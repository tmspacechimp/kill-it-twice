import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { InitialLoadService } from '../dist/initial-load.service.js';

function harness(t, reads, connectionError, commitError) {
  const queries = [];
  const logs = [];
  let ended = false;
  t.mock.method(Logger.prototype, 'log', (message) => logs.push(message));
  t.mock.method(Client.prototype, 'connect', async function () {
    assert.equal(this.connectionParameters.options, '-c default_transaction_read_only=on');
    if (connectionError) throw connectionError;
  });
  t.mock.method(Client.prototype, 'end', async () => { ended = true; });
  t.mock.method(Client.prototype, 'query', async (sql, params) => {
    queries.push({ sql, params });
    if (sql === 'COMMIT' && commitError) throw commitError;
    if (!sql.startsWith('SELECT')) return { rows: [] };
    assert.match(sql, /SELECT id, full_name, email, country_code, status, created_at FROM public.customers/);
    assert.match(sql, /ORDER BY id LIMIT/);
    assert.equal(params.at(-1), 1000);
    assert.ok(reads.length > 0, 'No reads after snapshot exhaustion');
    const next = reads.shift();
    if (next instanceof Error) throw next;
    return { rows: next };
  });
  return { queries, logs, ended: () => ended };
}

const rows = (start, count) => Array.from({ length: count }, (_, i) => ({ id: start + i }));

test('10,000 rows require ten bounded batches, a final empty read, and cleanup', async (t) => {
  const reads = Array.from({ length: 10 }, (_, i) => rows(i * 1000 + 1, 1000));
  reads.push([]);
  const h = harness(t, reads);
  await new InitialLoadService().run();
  assert.equal(h.queries[0].sql, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const selects = h.queries.filter(({ sql }) => sql.startsWith('SELECT'));
  assert.equal(selects.length, 11);
  assert.deepEqual(selects[0].params, [1000]);
  for (let i = 1; i < selects.length; i++) {
    assert.match(selects[i].sql, /WHERE id > \$1/);
    assert.deepEqual(selects[i].params, [i * 1000, 1000]);
  }
  assert.equal(h.logs.filter((line) => line.startsWith('Batch ')).length, 10);
  assert.ok(h.logs.includes('Batch 10: rows=1000 firstId=9001 lastId=10000 total=10000'));
  assert.equal(h.logs.at(-1), 'Initial load complete: rows=10000 batches=10');
  assert.equal(h.queries.at(-1).sql, 'COMMIT');
  assert.equal(h.ended(), true);
});

test('missing and empty tables release their snapshots before waiting', async (t) => {
  const missing = Object.assign(new Error('missing relation'), { code: '42P01' });
  const h = harness(t, [missing, [], rows(1, 1)]);
  await new InitialLoadService().run();
  assert.deepEqual(h.queries.map(({ sql }) => sql.split(' ')[0]), [
    'BEGIN', 'SELECT', 'ROLLBACK', 'BEGIN', 'SELECT', 'ROLLBACK', 'BEGIN', 'SELECT', 'COMMIT',
  ]);
  assert.equal(h.logs.filter((line) => line.startsWith('Waiting')).length, 1);
  assert.equal(h.logs.at(-1), 'Initial load complete: rows=1 batches=1');
  assert.equal(h.ended(), true);
});

test('negative, zero, and sparse IDs and a partial last batch are preserved', async (t) => {
  const first = [{ id: -2147483648 }, { id: 0 }, ...rows(2, 998)];
  const h = harness(t, [first, [{ id: 2147483647 }]]);
  await new InitialLoadService().run();
  const selects = h.queries.filter(({ sql }) => sql.startsWith('SELECT'));
  assert.doesNotMatch(selects[0].sql, /WHERE/);
  assert.deepEqual(selects[1].params, [999, 1000]);
  assert.equal(selects.length, 2);
  assert.ok(h.logs.includes('Batch 1: rows=1000 firstId=-2147483648 lastId=999 total=1000'));
  assert.equal(h.logs.at(-1), 'Initial load complete: rows=1001 batches=2');
});

test('schema errors fail without readiness polling and close the connection', async (t) => {
  const failure = Object.assign(new Error('missing column'), { code: '42703' });
  const h = harness(t, [failure]);
  await assert.rejects(new InitialLoadService().run(), failure);
  assert.equal(h.queries.length, 2);
  assert.deepEqual(h.logs, []);
  assert.equal(h.ended(), true);
});

test('connection errors fail without retry and close the client', async (t) => {
  const failure = new Error('connection refused');
  const h = harness(t, [], failure);
  await assert.rejects(new InitialLoadService().run(), failure);
  assert.deepEqual(h.queries, []);
  assert.equal(h.ended(), true);
});

test('a later batch error fails without committing or logging completion', async (t) => {
  const failure = Object.assign(new Error('read failed'), { code: '42501' });
  const h = harness(t, [rows(1, 1000), failure]);
  await assert.rejects(new InitialLoadService().run(), failure);
  assert.equal(h.queries.length, 3);
  assert.equal(h.logs.some((line) => line.startsWith('Initial load complete')), false);
  assert.equal(h.ended(), true);
});

test('a failed commit closes the client without logging completion', async (t) => {
  const failure = new Error('connection lost during commit');
  const h = harness(t, [rows(1, 1)], undefined, failure);
  await assert.rejects(new InitialLoadService().run(), failure);
  assert.equal(h.queries.at(-1).sql, 'COMMIT');
  assert.equal(h.logs.some((line) => line.startsWith('Initial load complete')), false);
  assert.equal(h.ended(), true);
});

test('processing is awaited before the next bounded read', async (t) => {
  const h = harness(t, [rows(1, 1000), rows(1001, 1)]);
  const processed = [];
  await new InitialLoadService().run(async (customer) => {
    const selects = h.queries.filter(({ sql }) => sql.startsWith('SELECT'));
    assert.equal(selects.length, customer.id <= 1000 ? 1 : 2);
    await Promise.resolve();
    processed.push(customer.id);
  });
  assert.equal(processed.length, 1001);
  assert.equal(processed.at(-1), 1001);
});

test('a destination error stops processing without the next read or completion', async (t) => {
  const h = harness(t, [rows(1, 1000)]);
  const failure = new Error('destination failed');
  const processed = [];
  await assert.rejects(new InitialLoadService().run(async (customer) => {
    processed.push(customer.id);
    if (customer.id === 2) throw failure;
  }), failure);
  assert.deepEqual(processed, [1, 2]);
  assert.equal(h.queries.length, 2);
  assert.equal(h.logs.some((line) => line.startsWith('Initial load complete')), false);
  assert.equal(h.ended(), true);
});
