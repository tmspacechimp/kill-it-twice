import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointService } from '../dist/checkpoint.service.js';
import { setupLoad } from './load-test-helpers.mjs';

function statePath(t) {
  const directory = mkdtempSync(join(tmpdir(), 'checkpoint-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'progress.sqlite');
}

test('restart resumes both cursors and retries the event that failed processing', async (t) => {
  const checkpointPath = statePath(t);
  const failure = new Error('broker confirmation failed');
  const first = setupLoad(t, {
    checkpointPath,
    boundary: 10,
    initialReads: [[{ id: -2 }, { id: 0 }, { id: 10 }]],
    pollingReads: [[{ id: 11 }, { id: 12 }]],
  });
  const incrementalSaved = Promise.withResolvers();
  await assert.rejects(
    first.run(async (event) => {
      if (event.id === 0) {
        await incrementalSaved.promise;
        throw failure;
      }
      if (event.id === 12) incrementalSaved.resolve();
    }),
    failure,
  );

  const second = setupLoad(t, {
    checkpointPath,
    boundary: new Error('must not recapture boundary'),
    initialReads: [[{ id: 0 }, { id: 10 }]],
    pollingReads: [[], [], [], [], [{ id: 13 }], [], [], []],
  });
  const processed = [];
  await second.run(async (event) => processed.push(event.id));

  assert.deepEqual(
    processed.sort((a, b) => a - b),
    [0, 10, 13],
  );
  assert.equal(second.database.boundaryReads, 0);
  assert.deepEqual(second.database.reads[0].values, [-2, 10, 1000]);
  assert.deepEqual(second.database.reads[1].values, [12, 1000]);

  const third = setupLoad(t, {
    checkpointPath,
    initialReads: [],
    pollingReads: [[{ id: 14 }], [], [], []],
  });
  await third.run();
  assert.equal(third.database.boundaryReads, 0);
  assert.ok(third.database.reads.every((read) => read.reader === 'polling'));
  assert.deepEqual(third.database.reads[0].values, [13, 1000]);
});

test('empty initial boundary persists and checkpoint write failure stops the reader', async (t) => {
  const checkpointPath = statePath(t);
  const failure = new Error('disk full');
  t.mock.method(CheckpointService.prototype, 'advanceIncremental', () => {
    throw failure;
  });
  const first = setupLoad(t, {
    checkpointPath,
    boundary: null,
    initialReads: [],
    pollingReads: [[{ id: -1 }, { id: 0 }]],
  });
  const processed = [];
  await assert.rejects(
    first.run(async (event) => processed.push(event.id)),
    failure,
  );
  assert.deepEqual(processed, [-1]);

  const checkpoint = new CheckpointService();
  const saved = await checkpoint.open(
    () => assert.fail('boundary must be retained'),
    checkpointPath,
  );
  assert.equal(saved.boundary, null);
  assert.equal(saved.incrementalId, null);
  assert.equal(saved.initialDone, 1);
  checkpoint.close();
});

test('corrupt checkpoint fails closed rather than starting over', async (t) => {
  const checkpointPath = statePath(t);
  writeFileSync(checkpointPath, 'not a SQLite database');
  const load = setupLoad(t, { checkpointPath });
  await assert.rejects(load.run(), /not a database/);
  assert.equal(load.database.boundaryReads, 0);
  assert.equal(load.database.reads.length, 0);
});
