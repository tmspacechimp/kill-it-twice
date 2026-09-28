export type ShipmentEvent = {
  id: number;
  shipment_id: number;
  version: number;
  status: 'created' | 'in_transit' | 'delivered' | 'cancelled';
  occurred_at: Date;
};
