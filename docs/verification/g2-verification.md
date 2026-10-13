# Scheduled replicator-crash verification

Run `make verify-g2` with Node.js 24 and Docker Compose, or `make verify` for G1
followed by G2. On Windows/WSL add `NODE=node.exe`. Each scenario uses its own
isolated Compose project; G2 does not complete every aspect of the G2 epic.
The root-level [G2 proof](../../G2.md) explains recovery and recorded results;
this guide covers configuration and evidence files.

## Configuration

Settings live in `.env.verify`; exported variables take precedence:

```dotenv
DEFAULT_SEED_SHIPMENTS=4000
DEFAULT_WAIT_TIMEOUT_MS=600000
G2_SEED_SHIPMENTS=${DEFAULT_SEED_SHIPMENTS}
G2_WAIT_TIMEOUT_MS=${DEFAULT_WAIT_TIMEOUT_MS}
G2_INCREMENTAL_EVENTS=6000
G2_CRASH_EVENT_IDS=[2048,2048,12048]
```

The harness resolves these two shared-default references. A literal G2 value
overrides its shared default without changing G1. The timeout applies to each
asynchronous wait; incremental size is event rows per generated traffic batch.

Crash IDs form a nonempty JSON array of nondecreasing integers above 1, through
`initialEvents + G2_INCREMENTAL_EVENTS`. Decreasing IDs can already be behind
the saved cursor, so they are rejected before infrastructure starts. The default
fixture has 10,000 initial events: 2048 is initial, and 12048 is incremental.
Initial-only schedules such as `[2048,2048,4096]` remain supported.

## Six steps

1. Build isolated services, seed the initial dataset, and capture its boundary.
2. Install one crash target per replicator run. Each target triggers SIGKILL
   after broker confirmation and before its reader's checkpoint. Validate exit
   137, the original boundary, saved cursors, correct consumer payloads, and
   preceding scheduled replays before advancing.
3. Append restart traffic while stopped, recreate without injection, and validate
   both loaded cursors.
4. Wait for successful completion. Verify
   the completed initial and incremental cursors and the first resumed initial
   row when initial work was unfinished.
5. Compare every source event with unique normal consumer handling and check
   every latest shipment document plus the exact total shipment count.
6. Scan full OpenSearch event history and require matching source payloads and
   enough distinct deliveries to prove every scheduled replay.

Only the replicator is recreated. Its checkpoint volume, destination services,
consumer, and consumer receipts survive. Repeated targets may kill a restarted
process immediately; startup evidence is read even if that process has exited.

## Incremental traffic and concurrent progress

The first traffic batch is generated after the first incremental target has
been installed. Generating it earlier could let an initial-crash run checkpoint
a future incremental target. The second batch is generated while stopped before
the final restart, supplying new activity even if earlier incremental work finished.
This also avoids an idle-stop race when only the last replay remains and writer
startup takes longer than the post-activity empty-poll window.
An initial-only schedule needs just the final batch.

At an initial crash, the initial cursor must equal target minus one. At an
incremental crash, the incremental cursor must equal target minus one; the
initial reader may have advanced or finished concurrently. Both cursors must
retain prior progress and stay within their source ranges. The default target
and larger traffic batch encourage overlapping readers; saved cursors and logs
record what actually happened rather than asserting overlap from timing alone.

For incremental schedules, final source size is `initialEvents + 2 * incrementalEvents`;
for initial-only schedules it is `initialEvents + incrementalEvents`. Every
process still waits for first incremental activity before counting empty polls,
then stops after three consecutive empty polls one second apart. It must finish
the initial load before exiting. These replicator rules are unchanged.

## Retained evidence and failure

The printed run directory is under `logs/verify-g2/<run-id>/`. Files follow the
[G1 evidence conventions](../guides/run-logs.md#g1-evidence), without automatic rotation.
Host evidence survives isolated-project cleanup.

`crash-schedule.json` retains the sequence. `checkpoints.jsonl` contains durable
SQLite reads after every crash and at completion. `validation/startup-N.json`
and `final-startup.json` contain loaded-checkpoint logs and expected cursors;
these are not fresh disk reads. `validation/crash-N.json` contains the validated
exit, checkpoint, cumulative consumer observations, and replicator logs. Service
logs retain each killed and replacement container separately.

Final source, consumer, expected shipments, actual shipment batches/count, and
history scroll pages live in `validation/`. `summary.json` records configuration,
status, validated crash checkpoints, event/shipment totals, duplicate notices,
and history replay counts. `timeline.jsonl` records advancement and cleanup;
`commands.jsonl` retains Docker output. Missing crashes, incorrect progress,
missing or repeated normal handling, mismatches, and evidence/cleanup failures
produce FAIL and a nonzero exit.

## Guarantee and limits

The case demonstrates at-least-once processing with harmless replay for a finite
replicator crash schedule. It assumes a single serial append-only source writer,
one replicator per checkpoint volume, one surviving consumer per receipt volume,
and intact source, destinations, and volumes. Current-state versions prevent
regression; consumer receipts suppress repeated normal handling. History
duplicates are expected delivery evidence. An incremental crash can also
interrupt the other reader's uncheckpointed event, producing additional harmless
replays. This is not exactly-once delivery or logging, consumer-crash recovery,
broker/disk-loss recovery, or proof of every possible failure schedule.
