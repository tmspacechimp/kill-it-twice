import assert from 'node:assert/strict';
import test from 'node:test';
import { generateEvents } from '../dist/generator.js';
import { writeEvents } from '../dist/writer.js';

test('writer awaits bounded parameterized inserts and commits the partial last batch', async () => {
  const calls = [];
  let generated = 0;
  function* events() {
    for (const event of generateEvents(401)) {
      generated++;
      yield event;
    }
  }
  const db = {
    async query(sql, values) {
      calls.push(sql);
      if (values) {
        const generatedBeforeInsert = generated;
        const count = values.length / 5;
        assert.equal(count, generated === 1000 ? 1000 : 3);
        assert.equal(
          generated,
          calls.filter((s) => s.startsWith('INSERT')).length === 1 ? 1000 : 1003,
        );
        assert.match(sql, /ON CONFLICT \(id\) DO NOTHING$/);
        assert.match(sql, new RegExp(`\\$${values.length}\\)`));
        assert.deepEqual(
          values.slice(0, 5),
          generated === 1000
            ? [1, 1, 1, 'created', '2025-01-01T00:01:00.000Z']
            : [1001, 401, 1, 'created', '2025-01-01T16:41:00.000Z'],
        );
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(generated, generatedBeforeInsert);
        return { rowCount: count };
      }
      return { rowCount: null };
    },
  };
  assert.equal(await writeEvents(db, events()), 1003);
  assert.equal(calls[0], 'BEGIN');
  assert.match(calls[1], /^CREATE TABLE IF NOT EXISTS/);
  assert.equal(calls.at(-1), 'COMMIT');
});

test('rerun reporting uses the database inserted count', async () => {
  const db = {
    async query() {
      return { rowCount: 0 };
    },
  };
  assert.equal(await writeEvents(db, generateEvents(2)), 0);
});

test('a failed later batch rolls back and stops reading', async () => {
  const calls = [];
  const failure = new Error('shipment/version conflict');
  const db = {
    async query(sql, values) {
      calls.push(sql);
      if (values?.[0] === 1001) throw failure;
      return { rowCount: values ? values.length / 5 : null };
    },
  };
  await assert.rejects(writeEvents(db, generateEvents(1200)), (error) => error === failure);
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.equal(calls.filter((sql) => sql.startsWith('INSERT')).length, 2);
  assert.ok(!calls.includes('COMMIT'));
});
