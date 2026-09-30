# Detailed usage and development

For a quick start, see the [README](../README.md). The [specification](../SPEC.md) defines the source contract and implementation boundaries; [validation history](validation-history.md) records observed runs.

## Current application behavior (shipments)

The replicator reads the maximum event ID on its first startup and persists that boundary. Restarts reuse the boundary and resume the saved initial and incremental cursors. Existing rows through that boundary form the initial load. A separate read-only connection immediately polls for greater IDs while initial loading is in progress. Both readers use batches of at most 1,000, ordered by ID. An empty table means zero initial rows; a missing table fails with instructions to seed first. The single serial, append-only writer assumption makes the ID boundary valid without a long-lived snapshot transaction.

For each row, each reader awaits a versioned PUT to `shipments/_doc/<shipment ID>` in OpenSearch, then publishes a JSON event to RabbitMQ queue `shipments.initial-load` and awaits broker confirmation. Every event is published, including older or replayed versions. Only a higher shipment version replaces the OpenSearch document; recognized version conflicts continue to publication, while other errors stop processing. Both destinations contain all five event fields; timestamps use ISO UTC strings. The readers can interleave events, so consumer logs need not be in event-ID or shipment-version order.

Polling waits indefinitely for the first incremental rows; startup empty reads do not count. After the first nonempty incremental batch, polling stops after `POLL_MAX_EMPTY` consecutive empty reads (default 3); any later nonempty batch resets the counter. Full batches drain immediately; empty or partial batches wait `POLL_INTERVAL_MS` (default 1000), except after the final empty read. The first poll is immediate. If no incremental rows arrive, polling stays alive until shutdown or error, even after initial loading finishes. Polling may stop before initial loading finishes, and does not restart automatically. The process exits after both readers finish. SIGINT/SIGTERM stop between records and interrupt waits; failures cancel the sibling reader before cleanup.

The independent plain TypeScript consumer connects to RabbitMQ and owns a separate SQLite receipt database. It logs each new event in full and logs `Duplicate event received: sourceId=<ID>; skipping` for repeated IDs. It manually acknowledges after the receipt commits and the log call returns. It stays subscribed after the replicator exits. Events look like this (illustrative shape):

```json
{"type":"shipment.status","sourceId":3,"record":{"id":3,"shipment_id":1,"version":3,"status":"delivered","occurred_at":"2025-01-01T00:03:00.000Z"}}
```

## Prerequisites

Use Docker with Linux containers, Compose v2 (`docker compose`), and GNU Make. Run Make from WSL on Windows. `make help` lists the demo commands. The Makefile uses Compose v2 for health-aware startup.

