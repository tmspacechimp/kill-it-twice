# Kill It Twice

A local data-replication project based on Optio's technical assignment. The initial implementation is an **initial-load proof of concept**; later versions will address incremental sync and the assignment's failure scenarios.

## Read first

- [`docs/optio-assignment-original-ka.md`](docs/optio-assignment-original-ka.md) — original Georgian handout, preserved verbatim.
- [`docs/optio-assignment-faithful-en.md`](docs/optio-assignment-faithful-en.md) — close English translation of the handout, including submission instructions.
- [`docs/project-brief-en.md`](docs/project-brief-en.md) — project-facing English brief of the technical problem, without the hiring-process instructions.
- [`SPEC.md`](SPEC.md) — evolving implementation scope and decisions. Start here before coding.
- [`AGENTS.md`](AGENTS.md) — instructions for coding agents working in this repository.

The original handout governs the assignment requirements. The project brief is an easier English reference for the technical problem. The spec records what this implementation currently intends to build; it will change as the project develops.

## Current state

Two independent applications are available:

- `apps/replicator`: NestJS/TypeScript initial PostgreSQL reader.
- `apps/consumer`: plain TypeScript application.

The replicator waits for seeded customers, reads one read-only snapshot in batches of at most 1,000, logs progress, then closes its database connection and Nest context and exits. The consumer remains a scaffold that prints its startup line and exits. OpenSearch indexing and RabbitMQ publication/consumption are not implemented yet.

## Build and run with Docker Compose

