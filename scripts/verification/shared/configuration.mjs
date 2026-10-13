import assert from 'node:assert/strict';

export const DEFAULT_SEED_SHIPMENTS = 4000;
export const DEFAULT_WAIT_TIMEOUT_MS = 600000;

function readInteger(name, value, maximum = 2_147_483_647) {
  const number = Number(value);
  assert.ok(
    /^\d+$/.test(String(value)) && Number.isSafeInteger(number) && number > 0 && number <= maximum,
    `${name} must be an integer between 1 and ${maximum}`,
  );
  return number;
}

function readScenarioValue(name, defaultName, defaults, env) {
  const value = env[name];
  if (value === undefined || value === '${' + defaultName + '}') {
    return defaults[defaultName];
  }
  return value;
}

function readCommonConfiguration(name, env, defaultIncrementalEvents) {
  const defaults = {
    DEFAULT_SEED_SHIPMENTS: readInteger(
      'DEFAULT_SEED_SHIPMENTS',
      env.DEFAULT_SEED_SHIPMENTS ?? DEFAULT_SEED_SHIPMENTS,
      858_993_458,
    ),
    DEFAULT_WAIT_TIMEOUT_MS: readInteger(
      'DEFAULT_WAIT_TIMEOUT_MS',
      env.DEFAULT_WAIT_TIMEOUT_MS ?? DEFAULT_WAIT_TIMEOUT_MS,
    ),
  };
  const initialShipments = readInteger(
    `${name}_SEED_SHIPMENTS`,
    readScenarioValue(`${name}_SEED_SHIPMENTS`, 'DEFAULT_SEED_SHIPMENTS', defaults, env),
    858_993_458,
  );
  const waitTimeoutMs = readInteger(
    `${name}_WAIT_TIMEOUT_MS`,
    readScenarioValue(`${name}_WAIT_TIMEOUT_MS`, 'DEFAULT_WAIT_TIMEOUT_MS', defaults, env),
  );
  const incrementalEvents = readInteger(
    `${name}_INCREMENTAL_EVENTS`,
    env[`${name}_INCREMENTAL_EVENTS`] ?? defaultIncrementalEvents,
  );
  // Odd shipments have three events; even shipments have two.
  const initialEvents = 3 * Math.ceil(initialShipments / 2) + 2 * Math.floor(initialShipments / 2);
  assert.ok(
    initialEvents + 2 * incrementalEvents <= 2_147_483_647,
    'Initial and incremental event IDs must fit the source integer column',
  );
  return { initialShipments, initialEvents, waitTimeoutMs, incrementalEvents };
}

export function readG1Configuration(env = process.env) {
  const configuration = readCommonConfiguration('G1', env, 500);
  const crashEventId = Number(env.G1_CRASH_EVENT_ID ?? '2048');
  assert.ok(
    Number.isInteger(crashEventId) &&
      crashEventId > 1 &&
      crashEventId < configuration.initialEvents,
    `G1_CRASH_EVENT_ID must be an integer between 2 and ${configuration.initialEvents - 1}`,
  );
  return { ...configuration, crashEventId };
}

export function readG2Configuration(env = process.env) {
  const configuration = readCommonConfiguration('G2', env, 6000);
  const crashEventIds = JSON.parse(env.G2_CRASH_EVENT_IDS ?? '[2048,2048,12048]');
  assert.ok(
    Array.isArray(crashEventIds) && crashEventIds.length > 0,
    'G2_CRASH_EVENT_IDS must be a nonempty JSON array',
  );
  const lastAvailableEvent = configuration.initialEvents + configuration.incrementalEvents;
  for (let index = 0; index < crashEventIds.length; index++) {
    const id = crashEventIds[index];
    assert.ok(
      Number.isInteger(id) && id > 1 && id <= lastAvailableEvent,
      `Crash event IDs must be integers between 2 and ${lastAvailableEvent}`,
    );
    if (index > 0) {
      assert.ok(
        id >= crashEventIds[index - 1],
        'Crash event IDs must be nondecreasing so each target can be reached after resume',
      );
    }
  }
  return { ...configuration, crashEventIds };
}
