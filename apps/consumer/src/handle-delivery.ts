import type { Channel, ConsumeMessage } from 'amqplib';
import type { ReceiptStore } from './receipt-store.js';

function readEventId(payload: string): number {
  const event = JSON.parse(payload) as {
    type?: unknown;
    sourceId?: unknown;
    record?: { id?: unknown };
  } | null;
  const id = event?.sourceId;

  if (
    event?.type !== 'shipment.status' ||
    typeof id !== 'number' ||
    !Number.isInteger(id) ||
    id < -2_147_483_648 ||
    id > 2_147_483_647 ||
    event.record?.id !== id
  ) {
    throw new Error('Invalid shipment event: expected matching integer sourceId and record.id');
  }

  return id;
}

export function handleDelivery(
  message: ConsumeMessage,
  channel: Pick<Channel, 'ack'>,
  receipts: Pick<ReceiptStore, 'record'>,
  log: (message: string) => void = console.log,
): void {
  const payload = message.content.toString('utf8');
  const eventId = readEventId(payload);
  const isNew = receipts.record(eventId);

  if (isNew) {
    log('Received event ' + payload);
  } else {
    log(`Duplicate event received: sourceId=${eventId}; skipping`);
  }

  channel.ack(message);
}
