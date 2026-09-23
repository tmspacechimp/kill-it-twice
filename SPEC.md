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

NestJS/TypeScript is the intended replicator stack. Keep the consumer small; its framework is an implementation choice, not a product requirement. The sample record shape and specific names for the index, queue, and services can be set during implementation and recorded here when they matter.

## Boundaries and future work

This v0 makes no claim about recovery, complete delivery, duplicates, concurrent updates, or behavior when a destination fails. It has no incremental sync, checkpoints, retry policy, DLQ, observability UI, or `make verify`. Do not describe the visible happy path as proof of any failure gate.

Later versions must decide how source changes are captured; how progress and delivery are made recoverable; how rejected records are handled; and how the UI and `make verify` demonstrate the assignment's requirements. Record those decisions when there is enough evidence to make them, including changes prompted by experiments.
