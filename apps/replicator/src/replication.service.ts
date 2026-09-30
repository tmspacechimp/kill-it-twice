import { Injectable, Logger } from '@nestjs/common';
import { ShipmentSourceService } from './shipment-source.service.js';
import { InitialLoadService } from './initial-load.service.js';
import { IncrementalLoadService } from './incremental-load.service.js';
import type { ProcessRecord } from './shipment-event.js';
import type { PollingOptions } from './polling-options.js';
import { CheckpointService, type Checkpoint } from './checkpoint.service.js';

@Injectable()
export class ReplicationService {
  private readonly logger = new Logger(ReplicationService.name);

  constructor(
    private readonly source: ShipmentSourceService,
    private readonly initialLoad: InitialLoadService,
    private readonly incrementalLoad: IncrementalLoadService,
    private readonly checkpoint: CheckpointService,
  ) {}

  async run(
    processRecord: ProcessRecord,
    options: PollingOptions,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.source.connect();
      signal.throwIfAborted();

      const saved = await this.checkpoint.open(() => this.source.readStartupBoundary());
      this.logger.log(`Startup boundary: lastId=${saved.boundary ?? 'none'}`);
      this.logger.log(
        `Saved progress: initialId=${saved.initialId ?? 'none'} initialDone=${saved.initialDone} incrementalId=${saved.incrementalId ?? 'none'}`,
      );

      await this.runBothLoads(saved, processRecord, options, signal);
    } finally {
      try {
        await this.source.close();
      } finally {
        this.checkpoint.close();
      }
    }
  }

  private async runBothLoads(
    saved: Checkpoint,
    processRecord: ProcessRecord,
    options: PollingOptions,
    shutdownSignal: AbortSignal,
  ): Promise<void> {
    const failure = new AbortController();
    const signal = AbortSignal.any([shutdownSignal, failure.signal]);
    const loads = [
      this.resumeInitial(saved, processRecord, signal),
      this.incrementalLoad.run(
        saved.incrementalId,
        async (event) => {
          await processRecord(event);
          this.checkpoint.advanceIncremental(event.id);
        },
        options,
        signal,
      ),
    ];

    try {
      await Promise.all(loads);
    } catch (error) {
      // Stop the other reader, then wait for its active operation before closing clients.
      failure.abort();
      await Promise.allSettled(loads);
      throw error;
    }
  }

  private async resumeInitial(
    saved: Checkpoint,
    processRecord: ProcessRecord,
    signal: AbortSignal,
  ): Promise<void> {
    if (saved.initialDone) {
      this.logger.log('Initial load already complete; resuming incremental polling only');
      return;
    }

    await this.initialLoad.run(
      saved.boundary,
      async (event) => {
        await processRecord(event);
        this.checkpoint.advanceInitial(event.id);
      },
      signal,
      saved.initialId,
    );
    this.checkpoint.finishInitial();
  }
}
