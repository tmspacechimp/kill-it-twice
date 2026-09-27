import { Injectable } from '@nestjs/common';
import type { Customer } from './initial-load.service.js';

@Injectable()
export class IndexerService {
  async index(customer: Customer): Promise<void> {
    const baseUrl = process.env.OPENSEARCH_URL;
    if (!baseUrl) throw new Error('OPENSEARCH_URL is required');
    const response = await fetch(new URL('/customers/_doc/' + customer.id, baseUrl), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(customer),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error('OpenSearch indexing failed for customer ' + customer.id + ': HTTP ' + response.status + ' ' + body);
    }
  }
}
