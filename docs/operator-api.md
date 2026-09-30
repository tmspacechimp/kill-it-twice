# Operator API contract (issue #29)

This is the operator-side contract agreed for implementation before gate-owned
endpoints exist. It is a handoff for gate/metrics work, not a claim that the current
replicator implements it. The current replicator has no HTTP server, durable
progress, DLQ or G4 mechanism. These integrations return unavailable until supplied.

## Run locally

Use Node.js 24. From the repository root:

```sh
npm ci --prefix apps/operator-api
npm test --prefix apps/operator-api
npm start --prefix apps/operator-api
```

`OPERATOR_PORT` defaults to 3000. The server binds to `127.0.0.1` by default;
`OPERATOR_HOST` can override it for later container integration. Optional
`REPLICATOR_API_URL` must be an HTTP(S) origin without credentials, path, query or
fragment. Without it, routes explicitly report that the integration is not
configured. No source/destination connection or Docker access is needed to start
the operator API. Environment files are not loaded automatically.

## Routes

Upstream paths match the operator paths with `/api` removed. No automatic retries,
redirects, background polling, status cache or fallback container commands exist.
Each upstream call has a two-second deadline, including reading its body, and a
1 MiB response limit. Requests accept JSON bodies up to 16 KiB.

| Operator route | Input | Confirmed upstream response |
| --- | --- | --- |
| `GET /api/status` | None | Status below |
| `POST /api/replication/start` | No body or `{}` | Completion below |
| `POST /api/replication/stop` | No body or `{}` | Completion below |
| `GET /api/config` | None | Configuration below |
| `PUT /api/config` | `{ "values": { "advertisedKey": 123 } }` | Configuration below |
| `GET /api/dlq` | Optional `limit` (1–100, default 50), `cursor` | DLQ page below |
| `POST /api/dlq/:id/replay` | No body or `{}` | Completion below |
| `POST /api/simulations/rejected-records` | No body or `{}` | Completion below |

All successful upstream responses use `{ "available": true, "data": ... }`.
Unsupported capabilities use `{ "available": false, "code": "unsupported",
"reason": "explanation" }`. Empty explanations are invalid.

The G4 route requests the gate-owned scenario, with no operator-defined injection
parameters or implementation. A start response confirms resumed processing; a
stop response confirms active work finished and fetching stopped, while the
replicator HTTP server remains running. Only gate work can supply these semantics.

## Status

Every configured `GET /api/status` makes exactly one upstream `GET /status` call.
An unavailable/malformed/error response returns HTTP 200 with `available: false`,
an error code and reason, and `receivedAt: null`. HTTP 200 here means the operator
answered, not that replication is healthy. A valid available response gets the
operator's ISO UTC `receivedAt` timestamp after the complete response is validated.
The future UI may retain its last available response, but must mark it stale and
keep that earlier timestamp when availability is lost.

Status data contains:

- `replicationState`: an available string `value`, or an unavailable reason.
- `metrics`: exactly `initialLoadProgress`, `throughput`, `incrementalLag`, and
  `dlqCount`. Each is `{ "available": true, "value": <finite number>,
  "unit": "...", "definition": "..." }` or an unavailable reason.
- `health`: entries with `component` and `state` (`healthy`, `unhealthy`, or
  `unavailable`), plus a nonempty `reason`.

Metric units, formulas, sampling windows, meanings of replication states and
component health come from gate/metrics work. No metric is calculated here and no
unavailable number becomes zero. A valid status may contain unavailable individual
metrics; that still counts as a successful status response.

## Configuration

Configuration data is `{ "settings": [...] }`. Every advertised editable setting
has `key`, scalar `value` (string, finite number or boolean), `description`, and
`appliesAt` explaining when a change takes effect. An available empty list means
the backend supports inspection but exposes no editable settings. Unsupported
configuration must instead return an unavailable envelope.

PUT requires a nonempty `values` object. The operator reads fresh configuration,
checks every key is advertised and every new value has the current value's scalar
type, then forwards the PUT. The replicator must validate its domain constraints
and current capabilities atomically when applying the update. There is no locally
maintained settings list or invented range. A failed configuration read prevents
the write. The response describes actual confirmed settings and their effect time.

## DLQ and completion

