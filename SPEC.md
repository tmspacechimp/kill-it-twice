# Kill It Twice — specification

## Purpose

Build a local demonstration of data replication from a client database to a searchable current-state store and an event stream with an independent consumer. The assignment ultimately calls for initial load and continuous incremental sync running together, a usable UI, and executable evidence for five failure scenarios. This specification will evolve as those parts are designed and built; Git history should show the changes.

## v0.5: concurrent initial load and finite polling (issue #21)

Issue #21 expands the initial-load proof of concept with incremental polling under a single serial source-writer assumption. The replicator reads shipment events, projects the highest version per shipment in OpenSearch, and publishes every event to the independent logging consumer. Existing customer data and destinations are left untouched and are no longer used.

```text
PostgreSQL (client source) → replicator → OpenSearch (current records)
                                  └─────→ RabbitMQ → consumer → logs
```

- Docker Compose runs the source PostgreSQL, replicator, OpenSearch, RabbitMQ, and a separate consumer application. Infrastructure ports use the short `HOST_PORT:CONTAINER_PORT` format, with host ports supplied by `.env`, and bind to all host interfaces. OpenSearch uses unauthenticated HTTP for this local demonstration.
- `make seed` adds shipment events to the source, for the shipment pipeline. PostgreSQL represents a client-owned database: the replicator reads it and does not use it to store internal state. The consumer does not write to it.
- At startup, the replicator captures the highest existing event ID. Rows through that boundary form its initial load. It processes that dataset and polls for later events concurrently, using bounded reads and the same index-then-publish path. Polling stops after consecutive empty reads; the process exits when both readers finish.
- The consumer receives events independently and logs them. The event needs enough information to identify the source record and see what was sent.
- Start PostgreSQL and run `make seed` before starting the replicator. Inspect OpenSearch and consumer logs to see the shipment path working. No automated outcome check is required yet.

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

Retaining history does not solve concurrent incremental discovery. Concurrent transactions can commit out of event-ID order; IDs are not commit-order offsets, and an ID cursor alone does not guarantee that no events are missed. Issue #21 assumes one serial writer whose appended IDs increase with its commits. Concurrent writers require a future specification decision.

A fresh source receives exactly 10,000 events for shipments 1 through 4,000. Odd shipment IDs have versions 1–3 (`created`, `in_transit`, `delivered`); even shipment IDs have versions 1–2 (`created`, `cancelled`). Totals are 4,000 created, 2,000 in_transit, 2,000 delivered, and 2,000 cancelled events. A pure, lazy TypeScript generator yields histories ordered by shipment ID and version, assigning sequential event IDs starting at 1. Every `occurred_at` is `TIMESTAMPTZ '2025-01-01 00:00:00+00' + id * INTERVAL '1 minute'`. Generation uses neither randomness nor the current clock.

Schema creation (`CREATE TABLE IF NOT EXISTS`) and insertion share an explicit transaction. The writer awaits parameterized inserts of at most 1,000 events each and rolls back on errors, without retries. Targeted `ON CONFLICT (id) DO NOTHING` makes reruns insert only missing IDs in the fixed range. Existing values and extra events are preserved; a populated table can exceed 10,000 rows. A different event ID conflicting with a shipment/version pair fails the transaction, as do unrelated schema or constraint errors. The CLI does not migrate an existing schema or drop, truncate, rename, or alter an existing customer table. After committing, it prints total events, distinct shipments, and the first ten events ordered by ID.

The CLI accepts `--shipments N` (or `make seed SEED_ARGS="--shipments N"`), a positive integer up to 858,993,458 so event IDs fit the source integer column. The default is 4,000. Every run generates the same prefix starting at shipment/event ID 1; a smaller count does not remove existing rows, and a larger count adds missing initial histories. This is initial seeding only, not a command for later transitions. Generation uses no database access.

Seeding requires only running PostgreSQL, independently of the replicator and consumer. `make seed` builds and runs a disposable writer container with `--no-deps`; it starts no other services, resets no volumes, and creates no application-owned state tables. The CLI uses standard PostgreSQL environment variables, a five-second connection timeout, and closes its connection on success or failure. Invalid arguments fail before connection. Unit tests establish fixture histories independently of PostgreSQL; they do not establish pipeline outcomes. This dataset demonstrates v0 sample loading, not large-scale capacity or the assignment's failure gates.

## Initial source reader (issue #6)

The reader connects using the standard `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` environment variables. Compose supplies these and waits for healthy PostgreSQL. A connection attempt times out after five seconds; connection, permission, and schema errors fail the process rather than being retried.

