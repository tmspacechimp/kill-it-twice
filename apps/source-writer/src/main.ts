import pg from 'pg';
import { DEFAULT_SHIPMENTS, generateEvents, validateShipmentCount } from './generator.js';
import { writeEvents } from './writer.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: source-writer [--shipments N] (default: 4000)');
    return;
  }
  if (args.length !== 0 &&
      (args.length !== 2 || args[0] !== '--shipments' || !/^\d+$/.test(args[1]))) {
    throw new Error('Usage: source-writer [--shipments N]');
  }
  const count = args.length === 0 ? DEFAULT_SHIPMENTS : Number(args[1]);
  validateShipmentCount(count);
  const client = new pg.Client({ connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const inserted = await writeEvents(client, generateEvents(count));
    console.log(`Seed complete: inserted=${inserted}`);
    const totals = await client.query(`SELECT count(*) AS event_count,
      count(DISTINCT shipment_id) AS shipment_count FROM public.shipment_status_events`);
    console.table(totals.rows);
    const sample = await client.query('SELECT * FROM public.shipment_status_events ORDER BY id LIMIT 10');
    console.table(sample.rows);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
