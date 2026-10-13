# Kill It Twice

A shipment replication demo: PostgreSQL event history goes through a NestJS
replicator into OpenSearch and RabbitMQ. A separate consumer logs events and
detects duplicates. [SPEC.md](SPEC.md) describes the design.

## Try it

You need Docker with Linux containers, Compose v2, GNU Make, and Node.js 24.
On Windows, run Make in WSL and add `NODE=node.exe`.
Give Docker at least 4 GB of memory and set `vm.max_map_count >= 262144`.

```sh
make init
# Set POSTGRES_PASSWORD and RABBITMQ_PASSWORD in .env.
make run
```

`make run` builds the apps, starts infrastructure, seeds the source, starts the
replicator and consumer, and generates incremental events after the replicator
has captured its startup boundary. It prints the log directory and collects
until Ctrl+C. Use `make logs` in another terminal to watch replication progress.
After replication finishes, a report is generated with checks, counts, and timings;
see [how the demo report works](docs/demo-report.md).
Existing data and checkpoints are kept; the seed setting applies to an empty source.

To start from scratch in one command:

```sh
make run-fresh
```

This deletes the current demo project's source data, index, checkpoints, and
consumer receipts before running. Saved logs and configuration are kept.
Use `make reset` to clear the demo without starting it.

Configure demo runs in `.env`:

```dotenv
DEMO_SEED_SHIPMENTS=4000
DEMO_INCREMENTAL_EVENTS=500
DEMO_INCREMENTAL_RATE=20
DEMO_LOG_MAX_BYTES=10485760
```

The seed count is **shipments** (4,000 produce 10,000 event rows); incremental
count is **event rows**, and rate is events per second.

Inspect with `make counts`, `make history ID=1`, `make shipment ID=1`, or
[Dashboards Discover](http://localhost:5601/app/discover). `make down` removes
containers and keeps data. The [Make command guide](docs/make-commands.md)
explains every command, its options, and when to use it.

## Check crash recovery

```sh
make verify
```

This runs G1 and G2 sequentially in separate isolated projects. Use
`make verify-g1` or `make verify-g2` to run one scenario. Configure seed sizes,
incremental batches, timeouts, and crash targets in [.env.verify](.env.verify);
the [verification guide](scripts/verification/README.md) links the settings and
evidence details. PASS requires all checks and cleanup to succeed.

[G1.md](G1.md) explains single-crash recovery; [G2.md](G2.md) explains repeated
initial and incremental crashes. G2 covers a scheduled replicator-crash case;
consumer-crash recovery, G3-G5, and the operator UI remain outside scope.

## Logs and manual runs

Demo logs live in `logs/demo/<run-id>/`, verification evidence in
`logs/verify-g1/<run-id>/` and `logs/verify-g2/<run-id>/`.
Start with `summary.json`; delete old run directories
when finished with them. Logs are ignored by Git. [Log guide](docs/run-logs.md)
covers the evidence files and retention.

For a manual run:

```sh
make build
make infra
make seed SEED_ARGS="--shipments 100"
make up
make generate COUNT=50 RATE=10
make logs
```

These commands give you control over each step and retain existing data.
See [development.md](docs/development.md) for inspection, custom configuration,
and troubleshooting, [scripts](scripts/README.md) for the command code,
or [submission notes](docs/submission-notes.md) for tradeoffs.
