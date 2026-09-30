import { Injectable } from '@nestjs/common';
import { PublisherService } from './publisher.service.js';
import type { ShipmentEvent } from './shipment-event.js';

// Selected only for G1's first run; restart uses the normal publisher.
@Injectable()
export class G1PublisherService extends PublisherService {
  private readonly crashEventId = Number(process.env.G1_CRASH_EVENT_ID);

  constructor() {
    super();
    if (!Number.isInteger(this.crashEventId) || this.crashEventId < 1) {
      throw new Error('G1_CRASH_EVENT_ID must be a positive integer');
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
