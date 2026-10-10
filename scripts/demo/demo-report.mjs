import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { assertConsumerCoverage, assertShipmentDocuments, latestShipmentEvents } from '../verification/outcomes.mjs';

const RECEIPTS_QUERY = `
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync('/state/receipts.sqlite', { readOnly: true });
  const rows = database.prepare(
    "SELECT event_id FROM processed_events WHERE consumer_name = 'shipment-consumer' AND source_name = 'client-source' ORDER BY event_id"
  ).all();
  console.log(JSON.stringify(rows.map(row => row.event_id)));
  database.close();
`;

export function checkConsumerReceipts(sourceEvents, receiptIds) {
  const expected = sourceEvents.map(event => event.id).sort((left, right) => left - right);
  assert.deepEqual(receiptIds, expected, 'Consumer receipts do not match the source event IDs');
}

export function checkLoggedPayloads(sourceEvents, logs, requiredEvents = []) {
  const byId = new Map(sourceEvents.map(event => [event.id, event]));
  const messages = [];
  const duplicateIds = [];
  for (const line of logs.split('\n')) {
    if (line.startsWith('Received event ')) {
      messages.push(JSON.parse(line.slice('Received event '.length)));
    }
    const duplicate = /^Duplicate event received: sourceId=(-?\d+); skipping\r?$/.exec(line);
    if (duplicate) duplicateIds.push(Number(duplicate[1]));
  }
  const expected = [];
  const seen = new Set();
  for (const message of messages) {
    assert.ok(byId.has(message.sourceId), `Unknown consumer event ${message.sourceId}`);
    assert.ok(!seen.has(message.sourceId), `Repeated normal processing for event ${message.sourceId}`);
    seen.add(message.sourceId);
    expected.push(byId.get(message.sourceId));
  }
  assertConsumerCoverage(expected, messages);
  const requiredIds = new Set(requiredEvents.map(event => event.id));
  assertConsumerCoverage(requiredEvents, messages.filter(message => requiredIds.has(message.sourceId)));
  for (const id of duplicateIds) assert.ok(byId.has(id), `Unknown duplicate event ${id}`);
  return { loggedPayloads: messages.length, duplicateDeliveries: duplicateIds.length };
}

export class DemoReport {
  constructor(compose, evidence, workflow, interrupted = () => false) {
    this.compose = compose;
    this.evidence = evidence;
    this.workflow = workflow;
    this.interrupted = interrupted;
    this.result = {
      status: 'INCOMPLETE',
      timings: { phasesMs: workflow.timings },
      checks: {},
    };
  }

  save() {
    this.evidence.save('report.json', this.result);
    this.evidence.summary.result = this.result;
    this.evidence.saveSummary();
  }

  async waitFor(description, observe) {
    const deadline = Date.now() + this.workflow.options.waitTimeoutMs;
    let nextMessage = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (this.interrupted()) throw new Error('Demo report interrupted');
      const result = observe();
      if (result) return result;
      if (Date.now() >= nextMessage) {
        console.log(`Waiting for ${description}`);
        nextMessage = Date.now() + 30000;
      }
      await setTimeout(500);
    }
    throw new Error(`Timed out waiting for ${description}`);
  }

  status(service) {
    return JSON.parse(this.compose('ps', '-a', '--format', 'json', service));
  }

  readReceipts() {
    assert.equal(this.status('consumer').State, 'running', 'Consumer is not running');
    return JSON.parse(this.compose('exec', '-T', 'consumer', 'node', '-e', RECEIPTS_QUERY));
  }

  async run() {
    this.save();
    try {
      await this.waitFor('replication to finish', () => {
        const status = this.status('replicator');
        if (status.State === 'running') return false;
        assert.equal(status.State, 'exited', 'Replicator did not exit normally');
        assert.equal(status.ExitCode, 0, 'Replicator exited with an error');
        return true;
      });
      this.result.checks.replicatorExit = 'PASS';
      this.result.timings.replicationMs = Date.now() - this.workflow.replicationStartedAt;
      const validationStartedAt = Date.now();
      await this.validate();
      this.result.timings.validationMs = Date.now() - validationStartedAt;
      this.result.timings.toValidationMs = Date.now() - Date.parse(this.evidence.summary.startedAt);
      this.result.status = 'PASS';
      this.result.completedAt = new Date().toISOString();
      this.evidence.timeline('demo validation passed', this.result);
      console.log(`Demo checks PASS: ${this.result.counts.sourceEvents} events, ${this.result.counts.shipments} shipments; replication ${(this.result.timings.replicationMs / 1000).toFixed(1)}s. See report.json.`);
      this.save();
      return this.result;
    } catch (error) {
      this.result.status = this.interrupted() ? 'INTERRUPTED' : 'FAIL';
      this.result.error = error.message;
      this.result.completedAt = new Date().toISOString();
      this.save();
      throw error;
    }
  }

  async validate() {
    const source = JSON.parse(this.workflow.sourceQuery(
      "SELECT coalesce(json_agg(event ORDER BY id), '[]') FROM shipment_status_events event",
    ));
    this.evidence.save('validation/source.json', source);
    this.result.counts = {
      sourceEventsAtStartup: this.workflow.sourceEventsAtStartup,
      generatedEvents: source.length - this.workflow.sourceEventsAtStartup,
      sourceEvents: source.length,
    };
    assert.equal(source.length,
      this.workflow.sourceEventsAtStartup + this.workflow.options.incrementalEvents,
      'Source event count does not match startup data plus configured traffic');
    this.result.checks.generatedEvents = 'PASS';

    const receiptIds = await this.waitFor('consumer receipts', () => {
      const ids = this.readReceipts();
      return ids.length >= source.length ? ids : false;
    });
    this.evidence.save('validation/consumer-receipts.json', receiptIds);
    checkConsumerReceipts(source, receiptIds);
    this.result.checks.consumerReceipts = 'PASS';

    const logs = this.compose('logs', '--no-color', '--no-log-prefix',
      '--since', new Date(this.workflow.replicationStartedAt).toISOString(), 'consumer');
    this.evidence.save('validation/consumer-logs.json', { logs });
    const requiredEvents = source.filter(event =>
      this.workflow.freshSource || event.id > this.workflow.sourceLastIdAtStartup);
    const deliveries = checkLoggedPayloads(source, logs, requiredEvents);
    this.result.checks.loggedPayloads = 'PASS';

    const shipments = latestShipmentEvents(source);
    this.evidence.save('validation/expected-shipments.json', shipments);
    for (let offset = 0; offset < shipments.length; offset += 1000) {
      const batch = shipments.slice(offset, offset + 1000);
      const body = JSON.stringify({ ids: batch.map(event => String(event.shipment_id)) });
      const response = this.compose('exec', '-T', 'opensearch', 'curl',
        '--fail', '--silent', '--show-error', 'http://localhost:9200/shipments/_mget',
        '-H', 'Content-Type: application/json', '-d', body);
      const documents = JSON.parse(response).docs;
      this.evidence.save(`validation/opensearch-${offset}.json`, documents);
      assertShipmentDocuments(batch, documents);
    }
    this.result.checks.latestShipmentState = 'PASS';
    this.result.counts = {
      sourceEventsAtStartup: this.workflow.sourceEventsAtStartup,
      generatedEvents: this.workflow.options.incrementalEvents,
      sourceEvents: source.length, consumerReceipts: receiptIds.length,
      shipments: shipments.length, ...deliveries,
    };
  }
}
