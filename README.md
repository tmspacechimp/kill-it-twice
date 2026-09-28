# Kill It Twice

A local shipment replication demo: a NestJS/TypeScript replicator reads PostgreSQL events, stores each shipment's latest status in OpenSearch, and publishes every event to RabbitMQ. A separate consumer logs the events.

The current version performs one initial load. Incremental sync, recovery, and a UI are not implemented.

## Run

Use Docker with Linux containers, standalone `docker-compose`, and GNU Make. On Windows, run these commands in WSL from the repository root. Allow at least 4 GB of Docker memory and set `vm.max_map_count >= 262144` on the Docker Linux host.

Create your local configuration if it does not already exist:

```sh
cp .env.example .env
```

Set `POSTGRES_PASSWORD` and `RABBITMQ_PASSWORD` in `.env`. Adjust the host ports there if the defaults are occupied. Then start and seed the system:

```sh
docker-compose up --build -d
make seed
docker-compose logs --follow replicator consumer
```

A fresh seed creates 10,000 events for 4,000 shipments. The replicator processes them in batches of 1,000 and exits; the consumer stays running. Rerunning `make seed` preserves existing data.

## Inspect

View shipment 1's latest status and the service states:

```sh
docker-compose exec -T opensearch curl --fail --silent http://localhost:9200/shipments/_doc/1
docker-compose ps -a
```

After the sample load, shipment 1 has version 3 and status `delivered`. OpenSearch contains 4,000 shipment documents.

Run the initial load again (this republishes all events):

```sh
docker-compose start replicator
```

Stop the system while retaining its data:

```sh
docker-compose down
```

## More

- [Detailed usage and development](docs/development.md): configuration, inspection, seeding, and tests.
- [Specification](SPEC.md): data model, behavior, and limitations.
- [Validation history](docs/validation-history.md): recorded runs and the customer-to-shipment change.
- [Project brief](docs/project-brief-en.md): broader assignment requirements.
