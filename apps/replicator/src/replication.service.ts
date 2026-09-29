import { Injectable, Logger } from '@nestjs/common';
import { ShipmentSourceService } from './shipment-source.service.js';
import { InitialLoadService } from './initial-load.service.js';
import { IncrementalLoadService } from './incremental-load.service.js';
import type { ProcessRecord } from './shipment-event.js';
import type { PollingOptions } from './polling-options.js';

@Injectable()
export class ReplicationService {
  private readonly logger = new Logger(ReplicationService.name);

  constructor(
    private readonly source: ShipmentSourceService,
    private readonly initialLoad: InitialLoadService,
    private readonly incrementalLoad: IncrementalLoadService,
  ) {}

  async run(
    processRecord: ProcessRecord,
    options: PollingOptions,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.source.connect();
      signal.throwIfAborted();

      const boundary = await this.source.readStartupBoundary();
      this.logger.log(`Startup boundary: lastId=${boundary ?? 'none'}`);

      await this.runBothLoads(boundary, processRecord, options, signal);
    } finally {
      await this.source.close();
    }
  }

  private async runBothLoads(
    boundary: number | null,
    processRecord: ProcessRecord,
    options: PollingOptions,
    shutdownSignal: AbortSignal,
  ): Promise<void> {
    const failure = new AbortController();
    const signal = AbortSignal.any([shutdownSignal, failure.signal]);
    const loads = [
      this.initialLoad.run(boundary, processRecord, signal),
      this.incrementalLoad.run(boundary, processRecord, options, signal),
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
}
