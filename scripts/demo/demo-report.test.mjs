import assert from 'node:assert/strict';
import test from 'node:test';
import { DemoReport, checkConsumerReceipts, checkLoggedPayloads } from './demo-report.mjs';

const event = { id: 1, shipment_id: 1, version: 1, status: 'created', occurred_at: '2026-10-10T00:00:00Z' };
const message = { type: 'shipment.status', sourceId: 1, record: { ...event, occurred_at: '2026-10-10T00:00:00.000Z' } };
const log = value => 'Received event ' + JSON.stringify(value);

test('receipt coverage rejects missing and unknown events even when counts match', () => {
  checkConsumerReceipts([event], [1]);
  assert.throws(() => checkConsumerReceipts([event], []), /Consumer receipts/);
  assert.throws(() => checkConsumerReceipts([event], [2]), /Consumer receipts/);
});

test('payload checks reject wrong fields, repeated processing, and missing required deliveries', () => {
  assert.deepEqual(checkLoggedPayloads([event], log(message), [event]), { loggedPayloads: 1, duplicateDeliveries: 0 });
  assert.throws(() => checkLoggedPayloads([event], log({ ...message, record: { ...message.record, status: 'delivered' } }), [event]), /Wrong payload/);
  assert.throws(() => checkLoggedPayloads([event], log(message) + '\n' + log(message)), /Repeated normal/);
  assert.throws(() => checkLoggedPayloads([event], '', [event]), /never received/);
  assert.throws(() => checkLoggedPayloads([event], 'Duplicate event received: sourceId=99; skipping'), /Unknown duplicate/);
});

function fixture({ exitCode = 0, wrongDocument = false } = {}) {
  const saved = new Map();
  const evidence = {
    summary: { startedAt: new Date().toISOString() },
    save: (name, value) => saved.set(name, structuredClone(value)),
    saveSummary() {}, timeline() {},
  };
  const workflow = {
    options: { incrementalEvents: 1, waitTimeoutMs: 100 },
    timings: { 'Build applications': 12 },
    replicationStartedAt: Date.now(), sourceEventsAtStartup: 0,
    sourceLastIdAtStartup: 0, freshSource: true,
    sourceQuery: () => JSON.stringify([event]),
  };
  const compose = (...args) => {
    if (args[0] === 'ps') return JSON.stringify(args.at(-1) === 'replicator'
      ? { State: 'exited', ExitCode: exitCode } : { State: 'running' });
    if (args[0] === 'logs') return log(message);
    if (args.includes('consumer')) return '[1]';
    return JSON.stringify({ docs: [{
      _id: '1', found: true,
      _source: { ...message.record, status: wrongDocument ? 'delivered' : 'created' },
    }] });
  };
  return { saved, evidence, workflow, compose };
}

test('completed demo saves counts, individual checks, and timings in report and summary', async () => {
  const fake = fixture();
  const result = await new DemoReport(fake.compose, fake.evidence, fake.workflow).run();
  assert.equal(result.status, 'PASS');
  assert.equal(result.counts.sourceEvents, 1);
  assert.equal(result.counts.consumerReceipts, 1);
  assert.equal(result.counts.loggedPayloads, 1);
  assert.equal(result.counts.shipments, 1);
  assert.equal(result.checks.latestShipmentState, 'PASS');
  assert.ok(result.timings.replicationMs >= 0);
  assert.ok(result.timings.validationMs >= 0);
  assert.equal(fake.saved.get('report.json').status, 'PASS');
  assert.equal(fake.evidence.summary.result.status, 'PASS');
});

test('failed replicator and stale index produce failed reports, never PASS', async () => {
  for (const options of [{ exitCode: 1 }, { wrongDocument: true }]) {
    const fake = fixture(options);
    await assert.rejects(new DemoReport(fake.compose, fake.evidence, fake.workflow).run());
    assert.equal(fake.saved.get('report.json').status, 'FAIL');
    assert.ok(fake.saved.get('report.json').error);
  }
});

test('stopping before replication finishes records interruption', async () => {
  const fake = fixture();
  await assert.rejects(new DemoReport(fake.compose, fake.evidence, fake.workflow, () => true).run(), /interrupted/);
  assert.equal(fake.saved.get('report.json').status, 'INTERRUPTED');
});
