# Issue #19: initial source-writer CLI

1. Add an independent TypeScript CLI with a pure lazy generator. Default to the
   existing 4,000-shipment fixture; accept `--shipments N` for initial dataset size.
2. Insert at most 1,000 events per parameterized query. Keep schema creation and
   all inserts in one transaction, preserving insert-only reruns and rollback on
   shipment/version conflicts. Close the connection on success or failure.
3. Replace the SQL seed with a manually invoked Compose service behind a profile.
   `make seed` builds/runs it without starting dependencies or resetting data.
4. Test generation independently of PostgreSQL; test bounded writes and rollback
   using a fake query client. Update the specification and usage documentation.
5. Run the source-writer build/tests and check Compose configuration. If available,
   smoke-test initial seeding and reruns against isolated PostgreSQL only.

No linked development branch was reported by `gh issue develop 19 --list`.
Existing uncommitted changes must be preserved. This task adds no incremental
commands, timed generation, pipeline changes, or failure-gate claims.

## Completed validation

- `npm install --prefix apps/source-writer --ignore-scripts`: installed 18 packages,
  generated the lockfile, reported zero vulnerabilities. Offline installation had
  failed because the cache was incomplete.
- `npm test --prefix apps/source-writer`: TypeScript build and all seven tests
  passed. The sandbox blocked test subprocesses; the permitted rerun passed.
- `docker-compose config --services`: accepted the updated configuration.
- `docker-compose build source-writer`: built successfully, including `npm ci`
  and TypeScript compilation inside the image.
- `docker-compose run --rm --no-deps -T source-writer --help`: exited successfully
  and printed usage.
- Local CLI `--help` succeeded; `--shipments 0` failed with exit code 1 before
  connecting.
- Started disposable `postgres:17` container `issue19-source-writer-check` on
  port 25439. Ran the built CLI twice with standard PG environment variables:
  first inserted 10,000 events for 4,000 shipments; second inserted zero and
  retained those counts. Stopped the auto-removing container afterward.
- `git diff --check` and `git diff --cached --check`: passed.

The full `make seed` target was not invoked against the existing project database;
its build and Compose entry point were checked separately, and real writes were
checked only against isolated PostgreSQL. No pipeline or failure-gate claim.
