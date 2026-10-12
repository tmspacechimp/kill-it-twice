import { Injectable } from '@nestjs/common';
import { OpenSearchService } from './opensearch.service.js';

@Injectable()
export class RecordIndexerService extends OpenSearchService {
  protected readonly method = 'POST';

  protected buildUrl(): URL {
    // OpenSearch assigns a new document ID for every delivery, including replays.
    return this.createUrlFromBase('/shipment-records/_doc');
  }
}
