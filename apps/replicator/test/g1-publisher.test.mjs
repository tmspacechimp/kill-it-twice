import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { G1PublisherService } from '../dist/g1-publisher.service.js';

function setupPublisher(t, confirmation) {
  const previousId = process.env.G1_CRASH_EVENT_ID;
  process.env.G1_CRASH_EVENT_ID = '1000';
  t.after(() => {
    if (previousId === undefined) delete process.env.G1_CRASH_EVENT_ID;
    else process.env.G1_CRASH_EVENT_ID = previousId;
  });

  const publisher = new G1PublisherService();
  publisher.channel = {
    sendToQueue: t.mock.fn(),
    waitForConfirms: () => confirmation,
  };
  const simulatedKill = new Error('simulated SIGKILL');
  const kill = t.mock.method(process, 'kill', () => {
    throw simulatedKill;
  });
  return { publisher, kill, simulatedKill };
}

test('G1 waits for confirmation, then kills before the caller can save progress', async (t) => {
  const confirmation = Promise.withResolvers();
  const { publisher, kill, simulatedKill } = setupPublisher(t, confirmation.promise);
  let checkpointSaved = false;
  const processing = publisher.publish({ id: 1000 }).then(() => {
    checkpointSaved = true;
  });
  const interrupted = assert.rejects(processing, simulatedKill);

  await Promise.resolve();
  assert.equal(kill.mock.callCount(), 0, 'Must not kill before broker confirmation');
  confirmation.resolve();
  await interrupted;

  assert.equal(kill.mock.callCount(), 1);
  assert.deepEqual(kill.mock.calls[0].arguments, [process.pid, 'SIGKILL']);
  assert.equal(checkpointSaved, false);
});

test('G1 lets other confirmed events return normally', async (t) => {
  const { publisher, kill } = setupPublisher(t, Promise.resolve());
  await publisher.publish({ id: 999 });
  assert.equal(kill.mock.callCount(), 0);
});

test('G1 propagates failed confirmation without injecting a kill', async (t) => {
  const brokerError = new Error('confirmation rejected');
  const { publisher, kill } = setupPublisher(t, Promise.reject(brokerError));
  await assert.rejects(publisher.publish({ id: 1000 }), brokerError);
  assert.equal(kill.mock.callCount(), 0);
});
