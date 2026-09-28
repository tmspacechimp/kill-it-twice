import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IndexerService } from '../dist/indexer.service.js';
import { PublisherService } from '../dist/publisher.service.js';

const event = {
  id: 1,
  shipment_id: 42,
  version: 3,
  status: 'delivered',
  occurred_at: new Date('2025-01-01T00:01:00Z'),
};

const expectedDocument = {
  id: 1,
  shipment_id: 42,
  version: 3,
  status: 'delivered',
  occurred_at: '2025-01-01T00:01:00.000Z',
};

test('OpenSearch receives the shipment ID, external version, and all event fields', async (t) => {
  // Given an OpenSearch endpoint that accepts the document.
  useOpenSearchEndpoint(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: url.href, ...options });
    return new Response('{"result":"created"}', { status: 201 });
  });

  // When an event is indexed.
  await new IndexerService().index(event);

  // Then exactly one PUT contains the expected document.
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'http://opensearch:9200/shipments/_doc/42?version=3&version_type=external',
  );
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
  const indexing = new IndexerService().index(event);

  // Then the error identifies the record and response, and only one request was made.
  await assert.rejects(indexing, /event 1: HTTP 400 mapping rejected/);
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

  // When the event is published, pause before the broker confirms.
  let publicationFinished = false;
  const publishing = publisher.publish(event).then(() => {
    publicationFinished = true;
  });
  await waitingForConfirmation.promise;

  // Then the event is correct, but publication is still waiting.
  assert.deepEqual(messages, [
    {
      queue: 'shipments.initial-load',
      event: {
        type: 'shipment.status',
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

test('older and replayed events still publish while the highest shipment version stays indexed', async (t) => {
  useOpenSearchEndpoint(t);
  const documents = new Map();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const document = JSON.parse(options.body);
    const key = url.pathname;
    const version = Number(url.searchParams.get('version'));
    assert.equal(url.searchParams.get('version_type'), 'external');
    if (documents.has(key) && documents.get(key).version >= version) {
      return new Response(
        JSON.stringify({ error: { type: 'version_conflict_engine_exception' } }),
        { status: 409 },
      );
    }
    documents.set(key, document);
    return new Response('{}', { status: 201 });
  });
  const messages = [];
  const publisher = new PublisherService();
  publisher.channel = {
    sendToQueue(queue, body) {
      messages.push(JSON.parse(body.toString()));
    },
    async waitForConfirms() {},
  };
  const indexer = new IndexerService();
  // Event IDs and timestamps do not define shipment version ordering.
  const history = [
    event,
    { ...event, id: 2, version: 1, status: 'created' },
    { ...event, id: 3, shipment_id: 43, version: 1, status: 'created' },
    { ...event, id: 4, version: 2, status: 'in_transit' },
  ];
  for (const record of [...history, ...history]) {
    await indexer.index(record);
    await publisher.publish(record);
  }
  assert.equal(documents.size, 2);
  assert.deepEqual(documents.get('/shipments/_doc/42'), expectedDocument);
  assert.equal(documents.get('/shipments/_doc/43').version, 1);
  assert.deepEqual(
    messages.map((message) => message.sourceId),
    [1, 2, 3, 4, 1, 2, 3, 4],
  );
});

test('unrelated and malformed HTTP 409 responses fail instead of being treated as old versions', async (t) => {
  useOpenSearchEndpoint(t);
  for (const body of ['not JSON', 'null', '{"error":{"type":"other_error"}}']) {
    const request = t.mock.method(
      globalThis,
      'fetch',
      async () => new Response(body, { status: 409 }),
    );
    await assert.rejects(new IndexerService().index(event), /HTTP 409/);
    assert.equal(request.mock.callCount(), 1);
    request.mock.restore();
  }
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
