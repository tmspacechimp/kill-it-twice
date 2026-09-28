.PHONY: seed

seed:
	docker-compose build source-writer
	docker-compose run --rm --no-deps -T source-writer $(SEED_ARGS)
