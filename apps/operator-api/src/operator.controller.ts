import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { tokenSchema } from './contracts.js';
import { parseConfigurationUpdate, parseDlqQuery, parseInput, requireEmpty } from './input.js';
import { ReplicatorClient } from './replicator-client.js';
import { OperationsService } from './operations.service.js';

@Controller('api')
export class OperatorController {
  constructor(
    @Inject(ReplicatorClient) private readonly replicator: ReplicatorClient,
    @Inject(OperationsService) private readonly operations: OperationsService,
  ) {}

  @Get('status')
  status(@Query() query: unknown) {
    requireEmpty(query);
    return this.replicator.status();
  }

  @Post('replication/start')
  @HttpCode(200)
  start(@Body() body: unknown, @Query() query: unknown) {
    requireEmpty(body);
    requireEmpty(query);
    return this.operations.exclusive(['replicator'], () => this.replicator.start());
  }

  @Post('replication/stop')
  @HttpCode(200)
  stop(@Body() body: unknown, @Query() query: unknown) {
    requireEmpty(body);
    requireEmpty(query);
    return this.operations.exclusive(['replicator'], () => this.replicator.stop());
  }

  @Get('config')
  configuration(@Query() query: unknown) {
    requireEmpty(query);
    return this.replicator.configuration();
  }

  @Put('config')
  updateConfiguration(@Body() body: unknown, @Query() query: unknown) {
    requireEmpty(query);
    const update = parseConfigurationUpdate(body);
    return this.operations.exclusive(['replicator'], () =>
      this.replicator.updateConfiguration(update),
    );
  }

  @Get('dlq')
  dlq(@Query() query: unknown) {
    return this.replicator.dlq(parseDlqQuery(query));
  }

  @Post('dlq/:id/replay')
  @HttpCode(200)
  replay(@Param('id') id: string, @Body() body: unknown, @Query() query: unknown) {
    requireEmpty(body);
    requireEmpty(query);
    const token = parseInput(tokenSchema, id);
    return this.operations.exclusive(['replicator', 'opensearch'], () =>
      this.replicator.replay(token),
    );
  }

  @Post('simulations/rejected-records')
  @HttpCode(200)
  rejectedRecords(@Body() body: unknown, @Query() query: unknown) {
    requireEmpty(body);
    requireEmpty(query);
    return this.operations.exclusive(['writer', 'replicator', 'opensearch'], () =>
      this.replicator.rejectedRecords(),
    );
  }
}
