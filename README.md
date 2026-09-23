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

From the repository root, with Docker running:

```sh
docker compose up --build
```

Compose builds and starts both application scaffolds. Services are named `replicator` and `consumer` under the Compose project (by default, `kill-it-twice`, from the repository directory name). Compose generates project-prefixed container names to avoid collisions with other projects. Images are tagged `kill-it-twice/replicator` and `kill-it-twice/consumer`. Use `docker compose -p another-project up --build` for a separate container group; image tags remain shared. Their logs include `Replicator started` and `Consumer started`; both containers then exit with code 0. No external services are required or started by this scaffold configuration.

To build and run just one application:

```sh
docker compose up --build replicator
docker compose up --build consumer
```

To remove the containers and Compose network afterward:

```sh
docker compose down
```

## Build and run with Docker

From the repository root, with Docker running:

```sh
docker build -t kill-it-twice/replicator ./apps/replicator
docker run --rm kill-it-twice/replicator

docker build -t kill-it-twice/consumer ./apps/consumer
docker run --rm kill-it-twice/consumer
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
