import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CustomerSourceService } from './customer-source.service.js';
import { InitialLoadService } from './initial-load.service.js';
import { IndexerService } from './indexer.service.js';
import { PublisherService } from './publisher.service.js';

@Module({
  providers: [CustomerSourceService, InitialLoadService, IndexerService, PublisherService],
})
class AppModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  const publisher = app.get(PublisherService);
  const indexer = app.get(IndexerService);
  try {
    await publisher.open();
    new Logger('Replicator').log('Replicator started');
    await app.get(InitialLoadService).run(async (customer) => {
      await indexer.index(customer);
      await publisher.publish(customer);
    });
  } finally {
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
