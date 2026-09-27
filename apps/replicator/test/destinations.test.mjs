import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IndexerService } from '../dist/indexer.service.js';
import { PublisherService } from '../dist/publisher.service.js';

const customer = {
  id: 1,
  full_name: 'Customer 1',
  email: 'customer1@example.test',
  country_code: 'GE',
  status: 'active',
  created_at: new Date('2025-01-01T00:01:00Z'),
};

const expectedDocument = {
  id: 1,
  full_name: 'Customer 1',
  email: 'customer1@example.test',
  country_code: 'GE',
  status: 'active',
  created_at: '2025-01-01T00:01:00.000Z',
};

test('OpenSearch receives a PUT using the source ID and all customer fields', async (t) => {
  // Given an OpenSearch endpoint that accepts the document.
  useOpenSearchEndpoint(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: url.href, ...options });
    return new Response('{"result":"created"}', { status: 201 });
  });

  // When a customer is indexed.
  await new IndexerService().index(customer);

  // Then exactly one PUT contains the expected document.
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://opensearch:9200/customers/_doc/1');
  assert.equal(requests[0].method, 'PUT');
  assert.deepEqual(JSON.parse(requests[0].body), expectedDocument);
});

test('an OpenSearch rejection reaches the caller without retrying', async (t) => {
  // Given OpenSearch rejects the document.
  useOpenSearchEndpoint(t);
  const request = t.mock.method(globalThis, 'fetch', async () => {
    return new Response('mapping rejected', { status: 400 });
  });

  // When indexing is attempted.
  const indexing = new IndexerService().index(customer);

  // Then the error identifies the record and response, and only one request was made.
  await assert.rejects(indexing, /customer 1: HTTP 400 mapping rejected/);
  assert.equal(request.mock.callCount(), 1);
});

test('RabbitMQ receives the full event and publication waits for confirmation', async (t) => {
  // Given a channel whose broker confirmation has not arrived yet.
  const brokerConfirmation = Promise.withResolvers();
  const waitingForConfirmation = Promise.withResolvers();
  const messages = [];
  const publisher = new PublisherService();
  t.after(() => brokerConfirmation.resolve());

  // Substitute the channel directly so this test needs no RabbitMQ connection.
  publisher.channel = {
    sendToQueue(queue, body, options) {
      messages.push({ queue, event: JSON.parse(body.toString()), options });
      return true;
    },
    waitForConfirms() {
      waitingForConfirmation.resolve();
      return brokerConfirmation.promise;
    },
  };

  // When the customer is published, pause before the broker confirms.
  let publicationFinished = false;
  const publishing = publisher.publish(customer).then(() => {
    publicationFinished = true;
  });
  await waitingForConfirmation.promise;

  // Then the event is correct, but publication is still waiting.
  assert.deepEqual(messages, [
    {
      queue: 'customers.initial-load',
      event: {
        type: 'customer.initial-load',
        sourceId: 1,
        record: expectedDocument,
      },
      options: { contentType: 'application/json', persistent: false },
    },
  ]);
  assert.equal(publicationFinished, false);

  // Once the broker confirms, publication can finish.
  brokerConfirmation.resolve();
  await publishing;
  assert.equal(publicationFinished, true);
});

function useOpenSearchEndpoint(testContext) {
  const previousUrl = process.env.OPENSEARCH_URL;
  process.env.OPENSEARCH_URL = 'http://opensearch:9200';

  testContext.after(() => {
    if (previousUrl === undefined) {
      delete process.env.OPENSEARCH_URL;
    } else {
      process.env.OPENSEARCH_URL = previousUrl;
    }
  });
}