DLQ page data is `{ "entries": [{ "id": "...", "record": { ... },
"reason": "..." }], "nextCursor": null }`. A non-null cursor is an opaque token.
Pages contain at most the requested limit. IDs and cursors are 1–200 characters
from letters, digits, `_` and `-`; the backend should encode opaque IDs accordingly.
Payloads are passed through without shipment/DLQ processing logic in the operator.

Completion data is `{ "completed": true, "message": "..." }` and must only be
returned after the requested action finishes. HTTP 202 or unconfirmed responses
are not success: the operator returns `unconfirmed` and the caller must inspect
state before deciding what to do next. Timeouts also do not prove a mutation was
rolled back. Docker/source operation IDs are described below. Gate HTTP commands
still require completion within their deadline. No mutation is automatically retried.

## Errors and input validation

Non-status failures use `{ "available": false, "code": "...", "reason": "..." }`:

| HTTP status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_input` | Invalid JSON/body/query/ID; unknown fields rejected |
| 413 / 415 | `invalid_input` | Request body too large or not JSON |
| Upstream 4xx / 5xx | Upstream code | A validated backend error, e.g. conflict or missing DLQ entry |
| 501 | `unsupported` | Unimplemented route/capability (including bare upstream 404/405/501) |
| 502 | `invalid_response` / `upstream_error` / `unconfirmed` | Bad protocol/JSON/schema, other backend error, or unfinished command |
| 503 | `not_configured` / `unreachable` | Integration not configured or network failure |
| 504 | `timeout` | Upstream call exceeded two seconds |

Backend error text is forwarded only from a validated unavailable envelope, never
raw HTML or an arbitrary response body. Unexpected local failures use HTTP 500
with a generic reason. Responses disable caching. Request parameters are never
treated as URLs, commands or service names.

## Source and container operations (issue #30)

Set `OPERATOR_COMPOSE_PROJECT` to the running Compose project name, and
`OPERATOR_COMPOSE_FILE` and `OPERATOR_COMPOSE_DIRECTORY` to absolute paths accessible
to the operator. Set all three together; without them Docker controls return 503.
The directory must contain the same environment configuration as the running stack.
Docker CLI/Compose and daemon access are required. Container setup follows in #32.

The following POST routes accept no body or `{}`, except generation:

| Route | Fixed action |
| --- | --- |
| `/api/source/generate` | `{ "count": 500, "rate": 20 }`; existing source-writer CLI |
| `/api/simulations/replicator/kill` | Compose kill with SIGKILL |
| `/api/simulations/replicator/restart` | Compose restart replicator |
| `/api/simulations/opensearch/stop` | Compose stop opensearch |
| `/api/simulations/opensearch/restore` | Compose start opensearch |

Generation permits integer count 1–2147483647 and rate 1–1000. It starts no dependent
services and builds no image. Seed first and build source-writer beforehand.
Success requires the requested final inserted count; interruption is not success.
Container actions require existing containers. They have a 30-second CLI deadline;
generation can run as long as its requested count/rate requires.

HTTP 202 returns `{ id, action, resources, state, startedAt, finishedAt, message }`.
Poll `GET /api/operations/:id` for `pending`, `succeeded` or `failed`. Do not treat
202 as completion. A Docker success confirms the command, not component health.
Output retains its last 4096 characters. Unknown/expired IDs return 404; the most
recent 100 records are held in memory. An API restart loses them, but a writer
container may remain active. Check active writers before submitting more work.

Conflict groups are `writer`, `replicator`, and `opensearch`. Source generation
locks writer; each container action locks its component; start/stop/configuration
lock replicator; replay locks replicator and OpenSearch; G4 locks all three.
Conflicts return 409. External CLI writers cannot be coordinated by these in-memory
locks: the existing one-serial-writer rule applies to all writer commands.

## Verification limits and next tickets

Tests use a local HTTP test double to verify routing, validation, timeouts,
unavailable responses and forwarding. They do not establish live metric accuracy,
resume, graceful stopping, DLQ replay, G4 outcomes or any assignment gate.

The operator now includes source/container commands, Angular polling and Compose
packaging. See [operator setup](operator-ui.md) and the recorded live checks.
The parent #28 acceptance remains unfinished until gate integrations are available.
