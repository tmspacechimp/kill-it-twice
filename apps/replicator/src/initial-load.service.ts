import { Injectable, Logger } from '@nestjs/common';
import { Client } from 'pg';
import { setTimeout } from 'node:timers/promises';

const BATCH_SIZE = 1_000;
const COLUMNS = 'id, full_name, email, country_code, status, created_at';

type Customer = {
  id: number;
  full_name: string;
  email: string;
  country_code: string;
  status: string;
  created_at: Date;
};

@Injectable()
export class InitialLoadService {
  private readonly logger = new Logger(InitialLoadService.name);

  async run(): Promise<void> {
    const client = new Client({
      connectionTimeoutMillis: 5_000,
      options: '-c default_transaction_read_only=on',
    });

    try {
      await client.connect();
      let waitingLogged = false;
      // Empty attempts end their snapshot so a later seed can become visible.
      for (;;) {
        await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        let batch: Customer[];
        try {
          const result = await client.query<Customer>(
            `SELECT ${COLUMNS} FROM public.customers ORDER BY id LIMIT $1`,
            [BATCH_SIZE],
          );
          batch = result.rows;
        } catch (error: unknown) {
          if ((error as { code?: string } | null)?.code !== '42P01') {
            throw error;
          }
          batch = [];
        }

        if (batch.length === 0) {
          await client.query('ROLLBACK');
          if (!waitingLogged) {
            this.logger.log('Waiting for seeded records in public.customers');
            waitingLogged = true;
          }
          await setTimeout(1_000);
          continue;
        }

        let total = 0;
        let batches = 0;
        while (batch.length > 0) {
          const firstId = batch[0].id;
          const lastId = batch[batch.length - 1].id;
          total += batch.length;
          batches += 1;
          this.logger.log(
            `Batch ${batches}: rows=${batch.length} firstId=${firstId} lastId=${lastId} total=${total}`,
          );
          if (batch.length < BATCH_SIZE) break;
          // Release the current rows before fetching the next bounded batch.
          batch = [];
          const result = await client.query<Customer>(
            `SELECT ${COLUMNS} FROM public.customers WHERE id > $1 ORDER BY id LIMIT $2`,
            [lastId, BATCH_SIZE],
          );
          batch = result.rows;
        }
        await client.query('COMMIT');
        this.logger.log(`Initial load complete: rows=${total} batches=${batches}`);
        return;
      }
    } finally {
      // Disconnecting also rolls back any transaction left by a failed read.
      await client.end();
    }
  }
}
