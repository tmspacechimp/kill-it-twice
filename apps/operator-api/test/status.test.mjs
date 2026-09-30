import assert from 'node:assert/strict';
import { test } from 'node:test';
import { available, startOperator, statusFixture, unsupported } from './http-helpers.mjs';

test('status forwards one request, preserves unknown metrics and timestamps only valid responses', async (t) => {
  let payload = available(statusFixture());
  const api = await startOperator(t, (_request, response) => response.end(JSON.stringify(payload)));
  const first = await api.request('/status');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.deepEqual(first.body.data, statusFixture());
  assert.ok(Number.isFinite(Date.parse(first.body.receivedAt)));
  assert.deepEqual(api.requests, [{ method: 'GET', url: '/status', body: '' }]);

  payload = unsupported;
  const second = await api.request('/status');
  assert.deepEqual(second.body, { ...unsupported, receivedAt: null });
  assert.equal(api.requests.length, 2);
  assert.equal('data' in second.body, false, 'API must not cache a prior success');

  payload = available(statusFixture());
  payload.data.metrics.throughput.value = 24;
  const restored = await api.request('/status');
  assert.equal(restored.body.data.metrics.throughput.value, 24);
  assert.ok(Date.parse(restored.body.receivedAt) > Date.parse(first.body.receivedAt));
  assert.equal(api.requests.length, 3);
});

test('API starts without a replicator and reports missing configuration on every route', async (t) => {
  const api = await startOperator(t);
  const status = await api.request('/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.code, 'not_configured');
  assert.equal(status.body.receivedAt, null);

  for (const [path, method, body] of [
    ['/config', 'GET'],
    ['/config', 'PUT', { values: { example: 1 } }],
    ['/dlq', 'GET'],
    ['/dlq/example/replay', 'POST'],
    ['/replication/start', 'POST'],
    ['/replication/stop', 'POST'],
    ['/simulations/rejected-records', 'POST'],
  ]) {
    const result = await api.request(path, method, body);
    assert.equal(result.status, 503);
    assert.equal(result.body.available, false);
    assert.equal(result.body.code, 'not_configured');
  }
});

test('network failure returns unavailable without fabricated measurements or a timestamp', async (t) => {
  const api = await startOperator(t, (request) => request.socket.destroy());
  const result = await api.request('/status');
  assert.equal(result.body.code, 'unreachable');
  assert.equal(result.body.available, false);
  assert.equal(result.body.receivedAt, null);
  assert.equal('data' in result.body, false);
  assert.equal(api.requests.length, 1);
});

test('malformed JSON, wrong schema, missing definitions and bare unsupported routes are unavailable', async (t) => {
  let responseStatus = 200;
  let payload = 'not JSON';
  const api = await startOperator(t, (_request, response) => {
    response.writeHead(responseStatus);
    response.end(payload);
  });

  const missingDefinition = statusFixture();
  delete missingDefinition.metrics.throughput.definition;
  for (const invalid of ['not JSON', '{}', 'null', JSON.stringify(available(missingDefinition))]) {
    payload = invalid;
    const result = await api.request('/status');
    assert.equal(result.body.code, 'invalid_response');
    assert.equal(result.body.receivedAt, null);
  }
  responseStatus = 404;
  payload = '<html>not found</html>';
  const result = await api.request('/status');
  assert.equal(result.body.code, 'unsupported');
  assert.equal(result.body.receivedAt, null);
});

test('deadline includes a stalled response body and does not retry', async (t) => {
  const api = await startOperator(t, (_request, response) => {
    response.writeHead(200);
    response.write('{');
  });
  const started = performance.now();
  const result = await api.request('/status');
  const elapsed = performance.now() - started;
  assert.equal(result.body.code, 'timeout');
  assert.equal(result.body.receivedAt, null);
  assert.ok(elapsed >= 1800 && elapsed < 4000, `elapsed: ${elapsed}`);
  assert.equal(api.requests.length, 1);
});

test('oversized responses are rejected and redirects are not followed', async (t) => {
  let redirect = false;
  const api = await startOperator(t, (_request, response) => {
    if (redirect) {
      response.writeHead(302, { Location: '/other' });
      response.end();
      return;
    }
    response.end('x'.repeat(1024 * 1024 + 1));
  });
  assert.equal((await api.request('/status')).body.code, 'invalid_response');
  redirect = true;
  assert.equal((await api.request('/status')).body.code, 'upstream_error');
  assert.equal(api.requests.length, 2);
});

test('a mutation with no response headers times out without being retried or reported complete', async (t) => {
  const api = await startOperator(t, () => {});
  const result = await api.request('/replication/stop', 'POST');
  assert.equal(result.status, 504);
  assert.equal(result.body.code, 'timeout');
  assert.equal(result.body.available, false);
  assert.match(result.body.reason, /completion is unknown/);
  assert.equal(api.requests.length, 1);
});
