import { DEFAULT_SHIPMENTS, validateShipmentCount } from './generator.js';
import { validateAppend } from './append-event.js';
import { validateTraffic } from './traffic.js';

export type Command =
  | { name: 'help' }
  | { name: 'seed'; shipmentCount: number }
  | { name: 'generate'; eventCount: number; eventsPerSecond: number }
  | { name: 'append'; shipmentId: number; status: string };

const SEED_USAGE = 'Usage: source-writer [--shipments N]';
const GENERATE_USAGE = 'Usage: source-writer generate --count N --rate N';
const APPEND_USAGE = 'Usage: source-writer append SHIPMENT_ID STATUS';

export const HELP = [
  `${SEED_USAGE} (default: SEED_SHIPMENTS environment variable, otherwise ${DEFAULT_SHIPMENTS})`,
  GENERATE_USAGE,
  APPEND_USAGE,
].join('\n');

export function parseCommand(args: string[], seedShipments = process.env.SEED_SHIPMENTS): Command {
  if (args.length === 1 && args[0] === '--help') {
    return { name: 'help' };
  }

  switch (args[0]) {
    case 'generate':
      return parseGenerate(args);
    case 'append':
      return parseAppend(args);
    default:
      return parseSeed(args, seedShipments);
  }
}

function parseSeed(args: string[], seedShipments: string | undefined): Command {
  if (args.length === 0) {
    const shipmentCount =
      seedShipments === undefined
        ? DEFAULT_SHIPMENTS
        : parseInteger(seedShipments, 'SEED_SHIPMENTS must be a positive integer');
    validateShipmentCount(shipmentCount);
    return { name: 'seed', shipmentCount };
  }

  if (args.length !== 2 || args[0] !== '--shipments') {
    throw new Error(SEED_USAGE);
  }

  const shipmentCount = parseInteger(args[1], SEED_USAGE);
  validateShipmentCount(shipmentCount);

  return { name: 'seed', shipmentCount };
}

function parseGenerate(args: string[]): Command {
  if (args.length !== 5 || args[1] !== '--count' || args[3] !== '--rate') {
    throw new Error(GENERATE_USAGE);
  }

  const eventCount = parseInteger(args[2], GENERATE_USAGE);
  const eventsPerSecond = parseInteger(args[4], GENERATE_USAGE);
  validateTraffic(eventCount, eventsPerSecond);

  return { name: 'generate', eventCount, eventsPerSecond };
}

function parseAppend(args: string[]): Command {
  if (args.length !== 3) {
    throw new Error(APPEND_USAGE);
  }

  const shipmentId = parseInteger(args[1], APPEND_USAGE);
  const status = args[2];
  validateAppend(shipmentId, status);

  return { name: 'append', shipmentId, status };
}

function parseInteger(value: string, usage: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(usage);
  }

  return Number(value);
}
