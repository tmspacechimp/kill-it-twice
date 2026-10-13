import assert from 'node:assert/strict';
import test from 'node:test';
import { readG1Configuration } from '../shared/configuration.mjs';
import { verifyG1 } from './verify-g1.mjs';
import { scenarioFixture } from '../shared/scenario-fixture.mjs';

test('G1 supplies configured traffic before the crash and while stopped before restart', async () => {
  const configuration = readG1Configuration({
    G1_SEED_SHIPMENTS: '3',
    G1_INCREMENTAL_EVENTS: '7',
    G1_CRASH_EVENT_ID: '2',
  });
  const f = scenarioFixture(configuration);
  const result = await verifyG1(f.environment, f.evidence, configuration, f.wait);
  assert.deepEqual(f.calls, [
    ['start', 2],
    ['traffic', 7],
    ['traffic', 7],
    ['start', ''],
  ]);
  assert.equal(result.events, 22);
  assert.equal(result.duplicateDeliveries, 1);
  assert.equal(result.shipmentRecords.documents, 23);
});