The operating rule, revised on 2026-09-29, is that rows visible at startup form the initial load. After connecting, `SELECT max(id)` captures that boundary once. Under the required single serial, append-only writer assumption, later committed events have greater IDs, so initial reads can use `id <= boundary` without keeping a long-lived snapshot transaction open. The precise startup boundary is the committed view of that SELECT. Updating or deleting existing source rows is outside the source contract.

Initial reads select all five shipment event columns, ordered by primary key, with a fixed limit of 1,000 and the startup upper bound. The first read has no lower ID bound; subsequent reads use `id > lastId`, including negative, zero, and sparse IDs correctly. A null startup boundary means an empty initial load; it completes immediately. A missing table fails with an instruction to seed first. There is no readiness wait. Logs show the startup boundary, each completed initial batch, and final initial totals.

Initial loading and polling use separate PostgreSQL connections with sessions defaulting to read-only. Both loops retain at most one batch and await processing within that batch. Neither creates source state or issues data/schema writes. Initial completion does not stop an active poller; polling completion does not stop an unfinished initial load. Connections and the Nest context close after both finish.

## Generate traffic and incremental polling (issue #21)

The source-writer's two primary workflows are initial fixtures (`make seed`) and
ongoing source traffic (`make generate COUNT=500 RATE=20`). `COUNT` is the exact
number of events to append, not shipments; `RATE` is the target events per
second. Defaults are 500 and 20. The CLI form is
`source-writer generate --count 500 --rate 20`. COUNT accepts positive integers
up to 2147483647; RATE accepts integers from 1 to 1000. Invalid options fail
before connection.

Generate requires the existing source table. It reads the maximum shipment ID
once, then lazily creates new shipments above that maximum, each following
`created`, `in_transit`, `delivered`. A run ends at exactly COUNT events, so its
last shipment can have a partial history. Each new run starts new shipments;
it does not resume incomplete histories. The transition generator is pure and
independent of PostgreSQL. Event creation uses the same pure constructor as
manual append, with current timestamps. No previous rows are changed.

Each event is committed in its own transaction using the serial append writer.
The first event starts immediately; subsequent writes target a spacing of
`1000 / RATE` milliseconds, accounting for database write time with a
monotonic clock. Writes never overlap and slow writes cause a lower achieved
rate, without catch-up bursts. Each committed event is printed, followed by a
final inserted count. SIGINT/SIGTERM stop between writes or interrupt a pacing
wait, keeping already committed events. Errors stop the run without retries;
earlier commits remain. Only PostgreSQL needs to be running. Make builds and
runs a disposable writer with `--no-deps`, without starting other services.
Run only one seed, generate, or append command at a time.

Manual append is a secondary tool for selecting a specific shipment and status.

After initial seeding, `source-writer append SHIPMENT_ID STATUS` appends one event in a transaction. Shipment IDs must be positive PostgreSQL integers and statuses must be one of the four allowed values; CLI validation precedes connection. The writer reads the global maximum event ID and the shipment's maximum version, supplies those values and the current time to a pure event constructor, and inserts the result with parameters. The new ID and version are each their maximum plus one (or 1 when absent); integer exhaustion fails. A new shipment starts at version 1. There is no transition state machine. Append requires the existing table, changes no old rows, commits before printing the event, and rolls back errors without retries or conflict suppression. `make seed` remains for initial fixtures only; do not run seed extensions after appending, because fixture IDs can collide or insert behind the cursor.

The single serial writer must finish each commit before starting another write. Immediately after the startup boundary is captured, polling starts alongside initial loading, with its cursor set to that boundary. It queries `id > lastId ORDER BY id LIMIT 1000` using fresh committed views. For an initially empty table, the first poll has no lower ID bound. Each reader indexes and publishes its events sequentially; at most two events can be in flight across both readers. The polling cursor advances only after successful batch processing. Initial and incremental events can interleave in consumer logs and need not arrive in shipment-version order; OpenSearch's external version check retains the highest version.

