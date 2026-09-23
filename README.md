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

Two independent application scaffolds are available:

- `apps/replicator`: NestJS/TypeScript application context.
- `apps/consumer`: plain TypeScript application.

Each prints an identifiable startup line and exits successfully. The replicator closes its Nest application context before exiting. Neither application requires external services yet.

## Build and run with Docker Compose

Use Docker with Linux containers and the standalone `docker-compose` command. Allow at least 4 GB of memory for Docker. OpenSearch needs `vm.max_map_count` of at least `262144` on the Linux Docker host (or Docker's Linux VM); see the [OpenSearch Docker prerequisites](https://docs.opensearch.org/latest/install-and-configure/install-opensearch/docker/).

From the repository root, copy `.env.example` to `.env` (`cp .env.example .env` in a POSIX shell or `Copy-Item .env.example .env` in PowerShell). Set both passwords to your own local values. No passwords are supplied by the repository. The ignored `.env` also allows host port overrides if a default port is already occupied.

With Docker running:

```sh
docker-compose up --build
```

Compose starts five services: `postgres`, `opensearch`, `rabbitmq`, `replicator`, and `consumer`. The three infrastructure services stay running. The two apps print `Replicator started` and `Consumer started`, then exit with code 0; they do not connect to the infrastructure yet. There is no source schema, seed command, replication, or message consumption at this stage.

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

## Build and run with Docker

From the repository root, with Docker running:

```sh
docker build -t replicator ./apps/replicator
docker run --rm replicator

docker build -t consumer ./apps/consumer
docker run --rm consumer
```

Expected output includes `Replicator started` and `Consumer started`, respectively. Each directory is its own build context, with a dependency lockfile. The images compile TypeScript in a build stage and run as the Node user with only runtime files and dependencies.

## Build and run locally

Use Node.js 24 and npm. From the repository root:

```sh
npm ci --prefix apps/replicator
npm run build --prefix apps/replicator
npm start --prefix apps/replicator

npm ci --prefix apps/consumer
npm run build --prefix apps/consumer
npm start --prefix apps/consumer
```

These commands check scaffold startup only. The initial-load implementation and the assignment's failure scenarios remain future work.
