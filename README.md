# Kill It Twice

**[G1 recovery proof](G1.md): how checkpoints, the injected crash, and duplicate detection are verified.**

A local shipment replication demo: a NestJS/TypeScript replicator reads PostgreSQL events, stores each shipment's latest status in OpenSearch, and publishes every event to RabbitMQ. A separate consumer logs the events.

On the first startup, existing rows become the initial load. The replicator processes them while polling for later events concurrently. Durable checkpoints let later runs resume both readers. Each process waits for its first new incremental rows without an idle limit, then stops after three consecutive empty reads by default; it exits once initial loading also finishes. This assumes one serial source writer whose event IDs increase with commits and one replicator process. OpenSearch Dashboards provides shipment inspection; the assignment's operator UI is not implemented.

## Run

Use Docker with Linux containers, Compose v2 (`docker compose`), and GNU Make. On Windows, run these commands in WSL from the repository root. Allow at least 4 GB of Docker memory and set `vm.max_map_count >= 262144` on the Docker Linux host.

Create your local configuration if it does not already exist:

```sh
make init
```

Set `POSTGRES_PASSWORD` and `RABBITMQ_PASSWORD` in `.env`. Adjust the host ports there if the defaults are occupied. `SEED_SHIPMENTS` in the same file controls the initial fixture for both `make seed` and G1: 4000 gives 10,000 events; 40000 gives 100,000. The replicator discovers the boundary from the database. Then start and seed the system:

```sh
make build
make infra
make seed
make up
make logs
```

`make seed` builds and runs a separate source-writer CLI against running PostgreSQL. A fresh seed creates 10,000 events for 4,000 shipments. Use `make seed SEED_ARGS="--shipments 3"` for a smaller initial fixture. Seed before starting the replicator: a missing table fails, and an empty table means zero initial rows. Reads are bounded to 1,000 rows per reader. Set `POLL_INTERVAL_MS` (default 1000) and `POLL_MAX_EMPTY` (default 3) in `.env` to control polling. Startup empty reads do not count. The empty counter becomes active after the first incremental rows arrive; later nonempty reads reset it. If no new rows ever arrive, polling stays active until stopped manually.

`make infra` waits for healthy PostgreSQL, OpenSearch, RabbitMQ, and Dashboards,
then creates the Discover pattern and columns. Commands run from a WSL shell;
`make` alone lists the available targets. Ctrl+C leaves `make logs` without
stopping the applications. Logs show the last 30 lines per service by default;
use `make logs TAIL=all` for the complete run.

Build or run individual components or groups:

```sh
make build SERVICES=replicator
make up SERVICES=consumer
make up SERVICES="replicator consumer"
make logs SERVICES=replicator
make stop SERVICES="replicator consumer"
```

`make up` starts dependencies as needed but does not seed or rebuild images.
Use `make postgres` for the source alone, or `make dashboards` for inspection
without the applications. After a code change, build the affected app and run
`make up SERVICES=replicator` to recreate it. `make restart` resumes saved progress
with the existing image. An interrupted event may be published again.

## Generate live traffic

The source writer has two main commands: `make seed` for the initial fixture,
and `make generate` for a stream of new events:

Start generation in another terminal whenever you are ready: the replicator
waits for its first incremental rows. After traffic has started, the empty-poll
limit applies. After `Polling stopped` appears, new rows require another
replicator run; it does not resume polling on its own.

```sh
make generate COUNT=500 RATE=20
make logs
```

This appends **500 events at a target of 20 events per second** (about 25 seconds,
plus build/startup time). Each event commits separately, so replication runs
while generation is in progress. Slower database writes lower the achieved
rate; the writer never sends concurrent writes or catch-up bursts.

Generation starts above the highest existing shipment ID and creates histories
in order: `created`, `in_transit`, `delivered`. COUNT counts events, so 500 creates
166 complete histories and one with two statuses. Every run creates new shipments.
The command prints each committed event and a final inserted count. Run one
writer at a time; finish initial seeding before generating. Ctrl+C stops generation
and retains committed events. RATE accepts integers from 1 to 1000.

Make defaults to COUNT=500 and RATE=20. The direct CLI equivalent is
`npm start --prefix apps/source-writer -- generate --count 500 --rate 20`
after building and setting PostgreSQL environment variables. Generation only
requires PostgreSQL; it does not start the replicator or consumer.

## Optional: append a specific status

While polling is still active (increase `POLL_MAX_EMPTY` for longer gaps between manual appends), use a new shipment (4001 is unused with the default fixture). Run each append only after the previous command finishes:

```sh
make append ID=4001 STATUS=created
make append ID=4001 STATUS=in_transit
make logs
```

