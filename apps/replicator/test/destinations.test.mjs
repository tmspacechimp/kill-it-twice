import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IndexerService } from '../dist/indexer.service.js';
import { PublisherService } from '../dist/publisher.service.js';

const customer = {
  id: 1, full_name: 'Customer 1', email: 'customer1@example.test',
  country_code: 'GE', status: 'active', created_at: new Date('2025-01-01T00:01:00Z'),
};

function endpoint(t) {
  const original = process.env.OPENSEARCH_URL;
  process.env.OPENSEARCH_URL = 'http://opensearch:9200';
  t.after(() => {
    if (original === undefined) delete process.env.OPENSEARCH_URL;
    else process.env.OPENSEARCH_URL = original;
  });
}

test('indexing uses the source ID and complete JSON fields', async (t) => {
  endpoint(t);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.href, 'http://opensearch:9200/customers/_doc/1');
    assert.equal(options.method, 'PUT');
    assert.deepEqual(JSON.parse(options.body), {
      ...customer, created_at: '2025-01-01T00:01:00.000Z',
    });
    return new Response('{"result":"created"}', { status: 201 });
  });
  await new IndexerService().index(customer);
});

test('a rejected index write fails without retry', async (t) => {
  endpoint(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
    new Response('mapping rejected', { status: 400 }));
  await assert.rejects(new IndexerService().index(customer), /customer 1: HTTP 400 mapping rejected/);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('publication contains the indexed record and waits for broker confirmation', async () => {
  const publisher = new PublisherService();
  let confirm;
  const confirmation = new Promise((resolve) => { confirm = resolve; });
  publisher.channel = {
    sendToQueue(queue, body, options) {
      assert.equal(queue, 'customers.initial-load');
      assert.deepEqual(JSON.parse(body.toString()), {
        type: 'customer.initial-load', sourceId: 1,
        record: { ...customer, created_at: '2025-01-01T00:01:00.000Z' },
      });
      assert.equal(options.persistent, false);
      assert.equal(options.contentType, 'application/json');
      return true;
    },
    waitForConfirms() { return confirmation; },
  };
  let completed = false;
  const pending = publisher.publish(customer).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  confirm();
  await pending;
  assert.equal(completed, true);
});