Use Docker with Linux containers and the standalone `docker-compose` command. Allow at least 4 GB of memory for Docker. OpenSearch needs `vm.max_map_count` of at least `262144` on the Linux Docker host (or Docker's Linux VM); see the [OpenSearch Docker prerequisites](https://docs.opensearch.org/latest/install-and-configure/install-opensearch/docker/).

From the repository root, copy `.env.example` to `.env` (`cp .env.example .env` in a POSIX shell or `Copy-Item .env.example .env` in PowerShell). Set both passwords to your own local values. No passwords are supplied by the repository. The ignored `.env` also allows host port overrides if a default port is already occupied.

With Docker running:

```sh
docker-compose up --build
```

Compose starts five services: `postgres`, `opensearch`, `rabbitmq`, `replicator`, and `consumer`. The three infrastructure services stay running. The replicator waits for healthy PostgreSQL, prints `Replicator started`, and waits if the source table is missing or empty. Run `make seed` in another terminal (below). It reads the initial snapshot and exits with code 0 after logging completion. The consumer prints `Consumer started` and exits with code 0. Destination indexing, publication, and message consumption are not implemented yet.

In another terminal, check all five containers (including the exited apps) and their logs:

```sh
docker-compose ps -a
docker-compose logs replicator consumer
docker-compose logs postgres opensearch rabbitmq
```

The infrastructure containers should become healthy. Health checks only indicate service readiness, not data flow or the assignment's failure gates. To start in the background instead, use `docker-compose up --build -d`.

Published ports use host ports from `.env` and bind to all host interfaces. Default addresses for local access are:

| Service | Local interface | Access |
| --- | --- | --- |
| PostgreSQL | `127.0.0.1:5432` | Database `client_source`, user `source`, password from `.env` |
| OpenSearch | <http://localhost:9200> | Plain HTTP without authentication, for local development only |
| RabbitMQ | `127.0.0.1:5672` | AMQP, user `local`, password from `.env` |
| RabbitMQ management | <http://localhost:15672> | Same RabbitMQ credentials |

Check the services individually (adjust host ports if overridden):

```sh
docker-compose exec postgres pg_isready -U source -d client_source
curl http://localhost:9200/_cluster/health
docker-compose exec rabbitmq rabbitmq-diagnostics -q check_running
```

PostgreSQL is the client-like source database. It has no application-owned state tables. Named volumes preserve infrastructure data across container removal. Password environment variables initialize new PostgreSQL/RabbitMQ data only; changing `.env` does not change credentials in an existing volume.

Compose uses project-prefixed container and volume names (by default, `kill-it-twice`, from the directory name). Application images are tagged `replicator` and `consumer`. A separate project name also needs distinct host ports to run concurrently; application image tags remain shared.

To build and run just one application:

```sh
docker-compose up --build replicator
docker-compose up --build consumer
```

Stop a foreground run with Ctrl+C. To stop and remove the containers and network while keeping data:

```sh
docker-compose down
```

To also delete this project's infrastructure data for a fresh local start, use `docker-compose down --volumes`.

## Seed the source

Install GNU Make and ensure `make` and the standalone `docker-compose` command are available in the same environment. On Windows, use GNU Make with a compatible recipe shell (`cmd.exe` or a POSIX shell), or run both commands inside WSL. PowerShell can launch `make`; Make's recipe shell handles the SQL file redirection. A host PostgreSQL installation is unnecessary because the command uses the container's psql client.

After configuring `.env` as above, start PostgreSQL if needed and wait for it to be ready:

```sh
docker-compose up -d postgres
docker-compose exec -T postgres pg_isready -U source -d client_source
make seed
```

Run these commands from the repository root. Seeding works independently of the replicator and consumer; neither application needs to run. The target itself does not start services or reset volumes. A stopped PostgreSQL service makes it fail.

The script creates `public.customers` in `client_source` with `id integer PRIMARY KEY`, `full_name text NOT NULL`, `email text NOT NULL`, `country_code text NOT NULL`, `status text NOT NULL`, and `created_at timestamptz NOT NULL`. A fresh source receives exactly 10,000 deterministic records with IDs 1 through 10,000:

- Names are `Customer <id>` and emails are `customer<id>@example.test`.
- Countries cycle through `GE`, `US`, `DE`, `GB`, and `FR`; odd IDs are `active`, even IDs are `inactive`.
- Timestamps are the fixed UTC base `2025-01-01 00:00:00+00` plus the ID in minutes.

`make seed` prints the resulting count and first five customers ordered by ID. To inspect them separately:

```sh
docker-compose exec -T postgres psql -X -U source -d client_source -c "SELECT count(*), count(DISTINCT id), min(id), max(id) FROM public.customers;"
docker-compose exec -T postgres psql -X -U source -d client_source -c "SELECT * FROM public.customers ORDER BY id LIMIT 5;"
```

For a fresh source, the aggregate values are `10000`, `10000`, `1`, and `10000`. Reruns use `ON CONFLICT (id) DO NOTHING`: only missing IDs in the fixed range are inserted. Existing customer values, including manual edits and records outside the range, are preserved, so a populated table can exceed 10,000 rows.

Schema creation and insertion run in one transaction with psql error-stop enabled; a SQL failure before commit leaves no partially committed seed. The script does not migrate or delete an existing schema; incompatible definitions can produce a visible SQL error. No application-owned state tables are created. These sample records demonstrate v0 loading, not memory/throughput limits, large-scale capacity, or the assignment's failure gates.

## Build and run with Docker

From the repository root, with Docker running:

```sh
docker build -t replicator ./apps/replicator
docker run --rm --env PGHOST --env PGPORT --env PGDATABASE --env PGUSER --env PGPASSWORD replicator

docker build -t consumer ./apps/consumer
docker run --rm consumer
```

For a standalone replicator container, first export the five PG connection variables with a host reachable from inside that container. Expected output includes `Replicator started` and `Consumer started`, respectively; the replicator requires PostgreSQL and seed data to complete. Each directory is its own build context, with a dependency lockfile. The images compile TypeScript in a build stage and run as the Node user with only runtime files and dependencies.

## Build and run locally

Use Node.js 24 and npm. Before running the replicator locally, set `PGHOST=127.0.0.1`, `PGPORT` to your published PostgreSQL port, `PGDATABASE=client_source`, `PGUSER=source`, and `PGPASSWORD` to your local source password. The local process does not load `.env` automatically. From the repository root:

```sh
npm ci --prefix apps/replicator
npm run build --prefix apps/replicator
npm start --prefix apps/replicator

npm ci --prefix apps/consumer
npm run build --prefix apps/consumer
npm start --prefix apps/consumer
```

To inspect issue #6 with the Compose stack running, start the reader before seeding:

```sh
docker-compose up --build -d postgres replicator
make seed
docker-compose logs replicator
docker-compose ps -a
```

A fresh source logs `Waiting for seeded records in public.customers` before seeding, followed by ten batches of 1,000 rows: first IDs 1, 1001, ..., 9001 and last IDs 1000, 2000, ..., 10000. The final line is `Initial load complete: rows=10000 batches=10`, and the replicator exits with code 0. If already seeded, it starts reading immediately. Each new process performs a fresh load; it has no checkpoint. To rerun an exited reader, use `docker-compose start replicator`.

The first nonempty read defines a repeatable-read snapshot. Rows changed afterward are outside that load. The reader performs no writes to PostgreSQL and stops after that snapshot, with no polling of later changes. Missing/empty seed data is checked once per second; other database errors terminate with a nonzero exit status. These observations check the initial read only, not destination delivery or the assignment's failure gates.

Run the reader's focused tests with `npm test --prefix apps/replicator`. They compile TypeScript and use a mocked PostgreSQL client to check batching, missing/empty-table waiting, sparse IDs, and error cleanup. They do not establish that a live PostgreSQL/Compose load succeeds; use the manual steps above for that check.