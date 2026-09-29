import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { appendEvent, createAppendEvent } from '../dist/append-event.js';

const time = new Date('2026-09-28T12:00:00.000Z');

test('event construction uses global ID and per-shipment version independently', () => {
  assert.deepEqual(createAppendEvent(42, 'in_transit', 10000, 1, time), {
    id: 10001,
    shipment_id: 42,
    version: 2,
    status: 'in_transit',
    occurred_at: time.toISOString(),
  });
  assert.equal(createAppendEvent(42, 'created', null, null, time).id, 1);
  assert.equal(createAppendEvent(42, 'created', 10000, null, time).version, 1);
  assert.equal(createAppendEvent(42, 'created', -1, null, time).id, 0);
});

test('invalid inputs and exhausted integer IDs or versions are rejected', () => {
  for (const id of [0, -1, 1.5, NaN, 2147483648]) {
    assert.throws(() => createAppendEvent(id, 'created', 1, 1, time));
  }
  assert.throws(() => createAppendEvent(1, 'unknown', 1, 1, time));
  assert.throws(() => createAppendEvent(1, 'created', 2147483647, 1, time));
  assert.throws(() => createAppendEvent(1, 'created', 1, 2147483647, time));
});

test('append inserts exactly one parameterized row and commits before returning', async () => {
  const calls = [];
  const db = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ max_id: 10000, max_version: 3 }] };
    },
  };
  const event = await appendEvent(db, 1, 'cancelled');
  assert.equal(calls[0].sql, 'BEGIN');
  assert.deepEqual(calls[1].values, [1]);
  assert.match(calls[1].sql, /max\(id\)/);
  assert.match(calls[1].sql, /max\(version\).*shipment_id = \$1/);
  assert.match(calls[2].sql, /INSERT INTO public.shipment_status_events/);
  assert.doesNotMatch(calls[2].sql, /ON CONFLICT/);
  assert.deepEqual(calls[2].values, [10001, 1, 4, 'cancelled', event.occurred_at]);
  assert.equal(calls[3].sql, 'COMMIT');
  assert.equal(calls.length, 4);
});

test('append rolls back insertion failures without retry or success', async () => {
  const calls = [];
  const failure = new Error('duplicate key');
  const db = {
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('INSERT')) throw failure;
      return { rows: [{ max_id: 4, max_version: 2 }] };
    },
  };
  await assert.rejects(appendEvent(db, 2, 'delivered'), failure);
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.equal(calls.length, 4);
  assert.ok(!calls.includes('COMMIT'));
});

test('invalid append CLI arguments fail before attempting a connection', () => {
  for (const args of [
    ['append', '1'],
    ['append', '0', 'created'],
    ['append', '1', 'bad'],
    ['append', '1.5', 'created'],
  ]) {
    const result = spawnSync(process.execPath, ['dist/main.js', ...args], {
      encoding: 'utf8',
      env: { ...process.env, PGHOST: 'invalid.invalid' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:|Shipment ID|Status must/);
    assert.doesNotMatch(result.stderr, /ENOTFOUND/);
  }
});
