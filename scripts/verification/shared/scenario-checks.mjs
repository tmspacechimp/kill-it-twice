import assert from 'node:assert/strict';
import { assertConsumerCoverage, assertShipmentDocuments } from './outcomes.mjs';

export async function waitForReplicatorStartup(environment, wait) {
  return wait('replicator startup', () => {
    const logs = environment.logs('replicator');
    assert.ok(!logs.includes('Replicator failed'), 'Replicator reported failure');
    // A repeated target can crash before the harness observes a running process.
    if (logs.includes('Saved progress:')) return logs;
    assert.equal(
      environment.replicatorStatus().State,
      'running',
      'Replicator stopped without startup evidence',
    );
    return false;
  });
}

export async function waitForReplicatorExit(environment, wait, expectedExitCode) {
  return wait(`replicator exit ${expectedExitCode}`, () => {
    const status = environment.replicatorStatus();
    if (status.State !== 'exited') return false;
    assert.equal(status.ExitCode, expectedExitCode, 'Unexpected replicator exit');
    return status;
  });
}

export function assertLoadedCheckpoint(logs, checkpoint) {
  assert.ok(
    logs.includes(`Startup boundary: lastId=${checkpoint.boundary}`),
    'Restart changed the boundary',
  );
  const progress = `Saved progress: initialId=${checkpoint.initialId ?? 'none'} initialDone=${checkpoint.initialDone} incrementalId=${checkpoint.incrementalId}`;
  assert.ok(logs.includes(progress), 'Restart did not restore both saved cursors');
}

export function assertFirstResumedEvent(logs, checkpoint) {
  if (checkpoint.initialDone === 1) return;
  const firstBatch = /Initial batch 1: rows=\d+ firstId=(\d+)/.exec(logs);
  assert.ok(firstBatch, 'Restart produced no completed initial batch');
  const expectedId = (checkpoint.initialId ?? 0) + 1;
  assert.equal(Number(firstBatch[1]), expectedId, 'Restart skipped or repeated initial rows');
  console.log(`   First resumed initial event: ${firstBatch[1]}`);
}

export function assertCrashCheckpoint(checkpoint, crashEventId, previous, lastSourceId) {
  assert.equal(checkpoint.boundary, previous.boundary, 'The original startup boundary changed');
  assert.ok(checkpoint.initialId >= (previous.initialId ?? 0), 'Initial progress was lost');
  assert.ok(checkpoint.initialId <= checkpoint.boundary, 'Initial cursor crossed its boundary');
  assert.ok(checkpoint.incrementalId >= previous.incrementalId, 'Incremental progress was lost');
  assert.ok(checkpoint.incrementalId <= lastSourceId, 'Incremental cursor crossed the source end');
  assert.ok([0, 1].includes(checkpoint.initialDone), 'Invalid initial completion flag');
  assert.ok(checkpoint.initialDone >= previous.initialDone, 'Initial completion was lost');

  if (crashEventId <= checkpoint.boundary) {
    assert.equal(
      checkpoint.initialId,
      crashEventId - 1,
      'Initial crash event was checkpointed or progress was lost',
    );
    assert.equal(checkpoint.initialDone, 0, 'The crashed initial load must be unfinished');
  } else {
    assert.equal(
      checkpoint.incrementalId,
      crashEventId - 1,
      'Incremental crash event was checkpointed or progress was lost',
    );
  }
  if (checkpoint.initialDone === 1) {
    assert.equal(
      checkpoint.initialId,
      checkpoint.boundary,
      'Completed initial cursor is incomplete',
    );
  }
}

export function assertFinalCheckpoint(checkpoint, initialEvents, totalEvents) {
  assert.equal(checkpoint.boundary, initialEvents, 'Final startup boundary changed');
  assert.equal(checkpoint.initialId, initialEvents, 'Initial cursor is incomplete');
  assert.equal(checkpoint.initialDone, 1, 'Initial load did not finish');
  assert.equal(checkpoint.incrementalId, totalEvents, 'Incremental cursor is incomplete');
}

export function assertScheduledDuplicates(duplicateIds, replayedSchedule) {
  const required = new Map();
  for (const id of replayedSchedule) {
    required.set(id, (required.get(id) ?? 0) + 1);
  }
  for (const [id, count] of required) {
    const observed = duplicateIds.filter((duplicateId) => duplicateId === id).length;
    assert.ok(
      observed >= count,
      `Event ${id} needs ${count} duplicate notices; observed ${observed}`,
    );
  }
}

function hasScheduledDuplicates(duplicateIds, schedule) {
  const remaining = [...duplicateIds];
  for (const id of schedule) {
    const position = remaining.indexOf(id);
    if (position < 0) return false;
    remaining.splice(position, 1);
  }
  return true;
}

export async function waitForCrashDeliveries(
  environment,
  wait,
  source,
  checkpoint,
  crashEventId,
  replays,
) {
  const requiredSource = source.filter(
    (event) =>
      event.id <= (checkpoint.initialId ?? 0) ||
      (event.id > checkpoint.boundary && event.id <= checkpoint.incrementalId) ||
      event.id === crashEventId,
  );

  return wait('confirmed crash delivery and preceding replays', () => {
    const output = environment.readConsumerOutput();
    const receivedIds = new Set(output.events.map((message) => message.sourceId));
    const observedSource = source.filter((event) => receivedIds.has(event.id));
    // The other reader can publish beyond its saved cursor before the kill.
    // Validate every observed payload, then wait for all checkpointed events.
    assertConsumerCoverage(observedSource, output.events);
    if (!requiredSource.every((event) => receivedIds.has(event.id))) return false;
    if (!hasScheduledDuplicates(output.duplicateIds, replays)) return false;
    return output;
  });
}

export async function waitForConsumerDeliveries(environment, wait, expectedCount, replays) {
  return wait('consumer delivery of all source events and scheduled replays', () => {
    const output = environment.readConsumerOutput();
    if (output.events.length < expectedCount) return false;
    if (!hasScheduledDuplicates(output.duplicateIds, replays)) return false;
    return output;
  });
}

export function checkIndexedShipments(environment, run, shipments) {
  const batchSize = 500;
  for (let offset = 0; offset < shipments.length; offset += batchSize) {
    const expectedShipments = shipments.slice(offset, offset + batchSize);
    const shipmentIds = expectedShipments.map((event) => event.shipment_id);
    const documents = environment.readShipmentDocuments(shipmentIds);
    assertShipmentDocuments(expectedShipments, documents);
  }
  const count = environment.readShipmentCount();
  run.save('validation/opensearch-count.json', { expected: shipments.length, actual: count });
  assert.equal(count, shipments.length, 'OpenSearch has extra or missing shipment documents');
}
