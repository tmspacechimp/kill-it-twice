import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertConsumerCoverage,
  latestShipmentEvents,
  assertShipmentDocuments,
} from './outcomes.mjs';

const firstEvent = {
  id: 72,
  shipment_id: 1,
  version: 1,
  status: 'created',
  occurred_at: '2025-01-01T00:00:00+00:00',
};
const secondEvent = {
  id: 10001,
  shipment_id: 2,
  version: 1,
  status: 'created',
  occurred_at: '2025-01-01T00:01:00+00:00',
};
const sourceEvents = [firstEvent, secondEvent];

function delivery(event) {
  return {
    type: 'shipment.status',
    sourceId: event.id,
    record: { ...event, occurred_at: new Date(event.occurred_at).toISOString() },
  };
}

test('coverage accepts exact payloads delivered out of source order', () => {
  assertConsumerCoverage(sourceEvents, [delivery(secondEvent), delivery(firstEvent)]);
});

test('coverage rejects a missing event and names its ID', () => {
  assert.throws(
    () => assertConsumerCoverage(sourceEvents, [delivery(firstEvent)]),
    /never received source event 10001/,
  );
});

test('a duplicate cannot disguise a missing event by keeping the total count correct', () => {
  const received = [delivery(firstEvent), delivery(firstEvent)];
  assert.equal(received.length, sourceEvents.length);
  assert.throws(() => assertConsumerCoverage(sourceEvents, received), /event 72 more than once/);
});

test('an unrelated event cannot replace a missing source event', () => {
  const unrelated = { ...secondEvent, id: 999 };
  assert.throws(
    () => assertConsumerCoverage(sourceEvents, [delivery(firstEvent), delivery(unrelated)]),
    /unknown event 999/,
  );
});

test('matching IDs do not excuse incorrect payloads', () => {
  const corrupted = delivery(secondEvent);
  corrupted.record.status = 'cancelled';
  assert.throws(
    () => assertConsumerCoverage(sourceEvents, [delivery(firstEvent), corrupted]),
    /Wrong payload for event 10001/,
  );
});

test('expected shipment state uses highest version, not highest event ID or last arrival', () => {
  const highestVersion = { ...firstEvent, id: 3, version: 3, status: 'delivered' };
  const lowerVersion = { ...firstEvent, id: 900, version: 2, status: 'in_transit' };
  const expected = latestShipmentEvents([highestVersion, secondEvent, lowerVersion, firstEvent]);
  assert.deepEqual(expected, [delivery(highestVersion).record, delivery(secondEvent).record]);
});

test('document checks accept exact state and reject missing or stale state', () => {
  const expected = [delivery(firstEvent).record];
  const valid = { _id: '1', found: true, _source: expected[0] };
  assertShipmentDocuments(expected, [valid]);

  assert.throws(() => assertShipmentDocuments(expected, []), /wrong document count/);
  assert.throws(() => assertShipmentDocuments(expected, [{ _id: '1', found: false }]), /missing/);
  assert.throws(
    () => assertShipmentDocuments(expected, [{ ...valid, _id: '2' }]),
    /Unexpected document ID/,
  );
  const corrupted = { ...valid, _source: { ...expected[0], version: 99 } };
  assert.throws(() => assertShipmentDocuments(expected, [corrupted]), /Wrong latest state/);
});
