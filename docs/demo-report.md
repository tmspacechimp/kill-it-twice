# Understanding the demo report

`make run` and `make run-fresh` generate `report.json` in the printed run
directory. The same result appears in `summary.json.result`. Checks start after
traffic generation and wait for replication to finish; you do not need to press
Ctrl+C to trigger them.

## What is checked

These are checks against the running demo and its saved data.

| Report check | How it passes |
| --- | --- |
| `replicatorExit` | Docker reports the replicator as exited with code 0. A running process is observed until it exits; another state or a nonzero exit fails. |
| `generatedEvents` | The final PostgreSQL event count equals the count captured before application startup plus `DEMO_INCREMENTAL_EVENTS`. |
| `consumerReceipts` | Every source event ID matches exactly one durable receipt for `shipment-consumer` and `client-source`. The sorted ID lists must match, so equal counts cannot hide missing or unknown IDs. The consumer must be running while receipts are read. |
| `loggedPayloads` | Each current-run `Received event` message has a known source ID, type `shipment.status`, and the exact source record. An ID cannot have two normal processing logs. Required deliveries must have a matching normal log. Duplicate notices must refer to known source IDs. |
| `latestShipmentState` | For each shipment, select the source event with its highest version. Fetch the document by shipment ID from OpenSearch and compare its ID, existence, and entire payload with that event. |
| `logCollection` | After Ctrl+C, the collector exits cleanly without recorded collection errors, the final log snapshot succeeds, and retained one-off containers are removed. |

Payload comparison includes event ID, shipment ID, version, status, and occurrence
time. Source UTC timestamps are converted to the same ISO spelling used in JSON
logs. OpenSearch documents are fetched with `_mget` in batches of at most 1,000;
this avoids depending on search refresh. The check covers expected shipment IDs,
rather than scanning the index for unrelated extra documents.

### Fresh and resumed runs

For a fresh source, every final source event needs a matching consumer payload
log. For an existing source, that requirement applies to events above the highest
source ID captured before application startup. Any older events logged during
this run also have their payloads checked.

Receipt coverage always includes the entire source history. Existing receipts
establish recorded event identity; they do not establish historical payload
correctness or exactly-once business effects. Valid duplicate notices are counted
and allowed, since replay can occur when resuming unfinished work.

The report observes a completed demo. It does not inject a crash or establish
recovery from failures; [G1](../G1.md) checks replicator crash recovery separately.
Keep one serial source writer during the run. Extra manual traffic changes the
expected final count and fails `generatedEvents`.

## How counts are calculated

A shipment can have several source events. These fields count event rows unless
explicitly named otherwise.

| Field under `counts` | Calculation |
| --- | --- |
| `sourceEventsAtStartup` | PostgreSQL row count after seeding or preserving existing data, before starting the applications. Includes previously processed history, not just work remaining for this run. |
| `generatedEvents` | On success, the configured incremental event count, verified against the increase in source rows. A partial failed report can instead contain the observed increase. |
| `sourceEvents` | Number of rows in the final source snapshot. |
| `consumerReceipts` | Number of persisted event IDs for the fixed consumer/source pair. Includes receipts from previous runs. |
| `shipments` | Number of distinct shipment IDs in the source snapshot, each represented by its highest-version event. |
| `loggedPayloads` | Number of normal `Received event` messages logged since this run's application-start timestamp. Previous-run logs are excluded. |
| `duplicateDeliveries` | Number of duplicate notices in that same log window. Counts notices, not distinct IDs; repeated notices for one ID each count. |

For example, a fresh fixture with 8 events followed by 9 generated events has
17 source events, 17 receipts, and 17 required payload logs. A repeat run adding
another 9 has 26 source events and receipts, but only 9 new payload logs are
required if the earlier work had completed.

## How timings are calculated

All duration fields use host wall-clock milliseconds; divide by 1,000 for seconds.
They include Docker commands and polling overhead. They are elapsed observations,
not CPU time or per-event latency, and a host clock adjustment can affect them.

| Field under `timings` | Start and end |
| --- | --- |
| `phasesMs` | Each printed workflow step starts a timer. The next step ends it; the final traffic step ends when its writer command returns. See the phase boundaries below. |
| `replicationMs` | From immediately before starting the applications until the report observes replicator exit 0. Includes application startup, traffic generation, concurrent initial/incremental processing, and the final idle polls. |
| `validationMs` | From observed successful replicator exit through the source read, receipt wait, payload checks, and OpenSearch comparisons. |
| `toValidationMs` | From run-summary creation through successful validation. Includes configuration, collection startup, build, infrastructure, seeding, replication, and validation. |

The `phasesMs` entries have these boundaries:

- **Build applications:** build command through the next infrastructure step.
- **Start infrastructure:** service health waits, Dashboards setup, and checking
  whether the source needs seeding.
- **Seed empty source:** seed writer command until the application-start step begins.
  **Keep existing source history** replaces this phase when data already exists.
- **Start consumer and replicator:** capture source counts and highest ID, start
  applications, and wait for the replicator's saved startup-boundary log.
- **Generate incremental events:** incremental writer command through its return.

Replication overlaps traffic generation, so adding every duration together
double-counts work. `toValidationMs` gives the elapsed time to completed checks.
It excludes the later time spent collecting logs until Ctrl+C, final cleanup,
and the reset command that runs before `make run-fresh` starts the demo runner.

`completedAt` is the timestamp when validation succeeds or its reporting stage
fails. `summary.json.startedAt` and `endedAt` describe the overall collection
session; their difference includes time spent waiting for Ctrl+C.

## Results and supporting files

The report starts as `INCOMPLETE`. Successful validation sets it to `PASS`
while logs continue collecting. `logCollection` is added during shutdown; a
collection or cleanup error can change the result to `FAIL`. Stopping before
validation finishes records `INTERRUPTED`; the outer summary records `STOPPED`
when that interruption and shutdown are clean.

Checks stop at the first error. Only checks that reached a successful comparison
have PASS entries, apart from the shutdown check, which can explicitly say FAIL.
Read `error` for the failure; missing counts or timings mean that stage did not
finish. `DEMO_WAIT_TIMEOUT_MS` defaults to 600,000 ms and applies separately to
waiting for replicator completion and consumer receipts. Both are observed at
500 ms intervals plus command execution time.

Supporting snapshots live under `validation/`: source events, consumer receipt
IDs, current-run consumer logs, expected latest shipments, and OpenSearch
responses. They are unrotated and loaded in memory for comparison. The
[log guide](run-logs.md) explains service logs, retention, and incomplete runs.
`started.json` permanently preserves the original INCOMPLETE startup record;
use `report.json` and `summary.json` for updated results.
