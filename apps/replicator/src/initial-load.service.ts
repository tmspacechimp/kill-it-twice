import { Injectable, Logger } from '@nestjs/common';
import { setTimeout } from 'node:timers/promises';
import { BATCH_SIZE, CustomerSourceService } from './customer-source.service.js';
import type { Customer } from './customer.js';

const SEED_POLL_INTERVAL_MS = 1_000;
type ProcessRecord = (customer: Customer) => Promise<void>;
type LoadSummary = { rows: number; batches: number };

@Injectable()
export class InitialLoadService {
  private readonly logger = new Logger(InitialLoadService.name);

  constructor(private readonly source: CustomerSourceService) {}

  async run(processRecord: ProcessRecord = async () => {}): Promise<void> {
    try {
      await this.source.connect();
      const summary = await this.loadSnapshot(processRecord);
      await this.source.commitSnapshot();
      this.logger.log(`Initial load complete: rows=${summary.rows} batches=${summary.batches}`);
    } finally {
      await this.source.close();
    }
  }

  private async loadSnapshot(processRecord: ProcessRecord): Promise<LoadSummary> {
    let batch = await this.waitForSeededBatch();
    const summary: LoadSummary = { rows: 0, batches: 0 };

    while (batch.length > 0) {
      await this.processBatch(batch, processRecord);
      this.recordProgress(batch, summary);
      if (batch.length < BATCH_SIZE) break;

      const lastId = batch[batch.length - 1].id;
      // eslint-disable-next-line no-useless-assignment -- Release processed rows before awaiting the next batch.
      batch = [];
      batch = await this.source.readNextBatch(lastId);
    }

    return summary;
  }

  private async waitForSeededBatch(): Promise<Customer[]> {
    let waitingLogged = false;

    for (;;) {
      await this.source.beginSnapshot();
      const batch = await this.source.readFirstBatch();
      if (batch.length > 0) return batch;

      // End empty snapshots so the next check can see committed seed data.
      await this.source.rollbackSnapshot();
      if (!waitingLogged) {
        this.logger.log('Waiting for seeded records in public.customers');
        waitingLogged = true;
      }
      await setTimeout(SEED_POLL_INTERVAL_MS);
    }
  }

  private async processBatch(batch: Customer[], processRecord: ProcessRecord): Promise<void> {
    for (const customer of batch) {
      await processRecord(customer);
    }
  }

  private recordProgress(batch: Customer[], summary: LoadSummary): void {
    summary.rows += batch.length;
    summary.batches += 1;
    const firstId = batch[0].id;
    const lastId = batch[batch.length - 1].id;
    this.logger.log(
      `Batch ${summary.batches}: rows=${batch.length} firstId=${firstId} lastId=${lastId} total=${summary.rows}`,
    );
  }
}
