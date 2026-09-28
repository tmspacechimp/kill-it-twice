# Kill It Twice — specification

## Purpose

Build a local demonstration of data replication from a client database to a searchable current-state store and an event stream with an independent consumer. The assignment ultimately calls for initial load and continuous incremental sync running together, a usable UI, and executable evidence for five failure scenarios. This specification will evolve as those parts are designed and built; Git history should show the changes.

## v0: initial-load proof of concept

Issue #17 now includes the shipment initial-load pipeline as well as its source fixture, expanding the original source-only scope. The replicator reads shipment events, projects the highest version per shipment in OpenSearch, and publishes every event to the independent logging consumer. Existing customer data and destinations are left untouched and are no longer used. Incremental reading remains out of scope.

```text
PostgreSQL (client source) → replicator → OpenSearch (current records)
                                  └─────→ RabbitMQ → consumer → logs
```

- Docker Compose runs the source PostgreSQL, replicator, OpenSearch, RabbitMQ, and a separate consumer application. Infrastructure ports use the short `HOST_PORT:CONTAINER_PORT` format, with host ports supplied by `.env`, and bind to all host interfaces. OpenSearch uses unauthenticated HTTP for this local demonstration.
- `make seed` adds shipment events to the source, for the shipment pipeline. PostgreSQL represents a client-owned database: the replicator reads it and does not use it to store internal state. The consumer does not write to it.
- After startup, the replicator waits for shipment events, reads the initial event dataset in bounded batches, projects status by shipment ID and version in OpenSearch, and publishes an event for each record to RabbitMQ. Once that load is done, it does not watch for later changes.
- The consumer receives events independently and logs them. The event needs enough information to identify the source record and see what was sent.
- `docker compose up --build` starts the system. After seeding, inspect OpenSearch and consumer logs to see the shipment path working. No automated outcome check is required yet.

NestJS/TypeScript is the intended replicator stack. Keep the consumer small; its framework is an implementation choice, not a product requirement. Specific names for the index and queue can be set during implementation and recorded here when they matter.

## Sample source data

