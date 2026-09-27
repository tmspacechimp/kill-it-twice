import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { customersFrom, postgresError, setupLoad } from './load-test-helpers.mjs';

const FIRST_BATCH_SQL =
  'SELECT id, full_name, email, country_code, status, created_at FROM public.customers ORDER BY id LIMIT $1';
const NEXT_BATCH_SQL =
  'SELECT id, full_name, email, country_code, status, created_at FROM public.customers WHERE id > $1 ORDER BY id LIMIT $2';

test('10,000 customers are read in batches of 1,000, then the connection closes', async (t) => {
  // Given ten full batches, followed by an empty result.
  const batches = Array.from({ length: 10 }, (_, batch) => customersFrom(batch * 1000 + 1, 1000));
  const { loader, database, logs } = setupLoad(t, { readResults: [...batches, []] });

  // When the initial load runs.
  await loader.run();

  // Then every read is bounded and advances from the previous batch's last ID.
  assert.equal(database.connectionOptions, '-c default_transaction_read_only=on');
  assert.equal(database.commands[0], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.deepEqual(database.reads[0], { sql: FIRST_BATCH_SQL, parameters: [1000] });
  assert.equal(database.reads.length, 11);

  for (let batch = 1; batch <= 10; batch++) {
    assert.deepEqual(database.reads[batch], {
      sql: NEXT_BATCH_SQL,
      parameters: [batch * 1000, 1000],
    });
  }

  assert.equal(logs.filter((message) => message.startsWith('Batch ')).length, 10);
  assert.equal(logs.at(-2), 'Batch 10: rows=1000 firstId=9001 lastId=10000 total=10000');
  assert.equal(logs.at(-1), 'Initial load complete: rows=10000 batches=10');
  assert.equal(database.commands.at(-1), 'COMMIT');
  assert.equal(database.closeCalls, 1);
});

test('a missing or empty table gets a fresh snapshot until seed data appears', async (t) => {
  // Given a missing table, then an empty table, then one seeded customer.
  const missingTable = postgresError('customers does not exist', '42P01');
  const { loader, database, logs } = setupLoad(t, {
    readResults: [missingTable, [], [{ id: 1 }]],
  });

  // When the load waits for seed data.
  await loader.run();

  // Then each empty snapshot ends before a new one starts.
  assert.deepEqual(database.commands, [
    'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    FIRST_BATCH_SQL,
    'ROLLBACK',
    'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    FIRST_BATCH_SQL,
    'ROLLBACK',
    'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    FIRST_BATCH_SQL,
    'COMMIT',
  ]);
  assert.equal(logs.filter((message) => message.startsWith('Waiting')).length, 1);
  assert.equal(logs.at(-1), 'Initial load complete: rows=1 batches=1');
  assert.equal(database.closeCalls, 1);
});

test('negative, zero, and widely spaced IDs are processed, including a short last batch', async (t) => {
  // Given a full batch ending at 999 and one remaining customer with a much larger ID.
  const firstBatch = [{ id: -2147483648 }, { id: 0 }, ...customersFrom(2, 998)];
  const { loader, database, logs } = setupLoad(t, {
    readResults: [firstBatch, [{ id: 2147483647 }]],
  });
  const processedIds = [];

  // When both batches are processed.
  await loader.run(async (customer) => {
    processedIds.push(customer.id);
  });

  // Then no IDs are skipped and a short batch needs no extra read.
  const expectedIds = firstBatch.map((customer) => customer.id).concat(2147483647);
  assert.deepEqual(processedIds, expectedIds);
  assert.deepEqual(database.reads, [
    { sql: FIRST_BATCH_SQL, parameters: [1000] },
    { sql: NEXT_BATCH_SQL, parameters: [999, 1000] },
  ]);
  assert.equal(logs[0], 'Batch 1: rows=1000 firstId=-2147483648 lastId=999 total=1000');
  assert.equal(logs.at(-1), 'Initial load complete: rows=1001 batches=2');
});

test('a schema error stops immediately instead of waiting for seed data', async (t) => {
  // Given a table whose required column is missing.
  const schemaError = postgresError('email column does not exist', '42703');
  const { loader, database, logs } = setupLoad(t, { readResults: [schemaError] });

  // When the first read fails, the error reaches the caller.
  await assert.rejects(loader.run(), schemaError);

  // Then there is no retry, commit, or progress log.
  assert.equal(database.reads.length, 1);
  assert.equal(database.commands.includes('COMMIT'), false);
  assert.deepEqual(logs, []);
  assert.equal(database.closeCalls, 1);
});

test('a connection error reaches the caller and the client is closed', async (t) => {
  // Given PostgreSQL refuses the connection.
  const connectionError = new Error('connection refused');
  const { loader, database, logs } = setupLoad(t, { readResults: [], connectionError });

  // When connecting fails.
  await assert.rejects(loader.run(), connectionError);

  // Then there was one attempt, no queries, and cleanup still ran.
  assert.equal(database.connectionAttempts, 1);
  assert.deepEqual(database.commands, []);
  assert.deepEqual(logs, []);
  assert.equal(database.closeCalls, 1);
});

test('a second-batch read error does not commit or report a completed load', async (t) => {
  // Given the first batch succeeds but the next read fails.
  const readError = postgresError('permission denied', '42501');
  const { loader, database, logs } = setupLoad(t, {
    readResults: [customersFrom(1, 1000), readError],
  });

  // When the second read fails.
  await assert.rejects(loader.run(), readError);

  // Then only the first batch is reported.
  assert.equal(database.reads.length, 2);
  assert.equal(database.commands.includes('COMMIT'), false);
  assert.deepEqual(logs, ['Batch 1: rows=1000 firstId=1 lastId=1000 total=1000']);
  assert.equal(database.closeCalls, 1);
});

test('a failed commit does not report completion, but still closes the client', async (t) => {
  // Given one customer was read, but committing the snapshot fails.
  const commitError = new Error('connection lost during commit');
  const { loader, database, logs } = setupLoad(t, {
    readResults: [[{ id: 1 }]],
    commitError,
  });

  // When committing fails.
  await assert.rejects(loader.run(), commitError);

  // Then processing was logged, but successful completion was not.
  assert.equal(database.commands.at(-1), 'COMMIT');
  assert.deepEqual(logs, ['Batch 1: rows=1 firstId=1 lastId=1 total=1']);
  assert.equal(database.closeCalls, 1);
});

test('the next batch is not read while a customer is still being processed', async (t) => {
  // Given processing of the first customer is paused.
  const { loader, database } = setupLoad(t, {
    readResults: [customersFrom(1, 1000), [{ id: 1001 }]],
  });
  const processingStarted = Promise.withResolvers();
  const allowProcessingToFinish = Promise.withResolvers();
  const processedIds = [];
  t.after(() => allowProcessingToFinish.resolve());

  // When the load reaches that customer, hold it there.
  const loading = loader.run(async (customer) => {
    if (customer.id === 1) {
      processingStarted.resolve();
      await allowProcessingToFinish.promise;
    }
    processedIds.push(customer.id);
  });
  await processingStarted.promise;

  // Then no second read occurs until processing is released.
  assert.equal(database.reads.length, 1);
  assert.deepEqual(processedIds, []);

  allowProcessingToFinish.resolve();
  await loading;

  assert.equal(database.reads.length, 2);
  assert.deepEqual(
    processedIds,
    customersFrom(1, 1001).map((customer) => customer.id),
  );
});

test('a destination error stops before processing more customers or reading another batch', async (t) => {
  // Given a full batch whose second customer fails at the destination.
  const { loader, database, logs } = setupLoad(t, {
    readResults: [customersFrom(1, 1000)],
  });
  const destinationError = new Error('destination failed');
  const attemptedIds = [];

  // When processing customer 2 fails.
  const loading = loader.run(async (customer) => {
    attemptedIds.push(customer.id);
    if (customer.id === 2) throw destinationError;
  });
  await assert.rejects(loading, destinationError);

  // Then customer 3 and the next batch are never attempted.
  assert.deepEqual(attemptedIds, [1, 2]);
  assert.equal(database.reads.length, 1);
  assert.equal(database.commands.includes('COMMIT'), false);
  assert.deepEqual(logs, []);
  assert.equal(database.closeCalls, 1);
});
