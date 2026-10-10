import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { format } from 'node:util';
import { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectServiceLogs } from './collector.mjs';

export class RunEvidence {
  constructor(kind, configuration = {}) {
    this.kind = kind;
    this.runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
    this.directory = resolve('logs', kind, this.runId);
    mkdirSync(this.directory, { recursive: true });
    this.summary = {
      runId: this.runId, startedAt: new Date().toISOString(), endedAt: null,
      status: 'INCOMPLETE', configuration,
      evidence: kind === 'demo' ? {
        started: 'started.json', timeline: 'timeline.jsonl', services: 'services/', serviceLifecycle: 'services/lifecycle.jsonl',
      } : {
        started: 'started.json', sourceWriter: 'source-writer.jsonl',
        timeline: 'timeline.jsonl', commands: 'commands.jsonl',
        verification: 'verification.log', services: 'services/',
        serviceLifecycle: 'services/lifecycle.jsonl',
        checkpoints: 'checkpoints.jsonl', validation: 'validation/',
      },
    };
    this.saveSummary();
    this.save('started.json', this.summary);
    console.log(`Run directory: ${this.directory}`);
  }

  saveSummary() {
    writeFileSync(join(this.directory, 'summary.json'), JSON.stringify(this.summary, null, 2) + '\n');
  }

  timeline(action, details = {}) {
    this.append('timeline.jsonl', { action, ...details });
  }

  append(filename, data) {
    appendFileSync(join(this.directory, filename), JSON.stringify({
      observedAt: new Date().toISOString(), ...data,
    }) + '\n');
  }

  save(filename, data) {
    const path = join(this.directory, filename);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  }

  captureConsole() {
    for (const level of ['log', 'error']) {
      const original = console[level].bind(console);
      console[level] = (...values) => {
        appendFileSync(join(this.directory, 'verification.log'),
          `${new Date().toISOString()} [verification] ${format(...values)}\n`);
        original(...values);
      };
    }
  }

  startCollector(projectName, maxBytes = 0) {
    this.projectName = projectName;
    this.maxBytes = maxBytes;
    this.serviceDirectory = join(this.directory, 'services');
    mkdirSync(this.serviceDirectory, { recursive: true });
    const stopFile = join(this.serviceDirectory, 'collector.stop');
    if (existsSync(stopFile)) unlinkSync(stopFile);
    const configPath = join(this.directory, 'collector.json');
    this.save('collector.json', {
      directory: this.serviceDirectory, projectName, maxBytes,
      parentPid: process.pid, startedAt: new Date().toISOString(), captureOneOff: this.kind === 'demo',
    });
    const script = fileURLToPath(new URL('./collector.mjs', import.meta.url));
    this.collector = spawn(process.execPath, [script, configPath], {
      // Ctrl+C belongs to the parent; it stops this worker through collector.stop.
      detached: true, windowsHide: true,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    this.collectorResult = new Promise((resolveResult) => {
      this.collector.once('error', (error) => resolveResult({ error }));
      this.collector.once('exit', (code, signal) => resolveResult({ code, signal }));
    });
    this.timeline('log collection started', { projectName, maxBytes });
  }

  snapshot() {
    collectServiceLogs(this.serviceDirectory, this.projectName, this.maxBytes);
  }

  async stopCollector() {
    if (!this.collector) return;
    writeFileSync(join(this.serviceDirectory, 'collector.stop'), '');
    const result = await this.collectorResult;
    const errorFile = join(this.serviceDirectory, 'collection-errors.jsonl');
    if (result.error || result.code !== 0 || existsSync(errorFile)) {
      appendFileSync(errorFile, JSON.stringify({
        time: new Date().toISOString(), workerCode: result.code,
        workerSignal: result.signal, message: result.error?.message ?? 'Collector did not finish cleanly',
      }) + '\n');
      throw new Error('Log collection incomplete; see services/collection-errors.jsonl');
    }
    this.timeline('log collection finished');
  }

  finish(status, result = {}) {
    this.summary.status = status;
    this.summary.endedAt = new Date().toISOString();
    this.summary.result = result;
    this.saveSummary();
  }
}
