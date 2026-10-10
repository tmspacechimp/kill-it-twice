import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectServiceLogs, retainTail } from './collector.mjs';

test('preserves the killed container and replacement in separate timestamped service logs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'run-logs-'));
  let containerId = 'before-kill';
  const docker = (arguments_) => {
    if (arguments_[0] === 'ps') {
      return JSON.stringify({ ID: containerId, Labels: 'com.docker.compose.service=replicator' });
    }
    assert.deepEqual(arguments_, ['logs', '--timestamps', containerId]);
    return '2026-10-10T12:00:00.123Z Saved progress: initialId=2047\n';
  };
  try {
    collectServiceLogs(directory, 'g1', 0, docker);
    containerId = 'after-restart';
    collectServiceLogs(directory, 'g1', 0, docker);
    assert.deepEqual(readdirSync(directory).sort(), [
      'replicator-after-restart.log', 'replicator-before-kill.log',
    ]);
    assert.match(readFileSync(join(directory, 'replicator-before-kill.log'), 'utf8'),
      /^\[replicator\] 2026-10-10T12:00:00.123Z Saved progress:/);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('demo snapshots bound the Docker read and host file without cutting UTF-8 lines', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bounded-logs-'));
  const output = '2026-10-10T12:00:00Z older event\n2026-10-10T12:00:01Z ახალი\n';
  const docker = (arguments_) => {
    if (arguments_[0] === 'ps') {
      return JSON.stringify({ ID: 'one', Labels: 'com.docker.compose.service=consumer' });
    }
    assert.deepEqual(arguments_, ['logs', '--timestamps', '--tail', '70', 'one']);
    return output;
  };
  try {
    collectServiceLogs(directory, 'demo', 70, docker);
    const saved = readFileSync(join(directory, 'consumer-one.log'), 'utf8');
    assert.ok(Buffer.byteLength(saved) <= 70);
    assert.match(saved, /ახალი/);
    assert.ok(!saved.includes('older event'));
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('verification logs remain unbounded and collection errors are propagated', () => {
  const text = 'one\ntwo\n';
  assert.equal(retainTail(text, 0), text);
  assert.throws(() => collectServiceLogs('unused', 'g1', 0, () => {
    throw new Error('Docker unavailable');
  }), /Docker unavailable/);
});
