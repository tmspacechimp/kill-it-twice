import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Subject } from 'rxjs';
import { initialStatus, updateStatus, pollStatus } from '../dist/test/status-state.js';
import { conflicts, replaceOperation } from '../dist/test/operation-state.js';

test('unavailable status keeps last values and their original timestamp visibly stale', () => {
  const successful = {
    available: true,
    data: { metrics: { throughput: { value: 12 } } },
    receivedAt: '2026-09-30T12:00:00Z',
  };
  const current = updateStatus(initialStatus, successful);
  const stale = updateStatus(current, { available: false, reason: 'Replicator stopped' });
  assert.equal(stale.data.metrics.throughput.value, 12);
  assert.equal(stale.receivedAt, successful.receivedAt);
  assert.equal(stale.stale, true);
  assert.equal(stale.reason, 'Replicator stopped');
  const restored = updateStatus(stale, { ...successful, receivedAt: '2026-09-30T12:01:00Z' });
  assert.equal(restored.stale, false);
  assert.equal(restored.reason, '');
  assert.notEqual(restored.receivedAt, stale.receivedAt);
  const empty = updateStatus(initialStatus, { available: false, reason: 'No integration' });
  assert.equal(empty.data, null);
  assert.equal(empty.receivedAt, null);
});

test('polling skips ticks while a request is active and recovers after an error', () => {
  const ticks = new Subject();
  const requests = [];
  const replies = [];
  const subscription = pollStatus(() => {
    const request = new Subject();
    requests.push(request);
    return request;
  }, ticks).subscribe((reply) => replies.push(reply));
  ticks.next();
  ticks.next();
  ticks.next();
  assert.equal(requests.length, 1);
  requests[0].error(new Error('timeout'));
  assert.equal(replies[0].available, false);
  assert.equal(replies[0].receivedAt, null);
  ticks.next();
  assert.equal(requests.length, 2);
  subscription.unsubscribe();
  ticks.next();
  assert.equal(requests.length, 2);
});

test('pending operations disable only related resources and failed outcomes remain visible', () => {
  const pending = {
    id: 'one',
    action: 'generate',
    state: 'pending',
    resources: ['writer'],
    message: 'Waiting',
  };
  let operations = replaceOperation([], pending);
  assert.equal(conflicts(operations, ['writer']), true);
  assert.equal(conflicts(operations, ['replicator']), false);
  assert.equal(conflicts(operations, ['replicator', 'writer']), true);
  operations = replaceOperation(operations, {
    ...pending,
    state: 'failed',
    message: 'Writer rejected the request',
  });
  assert.equal(operations.length, 1);
  assert.equal(conflicts(operations, ['writer']), false);
  assert.equal(operations[0].state, 'failed');
  assert.equal(operations[0].message, 'Writer rejected the request');
});
