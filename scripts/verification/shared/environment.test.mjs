import assert from 'node:assert/strict';
import test from 'node:test';
import { VerificationEnvironment } from './environment.mjs';

test('recreation installs one scheduled target and snapshots before replacing only the replicator', async (t) => {
  const calls = [];
  const evidence = {
    stopCollector: async () => calls.push('stop'),
    snapshot: () => calls.push('snapshot'),
    timeline() {},
    startCollector: () => calls.push('collect'),
  };
  const environment = new VerificationEnvironment('test', evidence);
  t.mock.method(environment, 'replicatorStatus', () => ({ State: 'exited', ExitCode: 137 }));
  t.mock.method(environment, 'compose', (...args) =>
    calls.push({ args, target: environment.crashEventId }),
  );
  await environment.recreateReplicator(2048);
  await environment.recreateReplicator();
  assert.deepEqual(calls, [
    'stop',
    'snapshot',
    { args: ['up', '-d', '--force-recreate', 'replicator'], target: 2048 },
    'collect',
    'stop',
    'snapshot',
    { args: ['up', '-d', '--force-recreate', 'replicator'], target: '' },
    'collect',
  ]);
});

test('collection failure prevents replacing a crash container', async (t) => {
  const environment = new VerificationEnvironment('test', {
    stopCollector: async () => {
      throw new Error('Collection failed');
    },
  });
  t.mock.method(environment, 'compose', () => assert.fail('Must retain old container'));
  await assert.rejects(environment.recreateReplicator(2048), /Collection failed/);
});

function historyEnvironment(t, pages) {
  const saved = [];
  const calls = [];
  const environment = new VerificationEnvironment('test', {
    save: (name, data) => saved.push({ name, data }),
  });
  t.mock.method(environment, 'requestOpenSearch', (method, path, body) => {
    calls.push({ method, path, body: body && JSON.parse(body) });
    if (path === '/shipment-records/_refresh') return {};
    if (method === 'DELETE') return {};
    const page = pages.shift();
    if (!page) throw new Error('Unexpected history page request');
    return page;
  });
  return { environment, calls, saved };
}

function page(scrollId, documents, total = 2) {
  return {
    _scroll_id: scrollId,
    hits: { total: { value: total, relation: 'eq' }, hits: documents },
  };
}

test('history reader refreshes, follows bounded scroll pages, saves evidence, and clears latest scroll', (t) => {
  const first = { _id: 'a', _source: { id: 1 } };
  const second = { _id: 'b', _source: { id: 2 } };
  const { environment, calls, saved } = historyEnvironment(t, [
    page('first', [first]),
    page('second', [second]),
    page('last', []),
  ]);
  assert.deepEqual([...environment.readShipmentRecords()], [[first], [second]]);
  assert.equal(calls[0].path, '/shipment-records/_refresh');
  assert.equal(calls[1].body.size, 500);
  assert.deepEqual(calls[2].body, { scroll: '1m', scroll_id: 'first' });
  assert.deepEqual(calls.at(-1), {
    method: 'DELETE',
    path: '/_search/scroll',
    body: { scroll_id: ['last'] },
  });
  assert.equal(saved.length, 3);
});

test('history reader clears its scroll when validation stops iteration early', (t) => {
  const { environment, calls } = historyEnvironment(t, [page('first', [{ _id: 'a' }])]);
  assert.throws(() => {
    for (const documents of environment.readShipmentRecords()) {
      assert.fail('payload mismatch');
    }
  }, /payload mismatch/);
  assert.deepEqual(calls.at(-1).body, { scroll_id: ['first'] });
});

test('history reader fails a truncated scan instead of accepting its partial counts', (t) => {
  const { environment, calls } = historyEnvironment(t, [
    page('first', [{ _id: 'a' }]),
    page('last', []),
  ]);
  assert.throws(() => [...environment.readShipmentRecords()], /1 of 2 documents/);
  assert.equal(calls.at(-1).method, 'DELETE');
});

test('history reader retains failed page evidence and clears its scroll on partial search results', (t) => {
  for (const response of [{ timed_out: true }, { _shards: { failed: 1 } }]) {
    const failedPage = { ...page('failed', []), ...response };
    const { environment, calls, saved } = historyEnvironment(t, [failedPage]);
    assert.throws(() => [...environment.readShipmentRecords()], /Incomplete OpenSearch response/);
    assert.deepEqual(saved[0].data, failedPage);
    assert.deepEqual(calls.at(-1).body, { scroll_id: ['failed'] });
  }
});

test('history reader releases the previous scroll if a later page omits its ID', (t) => {
  const missingId = page(undefined, []);
  const { environment, calls, saved } = historyEnvironment(t, [
    page('first', [{ _id: 'a' }]),
    missingId,
  ]);
  assert.throws(
    () => [...environment.readShipmentRecords()],
    /Missing OpenSearch history scroll ID/,
  );
  assert.equal(saved.length, 2);
  assert.deepEqual(calls.at(-1).body, { scroll_id: ['first'] });
});

test('history reader releases its scroll when the next request fails', (t) => {
  const { environment, calls } = historyEnvironment(t, [page('first', [{ _id: 'a' }])]);
  assert.throws(() => [...environment.readShipmentRecords()], /Unexpected history page request/);
  assert.deepEqual(calls.at(-1).body, { scroll_id: ['first'] });
});

test('history reader scans beyond the search result window in bounded pages', (t) => {
  const documents = Array.from({ length: 10_001 }, (_, id) => ({ _id: String(id) }));
  const pages = [];
  for (let offset = 0; offset < documents.length; offset += 500) {
    pages.push(page('scroll-' + offset, documents.slice(offset, offset + 500), documents.length));
  }
  pages.push(page('last', [], documents.length));
  const { environment, calls, saved } = historyEnvironment(t, pages);
  assert.deepEqual([...environment.readShipmentRecords()].flat(), documents);
  assert.equal(saved.length, 22);
  assert.deepEqual(calls.at(-1).body, { scroll_id: ['last'] });
});

test('history reader rejects inexact totals and malformed pages while releasing the scroll', (t) => {
  const invalidPages = [
    { ...page('failed', []), hits: { total: { value: 2, relation: 'gte' }, hits: [] } },
    { ...page('failed', []), hits: { total: { value: -1, relation: 'eq' }, hits: [] } },
    page('failed', null),
    page(
      'failed',
      Array.from({ length: 501 }, () => ({})),
    ),
  ];
  for (const invalidPage of invalidPages) {
    const { environment, calls } = historyEnvironment(t, [invalidPage]);
    assert.throws(
      () => [...environment.readShipmentRecords()],
      /exact history document count|Invalid OpenSearch history page/,
    );
    assert.deepEqual(calls.at(-1).body, { scroll_id: ['failed'] });
  }
});
