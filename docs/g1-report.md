# Understanding the G1 report

`make verify` runs an isolated crash-and-resume scenario and writes its report
to `summary.json` in the printed run directory under `logs/verify-g1/`.
Detailed evidence is saved alongside it. The command finishes automatically;
successful checks, log collection, and cleanup produce `G1 PASS`.

## The scenario

1. Build and start isolated services, seed the source, and start a replicator
   that will crash at the configured event.
2. Generate nine incremental events while the initial load is unfinished.
   The replicator kills itself immediately after RabbitMQ confirms the selected
   event, before saving that event's cursor.
3. Read the saved checkpoint, confirm the original delivery, then replace the
   replicator container while keeping its checkpoint volume.
4. Confirm replay and resumed progress. After initial loading finishes, generate
   another nine events and wait for the replacement to exit successfully.
5. Compare the full source history with consumer messages and the latest state
   of every shipment with OpenSearch.
6. Refresh and scan OpenSearch history, compare every delivery payload, and
   confirm the crash event has separate original and replay documents. Save
   logs and remove the isolated project.

The consumer, PostgreSQL, OpenSearch, and RabbitMQ stay alive across the injected
replicator crash. [G1.md](../G1.md) explains the recovery design and its assumptions.

## What is checked

| Check | Evidence required to pass |
| --- | --- |
| Initial fixture | The source contains the expected number of seeded events. |
| Injected crash | The selected publisher awaits RabbitMQ confirmation, then sends itself SIGKILL. Docker must report exit code 137. |
| Exact interruption point | The durable initial cursor equals the crash event ID minus one, the initial load is unfinished, and the saved boundary equals the original initial event count. |
| Concurrent incremental progress | The durable incremental cursor equals the initial event count plus nine while the initial load remains unfinished. Timing alone cannot satisfy this check. |
| Original delivery | Before restart, the crash event has exactly one normal consumer message with the correct full payload and no duplicate notice for that ID. |
| Checkpoint survives replacement | After the crash, a separate read-only SQLite connection in a one-off container reads the retained volume. The replacement's startup logs must report that same boundary and both saved cursors. |
| Initial loading resumes at the right row | The replacement's first completed initial batch starts at saved initial cursor plus one. The fixture has contiguous IDs, so this is exactly the event interrupted by the crash. |
| Replay happens | After restart, the consumer must log a duplicate notice for the crash event. |
| Work after initial loading | Initial completion is observed before the second batch of nine events is generated. The final source must contain exactly the initial fixture plus eighteen events. |
| Successful completion | The replacement replicator exits with code 0 after the second traffic batch. Unexpected stops or replicator failure logs fail the scenario. |
| Complete consumer coverage | Every source ID has exactly one normal consumer message of type `shipment.status` with its full matching record. Unknown IDs, missing IDs, repeated normal processing, and wrong payload fields fail. |
| Complete OpenSearch history | Refresh `shipment-records`, scan 500-document scroll pages, and compare every document's source event ID and full payload. Every source event must occur; at least two distinct history documents must contain the crash event. Unknown IDs, corrupt payloads, repeated scan documents, and incomplete scans fail. |
| Latest shipment state | For each shipment, select its highest-version source event, fetch its document by shipment ID, and compare the document's ID, existence, and complete payload. |
| Evidence and cleanup | Collectors must finish without collection errors, final log snapshots must succeed, and removal of the isolated project's containers and volumes must succeed. |

Payload checks compare event ID, shipment ID, version, status, and occurrence
time. Source UTC timestamps are normalized to the ISO spelling used by JSON logs.
OpenSearch `_mget` fetches at most 500 expected shipments per batch, avoiding
dependence on search refresh. It checks expected IDs rather than scanning for
unrelated extra index documents. The separate history scan reads every
`shipment-records` document, including duplicate deliveries, after an explicit
refresh. Scroll resources are cleared on completion or failure.

Reaching the expected consumer-message count only ends the delivery wait.
Exact ID and payload comparisons then establish coverage; one duplicate or
unknown message cannot compensate for a missing event. Empty queue length is
not used as proof of delivery.

## How counts and cursors are calculated

Configuration is saved under `summary.json.configuration`.

