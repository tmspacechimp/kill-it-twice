import { Injectable } from '@nestjs/common';
import { StateIndexerService } from './state-indexer.service.js';
import { RecordIndexerService } from './record-indexer.service.js';
import type { ShipmentEvent } from '../source/shipment-event.js';
import type { IndexService } from './index.service.js';

@Injectable()
export class CompositeIndexerService implements IndexService {
  constructor(
    private readonly stateIndexer: StateIndexerService,
    private readonly recordIndexer: RecordIndexerService,
  ) {}

  async index(event: ShipmentEvent): Promise<void> {
    await this.stateIndexer.index(event);
    await this.recordIndexer.index(event);
  }
}
