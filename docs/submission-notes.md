# Submission notes

These notes collect decisions and evidence that would obscure the [reviewer entry point](../README.md). The [current design](../SPEC.md) is the operating contract; [G1.md](../G1.md) explains recovery. The [original assignment](optio-assignment-faithful-en.md) asks for a broader system than this submission implements.

## Architectural decisions

| Decision | Alternative considered | Tradeoff |
| --- | --- | --- |
| Keep the client-like PostgreSQL source read-only to applications; use separate SQLite volumes for replicator checkpoints and consumer receipts. | Put application state in the source database. | Preserves source ownership and isolates progress, but each volume must survive container replacement and remain paired with its source history. |
| Capture one startup event-ID boundary and use two bounded readers, one for the initial dataset and one for newer events. | Hold a long source transaction or load the whole source into memory. | A fixed boundary and small reads bound memory and allow overlap. Correct discovery requires one serial writer whose IDs rise with commits. |
| Index by shipment ID using external shipment versions, then publish each event through a RabbitMQ confirm channel. | Track latest versions in replicator memory or treat event ID as shipment order. | Older or replayed events cannot replace newer shipment state; index and broker writes remain separate, and a crash can publish again. |
| Commit a checkpoint after each confirmed event. | Checkpoint only after each batch. | Restarts redo less work, at the cost of one durable write per event. A crash before the commit can still replay the event. |
| Give the consumer its own durable identity receipt and acknowledge after handling. | Rely on broker acknowledgements or in-memory IDs. | Duplicate IDs remain detectable across consumer restarts while the volume survives. Receipt commit and console logging are not atomic. |

## Capacity notes

The default fixture is 4,000 shipments and 10,000 events. It is large enough to cross ten 1,000-row source batches, but it is not evidence of million-row throughput. A 40,000-shipment generator setting yields 100,000 events; tests generated that fixture, but the full Docker G1 scenario was not run at that size. The [validation history](validation-history.md#shared-seed-size-environment--2026-09-30) records a G1 PASS with 2,503 initial events plus 18 generated events, and the [default-size G1 run](validation-history.md#rabbitmq-startup-fix-and-live-g1-duplicate-proof--2026-09-30) compared all 10,018 events and 4,006 shipment documents.

There is no comparable measured end-to-end throughput for the current pipeline. An older customer-data run took about 111 seconds for 10,000 records, but it predates the shipment pipeline and its checkpoints, so it is not a current capacity measurement. Sequential indexing, broker confirmation, and durable checkpoint writes per event are plausible bottlenecks; their individual costs have not been measured. To target twice the throughput, first measure stage latency and resource use on a representative shipment fixture. Batching checkpoint commits could reduce disk work but increases replay after a crash; concurrent destination work would need a careful cursor and ordering design. No doubling claim is made. [G1.md](../G1.md#concerns) covers the receipt and checkpoint write cost.

## What I did not build and why

The implementation concentrates on a reproducible G1 process-crash proof. G2 would require a separate executable duplicate-outcome check across repeated kills and restarts; G1 proves one specific replay and consumer detection. G3 destination-outage recovery would require a retry and reconnection policy. G4 partial rejection needs independent record outcomes and a durable DLQ with replay. G5 operational visibility needs metrics and an operator UI. These systems are absent, so Dashboards inspection and healthy containers must not be mistaken for those gates. The current finite polling session also does not meet the assignment's continuous synchronization target. Broker messages are non-persistent, and the pipeline does not rebuild lost destination state.

| Gate | Status | Evidence or missing work |
| --- | --- | --- |
| G1: replicator interruption and resume | PASS in a recorded isolated run | Forced crash after confirmed publication, retained cursors, observed duplicate, full source/log and index comparisons; see [G1.md](../G1.md). |
| G2: no harmful duplicate outcomes | Unsupported as a separate gate | G1 observes one replay, one duplicate receipt, and correct final state; repeated kills and destination effects are not separately verified. |
| G3: destination outage and recovery | Unsupported | No automatic retry or reconnect, and broker durability is outside the G1 guarantee. |
| G4: partial batch failure | Unsupported | No per-record rejection handling or DLQ. |
| G5: observability | Unsupported | Logs and Dashboards inspection do not supply the required progress, lag, throughput, DLQ, and health view. |

`make verify` runs G1 only. The G1 status above is a [recorded result](validation-history.md#rabbitmq-startup-fix-and-live-g1-duplicate-proof--2026-09-30), not a claim that every future environment will pass.

## Where AI-assisted work diverged from the intended behavior

The validation history records two concrete corrections made during the AI-assisted implementation. It establishes the faulty behavior and fix; it does not identify an individual line of AI output or preserve a prompt transcript, so these are described as reviewed implementation deviations rather than invented quotations.

1. **RabbitMQ readiness.** The requested G1 run needed a working broker. The first health probe ran `rabbitmq-diagnostics` as root and created a cookie the RabbitMQ user could not read, so startup failed before replication. The probe was changed to run as the server account after reproducing both behaviors in disposable containers. See the [recorded startup fix](validation-history.md#rabbitmq-startup-fix-and-live-g1-duplicate-proof--2026-09-30).
2. **Crash injection.** G1 required a real process death after broker confirmation. The first self-`SIGKILL` attempt did not terminate Node when it was container PID 1, so it could not prove restart behavior. A disposable container reproduced the issue; the verification replicator was run under Docker's init process, and the next isolated run observed exit 137 and an explicit duplicate. See the [same run record](validation-history.md#rabbitmq-startup-fix-and-live-g1-duplicate-proof--2026-09-30).

A separate earlier G1 run completed with zero duplicate logs. That result was insufficient for a duplicate-handling claim, so the crash point and assertions were strengthened to require a known published event to replay. The [validation history](validation-history.md#readable-g1-scenario--2026-09-30) and [G1 explanation](../G1.md) preserve the before-and-after evidence.
