import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { DemoReport } from './demo-report.mjs';
import { DemoWorkflow, readDemoOptions } from './demo-workflow.mjs';
import { RunEvidence } from '../logging/run-evidence.mjs';
import { runDocker } from '../logging/docker.mjs';

async function waitForExit(compose) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const status = JSON.parse(compose('ps', '-a', '--format', 'json', 'replicator'));
    if (status.State === 'exited') {
      assert.equal(status.ExitCode, 0);
      return;
    }
    await setTimeout(200);
  }
  throw new Error('Replicator did not finish the demo smoke run');
}

test('demo workflow seeds a fresh project once and appends configured traffic on each run', {
  skip: process.env.TEST_DEMO_RUN !== '1',
  timeout: 600000,
}, async () => {
  if (existsSync('.env')) loadEnvFile('.env');
  const project = `demo-workflow-${randomUUID()}`;
  const settings = {
    DEMO_SEED_SHIPMENTS: '3', POSTGRES_PORT: '0', OPENSEARCH_PORT: '0',
    DASHBOARDS_PORT: '0', RABBITMQ_PORT: '0', RABBITMQ_MANAGEMENT_PORT: '0',
  };
  const compose = (...args) => runDocker(['compose', '-p', project, ...args], settings).trim();
  const options = readDemoOptions({
    DEMO_SEED_SHIPMENTS: '3', DEMO_INCREMENTAL_EVENTS: '9', DEMO_INCREMENTAL_RATE: '100',
  });
  const evidence = new RunEvidence('demo', { ...options, test: 'demo workflow smoke' });
  evidence.startCollector(project, options.maxLogBytes);
  let result = 'FAIL';
  try {
    const first = new DemoWorkflow(compose, evidence, options);
    await first.start();
    await waitForExit(compose);
    const firstReport = await new DemoReport(compose, evidence, first).run();
    assert.equal(firstReport.status, 'PASS');
    assert.equal(firstReport.counts.loggedPayloads, 17);
    assert.equal(first.sourceQuery('SELECT count(*) FROM public.shipment_status_events'), '17');
    assert.ok(compose('logs', '--no-color', 'replicator').includes('Startup boundary: lastId=8'));

    const second = new DemoWorkflow(compose, evidence, options);
    await second.start();
    await waitForExit(compose);
    const secondReport = await new DemoReport(compose, evidence, second).run();
    assert.equal(secondReport.status, 'PASS');
    assert.equal(secondReport.counts.consumerReceipts, 26);
    assert.equal(secondReport.counts.loggedPayloads, 9);
    assert.equal(second.sourceQuery('SELECT count(*) FROM public.shipment_status_events'), '26');
    assert.ok(compose('logs', '--no-color', 'replicator').includes('Initial load already complete'));
    result = 'STOPPED';
  } finally {
    try {
      await evidence.stopCollector();
      evidence.snapshot();
      const writerLogs = readdirSync(evidence.serviceDirectory)
        .filter((name) => name.startsWith('source-writer-') && name.endsWith('.log'));
      if (result === 'STOPPED') assert.equal(writerLogs.length, 3);
      evidence.finish(result);
    } finally {
      // Only this test's randomly named project and volumes are removed.
      compose('down', '--volumes', '--remove-orphans');
    }
  }
});
