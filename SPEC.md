# Kill It Twice — current design

## Purpose and scope

This repository demonstrates a shipment event pipeline with an initial load, finite incremental polling, current-state and event-history search indexes, and an independent event consumer. G1 verifies recovery from a replicator process crash under the assumptions below. A [G2 verification case](docs/verification/g2-verification.md) checks multiple scheduled replicator crashes with retained volumes and surviving destinations; consumer-crash recovery and the complete G2 epic remain outside this case. G3–G5 and the operator UI remain outside the implemented scope. [G1.md](G1.md) and [G2.md](G2.md) explain the recovery proofs; [submission notes](docs/project/submission-notes.md) record tradeoffs and omissions. Earlier versions of this specification remain in Git history.

## Components and source contract

The source writer alone creates sample data and appends later events to PostgreSQL. The source is client-like: neither application stores checkpoints, receipts, or other internal state there. The NestJS/TypeScript replicator reads PostgreSQL through read-only connections and sends each event to OpenSearch and RabbitMQ. A separate TypeScript consumer receives messages and logs them. OpenSearch Dashboards displays current shipment records; it does not control the pipeline.

The source table `shipment_status_events` contains an integer event `id`, integer `shipment_id`, positive integer `version`, status, and occurrence time. Status is one of `created`, `in_transit`, `delivered`, or `cancelled`. Event IDs identify history entries; a unique shipment/version pair orders each shipment's state. Events are immutable and append-only by writer convention. `make seed` creates a deterministic sample, while `make generate` and `make append` add later events through one serial writer. See the [development guide](docs/guides/development.md#source-seed) for schema, fixtures, and commands.

Correct cursor discovery assumes one serial writer that commits each event before starting the next, with event IDs increasing in commit order. Concurrent writers can commit lower IDs after higher ones; this design can miss those rows. Updating or deleting existing events is outside the source contract.

## Concurrent reading and finite polling

On the first start without a checkpoint, the replicator saves the highest committed source event ID as the initial boundary. Existing rows through that boundary form a bounded initial load. A second reader immediately polls for rows above the boundary, while the initial reader continues. Each reader fetches at most 1,000 ordered rows at a time and processes them sequentially. Both can have one event in flight, so publication order across the readers is not guaranteed. If the source table is empty, initial loading finishes immediately; a missing table is an error.

Each process waits indefinitely for its **first** incremental rows. Empty reads during that wait do not count. After the first nonempty read, `POLL_MAX_EMPTY` consecutive empty reads end polling; any new rows reset the count. The default is three empty reads, separated by `POLL_INTERVAL_MS` (default one second). Polling can finish before initial loading, but the process finishes the bounded initial dataset before exiting. Once polling stops, later rows wait for another replicator run. This is finite polling, not continuous synchronization.

## Destinations and progress

For each event, a composite indexer writes the current shipment state to `shipments`, then appends the full event to `shipment-records`. The state index uses shipment ID as the document ID and the source shipment version as an external version; only a higher version replaces the current document. The state indexer catches and logs a recognized equal or older version conflict, then allows the history append. OpenSearch assigns a new history document ID for each delivery, preserving intermediate events and duplicates. Other state errors and all history errors stop processing before publication and checkpoint advancement.

After both index operations succeed, the replicator publishes the full event to RabbitMQ and awaits broker confirmation. The two index writes, broker publication, and checkpoint are not atomic. A crash can leave only the state write completed, or history recorded without publication; an uncheckpointed event is replayed. History documents are delivery evidence, not duplicate shipment effects. Existing checkpoints do not backfill events processed before the history index was introduced; complete-history verification starts with a fresh isolated environment.

The replicator stores its startup boundary, initial cursor and completion flag, and incremental cursor in SQLite on a dedicated persistent volume. It saves each reader's cursor only after that event's index operation and confirmed publication. The readers update their own cursors independently. A restart retains the original boundary, resumes unfinished initial rows after the saved initial cursor, and resumes polling after its saved incremental cursor. Each restarted process waits anew for incremental activity before counting empty polls. Failed or corrupt checkpoint storage stops the process; progress is not silently reset.

An interruption between destination work and cursor commit can replay the event. OpenSearch's version check prevents an older or repeated event from replacing newer shipment state. The RabbitMQ queue and messages are non-durable, so broker loss is not covered by the process-crash guarantee.

## Consumer receipts

The consumer stores processed event identities in its own SQLite database and persistent volume, separate from the replicator checkpoint. Identity combines the fixed consumer and source names with the source event ID; different events for one shipment remain distinct. For a valid event, a conflict-aware insert records an unseen ID and identifies a repeated one. New events produce a full `Received event` log; repeats produce an explicit duplicate log. The consumer acknowledges a message after the receipt operation and log call. Errors stop the process with the current delivery unacknowledged.

The receipt commits before console output. A consumer crash in that gap can omit the normal log, and redelivery may produce only a duplicate log. Receipts are not a transactional business effect or exactly-once logging guarantee. They must be retained with the same source history; the replicator does not access them.

`make verify` runs G1 and G2 sequentially in separate isolated projects; `make verify-g1` and `make verify-g2` run them individually. Both have independent settings with shared seed and timeout defaults. G2 schedules initial and incremental crashes, including repeated IDs, after confirmed publication and before checkpointing; it validates each crash before advancing. Only the replicator is recreated, retaining its checkpoint volume and surviving destinations and consumer. Traffic is supplied for the first incremental target and while stopped before the final restart, preserving the polling rules. The [G2 case guide](docs/verification/g2-verification.md) defines configuration, comparisons, and evidence. This finite case does not establish exactly-once delivery or complete G2.

## Guarantee and limits

Under a single serial, append-only source writer, one replicator per checkpoint volume, one consumer per receipt volume, and intact source, destination services, and volumes, the pipeline provides **at-least-once processing across replicator process interruption**. G1 injects a crash after confirmed publication and before checkpointing, then checks replay, resumed cursors, complete event logs, current shipment documents, and full OpenSearch event-history coverage including the replay. [G1.md](G1.md) states exactly what the test proves.

There is no automatic retry or reconnect for destination outages, no durable broker stream, no DLQ or rejected-record replay, no continuous incremental service, and no operational control UI. The current test does not establish recovery from broker or disk loss, consumer crash, concurrent source writers, or exactly-once delivery. See [submission notes](docs/project/submission-notes.md) for gate status and capacity evidence.

## Logged runs

`make run` builds the applications, starts infrastructure, seeds an empty source,
starts the applications, and appends configured incremental events after the
replicator has captured its startup boundary. Existing history and state are
retained; an active writer or replicator prevents a new run. Logs are collected
until Ctrl+C, leaving regular services available for inspection. After successful
replicator exit, the demo checks generated traffic, complete consumer receipt
coverage, current-run payloads, and latest shipment documents. It saves counts,
checks, and wall-clock timings in `report.json` and the summary. This validates
the observed demo outcome; G1 remains the crash-recovery scenario.

`make reset` removes the current Compose project's containers and data volumes,
including source history, both indexes, checkpoints, and receipts. `make run-fresh`
resets first, then runs the demo. Both retain saved host logs and configuration.

Demo runs use DEMO_SEED_SHIPMENTS and DEMO_INCREMENTAL_EVENTS from `.env`;
G1 and G2 use their own settings from `.env.verify`. The replicator's polling and
recovery rules remain unchanged. Demo logs are size-limited; verification evidence
is retained until deleted. Collection or cleanup failures prevent scenario PASS.
[Run-log details](docs/guides/run-logs.md) explain configuration, saved evidence, and
incomplete runs.
