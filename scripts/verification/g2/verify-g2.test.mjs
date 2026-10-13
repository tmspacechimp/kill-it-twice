import assert from 'node:assert/strict';
import test from 'node:test';
import { readG2Configuration } from '../shared/configuration.mjs';
import { verifyG2 } from './verify-g2.mjs';
import { scenarioFixture } from '../shared/scenario-fixture.mjs';

function fixture(overrides = {}, schedule = '[2,2,11]') {
  const configuration = readG2Configuration({
    G2_SEED_SHIPMENTS: '3',
    G2_INCREMENTAL_EVENTS: '9',
    G2_CRASH_EVENT_IDS: schedule,
  });
  return scenarioFixture(configuration, overrides);
}

test('G2 replays repeated initial targets and an incremental target while initial work remains', async () => {
  const f = fixture();
  const result = await verifyG2(f.environment, f.evidence, f.configuration, f.wait);
  assert.deepEqual(f.calls, [
    ['start', 2],
    ['start', 2],
    ['start', 11],
    ['traffic', 9],
    ['traffic', 9],
    ['start', ''],
  ]);
  assert.equal(result.crashes.length, 3);
  assert.equal(result.crashes[2].checkpoint.incrementalId, 10);
  assert.equal(result.crashes[2].checkpoint.initialDone, 0);
  assert.equal(result.duplicateDeliveries, 3);
  assert.equal(result.events, 26);
  assert.equal(result.shipmentRecords.documents, 29);
});

test('an initial-only schedule still receives final incremental activity', async () => {
  const f = fixture({}, '[2,2,4]');
  const result = await verifyG2(f.environment, f.evidence, f.configuration, f.wait);
  assert.deepEqual(f.calls, [
    ['start', 2],
    ['start', 2],
    ['start', 4],
    ['traffic', 9],
    ['start', ''],
  ]);
  assert.equal(result.events, 17);
});

test('an incremental-only schedule and repeated incremental target resume the saved incremental cursor', async () => {
  const f = fixture({}, '[11,11,13]');
  const result = await verifyG2(f.environment, f.evidence, f.configuration, f.wait);
  assert.deepEqual(
    result.crashes.map((crash) => crash.checkpoint.incrementalId),
    [10, 10, 12],
  );
  assert.equal(result.duplicateDeliveries, 3);
});

test('a missing crash stops the schedule before any next restart', async () => {
  const f = fixture({ replicatorStatus: () => ({ State: 'exited', ExitCode: 0 }) });
  await assert.rejects(
    verifyG2(f.environment, f.evidence, f.configuration, f.wait),
    /Unexpected replicator exit/,
  );
  assert.deepEqual(f.calls, [['start', 2]]);
});

test('a target at the end of the first traffic batch has new traffic available before final restart', async () => {
  const f = fixture({}, '[11,11,17]');
  const result = await verifyG2(f.environment, f.evidence, f.configuration, f.wait);
  assert.equal(result.crashes[2].checkpoint.incrementalId, 16);
  assert.deepEqual(f.calls.slice(-2), [
    ['traffic', 9],
    ['start', ''],
  ]);
  assert.equal(result.events, 26);
});

test('destination count rejects extra shipments even when all expected documents match', async () => {
  const f = fixture({ readShipmentCount: () => 27 });
  await assert.rejects(
    verifyG2(f.environment, f.evidence, f.configuration, f.wait),
    /extra or missing/,
  );
});

test('evidence write failures cannot advance the crash schedule', async () => {
  const f = fixture();
  f.evidence.save = (name) => {
    if (name === 'validation/crash-1.json') throw new Error('Evidence disk failed');
  };
  await assert.rejects(
    verifyG2(f.environment, f.evidence, f.configuration, f.wait),
    /Evidence disk failed/,
  );
  assert.deepEqual(f.calls, [['start', 2]]);
});

test('a repeated target without its duplicate notice cannot advance to the third crash', async () => {
  const f = fixture();
  const read = f.environment.readConsumerOutput;
  f.environment.readConsumerOutput = () => ({ ...read(), duplicateIds: [] });
  await assert.rejects(
    verifyG2(f.environment, f.evidence, f.configuration, f.wait),
    /preceding replays/,
  );
  assert.deepEqual(f.calls, [
    ['start', 2],
    ['start', 2],
  ]);
});

test('a second normal handling of an event fails before the next crash', async () => {
  const f = fixture();
  const read = f.environment.readConsumerOutput;
  f.environment.readConsumerOutput = () => {
    const output = read();
    output.events.push(output.events[0]);
    return output;
  };
  await assert.rejects(
    verifyG2(f.environment, f.evidence, f.configuration, f.wait),
    /more than once/,
  );
  assert.deepEqual(f.calls, [['start', 2]]);
});
