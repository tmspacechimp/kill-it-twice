import assert from 'node:assert/strict';

// Deterministic harness fixture, not process-crash evidence. Initial and
// incremental readers can both advance before an incremental target kills them.
export function scenarioFixture(configuration, overrides = {}) {
  const boundary = configuration.initialEvents;
  const source = Array.from({ length: boundary }, (_, index) => ({
    id: index + 1,
    shipment_id: index + 1,
    version: 1,
    status: 'created',
    occurred_at: '2026-01-01T00:00:00.000Z',
  }));
  const calls = [];
  const output = { events: [], duplicateIds: [] };
  const history = [];
  const checkpoint = { boundary, initialId: null, initialDone: 0, incrementalId: boundary };
  let logs;
  let status;
  let target;

  function deliver(event) {
    history.push({ _id: String(history.length), _source: event });
    if (output.events.some((message) => message.sourceId === event.id)) {
      output.duplicateIds.push(event.id);
    } else {
      output.events.push({ type: 'shipment.status', sourceId: event.id, record: event });
    }
  }

  function processInitial(end) {
    const firstId = (checkpoint.initialId ?? 0) + 1;
    for (const event of source.filter((event) => event.id >= firstId && event.id <= end)) {
      deliver(event);
      if (event.id === target) {
        status = { State: 'exited', ExitCode: 137 };
        return;
      }
      checkpoint.initialId = event.id;
    }
    logs += `\nInitial batch 1: rows=${end - firstId + 1} firstId=${firstId}`;
    if (end === boundary) {
      checkpoint.initialDone = 1;
      logs += '\nInitial load complete:';
    }
  }

  function processIncremental() {
    for (const event of source.filter((event) => event.id > checkpoint.incrementalId)) {
      deliver(event);
      if (event.id === target) {
        status = { State: 'exited', ExitCode: 137 };
        return;
      }
      checkpoint.incrementalId = event.id;
    }
  }

  function start(id = '') {
    calls.push(['start', id]);
    target = id;
    logs = `Startup boundary: lastId=${boundary}\nSaved progress: initialId=${checkpoint.initialId ?? 'none'} initialDone=${checkpoint.initialDone} incrementalId=${checkpoint.incrementalId}`;
    status = { State: 'running' };
    if (checkpoint.initialDone === 0) {
      // Leave initial work outstanding while processing an incremental crash.
      const end = target > boundary ? Math.max(checkpoint.initialId ?? 0, 4) : target || boundary;
      processInitial(end);
    }
    if (status.State === 'running') processIncremental();
    if (!target) status = { State: 'exited', ExitCode: 0 };
  }

  const environment = {
    projectName: 'fixture',
    buildApplications() {},
    startInfrastructure() {},
    seed() {},
    readSourceEvents: () => structuredClone(source),
    startApplications: start,
    recreateReplicator: async (id) => start(id),
    logs: () => logs,
    replicatorStatus: () => status,
    readStoppedCheckpoint: () => ({ ...checkpoint }),
    readConsumerOutput: () => structuredClone(output),
    generate(count) {
      calls.push(['traffic', count]);
      for (let index = 0; index < count; index++) {
        const event = { ...source[0], id: source.length + 1, shipment_id: source.length + 1 };
        source.push(event);
      }
      if (status.State !== 'running') return;
      processIncremental();
      if (!target) status = { State: 'exited', ExitCode: 0 };
    },
    readShipmentDocuments: (ids) =>
      ids.map((id) => ({
        _id: String(id),
        found: true,
        _source: source.find((event) => event.shipment_id === id),
      })),
    readShipmentCount: () => source.length,
    readShipmentRecords: () => [history],
    ...overrides,
  };
  const saved = [];
  const evidence = { save: (name, data) => saved.push({ name, data }), append() {}, timeline() {} };
  const wait = async (description, observe) => {
    const value = observe();
    if (!value) throw new Error('Timed out waiting for ' + description);
    return value;
  };
  return { environment, evidence, configuration, wait, calls, saved };
}
