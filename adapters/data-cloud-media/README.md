# data-cloud-media adapter boundary (DC-06)

This adapter is the only place Media consumes Data Cloud public contracts
(`com.ghatana.datacloud.*`). It does not make Data Cloud an authority over
Media behavior.

## Ownership and finality

- **Media owns job finality.** Nothing in this module mutates Media job
  state, attempts or outcomes. `DataCloudMultimodalAdapter` reports
  `isAvailable(...) == false` for every operation type until a trusted
  artifact/version reader and rights/consent admission path are wired.
- **Publication is observation-only.** `MediaObservationPublicationCoordinator`
  projects bounded `MediaDerivedObservation` values into the Data Cloud
  semantic contract (`OperationalSemanticContext.SemanticObject`) and
  publishes them through an admitted destination client. Raw media payloads
  never cross the boundary — only bounded redacted values, references and
  provenance.
- **Idempotent outbox, never a double write.** One logical downstream
  projection exists per `(sourceEventId, sourceArtifactVersionId)`; replays
  return the recorded outcome. An ambiguous receipt stays `OUTCOME_UNKNOWN`
  and is never republished blindly.
- **Source authority is live.** Every publish re-verifies the source owner
  readback through `SourceReadbackAuthority`; denied, unadmitted or
  unavailable authority records `DENIED` with no dispatch.

## External handoff status

The `PublicationClient`, `SourceReadbackAuthority` and `PublicationOutbox`
seams are injected here. Real platform Data Cloud clients and the durable
shared outbox binding remain external-owner integrations; local fixtures are
UNVERIFIED_EXTERNAL, not proof of a platform effect.

## Dependency reconciliation

Data Cloud contracts enter via `project(":services:data-cloud:delivery:api")`
and `project(":services:data-cloud:planes:shared-spi")` — source-free client
dependencies on their owning repositories' public APIs only. No Data Cloud
internals are imported; no second aggregate spec is created.
