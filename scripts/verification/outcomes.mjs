import assert from 'node:assert/strict';

function normalizeTimestamp(event) {
  // PostgreSQL and JSON logs spell UTC timestamps differently.
  return { ...event, occurred_at: new Date(event.occurred_at).toISOString() };
}

export function assertConsumerCoverage(sourceEvents, receivedEvents) {
  const expectedById = new Map();
  for (const event of sourceEvents) {
    expectedById.set(event.id, normalizeTimestamp(event));
  }

  const receivedIds = new Set();
  for (const message of receivedEvents) {
    const eventId = message.sourceId;
    assert.equal(message.type, 'shipment.status', `Wrong message type for event ${eventId}`);
    assert.ok(expectedById.has(eventId), `Consumer received unknown event ${eventId}`);
    assert.ok(!receivedIds.has(eventId), `Consumer processed event ${eventId} more than once`);
    assert.deepEqual(
      message.record,
      expectedById.get(eventId),
      `Wrong payload for event ${eventId}`,
    );
    receivedIds.add(eventId);
  }

  for (const eventId of expectedById.keys()) {
    assert.ok(receivedIds.has(eventId), `Consumer never received source event ${eventId}`);
  }
}

export function latestShipmentEvents(sourceEvents) {
  const latestByShipment = new Map();
  for (const event of sourceEvents) {
    const previous = latestByShipment.get(event.shipment_id);
    if (!previous || event.version > previous.version) {
      latestByShipment.set(event.shipment_id, normalizeTimestamp(event));
    }
  }
  return [...latestByShipment.values()];
}

export function assertShipmentDocuments(expectedShipments, documents) {
  assert.equal(
    documents.length,
    expectedShipments.length,
    'OpenSearch returned the wrong document count',
  );
  // _mget returns documents in the same order as the requested IDs.
  for (let index = 0; index < expectedShipments.length; index++) {
    const expected = expectedShipments[index];
    const actual = documents[index];
    const shipmentId = String(expected.shipment_id);
    assert.equal(actual._id, shipmentId, `Unexpected document ID for shipment ${shipmentId}`);
    assert.equal(actual.found, true, `Shipment ${shipmentId} is missing from OpenSearch`);
    assert.deepEqual(actual._source, expected, `Wrong latest state for shipment ${shipmentId}`);
  }
}
