import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readPollingOptions } from '../dist/polling-options.js';
import { eventsFrom, setupLoad } from './load-test-helpers.mjs';

test('polling processes new events while an initial event is still in progress', async (t) => {
  const releaseInitial = Promise.withResolvers();
  const incrementalProcessed = Promise.withResolvers();
  const pollingStopped = Promise.withResolvers();
  const { run, database, logs } = setupLoad(t, {
    boundary: 10,
    initialReads: [[{ id: 1 }, { id: 10 }]],
    pollingReads: [[{ id: 11 }], [], [], []],
    onLog: (message) => {
      if (message.startsWith('Polling stopped:')) pollingStopped.resolve();
    },
  });
  t.after(() => releaseInitial.resolve());
  const processed = [];

  const running = run(async (event) => {
    if (event.id === 1) await releaseInitial.promise;
    processed.push(event.id);
    if (event.id === 11) incrementalProcessed.resolve();
  });

  await incrementalProcessed.promise;
  await pollingStopped.promise;
  assert.deepEqual(processed, [11]);
  assert.equal(database.closed.length, 0);
  assert.ok(!logs.some((message) => message.startsWith('Initial load complete')));

  releaseInitial.resolve();
  await running;

  assert.deepEqual(processed, [11, 1, 10]);
  const firstPoll = database.reads.find((read) => read.reader === 'polling');
  assert.deepEqual(firstPoll.values, [10, 1000]);
  assert.equal(database.closed.length, 2);
});

test('rows reset the empty-poll counter and full batches drain before stopping', async (t) => {
  const { run, database, logs } = setupLoad(t, {
    boundary: 0,
    initialReads: [[{ id: 0 }]],
    pollingReads: [eventsFrom(1, 1000), [], [], [{ id: 2000 }], [], [], []],
  });

  await run();

  const polls = database.reads.filter((read) => read.reader === 'polling');
  assert.deepEqual(
    polls.map((read) => read.values),
    [
      [0, 1000],
      [1000, 1000],
      [1000, 1000],
      [1000, 1000],
      [2000, 1000],
      [2000, 1000],
      [2000, 1000],
    ],
  );
  assert.ok(logs.includes('Polling stopped: 3 consecutive empty polls'));
  assert.equal(logs.filter((message) => message === 'Empty poll 1/3').length, 2);
});

test('startup empties do not count until the first incremental rows arrive', async (t) => {
  const { run, database, logs } = setupLoad(t, {
    pollingReads: [[], [], [], [], [], [{ id: 2 }], [], [], []],
  });
  const processed = [];

  await run(async (event) => {
    processed.push(event.id);
  });

  assert.deepEqual(processed, [1, 2]);
  assert.equal(database.reads.filter((read) => read.reader === 'polling').length, 9);
  assert.equal(logs.filter((message) => message.startsWith('Empty poll ')).length, 3);
  assert.ok(logs.includes('Polling stopped: 3 consecutive empty polls'));
});

test('polling an initially empty table has no artificial lower ID bound', async (t) => {
  const { run, database } = setupLoad(t, {
    boundary: null,
    initialReads: [],
    pollingReads: [[{ id: -2 }, { id: 0 }], []],
  });
  const processed = [];

  await run(
    async (event) => {
      processed.push(event.id);
    },
    { maxEmptyPolls: 1 },
  );

  assert.deepEqual(processed, [-2, 0]);
  assert.deepEqual(
    database.reads.map((read) => read.values),
    [
      [null, 1000],
      [0, 1000],
    ],
  );
});

test('poll failure cancels the initial reader but waits for its active event before cleanup', async (t) => {
  const releaseInitial = Promise.withResolvers();
  const pollFailed = Promise.withResolvers();
  const failure = new Error('publication failed');
  const { run, database } = setupLoad(t, {
    boundary: 2,
    initialReads: [[{ id: 1 }, { id: 2 }]],
    pollingReads: [[{ id: 3 }]],
  });
  t.after(() => releaseInitial.resolve());
  const attempted = [];

  const running = run(async (event) => {
    attempted.push(event.id);
    if (event.id === 1) await releaseInitial.promise;
    if (event.id === 3) {
      pollFailed.resolve();
      throw failure;
    }
  });
  const rejected = assert.rejects(running, failure);

  await pollFailed.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(database.closed.length, 0);

  releaseInitial.resolve();
  await rejected;

  assert.deepEqual(attempted, [1, 3]);
  assert.equal(database.closed.length, 2);
});

test('an initial read failure cancels polling and fails the run', async (t) => {
  const failure = new Error('source read failed');
  const { run, database } = setupLoad(t, { initialReads: [failure] });

  await assert.rejects(run(), failure);

  assert.equal(database.closed.length, 2);
  assert.equal(database.reads.filter((read) => read.reader === 'initial').length, 1);
});

test('shutdown interrupts a long poll wait', async (t) => {
  const controller = new AbortController();
  const { run, database } = setupLoad(t);

  const running = run(
    async () => {
      setImmediate(() => controller.abort());
    },
    { intervalMs: 60000, signal: controller.signal },
  );

  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(database.closed.length, 2);
});

test('polling options validate the interval and empty-poll limit', () => {
  const env = { POLL_INTERVAL_MS: '250', POLL_MAX_EMPTY: '4' };
  assert.deepEqual(readPollingOptions(env), { intervalMs: 250, maxEmptyPolls: 4 });
  assert.deepEqual(readPollingOptions({}), { intervalMs: 1000, maxEmptyPolls: 3 });

  for (const name of ['POLL_INTERVAL_MS', 'POLL_MAX_EMPTY']) {
    for (const value of ['', '0', '-1', '1.5', '2147483648']) {
      env[name] = value;
      assert.throws(() => readPollingOptions(env), new RegExp(name));
    }
    env[name] = '1';
  }
});
