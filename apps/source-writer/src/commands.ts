import type { Client } from 'pg';
import type { Command } from './cli.js';
import { generateEvents } from './generator.js';
import { writeEvents } from './writer.js';
import { appendEvent } from './append-event.js';
import { writeTraffic, type Transition } from './traffic.js';

export async function runCommand(
  client: Client,
  command: Exclude<Command, { name: 'help' }>,
): Promise<void> {
  switch (command.name) {
    case 'seed':
      return seed(client, command.shipmentCount);
    case 'generate':
      return generate(client, command.eventCount, command.eventsPerSecond);
    case 'append':
      return append(client, command.shipmentId, command.status);
  }
}

async function seed(client: Client, shipmentCount: number): Promise<void> {
  const inserted = await writeEvents(client, generateEvents(shipmentCount));
  console.log(`Seed complete: inserted=${inserted}`);

  const totals = await client.query(`
    SELECT count(*) AS event_count, count(DISTINCT shipment_id) AS shipment_count
    FROM public.shipment_status_events
  `);
  console.table(totals.rows);

  const sample = await client.query(
    'SELECT * FROM public.shipment_status_events ORDER BY id LIMIT 10',
  );
  console.table(sample.rows);
}

async function append(client: Client, shipmentId: number, status: string): Promise<void> {
  const event = await appendEvent(client, shipmentId, status);
  console.log(`Appended event ${JSON.stringify(event)}`);
}

async function generate(
  client: Client,
  eventCount: number,
  eventsPerSecond: number,
): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  let written = 0;

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  async function writeTransition({ shipmentId, status }: Transition): Promise<void> {
    const event = await appendEvent(client, shipmentId, status);
    written++;
    console.log(`Generated event ${JSON.stringify(event)}`);
  }

  try {
    const firstShipmentId = await readNextShipmentId(client);
    console.log(
      `Generating events: count=${eventCount} rate=${eventsPerSecond}/s firstShipmentId=${firstShipmentId}`,
    );

    await writeTraffic(
      eventCount,
      eventsPerSecond,
      firstShipmentId,
      writeTransition,
      controller.signal,
    );
    console.log(`Generation complete: inserted=${written}`);
  } catch (error) {
    if (!wasInterrupted(error, controller.signal)) {
      throw error;
    }

    console.log(`Generation stopped: inserted=${written}`);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

async function readNextShipmentId(client: Client): Promise<number> {
  const result = await client.query<{ max_shipment: number | null }>(
    'SELECT max(shipment_id) AS max_shipment FROM public.shipment_status_events',
  );
  const highestShipmentId = result.rows[0].max_shipment ?? 0;

  return Math.max(0, highestShipmentId) + 1;
}

function wasInterrupted(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && error instanceof Error && error.name === 'AbortError';
}
