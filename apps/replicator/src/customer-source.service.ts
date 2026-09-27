import { Injectable } from '@nestjs/common';
import { Client } from 'pg';
import type { Customer } from './customer.js';

export const BATCH_SIZE = 1_000;
const COLUMNS = 'id, full_name, email, country_code, status, created_at';
const MISSING_TABLE_ERROR_CODE = '42P01';

@Injectable()
export class CustomerSourceService {
  private client!: Client;

  async connect(): Promise<void> {
    this.client = new Client({
      connectionTimeoutMillis: 5_000,
      options: '-c default_transaction_read_only=on',
    });
    await this.client.connect();
  }

  async close(): Promise<void> {
    // Disconnecting also rolls back a snapshot left open by a failed load.
    await this.client.end();
  }

  async beginSnapshot(): Promise<void> {
    await this.client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  }

  async commitSnapshot(): Promise<void> {
    await this.client.query('COMMIT');
  }

  async rollbackSnapshot(): Promise<void> {
    await this.client.query('ROLLBACK');
  }

  async readFirstBatch(): Promise<Customer[]> {
    try {
      const result = await this.client.query<Customer>(
        `SELECT ${COLUMNS} FROM public.customers ORDER BY id LIMIT $1`,
        [BATCH_SIZE],
      );
      return result.rows;
    } catch (error: unknown) {
      // The seed creates this table; all other database errors fail the load.
      if (this.isMissingTable(error)) return [];
      throw error;
    }
  }

  async readNextBatch(lastId: number): Promise<Customer[]> {
    const result = await this.client.query<Customer>(
      `SELECT ${COLUMNS} FROM public.customers WHERE id > $1 ORDER BY id LIMIT $2`,
      [lastId, BATCH_SIZE],
    );
    return result.rows;
  }

  private isMissingTable(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === MISSING_TABLE_ERROR_CODE
    );
  }
}
