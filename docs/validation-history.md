# Validation history

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
