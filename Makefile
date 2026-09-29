.PHONY: seed generate

COUNT ?= 500
RATE ?= 20

seed:
	docker-compose build source-writer
	docker-compose run --rm --no-deps -T source-writer $(SEED_ARGS)

generate:
	docker-compose build source-writer
	docker-compose run --rm --no-deps -T source-writer generate --count "$(COUNT)" --rate "$(RATE)"
