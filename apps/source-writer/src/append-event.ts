import type { ShipmentEvent } from './generator.js';

const MAX_INTEGER = 2_147_483_647;

interface EventPosition {
  max_id: number | null;
  max_version: number | null;
}

interface Database {
  query(sql: string, values?: unknown[]): Promise<{ rows: EventPosition[] }>;
}

export function validateAppend(shipmentId: number, status: string): void {
  if (!Number.isInteger(shipmentId) || shipmentId < 1 || shipmentId > MAX_INTEGER) {
    throw new Error('Shipment ID must be a positive PostgreSQL integer');
  }

  if (!['created', 'in_transit', 'delivered', 'cancelled'].includes(status)) {
    throw new Error('Status must be created, in_transit, delivered, or cancelled');
  }
}

// Pure construction: database maxima and time are supplied by the caller.
export function createAppendEvent(
  shipmentId: number,
  status: string,
  maxId: number | null,
  maxVersion: number | null,
  occurredAt: Date,
): ShipmentEvent {
  validateAppend(shipmentId, status);

  const id = (maxId ?? 0) + 1;
  const version = (maxVersion ?? 0) + 1;
  const validId = Number.isInteger(id) && id >= -2_147_483_648 && id <= MAX_INTEGER;
  const validVersion = Number.isInteger(version) && version >= 1 && version <= MAX_INTEGER;

  if (!validId || !validVersion) {
    throw new Error('Next event ID or shipment version exceeds PostgreSQL integer bounds');
  }

  return {
    id,
    shipment_id: shipmentId,
    version,
    status: status as ShipmentEvent['status'],
    occurred_at: occurredAt.toISOString(),
  };
}

export async function appendEvent(
  db: Database,
  shipmentId: number,
  status: string,
): Promise<ShipmentEvent> {
  validateAppend(shipmentId, status);
  await db.query('BEGIN');

  try {
    const position = await readEventPosition(db, shipmentId);
    const event = createAppendEvent(
      shipmentId,
      status,
      position.max_id,
      position.max_version,
      new Date(),
    );

    await insertEvent(db, event);
    await db.query('COMMIT');

    return event;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function readEventPosition(db: Database, shipmentId: number): Promise<EventPosition> {
  // Safe only for one serial writer whose IDs increase with commits.
  const result = await db.query(
    `SELECT
      (SELECT max(id) FROM public.shipment_status_events) AS max_id,
      (SELECT max(version) FROM public.shipment_status_events WHERE shipment_id = $1) AS max_version`,
    [shipmentId],
  );

  return result.rows[0];
}

async function insertEvent(db: Database, event: ShipmentEvent): Promise<void> {
  await db.query(
    `INSERT INTO public.shipment_status_events
      (id, shipment_id, version, status, occurred_at) VALUES ($1, $2, $3, $4, $5)`,
    [event.id, event.shipment_id, event.version, event.status, event.occurred_at],
  );
}
