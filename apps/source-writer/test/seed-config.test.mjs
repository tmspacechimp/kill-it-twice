import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCommand } from '../dist/cli.js';
import { generateEvents } from '../dist/generator.js';

test('shared seed setting produces 100000 events for 40000 shipments', () => {
  const command = parseCommand([], '40000');
  assert.deepEqual(command, { name: 'seed', shipmentCount: 40000 });
  let count = 0;
  for (const event of generateEvents(command.shipmentCount)) {
    count++;
    assert.equal(event.id, count);
  }
  assert.equal(count, 100000);
});

test('explicit shipment argument overrides the shared setting', () => {
  assert.deepEqual(parseCommand(['--shipments', '3'], '40000'), {
    name: 'seed',
    shipmentCount: 3,
  });
});

test('invalid seed environment fails before any database work', () => {
  for (const value of ['', '0', '-1', '1.5', 'bad', '858993459']) {
    assert.throws(() => parseCommand([], value));
  }
  assert.deepEqual(parseCommand(['--help'], 'bad'), { name: 'help' });
});
