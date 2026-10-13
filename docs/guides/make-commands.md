# Make commands

Run commands from the repository root. You need GNU Make, Docker with Linux
containers, Compose v2, and Node.js 24. On Windows, run Make in WSL and add
`NODE=node.exe` to commands that launch Node. `make` or `make help` prints the
short command list.

## Complete runs

```sh
make init
# Set POSTGRES_PASSWORD and RABBITMQ_PASSWORD in .env.
make run
```

`make run` builds the applications, starts infrastructure, seeds an empty source,
starts replication and the consumer, then appends traffic after the startup
boundary is captured. It keeps existing data and collects logs until Ctrl+C;
the services remain available for inspection. Configure demo size and rate in
`.env`. See the [demo report guide](demo-report.md) for outcome checks and timing.

| Command | What it does |
| --- | --- |
| `make init` | Copies `.env.example` to `.env` only if `.env` is missing. Set both passwords before starting services. |
| `make run` | Runs the complete demo with existing data and checkpoints retained. |
| `make run-fresh` | Deletes the demo project's containers and data volumes, then runs a fresh demo. `make fresh-run` is an alias. |
| `make reset` | Deletes the demo project's containers and all data volumes, including source history, indexes, checkpoints, and receipts. Keeps saved host logs and configuration. |
| `make verify` | Runs G1 and then G2 in separate isolated projects. Returns failure if either fails; interruption stops the run. |
| `make verify-g1` | Runs the single-crash recovery scenario. |
| `make verify-g2` | Runs the scheduled initial/incremental crash scenario. |

Verification uses `.env.verify`, saves evidence under `logs/verify-g1/` or
`logs/verify-g2/`, and removes its isolated services and volumes after each run.
It does not reset the regular demo project. See the
[verification guide](../../scripts/verification/README.md) for configuration and
[G1](../../G1.md) / [G2](../../G2.md) for the proofs.

## Start and control services

| Command | What it does |
| --- | --- |
| `make build` | Builds replicator, consumer, and source-writer images. Limit it with `SERVICES='replicator consumer'`. |
| `make postgres` | Starts PostgreSQL and waits until healthy. |
| `make infra` | Starts PostgreSQL, OpenSearch, RabbitMQ, and Dashboards; configures Discover. |
| `make dashboards` | Starts OpenSearch and Dashboards; configures Discover. |
| `make up` | Starts replicator and consumer. Override with `SERVICES='consumer'`. |
| `make restart` | Restarts the replicator with its saved checkpoint. Override with `SERVICES='consumer'`. |
| `make stop` | Stops all services, retaining containers and volumes. Limit it with `SERVICES='replicator consumer'`. |
| `make down` | Removes containers and the network, retaining data volumes. |
| `make status` | Lists containers, including completed jobs. |
| `make logs` | Follows replicator and consumer logs. Choose services with `SERVICES='consumer'` and recent lines with `TAIL=100` (default 30). |

`restart` keeps the container's existing configuration; changed settings need
container recreation. `COMPOSE` can override the Compose invocation, for example
`make status COMPOSE='docker compose -p my-demo'`. Reset and inspection commands
apply to that selected project.

## Write sample source events

Start infrastructure first. The source writer alone modifies PostgreSQL; the
replicator only reads it. Keep one serial writer active at a time.

| Command | What it does |
| --- | --- |
| `make seed` | Builds the source writer and seeds using `DEMO_SEED_SHIPMENTS` from `.env`. Override with `SEED_ARGS='--shipments 100'`. |
| `make generate COUNT=50 RATE=10` | Builds the writer and appends 50 event rows at 10 events per second. Defaults: `COUNT=500`, `RATE=20`. |
| `make append ID=101 STATUS=created` | Appends one event for shipment 101. Supply `STATUS`; statuses are `created`, `in_transit`, `delivered`, or `cancelled`. Requires the source-writer image. |

Seed size counts **shipments**; generated traffic counts **event rows**. Seeding
keeps existing rows and adds missing sample IDs. Append assigns the next event
ID and shipment version; it does not enforce status transitions. Complete seeding
before generating traffic to avoid inserting behind saved cursors. See the
[source guide](development.md#source-seed) for the deterministic fixture.

A manual run gives control over each step:

```sh
make build
make infra
make seed SEED_ARGS='--shipments 100'
make up
make generate COUNT=50 RATE=10
make logs
```

Each replicator process waits for its first incremental activity before counting
empty polls, then stops polling after its configured idle window. It finishes
the initial load before exiting. Generate later traffic before that window ends,
or restart the replicator to pick it up. [SPEC.md](../../SPEC.md) defines the rules.

## Inspect results

| Command | What it shows |
| --- | --- |
| `make history ID=1` | PostgreSQL history for shipment 1, ordered by version. |
| `make shipment ID=1` | The current OpenSearch document for shipment 1. |
| `make counts` | Source event and distinct shipment counts, then the indexed shipment count. |
| `make queue` | RabbitMQ ready messages, unacknowledged messages, and consumer counts. |

`ID` defaults to 1 and must contain decimal digits. The internal `check-id`
target validates it for `append`, `history`, and `shipment`. Counts help inspect
progress; full payload comparisons in the verification scenarios establish
their stated results. Use [Discover](http://localhost:5601/app/discover) to browse
current shipment state, and the [log guide](run-logs.md) to inspect saved runs.
