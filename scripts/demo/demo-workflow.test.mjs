import assert from 'node:assert/strict';
import test from 'node:test';
import { DemoWorkflow, readDemoOptions } from './demo-workflow.mjs';

const evidence = { timeline() {} };

function fakeCompose({ existingRows = 0, running = false, startupFails = false } = {}) {
  const calls = [];
  const compose = (...args) => {
    calls.push(args);
    if (args[0] === 'ps' && args.includes('source-writer')) {
      return running ? JSON.stringify({ State: 'running', Service: 'replicator' }) : '';
    }
    if (args[0] === 'ps') return JSON.stringify({ State: startupFails ? 'exited' : 'running', ExitCode: 1 });
    if (args[0] === 'logs') return startupFails ? 'Replicator failed' : 'Startup boundary: lastId=250\nSaved progress: initialId=0';
    if (args.includes('psql')) {
      return args.at(-1).includes('to_regclass') ? (existingRows ? 't' : 'f') : String(existingRows);
    }
    return '';
  };
  return { compose, calls };
}

test('demo settings have separate shipment/event counts and reject invalid values before startup', () => {
  const options = readDemoOptions({ DEMO_SEED_SHIPMENTS: '100', G1_SEED_SHIPMENTS: '4000', DEMO_INCREMENTAL_EVENTS: '9' });
  assert.equal(options.seedShipments, 100);
  assert.equal(options.incrementalEvents, 9);
  assert.throws(() => readDemoOptions({ DEMO_INCREMENTAL_EVENTS: '0' }), /DEMO_INCREMENTAL_EVENTS/);
  assert.throws(() => readDemoOptions({ DEMO_INCREMENTAL_RATE: '1001' }), /DEMO_INCREMENTAL_RATE/);
});

test('one command seeds only after infrastructure and generates only after the startup boundary', async () => {
  const fake = fakeCompose();
  const run = new DemoWorkflow(fake.compose, evidence, readDemoOptions({ DEMO_SEED_SHIPMENTS: '100', DEMO_INCREMENTAL_EVENTS: '9' }));
  await run.start();
  const infrastructure = fake.calls.findIndex((args) => args.includes('--wait'));
  const seed = fake.calls.findIndex((args) => args.includes('--shipments'));
  const startup = fake.calls.findIndex((args) => args[0] === 'logs');
  const generate = fake.calls.findIndex((args) => args.includes('generate'));
  assert.ok(infrastructure < seed && seed < startup && startup < generate);
  assert.ok(fake.calls[seed].includes('100'));
  assert.ok(fake.calls[generate].includes('9'));
});

test('repeat runs preserve source history and still generate incremental events', async () => {
  const fake = fakeCompose({ existingRows: 1000 });
  await new DemoWorkflow(fake.compose, evidence, readDemoOptions()).start();
  assert.ok(!fake.calls.some((args) => args.includes('--shipments')));
  assert.ok(fake.calls.some((args) => args.includes('generate')));
});

test('an active writer or failed replicator prevents seeding or incremental generation', async () => {
  const active = fakeCompose({ running: true });
  await assert.rejects(new DemoWorkflow(active.compose, evidence, readDemoOptions()).start(), /already active/);
  assert.equal(active.calls.length, 1);
  const failed = fakeCompose({ startupFails: true });
  await assert.rejects(new DemoWorkflow(failed.compose, evidence, readDemoOptions()).start(), /failed before incremental/);
  assert.ok(!failed.calls.some((args) => args.includes('generate')));
});
