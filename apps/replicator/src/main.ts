import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ShipmentSourceService } from './source/shipment-source.service.js';
import { InitialLoadService } from './replication/initial-load.service.js';
import { IncrementalLoadService } from './replication/incremental-load.service.js';
import { ReplicationService } from './replication/replication.service.js';
import { readPollingOptions } from './replication/polling-options.js';
import { CompositeIndexerService } from './indexing/composite-indexer.service.js';
import { StateIndexerService } from './indexing/state-indexer.service.js';
import { RecordIndexerService } from './indexing/record-indexer.service.js';
import { PublisherService } from './publishing/publisher.service.js';
import { CrashInjectingPublisherService } from './publishing/crash-injecting-publisher.service.js';
import { CheckpointService } from './replication/checkpoint.service.js';

@Module({
  providers: [
    ShipmentSourceService,
    InitialLoadService,
    IncrementalLoadService,
    ReplicationService,
    CompositeIndexerService,
    StateIndexerService,
    RecordIndexerService,
    {
      provide: PublisherService,
      useClass: process.env.CRASH_EVENT_ID ? CrashInjectingPublisherService : PublisherService,
    },
    CheckpointService,
  ],
})
class AppModule {}

async function bootstrap(): Promise<void> {
  const pollingOptions = readPollingOptions();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const app = await NestFactory.createApplicationContext(AppModule);
  const publisher = app.get(PublisherService);
  const indexer = app.get(CompositeIndexerService);
  try {
    await publisher.open();
    new Logger('Replicator').log('Replicator started');
    await app.get(ReplicationService).run(
      async (event) => {
        await indexer.index(event);
        await publisher.publish(event);
      },
      pollingOptions,
      controller.signal,
    );
  } catch (error) {
    if (!(controller.signal.aborted && error instanceof Error && error.name === 'AbortError'))
      throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    try {
      await publisher.close();
    } finally {
      await app.close();
    }
  }
}

bootstrap().catch((error: unknown) => {
  console.error('Replicator failed', error);
  process.exitCode = 1;
});