| Field | Meaning or calculation |
| --- | --- |
| `initialShipments` | `G1_SEED_SHIPMENTS`, default 4,000. |
| `initialEvents` | Odd shipment IDs have three events; even IDs have two. For S shipments: `3 ? ceil(S / 2) + 2 ? floor(S / 2)`. Default: 10,000. |
| `crashEventId` | `G1_CRASH_EVENT_ID`, default 2,048. Must be at least 2 and below `initialEvents`. |
| `eventsPerTrafficRun` | Nine events, fixed by the G1 scenario. |
| `firstIncrementalEnd` | `initialEvents + 9`: the required incremental cursor at the crash. |
| `expectedEvents` | `initialEvents + 18`: the final source size. Default: 10,018. |
| `waitTimeoutMs` | `G1_WAIT_TIMEOUT_MS`, default 600,000 milliseconds, per asynchronous wait. |
| `pollIntervalMs`, `pollMaxEmpty` | G1's replicator configuration: 1,000 milliseconds and three consecutive empty polls after incremental activity. |

Successful comparisons produce the fields under `summary.json.result`, also
printed after `G1 PASS`:

| Field | How it is measured |
| --- | --- |
| `resumedAfter` | Initial cursor read from durable SQLite after the crash. Must equal `crashEventId - 1`; default 2,047. This is an event ID, not an elapsed duration. |
| `duplicateEventId` | The selected crash event ID whose duplicate notice was observed after restart. |
| `events` | Number of rows in the final source snapshot, verified against `expectedEvents`. |
| `shipments` | Number of distinct shipment IDs in that snapshot, each represented by its highest-version source event. Includes shipments introduced by incremental traffic. |
| `duplicateDeliveries` | Number of explicit duplicate notices in the consumer logs. Counts notices, not distinct IDs. Must include a notice for `duplicateEventId`; normal messages are checked separately. |

The `shipmentRecords` result contains `documents` (all history deliveries),
`events` (distinct source IDs), `duplicateDeliveries` (documents minus distinct
IDs), and `crashEventDeliveries` (at least two). Each scroll page is retained as
`validation/opensearch-records-batch-<n>.json`, with aggregate counts in
`validation/opensearch-records-summary.json`.

A cursor records the last completed source event ID. It is not a message count
or throughput metric. G1 uses contiguous source IDs to check the exact resumed
row; the application itself reads ordered, bounded batches.

## Timing and status

G1 currently records timestamps, rather than the demo's `timings` object.
Calculate overall elapsed milliseconds as:

`Date.parse(summary.endedAt) - Date.parse(summary.startedAt)`

This includes configuration, building, service startup, seeding, the crash,
recreation, resumed processing, comparisons, log snapshots, and cleanup.
There are no separately reported replication, validation, or phase durations.

`timeline.jsonl` timestamps identify observed steps such as traffic generation,
the crash, recreation, final exit, and project removal. Differences between these
entries give elapsed intervals between observations, including command and polling
overhead. Container lifecycle timestamps in `services/lifecycle.jsonl` describe
Docker events instead. Neither is a per-event latency measurement.

Each asynchronous wait gets its own `G1_WAIT_TIMEOUT_MS` deadline and checks at
500 ms intervals plus command execution time. It does not set a deadline for
the whole scenario.

The summary begins as `INCOMPLETE`. Normal completion records `PASS` or `FAIL`;
handled SIGINT/SIGTERM records `INTERRUPTED`. A hard kill can leave `INCOMPLETE`.
`started.json` always preserves the original startup snapshot.

Checks stop on the first failure. Read `validation/failure.json` for assertion
details and `verification.log` or `timeline.jsonl` for collection/cleanup errors.
The result fields are produced only after all scenario comparisons succeed.
A summary can still say FAIL with those fields populated if later collection
or cleanup fails; the top-level status is the final outcome.

## Where the evidence lives

| File | What the reader can inspect |
| --- | --- |
| `checkpoints.jsonl` | SQLite reads before the crash, after the crash, and at completion. The restarted process's loaded checkpoint is labelled as a startup log, not a new database read. |
| `validation/initial-source.json`, `final-source.json` | The exact source fixtures used by the comparisons. |
| `validation/restarted-replicator.json` | Restart logs used to check the retained boundary, cursors, and first resumed batch. |
| `validation/consumer.json` | Normal messages and duplicate IDs parsed from consumer logs. |
| `validation/opensearch-records-batch-*.json`, `opensearch-records-summary.json` | Full history scan pages and distinct-event, delivery, and replay counts. |
| `validation/expected-shipments.json`, `opensearch-batch-*.json` | Highest-version source records and actual fetched documents. |
| `services/` | Separate logs for the killed and replacement containers, plus lifecycle and collection diagnostics. |
| `commands.jsonl`, `source-writer.jsonl` | Docker command results and output from removed one-off source writers. |

Snapshots are retained without rotation and the comparison harness holds fixtures
in memory. The [log guide](run-logs.md) covers file retention. These checks cover
replicator process interruption with intact services and volumes; they do not
establish broker/disk-loss recovery, consumer-crash recovery, G2-G5, or
exactly-once console logging.
