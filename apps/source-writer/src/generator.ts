export interface ShipmentEvent {
  id: number;
  shipment_id: number;
  version: number;
  status: 'created' | 'in_transit' | 'delivered' | 'cancelled';
  occurred_at: string;
}

export const DEFAULT_SHIPMENTS = 4_000;
// The generated event IDs must fit PostgreSQL's signed integer column.
export const MAX_SHIPMENTS = 858_993_458;

export function validateShipmentCount(count: number): void {
  if (!Number.isInteger(count) || count < 1 || count > MAX_SHIPMENTS) {
    throw new Error(`Shipment count must be an integer from 1 to ${MAX_SHIPMENTS}`);
  }
}

export function* generateEvents(count = DEFAULT_SHIPMENTS): Generator<ShipmentEvent> {
  validateShipmentCount(count);
  const epoch = Date.parse('2025-01-01T00:00:00.000Z');
  let id = 0;
  for (let shipment = 1; shipment <= count; shipment++) {
    const statuses: ShipmentEvent['status'][] = shipment % 2 === 1
      ? ['created', 'in_transit', 'delivered']
      : ['created', 'cancelled'];
    for (const [index, status] of statuses.entries()) {
      id++;
      yield {
        id,
        shipment_id: shipment,
        version: index + 1,
        status,
        occurred_at: new Date(epoch + id * 60_000).toISOString(),
      };
    }
  }
}
