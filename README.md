# Kill It Twice

A local shipment replication demo. A NestJS replicator reads event history from a client-like PostgreSQL database, keeps each shipment's latest state in OpenSearch, and publishes every event to RabbitMQ. An independent consumer logs events and records their IDs to detect replays.

```text
PostgreSQL shipment events ──> NestJS replicator ──> OpenSearch ──> Dashboards
                                  │                      (current state)
                                  ├──> RabbitMQ ──> consumer logs
                                  │                    │
                                  │                    └──> SQLite receipts
                                  └──> SQLite checkpoints
```

**Submission scope:** G1, replicator crash and resume, is implemented and has a recorded passing run. G2–G5 are not implemented or claimed. The assignment's operator UI is not built; OpenSearch Dashboards is for inspecting indexed shipments. See [G1: recovery and evidence](G1.md) for the crash point, assertions, and limits.

## Run the demo

Use Docker with Linux containers, Compose v2, GNU Make, and at least 4 GB of Docker memory. Set `vm.max_map_count >= 262144` on the Docker Linux host for OpenSearch. On Windows, run Make in WSL. From the repository root:

```sh
make init
```

Set `POSTGRES_PASSWORD` and `RABBITMQ_PASSWORD` in the new `.env` file. Then run:

```sh
make build
make infra
make seed
make up
make logs
```

Seed **before** starting the replicator. The default seed creates 10,000 events for 4,000 shipments. The replicator captures those rows as its initial load and waits for later events. In another terminal, run `make generate COUNT=500 RATE=20` to supply them. Once incremental activity begins, polling stops after three consecutive empty reads by default; a later run is needed to pick up events added after that stop.

Inspect the result with `make history ID=1`, `make shipment ID=1`, and `make counts`. For a fresh default seed, shipment 1 ends at version 3, `delivered`. [OpenSearch Dashboards Discover](http://localhost:5601/app/discover#/?_a=%28columns%3A!%28shipment_id%2Cversion%2Cstatus%2Cid%2Coccurred_at%29%2Cindex%3Ashipments%29) shows current records after indexing; use the configured port if it differs from 5601. The [development guide](docs/development.md) has optional commands, configuration, and troubleshooting.

## Verify G1

With Node.js 24 and Docker Compose available, run:

```sh
make verify
```

This creates an isolated Docker project, appends events during initial loading, kills the replicator after a confirmed publication but before its checkpoint, then restarts it. It checks saved and resumed progress, an explicit duplicate detection, every source event against consumer logs, and every shipment's latest OpenSearch document. It prints `G1 PASS` only when those assertions and cleanup succeed; errors print `G1 FAIL` and exit nonzero. [G1.md](G1.md) explains the evidence. A [recorded passing run](docs/validation-history.md#rabbitmq-startup-fix-and-live-g1-duplicate-proof--2026-09-30) used the default 10,000-event fixture; running the command again is the current check.

## Limits and further reading

Delivery is **at least once across a replicator process crash** while PostgreSQL, destination services, and checkpoint volumes survive. An event published before its checkpoint may be sent again; the consumer's durable receipt detects the repeated ID. Indexing and publication are separate operations. The RabbitMQ queue and messages are not durable, and a consumer crash between receipt commit and logging can omit a normal log. The source must have one serial, append-only writer with IDs increasing in commit order, and each state volume has one application owner. This is finite polling, not continuous synchronization; there is no automatic destination recovery, DLQ, or operator UI.

The [current design](SPEC.md) explains those boundaries. [Submission notes](docs/submission-notes.md) record architectural choices, capacity evidence, omissions, AI-related corrections, and the status of all five gates. The [development guide](docs/development.md) covers operation, while the [verification guide](scripts/verification/README.md) maps G1 assertions to code. The [original assignment](docs/optio-assignment-faithful-en.md) describes the broader target.
