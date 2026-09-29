import { Injectable, Logger } from '@nestjs/common';
import { setTimeout } from 'node:timers/promises';
import { BATCH_SIZE, ShipmentSourceService } from './shipment-source.service.js';
import type { ProcessRecord } from './shipment-event.js';
import type { PollingOptions } from './polling-options.js';

type PollingState = {
  lastId: number | null;
  emptyPolls: number;
  hasReceivedRows: boolean;
};

@Injectable()
export class IncrementalLoadService {
  private readonly logger = new Logger(IncrementalLoadService.name);

  constructor(private readonly source: ShipmentSourceService) {}

  async run(
    boundary: number | null,
    processRecord: ProcessRecord,
    options: PollingOptions,
    signal: AbortSignal,
  ): Promise<void> {
    const state: PollingState = { lastId: boundary, emptyPolls: 0, hasReceivedRows: false };
    this.logger.log(
      `Polling started: afterId=${boundary ?? 'none'} maxEmptyPolls=${options.maxEmptyPolls}`,
    );
    this.logger.log('Waiting for first incremental rows; empty-poll limit is not active');

    while (state.emptyPolls < options.maxEmptyPolls) {
      const count = await this.pollOnce(state, processRecord, signal);

      if (count === 0 && state.hasReceivedRows) {
        this.logger.log(`Empty poll ${state.emptyPolls}/${options.maxEmptyPolls}`);
      }

      if (state.emptyPolls === options.maxEmptyPolls) break;

      if (count < BATCH_SIZE) {
        await setTimeout(options.intervalMs, undefined, { signal });
      }
    }

    this.logger.log(`Polling stopped: ${state.emptyPolls} consecutive empty polls`);
  }

  private async pollOnce(
    state: PollingState,
    processRecord: ProcessRecord,
    signal: AbortSignal,
  ): Promise<number> {
    signal.throwIfAborted();
    const batch = await this.source.readNewBatch(state.lastId);

    if (batch.length === 0) {
      if (state.hasReceivedRows) state.emptyPolls++;
      return 0;
    }

    if (!state.hasReceivedRows) {
      state.hasReceivedRows = true;
      this.logger.log('First incremental rows received; empty-poll limit is now active');
    }

    for (const event of batch) {
      signal.throwIfAborted();
      await processRecord(event);
    }

    state.emptyPolls = 0;
    state.lastId = batch[batch.length - 1].id;
    this.logger.log(
      `Incremental batch: rows=${batch.length} firstId=${batch[0].id} lastId=${state.lastId}`,
    );

    return batch.length;
  }
}
