# Detailed usage and development

For a quick start, see the [README](../README.md). The [specification](../SPEC.md) defines the source contract and implementation boundaries; [validation history](validation-history.md) records observed runs.

## Current application behavior (shipments)

The replicator waits for seeded shipment events and reads one repeatable-read, read-only PostgreSQL snapshot in batches of at most 1,000. The first query has no lower ID bound; subsequent queries use `id > lastId`, ordered by ID. Missing or empty data is checked once per second; other source errors fail the process.

For each row, it awaits a versioned PUT to `shipments/_doc/<shipment ID>` in OpenSearch, then publishes a JSON event to RabbitMQ queue `shipments.initial-load` and awaits broker confirmation. Every event is published, including older or replayed versions. Only a higher shipment version replaces the OpenSearch document; recognized version conflicts continue to publication, while other errors stop the load. Both destinations contain all five event fields; timestamps use ISO UTC strings. Each batch finishes before the next source read. After the snapshot completes, the replicator closes its connections and exits.

The independent plain TypeScript consumer connects only to RabbitMQ and logs each complete event. It stays subscribed after the replicator exits. Events look like this (illustrative shape):

```json
{"type":"shipment.status","sourceId":3,"record":{"id":3,"shipment_id":1,"version":3,"status":"delivered","occurred_at":"2025-01-01T00:03:00.000Z"}}
```

## Prerequisites

Use Docker with Linux containers, Compose, and GNU Make. The existing Makefile invokes the standalone `docker-compose` command, so that command must be available to Make. The Compose plugin can run the same configuration with `docker compose`. The recorded runs used standalone Compose 1.29.2.

