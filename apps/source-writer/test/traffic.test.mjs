import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { generateTransitions, validateTraffic, writeTraffic } from '../dist/traffic.js';

test('generation creates new ordered histories with an exact event count', () => {
  assert.deepEqual(
    [...generateTransitions(5, 4002)],
    [
      { shipmentId: 4002, status: 'created' },
      { shipmentId: 4002, status: 'in_transit' },
      { shipmentId: 4002, status: 'delivered' },
      { shipmentId: 4003, status: 'created' },
      { shipmentId: 4003, status: 'in_transit' },
    ],
  );
  const events = [...generateTransitions(500, 1)];
  assert.equal(events.length, 500);
  assert.equal(new Set(events.map((e) => e.shipmentId)).size, 167);
  assert.deepEqual(generateTransitions(2147483647, 1).next().value, {
    shipmentId: 1,
    status: 'created',
  });
  assert.throws(() => [...generateTransitions(4, 2147483647)], /bounds/);
});

test('rate spaces serial writes, accounting for write time without catch-up bursts', async () => {
  let now = 0;
  const starts = [];
  const sleeps = [];
  const durations = [10, 80, 10, 10];
  const timer = {
    now: () => now,
    async sleep(ms) {
      sleeps.push(ms);
      now += ms;
    },
  };
  assert.equal(
    await writeTraffic(
      4,
      20,
      1,
      async () => {
        starts.push(now);
        await Promise.resolve();
        now += durations.shift();
      },
      undefined,
      timer,
    ),
    4,
  );
  assert.deepEqual(starts, [0, 50, 130, 180]);
  assert.deepEqual(sleeps, [40, 40]);
});

test('a write failure stops generation without retries', async () => {
  let writes = 0;
  const failure = new Error('insert failed');
  await assert.rejects(
    writeTraffic(5, 20, 1, async () => {
      writes++;
      throw failure;
    }),
    failure,
  );
  assert.equal(writes, 1);
});

test('cancellation during a wait prevents the next write', async () => {
  const controller = new AbortController();
  let writes = 0;
  await assert.rejects(
    writeTraffic(
      5,
      20,
      1,
      async () => {
        writes++;
      },
      controller.signal,
      {
        now: () => 0,
        async sleep() {
          controller.abort();
        },
      },
    ),
    { name: 'AbortError' },
  );
  assert.equal(writes, 1);
});

test('count and rate limits are validated before connecting', () => {
  for (const [count, rate] of [
    [0, 20],
    [1.5, 20],
    [2147483648, 20],
    [1, 0],
    [1, 1001],
    [1, NaN],
  ]) {
    assert.throws(() => validateTraffic(count, rate));
  }
  for (const args of [
    ['generate'],
    ['generate', '--count', '500', '--rate', '0'],
    ['generate', '--count', '-1', '--rate', '20'],
  ]) {
    const result = spawnSync(process.execPath, ['dist/main.js', ...args], {
      encoding: 'utf8',
      env: { ...process.env, PGHOST: 'invalid.invalid' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:|RATE/);
    assert.doesNotMatch(result.stderr, /ENOTFOUND/);
  }
});
