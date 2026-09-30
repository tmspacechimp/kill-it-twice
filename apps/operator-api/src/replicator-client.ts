import { ApiError } from './api-error.js';
import { completionSchema, configurationSchema, dlqPageSchema, statusSchema } from './contracts.js';
import type { ConfigurationUpdate, DlqQuery } from './contracts.js';
import { validateSettings } from './input.js';
import { ReplicatorHttp } from './replicator-http.js';

export class ReplicatorClient {
  private readonly http: ReplicatorHttp;

  constructor(origin: string | undefined) {
    this.http = new ReplicatorHttp(origin);
  }

  async status() {
    try {
      const data = await this.http.request('GET', '/status', statusSchema);
      return { available: true as const, data, receivedAt: new Date().toISOString() };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return { ...error.details, receivedAt: null };
    }
  }

  async configuration() {
    const data = await this.http.request('GET', '/config', configurationSchema);
    return { available: true as const, data };
  }

  async updateConfiguration(update: ConfigurationUpdate) {
    const current = await this.configuration();
    validateSettings(update, current.data);
    const data = await this.http.request('PUT', '/config', configurationSchema, update);
    return { available: true as const, data };
  }

  async dlq(query: DlqQuery) {
    const parameters = new URLSearchParams({ limit: String(query.limit) });
    if (query.cursor) parameters.set('cursor', query.cursor);

    const data = await this.http.request('GET', `/dlq?${parameters}`, dlqPageSchema);
    if (data.entries.length > query.limit) {
      throw new ApiError(
        502,
        'invalid_response',
        'Replicator returned more DLQ entries than requested.',
      );
    }
    return { available: true as const, data };
  }

  start() {
    return this.complete('/replication/start');
  }

  stop() {
    return this.complete('/replication/stop');
  }

  replay(id: string) {
    return this.complete(`/dlq/${encodeURIComponent(id)}/replay`);
  }

  rejectedRecords() {
    return this.complete('/simulations/rejected-records');
  }

  private async complete(path: string) {
    const data = await this.http.request('POST', path, completionSchema);
    return { available: true as const, data };
  }
}
