import { executeDocker } from '../logging/docker.mjs';
import { setTimeout } from 'node:timers/promises';

const CHECKPOINT_QUERY = `
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync('/state/progress.sqlite', { readOnly: true });
  const checkpoint = database.prepare('SELECT * FROM progress WHERE singleton = 1').get();
  console.log(JSON.stringify(checkpoint));
  database.close();
`;

// Docker commands and data collection only. Assertions belong to the scenario.
export class VerificationEnvironment {
  constructor(projectName, evidence) {
    this.evidence = evidence;
    this.documentBatch = 0;
    this.projectName = projectName;
    this.crashEventId = '';
  }

  compose(...arguments_) {
    const command = ['compose', '-f', 'compose.verify.yaml', '-p', this.projectName, ...arguments_];
    const settings = {
      G1_CRASH_EVENT_ID: String(this.crashEventId),
      G1_SEED_SHIPMENTS: process.env.G1_SEED_SHIPMENTS ?? '4000',
    };
    try {
      const result = executeDocker(command, settings);
      this.evidence.append('commands.jsonl', {
        command, stdout: result.stdout, stderr: result.stderr, status: 0,
      });
      if (arguments_.includes('source-writer') && arguments_[0] === 'run') {
        this.evidence.append('source-writer.jsonl', {
          service: 'source-writer', stdout: result.stdout, stderr: result.stderr,
        });
      }
      return result.stdout.trim();
    } catch (error) {
      this.evidence.append('commands.jsonl', {
        command, stdout: error.stdout, stderr: error.stderr, error: error.message,
      });
      throw error;
    }
  }

  buildApplications() {
    this.compose('build', 'source-writer', 'replicator', 'consumer');
  }

  startInfrastructure() {
    this.compose('up', '-d', '--wait', 'postgres', 'opensearch', 'rabbitmq');
  }

  seed() {
    this.compose('run', '--rm', '--no-deps', '-T', 'source-writer');
  }

  startApplications(crashEventId) {
    this.crashEventId = crashEventId;
    this.compose('up', '-d', 'consumer', 'replicator');
  }

  generate(eventCount) {
    this.compose(
      'run',
      '--rm',
      '--no-deps',
      '-T',
      'source-writer',
      'generate',
      '--count',
      String(eventCount),
      '--rate',
      '1000',
    );
  }

  async recreateReplicator() {
    // Stop the reader before removing a container so its last snapshot is retained.
    await this.evidence.stopCollector();
    this.evidence.snapshot();
    this.evidence.timeline('recreate replicator', { service: 'replicator', status: this.replicatorStatus() });
    this.crashEventId = '';
    // Replacing the container proves recovery uses the retained named volume.
    this.compose('up', '-d', '--force-recreate', 'replicator');
    this.evidence.startCollector(this.projectName);
  }

  replicatorStatus() {
    return JSON.parse(this.compose('ps', '-a', '--format', 'json', 'replicator'));
  }

  readStoppedCheckpoint() {
    // A one-off container mounts the same volume but does not run the replicator.
    return JSON.parse(
      this.compose(
        'run',
        '--rm',
        '--no-deps',
        '-T',
        '--entrypoint',
        'node',
        'replicator',
        '-e',
        CHECKPOINT_QUERY,
      ),
    );
  }

  readRunningCheckpoint() {
    return JSON.parse(this.compose('exec', '-T', 'replicator', 'node', '-e', CHECKPOINT_QUERY));
  }

  readSourceEvents() {
    const query = `SELECT coalesce(json_agg(event ORDER BY id), '[]') FROM shipment_status_events event`;
    const result = this.compose(
      'exec',
      '-T',
      'postgres',
      'psql',
      '-X',
      '-At',
      '-U',
      'source',
      '-d',
      'client_source',
      '-c',
      query,
    );
    return JSON.parse(result);
  }

  logs(service) {
    return this.compose('logs', '--no-color', '--no-log-prefix', service);
  }

