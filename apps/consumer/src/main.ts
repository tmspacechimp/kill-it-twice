import { connect } from 'amqplib';
import { ReceiptStore } from './receipt-store.js';
import { handleDelivery } from './handle-delivery.js';

const QUEUE = 'shipments.initial-load';

async function consume(receipts: ReceiptStore): Promise<void> {
  const password = process.env.RABBITMQ_PASSWORD;
  if (!password) throw new Error('RABBITMQ_PASSWORD is required');
  const connection = await connect(
    {
      hostname: process.env.RABBITMQ_HOST ?? 'localhost',
      port: Number(process.env.RABBITMQ_PORT ?? 5672),
      username: process.env.RABBITMQ_USER ?? 'local',
      password,
      heartbeat: 10,
    },
    { timeout: 5_000 },
  );
  let closing = false;
  const fail = (error: unknown) => {
    console.error('Consumer failed', error);
    process.exit(1);
  };
  connection.on('error', fail);
  connection.on('close', () => {
    if (!closing) fail(new Error('RabbitMQ connection closed'));
    receipts.close();
  });
  const channel = await connection.createChannel();
  channel.on('error', fail);
  channel.on('handler-error', fail);
  await channel.assertQueue(QUEUE, { durable: false, autoDelete: false });
  await channel.prefetch(1);
  await channel.consume(
    QUEUE,
    (message) => {
      if (!message) {
        fail(new Error('RabbitMQ cancelled the consumer'));
        return;
      }
      try {
        handleDelivery(message, channel, receipts);
      } catch (error) {
        // Leave the delivery unacknowledged; connection loss returns it to RabbitMQ.
        fail(error);
      }
    },
    { noAck: false },
  );
  console.log('Consumer listening on ' + QUEUE);

  const shutdown = () => {
    if (closing) return;
    closing = true;
    connection.close().catch(fail);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

async function main(): Promise<void> {
  const path = process.env.RECEIPT_PATH;
  if (!path) throw new Error('RECEIPT_PATH is required');
  const receipts = new ReceiptStore(path);
  try {
    await consume(receipts);
  } catch (error) {
    receipts.close();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error('Consumer failed', error);
  process.exit(1);
});
