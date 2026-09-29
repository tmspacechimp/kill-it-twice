import assert from 'node:assert/strict';
import test from 'node:test';
import { generateEvents, MAX_SHIPMENTS } from '../dist/generator.js';

test('two shipments have complete ordered histories and fixed timestamps', () => {
  assert.deepEqual(
    [...generateEvents(2)],
    [
      {
        id: 1,
        shipment_id: 1,
        version: 1,
        status: 'created',
        occurred_at: '2025-01-01T00:01:00.000Z',
      },
      {
        id: 2,
        shipment_id: 1,
        version: 2,
        status: 'in_transit',
        occurred_at: '2025-01-01T00:02:00.000Z',
      },
      {
        id: 3,
        shipment_id: 1,
        version: 3,
        status: 'delivered',
        occurred_at: '2025-01-01T00:03:00.000Z',
      },
      {
        id: 4,
        shipment_id: 2,
        version: 1,
        status: 'created',
        occurred_at: '2025-01-01T00:04:00.000Z',
      },
      {
        id: 5,
        shipment_id: 2,
        version: 2,
        status: 'cancelled',
        occurred_at: '2025-01-01T00:05:00.000Z',
      },
    ],
  );
});

test('default fixture is deterministic with unique IDs and complete histories', () => {
  const events = [...generateEvents()];
  assert.deepEqual(events, [...generateEvents()]);
  assert.equal(events.length, 10_000);
  assert.equal(new Set(events.map((event) => event.shipment_id)).size, 4_000);
  const counts = { created: 0, in_transit: 0, delivered: 0, cancelled: 0 };
  let previous;
  for (const [index, event] of events.entries()) {
    assert.equal(event.id, index + 1);
    assert.equal(
      event.occurred_at,
      new Date(Date.parse('2025-01-01T00:00:00Z') + event.id * 60_000).toISOString(),
    );
    const sameShipment = previous?.shipment_id === event.shipment_id;
    assert.equal(event.version, sameShipment ? previous.version + 1 : 1);
    assert.equal(
      event.shipment_id,
      sameShipment ? previous.shipment_id : (previous?.shipment_id ?? 0) + 1,
    );
    const history =
      event.shipment_id % 2 ? ['created', 'in_transit', 'delivered'] : ['created', 'cancelled'];
    assert.equal(event.status, history[event.version - 1]);
    if (previous && !sameShipment)
      assert.equal(previous.status, previous.shipment_id % 2 ? 'delivered' : 'cancelled');
    counts[event.status]++;
    previous = event;
  }
  assert.equal(previous.status, 'cancelled');
  assert.deepEqual(counts, {
    created: 4_000,
    in_transit: 2_000,
    delivered: 2_000,
    cancelled: 2_000,
  });
});

test('custom odd counts include the last complete history', () => {
  assert.equal([...generateEvents(1)].length, 3);
  const events = [...generateEvents(3)];
  assert.equal(events.length, 8);
  assert.deepEqual(events.at(-1), {
    id: 8,
    shipment_id: 3,
    version: 3,
    status: 'delivered',
    occurred_at: '2025-01-01T00:08:00.000Z',
  });
});

test('invalid counts fail and large valid counts can be consumed lazily', () => {
  for (const count of [0, -1, 1.5, NaN, Infinity, MAX_SHIPMENTS + 1]) {
    assert.throws(() => generateEvents(count).next(), /Shipment count/);
  }
  assert.equal(generateEvents(MAX_SHIPMENTS).next().value.id, 1);
});
