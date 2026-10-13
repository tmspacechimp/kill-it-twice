import { Injectable } from '@nestjs/common';
import { PublisherService } from './publisher.service.js';
import type { ShipmentEvent } from '../source/shipment-event.js';

// One crash target per verification process; G1/G2 harnesses control restarts.
@Injectable()
export class CrashInjectingPublisherService extends PublisherService {
  private readonly crashEventId = Number(process.env.CRASH_EVENT_ID);

  constructor() {
    super();
    if (!Number.isInteger(this.crashEventId) || this.crashEventId < 1) {
      throw new Error('CRASH_EVENT_ID must be a positive integer');
    }
  }

  override async publish(event: ShipmentEvent): Promise<void> {
    await super.publish(event);

    // RabbitMQ confirmed this event, but the caller has not checkpointed it.
    if (event.id === this.crashEventId) {
      process.kill(process.pid, 'SIGKILL');
    }
  }
}
