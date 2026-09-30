# Reading and running the tests

The tests exercise the real reader and load services with PostgreSQL, HTTP,
and RabbitMQ clients replaced by fakes. Assertions belong in the tests; shared
setup only supplies rows and records calls.

| File                                           | Coverage                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [initial-load.test.mjs](initial-load.test.mjs) | Five tests: bounded startup reads, unusual IDs, empty startup, missing table, and connection failure.                                                                                                                                                 |
| [incremental.test.mjs](incremental.test.mjs)   | Eight tests: waiting through startup empties, concurrent processing, stopping before initial completion, empty-counter reset, empty startup polling, sibling cancellation, shutdown, and configuration. Some tests cover multiple related conditions. |
| [destinations.test.mjs](destinations.test.mjs) | Five tests: versioned indexing, indexing rejection, broker confirmation, older/replayed events, and unrelated conflicts.                                                                                                                              |
| [load-test-helpers.mjs](load-test-helpers.mjs) | Fake PostgreSQL responses for two independent connections, plus captured reads and logs.                                                                                                                                                              |

The concurrency test deliberately blocks one initial event. It verifies that
an incremental event finishes and polling stops while the initial event is
still blocked. Only then does it release the initial reader. This checks actual
overlap without depending on arbitrary sleep durations.

The checkpoint tests use temporary SQLite files to verify restart cursors,
completion, failed processing and checkpoint writes, and corrupt-file rejection.
The reader tests also use isolated temporary checkpoint files.

Run all 21 tests, including formatting, lint, typecheck, and compilation:

```sh
npm test --prefix apps/replicator
```

Run only the incremental tests after building:

```sh
npm run build --prefix apps/replicator
node --test apps/replicator/test/incremental.test.mjs
```

These tests establish the specified startup boundary and finite polling flow
with fake services and real checkpoint storage. They do not establish
concurrent-writer safety or the assignment's failure gates. `make verify` runs
the separate G1 check against real Docker services and an actual SIGKILL.
