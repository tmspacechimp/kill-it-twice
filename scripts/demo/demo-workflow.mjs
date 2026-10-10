import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

export function readDemoOptions(environment = process.env) {
  return {
    seedShipments: readInteger(environment, 'DEMO_SEED_SHIPMENTS', 4000, 1, 858993458),
    incrementalEvents: readInteger(environment, 'DEMO_INCREMENTAL_EVENTS', 500, 1, 2147483647),
    incrementalRate: readInteger(environment, 'DEMO_INCREMENTAL_RATE', 20, 1, 1000),
    waitTimeoutMs: readInteger(environment, 'DEMO_WAIT_TIMEOUT_MS', 600000, 1, Number.MAX_SAFE_INTEGER),
    maxLogBytes: readInteger(environment, 'DEMO_LOG_MAX_BYTES', 10485760, 1024, Number.MAX_SAFE_INTEGER),
  };
}

function readInteger(environment, name, defaultValue, minimum, maximum) {
  const text = environment[name] ?? String(defaultValue);
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export class DemoWorkflow {
  constructor(compose, evidence, options, interrupted = () => false) {
    this.compose = compose;
    this.evidence = evidence;
    this.options = options;
    this.interrupted = interrupted;
    this.jobs = [];
    this.timings = {};
  }

  async start() {
    this.assertNoActiveWriter();
    this.step('Build applications');
    this.compose('build', 'source-writer', 'replicator', 'consumer');

    this.step('Start infrastructure');
    this.compose('up', '-d', '--wait', 'postgres', 'opensearch', 'rabbitmq', 'dashboards');
    this.runJob('dashboards-setup');
    this.seedEmptySource();

    this.step('Start consumer and replicator');
    this.sourceEventsAtStartup = Number(this.sourceQuery('SELECT count(*) FROM public.shipment_status_events'));
    this.sourceLastIdAtStartup = Number(this.sourceQuery('SELECT coalesce(max(id), 0) FROM public.shipment_status_events'));
    this.replicationStartedAt = Date.now();
    const startedAt = new Date(this.replicationStartedAt).toISOString();
    this.compose('up', '-d', 'consumer', 'replicator');
    await this.waitForStartup(startedAt);

    this.step('Generate incremental events', {
      count: this.options.incrementalEvents, rate: this.options.incrementalRate,
    });
    this.runJob('source-writer', 'generate',
      '--count', String(this.options.incrementalEvents),
      '--rate', String(this.options.incrementalRate));
    this.finishStep();
  }

  finishStep() {
    if (this.currentStep) this.timings[this.currentStep] = Date.now() - this.stepStartedAt;
    this.currentStep = null;
  }

  step(action, details = {}) {
    if (this.interrupted()) throw new Error('Demo run interrupted');
    this.finishStep();
    this.currentStep = action;
    this.stepStartedAt = Date.now();
    console.log(action);
    this.evidence.timeline(action, details);
  }

  assertNoActiveWriter() {
    const output = this.compose('ps', '-a', '--format', 'json', 'replicator', 'source-writer');
    for (const line of output.trim().split('\n')) {
      if (!line) continue;
      const container = JSON.parse(line);
      if (['running', 'restarting', 'paused'].includes(container.State)) {
        throw new Error(`${container.Service} is already active; stop it before make run`);
      }
    }
  }

  sourceQuery(query) {
    return this.compose('exec', '-T', 'postgres',
      'psql', '-X', '-At', '-U', 'source', '-d', 'client_source', '-c', query).trim();
  }

  seedEmptySource() {
    const tableExists = this.sourceQuery(
      "SELECT to_regclass('public.shipment_status_events') IS NOT NULL",
    ) === 't';
    let eventCount = 0;
    if (tableExists) {
      eventCount = Number(this.sourceQuery('SELECT count(*) FROM public.shipment_status_events'));
    }
    if (!Number.isSafeInteger(eventCount) || eventCount < 0) {
      throw new Error('Invalid source event count');
    }

    this.freshSource = eventCount === 0;
    this.evidence.timeline('Source before seeding', { events: eventCount });
    if (eventCount > 0) {
      this.step('Keep existing source history', { events: eventCount });
      return;
    }
    this.step('Seed empty source', { shipments: this.options.seedShipments });
    this.runJob('source-writer', '--shipments', String(this.options.seedShipments));
  }

  runJob(service, ...arguments_) {
    const name = `demo-${service}-${randomUUID()}`;
    this.jobs.push(name);
    // Retain one-off containers until their host logs have been saved.
    this.compose('run', '--no-deps', '-T', '--name', name, service, ...arguments_);
  }

  async waitForStartup(startedAt) {
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      if (this.interrupted()) throw new Error('Demo run interrupted');
      const logs = this.compose('logs', '--no-color', '--no-log-prefix',
        '--since', startedAt, 'replicator');
      const status = JSON.parse(this.compose('ps', '-a', '--format', 'json', 'replicator'));
      if (status.State !== 'running' || logs.includes('Replicator failed')) {
        throw new Error(`Replicator failed before incremental generation: ${JSON.stringify(status)}`);
      }
      if (logs.includes('Saved progress:')) {
        const startupBoundary = logs.match(/Startup boundary:.*$/m)?.[0];
        const savedProgress = logs.match(/Saved progress:.*$/m)?.[0];
        if (startupBoundary) console.log(startupBoundary);
        if (savedProgress) console.log(savedProgress);
        this.evidence.timeline('Replicator captured startup boundary', {
          startupBoundary, savedProgress,
        });
        return;
      }
      await setTimeout(200);
    }
    throw new Error('Timed out waiting for replicator startup');
  }
}
