import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { RunEvidence } from './run-evidence.mjs';

function readSummary(run) {
  return JSON.parse(readFileSync(join(run.directory, 'summary.json'), 'utf8'));
}

test('run directories are unique and summary updates preserve a clear initial status', () => {
  const first = new RunEvidence('demo', { test: 'summary lifecycle' });
  const second = new RunEvidence('demo', { test: 'unique directory' });
  assert.notEqual(first.directory, second.directory);
  assert.equal(readSummary(first).status, 'INCOMPLETE');
  first.summary.configuration.maxBytesPerContainer = 1024;
  first.saveSummary();
  first.finish('FAIL', { message: 'expected test failure' });
  assert.equal(readSummary(first).status, 'FAIL');
  assert.ok(readSummary(first).endedAt);
  assert.equal(JSON.parse(readFileSync(join(first.directory, 'started.json'), 'utf8')).status, 'INCOMPLETE');
});

test('a disconnected collector is rejected and its diagnostics are persisted', async () => {
  const run = new RunEvidence('demo', { test: 'disconnected collector' });
  run.serviceDirectory = join(run.directory, 'services');
  mkdirSync(run.serviceDirectory);
  run.collector = {};
  run.collectorResult = Promise.resolve({ code: null, signal: 'SIGTERM' });
  await assert.rejects(run.stopCollector(), /Log collection incomplete/);
  const diagnostics = readFileSync(join(run.serviceDirectory, 'collection-errors.jsonl'), 'utf8');
  assert.match(diagnostics, /SIGTERM/);
  run.finish('FAIL');
  assert.equal(readSummary(run).status, 'FAIL');
});
