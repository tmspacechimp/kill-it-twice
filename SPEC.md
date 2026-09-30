# Kill It Twice — current design

## Purpose and scope

This repository demonstrates a shipment event pipeline with an initial load, finite incremental polling, a current-state search index, and an independent event consumer. G1 verifies recovery from a replicator process crash under the assumptions below. G2–G5 and the operator UI remain outside the implemented scope. [G1.md](G1.md) explains the recovery proof; [submission notes](docs/submission-notes.md) record tradeoffs and omissions. Earlier versions of this specification remain in Git history.

## Components and source contract

The source writer alone creates sample data and appends later events to PostgreSQL. The source is client-like: neither application stores checkpoints, receipts, or other internal state there. The NestJS/TypeScript replicator reads PostgreSQL through read-only connections and sends each event to OpenSearch and RabbitMQ. A separate TypeScript consumer receives messages and logs them. OpenSearch Dashboards displays current shipment records; it does not control the pipeline.

The source table `shipment_status_events` contains an integer event `id`, integer `shipment_id`, positive integer `version`, status, and occurrence time. Status is one of `created`, `in_transit`, `delivered`, or `cancelled`. Event IDs identify history entries; a unique shipment/version pair orders each shipment's state. Events are immutable and append-only by writer convention. `make seed` creates a deterministic sample, while `make generate` and `make append` add later events through one serial writer. See the [development guide](docs/development.md#source-seed) for schema, fixtures, and commands.

Correct cursor discovery assumes one serial writer that commits each event before starting the next, with event IDs increasing in commit order. Concurrent writers can commit lower IDs after higher ones; this design can miss those rows. Updating or deleting existing events is outside the source contract.

## Concurrent reading and finite polling

On the first start without a checkpoint, the replicator saves the highest committed source event ID as the initial boundary. Existing rows through that boundary form a bounded initial load. A second reader immediately polls for rows above the boundary, while the initial reader continues. Each reader fetches at most 1,000 ordered rows at a time and processes them sequentially. Both can have one event in flight, so publication order across the readers is not guaranteed. If the source table is empty, initial loading finishes immediately; a missing table is an error.

Each process waits indefinitely for its **first** incremental rows. Empty reads during that wait do not count. After the first nonempty read, `POLL_MAX_EMPTY` consecutive empty reads end polling; any new rows reset the count. The default is three empty reads, separated by `POLL_INTERVAL_MS` (default one second). Polling can finish before initial loading, but the process finishes the bounded initial dataset before exiting. Once polling stops, later rows wait for another replicator run. This is finite polling, not continuous synchronization.

## Destinations and progress

For each event, the replicator first writes the shipment document to OpenSearch, then publishes the full event to RabbitMQ and awaits broker confirmation. OpenSearch uses shipment ID as the document ID and the source shipment version as an external version. Only a higher version replaces the current document. A recognized equal or older version conflict still leads to publication; other destination errors stop the process. Every event is published, including one replayed after a crash. There is no atomic transaction spanning the index, broker, and checkpoint.

The replicator stores its startup boundary, initial cursor and completion flag, and incremental cursor in SQLite on a dedicated persistent volume. It saves each reader's cursor only after that event's index operation and confirmed publication. The readers update their own cursors independently. A restart retains the original boundary, resumes unfinished initial rows after the saved initial cursor, and resumes polling after its saved incremental cursor. Each restarted process waits anew for incremental activity before counting empty polls. Failed or corrupt checkpoint storage stops the process; progress is not silently reset.

An interruption between destination work and cursor commit can replay the event. OpenSearch's version check prevents an older or repeated event from replacing newer shipment state. The RabbitMQ queue and messages are non-durable, so broker loss is not covered by the process-crash guarantee.

## Consumer receipts

The consumer stores processed event identities in its own SQLite database and persistent volume, separate from the replicator checkpoint. Identity combines the fixed consumer and source names with the source event ID; different events for one shipment remain distinct. For a valid event, a conflict-aware insert records an unseen ID and identifies a repeated one. New events produce a full `Received event` log; repeats produce an explicit duplicate log. The consumer acknowledges a message after the receipt operation and log call. Errors stop the process with the current delivery unacknowledged.

The receipt commits before console output. A consumer crash in that gap can omit the normal log, and redelivery may produce only a duplicate log. Receipts are not a transactional business effect or exactly-once logging guarantee. They must be retained with the same source history; the replicator does not access them.

## Guarantee and limits

Under a single serial, append-only source writer, one replicator per checkpoint volume, one consumer per receipt volume, and intact source, destination services, and volumes, the pipeline provides **at-least-once processing across replicator process interruption**. G1 injects a crash after confirmed publication and before checkpointing, then checks replay, resumed cursors, complete event logs, and current shipment documents. [G1.md](G1.md) states exactly what the test proves.

There is no automatic retry or reconnect for destination outages, no durable broker stream, no DLQ or rejected-record replay, no continuous incremental service, and no operational control UI. The current test does not establish recovery from broker or disk loss, consumer crash, concurrent source writers, or exactly-once delivery. See [submission notes](docs/submission-notes.md) for gate status and capacity evidence.
