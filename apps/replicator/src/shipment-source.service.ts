import { Injectable } from '@nestjs/common';
import { Client } from 'pg';
import type { ShipmentEvent } from './shipment-event.js';

export const BATCH_SIZE = 1_000;
const COLUMNS = 'id, shipment_id, version, status, occurred_at';

function createReadOnlyClient(): Client {
  return new Client({
    connectionTimeoutMillis: 5_000,
    options: '-c default_transaction_read_only=on',
  });
}

@Injectable()
export class ShipmentSourceService {
  private readonly initialClient = createReadOnlyClient();
  private readonly pollingClient = createReadOnlyClient();

  async connect(): Promise<void> {
    await this.initialClient.connect();
    await this.pollingClient.connect();
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([this.initialClient.end(), this.pollingClient.end()]);

    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
  }

  async readStartupBoundary(): Promise<number | null> {
    try {
      const result = await this.initialClient.query<{ last_id: number | null }>(
        'SELECT max(id) AS last_id FROM public.shipment_status_events',
      );

      return result.rows[0].last_id;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '42P01'
      ) {
        throw new Error('Source table is missing. Run make seed before starting the replicator.', {
          cause: error,
        });
      }

      throw error;
    }
  }

  async readInitialBatch(lastId: number | null, boundary: number): Promise<ShipmentEvent[]> {
    const result = await this.initialClient.query<ShipmentEvent>(
      `SELECT ${COLUMNS} FROM public.shipment_status_events
       WHERE ($1::integer IS NULL OR id > $1) AND id <= $2
       ORDER BY id LIMIT $3`,
      [lastId, boundary, BATCH_SIZE],
    );

    return result.rows;
  }

  async readNewBatch(lastId: number | null): Promise<ShipmentEvent[]> {
    const result = await this.pollingClient.query<ShipmentEvent>(
      `SELECT ${COLUMNS} FROM public.shipment_status_events
       WHERE ($1::integer IS NULL OR id > $1)
       ORDER BY id LIMIT $2`,
      [lastId, BATCH_SIZE],
    );

    return result.rows;
  }
}
