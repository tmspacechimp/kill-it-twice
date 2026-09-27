# Kill It Twice

A local initial-load proof of concept: PostgreSQL → NestJS replicator → OpenSearch, then RabbitMQ → independent logging consumer. The implementation does not include incremental sync or the assignment's failure scenarios.

## Read first

- [SPEC.md](SPEC.md): current scope and material implementation choices.
- [AGENTS.md](AGENTS.md): repository working instructions.
- [Original Georgian assignment](docs/optio-assignment-original-ka.md).
- [Faithful English translation](docs/optio-assignment-faithful-en.md).
- [Project brief](docs/project-brief-en.md): broader requirements, not a claim of implemented behavior.

## Current behavior

The replicator waits for seeded customers and reads one repeatable-read, read-only PostgreSQL snapshot in batches of at most 1,000. The first query has no lower ID bound; subsequent queries use `id > lastId`, ordered by ID. Missing or empty data is checked once per second; other source errors fail the process.

For each row, it awaits a PUT to `customers/_doc/<source ID>` in OpenSearch, then publishes a JSON event to RabbitMQ queue `customers.initial-load` and awaits broker confirmation. Both destinations contain all six source fields; timestamps use ISO UTC strings. Each batch finishes before the next source read. After the snapshot completes, the replicator closes its connections and exits.

The independent plain TypeScript consumer connects only to RabbitMQ and logs each complete event. It stays subscribed after the replicator exits. Events look like this (illustrative shape):

```json
{"type":"customer.initial-load","sourceId":1,"record":{"id":1,"full_name":"Customer 1","email":"customer1@example.test","country_code":"GE","status":"active","created_at":"2025-01-01T00:01:00.000Z"}}
```

## Prerequisites

Use Docker with Linux containers, Compose, and GNU Make. The existing Makefile invokes the standalone `docker-compose` command, so that command must be available to Make. The Compose plugin can run the same configuration with `docker compose`. The actual environment used below had standalone Compose 1.29.2 but no Compose plugin.

