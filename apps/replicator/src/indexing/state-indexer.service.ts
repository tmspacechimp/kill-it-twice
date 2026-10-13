import { Injectable, Logger } from '@nestjs/common';
import { OpenSearchService, OpenSearchWriteError } from './opensearch.service.js';
import type { ShipmentEvent } from '../source/shipment-event.js';

@Injectable()
export class StateIndexerService extends OpenSearchService {
  protected readonly method = 'PUT';
  private readonly logger = new Logger(StateIndexerService.name);

  protected buildUrl(event: ShipmentEvent): URL {
    const url = this.createUrlFromBase('/shipments/_doc/' + event.shipment_id);
    url.searchParams.set('version', String(event.version));
    url.searchParams.set('version_type', 'external');
    return url;
  }

  async index(event: ShipmentEvent): Promise<void> {
    try {
      await super.index(event);
    } catch (error) {
      if (!this.isVersionConflict(error)) throw error;

      this.logger.warn(
        `State version conflict for event ${event.id} ` +
          `(shipment=${event.shipment_id}, version=${event.version}); keeping existing state`,
      );
    }
  }

  private isVersionConflict(error: unknown): boolean {
    if (!(error instanceof OpenSearchWriteError) || error.status !== 409) return false;

    try {
      const result = JSON.parse(error.body) as { error?: { type?: string } };
      return result?.error?.type === 'version_conflict_engine_exception';
    } catch {
      return false;
    }
  }
}
