import assert from 'node:assert/strict';
import { RunEvidence } from '../logging/run-evidence.mjs';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { VerificationEnvironment, waitFor } from './environment.mjs';
import {
  assertConsumerCoverage,
  latestShipmentEvents,
  assertShipmentDocuments,
} from './outcomes.mjs';

const run = new RunEvidence('verify-g1');
run.captureConsole();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    run.timeline('verification interrupted', { signal });
    try {
      await run.stopCollector();
    } catch (error) {
      console.error(error);
    }
    run.finish('INTERRUPTED', { signal });
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

if (existsSync('.env')) loadEnvFile('.env');
loadEnvFile('.env.verify');

const seedShipments = process.env.G1_SEED_SHIPMENTS ?? '4000';
const INITIAL_SHIPMENTS = Number(seedShipments);
assert.ok(
  /^\d+$/.test(seedShipments) && INITIAL_SHIPMENTS >= 1 && INITIAL_SHIPMENTS <= 858_993_458,
  'G1_SEED_SHIPMENTS must be an integer between 1 and 858993458',
);
// Odd shipments have three events; even shipments have two.
const INITIAL_EVENTS = 3 * Math.ceil(INITIAL_SHIPMENTS / 2) + 2 * Math.floor(INITIAL_SHIPMENTS / 2);
const CRASH_EVENT_ID = Number(process.env.G1_CRASH_EVENT_ID);
assert.ok(
  Number.isInteger(CRASH_EVENT_ID) && CRASH_EVENT_ID > 1 && CRASH_EVENT_ID < INITIAL_EVENTS,
  `G1_CRASH_EVENT_ID must be an integer between 2 and ${INITIAL_EVENTS - 1}`,
);
const EVENTS_PER_TRAFFIC_RUN = 9;
const FIRST_INCREMENTAL_END = INITIAL_EVENTS + EVENTS_PER_TRAFFIC_RUN;
const TOTAL_EVENTS = INITIAL_EVENTS + 2 * EVENTS_PER_TRAFFIC_RUN;

const environment = new VerificationEnvironment(`kill-it-twice-g1-${randomUUID()}`, run);
run.summary.configuration = {
  projectName: environment.projectName, initialShipments: INITIAL_SHIPMENTS,
  initialEvents: INITIAL_EVENTS, crashEventId: CRASH_EVENT_ID,
  firstIncrementalEnd: FIRST_INCREMENTAL_END, expectedEvents: TOTAL_EVENTS,
  eventsPerTrafficRun: EVENTS_PER_TRAFFIC_RUN,
  waitTimeoutMs: process.env.G1_WAIT_TIMEOUT_MS ?? '600000',
  pollIntervalMs: 1000, pollMaxEmpty: 3,
};
run.saveSummary();
run.startCollector(environment.projectName);

