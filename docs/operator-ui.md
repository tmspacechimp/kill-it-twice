# Operator page (issue #31)

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
feedback. They use fixtures, not live pipeline metrics. Compose packaging and live
failure/restoration checks belong to #32; no failure-gate claim is made here.
