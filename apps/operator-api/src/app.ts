import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import { ApiError, ApiErrorFilter } from './api-error.js';
import { OperatorController } from './operator.controller.js';
import { ReplicatorClient } from './replicator-client.js';

export async function createApp(replicatorUrl?: string) {
  @Module({
    controllers: [OperatorController],
    providers: [{ provide: ReplicatorClient, useValue: new ReplicatorClient(replicatorUrl) }],
  })
  class OperatorModule {}

  const app = await NestFactory.create<NestExpressApplication>(OperatorModule, {
    logger: false,
    bodyParser: false,
  });
  app.use(requireJson);
  app.useBodyParser('json', { limit: '16kb' });
  app.useGlobalFilters(new ApiErrorFilter());
  app.enableShutdownHooks();
  return app;
}

function requireJson(request: Request, response: Response, next: NextFunction): void {
  response.setHeader('Cache-Control', 'no-store');
  const hasBody =
    Number(request.headers['content-length'] ?? 0) > 0 ||
    request.headers['transfer-encoding'] !== undefined;
  if (hasBody && !request.is('application/json')) {
    next(new ApiError(415, 'invalid_input', 'Request bodies must use application/json.'));
    return;
  }
  next();
}
