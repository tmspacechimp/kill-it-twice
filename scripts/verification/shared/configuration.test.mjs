import assert from 'node:assert/strict';
import test from 'node:test';
import { readG1Configuration, readG2Configuration } from './configuration.mjs';

test('both scenarios resolve shared defaults and allow independent overrides', () => {
  const defaults = {
    DEFAULT_SEED_SHIPMENTS: '1000',
    DEFAULT_WAIT_TIMEOUT_MS: '12000',
    G1_SEED_SHIPMENTS: '${DEFAULT_SEED_SHIPMENTS}',
    G2_SEED_SHIPMENTS: '${DEFAULT_SEED_SHIPMENTS}',
    G1_WAIT_TIMEOUT_MS: '${DEFAULT_WAIT_TIMEOUT_MS}',
    G2_WAIT_TIMEOUT_MS: '${DEFAULT_WAIT_TIMEOUT_MS}',
    G2_CRASH_EVENT_IDS: '[2048,2048,2700]',
  };
  const g1 = readG1Configuration(defaults);
  const g2 = readG2Configuration(defaults);
  assert.equal(g1.initialShipments, 1000);
  assert.equal(g2.initialShipments, 1000);
  assert.equal(g1.waitTimeoutMs, 12000);
  assert.equal(g2.waitTimeoutMs, 12000);
  const customG2 = readG2Configuration({
    ...defaults,
    G2_SEED_SHIPMENTS: '1500',
    G2_WAIT_TIMEOUT_MS: '30000',
  });
  assert.equal(customG2.initialShipments, 1500);
  assert.equal(customG2.waitTimeoutMs, 30000);
  assert.equal(readG1Configuration(defaults).initialShipments, 1000);
});

test('incremental sizes are independent and bound the reachable G2 targets', () => {
  const env = { G1_INCREMENTAL_EVENTS: '17', G2_INCREMENTAL_EVENTS: '3000' };
  assert.equal(readG1Configuration(env).incrementalEvents, 17);
  assert.equal(readG2Configuration(env).incrementalEvents, 3000);
  assert.deepEqual(readG2Configuration({}).crashEventIds, [2048, 2048, 12048]);
  for (const schedule of [
    '[]',
    '{}',
    '[2048,2047]',
    '[1]',
    '[16001]',
    '[2.5]',
    '["2048"]',
    'broken',
  ]) {
    assert.throws(() => readG2Configuration({ G2_CRASH_EVENT_IDS: schedule }));
  }
  assert.throws(
    () => readG2Configuration({ G2_INCREMENTAL_EVENTS: '2000' }),
    /between 2 and 12000/,
  );
});

test('invalid defaults, scenario values, and source ID overflow are rejected', () => {
  for (const name of [
    'DEFAULT_SEED_SHIPMENTS',
    'DEFAULT_WAIT_TIMEOUT_MS',
    'G2_SEED_SHIPMENTS',
    'G2_WAIT_TIMEOUT_MS',
    'G2_INCREMENTAL_EVENTS',
  ]) {
    assert.throws(() => readG2Configuration({ [name]: '0' }), new RegExp(name));
    assert.throws(() => readG2Configuration({ [name]: 'bad' }), new RegExp(name));
  }
  assert.throws(() => readG1Configuration({ G1_WAIT_TIMEOUT_MS: '0' }), /G1_WAIT_TIMEOUT_MS/);
  assert.throws(() => readG1Configuration({ G1_INCREMENTAL_EVENTS: '0' }), /G1_INCREMENTAL_EVENTS/);
  assert.throws(() => readG2Configuration({ G2_SEED_SHIPMENTS: '858993458' }), /fit the source/);
});
