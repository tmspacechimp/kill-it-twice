import { Injectable, Logger } from '@nestjs/common';
import { BATCH_SIZE, ShipmentSourceService } from './shipment-source.service.js';
import type { ProcessRecord } from './shipment-event.js';

@Injectable()
export class InitialLoadService {
  private readonly logger = new Logger(InitialLoadService.name);

  constructor(private readonly source: ShipmentSourceService) {}

  async run(
    boundary: number | null,
    processRecord: ProcessRecord,
    signal: AbortSignal,
  ): Promise<void> {
    let lastId: number | null = null;
    let rows = 0;
    let batches = 0;

    while (boundary !== null) {
      signal.throwIfAborted();
      const batch = await this.source.readInitialBatch(lastId, boundary);
      if (batch.length === 0) break;

      for (const event of batch) {
        signal.throwIfAborted();
        await processRecord(event);
      }

      lastId = batch[batch.length - 1].id;
      rows += batch.length;
      batches++;
      this.logger.log(
        `Initial batch ${batches}: rows=${batch.length} firstId=${batch[0].id} lastId=${lastId} total=${rows}`,
      );

      if (batch.length < BATCH_SIZE || lastId === boundary) break;
    }

    this.logger.log(`Initial load complete: rows=${rows} batches=${batches}`);
  }
}
