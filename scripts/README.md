# Scripts

Run commands from the repository root.

- [demo/run-demo.mjs](demo/run-demo.mjs): `make run` entry point. [demo/demo-workflow.mjs](demo/demo-workflow.mjs) handles infrastructure, seeding, application startup, and incremental traffic.
- [demo/demo-report.mjs](demo/demo-report.mjs): automatic demo outcome checks, counts, and timings.
- [verification/verify-g1.mjs](verification/verify-g1.mjs): `make verify` entry point. The [G1 guide](verification/README.md) explains its checks.
- [logging/](logging/): shared Docker log collection and saved run evidence.

Tests live beside the code they check:

```sh
node --test scripts/demo/*.test.mjs scripts/logging/*.test.mjs scripts/verification/*.test.mjs
```

Docker smoke tests are opt-in: set `TEST_DEMO_RUN=1` for the demo or `TEST_DOCKER_LOGS=1` for logging.
