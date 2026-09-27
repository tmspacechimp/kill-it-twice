# Kill It Twice — specification

## Purpose

Build a local demonstration of data replication from a client database to a searchable current-state store and an event stream with an independent consumer. The assignment ultimately calls for initial load and continuous incremental sync running together, a usable UI, and executable evidence for five failure scenarios. This specification will evolve as those parts are designed and built; Git history should show the changes.

## v0: initial-load proof of concept

The first version demonstrates one straightforward path:

```text
PostgreSQL (client source) → replicator → OpenSearch (current records)
                                  └─────→ RabbitMQ → consumer → logs
```

- Docker Compose runs the source PostgreSQL, replicator, OpenSearch, RabbitMQ, and a separate consumer application. Infrastructure ports use the short `HOST_PORT:CONTAINER_PORT` format, with host ports supplied by `.env`, and bind to all host interfaces. OpenSearch uses unauthenticated HTTP for this local demonstration.
- `make seed` adds sample records to the source. PostgreSQL represents a client-owned database: the replicator reads it and does not use it to store internal state. The consumer does not write to it.
- After startup, the replicator waits for seeded records, reads the initial dataset in bounded batches, indexes records by source ID in OpenSearch, and publishes an event for each record to RabbitMQ. Once that load is done, it does not watch for later changes.
- The consumer receives events independently and logs them. The event needs enough information to identify the source record and see what was sent.
- `docker compose up --build` starts the system. For this version, inspect OpenSearch and consumer logs to see the path working. No automated outcome check is required yet.

NestJS/TypeScript is the intended replicator stack. Keep the consumer small; its framework is an implementation choice, not a product requirement. Specific names for the index and queue can be set during implementation and recorded here when they matter.

## Sample source data

`make seed` runs `seed.sql` through psql in the running Compose `postgres` service, as user `source` in database `client_source`. It creates only `public.customers`, with this schema:

| Column | Type | Constraint |
| --- | --- | --- |
| `id` | `integer` | Primary key |
| `full_name` | `text` | Not null |
| `email` | `text` | Not null |
| `country_code` | `text` | Not null |
| `status` | `text` | Not null |
| `created_at` | `timestamptz` | Not null |

A fresh source receives exactly 10,000 synthetic customers with integer IDs 1 through 10,000. PostgreSQL `generate_series` supplies the IDs. Names are `Customer <id>` and emails are `customer<id>@example.test`. Countries cycle through `GE`, `US`, `DE`, `GB`, and `FR`; odd IDs are `active` and even IDs are `inactive`. Each timestamp is `2025-01-01 00:00:00+00` plus the ID in minutes. Generation uses neither randomness nor the current clock.

Schema creation and insertion share an explicit transaction, with psql stopping on SQL errors. `ON CONFLICT (id) DO NOTHING` makes reruns insert only missing IDs in the fixed range. Existing values, manual edits, and records outside that range are preserved; a populated table can therefore exceed 10,000 rows. The script does not migrate an existing schema. After committing, it prints the total count and first five customers ordered by ID.

Seeding requires only PostgreSQL, independently of the replicator and consumer. It neither starts services nor resets volumes and creates no application-owned state tables. This dataset demonstrates v0 sample loading, not large-scale capacity or the assignment's failure gates.

## Initial source reader (issue #6)

The reader connects using the standard `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` environment variables. Compose supplies these and waits for healthy PostgreSQL. A connection attempt times out after five seconds; connection, permission, and schema errors fail the process rather than being retried.

Before loading, the reader waits one second between checks while `public.customers` is missing or empty. Each check opens a repeatable-read, read-only transaction. An empty check rolls back before sleeping, so newly committed seed data can become visible. The first nonempty check defines the initial snapshot; the reader keeps that transaction until all its rows have been read. Later inserts, updates, and deletes are outside this load. This snapshot is a v0 read boundary, not a concurrent-update or recovery guarantee.

Reads select all six customer columns, ordered by primary key, with a fixed limit of 1,000 rows. The first read has no lower ID bound; subsequent reads use `id > lastId`, including negative, zero, and sparse IDs correctly. Only bounded batches are retained in application memory. Logs show each batch's count, first and last IDs, cumulative count, and final completion. After committing the read-only transaction the connection and Nest context close and the process exits. Empty sources wait indefinitely until seeded. Database sessions default to read-only; the reader creates no source state and issues no data/schema writes.

Holding a snapshot open can delay PostgreSQL cleanup during the load; this is accepted for the initial-load proof of concept.

## OpenSearch destination (issue #7)

Each source row is indexed sequentially using HTTP PUT to the fixed index `customers`, document ID equal to the decimal source ID. The JSON document contains exactly the six source fields; `created_at` is serialized as an ISO UTC timestamp. OpenSearch creates the index on first write with its default dynamic mapping. `OPENSEARCH_URL` supplies the HTTP endpoint; Compose waits for healthy OpenSearch.

The reader awaits each write before processing the next record or fetching another batch. HTTP requests time out after ten seconds; non-success responses terminate the load with no retry. Successful writes replace documents with the same ID on later full runs; this does not remove stale documents or establish recovery. Normal OpenSearch refresh timing applies to searches; GET by document ID can inspect a write immediately.

## RabbitMQ publication (issue #8)

After each successful index write, the replicator sends one JSON event through RabbitMQ's default exchange to queue `customers.initial-load`. The queue is non-durable, non-exclusive, and not auto-deleted; messages are non-persistent. Both applications declare it identically. The event is `{ "type": "customer.initial-load", "sourceId": <integer>, "record": <the six-field indexed document> }`.

The publisher uses one confirm channel and awaits broker confirmation for each message before advancing. This bounds pending publications and lets the replicator close after its last publication; it does not guarantee consumption or atomicity with OpenSearch. Batch progress is logged only after every row in that batch has been indexed and published. A new process repeats the full snapshot and can publish duplicate events.

Compose supplies `RABBITMQ_HOST`, `RABBITMQ_USER`, and `RABBITMQ_PASSWORD`; `RABBITMQ_PORT` defaults to 5672 inside the applications. Connections time out after five seconds and use a ten-second heartbeat. Client recovery is opt-in and is not enabled. Connection or publication errors fail the process without retries.

## Independent consumer (issue #9)

The plain TypeScript consumer connects only to RabbitMQ, declares the same queue, and logs each full UTF-8 JSON payload prefixed with `Received event `. It uses automatic acknowledgement (`noAck: true`): events can be lost before their logs are written. It keeps no receipts and performs no deduplication, retry, or requeue. It stays subscribed after the replicator exits, closes its connection on SIGINT/SIGTERM, and exits on broker errors or cancellation. Compose waits for healthy RabbitMQ; it has no dependency on the replicator or PostgreSQL.

## Boundaries and future work

This v0 makes no claim about recovery, complete delivery, duplicates, concurrent updates, or behavior when a destination fails. It has no incremental sync, checkpoints, retry policy, DLQ, observability UI, or `make verify`. Do not describe the visible happy path as proof of any failure gate.

Later versions must decide how source changes are captured; how progress and delivery are made recoverable; how rejected records are handled; and how the UI and `make verify` demonstrate the assignment's requirements. Record those decisions when there is enough evidence to make them, including changes prompted by experiments.