  readConsumerOutput() {
    const events = [];
    const duplicateIds = [];
    const eventPrefix = 'Received event ';
    for (const line of this.logs('consumer').split('\n')) {
      if (line.startsWith(eventPrefix)) {
        events.push(JSON.parse(line.slice(eventPrefix.length)));
      } else {
        const duplicate = /^Duplicate event received: sourceId=(-?\d+); skipping\r?$/.exec(line);
        if (duplicate) duplicateIds.push(Number(duplicate[1]));
      }
    }
    return { events, duplicateIds };
  }

  readShipmentDocuments(shipmentIds) {
    const body = JSON.stringify({ ids: shipmentIds.map(String) });
    const response = this.requestOpenSearch('POST', '/shipments/_mget', body);
    this.assertCompleteResponse(response, '/shipments/_mget');
    // GET by ID avoids depending on OpenSearch's asynchronous search refresh.
    const documents = response.docs;
    this.evidence.save(`validation/opensearch-batch-${++this.documentBatch}.json`, { shipmentIds, documents });
    return documents;
  }

  requestOpenSearch(method, path, body) {
    const arguments_ = [
      'exec', '-T', 'opensearch', 'curl',
      '--fail', '--silent', '--show-error',
      '-X', method, 'http://localhost:9200' + path,
    ];
    if (body !== undefined) {
      arguments_.push('-H', 'Content-Type: application/json', '-d', body);
    }
    return JSON.parse(this.compose(...arguments_));
  }

  assertCompleteResponse(response, path) {
    if (response.timed_out || response._shards?.failed > 0) {
      throw new Error('Incomplete OpenSearch response for ' + path);
    }
  }

  *readShipmentRecords() {
    const refresh = this.requestOpenSearch('POST', '/shipment-records/_refresh');
    this.assertCompleteResponse(refresh, '/shipment-records/_refresh');
    let scrollId;
    let pageNumber = 0;
    let received = 0;
    try {
      let response = this.requestOpenSearch('POST', '/shipment-records/_search?scroll=1m',
        JSON.stringify({ size: 500, sort: ['_doc'], track_total_hits: true }));
      let expected;

      while (true) {
        scrollId = response._scroll_id ?? scrollId;
        this.evidence.save(
          `validation/opensearch-records-batch-${++pageNumber}.json`,
          response,
        );
        this.assertCompleteResponse(response, 'history scroll page ' + pageNumber);
        if (!response._scroll_id) throw new Error('Missing OpenSearch history scroll ID');
        const total = response.hits?.total;
        if (
          total?.relation !== 'eq' ||
          !Number.isSafeInteger(total.value) ||
          total.value < 0
        ) {
          throw new Error('OpenSearch did not return an exact history document count');
        }
        expected ??= total.value;
        if (total.value !== expected) {
          throw new Error('OpenSearch history document count changed during the scan');
        }
        const documents = response.hits.hits;
        if (!Array.isArray(documents) || documents.length > 500) {
          throw new Error('Invalid OpenSearch history page');
        }
        if (documents.length === 0) break;
        received += documents.length;
        yield documents;
        response = this.requestOpenSearch('POST', '/_search/scroll',
          JSON.stringify({ scroll: '1m', scroll_id: scrollId }));
      }
      if (received !== expected) {
        throw new Error(`Incomplete OpenSearch history scan: ${received} of ${expected} documents`);
      }
    } finally {
      if (scrollId) {
        this.requestOpenSearch('DELETE', '/_search/scroll',
          JSON.stringify({ scroll_id: [scrollId] }));
      }
    }
  }

  failureLogs() {
    return this.compose('logs', '--no-color', '--tail', '40');
  }

  removeProject() {
    this.compose('down', '--volumes', '--remove-orphans');
  }
}

// Waiting observes asynchronous services; it never retries failed commands or assertions.
export async function waitFor(description, observe) {
  const timeoutMs = Number(process.env.G1_WAIT_TIMEOUT_MS ?? 600000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('G1_WAIT_TIMEOUT_MS must be a positive integer');
  }
  const deadline = Date.now() + timeoutMs;
  let nextProgressReport = Date.now() + 30000;
  while (Date.now() < deadline) {
    const evidence = observe();
    if (evidence) return evidence;
    if (Date.now() >= nextProgressReport) {
      console.log(`   Waiting for ${description}`);
      nextProgressReport = Date.now() + 30000;
    }
    await setTimeout(500);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
