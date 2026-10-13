# Saved run logs

Demo and verification commands print an absolute host path and create a new timestamp/UUID
directory. Runs never overwrite earlier logs. Compose cleanup keeps host logs;
delete selected run directories when you no longer need them. Git ignores logs.

## Demo

`make run` builds applications, starts infrastructure and Dashboards, seeds an
empty source, starts the consumer and replicator, and waits for the replicator's
saved startup boundary before generating incremental events.

Existing source history and state volumes are retained. DEMO_SEED_SHIPMENTS
applies to a fresh or empty source. Stop an active replicator or source writer
before starting another run. Keep one serial source writer and one replicator
per checkpoint volume. Use `make run-fresh` to delete the current project's
containers and data volumes, then run a new initial fixture. `make reset` only
clears them. Both keep saved logs and configuration. For a separate project that
preserves existing data, see [development.md](development.md).

The command keeps collecting logs until Ctrl+C. Replication still uses the
specified finite polling rule: initial loading must finish, and polling stops
after activity followed by the configured consecutive empty reads. Ctrl+C ends
collection, removes this command's one-off jobs, and leaves regular services
available for inspection. It does not delete source data, checkpoints, or receipts.

After replication finishes, `report.json` and `summary.json.result` contain
checks, counts, and timings. The [demo report guide](demo-report.md) explains
each check, how metrics are calculated, and fresh versus resumed coverage.

Settings in `.env`:

| Variable | Default | Meaning |
| --- | --- | --- |
| DEMO_SEED_SHIPMENTS | 4000 | Initial shipments; odd IDs have 3 events, even IDs have 2 |
| DEMO_INCREMENTAL_EVENTS | 500 | Later event rows to append after replicator startup |
| DEMO_INCREMENTAL_RATE | 20 | Target events/second, from 1 through 1000 |
| DEMO_WAIT_TIMEOUT_MS | 600000 | Maximum wait for replication and then consumer receipts, in milliseconds |
| DEMO_LOG_MAX_BYTES | 10485760 | Per-file limit; older complete lines are discarded |

Demo files live under `logs/demo/<run-id>/`. Each container file has Docker
timestamps and service names. Rotation also bounds the container lifecycle log.
One-off containers are retained until their logs have been saved.

## G1 evidence

Verification settings are independent of demo runs. Set G1_SEED_SHIPMENTS,
G1_CRASH_EVENT_ID, G1_INCREMENTAL_EVENTS, and G1_WAIT_TIMEOUT_MS in `.env.verify`; exported variables
override the file. The crash event must be above 1 and below the initial event
count. G1 generates two batches of G1_INCREMENTAL_EVENTS rows. Seed and timeout
references inherit DEFAULT_SEED_SHIPMENTS and DEFAULT_WAIT_TIMEOUT_MS; literal
scenario values override them. [G1.md](../G1.md) explains the guarantee; the [G1 report guide](g1-report.md)
explains the checks, result fields, and timing observations.

Files under `logs/verify-g1/<run-id>/`:

| File | Contents |
| --- | --- |
| summary.json | Run ID, start/end times, configuration, result, supporting paths |
| started.json | Original INCOMPLETE record, retained if summary updating is interrupted |
| timeline.jsonl | Verification steps, observed kill/restart, cleanup |
| verification.log | Verification output, separate from application logs |
| services/*.log | Timestamped stdout/stderr; killed and replacement containers stay separate |
| services/lifecycle.jsonl | Docker start, kill, exit, and removal times |
| source-writer.jsonl | Output from removed one-off source writers |
| checkpoints.jsonl | Durable SQLite reads after the kill and at completion; loaded checkpoints are in validation startup/restart files |
| validation/ | Source boundaries, expected shipments, consumer events/duplicates, actual OpenSearch documents, discrepancies |
| commands.jsonl | Successful and failed Docker command output |

Checkpoint observations are labelled: a restarted process's loaded-checkpoint
message is not a new disk read, and neither is ordinary in-memory progress.
G1 logs have no automatic rotation. A successful summary is written only after
the existing checks, log collection, and cleanup succeed. No other gate is tested.

## G2 evidence

G2's scheduled-crash case uses the same evidence conventions under
`logs/verify-g2/<run-id>/`, plus a saved crash schedule and observations for each
crash and restart. The [G2 guide](g2-verification.md#retained-evidence) describes
these files and the narrower scope of its PASS result.

## Incomplete collection

Runs start as INCOMPLETE. Handled verification interruption records INTERRUPTED;
a failed run records FAIL. A hard kill or power loss can leave only the original status
and logs flushed so far. Output still in a pipe or filesystem cache can be lost.
Collection failures are reported and prevent a successful result; diagnostics
are saved in `services/collection-errors.jsonl`. Event payloads may appear in logs.
