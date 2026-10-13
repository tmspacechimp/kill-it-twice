import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCrashCheckpoint,
  assertLoadedCheckpoint,
  assertScheduledDuplicates,
} from './scenario-checks.mjs';

test('initial crash checks reject checkpointed targets, lost progress, and changed boundary', () => {
  const before = { boundary: 10000, initialId: 1000, initialDone: 0, incrementalId: 10000 };
  const checkpoint = { ...before, initialId: 2047 };
  assertCrashCheckpoint(checkpoint, 2048, before, 10000);
  for (const change of [
    { initialId: 2048 },
    { initialId: 2046 },
    { boundary: 10009 },
    { initialDone: 1 },
    { incrementalId: 9999 },
  ]) {
    assert.throws(() => assertCrashCheckpoint({ ...checkpoint, ...change }, 2048, before, 10000));
  }
});

test('incremental crash checks allow concurrent initial progress but reject a checkpointed target', () => {
  const before = { boundary: 10000, initialId: 2047, initialDone: 0, incrementalId: 10000 };
  const checkpoint = { ...before, initialId: 4000, incrementalId: 12047 };
  assertCrashCheckpoint(checkpoint, 12048, before, 16000);
  assertCrashCheckpoint({ ...checkpoint, initialId: 10000, initialDone: 1 }, 12048, before, 16000);
  for (const change of [
    { incrementalId: 12048 },
    { incrementalId: 12046 },
    { initialId: 2046 },
    { boundary: 16000 },
  ]) {
    assert.throws(() => assertCrashCheckpoint({ ...checkpoint, ...change }, 12048, before, 16000));
  }
});

test('restart checks restore both cursors and the original boundary', () => {
  const checkpoint = { boundary: 10000, initialId: 4000, initialDone: 0, incrementalId: 12047 };
  const logs =
    'Startup boundary: lastId=10000\nSaved progress: initialId=4000 initialDone=0 incrementalId=12047';
  assertLoadedCheckpoint(logs, checkpoint);
  assert.throws(() =>
    assertLoadedCheckpoint(logs.replace('incrementalId=12047', 'incrementalId=12048'), checkpoint),
  );
  assert.throws(() =>
    assertLoadedCheckpoint(logs.replace('lastId=10000', 'lastId=16000'), checkpoint),
  );
});

test('one duplicate cannot prove two scheduled replays of the same event', () => {
  assertScheduledDuplicates([2048, 2048, 12048], [2048, 2048, 12048]);
  assert.throws(() => assertScheduledDuplicates([2048, 12048], [2048, 2048, 12048]), /needs 2/);
});
