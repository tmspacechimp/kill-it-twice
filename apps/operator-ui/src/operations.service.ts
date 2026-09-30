import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { timer, exhaustMap, from } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService, errorMessage } from './api.service';
import { conflicts, replaceOperation } from './operation-state';
import type { Operation, Resource } from './contracts';

@Injectable({ providedIn: 'root' })
export class OperationsService {
  private readonly api = inject(ApiService);
  readonly records = signal<Operation[]>([]);
  readonly message = signal('');
  readonly trackingError = signal('');
  private readonly submitting = signal<Resource[]>([]);

  constructor() {
    timer(1000, 1000)
      .pipe(
        exhaustMap(() => from(this.refresh())),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe();
  }

  busy(resources: Resource[]): boolean {
    return (
      resources.some((resource) => this.submitting().includes(resource)) ||
      conflicts(this.records(), resources)
    );
  }

  async gate<T>(resources: Resource[], work: () => Promise<T>): Promise<T> {
    if (this.busy(resources)) throw new Error('A related operation is pending.');
    this.submitting.update((current) => [...current, ...resources]);
    try {
      return await work();
    } finally {
      this.submitting.update((current) =>
        current.filter((resource) => !resources.includes(resource)),
      );
    }
  }

  async run(path: string, resources: Resource[], body?: unknown): Promise<void> {
    if (this.busy(resources)) return;
    this.submitting.update((current) => [...current, ...resources]);
    this.message.set('Submitting command; completion is not yet confirmed.');
    try {
      const operation = await this.api.request<Operation>('POST', path, body);
      this.records.update((records) => replaceOperation(records, operation));
      this.message.set('Command accepted. Waiting for its outcome.');
    } catch (error) {
      this.message.set(errorMessage(error));
    } finally {
      this.submitting.update((current) =>
        current.filter((resource) => !resources.includes(resource)),
      );
    }
  }

  async refresh(): Promise<void> {
    const pending = this.records().filter((operation) => operation.state === 'pending');
    if (pending.length === 0) return;
    try {
      for (const operation of pending) {
        const update = await this.api.request<Operation>('GET', '/operations/' + operation.id);
        this.records.update((records) => replaceOperation(records, update));
        if (update.state !== 'pending') this.message.set(`${update.action}: ${update.state}.`);
      }
      this.trackingError.set('');
    } catch (error) {
      // Keep pending locks: a lost response does not mean the command failed or stopped.
      this.trackingError.set(errorMessage(error) + ' Pending controls remain disabled.');
    }
  }
}
