import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceLogFollowers } from './follow.mjs';
import { runDocker } from './docker.mjs';

export function retainTail(text, maxBytes) {
  if (!maxBytes) return text;
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return text;
  // Start at a complete line so neither a timestamp nor a UTF-8 character is cut.
  const tail = buffer.subarray(buffer.length - maxBytes);
  const firstNewline = tail.indexOf(10);
  return firstNewline < 0 ? '' : tail.subarray(firstNewline + 1).toString('utf8');
}

export function collectServiceLogs(directory, projectName, maxBytes = 0, docker = runDocker) {
  const listing = docker([
    'ps', '-a', '--no-trunc', '--filter',
    `label=com.docker.compose.project=${projectName}`, '--format', '{{json .}}',
  ], {}, 30000);

  for (const line of listing.trim().split('\n')) {
    if (!line) continue;
    const container = JSON.parse(line);
    const labels = container.Labels.split(',');
    const serviceLabel = labels.find((label) => label.startsWith('com.docker.compose.service='));
    if (!serviceLabel) throw new Error(`Missing service label for ${container.ID}`);
    const service = serviceLabel.split('=')[1];
    const arguments_ = ['logs', '--timestamps'];
    // Bound both the Docker read and the host file for demo runs.
    if (maxBytes) arguments_.push('--tail', String(maxBytes));
    arguments_.push(container.ID);
    const output = docker(arguments_, {}, 30000);
    const tagged = output.split('\n').filter(Boolean)
      .map((entry) => `[${service}] ${entry}\n`).join('');
    const filename = join(directory, `${service}-${container.ID}.log`);
    writeFileSync(`${filename}.pending`, retainTail(tagged, maxBytes));
    renameSync(`${filename}.pending`, filename);
  }
}

async function runCollector(configPath) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const followers = new ServiceLogFollowers(config, retainTail);
  try {
    followers.start();
    await followers.waitUntilStopped();
  } catch (error) {
    appendFileSync(join(config.directory, 'collection-errors.jsonl'), JSON.stringify({
      time: new Date().toISOString(), message: error.message,
    }) + '\n');
    console.error('Service log collection failed:', error.message);
    process.exitCode = 1;
  } finally {
    await followers.stop();
  }
}

// Imported by tests and by the parent for a mandatory snapshot before recreation.
if (process.argv[2]) await runCollector(process.argv[2]);
