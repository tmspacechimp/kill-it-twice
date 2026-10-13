# Scripts

Run commands from the repository root.

- [demo/run-demo.mjs](demo/run-demo.mjs): `make run` entry point. [demo/demo-workflow.mjs](demo/demo-workflow.mjs) handles infrastructure, seeding, application startup, and incremental traffic.
- [demo/demo-report.mjs](demo/demo-report.mjs): automatic demo outcome checks, counts, and timings.
- [verification/verify.mjs](verification/verify.mjs): `make verify` entry point, running G1 then G2.
- [verify-g1.mjs](verification/g1/verify-g1.mjs) and [verify-g2.mjs](verification/g2/verify-g2.mjs): each file contains its scenario and command entry point. The [verification guide](verification/README.md) explains their shared helpers and checks.
- [logging/](logging/): shared Docker log collection and saved run evidence.

Tests live beside the code they check:

```sh
node --test scripts/demo/*.test.mjs scripts/logging/*.test.mjs scripts/verification/*.test.mjs scripts/verification/g1/*.test.mjs scripts/verification/g2/*.test.mjs scripts/verification/shared/*.test.mjs
```

Docker smoke tests are opt-in: set `TEST_DEMO_RUN=1` for the demo or `TEST_DOCKER_LOGS=1` for logging.
