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

The repository contains planning documents only. Application code and runnable commands have not been added yet. The first slice will read an initial set of PostgreSQL records in bounded batches, index them in OpenSearch, publish events to RabbitMQ, and log them through a separate consumer.
