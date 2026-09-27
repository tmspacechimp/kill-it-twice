import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { CustomerSourceService } from '../dist/customer-source.service.js';
import { InitialLoadService } from '../dist/initial-load.service.js';

// Only IDs matter to the reader. Destination tests use a complete customer.
export function customersFrom(firstId, count) {
  return Array.from({ length: count }, (_, offset) => ({ id: firstId + offset }));
}

export function postgresError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Runs the real workflow and source reader; replaces only PostgreSQL and logging.
export function setupLoad(testContext, options) {
  const database = fakePostgres(testContext, options);
  const logs = [];
  testContext.mock.method(Logger.prototype, 'log', (message) => logs.push(message));

  return {
    loader: new InitialLoadService(new CustomerSourceService()),
    database,
    logs,
  };
}

function fakePostgres(testContext, { readResults, connectionError, commitError }) {
  const pendingReads = [...readResults];
  const database = {
    commands: [],
    reads: [],
    connectionOptions: undefined,
    connectionAttempts: 0,
    closeCalls: 0,
  };

  testContext.mock.method(Client.prototype, 'connect', async function () {
    database.connectionAttempts += 1;
    database.connectionOptions = this.connectionParameters.options;
    if (connectionError) throw connectionError;
  });

  testContext.mock.method(Client.prototype, 'end', async () => {
    database.closeCalls += 1;
  });

  testContext.mock.method(Client.prototype, 'query', async (sql, parameters) => {
    database.commands.push(sql);
    if (sql === 'COMMIT' && commitError) throw commitError;
    if (!sql.startsWith('SELECT')) return { rows: [] };

    database.reads.push({ sql, parameters });
    if (pendingReads.length === 0) throw new Error('Unexpected extra database read');

    const result = pendingReads.shift();
    if (result instanceof Error) throw result;
    return { rows: result };
  });

  return database;
}
