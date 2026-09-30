import { execFileSync } from 'node:child_process';
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
  constructor(projectName) {
    this.projectName = projectName;
    this.crashEventId = '';
  }

  compose(...arguments_) {
    let executable = 'docker';
    let command = [];
    if (process.platform === 'win32') {
      executable = 'wsl.exe';
      // Pass the setting explicitly across the Windows/WSL boundary.
      command = [
        '--cd',
        process.cwd(),
        '--exec',
        'env',
        `G1_CRASH_EVENT_ID=${this.crashEventId}`,
        `SEED_SHIPMENTS=${process.env.SEED_SHIPMENTS ?? '4000'}`,
        'docker',
      ];
    }
    command.push('compose', '-f', 'compose.verify.yaml', '-p', this.projectName, ...arguments_);

    return execFileSync(executable, command, {
      encoding: 'utf8',
      env: { ...process.env, G1_CRASH_EVENT_ID: String(this.crashEventId) },
      maxBuffer: 32 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
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

  recreateReplicator() {
    this.crashEventId = '';
    // Replacing the container proves recovery uses the retained named volume.
    this.compose('up', '-d', '--force-recreate', 'replicator');
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
    const response = this.compose(
      'exec',
      '-T',
      'opensearch',
      'curl',
      '--fail',
      '--silent',
      '--show-error',
      'http://localhost:9200/shipments/_mget',
      '-H',
      'Content-Type: application/json',
      '-d',
      body,
    );
    // GET by ID avoids depending on OpenSearch's asynchronous search refresh.
    return JSON.parse(response).docs;
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
