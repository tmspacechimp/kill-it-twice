import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { InitialLoadService } from './initial-load.service.js';

@Module({ providers: [InitialLoadService] })
class AppModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  try {
    new Logger('Replicator').log('Replicator started');
    await app.get(InitialLoadService).run();
  } finally {
    await app.close();
  }
}

bootstrap().catch((error: unknown) => {
  console.error('Replicator failed', error);
  process.exitCode = 1;
});
