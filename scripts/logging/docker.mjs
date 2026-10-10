import { spawnSync } from 'node:child_process';

export function dockerCommand(arguments_, environment = {}) {
  const env = { ...process.env, ...environment };
  if (process.platform !== 'win32') {
    return { executable: 'docker', arguments: arguments_, env };
  }

  const forwarded = { ...environment };
  if (env.COMPOSE_PROJECT_NAME) forwarded.COMPOSE_PROJECT_NAME = env.COMPOSE_PROJECT_NAME;
  const settings = Object.entries(forwarded).map(([key, value]) => `${key}=${value}`);
  return {
    executable: 'wsl.exe',
    arguments: ['--cd', process.cwd(), '--exec', 'env', ...settings, 'docker', ...arguments_],
    env,
  };
}

export function executeDocker(arguments_, environment = {}, timeout = 600000) {
  const command = dockerCommand(arguments_, environment);
  const result = spawnSync(command.executable, command.arguments, {
    encoding: 'utf8',
    env: command.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const error = new Error(`Docker command failed (${result.status}): ${arguments_.join(' ')}\n${result.stderr ?? ''}`);
    error.cause = result.error;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return result;
}

export function runDocker(arguments_, environment = {}, timeout = 600000) {
  const result = executeDocker(arguments_, environment, timeout);
  // Docker sends a container's stderr to its own stderr even on success.
  if (arguments_[0] === 'logs') {
    return [result.stdout, result.stderr].join('\n').split('\n')
      .filter(Boolean).sort().join('\n');
  }
  return result.stdout;
}
