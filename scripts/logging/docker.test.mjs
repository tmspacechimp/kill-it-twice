import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { RunEvidence } from './run-evidence.mjs';
import { runDocker } from './docker.mjs';

test('live collector retains stdout/stderr for removed containers and reports bounded demo logs', {
  skip: process.env.TEST_DOCKER_LOGS !== '1',
  timeout: 60000,
}, async () => {
  const project = `log-smoke-${randomUUID()}`;
  const evidence = new RunEvidence('demo', { test: 'Docker collector smoke' });
  evidence.startCollector(project, 1024);
  const containers = [];
  try {
    for (const marker of ['before-kill', 'after-restart']) {
      const id = runDocker([
        'run', '-d', '--rm',
        '--label', `com.docker.compose.project=${project}`,
        '--label', 'com.docker.compose.service=replicator',
        'postgres:17', 'sh', '-c',
        'echo rotation-padding-for-size-limit; '.repeat(50) + `sleep 1; echo ${marker}; echo stderr-${marker} >&2; sleep 2`,
      ]).trim();
      containers.push(id);
      const path = join(evidence.serviceDirectory, `replicator-${id}.log`);
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (existsSync(path) && readFileSync(path, 'utf8').includes(`stderr-${marker}`)) break;
        await setTimeout(100);
      }
      const saved = readFileSync(path, 'utf8');
      assert.match(saved, /\[replicator\] \d{4}-\d\d-\d\dT/);
      assert.ok(saved.includes(marker));
      assert.ok(saved.includes(`stderr-${marker}`));
      assert.ok(Buffer.byteLength(saved) <= 1024);
      await setTimeout(2500);
      // Removal does not remove the already saved host file.
      assert.ok(existsSync(path));
    }
    await evidence.stopCollector();
    const lifecycle = readFileSync(join(evidence.serviceDirectory, 'lifecycle.jsonl'), 'utf8');
    assert.ok(lifecycle.includes(containers.at(-1)));
    assert.ok(lifecycle.includes('destroy'));
    evidence.finish('STOPPED', { containers });
  } finally {
    await evidence.stopCollector();
    // Remove only this test's still-existing containers after failure.
    const remaining = runDocker([
      'ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`,
    ]).trim().split('\n').filter(Boolean);
    if (remaining.length) runDocker(['rm', '-f', ...remaining]);
  }
});

test('live collector follows a second start of the same container ID', {
  skip: process.env.TEST_DOCKER_LOGS !== '1', timeout: 60000,
}, async () => {
  const project = `log-restart-${randomUUID()}`;
  const evidence = new RunEvidence('demo', { test: 'same-container restart' });
  evidence.startCollector(project, 4096);
  let id;
  try {
    id = runDocker([
      'run', '-d', '--label', `com.docker.compose.project=${project}`,
      '--label', 'com.docker.compose.service=replicator', 'postgres:17',
      'sh', '-c',
      'count=$(cat /tmp/log-run-count 2>/dev/null || echo 0); count=$((count + 1)); echo "$count" > /tmp/log-run-count; echo restart-marker-"$count"; sleep 2',
    ]).trim();
    const path = join(evidence.serviceDirectory, `replicator-${id}.log`);
    for (const attempt of [1, 2]) {
      if (attempt === 2) runDocker(['start', id]);
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (existsSync(path) && readFileSync(path, 'utf8').includes(`restart-marker-${attempt}`)) break;
        await setTimeout(100);
      }
      assert.ok(readFileSync(path, 'utf8').includes(`restart-marker-${attempt}`));
      runDocker(['wait', id]);
      await setTimeout(200);
    }
    await evidence.stopCollector();
    evidence.finish('STOPPED');
  } finally {
    await evidence.stopCollector();
    if (id) runDocker(['rm', '-f', id]);
  }
});

test('terminal Ctrl+C stops collection cleanly without killing the collector', {
  skip: process.env.TEST_DOCKER_LOGS !== '1' || process.platform === 'win32',
  timeout: 30000,
}, async () => {
  const project = `log-interrupt-${randomUUID()}`;
  const moduleUrl = new URL('./run-evidence.mjs', import.meta.url).href;
  const source = `
    import { RunEvidence } from ${JSON.stringify(moduleUrl)};
    import { setTimeout } from 'node:timers/promises';
    const interrupted = new Promise(resolve => process.once('SIGINT', resolve));
    const evidence = new RunEvidence('demo', { test: 'terminal interrupt' });
    evidence.startCollector(${JSON.stringify(project)}, 1024);
    await setTimeout(1000);
    console.log('READY');
    await interrupted;
    await evidence.stopCollector();
    evidence.finish('STOPPED');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let diagnostics = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  const completed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  try {
    const deadline = Date.now() + 10000;
    while (!output.includes('READY') && child.exitCode === null && Date.now() < deadline) {
      await setTimeout(50);
    }
    assert.ok(output.includes('READY'), output + diagnostics);
    // A terminal sends SIGINT to the entire foreground process group.
    process.kill(-child.pid, 'SIGINT');
    const result = await completed;
    assert.equal(result.code, 0, diagnostics);
    const directory = output.match(/Run directory: (.+)/)[1].trim();
    const summary = JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8'));
    assert.equal(summary.status, 'STOPPED');
    assert.equal(existsSync(join(directory, 'services', 'collection-errors.jsonl')), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid, 'SIGTERM');
      await completed;
    }
  }
});
