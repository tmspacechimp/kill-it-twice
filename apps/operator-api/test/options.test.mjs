import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readOptions } from '../dist/options.js';

test('startup defaults permit an independent, loopback-only operator', () => {
  assert.deepEqual(readOptions({}), { port: 3000, host: '127.0.0.1', replicatorUrl: undefined });
  assert.equal(
    readOptions({ REPLICATOR_API_URL: 'http://replicator:3001/' }).replicatorUrl,
    'http://replicator:3001',
  );
});

test('invalid ports and non-origin upstream URLs fail at startup', () => {
  for (const port of ['0', '65536', '-1', '1.5', 'abc', '']) {
    assert.throws(() => readOptions({ OPERATOR_PORT: port }));
  }
  for (const url of [
    'file:///tmp/test',
    'http://user:pass@localhost',
    'http://localhost/api',
    'http://localhost?path=x',
    'http://localhost/#fragment',
  ]) {
    assert.throws(() => readOptions({ REPLICATOR_API_URL: url }));
  }
});
