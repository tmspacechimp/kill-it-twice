import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { eventsFrom, setupLoad } from './load-test-helpers.mjs';

test('initial reads stay bounded by the startup ID and use a read-only connection', async (t) => {
  const controller = new AbortController();
  const initialReads = Array.from({ length: 10 }, (_, index) => eventsFrom(index * 1000 + 1, 1000));
  const { run, database, logs } = setupLoad(t, {
    boundary: 10000,
    initialReads,
    onLog: (message) => {
      if (message.startsWith('Initial load complete:')) controller.abort();
    },
  });
  const processed = [];

  await assert.rejects(
    run(
      async (event) => {
        processed.push(event.id);
      },
      { signal: controller.signal },
    ),
    { name: 'AbortError' },
  );

  assert.equal(processed.length, 10000);
  assert.equal(database.boundaryReads, 1);
  const reads = database.reads.filter((read) => read.reader === 'initial');
  assert.equal(reads.length, 10);

  for (const [index, read] of reads.entries()) {
    assert.match(read.sql, /id <= \$2/);
    assert.match(read.sql, /ORDER BY id LIMIT \$3/);
    assert.deepEqual(read.values, [index === 0 ? null : index * 1000, 10000, 1000]);
  }

  assert.ok(database.connections.every((c) => c.options === '-c default_transaction_read_only=on'));
  assert.deepEqual(database.closed.sort(), ['initial', 'polling']);
  assert.ok(logs.includes('Initial load complete: rows=10000 batches=10'));
});

test('negative, zero, and sparse IDs keep their original order', async (t) => {
  const controller = new AbortController();
  const events = [{ id: -2147483648 }, { id: 0 }, { id: 2147483647 }];
  const { run, database } = setupLoad(t, {
    boundary: 2147483647,
    initialReads: [events],
    onLog: (message) => {
      if (message.startsWith('Initial load complete:')) controller.abort();
    },
  });
  const processed = [];

  await assert.rejects(
    run(
      async (event) => {
        processed.push(event.id);
      },
      { signal: controller.signal },
    ),
    { name: 'AbortError' },
  );

  assert.deepEqual(
    processed,
    events.map((event) => event.id),
  );
  assert.deepEqual(database.reads.find((read) => read.reader === 'initial').values, [
    null,
    2147483647,
    1000,
  ]);
});

test('an empty startup table completes initial loading immediately', async (t) => {
  const controller = new AbortController();
  const { run, database, logs } = setupLoad(t, {
    boundary: null,
    initialReads: [],
    onLog: (message) => {
      if (message.startsWith('Initial load complete:')) controller.abort();
    },
  });

  await assert.rejects(run(undefined, { signal: controller.signal }), { name: 'AbortError' });

  assert.equal(database.reads.filter((read) => read.reader === 'initial').length, 0);
  assert.equal(database.reads.filter((read) => read.reader === 'polling').length, 0);
  assert.ok(logs.includes('Initial load complete: rows=0 batches=0'));
});

test('a missing source table fails at startup without readiness retries', async (t) => {
  const failure = Object.assign(new Error('relation does not exist'), { code: '42P01' });
  const { run, database } = setupLoad(t, { boundary: failure });

  await assert.rejects(run(), /Run make seed before starting the replicator/);

  assert.equal(database.boundaryReads, 1);
  assert.equal(database.reads.length, 0);
  assert.equal(database.closed.length, 2);
});

test('a connection failure closes both clients without reading', async (t) => {
  const failure = new Error('connection refused');
  const { run, database } = setupLoad(t, { connectionError: failure });

  await assert.rejects(run(), failure);

  assert.equal(database.connections.length, 1);
  assert.equal(database.boundaryReads, 0);
  assert.equal(database.closed.length, 2);
});