`make seed` builds and runs the independent TypeScript source-writer CLI (issue #19) against the running Compose `postgres` service, as user `source` in database `client_source`. The service is behind the `seed` profile and is not part of normal startup. It creates only `public.shipment_status_events`, with this schema:

| Column | Type | Constraint |
| --- | --- | --- |
| `id` | `integer` | Primary key; globally unique event identity supplied by the source writer |
| `shipment_id` | `integer` | Not null; identifies a shipment across events |
| `version` | `integer` | Not null; `CHECK (version > 0)` |
| `status` | `text` | Not null; `CHECK (status IN ('created', 'in_transit', 'delivered', 'cancelled'))` |
| `occurred_at` | `timestamptz` | Not null; time of the transition |

`UNIQUE (shipment_id, version)` prevents two events from claiming the same shipment version. Writers append new rows instead of updating or deleting previous events. Append-only behavior is a source-writer convention: this ticket adds no database mutation guards, triggers, or transition state machine. Event IDs identify history entries; per-shipment versions define business ordering. The OpenSearch projection selects the highest version for each shipment, while publication carries every individual event.

Retaining history does not solve incremental discovery. Concurrent transactions can commit out of event-ID order; IDs are not commit-order offsets, and an ID cursor alone does not guarantee that no events are missed. Incremental discovery and its ordering guarantees require a future specification decision.

A fresh source receives exactly 10,000 events for shipments 1 through 4,000. Odd shipment IDs have versions 1–3 (`created`, `in_transit`, `delivered`); even shipment IDs have versions 1–2 (`created`, `cancelled`). Totals are 4,000 created, 2,000 in_transit, 2,000 delivered, and 2,000 cancelled events. A pure, lazy TypeScript generator yields histories ordered by shipment ID and version, assigning sequential event IDs starting at 1. Every `occurred_at` is `TIMESTAMPTZ '2025-01-01 00:00:00+00' + id * INTERVAL '1 minute'`. Generation uses neither randomness nor the current clock.

Schema creation (`CREATE TABLE IF NOT EXISTS`) and insertion share an explicit transaction. The writer awaits parameterized inserts of at most 1,000 events each and rolls back on errors, without retries. Targeted `ON CONFLICT (id) DO NOTHING` makes reruns insert only missing IDs in the fixed range. Existing values and extra events are preserved; a populated table can exceed 10,000 rows. A different event ID conflicting with a shipment/version pair fails the transaction, as do unrelated schema or constraint errors. The CLI does not migrate an existing schema or drop, truncate, rename, or alter an existing customer table. After committing, it prints total events, distinct shipments, and the first ten events ordered by ID.

The CLI accepts `--shipments N` (or `make seed SEED_ARGS="--shipments N"`), a positive integer up to 858,993,458 so event IDs fit the source integer column. The default is 4,000. Every run generates the same prefix starting at shipment/event ID 1; a smaller count does not remove existing rows, and a larger count adds missing initial histories. This is initial seeding only, not a command for later transitions. Generation uses no database access.

Seeding requires only running PostgreSQL, independently of the replicator and consumer. `make seed` builds and runs a disposable writer container with `--no-deps`; it starts no other services, resets no volumes, and creates no application-owned state tables. The CLI uses standard PostgreSQL environment variables, a five-second connection timeout, and closes its connection on success or failure. Invalid arguments fail before connection. Unit tests establish fixture histories independently of PostgreSQL; they do not establish pipeline outcomes. This dataset demonstrates v0 sample loading, not large-scale capacity or the assignment's failure gates.

## Initial source reader (issue #6)

The reader connects using the standard `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` environment variables. Compose supplies these and waits for healthy PostgreSQL. A connection attempt times out after five seconds; connection, permission, and schema errors fail the process rather than being retried.

Before loading, the reader waits one second between checks while `public.shipment_status_events` is missing or empty. Each check opens a repeatable-read, read-only transaction. An empty check rolls back before sleeping, so newly committed seed data can become visible. The first nonempty check defines the initial snapshot; the reader keeps that transaction until all its rows have been read. Later inserts, updates, and deletes are outside this load. This snapshot is a v0 read boundary, not a concurrent-update or recovery guarantee.

Reads select all five shipment event columns, ordered by primary key, with a fixed limit of 1,000 rows. The first read has no lower ID bound; subsequent reads use `id > lastId`, including negative, zero, and sparse IDs correctly. Only bounded batches are retained in application memory. Logs show each batch's count, first and last IDs, cumulative count, and final completion. After committing the read-only transaction the connection and Nest context close and the process exits. Empty sources wait indefinitely until seeded. Database sessions default to read-only; the reader creates no source state and issues no data/schema writes.

Holding a snapshot open can delay PostgreSQL cleanup during the load; this is accepted for the initial-load proof of concept.

## OpenSearch destination (issue #7)

Each event is indexed sequentially using HTTP PUT to the fixed index `shipments`, document ID equal to the decimal `shipment_id`. The JSON document contains exactly the five event fields; `occurred_at` is serialized as an ISO UTC timestamp. Requests use `version=<event.version>&version_type=external`: only a strictly higher shipment version replaces a document. This keeps the highest version even when event IDs are out of business order or histories span batches, without retaining per-shipment state in application memory. OpenSearch creates the index on first write with its default dynamic mapping. `OPENSEARCH_URL` supplies the HTTP endpoint; Compose waits for healthy OpenSearch.

The reader awaits each write before processing the next record or fetching another batch. HTTP requests time out after ten seconds; a 409 response with error type `version_conflict_engine_exception` means an equal or newer version is already indexed, so processing continues to publication. All other non-success responses (including unrecognized or malformed 409 responses) terminate the load with no retry. Full reruns preserve equal or newer shipment versions; this assumes immutable source history and that this pipeline owns the shipment index. It does not remove stale documents or establish recovery. Normal OpenSearch refresh timing applies to searches; GET by document ID can inspect a write immediately.

## RabbitMQ publication (issue #8)

After each successful index write or recognized version conflict, the replicator sends one JSON event through RabbitMQ's default exchange to queue `shipments.initial-load`. The queue is non-durable, non-exclusive, and not auto-deleted; messages are non-persistent. Both applications declare it identically. The event is `{ "type": "shipment.status", "sourceId": <event ID>, "record": <the five-field source event> }`.

The publisher uses one confirm channel and awaits broker confirmation for each message before advancing. This bounds pending publications and lets the replicator close after its last publication; it does not guarantee consumption or atomicity with OpenSearch. Batch progress is logged only after every row in that batch has been projected (or recognized as an older/equal version) and published. A new process repeats the full snapshot and can publish duplicate events.

Compose supplies `RABBITMQ_HOST`, `RABBITMQ_USER`, and `RABBITMQ_PASSWORD`; `RABBITMQ_PORT` defaults to 5672 inside the applications. Connections time out after five seconds and use a ten-second heartbeat. Client recovery is opt-in and is not enabled. Connection or publication errors fail the process without retries.

## Independent consumer (issue #9)

The plain TypeScript consumer connects only to RabbitMQ, declares the same queue, and logs each full UTF-8 JSON payload prefixed with `Received event `. It uses automatic acknowledgement (`noAck: true`): events can be lost before their logs are written. It keeps no receipts and performs no deduplication, retry, or requeue. It stays subscribed after the replicator exits, closes its connection on SIGINT/SIGTERM, and exits on broker errors or cancellation. Compose waits for healthy RabbitMQ; it has no dependency on the replicator or PostgreSQL.

## Shipment inspection (issue #22)

OpenSearch and OpenSearch Dashboards are pinned together at 3.4.0. The previous OpenSearch pin was 3.3.2, but no Dashboards 3.3.2 image is published; issue #22 moves both forward to an available matching pair. Dashboards connects to `http://opensearch:9200` after OpenSearch is healthy, with its security plugin disabled to match the local unauthenticated setup. `DASHBOARDS_PORT` controls the host port and defaults to 5601, including for existing `.env` files without the new setting.

Users create a `shipments` index pattern without a time filter and inspect the latest indexed shipment status in Discover. Dashboards stores its own configuration in OpenSearch, never in the source database. This adds an inspection tool only: it does not provide pipeline controls, lag reporting, DLQ handling, failure simulation, or evidence for the assignment's failure gates.

## Boundaries and future work

This v0 makes no claim about recovery, complete delivery, duplicates, concurrent updates, or behavior when a destination fails. It has no incremental sync, checkpoints, retry policy, DLQ, observability UI, or `make verify`. Do not describe the visible happy path as proof of any failure gate.

Later versions must decide how source changes are captured; how progress and delivery are made recoverable; how rejected records are handled; and how the UI and `make verify` demonstrate the assignment's requirements. Record those decisions when there is enough evidence to make them, including changes prompted by experiments.