// Read this function first. Helpers below contain the evidence required by each step.
async function verifyG1() {
  console.log(`G1 project: ${environment.projectName}`);
  console.log(`Initial fixture: ${INITIAL_SHIPMENTS} shipments, ${INITIAL_EVENTS} events`);

  console.log('1. Start isolated services and seed the initial dataset.');
  run.timeline('start infrastructure and seed', { services: ['postgres', 'opensearch', 'rabbitmq', 'source-writer'] });
  environment.buildApplications();
  environment.startInfrastructure();
  environment.seed();
  const initialSource = environment.readSourceEvents();
  run.save('validation/initial-source.json', initialSource);
  assert.equal(initialSource.length, INITIAL_EVENTS, 'Unexpected seed size');
  run.timeline('start crash-injected replicator', { service: 'replicator', crashEventId: CRASH_EVENT_ID });
  environment.startApplications(CRASH_EVENT_ID);
  await waitForReplicatorStartup();
  run.append('checkpoints.jsonl', { phase: 'before-kill', storage: 'durable SQLite read', checkpoint: environment.readRunningCheckpoint() });

  console.log(
    `2. Append traffic and wait for the publisher to SIGKILL itself after confirming event ${CRASH_EVENT_ID}.`,
  );
  run.timeline('append traffic', { service: 'source-writer', eventCount: EVENTS_PER_TRAFFIC_RUN });
  environment.generate(EVENTS_PER_TRAFFIC_RUN);
  await waitForInjectedCrash();
  const checkpointAfterKill = environment.readStoppedCheckpoint();
  run.append('checkpoints.jsonl', { phase: 'after-kill', storage: 'durable SQLite read', checkpoint: checkpointAfterKill });
  assertKilledBeforeCheckpoint(checkpointAfterKill);
  await waitForOriginalDelivery();

  console.log('3. Recreate the replicator and prove it resumes after the saved cursor.');
  await environment.recreateReplicator();
  await waitForDuplicateDelivery();
  const resumedLogs = await waitForInitialLoadToFinish();
  run.save('validation/restarted-replicator.json', { logs: resumedLogs });
  run.append('checkpoints.jsonl', {
    phase: 'loaded-after-restart', storage: 'startup log of loaded checkpoint; not a fresh disk read',
    startupBoundary: resumedLogs.match(/Startup boundary:.*$/m)?.[0],
    savedProgress: resumedLogs.match(/Saved progress:.*$/m)?.[0],
  });
  assertResumedFromCheckpoint(resumedLogs, checkpointAfterKill);

  console.log('4. Append traffic after initial completion and wait for a successful exit.');
  run.timeline('append post-load traffic', { service: 'source-writer', eventCount: EVENTS_PER_TRAFFIC_RUN });
  environment.generate(EVENTS_PER_TRAFFIC_RUN);
  await waitForSuccessfulExit();
  run.append('checkpoints.jsonl', { phase: 'final', storage: 'durable SQLite read', checkpoint: environment.readStoppedCheckpoint() });

  console.log('5. Compare every source event and every latest shipment with the destinations.');
  const sourceEvents = environment.readSourceEvents();
  run.save('validation/final-source.json', sourceEvents);
  assert.equal(sourceEvents.length, TOTAL_EVENTS, 'Both traffic runs must append nine events');
  const consumerOutput = await waitForConsumerDeliveries(sourceEvents.length);
  run.save('validation/consumer.json', consumerOutput);
  assertConsumerCoverage(sourceEvents, consumerOutput.events);
  assert.ok(
    consumerOutput.duplicateIds.includes(CRASH_EVENT_ID),
    'Missing duplicate for the crash event',
  );
  const shipments = latestShipmentEvents(sourceEvents);
  run.save('validation/expected-shipments.json', shipments);
  checkIndexedShipments(shipments);

  return {
    resumedAfter: checkpointAfterKill.initialId,
    duplicateEventId: CRASH_EVENT_ID,
    events: sourceEvents.length,
    shipments: shipments.length,
    duplicateDeliveries: consumerOutput.duplicateIds.length,
  };
}

async function waitForReplicatorStartup() {
  await waitFor('replicator startup', () => {
    const logs = readHealthyReplicatorLogs();
    return logs.includes('Saved progress:');
  });
}

async function waitForInjectedCrash() {
  await waitFor('publisher SIGKILL after broker confirmation', () => {
    const status = environment.replicatorStatus();
    if (status.State !== 'exited') return false;
    run.timeline('observed injected SIGKILL', { service: 'replicator', status, crashEventId: CRASH_EVENT_ID });
    assert.equal(status.ExitCode, 137, 'Expected a SIGKILL exit');
    return true;
  });
}

function assertKilledBeforeCheckpoint(afterKill) {
  assert.equal(afterKill.boundary, INITIAL_EVENTS, 'The original boundary must be retained');
  assert.equal(
    afterKill.initialId,
    CRASH_EVENT_ID - 1,
    'The confirmed crash event must not be checkpointed',
  );
  assert.equal(afterKill.initialDone, 0, 'The killed initial load must still be unfinished');
  assert.equal(afterKill.incrementalId, FIRST_INCREMENTAL_END, 'Incremental progress was lost');
  console.log(
    `   Saved at kill: initial=${afterKill.initialId}, incremental=${afterKill.incrementalId}`,
  );
}

async function waitForOriginalDelivery() {
  const sourceEvent = environment.readSourceEvents().find((event) => event.id === CRASH_EVENT_ID);
  assert.ok(sourceEvent, 'Crash event is missing from the source');

  await waitFor(`original consumer delivery of event ${CRASH_EVENT_ID} before restart`, () => {
    const output = environment.readConsumerOutput();
    const deliveries = output.events.filter((message) => message.sourceId === CRASH_EVENT_ID);
    assert.ok(
      !output.duplicateIds.includes(CRASH_EVENT_ID),
      'Crash event was already duplicated before restart',
    );
    if (deliveries.length === 0) return false;
    assertConsumerCoverage([sourceEvent], deliveries);
    return true;
  });
  console.log(`   Consumer processed event ${CRASH_EVENT_ID} before restart.`);
}