Each command prints its committed event. Within subsequent polling cycles, consumer logs should show both `shipment.status` events for shipment 4001: version 1 `created` and version 2 `in_transit`. With exactly the default fixture, their event IDs are 10001 and 10002. Stop following logs with Ctrl+C, then inspect:

```sh
make history ID=4001
make shipment ID=4001
```

PostgreSQL retains both history rows; OpenSearch has one document for shipment 4001 with version 2 and status `in_transit`. If the shipment already exists, versions continue from its maximum; choose an unused positive shipment ID for this exact example. If polling has already stopped, restart the replicator to pick up these rows. Local CLI equivalent after building: `npm start --prefix apps/source-writer -- append 4001 created` with PostgreSQL environment variables set.

An ID cursor can miss events with concurrent transactions that commit out of ID order. Checkpoints cover replicator interruption; automatic retries and broker-loss recovery remain unimplemented. Consumer receipts detect replayed event IDs. This walkthrough checks the happy path; use the separate G1 check below for interruption evidence.

## Inspect

View shipment 1's latest status and the service states:

```sh
make shipment ID=1
make counts
make queue
make status
```

After the sample load, shipment 1 has version 3 and status `delivered`. OpenSearch contains 4,000 shipment documents.

Open [shipments in Discover](http://localhost:5601/app/discover#/?_a=%28columns%3A!%28shipment_id%2Cversion%2Cstatus%2Cid%2Coccurred_at%29%2Cindex%3Ashipments%29). Compose automatically creates the `shipments` index pattern without a time filter, so no manual setup or login is needed. The default table shows `shipment_id`, `version`, `status`, `id`, and `occurred_at` as columns. Search `shipment_id: 1` to inspect a sample shipment. If you override `DASHBOARDS_PORT`, use that port in the link. On first startup, wait for `make infra` to finish successfully; if the index has no documents yet, wait for replication and refresh Discover. See the [detailed walkthrough](docs/development.md#browser-inspection-with-dashboards).

Resume unfinished work and poll for later events:

```sh
make restart
```

Stop the system while retaining its data:

```sh
make down
```

## Checkpoint storage and G1

SQLite stores the original boundary, initial progress/completion, and incremental
progress in the dedicated `replicator-state` Docker volume. Each event advances
its cursor only after OpenSearch and RabbitMQ confirm success. Keep that volume
together with the source and destinations; `make down` preserves it. A completed
initial load is not repeated on restart. Use a fresh Compose project for a fresh
demo. Only one replicator may use a checkpoint volume at a time.

Run `make verify` with Node.js 24 installed to execute G1 in a separate, temporary
Docker project. It kills the replicator mid-load, recreates it, checks resumed
progress, verifies all source events against consumer logs, and compares every
latest shipment with OpenSearch. It also appends events during and after the
initial load. The check removes only its own containers and volumes and exits
nonzero on failure. G2–G5 are not implemented. On Windows, the script uses Docker
inside WSL; with Windows Node on the WSL path, use `make verify NODE=node.exe`.

For local execution outside Docker, set `CHECKPOINT_PATH` to a writable SQLite
file in an existing directory. No application state is written to PostgreSQL.
An interruption can cause duplicate publication before the cursor commits;
the consumer detects repeated IDs using its own durable receipts and logs duplicates explicitly.

The [G1 test reading guide](scripts/verification/README.md) maps each recovery
claim to its assertions and explains how to run the comparison checks without Docker.

## Consumer duplicate detection

The consumer owns a separate SQLite database in the `consumer-state` volume.
It attempts one `INSERT ... ON CONFLICT DO NOTHING RETURNING event_id` per
message, without a preliminary read. New IDs produce the usual `Received event`
log; repeats produce `Duplicate event received: sourceId=72; skipping`.
Different events for the same shipment remain distinct, regardless of arrival order.

Messages are manually acknowledged after the receipt commits and the log call
returns. Receipts survive consumer recreation and `make down`. Keep one consumer
process per volume and retain its receipts for the lifetime of this source history.
For local execution, set `RECEIPT_PATH` to a writable SQLite file in an existing
directory. No consumer state is stored in source PostgreSQL or read by the replicator.

A crash after receipt commit can prevent the normal log from appearing; a later
delivery then produces a duplicate log. This is durable duplicate detection, not
exactly-once console output. Storage or malformed-message errors stop the consumer
without acknowledging the affected message. No automatic retries or DLQ are added.

Run `npm test --prefix apps/consumer` for the focused receipt and handling tests.

## More

- [Detailed usage and development](docs/development.md): configuration, inspection, seeding, and tests.
- [Specification](SPEC.md): data model, behavior, and limitations.
- [Validation history](docs/validation-history.md): recorded runs and the customer-to-shipment change.
- [Project brief](docs/project-brief-en.md): broader assignment requirements.
