import assert from 'node:assert/strict';
import { test } from 'node:test';
import { available, startOperator, unsupported } from './http-helpers.mjs';

const configuration = {
  settings: [{ key: 'testSetting', value: 1, description: 'Fixture only', appliesAt: 'Next test' }],
};

test('only freshly advertised configuration keys and scalar types are forwarded', async (t) => {
  const api = await startOperator(t, (request, response, body) => {
    const data = structuredClone(configuration);
    if (request.method === 'PUT') data.settings[0].value = JSON.parse(body).values.testSetting;
    response.end(JSON.stringify(available(data)));
  });
  for (const values of [{ unknown: 1 }, { testSetting: '1' }]) {
    const result = await api.request('/config', 'PUT', { values });
    assert.equal(result.status, 400);
  }
  assert.ok(api.requests.every((request) => request.method === 'GET'));
  const result = await api.request('/config', 'PUT', { values: { testSetting: 2 } });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.settings[0].value, 2);
  assert.equal(result.body.data.settings[0].appliesAt, 'Next test');
  assert.deepEqual(
    api.requests.slice(-2).map(({ method }) => method),
    ['GET', 'PUT'],
  );
});

test('unsupported or malformed configuration prevents writes', async (t) => {
  let payload = unsupported;
  const api = await startOperator(t, (_request, response) => response.end(JSON.stringify(payload)));
  assert.equal((await api.request('/config', 'PUT', { values: { testSetting: 2 } })).status, 501);
  payload = available({ settings: [configuration.settings[0], configuration.settings[0]] });
  assert.equal((await api.request('/config', 'PUT', { values: { testSetting: 2 } })).status, 502);
  assert.ok(api.requests.every(({ method }) => method === 'GET'));
});

test('mutation routes forward only the agreed path and require confirmed completion', async (t) => {
  let status = 200;
  let payload = available({ completed: true, message: 'Confirmed by test backend' });
  const api = await startOperator(t, (_request, response) => {
    response.writeHead(status);
    response.end(JSON.stringify(payload));
  });
  for (const path of [
    '/replication/start',
    '/replication/stop',
    '/dlq/event_1/replay',
    '/simulations/rejected-records',
  ]) {
    const result = await api.request(path, 'POST', {});
    assert.equal(result.status, 200);
    assert.equal(result.body.data.completed, true);
    assert.equal(api.requests.at(-1).url, path);
    assert.equal(api.requests.at(-1).method, 'POST');
  }
  status = 202;
  assert.equal((await api.request('/replication/start', 'POST')).body.code, 'unconfirmed');
  status = 200;
  payload = available({ completed: false, message: 'Pending' });
  assert.equal((await api.request('/replication/stop', 'POST')).body.code, 'invalid_response');
});

test('backend conflicts, validation errors and missing entries preserve validated reasons', async (t) => {
  let status = 409;
  const failure = { available: false, code: 'conflict', reason: 'An operation is active.' };
  const api = await startOperator(t, (_request, response) => {
    response.writeHead(status);
    response.end(JSON.stringify(failure));
  });
  for (const code of [400, 404, 409, 422]) {
    status = code;
    const result = await api.request('/dlq/item/replay', 'POST');
    assert.equal(result.status, code);
    assert.deepEqual(result.body, failure);
  }
});

test('DLQ pagination passes tokens and rejects oversized pages', async (t) => {
  const entry = { id: 'event_1', reason: 'Test rejection', record: { sourceId: 42 } };
  let entries = [entry];
  const api = await startOperator(t, (_request, response) => {
    response.end(JSON.stringify(available({ entries, nextCursor: 'next_token' })));
  });
  const result = await api.request('/dlq?limit=1&cursor=current_token');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.entries, [entry]);
  assert.equal(api.requests[0].url, '/dlq?limit=1&cursor=current_token');
  entries = [entry, { ...entry, id: 'event_2' }];
  assert.equal((await api.request('/dlq?limit=1')).body.code, 'invalid_response');
});

test('invalid browser input is rejected before any upstream request', async (t) => {
  const api = await startOperator(t, (_request, response) => response.end('{}'));
  for (const [path, method, body] of [
    ['/config', 'PUT', { values: {} }],
    ['/config', 'PUT', { values: { key: {} } }],
    ['/config', 'PUT', { values: { key: 1 }, extra: true }],
    ['/config', 'PUT', []],
    ['/replication/start', 'POST', { command: 'docker stop postgres' }],
    ['/replication/stop?force=true', 'POST'],
    ['/simulations/rejected-records', 'POST', { count: 3 }],
    ['/dlq/event%20one/replay', 'POST'],
    ['/dlq?limit=101', 'GET'],
    ['/dlq?limit=0', 'GET'],
    ['/dlq?limit=1&limit=2', 'GET'],
    ['/dlq?cursor=../config', 'GET'],
    ['/status?url=http://other', 'GET'],
  ]) {
    const result = await api.request(path, method, body);
    assert.equal(result.status, 400, `${method} ${path}`);
    assert.equal(result.body.available, false);
  }
  const malformed = await fetch(api.url + '/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).available, false);
  const textBody = await fetch(api.url + '/api/replication/start', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'ignored input',
  });
  assert.equal(textBody.status, 415);
  const oversized = await fetch(api.url + '/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: { testSetting: 'x'.repeat(17000) } }),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).available, false);
  assert.equal(api.requests.length, 0);
});
