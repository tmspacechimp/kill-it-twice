# Validation history

## Delayed incremental startup — 2026-09-29

The empty-poll limit now activates only after the first incremental rows arrive.
Startup empty reads wait at the configured interval without increasing the
counter, including after initial loading finishes. This supersedes the earlier
same-day rule that counted empty reads immediately.

`npm test --prefix apps/replicator` passed all 18 tests, with formatting, lint,
typechecking, and compilation. The regression supplies five startup empty
reads with a limit of three, then a new row, then three empty reads; only the
last three count toward stopping. Existing tests cover counter resets and
shutdown while waiting. `git diff --check` passed. No Docker run was performed.

Updated the incremental service, initial/incremental tests and test guide,
SPEC, AGENTS, README, development documentation, and the environment comment.

## Startup boundary and finite concurrent polling — 2026-09-29

The operating rule now captures the startup maximum event ID, loads rows up to
that boundary, and polls above it concurrently on a separate read-only
connection. Polling stops after three consecutive empty reads by default;
nonempty reads reset the count. Initial loading finishes independently.

`npm test --prefix apps/replicator` passed all 17 tests, including formatting,
lint, typechecking, and compilation. The concurrency test holds an initial
event open until an incremental event is processed and polling has stopped,
then verifies that connections remain open until the initial load finishes.
Other checks cover the fixed upper bound, negative/zero/sparse IDs, empty
startup, missing table, counter resets, sibling cancellation, and shutdown.

`git diff --check` passed. `git rm -r --cached --ignore-unmatch -- .air` removed
editor state from the index; `git ls-files .air` returned no files. Local files
were retained, and `git check-ignore` confirmed they are ignored.

Changed implementation files: `shipment-source.service.ts`,
`initial-load.service.ts`, `main.ts`, `shipment-event.ts`, the publisher's
concurrency comment, and new `replication.service.ts`,
`incremental-load.service.ts`, and `polling-options.ts`. Updated the reader
tests, their helper and guide, Compose/environment settings, SPEC, README,
development instructions, AGENTS, and the root Git ignore rules.

No Docker rebuild or live pipeline run was performed for this revision. These
are focused checks with mocked external services, not failure-gate evidence.
The older records below describe earlier operating rules.

## Paced source generation — 2026-09-28

The source writer now exposes initial seeding and paced generation as its two
primary workflows; manual append remains a secondary option.

- `npm test --prefix apps/source-writer`: 17 passed, 0 failed, including exact
  event counts, lazy histories, pacing with slow writes, cancellation, failure
  handling, and argument validation before connection.
- `wsl --cd /mnt/c/work/kill-it-twice --exec make generate COUNT=500 RATE=20`:
  exited 0 and printed `Generation complete: inserted=500`. Make built the
  source-writer image and ran it against existing PostgreSQL with `--no-deps`.
- The 500 committed events had IDs 10003 through 10502 and shipment IDs 4002
  through 4168 (167 shipments). The first timestamp was
  `2026-09-28T18:57:08.739Z`; the last was `2026-09-28T18:57:33.711Z`, a span of
  24.972 seconds. The final shipment had version 2 / `in_transit`, as expected
  for a partial last history. These demo rows remain in the source.

This is a local happy-path observation, not a throughput or failure-gate claim.

## Incremental shipment validation — 2026-09-28 (issue #21)

The existing local project began with 10,000 events for 4,000 shipments. Built
only the source-writer and replicator, preserving the running infrastructure
and its volumes. Commands and actual results:

- `npm test --prefix apps/source-writer`: 12 passed, 0 failed.
- `npm test --prefix apps/replicator`: 19 passed, 0 failed; formatting, lint,
  typecheck, and compilation passed. Existing CRLF files were normalized to
  match the workspace's LF formatting setting. Node tests required execution
  outside the Windows sandbox because subprocess creation returned `EPERM`.
- `docker-compose build replicator source-writer`: both images built.
- `docker-compose up -d --no-deps replicator`: Compose 1.29.2 failed with
  `ContainerConfig`; `docker compose up -d --no-deps replicator` succeeded
  with Compose v2.40.3. Only the replicator container was recreated.
- The replicator completed 10 batches / 10,000 rows and logged
  `Polling for shipment events: intervalMs=1000 afterId=10000`.

Then ran these two commands serially after initial completion:

```sh
docker-compose run --rm --no-deps -T source-writer append 4001 created
docker-compose run --rm --no-deps -T source-writer append 4001 in_transit
docker compose logs --no-color --tail=4 replicator
docker-compose logs --no-color --tail=10 consumer
docker-compose exec -T postgres psql -X -U source -d client_source -c "SELECT * FROM public.shipment_status_events WHERE shipment_id = 4001 ORDER BY version;"
docker-compose exec -T opensearch curl --fail --silent http://localhost:9200/shipments/_doc/4001
docker compose ps replicator
```

Observed source rows and matching consumer events:

| Event ID | Shipment | Version | Status | Timestamp (UTC) |
| --- | --- | --- | --- | --- |
| 10001 | 4001 | 1 | created | 2026-09-28T17:48:11.135Z |
| 10002 | 4001 | 2 | in_transit | 2026-09-28T17:48:14.226Z |

