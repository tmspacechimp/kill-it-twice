import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { ApiError } from './api-error.js';

export type ContainerAction =
  'replicator-kill' | 'replicator-restart' | 'opensearch-stop' | 'opensearch-restore';
export type ComposeOptions = { project: string; file: string; directory: string };
export type DockerRunner = (args: string[], timeoutMs: number) => Promise<string>;

export function readComposeOptions(
  env: NodeJS.ProcessEnv = process.env,
): ComposeOptions | undefined {
  const project = env.OPERATOR_COMPOSE_PROJECT;
  const file = env.OPERATOR_COMPOSE_FILE;
  const directory = env.OPERATOR_COMPOSE_DIRECTORY;
  if (!project && !file && !directory) return undefined;
  if (
    !project ||
    !/^[a-z0-9][a-z0-9_-]*$/.test(project) ||
    !file ||
    !directory ||
    !isAbsolute(file) ||
    !isAbsolute(directory)
  ) {
    throw new Error(
      'Set OPERATOR_COMPOSE_PROJECT and absolute OPERATOR_COMPOSE_FILE/DIRECTORY paths together.',
    );
  }
  return { project, file, directory };
}

export class ProcessControlService {
  constructor(
    private readonly options?: ComposeOptions,
    private readonly run: DockerRunner = runDocker,
  ) {}

  requireConfigured(): void {
    if (!this.options)
      throw new ApiError(503, 'not_configured', 'Docker Compose controls are not configured.');
  }

  async generate(count: number, rate: number): Promise<string> {
    const output = await this.command(
      [
        'run',
        '--rm',
        '--no-deps',
        '-T',
        'source-writer',
        'generate',
        '--count',
        String(count),
        '--rate',
        String(rate),
      ],
      0,
    );
    if (
      !output.includes(`Generation complete: inserted=${count}\n`) &&
      !output.endsWith(`Generation complete: inserted=${count}`)
    ) {
      throw new Error(
        'Writer exited without confirming the requested count. Earlier commits may remain.\n' +
          output,
      );
    }
    return `Generated ${count} events.\n${output}`;
  }

  async container(action: ContainerAction): Promise<string> {
    let args: string[];
    switch (action) {
      case 'replicator-kill':
        args = ['kill', '--signal', 'SIGKILL', 'replicator'];
        break;
      case 'replicator-restart':
        args = ['restart', 'replicator'];
        break;
      case 'opensearch-stop':
        args = ['stop', 'opensearch'];
        break;
      case 'opensearch-restore':
        args = ['start', 'opensearch'];
        break;
    }
    const output = await this.command(args, 30_000);
    return `Docker confirmed ${action}. This confirms the container command, not service health.\n${output}`;
  }

  private command(args: string[], timeoutMs: number): Promise<string> {
    this.requireConfigured();
    const { project, file, directory } = this.options!;
    return this.run(
      [
        'compose',
        '--project-name',
        project,
        '--project-directory',
        directory,
        '--file',
        file,
        ...args,
      ],
      timeoutMs,
    );
  }
}

export function runDocker(
  args: string[],
  timeoutMs: number,
  spawnProcess = spawn,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('docker', args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    let output = '';
    const capture = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-4096);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.once('error', (error) => reject(new Error(`Docker could not run: ${error.message}`)));
    child.once('close', (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            `Docker exited with ${signal ?? code}; completion is not confirmed.\n${output}`,
          ),
        );
        return;
      }
      resolve(output.replaceAll('\r\n', '\n').trim());
    });
  });
}
