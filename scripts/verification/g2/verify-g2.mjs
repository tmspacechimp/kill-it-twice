import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readG2Configuration } from '../shared/configuration.mjs';
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
export async function verifyG2(environment, run, configuration, wait = createWait(configuration)) {
  const { initialShipments, initialEvents, incrementalEvents, crashEventIds } = configuration;
  let checkpoint = {
    boundary: initialEvents,
    initialId: null,
    initialDone: 0,
    incrementalId: initialEvents,
  };
  let trafficStarted = false;
  const crashes = [];
  run.save('crash-schedule.json', crashEventIds);
  console.log(`G2 project: ${environment.projectName}`);
  console.log(`Initial fixture: ${initialShipments} shipments, ${initialEvents} events`);

  console.log('1. Start isolated services and seed the initial dataset.');
  run.timeline('start infrastructure and seed');
  environment.buildApplications();
  environment.startInfrastructure();
  environment.seed();
  const initialSource = environment.readSourceEvents();
  run.save('validation/initial-source.json', initialSource);
  assert.equal(initialSource.length, initialEvents, 'Unexpected seed size');

  console.log('2. Run each scheduled crash and validate it before advancing.');
  for (let index = 0; index < crashEventIds.length; index++) {
    const crashEventId = crashEventIds[index];
    console.log(`   Crash ${index + 1}/${crashEventIds.length}: event ${crashEventId}`);
    run.timeline('start scheduled crash run', { index, crashEventId });
    if (index === 0) environment.startApplications(crashEventId);
    else await environment.recreateReplicator(crashEventId);

    const startupLogs = await waitForReplicatorStartup(environment, wait);
    assertLoadedCheckpoint(startupLogs, checkpoint);
    run.save(`validation/startup-${index + 1}.json`, {
      logs: startupLogs,
      expectedCheckpoint: checkpoint,
    });
    if (crashEventId > initialEvents && !trafficStarted) {
      // Delay traffic until the first incremental target is installed. Earlier
      // initial-load runs must not checkpoint a future scheduled target.
      run.timeline('append incremental crash traffic', { eventCount: incrementalEvents });
      environment.generate(incrementalEvents);
      trafficStarted = true;
    }

    const status = await waitForReplicatorExit(environment, wait, 137);
    const checkpointAfterKill = environment.readStoppedCheckpoint();
    run.append('checkpoints.jsonl', {
      phase: 'after-crash',
      index,
      crashEventId,
      storage: 'durable SQLite read',
      checkpoint: checkpointAfterKill,
    });
    const source = environment.readSourceEvents();
    assertCrashCheckpoint(checkpointAfterKill, crashEventId, checkpoint, source.at(-1).id);
    const precedingCrashes = crashEventIds.slice(0, index);
    const consumer = await waitForCrashDeliveries(
      environment,
      wait,
      source,
      checkpointAfterKill,
      crashEventId,
      precedingCrashes,
    );
    const crash = { crashEventId, checkpoint: checkpointAfterKill };
    run.save(`validation/crash-${index + 1}.json`, {
      status,
      ...crash,
      consumer,
      logs: environment.logs('replicator'),
    });
    run.timeline('validated scheduled crash', { index, ...crash });
    checkpoint = checkpointAfterKill;
    crashes.push(crash);
  }

  console.log(
    '3. Append restart traffic, recreate without injection, and restore both saved cursors.',
  );
  // Write while stopped so replaying the last incremental row cannot activate
  // the idle-stop limit before a slow writer-container startup supplies traffic.
  run.timeline('append restart traffic', { eventCount: incrementalEvents });
  environment.generate(incrementalEvents);
  await environment.recreateReplicator();
  const resumedLogs = await waitForReplicatorStartup(environment, wait);
  assertLoadedCheckpoint(resumedLogs, checkpoint);
  run.save('validation/final-startup.json', { logs: resumedLogs, expectedCheckpoint: checkpoint });

  console.log('4. Wait for initial completion and a successful exit.');
  await waitForReplicatorExit(environment, wait, 0);
  run.timeline('observed successful replicator exit');
  assertFirstResumedEvent(environment.logs('replicator'), checkpoint);
  const trafficRuns = trafficStarted ? 2 : 1;
  const totalEvents = initialEvents + trafficRuns * incrementalEvents;
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
    'Traffic runs must append the configured event count',
  );
  const consumerOutput = await waitForConsumerDeliveries(
    environment,
    wait,
    totalEvents,
    crashEventIds,
  );
  run.save('validation/consumer.json', consumerOutput);
  assertConsumerCoverage(sourceEvents, consumerOutput.events);
  assertScheduledDuplicates(consumerOutput.duplicateIds, crashEventIds);
  const shipments = latestShipmentEvents(sourceEvents);
  run.save('validation/expected-shipments.json', shipments);
  checkIndexedShipments(environment, run, shipments);

  console.log(
    '6. Compare every source event with OpenSearch history and prove each scheduled replay.',
  );
  const shipmentRecords = assertShipmentRecordCoverage(
    sourceEvents,
    environment.readShipmentRecords(),
    crashEventIds,
  );
  run.save('validation/opensearch-records-summary.json', shipmentRecords);
  return {
    crashes,
    events: totalEvents,
    shipments: shipments.length,
    duplicateDeliveries: consumerOutput.duplicateIds.length,
    shipmentRecords,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runScenario('G2', readG2Configuration, verifyG2);
}
