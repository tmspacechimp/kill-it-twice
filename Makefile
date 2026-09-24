.PHONY: seed

seed:
	docker-compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U source -d client_source < seed.sql
