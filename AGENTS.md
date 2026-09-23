# Instructions for coding agents

Read `SPEC.md` before editing. Its v0 scope is an initial-load proof of concept; `docs/project-brief-en.md` summarizes the broader problem, and `docs/optio-assignment-original-ka.md` is the original assignment. Work on one small requested task at a time and report files changed, commands run, and actual results.

- Before starting work on an issue, look for its linked development branch and check it out if one exists. Preserve any uncommitted changes when switching branches.
- Keep the source PostgreSQL database client-like. The replicator reads it; neither application stores its internal state there. `make seed` is only for sample data.
- Build the replicator in NestJS/TypeScript. Use bounded source reads, index records in OpenSearch, and publish RabbitMQ events. Keep the consumer a separate, small application that logs received events.
- Do not add incremental sync, receipt storage, recovery mechanisms, retries, DLQ, UI, or automated gate claims without a new specification decision.
- When an implementation choice changes the intended behavior, explain it to the developer and update `SPEC.md` deliberately. Preserve the earlier specification in Git history.
- Use the narrowest relevant command to check the assigned task. A visible initial load is not evidence that the assignment's failure gates pass.
