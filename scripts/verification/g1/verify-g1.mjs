import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readG1Configuration } from '../shared/configuration.mjs';
import { runScenario } from '../shared/run-scenario.mjs';
import assert from 'node:assert/strict';
import { createWait } from '../shared/environment.mjs';
import {
  assertConsumerCoverage,
  latestShipmentEvents,
  assertShipmentRecordCoverage,
} from '../shared/outcomes.mjs';
import {
  waitForReplicatorStartup,
  waitForReplicatorExit,
  assertLoadedCheckpoint,
  assertCrashCheckpoint,
  assertFinalCheckpoint,
  waitForCrashDeliveries,
  waitForConsumerDeliveries,
  assertScheduledDuplicates,
  checkIndexedShipments,
  assertFirstResumedEvent,
} from '../shared/scenario-checks.mjs';

// Read this function first. Helpers contain the evidence required by each step.
export async function verifyG1(environment, run, configuration, wait = createWait(configuration)) {
  const { initialShipments, initialEvents, incrementalEvents, crashEventId } = configuration;
  const totalEvents = initialEvents + 2 * incrementalEvents;
  const startupCheckpoint = {
    boundary: initialEvents,
    initialId: null,
    initialDone: 0,
    incrementalId: initialEvents,
  };
  console.log(`G1 project: ${environment.projectName}`);
  console.log(`Initial fixture: ${initialShipments} shipments, ${initialEvents} events`);

  console.log('1. Start isolated services and seed the initial dataset.');
  run.timeline('start infrastructure and seed');
  environment.buildApplications();
  environment.startInfrastructure();
  environment.seed();
  const initialSource = environment.readSourceEvents();
  run.save('validation/initial-source.json', initialSource);
  assert.equal(initialSource.length, initialEvents, 'Unexpected seed size');
  environment.startApplications(crashEventId);
  const startupLogs = await waitForReplicatorStartup(environment, wait);
  assertLoadedCheckpoint(startupLogs, startupCheckpoint);
  run.save('validation/startup.json', { logs: startupLogs, expectedCheckpoint: startupCheckpoint });

  console.log(`2. Append traffic and wait for SIGKILL after confirming event ${crashEventId}.`);
  run.timeline('append traffic', { eventCount: incrementalEvents });
  environment.generate(incrementalEvents);
  const crashStatus = await waitForReplicatorExit(environment, wait, 137);
  const checkpointAfterKill = environment.readStoppedCheckpoint();
  run.append('checkpoints.jsonl', {
    phase: 'after-kill',
    storage: 'durable SQLite read',
    checkpoint: checkpointAfterKill,
  });
  assertCrashCheckpoint(
    checkpointAfterKill,
    crashEventId,
    startupCheckpoint,
    initialEvents + incrementalEvents,
  );
  const crashSource = environment.readSourceEvents();
  const crashConsumer = await waitForCrashDeliveries(
    environment,
    wait,
    crashSource,
    checkpointAfterKill,
    crashEventId,
    [],
  );
  assert.ok(
    !crashConsumer.duplicateIds.includes(crashEventId),
    'Crash event was duplicated before restart',
  );
  run.save('validation/crash.json', {
    status: crashStatus,
    checkpoint: checkpointAfterKill,
    consumer: crashConsumer,
  });
  run.timeline('validated injected crash', {
    crashEventId,
    checkpoint: checkpointAfterKill,
    status: crashStatus,
  });

  console.log(
    '3. Append restart traffic, recreate the replicator, and restore both saved cursors.',
  );
  run.timeline('append restart traffic', { eventCount: incrementalEvents });
  environment.generate(incrementalEvents);
  await environment.recreateReplicator();
  const resumedLogs = await waitForReplicatorStartup(environment, wait);
  assertLoadedCheckpoint(resumedLogs, checkpointAfterKill);
  run.save('validation/restarted-replicator.json', {
    logs: resumedLogs,
    expectedCheckpoint: checkpointAfterKill,
  });

  console.log('4. Wait for initial completion and a successful exit.');
  await waitForReplicatorExit(environment, wait, 0);
  run.timeline('observed successful replicator exit');
  assertFirstResumedEvent(environment.logs('replicator'), checkpointAfterKill);
  const finalCheckpoint = environment.readStoppedCheckpoint();
  run.append('checkpoints.jsonl', {
    phase: 'final',
    storage: 'durable SQLite read',
    checkpoint: finalCheckpoint,
  });
  assertFinalCheckpoint(finalCheckpoint, initialEvents, totalEvents);

  console.log('5. Compare every source event and every latest shipment with the destinations.');
  const sourceEvents = environment.readSourceEvents();
  run.save('validation/final-source.json', sourceEvents);
  assert.equal(
    sourceEvents.length,
    totalEvents,
    'Both traffic runs must append the configured event count',
  );
  const consumerOutput = await waitForConsumerDeliveries(environment, wait, totalEvents, [
    crashEventId,
  ]);
  run.save('validation/consumer.json', consumerOutput);
  assertConsumerCoverage(sourceEvents, consumerOutput.events);
  assertScheduledDuplicates(consumerOutput.duplicateIds, [crashEventId]);
  const shipments = latestShipmentEvents(sourceEvents);
  run.save('validation/expected-shipments.json', shipments);
  checkIndexedShipments(environment, run, shipments);

  console.log(
    '6. Compare every source event with OpenSearch history and prove replay was retained.',
  );
  const shipmentRecords = assertShipmentRecordCoverage(
    sourceEvents,
    environment.readShipmentRecords(),
    crashEventId,
  );
  run.save('validation/opensearch-records-summary.json', shipmentRecords);
  return {
    shipmentRecords,
    resumedAfter: checkpointAfterKill.initialId,
    duplicateEventId: crashEventId,
    events: totalEvents,
    shipments: shipments.length,
    duplicateDeliveries: consumerOutput.duplicateIds.length,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runScenario('G1', readG1Configuration, verifyG1);
}