Allow at least 4 GB of Docker memory. OpenSearch needs `vm.max_map_count >= 262144` on the Docker Linux host/VM; see the [OpenSearch Docker prerequisites](https://docs.opensearch.org/latest/install-and-configure/install-opensearch/docker/).

Copy `.env.example` to `.env` and set both passwords. In PowerShell:

```powershell
Copy-Item .env.example .env
```

Do not overwrite an existing local configuration. Infrastructure host ports come from `.env` and bind to all interfaces. OpenSearch uses unauthenticated HTTP for this local demo. Defaults are PostgreSQL 5432, OpenSearch 9200, RabbitMQ 5672, and RabbitMQ management 15672.

Passwords initialize new PostgreSQL/RabbitMQ volumes only; editing `.env` does not update credentials in existing volumes.

## Run and inspect

From the repository root:

```sh
docker compose up --build
```

With standalone Compose, use `docker-compose up --build`. Add `-d` to run in the background. In another terminal, after infrastructure is healthy:

```sh
make seed
docker-compose logs --no-color --follow replicator consumer
```

Compose waits for the replicator's three infrastructure dependencies and the consumer's RabbitMQ dependency. The consumer does not depend on the replicator or source. On an empty source, the reader should log `Waiting for seeded records in public.customers` before seeding.

For 10,000 seeded rows, expected progress ends with:

```text
Batch 10: rows=1000 firstId=9001 lastId=10000 total=10000
Initial load complete: rows=10000 batches=10
```

These are expected final-pipeline results; the observed validation record below distinguishes what actually ran.

Inspect the same source ID across the three systems:

```sh
docker-compose exec -T postgres psql -X -U source -d client_source -c "SELECT * FROM public.customers WHERE id = 1;"
docker-compose exec -T opensearch curl --fail --silent http://localhost:9200/customers/_doc/1
docker-compose logs --no-color consumer
docker-compose ps -a
```

The OpenSearch response should have `_id: "1"` and matching `_source` fields. Find `"sourceId":1,` in the consumer output and compare its `record`. GET by document ID does not require waiting for the search refresh interval. These inspection commands use container ports, independent of host port overrides.

For a filtered log in PowerShell:

```powershell
docker-compose logs --no-color consumer | Select-String -SimpleMatch '"sourceId":1,'
```

Inspect the queue independently:

```sh
docker-compose exec -T rabbitmq rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers
```

An empty queue while the consumer is running is not proof that every event was logged. To observe queued publications manually, start the replicator with the consumer stopped, wait for completion, inspect the queue, then start the consumer. Rerunning the replicator republishes the snapshot.

After successful completion, expect the replicator to be exited with code 0 and the consumer to remain running. Run a fresh load with `docker-compose start replicator`. To stop and remove containers while retaining data, use `docker-compose down`. No walkthrough step requires deleting existing volumes.

A clean-source walkthrough needs unused volumes. Use a new `COMPOSE_PROJECT_NAME` and unused host ports, consistently for Compose and `make seed`, to preserve existing data. Application image tags remain shared.

## Source seed

`make seed` runs `seed.sql` through psql in the running PostgreSQL service, user `source`, database `client_source`. It can run independently of both applications. It does not start services or reset volumes.

The only table is `public.customers`: `id integer PRIMARY KEY`, plus non-null `full_name text`, `email text`, `country_code text`, `status text`, and `created_at timestamptz`. A fresh source receives 10,000 deterministic customers, IDs 1–10,000. Countries cycle GE/US/DE/GB/FR; odd IDs are active, even IDs inactive. Timestamps are 2025-01-01 UTC plus the ID in minutes.

Schema creation and insertion share a transaction with psql stopping on errors. `ON CONFLICT (id) DO NOTHING` preserves existing values and inserts only missing sample IDs. Existing extra records are preserved. The seed does not migrate an incompatible schema, and neither application writes internal state to PostgreSQL.

On this Windows host, GNU Make is available inside WSL, not PowerShell. The exact seed invocation used was:

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
```

The replicator tests compile TypeScript and use mocked clients to inspect bounded reads, waiting, cleanup, destination errors, JSON fields, and publication confirmation. They are not automated pipeline or failure-gate checks.

For local execution, set the five standard PostgreSQL variables (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`), `OPENSEARCH_URL`, and `RABBITMQ_HOST`, `RABBITMQ_PORT`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD`. Use published host ports. The consumer needs only the RabbitMQ variables. Neither application loads `.env` itself.

```sh
npm start --prefix apps/replicator
npm start --prefix apps/consumer
```

Both Dockerfiles compile TypeScript and ship runtime dependencies as the Node user.

## Actual validation — 2026-09-27

The existing issue #6 implementation was retained, committed, and fast-forward merged into local main before adding destinations. Its live reader-only demonstration succeeded:

```text
docker-compose up --build -d postgres replicator
wsl --cd /mnt/c/work/kill-it-twice --exec make seed
docker-compose logs --no-color replicator
docker-compose ps -a
```

Observed: seed inserted 10,000 rows; the reader logged waiting for seed, ten 1,000-row batches (IDs 1–1000 through 9001–10000), and `Initial load complete: rows=10000 batches=10`. The reader exited 0. This observation predates destination integration.

For the final implementation:

| Command | Actual result |
| --- | --- |
| `npm test --prefix apps/replicator` | TypeScript compiled; 12 tests passed, 0 failed. |
| `npm run build --prefix apps/consumer` | TypeScript compiled successfully. |
| `docker compose up --build -d` | Failed: Compose plugin unavailable (`unknown flag: --build`; `docker compose version` also reported unknown command). |
| `docker-compose up --build -d` | Initially failed with Docker socket connection resets. A later attempt built both application images and started infrastructure and consumer, but hit Compose 1.29.2's `KeyError: 'ContainerConfig'` recreating the exited reader. |
| `docker-compose rm -f replicator` followed by `docker-compose up --build -d` | Removed only the exited replicator container, preserved volumes, and started the integrated application successfully. |
| `wsl --cd /mnt/c/work/kill-it-twice --exec make seed` | On the reused source: `INSERT 0 0`, total 10,000; printed the first five source rows. |
| `docker-compose logs --no-color --tail=6 replicator consumer` | Replicator started; consumer logged complete events for source IDs 2–7. |

One observed source row from the seed output:

```text
2 | Customer 2 | customer2@example.test | US | inactive | 2025-01-01 00:02:00+00
```

The corresponding observed consumer log:

```text
Received event {"type":"customer.initial-load","sourceId":2,"record":{"id":2,"full_name":"Customer 2","email":"customer2@example.test","country_code":"US","status":"inactive","created_at":"2025-01-01T00:02:00.000Z"}}
```

Subsequent source/document/log inspection commands from the walkthrough failed while Compose fetched the Docker server API version: `ConnectionResetError(104, 'Connection reset by peer')` and `ConnectionRefusedError(111, 'Connection refused')`. No OpenSearch document response or final integrated completion was captured.

The host's Docker commands are WSL wrappers. Diagnostics reported a failed systemd Docker service (an existing PID prevented startup) and intermittently `Cannot connect to the Docker daemon at unix:///var/run/docker.sock`. The root cause of the repeated daemon unavailability was not established or changed.

A final isolated walkthrough attempt used `wsl --cd /mnt/c/work/kill-it-twice --exec sh -lc` with `COMPOSE_PROJECT_NAME=kill-it-twice-v0-walkthrough` and ports 25432/29200/25673/25674. Its initial `docker version` failed to connect, so it stopped before creating resources or seeding. A complete clean-start run, matching OpenSearch GET, and final integrated completion remain **unverified due to Docker availability**. Restore Docker access and repeat the walkthrough above.

## Limitations

This is a sequential initial-load POC, not a throughput benchmark. The long-lived read snapshot can delay PostgreSQL cleanup. Later source changes are outside it; restarting loads the snapshot again, overwrites same-ID documents, and can emit duplicate events. Stale destination documents are not deleted.

Indexing and publication are separate operations. The queue and events are non-durable/non-persistent; the consumer uses automatic acknowledgement, so an event may be lost before logging. Broker confirmation is not evidence of consumer logging or atomic delivery to both destinations.

There is no incremental sync, checkpoint, retry/reconnect policy, DLQ, receipt storage, UI, recovery mechanism, or failure-gate claim. Empty-source readiness polling and infrastructure health checks are not delivery guarantees. No `make verify` or automated outcome gate is provided.