Polling waits indefinitely for its first incremental rows, even if initial loading has finished. Empty reads during this startup wait do not count toward the limit. Once the first nonempty incremental batch arrives, polling stops after `POLL_MAX_EMPTY` consecutive empty reads (default 3). Any nonempty read resets that count to zero, including a partial batch. Full batches drain immediately; after empty or partial batches the reader waits `POLL_INTERVAL_MS` (default 1000), except after the final empty read. Both settings accept integers from 1 to 2147483647. The first poll is immediate, and all startup empty reads still wait the configured interval. If no incremental rows ever arrive, the process stays alive until shutdown or error. After incremental activity, three consecutive empty reads stop polling; the preceding batch size and query time affect the exact delay. Once stopped, polling does not resume during that process, even if initial loading is still running. Later inserts wait for a new run. Logs distinguish waiting for the first incremental rows, activation of the empty-poll limit, counted empty attempts, and the final stop.

SIGINT/SIGTERM interrupt waits and stop between records. A source or processing failure aborts the sibling reader and waits for its active operation before closing clients; no retries occur. Active database requests and destination operations are not cancelled by the shutdown signal. Once both readers finish, the publisher and Nest context close and the process exits.

This is a happy-path assumption, not concurrent capture or recovery: a lower ID committed after a higher ID has been processed can be missed. No cursor is persisted. Every restart captures a new startup boundary and reloads all existing rows, potentially republishing duplicates; it does not resume. There are no durable checkpoints, recovery, retries, DLQ, consumer deduplication, or failure-gate claims.

## OpenSearch destination (issue #7)

Each reader indexes its events sequentially using HTTP PUT to the fixed index `shipments`, document ID equal to the decimal `shipment_id`. The JSON document contains exactly the five event fields; `occurred_at` is serialized as an ISO UTC timestamp. Requests use `version=<event.version>&version_type=external`: only a strictly higher shipment version replaces a document. This keeps the highest version even when event IDs are out of business order or histories span batches, without retaining per-shipment state in application memory. OpenSearch creates the index on first write with its default dynamic mapping. `OPENSEARCH_URL` supplies the HTTP endpoint; Compose waits for healthy OpenSearch.

The reader awaits each write before processing the next record or fetching another batch. HTTP requests time out after ten seconds; a 409 response with error type `version_conflict_engine_exception` means an equal or newer version is already indexed, so processing continues to publication. All other non-success responses (including unrecognized or malformed 409 responses) terminate the load with no retry. Full reruns preserve equal or newer shipment versions; this assumes immutable source history and that this pipeline owns the shipment index. It does not remove stale documents or establish recovery. Normal OpenSearch refresh timing applies to searches; GET by document ID can inspect a write immediately.

## RabbitMQ publication (issue #8)

After each successful index write or recognized version conflict, the replicator sends one JSON event through RabbitMQ's default exchange to queue `shipments.initial-load`. The queue is non-durable, non-exclusive, and not auto-deleted; messages are non-persistent. Both applications declare it identically. The event is `{ "type": "shipment.status", "sourceId": <event ID>, "record": <the five-field source event> }`.

The publisher uses one confirm channel. Each reader awaits broker confirmation before advancing, bounding outstanding publications to two across both readers. This does not guarantee consumption or atomicity with OpenSearch. The existing queue name is retained for both initial and incremental events. Batch progress is logged only after every row in that batch has been projected (or recognized as an older/equal version) and published. A new process repeats the full initial dataset and can publish duplicate events.

Compose supplies `RABBITMQ_HOST`, `RABBITMQ_USER`, and `RABBITMQ_PASSWORD`; `RABBITMQ_PORT` defaults to 5672 inside the applications. Connections time out after five seconds and use a ten-second heartbeat. Client recovery is opt-in and is not enabled. Connection or publication errors fail the process without retries.

## Independent consumer (issue #9)

The plain TypeScript consumer connects only to RabbitMQ, declares the same queue, and logs each full UTF-8 JSON payload prefixed with `Received event `. It uses automatic acknowledgement (`noAck: true`): events can be lost before their logs are written. It keeps no receipts and performs no deduplication, retry, or requeue. It stays subscribed after the replicator exits, closes its connection on SIGINT/SIGTERM, and exits on broker errors or cancellation. Compose waits for healthy RabbitMQ; it has no dependency on the replicator or PostgreSQL.

## Shipment inspection (issue #22)

OpenSearch and OpenSearch Dashboards are pinned together at 3.4.0. The previous OpenSearch pin was 3.3.2, but no Dashboards 3.3.2 image is published; issue #22 moves both forward to an available matching pair. Dashboards connects to `http://opensearch:9200` after OpenSearch is healthy, with its security plugin disabled to match the local unauthenticated setup. `DASHBOARDS_PORT` controls the host port and defaults to 5601, including for existing `.env` files without the new setting.

