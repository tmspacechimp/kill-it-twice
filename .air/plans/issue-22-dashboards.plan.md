# Issue #22: shipment inspection with OpenSearch Dashboards

## Plan

1. Read the issue, linked branch metadata, specification, and existing Compose setup. No development branch is linked; preserve the pre-existing #21 working changes.
2. Add Dashboards with the same published version as OpenSearch, an internal HTTP connection, security disabled, and `DASHBOARDS_PORT` defaulting to 5601.
3. Update the specification and usage docs with the inspection-only scope, a `shipments` index pattern without a time filter, and a Discover lookup by shipment ID.
4. Validate Compose and run the UI against an initial shipment load; record commands and actual results in validation history. Use isolated volumes and ports to preserve existing data. Do not claim failure-gate coverage.

## Version decision

The existing OpenSearch 3.3.2 pin has no corresponding published Dashboards image: pulling `opensearchproject/opensearch-dashboards:3.3.2` returned `manifest unknown`. Registry manifest checks confirmed that both images exist at 3.4.0. Pin both to 3.4.0 and document the version change explicitly. No replicator changes are part of this issue.

## Result

Completed: Compose validation passed; isolated initial load indexed three shipments from eight events; the browser walkthrough created the index pattern and confirmed shipment 1 at version 3 with status `delivered` in Discover. Commands, actual image used, and limitations are recorded in `docs/validation-history.md`.