Allow at least 4 GB of Docker memory. OpenSearch needs `vm.max_map_count >= 262144` on the Docker Linux host/VM; see the [OpenSearch Docker prerequisites](https://docs.opensearch.org/latest/install-and-configure/install-opensearch/docker/).

Copy `.env.example` to `.env` and set both passwords. In PowerShell:

```powershell
wsl --exec make init
```

Do not overwrite an existing local configuration. Infrastructure host ports come from `.env` and bind to all interfaces. OpenSearch uses unauthenticated HTTP for this local demo. Defaults are PostgreSQL 5432, OpenSearch 9200, RabbitMQ 5672, and RabbitMQ management 15672.

Passwords initialize new PostgreSQL/RabbitMQ volumes only; editing `.env` does not update credentials in existing volumes.

## Run and inspect shipments

The following is the shipment workflow. Expected results for a fresh seed are 10,000 published events and 4,000 shipment documents. The [validation history](validation-history.md) records a successful run.

From the repository root:

```sh
make build
make infra
make seed
make up
```

Follow application output in another terminal:

```sh
make logs
```

Compose waits for the replicator's three infrastructure dependencies and the consumer's RabbitMQ dependency. The consumer does not depend on the replicator or source. Seed before starting the replicator. Startup logs show `Startup boundary: lastId=10000` for the default fixture, followed by both readers starting work.

For 10,000 seeded rows, expected progress ends with:

```text
Initial batch 10: rows=1000 firstId=9001 lastId=10000 total=10000
Initial load complete: rows=10000 batches=10
```

The older [shipment validation](validation-history.md#shipment-validation--2026-09-28) records the earlier sequential implementation; its log prefix and lifecycle predate the current rule.

Inspect shipment 1 and its latest event (ID 3) across the three systems:

```sh
make history ID=1
make shipment ID=1
make logs SERVICES=consumer TAIL=all
make status
```

The OpenSearch response should have `_id: "1"` with event ID 3, version 3, and status `delivered`. The index should contain 4,000 documents after refresh, while consumer logs should contain 10,000 events. Find `"sourceId":3,` in the consumer output and compare its `record`. GET by document ID does not require waiting for the search refresh interval. These inspection commands use container ports, independent of host port overrides.

Use `make counts` to compare source event/shipment totals with the indexed document count. Search counts follow the normal OpenSearch refresh interval. Ctrl+C stops log following without stopping the consumer.

Inspect the queue independently:

```sh
make queue
```

An empty queue while the consumer is running is not proof that every event was logged. To observe queued publications, stop the consumer, restart the replicator, and run `make generate`. Inspect with `make queue`, then start the consumer. Restarting resumes saved progress rather than republishing the snapshot.

After both initial loading and polling complete, expect the replicator to exit with code 0 while the consumer remains running. To observe live generation manually, run `make generate COUNT=500 RATE=20` in another terminal when ready; startup polling waits for this first activity; see [live traffic generation](../README.md#generate-live-traffic). New rows after polling stops need another run. Resume unfinished work with `make restart`; an event interrupted before checkpoint commit can be republished. To stop and remove containers while retaining data, use `make down`. No walkthrough step requires deleting existing volumes.

A clean-source walkthrough needs unused volumes. Use a new `COMPOSE_PROJECT_NAME` and unused host ports, consistently for Compose and `make seed`, to preserve existing data. Application image tags remain shared.

## Browser inspection with Dashboards

Normal Compose startup includes OpenSearch Dashboards 3.4.0, matching OpenSearch. Issue #22 moves OpenSearch from 3.3.2 to 3.4.0 because a matching Dashboards 3.3.2 image is unavailable. Starting this configuration against an existing project upgrades its OpenSearch container; use a separate project and unused ports for a fresh-data check that preserves the old volumes. To start Dashboards and its OpenSearch dependency:

```sh
make dashboards
make logs SERVICES=dashboards
```

Open [OpenSearch Dashboards](http://localhost:5601). Set `DASHBOARDS_PORT` in `.env` to override the host port; existing configurations without it use 5601. Dashboards connects to the internal OpenSearch HTTP address, independently of `OPENSEARCH_PORT`. Both security plugins are disabled for this local demo, so no login is required. Startup can take a minute after OpenSearch is healthy.

1. Wait for `make infra` or `make dashboards` to finish successfully. These commands run setup in a disposable container and print its output directly. Normal Compose startup also includes the setup service.
2. Open [shipments in Discover](http://localhost:5601/app/discover#/?_a=%28columns%3A!%28shipment_id%2Cversion%2Cstatus%2Cid%2Coccurred_at%29%2Cindex%3Ashipments%29). The setup service creates the pattern with a stable ID and no time filter, so the January 2025 seed timestamps remain visible. It preserves a compatible existing pattern on reruns and sets the default Discover columns to `shipment_id`, `version`, `status`, `id`, and `occurred_at`. The direct link includes those columns so an earlier browser session cannot restore the whole-document view.
3. Once replication has written data, search `shipment_id: 1`. Expand the document and inspect `shipment_id`, `version`, `status`, `id`, and `occurred_at`. With a fresh default seed, expect shipment 1, version 3, status `delivered`, event ID 3.
4. Use **Refresh** after indexing changes. Search visibility follows OpenSearch's refresh timing. If you opened Discover before any shipment data existed, reopen the link after the initial writes. Existing data may contain higher versions than the sample.

Dashboards shows the current projection, not the complete source event history. Its saved index pattern lives in OpenSearch. It is an inspection tool, not the assignment's operator UI for pipeline controls, lag, DLQ, or failure simulation.

## Source seed

`make seed` builds and runs the independent TypeScript source-writer CLI against the running PostgreSQL service, user `source`, database `client_source`. Its Compose service is behind the `seed` profile, so normal startup does not seed automatically. The disposable writer runs with `--no-deps` and does not start PostgreSQL, the replicator, or the consumer, or reset volumes.

Use `make seed SEED_ARGS="--shipments 3"` for a smaller initial fixture (eight events). Counts must be positive integers whose generated IDs fit PostgreSQL integer columns. Runs always start at shipment/event ID 1; smaller counts retain existing data, and larger counts add missing initial histories. Complete seeding before generating: later fixture extensions can collide with appended IDs or insert behind the reader's cursor.

The second main workflow is `make generate COUNT=500 RATE=20`. COUNT means events,
RATE means target events per second. It starts new shipments above the current
maximum ID and produces created/in_transit/delivered histories lazily, stopping
at exactly COUNT even within a history. Each event uses the serial append
transaction, commits before the next write, and is printed. Pacing accounts for
write time without concurrent writes or catch-up bursts. Already committed
events remain on interruption or error. Generate requires a table created by
seed; it starts no other services. There is no retry or restart continuation.

For occasional manual events, use `make append ID=4001 STATUS=created`. Run only one writer command at a time. Append inserts one row with maximum event ID plus one and maximum shipment version plus one, then prints it after commit. A new shipment starts at version 1. There is no transition state machine.

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
make postgres
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
npm test --prefix apps/consumer
npm ci --prefix apps/source-writer
npm test --prefix apps/source-writer
```

The source-writer tests check deterministic histories without PostgreSQL and use a fake query client to check bounded inserts and transaction handling. They do not check replication or failure gates. For local seeding, set the standard PostgreSQL environment variables and run `npm start --prefix apps/source-writer -- --shipments 4000`; use `--help` for usage. The CLI does not load `.env` itself.

See the [test reading guide](../apps/replicator/test/README.md) for scenarios and commands for running individual test files.

The replicator tests compile TypeScript and use mocked clients to inspect bounded reads, waiting, cleanup, destination errors, JSON fields, and publication confirmation. They are not automated pipeline or failure-gate checks.

For local execution, set `CHECKPOINT_PATH` to a writable SQLite file in an existing directory, then set the five standard PostgreSQL variables (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`), `OPENSEARCH_URL`, and `RABBITMQ_HOST`, `RABBITMQ_PORT`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD`. Use published host ports. The consumer needs the RabbitMQ variables and `RECEIPT_PATH`, pointing to a writable SQLite file in an existing directory. Neither application loads `.env` itself.

```sh
npm start --prefix apps/replicator
npm start --prefix apps/consumer
```

The replicator build runs format:check, lint, and typecheck before compiling; any failed check stops the build. This also applies to its Docker build. The consumer keeps its TypeScript-only build.

All application Dockerfiles compile TypeScript and ship runtime dependencies as the Node user.

## Limitations

This is a concurrent initial-load and finite-polling POC, not a throughput benchmark. Correct discovery assumes one serial writer whose IDs increase with commits; concurrent transactions committing out of ID order can be missed. After receiving its first incremental rows, polling stops permanently for this run after consecutive empty reads, even if initial loading is still active. Restarting resumes saved cursors, retains the highest shipment versions, and can emit duplicates for events interrupted before checkpoint commit. Stale destination documents are not deleted.

Indexing and publication are separate operations. The queue and events are non-durable/non-persistent; the consumer uses manual acknowledgement and persistent receipt checks. A crash between receipt commit and console output can still omit a normal log. Broker confirmation is not evidence of consumer logging or atomic delivery to both destinations.

Durable SQLite checkpoints live in the dedicated `replicator-state` volume, separate from PostgreSQL. One replicator process owns that volume. `make verify` runs the isolated G1 interruption check described in the README; G2–G5 remain unimplemented. The consumer owns separate receipts in `consumer-state`, using one conflict-aware insert per event; it never shares the replicator checkpoint. There is no automatic retry/reconnect policy, DLQ, or operator UI. Polling and infrastructure health checks are not delivery guarantees.