Compose runs a one-time `dashboards-setup` service after the Dashboards HTTP health check passes. It creates the `shipments` index pattern with saved-object ID `shipments` and no time field, using the Dashboards saved-object API. It can run before the shipment index exists; Discover discovers fields when data is available. A rerun preserves an existing compatible pattern and fails clearly if that fixed ID targets something else or has a time filter. It changes no default index pattern or unrelated saved objects. The setup script uses the same pinned Dashboards image, times out HTTP requests after ten seconds, and exits on errors without retries. The setup also sets the Dashboards `defaultColumns` preference to `shipment_id`, `version`, `status`, `id`, and `occurred_at`. Rerunning setup reapplies these columns. The README links directly to Discover with that pattern and those columns explicitly selected, rather than the whole `_source` document. Dashboards stores its own configuration in OpenSearch, never in the source database. This adds an inspection tool only: it does not provide pipeline controls, lag reporting, DLQ handling, failure simulation, or evidence for the assignment's failure gates.

## Operator API foundation (issue #29)

Issue #29 authorizes a separate NestJS operator API as the first part of #28.
It exposes status, replication start/stop, configuration, DLQ inspection/replay,
and the gate-owned rejected-record simulation through a typed HTTP client.
The [operator API contract](docs/operator-api.md) defines the wire shapes and
runtime validation. Gate/metrics work owns metric definitions, supported settings,
processing controls and the G4 mechanism. None exists in the current replicator;
missing or unreachable integrations return explicit unavailable reasons.

The API starts independently of the replicator and destinations. Each configured
status request makes one upstream call with a two-second deadline; it does not poll,
cache, retry, calculate metrics or replace missing values with zero. Only a valid
available status gets a successful-response timestamp. Mutations require confirmed
completion; a timeout or an accepted-but-unfinished response is not success.
Configuration writes validate against the backend's freshly advertised settings;
the backend remains responsible for validating its domain constraints on application.

This foundation does not change the replicator's startup, finite polling, shutdown
or serial append-only writer rules. It adds no persisted progress, recovery,
processing retries or DLQ mechanism, and does not emulate graceful controls with
container commands. Process controls, operation tracking, Angular and Compose
integration are separate subtickets #30–#32. Contract tests are not failure-gate
evidence.

## Operator process controls (issue #30)

The operator API accepts source generation and four fixed container actions.
One adapter invokes Docker Compose with argument arrays for a configured project,
Compose file and project directory. Generation validates the existing writer's
count/rate limits and reports success only after exit zero and confirmation of the
requested inserted count. Earlier commits remain on failure. Container actions use
SIGKILL/restart for the replicator and stop/start for OpenSearch; completion confirms
Docker's command, not service health or persisted resume.

These commands return HTTP 202 and an in-memory operation ID. GET by ID reports
pending, succeeded or failed, timestamps and a bounded output tail. The API keeps
100 recent operations. Restarting the API loses tracking and does not cancel or
resume writer containers. Confirm external writer activity before another write;
the serial-writer rule still applies to external seed/append/generate commands.

Operator commands lock writer, replicator or OpenSearch resources; conflicts return
HTTP 409. Graceful replication/configuration calls share the replicator lock,
replay shares replicator/OpenSearch locks, and G4 shares all three. No gate behavior
is implemented here. Docker packaging follows in #32.

## Operator page (issue #31)

The Angular operator is one page with status, controls, DLQ and simulation panels.
It uses only relative `/api` requests, with a development proxy to the operator API.
Status polls every two seconds, skips ticks while a request is active, and times
out requests after two seconds. Last successful values and timestamps survive
errors only with a visible stale marker. Missing measurements remain unavailable.
Supported configuration and DLQ pages are fetched on demand; only advertised
settings appear. Gate controls are disabled when no current status is available.

Source and container commands are tracked through their operation IDs. Related
controls stay disabled until a confirmed outcome; lost operation status leaves
pending controls disabled and displays a tracking error. The page makes no health
or resume claim from a completed Docker command. Docker integration follows in #32.

## Boundaries and future work

This v0.5 makes no claim about recovery, complete delivery, duplicates, concurrent updates, or behavior when a destination fails. It has no checkpoints, retry policy, DLQ mechanism, live gate metrics, or `make verify`. The operator page exposes available integrations and explains missing ones. Do not describe the visible happy path as proof of any failure gate.

Later versions must decide how source changes are captured; how progress and delivery are made recoverable; how rejected records are handled; and how the UI and `make verify` demonstrate the assignment's requirements. Record those decisions when there is enough evidence to make them, including changes prompted by experiments.
