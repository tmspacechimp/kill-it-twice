import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { parseInput, requireEmpty } from './input.js';
import { OperationsService } from './operations.service.js';
import { ProcessControlService } from './process-control.service.js';
import type { ContainerAction } from './process-control.service.js';

const generation = z.strictObject({
  count: z.number().int().min(1).max(2147483647),
  rate: z.number().int().min(1).max(1000),
});

@Controller('api')
export class ProcessController {
  constructor(
    @Inject(ProcessControlService) private readonly process: ProcessControlService,
    @Inject(OperationsService) private readonly operations: OperationsService,
  ) {}

  @Get('operations/:id')
  operation(@Param('id') id: string, @Query() query: unknown) {
    requireEmpty(query);
    return this.operations.get(parseInput(z.uuid(), id));
  }

  @Post('source/generate')
  @HttpCode(202)
  generate(@Body() body: unknown, @Query() query: unknown) {
    requireEmpty(query);
    const { count, rate } = parseInput(generation, body);
    this.process.requireConfigured();
    return this.operations.start('generate', ['writer'], () => this.process.generate(count, rate));
  }

  @Post('simulations/replicator/kill')
  @HttpCode(202)
  kill(@Body() body: unknown, @Query() query: unknown) {
    return this.container('replicator-kill', body, query);
  }

  @Post('simulations/replicator/restart')
  @HttpCode(202)
  restart(@Body() body: unknown, @Query() query: unknown) {
    return this.container('replicator-restart', body, query);
  }

  @Post('simulations/opensearch/stop')
  @HttpCode(202)
  stop(@Body() body: unknown, @Query() query: unknown) {
    return this.container('opensearch-stop', body, query);
  }

  @Post('simulations/opensearch/restore')
  @HttpCode(202)
  restore(@Body() body: unknown, @Query() query: unknown) {
    return this.container('opensearch-restore', body, query);
  }

  private container(action: ContainerAction, body: unknown, query: unknown) {
    requireEmpty(body);
    requireEmpty(query);
    this.process.requireConfigured();
    const resource = action.startsWith('replicator-') ? 'replicator' : 'opensearch';
    return this.operations.start(action, [resource], () => this.process.container(action));
  }
}
