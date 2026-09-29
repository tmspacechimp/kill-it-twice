import type { ShipmentEvent } from './generator.js';

interface Database {
  query(sql: string, values?: unknown[]): Promise<{ rowCount: number | null }>;
}

const BATCH_SIZE = 1_000;

export async function writeEvents(db: Database, events: Iterable<ShipmentEvent>): Promise<number> {
  await db.query('BEGIN');

  try {
    await createSourceTable(db);
    const inserted = await insertBatches(db, events);
    await db.query('COMMIT');

    return inserted;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function createSourceTable(db: Database): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS public.shipment_status_events (
      id integer PRIMARY KEY,
      shipment_id integer NOT NULL,
      version integer NOT NULL CHECK (version > 0),
      status text NOT NULL CHECK (status IN ('created', 'in_transit', 'delivered', 'cancelled')),
      occurred_at timestamptz NOT NULL,
      UNIQUE (shipment_id, version)
    )`);
}

async function insertBatches(db: Database, events: Iterable<ShipmentEvent>): Promise<number> {
  let batch: ShipmentEvent[] = [];
  let inserted = 0;

  for (const event of events) {
    batch.push(event);

    if (batch.length === BATCH_SIZE) {
      inserted += await insertBatch(db, batch);
      batch = [];
    }
  }

  if (batch.length > 0) {
    inserted += await insertBatch(db, batch);
  }

  return inserted;
}

async function insertBatch(db: Database, events: ShipmentEvent[]): Promise<number> {
  const values: unknown[] = [];

  const rows = events.map((event) => {
    const offset = values.length;
    values.push(event.id, event.shipment_id, event.version, event.status, event.occurred_at);
    return `(${[1, 2, 3, 4, 5].map((n) => `$${offset + n}`).join(', ')})`;
  });

  const result = await db.query(
    `INSERT INTO public.shipment_status_events (id, shipment_id, version, status, occurred_at)
     VALUES ${rows.join(', ')} ON CONFLICT (id) DO NOTHING`,
    values,
  );

  return result.rowCount ?? 0;
}
