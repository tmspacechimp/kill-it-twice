import { randomUUID } from 'node:crypto';
import { ApiError } from './api-error.js';

export type Resource = 'replicator' | 'opensearch' | 'writer';
export type Operation = {
  id: string;
  action: string;
  resources: Resource[];
  state: 'pending' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  message: string;
};

export class OperationsService {
  private readonly operations = new Map<string, Operation>();
  private readonly busy = new Set<Resource>();

  get(id: string): Operation {
    const operation = this.operations.get(id);
    if (!operation) throw new ApiError(404, 'not_found', 'Operation is unknown or has expired.');
    return { ...operation, resources: [...operation.resources] };
  }

  start(action: string, resources: Resource[], work: () => Promise<string>): Operation {
    this.acquire(resources);
    this.prune();
    const operation: Operation = {
      id: randomUUID(),
      action,
      resources,
      state: 'pending',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      message: 'Waiting for confirmation.',
    };
    this.operations.set(operation.id, operation);
    void this.finish(operation, work);
    return this.get(operation.id);
  }

  async exclusive<T>(resources: Resource[], work: () => Promise<T>): Promise<T> {
    this.acquire(resources);
    try {
      return await work();
    } finally {
      this.release(resources);
    }
  }

  private async finish(operation: Operation, work: () => Promise<string>): Promise<void> {
    try {
      operation.message = await work();
      operation.state = 'succeeded';
    } catch (error) {
      operation.message = error instanceof Error ? error.message : 'Operation failed.';
      operation.state = 'failed';
    } finally {
      operation.finishedAt = new Date().toISOString();
      this.release(operation.resources);
    }
  }

  private acquire(resources: Resource[]): void {
    if (resources.some((resource) => this.busy.has(resource))) {
      throw new ApiError(409, 'conflict', 'A conflicting operator command is still pending.');
    }
    resources.forEach((resource) => this.busy.add(resource));
  }

  private release(resources: Resource[]): void {
    resources.forEach((resource) => this.busy.delete(resource));
  }

  private prune(): void {
    // Keep pending work plus the latest completed operations, without persistence.
    for (const [id, operation] of this.operations) {
      if (this.operations.size < 100) break;
      if (operation.state !== 'pending') this.operations.delete(id);
    }
  }
}