The replicator logged two incremental batches of one row each. Both full
`shipment.status` events appeared in consumer logs. OpenSearch returned one
document, `_id: "4001"`, `_version: 2`, with event 10002 and status
`in_transit`. The replicator remained Up. The two appended demo rows remain
in the source; no history or volumes were deleted.

This validates the serial happy path only. It does not establish concurrent
capture, restart recovery, durable delivery, or any assignment failure gate.

## Dashboards inspection (issue #22) - 2026-09-28

The first startup attempt with Dashboards 3.3.2 failed with `manifest unknown`. Registry checks confirmed matching OpenSearch and Dashboards 3.4.0 images; Compose now pins both to that version. Validation used fresh project `issue22-dashboards-check`, preserving existing projects and volumes. From a WSL shell at the repository root:

```sh
export COMPOSE_PROJECT_NAME=issue22-dashboards-check
export POSTGRES_PORT=35432 OPENSEARCH_PORT=39200
export RABBITMQ_PORT=35672 RABBITMQ_MANAGEMENT_PORT=35674
export DASHBOARDS_PORT=5601
docker-compose config --quiet
docker-compose up -d postgres opensearch rabbitmq consumer dashboards
docker-compose build source-writer
docker-compose up -d postgres
docker-compose run --rm --no-deps -T source-writer --shipments 3
docker-compose up -d --no-build --no-recreate replicator consumer
```

Compose configuration validation passed, including an alternate `DASHBOARDS_PORT=15601`; the default resolved to host port 5601. Source-writer build passed and seeding inserted eight events for three shipments. Concurrent issue #21 work rebuilt the shared replicator image before container creation; the actual running image was `sha256:ea0d82f4ebb957e3676744ce576bdef12773d2df7f24f08a14d329a57fbcbaa7`. Logs showed `Initial load complete: rows=8 batches=1`, followed by incremental polling. No incremental events were appended for this check.

```sh
docker-compose logs --tail=10 replicator
docker-compose exec -T opensearch curl --fail --silent http://localhost:9200/shipments/_doc/1
docker-compose exec -T opensearch curl --fail --silent http://localhost:9200/shipments/_count
```

OpenSearch returned three shipment documents. Shipment 1 had event ID 3, version 3, status `delivered`, and timestamp `2025-01-01T00:03:00.000Z`.