async function waitForDuplicateDelivery() {
  await waitFor(`consumer duplicate log for event ${CRASH_EVENT_ID}`, () => {
    readHealthyReplicatorLogs();
    const output = environment.readConsumerOutput();
    return output.duplicateIds.includes(CRASH_EVENT_ID);
  });
  console.log(`   Consumer logged: Duplicate event received: sourceId=${CRASH_EVENT_ID}; skipping`);
}

async function waitForInitialLoadToFinish() {
  return waitFor('initial completion after restart', () => {
    const logs = readHealthyReplicatorLogs();
    if (logs.includes('Initial load complete:')) return logs;
    return false;
  });
}

function assertResumedFromCheckpoint(logs, checkpoint) {
  const expectedProgress = `Saved progress: initialId=${checkpoint.initialId} initialDone=0 incrementalId=${checkpoint.incrementalId}`;
  assert.ok(logs.includes(expectedProgress), 'Restart did not restore both saved cursors');
  assert.ok(
    logs.includes(`Startup boundary: lastId=${INITIAL_EVENTS}`),
    'Restart changed the boundary',
  );

  const firstBatch = /Initial batch 1: rows=\d+ firstId=(\d+)/.exec(logs);
  assert.ok(firstBatch, 'Restart produced no completed initial batch');
  const firstResumedEvent = Number(firstBatch[1]);
  // The seeded IDs are contiguous, so the next required event is exactly cursor + 1.
  assert.equal(
    firstResumedEvent,
    checkpoint.initialId + 1,
    'Restart skipped or repeated initial rows',
  );
  console.log(`   First resumed initial event: ${firstResumedEvent}`);
}

async function waitForSuccessfulExit() {
  await waitFor('replicator exit after post-load traffic', () => {
    const status = environment.replicatorStatus();
    if (status.State !== 'exited') return false;
    run.timeline('observed replicator exit', { service: 'replicator', status });
    assert.equal(status.ExitCode, 0, 'Replicator failed after restart');
    return true;
  });
}

function readHealthyReplicatorLogs() {
  const logs = environment.logs('replicator');
  assert.ok(!logs.includes('Replicator failed'), `Replicator reported failure:\n${logs}`);
  const status = environment.replicatorStatus();
  assert.equal(
    status.State,
    'running',
    `Replicator stopped unexpectedly: ${JSON.stringify(status)}`,
  );
  return logs;
}

async function waitForConsumerDeliveries(expectedCount) {
  return waitFor('consumer delivery of all source events', () => {
    const output = environment.readConsumerOutput();
    // Reaching the count only ends the wait. Exact IDs, payloads, and duplicates
    // are checked separately, so a repeated or unrelated ID cannot hide a gap.
    if (output.events.length >= expectedCount) return output;
    return false;
  });
}

function checkIndexedShipments(shipments) {
  const batchSize = 500;
  for (let offset = 0; offset < shipments.length; offset += batchSize) {
    const expectedShipments = shipments.slice(offset, offset + batchSize);
    const shipmentIds = expectedShipments.map((event) => event.shipment_id);
    const documents = environment.readShipmentDocuments(shipmentIds);
    assertShipmentDocuments(expectedShipments, documents);
  }
}

// A failed assertion or failed cleanup must produce a nonzero command exit.
// Only this randomly named project's containers and volumes may be removed.
let evidence;
try {
  evidence = await verifyG1();
} catch (error) {
  process.exitCode = 1;
  run.save('validation/failure.json', { message: error.message, stack: error.stack, actual: error.actual, expected: error.expected });
  run.timeline('verification failed', { message: error.message });
  console.error('G1 FAIL:', error);
  try {
    console.error(environment.failureLogs());
  } catch (logError) {
    console.error('Could not collect container logs:', logError.message);
  }
} finally {
  try {
    await run.stopCollector();
    run.snapshot();
  } catch (error) {
    process.exitCode = 1;
    console.error('G1 log collection failed:', error);
    run.timeline('log collection failed', { message: error.message });
  }
  try {
    run.timeline('remove isolated project', { projectName: environment.projectName });
    environment.removeProject();
    run.timeline('isolated project removed', { projectName: environment.projectName });
  } catch (error) {
    process.exitCode = 1;
    console.error(`G1 cleanup failed for ${environment.projectName}:`, error);
  }
}

run.finish(process.exitCode ? 'FAIL' : 'PASS', evidence);

if (!process.exitCode) {
  console.log(`G1 PASS: ${JSON.stringify(evidence)}`);
  console.log('G2-G5 NOT IMPLEMENTED; this command checks G1 only.');
}
