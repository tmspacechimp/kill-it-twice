# Operator integration check — 2026-09-30

This records #32's local operator check, not assignment failure-gate acceptance.
The isolated Compose project was `kit-operator-check`, with a fresh source volume.
Its ignored `.env` supplied local passwords and separate host ports. The UI used
port 4200 for the IDE browser preview; the repository default remains 8080.

## Build and setup

- `docker compose config --quiet` passed.
- `docker compose build operator-api operator-ui source-writer replicator consumer`
  built all five images. The first build exposed Windows CRLF checkout differences;
  adding the operator apps to `.gitattributes` and using LF files fixed the build.
- `docker compose up -d --wait postgres opensearch rabbitmq` reported all three
  infrastructure services healthy.
- `docker compose run --rm --no-deps -T source-writer --shipments 3` inserted eight
  initial events for three shipments.
- `docker compose up -d replicator consumer operator-api operator-ui` started the
  applications. Replicator logs confirmed an initial load of eight rows.
- Docker Compose inside the operator container reported v5.0.0, and
  `OPERATOR_COMPOSE_PROJECT` was `kit-operator-check`, matching the outer stack.

## Browser actions and observations

The page was opened against the containerized UI and real operator API. All browser
API requests used the UI's `/api` origin. The Dashboards link used the configured
host port 25609. Status, configuration and DLQ accurately reported the missing
replicator HTTP interface; start, graceful stop and G4 were disabled. No successful
status timestamp or zero-valued substitute metrics appeared.

1. **Kill replicator:** submitted from the page, displayed pending and then
   succeeded. Docker showed exit code 137. Both operator containers stayed running.
2. **Stop OpenSearch:** submitted from the page, displayed pending then succeeded.
   Docker showed exit code 143. The UI remained usable with both target services
   stopped, and its operator status endpoint continued returning unavailable.
3. **Generate source traffic:** submitted count 6, rate 2 from the page during the
   outage. Generate was disabled while pending. The operation showed succeeded
   only after `Generation complete: inserted=6`. A PostgreSQL count query confirmed
   14 rows (8 initial + 6 new), proving the command used the intended source/project.
4. **Restore OpenSearch:** submitted from the page and confirmed by Docker. Its
   cluster subsequently reached yellow and its Compose health check became healthy.
5. **Restart replicator:** an early restart while OpenSearch was still starting
   completed the Docker command but the replicator exited on connection refusal.
   This demonstrates the documented distinction between Docker command completion
   and service health; no automatic retry was added. After OpenSearch was healthy,
   another browser restart ran the replicator successfully. Logs showed startup
   boundary 14 and `Initial load complete: rows=14 batches=1`.

The latter reload is existing behavior, not checkpoint resume. A completed Docker
operation is deliberately labeled as a container command result, not pipeline health.
Browser feedback was also corrected so the page's command message changes from
waiting to the terminal state when operation tracking confirms completion.

## Focused automated checks

- Operator API: `npm test --prefix apps/operator-api` passed formatting, lint,
  typecheck and 21 tests in #30. The #32 API image build passed the same build checks;
  no API processing code changed in #32.
- Operator UI: `npm test --prefix apps/operator-ui` passed all three tests for stale
  values, nonoverlapping polling, pending conflicts and failed-operation feedback.
  Formatting and the Angular production build passed, including in Docker.
- `git diff --check` passed.

These tests use doubles for gate-owned responses. Stale values followed by a
successful live metrics response cannot be demonstrated against the current
replicator because it has no HTTP status endpoint.

## Still unfinished in parent #28

Live replication metrics and component health, graceful stop/start preserving
progress, supported gate configuration, DLQ inspection/replay, and G4 injection
depend on gate-owned implementations. Their controls report unavailable. This run
does not establish any G1–G5 gate and does not add `make verify`.
