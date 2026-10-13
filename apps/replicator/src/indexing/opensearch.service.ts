import type { IndexService } from './index.service.js';
import type { ShipmentEvent } from '../source/shipment-event.js';

export class OpenSearchWriteError extends Error {
  constructor(
    eventId: number,
    public readonly status: number,
    public readonly body: string,
  ) {
    super('OpenSearch indexing failed for event ' + eventId + ': HTTP ' + status + ' ' + body);
  }
}

export abstract class OpenSearchService implements IndexService {
  protected abstract readonly method: 'POST' | 'PUT';

  protected abstract buildUrl(event: ShipmentEvent): URL;

  protected createUrlFromBase(path: string): URL {
    const baseUrl = process.env.OPENSEARCH_URL;
    if (!baseUrl) throw new Error('OPENSEARCH_URL is required');

    return new URL(path, baseUrl);
  }

  async index(event: ShipmentEvent): Promise<void> {
    const response = await fetch(this.buildUrl(event), {
      method: this.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();

    if (!response.ok) {
      throw new OpenSearchWriteError(event.id, response.status, body);
    }
  }
}
