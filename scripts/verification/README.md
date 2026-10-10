# Reading the G1 test

Start with `verifyG1()` in [verify-g1.mjs](verify-g1.mjs). It lists the five
steps in execution order. Its helpers state the assertions for interruption and
resume. [environment.mjs](environment.mjs) contains Docker commands and reads;
[outcomes.mjs](outcomes.mjs) compares source data with observed destinations.
Neither helper starts a test on import.

For a walkthrough without reading code, see the [G1 report guide](../../docs/g1-report.md).
It explains the scenario, required evidence, result counts, cursors, and timing.
The [recovery design](../../G1.md) explains why replay is safe.

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
