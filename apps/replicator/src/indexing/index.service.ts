import type { ShipmentEvent } from '../source/shipment-event.js';

export interface IndexService {
  index(event: ShipmentEvent): Promise<void>;
}
