import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { ShipmentSourceService } from '../dist/shipment-source.service.js';
import { InitialLoadService } from '../dist/initial-load.service.js';
import { IncrementalLoadService } from '../dist/incremental-load.service.js';
import { ReplicationService } from '../dist/replication.service.js';

export function eventsFrom(firstId, count) {
  return Array.from({ length: count }, (_, offset) => ({ id: firstId + offset }));
}

export function setupLoad(
  t,
  {
    boundary = 1,
    initialReads = [[{ id: 1 }]],
    pollingReads = [[], [], []],
    connectionError,
    onLog = () => {},
  } = {},
) {
  const database = { reads: [], closed: [], connections: [], boundaryReads: 0 };
  const readers = new Map();
  const pendingInitial = [...initialReads];
  const pendingPolling = [...pollingReads];
  const logs = [];

  t.mock.method(Logger.prototype, 'log', (message) => {
    logs.push(message);
    onLog(message);
  });

  t.mock.method(Client.prototype, 'connect', async function () {
    const reader = readers.size === 0 ? 'initial' : 'polling';
    readers.set(this, reader);
    database.connections.push({ reader, options: this.connectionParameters.options });
    if (connectionError) throw connectionError;
  });

  t.mock.method(Client.prototype, 'end', async function () {
    database.closed.push(readers.get(this));
  });

  t.mock.method(Client.prototype, 'query', async function (sql, values) {
    const reader = readers.get(this);

    if (sql.startsWith('SELECT max(id)')) {
      database.boundaryReads++;
      if (boundary instanceof Error) throw boundary;
      return { rows: [{ last_id: boundary }] };
    }

    database.reads.push({ reader, sql, values });
    const pending = reader === 'initial' ? pendingInitial : pendingPolling;
    if (pending.length === 0) throw new Error(`Unexpected ${reader} read`);

    const result = pending.shift();
    if (result instanceof Error) throw result;
    return { rows: result };
  });

  const source = new ShipmentSourceService();
  const loader = new ReplicationService(
    source,
    new InitialLoadService(source),
    new IncrementalLoadService(source),
  );

  async function run(processRecord = async () => {}, options = {}) {
    const { signal = new AbortController().signal, ...polling } = options;
    await loader.run(processRecord, { intervalMs: 1, maxEmptyPolls: 3, ...polling }, signal);
  }

  return { run, database, logs };
}
