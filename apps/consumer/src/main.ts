import { connect } from 'amqplib';

const QUEUE = 'customers.initial-load';

async function main(): Promise<void> {
  const password = process.env.RABBITMQ_PASSWORD;
  if (!password) throw new Error('RABBITMQ_PASSWORD is required');
  const connection = await connect({
    hostname: process.env.RABBITMQ_HOST ?? 'localhost',
    port: Number(process.env.RABBITMQ_PORT ?? 5672),
    username: process.env.RABBITMQ_USER ?? 'local',
    password,
    heartbeat: 10,
  }, { timeout: 5_000 });
  let closing = false;
  const fail = (error: unknown) => {
    console.error('Consumer failed', error);
    process.exit(1);
  };
  connection.on('error', fail);
  connection.on('close', () => {
    if (!closing) fail(new Error('RabbitMQ connection closed'));
  });
  const channel = await connection.createChannel();
  channel.on('error', fail);
  channel.on('handler-error', fail);
  await channel.assertQueue(QUEUE, { durable: false, autoDelete: false });
  await channel.consume(QUEUE, (message) => {
    if (!message) {
      fail(new Error('RabbitMQ cancelled the consumer'));
      return;
    }
    console.log('Received event ' + message.content.toString('utf8'));
  }, { noAck: true });
  console.log('Consumer listening on ' + QUEUE);

  const shutdown = () => {
    if (closing) return;
    closing = true;
    connection.close().catch(fail);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  console.error('Consumer failed', error);
  process.exit(1);
});
