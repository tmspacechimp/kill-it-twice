# Instructions for coding agents

Read `SPEC.md` before editing. It defines the current operating rules; `docs/project-brief-en.md` summarizes the broader problem, and `docs/optio-assignment-original-ka.md` is the original assignment. Work on one small requested task at a time and report files changed, commands run, and actual results.

- Readability is the number one code-quality priority. The developer must be able to read and verify every change. Prefer small, clearly named functions, explicit control flow, descriptive variables, and whitespace between logical steps. Avoid dense expressions, long functions, deeply nested callbacks, and unnecessary abstractions. Review new code and rewrites for readability before presenting them; formatting alone is not enough.
- Replicator operating rule: on the first startup without a checkpoint, capture the source rows present as the initial load. On restart, retain that boundary and resume the saved initial and incremental cursors. Process the remaining bounded initial dataset and poll for later rows concurrently. Each process waits for its first incremental rows without counting empty polls. Only after incremental rows have arrived, stop polling after the configured number of consecutive empty polls, resetting the count when more rows arrive. Finish the initial load before exiting. Keep the single serial, append-only source writer and single replicator per checkpoint volume assumptions explicit; do not silently change this startup-wait and post-activity idle-stop rule.
- Keep `.air/` local and ignored by Git; do not commit editor plans or state.

- Before starting work on an issue, look for its linked development branch and check it out if one exists. Preserve any uncommitted changes when switching branches.
- Keep the source PostgreSQL database client-like. The replicator reads it; neither application stores its internal state there. `make seed` is only for sample data.
- Build the replicator in NestJS/TypeScript. Use bounded source reads, index records in OpenSearch, and publish RabbitMQ events. Keep the consumer a separate, small application that logs received events.
- Do not add incremental sync, receipt storage, recovery mechanisms, retries, DLQ, UI, or automated gate claims without a new specification decision.
- When an implementation choice changes the intended behavior, explain it to the developer and update `SPEC.md` deliberately. Preserve the earlier specification in Git history.
- Use the narrowest relevant command to check the assigned task. A visible initial load is not evidence that the assignment's failure gates pass.
