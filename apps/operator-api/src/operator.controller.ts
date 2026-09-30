import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { tokenSchema } from './contracts.js';
import { parseConfigurationUpdate, parseDlqQuery, parseInput, requireEmpty } from './input.js';
import { ReplicatorClient } from './replicator-client.js';

@Controller('api')
export class OperatorController {
  constructor(@Inject(ReplicatorClient) private readonly replicator: ReplicatorClient) {}

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
    return this.replicator.start();
  }

  @Post('replication/stop')
  @HttpCode(200)
  stop(@Body() body: unknown, @Query() query: unknown) {
    requireEmpty(body);
    requireEmpty(query);
    return this.replicator.stop();
  }

  @Get('config')
  configuration(@Query() query: unknown) {
    requireEmpty(query);
    return this.replicator.configuration();
  }

  @Put('config')
  updateConfiguration(@Body() body: unknown, @Query() query: unknown) {
    requireEmpty(query);
    return this.replicator.updateConfiguration(parseConfigurationUpdate(body));
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
    return this.replicator.replay(parseInput(tokenSchema, id));
  }

  @Post('simulations/rejected-records')
  @HttpCode(200)
  rejectedRecords(@Body() body: unknown, @Query() query: unknown) {
    requireEmpty(body);
    requireEmpty(query);
    return this.replicator.rejectedRecords();
  }
}
