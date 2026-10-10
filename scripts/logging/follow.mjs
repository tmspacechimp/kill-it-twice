import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { dockerCommand, runDocker } from './docker.mjs';

// Follow each container independently: Compose can remove an old container
// while creating its replacement, and short-lived writers may disappear quickly.
export class ServiceLogFollowers {
  constructor(config, retainTail) {
    this.retainTail = retainTail;
    this.config = config;
    this.followers = new Map();
    this.failure = null;
    this.stopping = false;
    this.children = [];
  }

  startChild(arguments_, handleLine, mustStayOpen = false) {
    const command = dockerCommand(arguments_);
    const child = spawn(command.executable, command.arguments, {
      env: command.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const completion = new Promise((resolve) => {
      child.once('error', (error) => {
        this.failure ??= error;
        resolve();
      });
      child.once('close', (code) => {
        if (!this.stopping && (code !== 0 || mustStayOpen)) {
          this.failure ??= new Error(`Docker log collector exited ${code}: ${arguments_.join(' ')}`);
        }
        resolve();
      });
    });
    this.children.push({ child, completion });
    this.readStream(child.stdout, handleLine);
    this.readStream(child.stderr, handleLine);
    return child;
  }

  readStream(stream, handleLine) {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        try {
          handleLine(line);
        } catch (error) {
          this.failure ??= error;
        }
      }
    });
    stream.on('end', () => {
      if (!pending) return;
      try {
        handleLine(pending);
      } catch (error) {
        this.failure ??= error;
      }
    });
  }

  follow(containerId, service, startedAt) {
    if (this.followers.has(containerId)) return;
    if (!/^[a-zA-Z0-9_.-]+$/.test(service) || !/^[a-f0-9]+$/.test(containerId)) {
      throw new Error('Invalid container log identity');
    }
    const filename = join(this.config.directory, `${service}-${containerId}.log`);
    const arguments_ = ['logs', '--follow', '--timestamps'];
    const since = startedAt ?? (this.config.maxBytes ? this.config.startedAt : null);
    if (since) arguments_.push('--since', since);
    arguments_.push(containerId);
    const child = this.startChild(arguments_, (line) => {
      this.writeLog(filename, `[${service}] ${line}\n`);
    });
    this.followers.set(containerId, child);
    child.once('close', () => {
      if (this.followers.get(containerId) === child) this.followers.delete(containerId);
    });
  }

  writeLog(filename, entry) {
    if (!this.config.maxBytes) {
      appendFileSync(filename, entry);
      return;
    }

    const currentBytes = existsSync(filename) ? statSync(filename).size : 0;
    if (currentBytes + Buffer.byteLength(entry) <= this.config.maxBytes) {
      appendFileSync(filename, entry);
      return;
    }

    // Discard older lines in batches rather than rewriting for every event.
    const previous = existsSync(filename) ? readFileSync(filename, 'utf8') : '';
    const retainedBytes = Math.floor(this.config.maxBytes / 2);
    writeFileSync(filename, this.retainTail(previous + entry, retainedBytes));
  }

  start() {
    const projectFilter = `label=com.docker.compose.project=${this.config.projectName}`;
    this.startChild([
      'events', '--since', this.config.startedAt, '--filter', projectFilter,
      '--filter', 'type=container', '--format', '{{json .}}',
    ], (line) => {
      this.observeEvent(line);
    }, true);

    const listing = runDocker([
      'ps', '-a', '--no-trunc', '--filter', projectFilter, '--format', '{{json .}}',
    ]);
    for (const line of listing.trim().split('\n')) {
      if (!line) continue;
      const container = JSON.parse(line);
      if (!this.config.captureOneOff && container.Labels.includes('com.docker.compose.oneoff=True')) continue;
      const label = container.Labels.split(',')
        .find((entry) => entry.startsWith('com.docker.compose.service='));
      if (!label) throw new Error(`Missing service label for ${container.ID}`);
      this.follow(container.ID, label.split('=')[1]);
    }
  }

  observeEvent(line) {
    const event = JSON.parse(line);
    if (['start', 'kill', 'die', 'destroy'].includes(event.Action)) {
      this.writeLog(join(this.config.directory, 'lifecycle.jsonl'), JSON.stringify({
        time: new Date(event.time * 1000).toISOString(), timeNano: event.timeNano,
        action: event.Action, containerId: event.Actor.ID,
        service: event.Actor.Attributes['com.docker.compose.service'],
      oneOff: event.Actor.Attributes['com.docker.compose.oneoff'] === 'True',
      }) + '\n');
    }
    if (event.Action !== 'start') return;
    if (!this.config.captureOneOff && event.Actor.Attributes['com.docker.compose.oneoff'] === 'True') return;
    const service = event.Actor.Attributes['com.docker.compose.service'];
    this.follow(event.Actor.ID, service, new Date(event.time * 1000).toISOString());
  }

  async waitUntilStopped() {
    while (!existsSync(join(this.config.directory, 'collector.stop'))) {
      if (this.failure) throw this.failure;
      // Avoid leaving collectors behind if the parent is forcibly terminated.
      process.kill(this.config.parentPid, 0);
      await setTimeout(100);
    }
    if (this.failure) throw this.failure;
  }

  async stop() {
    this.stopping = true;
    for (const { child } of this.children) child.kill();
    await Promise.all(this.children.map(({ completion }) => completion));
  }
}