Allow at least 4 GB of Docker memory. OpenSearch needs `vm.max_map_count >= 262144` on the Docker Linux host/VM; see the [OpenSearch Docker prerequisites](https://docs.opensearch.org/latest/install-and-configure/install-opensearch/docker/).

Copy `.env.example` to `.env` and set both passwords. In PowerShell:

```powershell
Copy-Item .env.example .env
```

Do not overwrite an existing local configuration. Infrastructure host ports come from `.env` and bind to all interfaces. OpenSearch uses unauthenticated HTTP for this local demo. Defaults are PostgreSQL 5432, OpenSearch 9200, RabbitMQ 5672, and RabbitMQ management 15672.

Passwords initialize new PostgreSQL/RabbitMQ volumes only; editing `.env` does not update credentials in existing volumes.

## Run and inspect shipments

The following is the shipment workflow. Expected results for a fresh seed are 10,000 published events and 4,000 shipment documents. The [validation history](validation-history.md) records a successful run.

From the repository root:

```sh
docker-compose up --build
```

With the Compose plugin, the equivalent startup command is `docker compose up --build`; the seed target still requires standalone `docker-compose`. Add `-d` to run in the background. In another terminal, after infrastructure is healthy:

```sh
make seed
docker-compose logs --no-color --follow replicator consumer
```

Compose waits for the replicator's three infrastructure dependencies and the consumer's RabbitMQ dependency. The consumer does not depend on the replicator or source. On an empty source, the reader should log `Waiting for seeded records in public.shipment_status_events` before seeding.

For 10,000 seeded rows, expected progress ends with:

```text
Batch 10: rows=1000 firstId=9001 lastId=10000 total=10000
Initial load complete: rows=10000 batches=10
```

The [shipment validation](validation-history.md#shipment-validation--2026-09-28) produced these completion logs.

Inspect shipment 1 and its latest event (ID 3) across the three systems:

```sh
docker-compose exec -T postgres psql -X -U source -d client_source -c "SELECT * FROM public.shipment_status_events WHERE shipment_id = 1 ORDER BY version;"
docker-compose exec -T opensearch curl --fail --silent http://localhost:9200/shipments/_doc/1
docker-compose logs --no-color consumer
docker-compose ps -a
```

The OpenSearch response should have `_id: "1"` with event ID 3, version 3, and status `delivered`. The index should contain 4,000 documents after refresh, while consumer logs should contain 10,000 events. Find `"sourceId":3,` in the consumer output and compare its `record`. GET by document ID does not require waiting for the search refresh interval. These inspection commands use container ports, independent of host port overrides.

For a filtered log in PowerShell:

```powershell
docker-compose logs --no-color consumer | Select-String -SimpleMatch '"sourceId":3,'
```

Inspect the queue independently:

```sh
docker-compose exec -T rabbitmq rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers
```

An empty queue while the consumer is running is not proof that every event was logged. To observe queued publications manually, start the replicator with the consumer stopped, wait for completion, inspect the queue, then start the consumer. Rerunning the replicator republishes the snapshot.

After successful completion, expect the replicator to be exited with code 0 and the consumer to remain running. Run a fresh load with `docker-compose start replicator`. To stop and remove containers while retaining data, use `docker-compose down`. No walkthrough step requires deleting existing volumes.

A clean-source walkthrough needs unused volumes. Use a new `COMPOSE_PROJECT_NAME` and unused host ports, consistently for Compose and `make seed`, to preserve existing data. Application image tags remain shared.

## Source seed

`make seed` builds and runs the independent TypeScript source-writer CLI against the running PostgreSQL service, user `source`, database `client_source`. Its Compose service is behind the `seed` profile, so normal startup does not seed automatically. The disposable writer runs with `--no-deps` and does not start PostgreSQL, the replicator, or the consumer, or reset volumes.

Use `make seed SEED_ARGS="--shipments 3"` for a smaller initial fixture (eight events). Counts must be positive integers whose generated IDs fit PostgreSQL integer columns. Runs always start at shipment/event ID 1; smaller counts retain existing data, and larger counts add missing initial histories. There are no commands for later transitions or timed generation.

The seed creates only `public.shipment_status_events`:

| Column | Type and constraints |
| --- | --- |
| `id` | `integer PRIMARY KEY` |
| `shipment_id` | `integer NOT NULL` |
| `version` | `integer NOT NULL CHECK (version > 0)` |
| `status` | `text NOT NULL CHECK (status IN ('created', 'in_transit', 'delivered', 'cancelled'))` |
| `occurred_at` | `timestamptz NOT NULL` |

`UNIQUE (shipment_id, version)` prevents duplicate shipment versions. Writers append events rather than updating or deleting history; this convention is not enforced by mutation triggers or a transition state machine. Event IDs identify events, while versions order each shipment's history. IDs do not guarantee commit order or safe incremental discovery.

A fresh source receives 10,000 deterministic events for 4,000 shipments. Odd shipment IDs have versions 1–3: created → in_transit → delivered. Even IDs have versions 1–2: created → cancelled. Status totals are 4,000 created and 2,000 each of in_transit, delivered, and cancelled. The pure, lazy generator assigns sequential event IDs in shipment ID and version order. Timestamps are `2025-01-01 00:00:00+00` plus event ID in minutes. The seed prints event and shipment counts and the first ten events, including several complete histories.

Schema creation and insertion share a transaction; the writer awaits parameterized inserts of at most 1,000 events and rolls back on errors without retrying. Targeted `ON CONFLICT (id) DO NOTHING` preserves existing values and inserts only missing sample IDs. Extra events and any existing customer table remain untouched. A distinct ID claiming an existing shipment/version fails and rolls back the seed; unrelated schema or constraint errors also abort. The seed does not migrate an incompatible schema, and neither application writes internal state to PostgreSQL.

For a fresh PostgreSQL-only check, run from a WSL shell at the repository root with `.env` configured. Choose an unused project name and PostgreSQL host port, preserving existing volumes:

```sh
export COMPOSE_PROJECT_NAME=issue19-seed-check
export POSTGRES_PORT=25433
docker-compose up -d postgres
docker-compose exec -T postgres pg_isready -U source -d client_source
# Wait for pg_isready to report accepting connections before continuing.
make seed
```

Only PostgreSQL is started. A fresh run should report `Seed complete: inserted=10000`, 10,000 events, and 4,000 shipments; an unchanged rerun should report `Seed complete: inserted=0`. The shipment reader consumes this fixture on its next initial load.

On this Windows host, GNU Make is available inside WSL, not PowerShell. For the default project, a PowerShell invocation is:

```powershell
wsl --cd /mnt/c/work/kill-it-twice --exec make seed
```

## Local development

Use Node.js 24 and npm:

```sh
npm ci --prefix apps/replicator
npm test --prefix apps/replicator
npm ci --prefix apps/consumer
npm run build --prefix apps/consumer
npm ci --prefix apps/source-writer
npm test --prefix apps/source-writer
```

The source-writer tests check deterministic histories without PostgreSQL and use a fake query client to check bounded inserts and transaction handling. They do not check replication or failure gates. For local seeding, set the standard PostgreSQL environment variables and run `npm start --prefix apps/source-writer -- --shipments 4000`; use `--help` for usage. The CLI does not load `.env` itself.

See the [test reading guide](../apps/replicator/test/README.md) for the 14 scenarios and commands for running individual test files.

The replicator tests compile TypeScript and use mocked clients to inspect bounded reads, waiting, cleanup, destination errors, JSON fields, and publication confirmation. They are not automated pipeline or failure-gate checks.

For local execution, set the five standard PostgreSQL variables (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`), `OPENSEARCH_URL`, and `RABBITMQ_HOST`, `RABBITMQ_PORT`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD`. Use published host ports. The consumer needs only the RabbitMQ variables. Neither application loads `.env` itself.

```sh
npm start --prefix apps/replicator
npm start --prefix apps/consumer
```

The replicator build runs format:check, lint, and typecheck before compiling; any failed check stops the build. This also applies to its Docker build. The consumer keeps its TypeScript-only build.

All application Dockerfiles compile TypeScript and ship runtime dependencies as the Node user.

## Limitations

This is a sequential initial-load POC, not a throughput benchmark. The long-lived read snapshot can delay PostgreSQL cleanup. Later source changes are outside it; restarting loads the snapshot again, retains the highest shipment versions, and can emit duplicate events. Stale destination documents are not deleted.

Indexing and publication are separate operations. The queue and events are non-durable/non-persistent; the consumer uses automatic acknowledgement, so an event may be lost before logging. Broker confirmation is not evidence of consumer logging or atomic delivery to both destinations.

There is no incremental sync, checkpoint, retry/reconnect policy, DLQ, receipt storage, UI, recovery mechanism, or failure-gate claim. Empty-source readiness polling and infrastructure health checks are not delivery guarantees. No `make verify` or automated outcome gate is provided.
