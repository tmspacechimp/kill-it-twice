import { setTimeout } from 'node:timers/promises';
import type { ShipmentEvent } from './generator.js';

const MAX_INTEGER = 2_147_483_647;
const SHIPMENT_STATUSES: ShipmentEvent['status'][] = ['created', 'in_transit', 'delivered'];

export type Transition = { shipmentId: number; status: ShipmentEvent['status'] };

export function validateTraffic(count: number, rate: number): void {
  if (!Number.isInteger(count) || count < 1 || count > MAX_INTEGER) {
    throw new Error('COUNT must be a positive PostgreSQL integer');
  }

  if (!Number.isInteger(rate) || rate < 1 || rate > 1000) {
    throw new Error('RATE must be an integer from 1 to 1000 events per second');
  }
}

// Lazy and database-independent; a partial final history still counts exactly.
export function* generateTransitions(
  count: number,
  firstShipmentId: number,
): Generator<Transition> {
  validateTraffic(count, 1);
  validateShipmentRange(count, firstShipmentId);

  for (let index = 0; index < count; index++) {
    const shipmentOffset = Math.floor(index / SHIPMENT_STATUSES.length);
    const statusIndex = index % SHIPMENT_STATUSES.length;

    yield {
      shipmentId: firstShipmentId + shipmentOffset,
      status: SHIPMENT_STATUSES[statusIndex],
    };
  }
}

function validateShipmentRange(count: number, firstShipmentId: number): void {
  const shipmentCount = Math.ceil(count / SHIPMENT_STATUSES.length);
  const lastShipmentId = firstShipmentId + shipmentCount - 1;

  if (!Number.isInteger(firstShipmentId) || firstShipmentId < 1 || lastShipmentId > MAX_INTEGER) {
    throw new Error('Generated shipment IDs exceed PostgreSQL integer bounds');
  }
}

interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const clock: Clock = {
  now: () => performance.now(),
  sleep: async (ms, signal) => {
    await setTimeout(ms, undefined, { signal });
  },
};

export async function writeTraffic(
  count: number,
  rate: number,
  firstShipmentId: number,
  write: (transition: Transition) => Promise<void>,
  signal?: AbortSignal,
  timer: Clock = clock,
): Promise<number> {
  validateTraffic(count, rate);

  const intervalMs = 1000 / rate;
  let previousStart: number | undefined;
  let written = 0;

  for (const transition of generateTransitions(count, firstShipmentId)) {
    signal?.throwIfAborted();
    await waitForNextWrite(previousStart, intervalMs, timer, signal);
    signal?.throwIfAborted();

    previousStart = timer.now();
    await write(transition);
    written++;
  }

  return written;
}

async function waitForNextWrite(
  previousStart: number | undefined,
  intervalMs: number,
  timer: Clock,
  signal?: AbortSignal,
): Promise<void> {
  if (previousStart === undefined) {
    return;
  }

  const elapsedMs = timer.now() - previousStart;
  const remainingMs = intervalMs - elapsedMs;

  if (remainingMs > 0) {
    await timer.sleep(remainingMs, signal);
  }
}
