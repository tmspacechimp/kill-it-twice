# Data Replication Pipeline — Project Brief

## Context

The platform ingests records from a client's relational database and distributes them to two destinations: a search index used for segmentation and an event stream consumed by services such as campaigns and analytics. The search index represents the current state of each record; the event stream carries changes.

The system must handle large datasets and remain understandable and recoverable when processes or destinations fail. It should be operable locally through Docker Compose, with a UI for inspection and control.

## Functional requirements

### Data flow

- Read from a relational source using two concurrent modes: an initial backfill and continuous incremental synchronization at a configurable interval.
- Write searchable current-state records to a search index and publish changes to an event stream with at least one independent consumer.
- Support data volumes that make full in-memory loading impractical. Document the chosen volume and its rationale.

### Failure behavior

- **Process interruption:** If the replicator is killed during a load, it must resume from its recorded progress without losing records or restarting the entire load.
- **Duplicate processing:** Restarts must not create harmful duplicate outcomes. State the actual delivery guarantee and demonstrate it.
- **Destination outage:** If the search index stops during processing, retain the work, avoid a busy loop, and recover automatically when it returns.
- **Partial batch rejection:** If three of 500 records are rejected, write the other 497 and put the rejected three in a DLQ with enough context to replay them. Do not discard or roll back the successful records.
- **Operational visibility:** Metrics, logs, and the UI must reveal load progress, current throughput, incremental lag, DLQ count, and system health without requiring code inspection.

### UI

Provide a functional interface for an unfamiliar operator to:

1. Inspect pipeline status, progress, throughput, lag, DLQ count, and health.
2. Browse and search replicated records, view details, and see changes in real time.
3. Start and stop loading, configure parameters, and replay DLQ entries.
4. Simulate destination outages, bad records, and source changes.

The UI need not have production-grade visual polish.

## Reproducible operation and evidence

- `docker compose up` starts the full local system.
- `make seed` generates source data at a documented scale.
- `make verify` runs five executable scenarios: interruption and resume, duplicate handling, destination outage and recovery, partial batch rejection, and observability. It reports PASS or FAIL for each with concrete evidence. If a scenario cannot pass, report FAIL and explain it.
- Document setup, data flow, checkpoint and DLQ locations, delivery guarantee, architectural choices and trade-offs, measured throughput, bottlenecks, capacity recommendations, and known omissions.

## Technology constraints

The platform commonly uses NestJS, Angular, RabbitMQ, Redis, Elasticsearch, Docker, S3, ClickHouse, and Apache NiFi, but equivalent tools may be used when appropriate. The selected implementation and its phased scope are recorded in [`../SPEC.md`](../SPEC.md); this brief describes the broader target, not a claim that every requirement is already implemented.
