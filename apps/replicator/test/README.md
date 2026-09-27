# Reading and running the tests

Start with the test names. Each test reads from top to bottom: **Given** the setup, **When** the action happens, **Then** the expected result. Assertions are in the tests, not hidden inside the fake database or HTTP callbacks.

There are 12 tests:

| File                                           | What to look for                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [initial-load.test.mjs](initial-load.test.mjs) | Nine scenarios: batching, waiting for seed data, unusual IDs, schema/connection/read/commit failures, waiting for processing, and destination failure. |
| [destinations.test.mjs](destinations.test.mjs) | Three scenarios: the indexed document, an indexing rejection, and the event plus broker confirmation.                                                  |
| [load-test-helpers.mjs](load-test-helpers.mjs) | Setup only. It substitutes PostgreSQL responses and captures queries and logs. You do not need to read this first.                                     |

## Read a simple example first

In the connection-error test:

1. `connectionError` describes what PostgreSQL will do.
2. `loader.run()` exercises the real load service.
3. Assertions check the error, one connection attempt, no queries, and client cleanup.

In `setupLoad`, `readResults` lists what successive database reads return. An array is a batch of rows; an Error makes that read fail. For example, `[[], [{ id: 1 }]]` means an empty first check followed by a seeded customer.

The workflow tests exercise the real source reader too, so they verify SQL and transaction boundaries. Only PostgreSQL and logging are replaced. No real database is needed.

The asynchronous tests use named signals: processing or confirmation starts, the test checks that work is paused, then explicitly releases it. There are no arbitrary sleeps in those assertions. Seed-readiness tests still use the application's one-second polling interval.

## Run from the repository root

All 12 tests, including TypeScript compilation:

```sh
npm test --prefix apps/replicator
```

Only workflow tests:

```sh
npm run build --prefix apps/replicator
node --test apps/replicator/test/initial-load.test.mjs
```

Only destination tests:

```sh
npm run build --prefix apps/replicator
node --test apps/replicator/test/destinations.test.mjs
```

A failed assertion prints actual and expected values. These are automated checks with fake external services; the live Docker walkthrough remains a separate manual check.
