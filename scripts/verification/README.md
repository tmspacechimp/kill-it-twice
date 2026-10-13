# Verification scenarios

Start with `verifyG1()` in [verify-g1.mjs](g1/verify-g1.mjs) or `verifyG2()` in
[verify-g2.mjs](g2/verify-g2.mjs). Each file contains its command entry point and
six numbered steps: setup, crash, restart, completion, destination comparisons,
and history replay checks. G2 repeats the crash step for its schedule and can
target either reader.

## Organization

```text
verification/
  verify.mjs              Run G1, then G2
  g1/verify-g1.mjs         Single-crash scenario
  g2/verify-g2.mjs         Scheduled-crash scenario
  shared/
    configuration.mjs     Defaults, overrides, and crash target validation
    environment.mjs       Docker commands, bounded reads, and waits
    run-scenario.mjs      Evidence, failure status, signals, and cleanup
    scenario-checks.mjs   Cursor, delivery, replay, and shipment checks
    outcomes.mjs          Source and destination payload comparisons
    scenario-fixture.mjs  Deterministic test environment
```

Tests live beside the code they check. Shared helpers keep the scenario steps
focused on what happens and what evidence must pass.

## Running and configuring

Use Node.js 24 and Docker Compose from the repository root:

```sh
make verify       # G1, then G2; failure of either makes the command fail
make verify-g1    # G1 only
make verify-g2    # G2 only
```

On Windows/WSL add `NODE=node.exe`. The combined command runs both scenarios
even if G1 fails; interruption stops the combined run. Each scenario has its own
random Compose project, volumes, and image names, without published ports.
Cleanup removes only that project's containers and volumes, including on failure.

Configure [.env.verify](../../.env.verify). `DEFAULT_SEED_SHIPMENTS` and
`DEFAULT_WAIT_TIMEOUT_MS` supply shared defaults; each scenario can override its
seed, wait timeout, incremental batch size, and crash targets independently.
Exported variables take precedence. The [G1 report guide](../../docs/g1-report.md)
and [G2 case guide](../../docs/g2-verification.md) explain settings and saved
evidence. The [Make command guide](../../docs/make-commands.md) covers the other
commands.

For fast checks without Docker:

```sh
node --test scripts/verification/*.test.mjs scripts/verification/g1/*.test.mjs scripts/verification/g2/*.test.mjs scripts/verification/shared/*.test.mjs
```

The tests feed missing events, duplicate IDs, incorrect payloads, stale cursors,
failed crashes, and extra shipment documents to the checks. The deterministic
fixture tests sequence advancement and traffic placement; it does not establish
actual process-crash recovery.

Both scenarios use `CrashInjectingPublisherService`: confirm publication, then
SIGKILL before the caller checkpoints. [G1.md](../../G1.md) and
[G2.md](../../G2.md) explain the recovery proofs and their limits.
