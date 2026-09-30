import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  ProcessControlService,
  readComposeOptions,
  runDocker,
} from '../dist/process-control.service.js';
import { OperationsService } from '../dist/operations.service.js';
import { startOperator } from './http-helpers.mjs';

const options = { project: 'test-project', file: '/project/compose.yaml', directory: '/project' };

test('fixed Docker actions use argument arrays scoped to the configured project', async () => {
  const calls = [];
  const process = new ProcessControlService(options, async (args, timeout) => {
    calls.push({ args, timeout });
    return 'Generation complete: inserted=3';
  });
  await process.generate(3, 20);
  for (const action of [
    'replicator-kill',
    'replicator-restart',
    'opensearch-stop',
    'opensearch-restore',
  ]) {
    await process.container(action);
  }
  const prefix = [
    'compose',
    '--project-name',
    'test-project',
    '--project-directory',
    '/project',
    '--file',
    '/project/compose.yaml',
  ];
  assert.deepEqual(
    calls.map(({ args }) => args.slice(0, 7)),
    Array(5).fill(prefix),
  );
  assert.deepEqual(
    calls.map(({ args }) => args.slice(7)),
    [
      [
        'run',
        '--rm',
        '--no-deps',
        '-T',
        'source-writer',
        'generate',
        '--count',
        '3',
        '--rate',
        '20',
      ],
      ['kill', '--signal', 'SIGKILL', 'replicator'],
      ['restart', 'replicator'],
      ['stop', 'opensearch'],
      ['start', 'opensearch'],
    ],
  );
  assert.deepEqual(
    calls.map(({ timeout }) => timeout),
    [0, 30000, 30000, 30000, 30000],
  );
});

test('writer exit alone does not confirm generation and configuration must be complete', async () => {
  const process = new ProcessControlService(options, async () => 'Generation stopped: inserted=2');
  await assert.rejects(process.generate(3, 20), /without confirming/);
  assert.equal(readComposeOptions({}), undefined);
  assert.throws(() => readComposeOptions({ OPERATOR_COMPOSE_PROJECT: 'demo' }));
});

test('operations retain failures and reject conflicting work until confirmation', async () => {
  const operations = new OperationsService();
  const completion = Promise.withResolvers();
  const accepted = operations.start('generate', ['writer'], () => completion.promise);
  assert.equal(accepted.state, 'pending');
  assert.throws(() => operations.start('generate', ['writer'], async () => 'wrong'), /conflicting/);
  await assert.rejects(
    operations.exclusive(['writer', 'replicator'], async () => 'wrong'),
    /conflicting/,
  );
  await operations.exclusive(['replicator'], async () => 'independent');
  completion.reject(new Error('Writer failed after committing two rows'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(operations.get(accepted.id).state, 'failed');
  assert.match(operations.get(accepted.id).message, /committing two/);
  const next = operations.start('generate', ['writer'], async () => 'confirmed');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(operations.get(next.id).state, 'succeeded');
  assert.throws(() => operations.get('unknown'), /unknown/);
});

test('HTTP generation validates limits, returns pending IDs and shares locks with G4', async (t) => {
  const completion = Promise.withResolvers();
  t.after(() => completion.resolve('Generation complete: inserted=3'));
  const calls = [];
  const process = new ProcessControlService(options, (args) => {
    calls.push(args);
    return completion.promise;
  });
  const api = await startOperator(t, undefined, process);
  for (const body of [
    { count: 0, rate: 20 },
    { count: 2147483648, rate: 20 },
    { count: 3, rate: 1001 },
    { count: '3', rate: 20 },
    { count: 3, rate: 1.5 },
    { count: 3, rate: 20, command: 'anything' },
  ]) {
    assert.equal((await api.request('/source/generate', 'POST', body)).status, 400);
  }
  assert.equal(calls.length, 0);
  const accepted = await api.request('/source/generate', 'POST', { count: 3, rate: 20 });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.state, 'pending');
  assert.equal((await api.request('/source/generate', 'POST', { count: 3, rate: 20 })).status, 409);
  assert.equal((await api.request('/simulations/rejected-records', 'POST')).status, 409);
  assert.equal((await api.request('/operations/' + accepted.body.id)).body.state, 'pending');
  completion.resolve('Generation complete: inserted=3');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await api.request('/operations/' + accepted.body.id)).body.state, 'succeeded');
  assert.equal(calls.length, 1);
  assert.equal((await api.request('/operations/00000000-0000-4000-8000-000000000000')).status, 404);
});

test('Docker runner disables the shell, bounds output and reports failures', async () => {
  function fakeSpawn(outcome) {
    return (command, args, options) => {
      assert.equal(command, 'docker');
      assert.deepEqual(args, ['compose', 'version']);
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => outcome(child));
      return child;
    };
  }
  const output = await runDocker(
    ['compose', 'version'],
    30000,
    fakeSpawn((child) => {
      child.stdout.emit('data', Buffer.from('x'.repeat(5000)));
      child.emit('close', 0, null);
    }),
  );
  assert.equal(output.length, 4096);
  await assert.rejects(
    runDocker(
      ['compose', 'version'],
      30000,
      fakeSpawn((child) => child.emit('error', new Error('ENOENT'))),
    ),
    /could not run/,
  );
  await assert.rejects(
    runDocker(
      ['compose', 'version'],
      30000,
      fakeSpawn((child) => {
        child.stderr.emit('data', Buffer.from('daemon unavailable'));
        child.emit('close', 1, null);
      }),
    ),
    /daemon unavailable/,
  );
});

test('container actions conflict with graceful controls and reject arbitrary services', async (t) => {
  const completion = Promise.withResolvers();
  t.after(() => completion.resolve('done'));
  const api = await startOperator(
    t,
    undefined,
    new ProcessControlService(options, () => completion.promise),
  );
  assert.equal(
    (await api.request('/simulations/replicator/kill', 'POST', { service: 'postgres' })).status,
    400,
  );
  assert.equal((await api.request('/simulations/replicator/kill', 'POST')).status, 202);
  assert.equal((await api.request('/replication/start', 'POST')).status, 409);
  assert.equal((await api.request('/simulations/replicator/restart', 'POST')).status, 409);
});
