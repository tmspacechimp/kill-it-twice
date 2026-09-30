# Reading the G1 test

Start with `verifyG1()` in [verify-g1.mjs](../verify-g1.mjs). It lists the five
steps in execution order. Its helpers state the assertions for interruption and
resume. [environment.mjs](environment.mjs) contains Docker commands and reads;
[outcomes.mjs](outcomes.mjs) compares source data with observed destinations.
Neither helper starts a test on import.

## What constitutes evidence

| Claim | Evidence the test requires |
| --- | --- |
| There was work to resume | The initial cursor is greater than zero and less than 10000, and initial completion is false, including after SIGKILL. |
| Incremental polling overlaps initial loading | All nine incremental events are checkpointed while the initial load is unfinished. |
| The process was killed after confirmed publication | The G1 publisher awaits the normal publisher for the configured event (default 2048), then sends SIGKILL to itself. The container exits 137 and the saved initial cursor is exactly one less (default 2047). |
| The original message reached the consumer | Before restart, the configured event has one normal consumer log with the matching source payload, and no duplicate log for that ID. |
| Restart actually causes a duplicate | After restart, the consumer must log a duplicate for the configured ID (default `Duplicate event received: sourceId=2048; skipping`). Final coverage still requires exactly one normal processing log for this ID. |
| Progress survived the container | A separate container reads the retained checkpoint volume after the kill. |
| Restart resumes rather than reloading | The replacement reports both saved cursors and the original boundary. Its first completed initial batch starts at exactly saved cursor + 1. |
| Traffic after initial loading still works | Nine more events are generated only after initial completion; they must appear in the final source-to-consumer comparison. |
| No event is missing or corrupted | Every source ID must have exactly one normal consumer log with the full matching payload. Unknown IDs, repeated normal handling, and wrong fields fail explicitly. |
| Current shipment state is correct | For each shipment, the highest source version must exactly match the document fetched by ID from OpenSearch. |
| Verification finished cleanly | The resumed replicator exits 0 and cleanup succeeds before PASS is printed. |

Counts alone do not establish coverage. In particular, one repeated ID cannot
compensate for a missing ID. Empty queue length is not used as delivery evidence.
Timestamp normalization only reconciles PostgreSQL and JSON UTC spellings.

The fixture uses 4000 shipments and 10000 contiguous event IDs. This is why the
first resumed ID must be exactly cursor + 1. The harness holds this small fixture
in memory for comparison; it does not change the application's bounded reads.
OpenSearch `_mget` avoids waiting for search-index refresh.

Set `G1_CRASH_EVENT_ID` in the root [`.env.verify`](../../.env.verify) file;
it is currently `2048`. The harness loads this file, with an existing shell
environment value taking precedence, and passes the value to Docker Compose.
The ID must be an integer between 2 and 9999. It selects the injected publisher for the first run.
The harness clears it before recreating the replicator, selecting the normal
publisher for recovery. The fixed crash point gives incremental traffic time
to arrive, but the saved incremental cursor is the evidence: the test fails if
it has not reached 10009 before the crash.

## Running it

From the repository root, run `make verify` with Node.js 24 and Docker Compose.
On this Windows/WSL setup use `make verify NODE=node.exe`. Every run uses its own
random Compose project, volumes, and image names, with no published ports.
Cleanup removes only that project's containers and volumes, including on failure.

For fast checks of the comparison code, without Docker:

```sh
node --test scripts/verification/outcomes.test.mjs
```

Those checks deliberately feed missing events, duplicate IDs, incorrect payloads,
and wrong shipment documents to the assertions. They check the test's comparisons;
they do not replace the real SIGKILL scenario.

G1 kills after broker confirmation and before checkpointing; it does not
simulate losing the confirmation itself, kill the consumer, or test broker loss.
Explicit consumer duplicate logs are counted separately from normal processing. This test does
not establish G2–G5 or exactly-once console output.
