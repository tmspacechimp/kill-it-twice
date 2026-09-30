import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ReceiptStore } from '../dist/receipt-store.js';
import { handleDelivery } from '../dist/handle-delivery.js';

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'consumer-receipts-'));
  const path = join(directory, 'receipts.sqlite');
  const stores = new Set();
  const logs = [];
  const acknowledged = [];
  const channel = { ack: (message) => acknowledged.push(message) };

  function open() {
    const store = new ReceiptStore(path);
    stores.add(store);
    return store;
  }

  function close(store) {
    store.close();
    stores.delete(store);
  }

  t.after(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { path, open, close, logs, acknowledged, channel };
}

function message(id) {
  return {
    content: Buffer.from(
      JSON.stringify({
        type: 'shipment.status',
        sourceId: id,
        record: { id, shipment_id: 1, version: 1, status: 'created' },
      }),
    ),
    fields: { redelivered: false },
  };
}

test('duplicate publications produce a clear log and are acknowledged without normal processing', (t) => {
  const { open, logs, acknowledged, channel } = setup(t);
  const receipts = open();
  const first = message(72);
  const duplicate = message(72);
  const log = (line) => logs.push(line);

  handleDelivery(first, channel, receipts, log);
  handleDelivery(duplicate, channel, receipts, log);

  assert.deepEqual(logs, [
    'Received event ' + first.content.toString(),
    'Duplicate event received: sourceId=72; skipping',
  ]);
  assert.deepEqual(acknowledged, [first, duplicate]);
});

test('receipt commits are visible to another connection before acknowledgement and survive reopening', (t) => {
  const { path, open, close } = setup(t);
  const receipts = open();
  const order = [];
  const channel = {
    ack() {
      const observer = new DatabaseSync(path, { readOnly: true });
      const saved = observer.prepare('SELECT event_id, processed_at FROM processed_events').get();
      observer.close();
      assert.equal(saved.event_id, 12);
      assert.ok(saved.processed_at);
      order.push('ack');
    },
  };

  handleDelivery(message(12), channel, receipts, () => order.push('log'));
  assert.deepEqual(order, ['log', 'ack']);
  close(receipts);
  const reopened = open();
  assert.equal(reopened.record(12), false);
});

test('out-of-order events and different event IDs for the same shipment are all new', (t) => {
  const { open, logs, channel } = setup(t);
  const receipts = open();
  for (const id of [10001, 72, 73, 0, -2]) {
    handleDelivery(message(id), channel, receipts, (line) => logs.push(line));
  }
  assert.equal(logs.length, 5);
  assert.ok(logs.every((line) => line.startsWith('Received event ')));
});

test('receipt failure leaves the message unacknowledged and does not log success', () => {
  const failure = new Error('disk full');
  const receipts = {
    record: () => {
      throw failure;
    },
  };
  const unexpected = () => assert.fail('must not log or acknowledge');
  assert.throws(
    () => handleDelivery(message(1), { ack: unexpected }, receipts, unexpected),
    failure,
  );
});

test('lost acknowledgement causes a duplicate on the next delivery', (t) => {
  const { open, logs, channel, acknowledged } = setup(t);
  const receipts = open();
  const delivery = message(1);
  const failure = new Error('connection lost');
  assert.throws(
    () =>
      handleDelivery(
        delivery,
        {
          ack: () => {
            throw failure;
          },
        },
        receipts,
        () => {},
      ),
    failure,
  );

  handleDelivery(delivery, channel, open(), (line) => logs.push(line));
  assert.deepEqual(logs, ['Duplicate event received: sourceId=1; skipping']);
  assert.equal(acknowledged.length, 1);
});

test('logging failure after receipt commit leaves a receipt but no acknowledgement', (t) => {
  const { open, channel, acknowledged, logs } = setup(t);
  const receipts = open();
  const failure = new Error('log output failed');
  assert.throws(
    () =>
      handleDelivery(message(1), channel, receipts, () => {
        throw failure;
      }),
    failure,
  );
  assert.equal(acknowledged.length, 0);
  handleDelivery(message(1), channel, receipts, (line) => logs.push(line));
  assert.deepEqual(logs, ['Duplicate event received: sourceId=1; skipping']);
});

test('invalid event identity fails before inserting a receipt or acknowledging', (t) => {
  const { path, open, channel, acknowledged } = setup(t);
  const receipts = open();
  const invalid = [
    'not json',
    'null',
    '{}',
    JSON.stringify({ type: 'shipment.status', sourceId: 1, record: { id: 2 } }),
  ];
  for (const payload of invalid) {
    assert.throws(() => handleDelivery({ content: Buffer.from(payload) }, channel, receipts));
  }
  const database = new DatabaseSync(path, { readOnly: true });
  assert.equal(database.prepare('SELECT count(*) AS total FROM processed_events').get().total, 0);
  database.close();
  assert.equal(acknowledged.length, 0);
});

test('corrupt receipt storage fails instead of silently resetting deduplication', (t) => {
  const { path, open } = setup(t);
  writeFileSync(path, 'not a SQLite database');
  assert.throws(open, /not a database/);
});
