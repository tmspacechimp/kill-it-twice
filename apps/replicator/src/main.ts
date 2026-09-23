import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

@Module({})
class AppModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  try {
    new Logger('Replicator').log('Replicator started');
  } finally {
    await app.close();
  }
}

bootstrap().catch((error: unknown) => {
  console.error('Replicator failed to start', error);
  process.exitCode = 1;
});
