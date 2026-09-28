import { Injectable } from '@nestjs/common';
import type { ShipmentEvent } from './shipment-event.js';

@Injectable()
export class IndexerService {
  async index(event: ShipmentEvent): Promise<void> {
    const baseUrl = process.env.OPENSEARCH_URL;
    if (!baseUrl) throw new Error('OPENSEARCH_URL is required');
    const url = new URL('/shipments/_doc/' + event.shipment_id, baseUrl);
    url.searchParams.set('version', String(event.version));
    url.searchParams.set('version_type', 'external');
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();
    // An equal or newer version is already projected. Still publish this event.
    if (response.status === 409 && this.isVersionConflict(body)) return;
    if (!response.ok) {
      throw new Error(
        'OpenSearch indexing failed for event ' +
          event.id +
          ': HTTP ' +
          response.status +
          ' ' +
          body,
      );
    }
  }

  private isVersionConflict(body: string): boolean {
    try {
      const result = JSON.parse(body) as { error?: { type?: string } };
      return result?.error?.type === 'version_conflict_engine_exception';
    } catch {
      return false;
    }
  }
}