The browser opened [Dashboards](http://localhost:5601) without a login. Through Dashboards Management, a `shipments` index pattern was created with **I don't want to use the time filter**. In Discover, the query `shipment_id: 1` returned **Result (1/1)**. Expanding the result showed `id: 3`, `shipment_id: 1`, `version: 3`, and `status: delivered`, matching OpenSearch. The timestamp displayed as January 1, 2025 at 04:03 in the browser's UTC+4 timezone. The UI and isolated project were left running for inspection. Existing-volume upgrades were not tested.

This is an inspection-tool check, not evidence for the assignment's failure gates or its full operator UI.

Issue #17 replaced the customer fixture and pipeline with append-only shipment status events. The current reader uses shipment events, OpenSearch keeps the highest version per shipment, and RabbitMQ carries individual events. Existing customer tables, index, and queue were left untouched.

The dated records below preserve the observed results for each version. Customer commands describe the old implementation and cannot reproduce that run with the current code.

## Shipment validation — 2026-09-28

The expanded shipment pipeline was built and run in WSL with Docker Engine 29.1.3 under isolated project `issue17-shipment-check`, preserving existing projects and volumes. Commands used:

```sh
export COMPOSE_PROJECT_NAME=issue17-shipment-check
export POSTGRES_PORT=25433 OPENSEARCH_PORT=29201
export RABBITMQ_PORT=25675 RABBITMQ_MANAGEMENT_PORT=25676
docker-compose up --build -d
docker-compose exec -T postgres pg_isready -U source -d client_source
make seed
docker wait issue17-shipment-check_replicator_1
```

Observed results:

| Check | Actual result |
| --- | --- |
| Fresh seed | Only the shipment sample table; 10,000 events, 4,000 shipments, 10,000 distinct IDs spanning 1–10,000. |
| Histories and timestamps | All histories matched the odd/even sequences; status counts were 4,000/2,000/2,000/2,000; zero timestamp deviations. |
| Seed rerun | `make seed` inserted zero rows; count and digest over all five fields were unchanged. |
| SQL constraints | All ten invalid insert cases were rejected: duplicate ID, duplicate shipment/version, zero/negative version, invalid status, and each NULL field. No changes persisted. |
| Preservation and rollback | Extra event and sentinel customer survived reruns. A conflicting shipment/version aborted the seed without restoring missing ID 1. These mutation cases used a separate `seed_checks` database in the isolated PostgreSQL instance. |
| Replicator | Ten 1,000-event batches; completion with 10,000 rows; exit 0. |
| OpenSearch | All 4,000 documents checked for shipment identity, latest event ID, version, and status. |
| Consumer | Exactly 10,000 received events, covering every fixture event ID with type `shipment.status`. |
| Real ordering and replay | A separate four-event source was loaded twice. Shipment 4001 received versions 3, 1, 2 in event-ID order and retained version 3. All eight events, including the existing shipment 1/version 3 replay, were logged. |
| Local checks | Replicator formatting, lint, typecheck, compilation, and all 14 mocked tests passed; consumer compilation and `git diff --check` passed. |

The ordering fixture used database `shipment_order_check`, with event IDs -1, 0, 1 for shipment 4001 versions 3, 1, 2, plus the existing event 3 for shipment 1/version 3. It ran twice via `docker-compose run --rm --no-deps -e PGDATABASE=shipment_order_check replicator`. After these checks, the index contained one additional shipment and the consumer had logged 10,008 events. The isolated project was stopped with `docker-compose stop`; its volumes and logs were retained. Application image tags are shared and were rebuilt by this run.

These checks demonstrate the shipment initial-load path and version projection, not incremental discovery, recovery, or the assignment's failure gates.

## Historical customer validation — 2026-09-27

This evidence predates issue #17 and used the former customer seed. It is not shipment seed validation, and the commands below no longer reproduce this customer run on fresh volumes with the current seed. Results are retained as history.

The complete integrated v0 path was run from fresh volumes using Docker Engine 29.1.3 and standalone Compose 1.29.2 in WSL. Project `v0-verified` used separate host ports; the existing project's data was preserved.

Run the following in a WSL shell from the repository root. These are the commands used for the successful run:

```sh
export COMPOSE_PROJECT_NAME=v0-verified
export POSTGRES_PORT=25432 OPENSEARCH_PORT=29200
export RABBITMQ_PORT=25673 RABBITMQ_MANAGEMENT_PORT=25674
docker-compose up --build -d
make seed
timeout 240 docker wait v0-verified_replicator_1
docker-compose logs --no-color --tail=12 replicator
docker-compose ps -a
```

The project now exists. Choose a new project name and unused ports for another fresh-volume run; update the container name in `docker wait` accordingly. Do not delete existing volumes just to repeat the demonstration.

Observed results:

| Check | Actual result |
| --- | --- |
| Image builds | Both applications compiled and their Docker images built successfully. |
| Seed | `INSERT 0 10000`; total 10,000 customers. |
| Replicator | Ten 1,000-row batches, IDs 1–1000 through 9001–10000; `Initial load complete: rows=10000 batches=10`; exit 0. |
| OpenSearch | `customers/_count` returned 10,000, with no failed shards. |
| Consumer | 10,000 `Received event` log lines; remained running after the replicator exited. |
| Sample comparison | IDs 1, 1000, 1001, and 10000 matched across source rows, document bodies, and event records, including timestamps. |
| Queue | `customers.initial-load`: 0 ready, 0 unacknowledged, 1 consumer. |
| Source tables | Only `public.customers` was present in the public schema. |
| Focused tests | `npm test --prefix apps/replicator`: 12 passed, 0 failed. |
| Consumer build | `npm run build --prefix apps/consumer`: passed. |

The integrated load logged startup at 11:59:53 UTC and completion at 12:01:44 UTC. This is an observation of this local run, not a capacity benchmark.

With the same exported environment, the manual inspection commands were:

```sh
docker-compose exec -T postgres psql -X -U source -d client_source -c "SELECT * FROM public.customers WHERE id IN (1,1000,1001,10000) ORDER BY id;"
docker-compose exec -T postgres psql -X -U source -d client_source -c "SELECT count(*), count(DISTINCT id), min(id), max(id) FROM public.customers;"
docker-compose exec -T postgres psql -X -U source -d client_source -c '\dt public.*'
docker-compose exec -T opensearch curl --fail --silent http://localhost:9200/customers/_doc/1
docker-compose exec -T opensearch curl --fail --silent http://localhost:9200/customers/_doc/1000
docker-compose exec -T opensearch curl --fail --silent http://localhost:9200/customers/_doc/1001
docker-compose exec -T opensearch curl --fail --silent http://localhost:9200/customers/_doc/10000
docker-compose exec -T opensearch curl --fail --silent http://localhost:9200/customers/_count
docker-compose logs --no-color consumer | grep -E '"sourceId":(1|1000|1001|10000),'
docker-compose logs --no-color consumer | grep -c 'Received event '
docker-compose exec -T rabbitmq rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers
```

Source row 10000 was:

```text
10000 | Customer 10000 | customer10000@example.test | FR | inactive | 2025-01-07 22:40:00+00
```

Its OpenSearch response included `"_id":"10000"`, `"found":true`, and this `_source`:

```json
{"id":10000,"full_name":"Customer 10000","email":"customer10000@example.test","country_code":"FR","status":"inactive","created_at":"2025-01-07T22:40:00.000Z"}
```

The corresponding consumer output was:

```text
Received event {"type":"customer.initial-load","sourceId":10000,"record":{"id":10000,"full_name":"Customer 10000","email":"customer10000@example.test","country_code":"FR","status":"inactive","created_at":"2025-01-07T22:40:00.000Z"}}
```

No application change was needed after code review and this run. This evidence verifies the v0 happy path and sampled field equality; it does not establish the assignment's failure scenarios.
