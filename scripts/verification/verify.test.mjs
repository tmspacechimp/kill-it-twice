import assert from 'node:assert/strict';
import test from 'node:test';
import { basename, dirname } from 'node:path';
import { verifyAll } from './verify.mjs';

test('combined verification runs G1 then G2, even when G1 fails', () => {
  const calls = [];
  const status = verifyAll((executable, args, options) => {
    calls.push(basename(args[0]));
    assert.equal(basename(dirname(args[0])), calls.length === 1 ? 'g1' : 'g2');
    assert.equal(executable, process.execPath);
    assert.equal(options.stdio, 'inherit');
    return { status: calls.length === 1 ? 1 : 0 };
  });
  assert.deepEqual(calls, ['verify-g1.mjs', 'verify-g2.mjs']);
  assert.equal(status, 1);
  assert.equal(
    verifyAll(() => ({ status: 0 })),
    0,
  );
  let index = 0;
  assert.equal(
    verifyAll(() => ({ status: index++ === 0 ? 0 : 1 })),
    1,
  );
});

test('combined verification stops on interruption', () => {
  let calls = 0;
  assert.equal(
    verifyAll(() => {
      calls++;
      return { status: 130 };
    }),
    130,
  );
  assert.equal(calls, 1);
});
