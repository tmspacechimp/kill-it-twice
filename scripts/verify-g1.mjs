import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { VerificationEnvironment, waitFor } from './verification/environment.mjs';
import {
  assertConsumerCoverage,
  latestShipmentEvents,
  assertShipmentDocuments,
} from './verification/outcomes.mjs';

const INITIAL_SHIPMENTS = 4000;
const INITIAL_EVENTS = 10000;
const EVENTS_PER_TRAFFIC_RUN = 9;
const FIRST_INCREMENTAL_END = INITIAL_EVENTS + EVENTS_PER_TRAFFIC_RUN;
const TOTAL_EVENTS = INITIAL_EVENTS + 2 * EVENTS_PER_TRAFFIC_RUN;

const environment = new VerificationEnvironment(`kill-it-twice-g1-${randomUUID()}`);

// Read this function first. Helpers below contain the evidence required by each step.
async function verifyG1() {
  console.log(`G1 project: ${environment.projectName}`);

  console.log('1. Start isolated services and seed the initial dataset.');
  environment.buildApplications();
  environment.startInfrastructure();
  environment.seed(INITIAL_SHIPMENTS);
  assert.equal(environment.readSourceEvents().length, INITIAL_EVENTS, 'Unexpected seed size');
  environment.startApplications();
  await waitForReplicatorStartup();

  console.log('2. Append traffic while initial loading is running, then kill the replicator.');
  environment.generate(EVENTS_PER_TRAFFIC_RUN);
  const checkpointBeforeKill = await waitForBothReadersToMakeProgress();
  environment.killReplicator();
  assert.equal(environment.replicatorStatus().ExitCode, 137, 'Expected a SIGKILL exit');
  const checkpointAfterKill = environment.readStoppedCheckpoint();
  assertKilledMidLoad(checkpointBeforeKill, checkpointAfterKill);

  console.log('3. Recreate the replicator and prove it resumes after the saved cursor.');
  environment.recreateReplicator();
  const resumedLogs = await waitForInitialLoadToFinish();
  assertResumedFromCheckpoint(resumedLogs, checkpointAfterKill);

  console.log('4. Append traffic after initial completion and wait for a successful exit.');
  environment.generate(EVENTS_PER_TRAFFIC_RUN);
  await waitForSuccessfulExit();

  console.log('5. Compare every source event and every latest shipment with the destinations.');
  const sourceEvents = environment.readSourceEvents();
  assert.equal(sourceEvents.length, TOTAL_EVENTS, 'Both traffic runs must append nine events');
  const consumerOutput = await waitForConsumerDeliveries(sourceEvents.length);
  assertConsumerCoverage(sourceEvents, consumerOutput.events);
  const shipments = latestShipmentEvents(sourceEvents);
  checkIndexedShipments(shipments);

  return {
    resumedAfter: checkpointAfterKill.initialId,
    events: sourceEvents.length,
    shipments: shipments.length,
    duplicateDeliveries: consumerOutput.duplicateCount,
  };
}

async function waitForReplicatorStartup() {
  await waitFor('replicator startup', () => {
    const logs = readHealthyReplicatorLogs();
    return logs.includes('Saved progress:');
  });
}

async function waitForBothReadersToMakeProgress() {
  return waitFor('initial and incremental progress before SIGKILL', () => {
    readHealthyReplicatorLogs();
    const checkpoint = environment.readRunningCheckpoint();
    assert.equal(checkpoint.boundary, INITIAL_EVENTS, 'Startup must capture the seeded boundary');
    assert.equal(checkpoint.initialDone, 0, 'Initial load finished before we could kill it');
    assert.ok(checkpoint.initialId < INITIAL_EVENTS, 'No unfinished initial rows remain');

    const initialHasProgress = checkpoint.initialId !== null && checkpoint.initialId > 0;
    const incrementalIsCaughtUp = checkpoint.incrementalId === FIRST_INCREMENTAL_END;
    if (initialHasProgress && incrementalIsCaughtUp) return checkpoint;
    return false;
  });
}

function assertKilledMidLoad(beforeKill, afterKill) {
  // Progress may advance between observing the checkpoint and delivering SIGKILL.
  assert.equal(afterKill.boundary, INITIAL_EVENTS, 'The original boundary must be retained');
  assert.ok(afterKill.initialId >= beforeKill.initialId, 'Committed initial progress was lost');
  assert.ok(afterKill.initialId < INITIAL_EVENTS, 'SIGKILL arrived after initial loading ended');
  assert.equal(afterKill.initialDone, 0, 'The killed initial load must still be unfinished');
  assert.equal(afterKill.incrementalId, FIRST_INCREMENTAL_END, 'Incremental progress was lost');
  console.log(
    `   Saved at kill: initial=${afterKill.initialId}, incremental=${afterKill.incrementalId}`,
  );
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
  console.error('G1 FAIL:', error);
  try {
    console.error(environment.failureLogs());
  } catch (logError) {
    console.error('Could not collect container logs:', logError.message);
  }
} finally {
  try {
    environment.removeProject();
  } catch (error) {
    process.exitCode = 1;
    console.error(`G1 cleanup failed for ${environment.projectName}:`, error);
  }
}

if (!process.exitCode) {
  console.log(`G1 PASS: ${JSON.stringify(evidence)}`);
  console.log('G2-G5 NOT IMPLEMENTED; this command checks G1 only.');
}
