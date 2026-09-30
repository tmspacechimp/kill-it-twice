# Operator page

## Docker setup

From a WSL/Linux shell, set the two local passwords in `.env`, then use the normal
`make build`, `make infra`, `make seed`, `make up` workflow. Open
[the operator page](http://localhost:8080), or the port set by `OPERATOR_UI_PORT`.
`make operator` starts only the operator applications; they need no running
replicator or OpenSearch. `docker compose up -d operator-api operator-ui` is equivalent.

The API mounts `/var/run/docker.sock` and the repository at `/project` read-only.
Docker socket access grants control of the Docker daemon; the API runs as root for
this local demonstration. The page is published on loopback, and the API has no
published port. This is not a remotely authenticated operator service.

Compose's project name is passed into the API, including a `-p` or
`COMPOSE_PROJECT_NAME` override. The API reads `/project/compose.yaml` and its `.env`
for fixed commands. Keep configuration there instead of relying on host-only
environment overrides. Extra Compose override files are not supported by the
operator adapter. Source generation uses the already built writer image; it does
not seed, build, or start dependencies. Container simulations require existing
replicator/OpenSearch containers. They can restore stopped containers without
waiting for upstream health.

`REPLICATOR_API_URL` defaults to `http://replicator:3001`, reserved for future gate
work. Current replication has no HTTP listener there; status and gate controls are
unavailable. Docker/source actions still work independently. The Dashboards link
uses `DASHBOARDS_PORT`, supplied through a runtime asset by nginx.

## Local development

Use Node.js 24. Start the operator API using [its setup guide](operator-api.md), then:

```sh
npm ci --prefix apps/operator-ui
npm run build --prefix apps/operator-ui
npm test --prefix apps/operator-ui
npm start --prefix apps/operator-ui
```

Open [the operator page](http://localhost:4200). The development server proxies
relative `/api` requests to `127.0.0.1:3000`; change `proxy.conf.json` if your local
API port differs. The Dashboards link uses the browser's hostname and port 5601.

Status polls every two seconds without overlapping calls. If the operator or
replicator becomes unreachable, the last successful values remain visibly stale
with their original timestamp. No response means unavailable, not zero.

Configuration and DLQ refresh buttons fetch current data. Configuration exposes
only settings the replicator advertises, including effect timing. Start, graceful
stop and G4 require current replicator status. Their actual availability is checked
by the backend when used; unsupported requests show its reason. No gate features
exist in the current replicator, so those controls remain unavailable.

Generation and container simulations use the separate operator API. Operation rows
show pending/succeeded/failed outcomes. Related buttons stay disabled while a
request or operation is pending. A lost tracking response keeps pending locks and
shows an error: it does not prove the command stopped. A page reload loses local
tracking; an API restart loses operation records. Inspect active writer containers
before submitting further writes after either event.

State tests check stale values, no overlapping polls, pending conflicts and failure
feedback. They use fixtures, not live pipeline metrics. See
[operator verification](operator-validation.md) for the separate live checks;
no failure-gate claim is made here.
