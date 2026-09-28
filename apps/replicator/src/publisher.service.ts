import { Injectable } from '@nestjs/common';
import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';
import type { ShipmentEvent } from './shipment-event.js';

const QUEUE = 'shipments.initial-load';

@Injectable()
export class PublisherService {
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private closing = false;

  async open(): Promise<void> {
    const password = process.env.RABBITMQ_PASSWORD;
    if (!password) throw new Error('RABBITMQ_PASSWORD is required');
    this.connection = await connect(
      {
        hostname: process.env.RABBITMQ_HOST ?? 'localhost',
        port: Number(process.env.RABBITMQ_PORT ?? 5672),
        username: process.env.RABBITMQ_USER ?? 'local',
        password,
        heartbeat: 10,
      },
      { timeout: 5_000 },
    );
    const fail = (error: unknown) => {
      console.error('Publisher connection failed', error);
      process.exit(1);
    };
    this.connection.on('error', fail);
    this.connection.on('close', () => {
      if (!this.closing) fail(new Error('RabbitMQ connection closed'));
    });
    this.channel = await this.connection.createConfirmChannel();
    this.channel.on('error', fail);
    await this.channel.assertQueue(QUEUE, { durable: false, autoDelete: false });
  }

  async publish(event: ShipmentEvent): Promise<void> {
    if (!this.channel) throw new Error('Publisher is not connected');
    const message = { type: 'shipment.status', sourceId: event.id, record: event };
    this.channel.sendToQueue(QUEUE, Buffer.from(JSON.stringify(message)), {
      contentType: 'application/json',
      persistent: false,
    });
    // One outstanding message: await broker acceptance before advancing.
    await this.channel.waitForConfirms();
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.connection?.close();
  }
}
