import { Injectable, Logger } from '@nestjs/common';
import { setTimeout } from 'node:timers/promises';
import { BATCH_SIZE, ShipmentSourceService } from './shipment-source.service.js';
import type { ShipmentEvent } from './shipment-event.js';

const SEED_POLL_INTERVAL_MS = 1_000;
type ProcessRecord = (event: ShipmentEvent) => Promise<void>;
type LoadSummary = { rows: number; batches: number };

@Injectable()
export class InitialLoadService {
  private readonly logger = new Logger(InitialLoadService.name);

  constructor(private readonly source: ShipmentSourceService) {}

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

  private async waitForSeededBatch(): Promise<ShipmentEvent[]> {
    let waitingLogged = false;

    for (;;) {
      await this.source.beginSnapshot();
      const batch = await this.source.readFirstBatch();
      if (batch.length > 0) return batch;

      // End empty snapshots so the next check can see committed seed data.
      await this.source.rollbackSnapshot();
      if (!waitingLogged) {
        this.logger.log('Waiting for seeded records in public.shipment_status_events');
        waitingLogged = true;
      }
      await setTimeout(SEED_POLL_INTERVAL_MS);
    }
  }

  private async processBatch(batch: ShipmentEvent[], processRecord: ProcessRecord): Promise<void> {
    for (const event of batch) {
      await processRecord(event);
    }
  }

  private recordProgress(batch: ShipmentEvent[], summary: LoadSummary): void {
    summary.rows += batch.length;
    summary.batches += 1;
    const firstId = batch[0].id;
    const lastId = batch[batch.length - 1].id;
    this.logger.log(
      `Batch ${summary.batches}: rows=${batch.length} firstId=${firstId} lastId=${lastId} total=${summary.rows}`,
    );
  }
}
