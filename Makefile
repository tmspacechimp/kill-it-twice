.DEFAULT_GOAL := help

COMPOSE ?= docker compose
COUNT ?= 500
RATE ?= 20
ID ?= 1
TAIL ?= 30

.PHONY: help init build postgres infra dashboards operator up restart stop down logs status
.PHONY: seed generate append history shipment counts queue check-id

help:
	@echo "Demo: make init, build, infra, seed, up; then make generate and logs"
	@echo "init        Create .env if missing; then set both passwords"
	@echo "build       Build all apps (or SERVICES='replicator consumer')"
	@echo "postgres    Start PostgreSQL and wait until healthy"
	@echo "infra       Start all infrastructure and configure Discover"
	@echo "dashboards  Start OpenSearch/Dashboards and configure Discover"
	@echo "up          Start applications, including the operator (or SERVICES='consumer')"
	@echo "operator    Start only the operator API and page"
	@echo "seed        Seed initial fixtures (optional SEED_ARGS='--shipments 3')"
	@echo "generate    Append live events (COUNT=500 RATE=20)"
	@echo "append      Append one status (ID=4001 STATUS=created)"
	@echo "logs        Follow recent app logs (SERVICES='consumer' TAIL=30)"
	@echo "status      Show all containers, including completed jobs"
	@echo "history     Show source history for ID=1"
	@echo "shipment    Show indexed current state for ID=1"
	@echo "counts      Show source event/shipment counts and indexed count"
	@echo "queue       Show RabbitMQ queue counts"
	@echo "restart     Restart replicator (or SERVICES='consumer')"
	@echo "stop        Stop all containers (or SERVICES='replicator consumer')"
	@echo "down        Remove containers, retaining volumes"

init:
	@if test -f .env; then echo "Keeping existing .env"; else cp .env.example .env; echo "Created .env; set both passwords before starting"; fi

build:
	@$(COMPOSE) build $(or $(SERVICES),replicator consumer source-writer operator-api operator-ui)

postgres:
	@$(COMPOSE) up -d --wait postgres

infra:
	@$(COMPOSE) up -d --wait postgres opensearch rabbitmq dashboards
	@$(COMPOSE) run --rm --no-deps -T dashboards-setup

dashboards:
	@$(COMPOSE) up -d --wait opensearch dashboards
	@$(COMPOSE) run --rm --no-deps -T dashboards-setup

operator:
	@$(COMPOSE) up -d operator-api operator-ui

up:
	@$(COMPOSE) up -d $(or $(SERVICES),replicator consumer operator-api operator-ui)

restart:
	@$(COMPOSE) restart $(or $(SERVICES),replicator)

stop:
	@$(COMPOSE) stop $(SERVICES)

down:
	@$(COMPOSE) down

logs:
	@$(COMPOSE) logs --follow --tail=$(TAIL) $(or $(SERVICES),replicator consumer)

status:
	@$(COMPOSE) ps -a

seed:
	@$(COMPOSE) build source-writer
	@$(COMPOSE) run --rm --no-deps -T source-writer $(SEED_ARGS)

generate:
	@$(COMPOSE) build source-writer
	@$(COMPOSE) run --rm --no-deps -T source-writer generate --count "$(COUNT)" --rate "$(RATE)"

append: check-id
	@$(COMPOSE) run --rm --no-deps -T source-writer append "$(ID)" "$(STATUS)"

# Only decimal IDs may be interpolated into the inspection SQL and URL.
check-id:
	@case '$(ID)' in ''|*[!0-9]*) echo "ID must contain decimal digits only"; exit 1;; esac

history: check-id
	@$(COMPOSE) exec -T postgres psql -X -U source -d client_source -c "SELECT * FROM public.shipment_status_events WHERE shipment_id = $(ID) ORDER BY version;"

shipment: check-id
	@$(COMPOSE) exec -T opensearch curl --fail --silent --show-error "http://localhost:9200/shipments/_doc/$(ID)?pretty"

counts:
	@$(COMPOSE) exec -T postgres psql -X -U source -d client_source -c "SELECT count(*) AS events, count(DISTINCT shipment_id) AS shipments FROM public.shipment_status_events;"
	@$(COMPOSE) exec -T opensearch curl --fail --silent --show-error "http://localhost:9200/shipments/_count?pretty"

queue:
	@$(COMPOSE) exec -T rabbitmq rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers
