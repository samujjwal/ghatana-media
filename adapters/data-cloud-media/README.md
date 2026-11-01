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
- **Tenant-scoped idempotent outbox, never a blind double write.** One logical
  downstream projection is keyed by a length-framed
  `(tenantId, sourceEventId, sourceArtifactVersionId)`. Every replay first
  rechecks live source authority and returns no prior receipt when access is
  denied. Dispatch requires an atomic durable exclusive claim; an unresolved
  claim or ambiguous receipt stays `OUTCOME_UNKNOWN` and is never republished
  blindly.
- **Source authority is live.** Every publish validates and re-verifies the
  source owner readback before replay or dispatch. Explicit `DENIED` remains a
  policy denial; `NOT_ADMITTED`/`UNAVAILABLE` remain unavailable and neither
  path mutates the outbox or dispatches.

## External handoff status

The `PublicationClient`, `SourceReadbackAuthority` and `PublicationOutbox`
seams are injected here. `PublicationOutbox.claim` defaults to `UNAVAILABLE`,
so existing implementations fail closed before dispatch until they provide a
durable atomic claim bound to the exact source and projection fingerprint,
plus monotonic completion behavior. The claim adapter must also reconcile or
reject legacy `sourceEventId|sourceArtifactVersionId` rows atomically before
enabling the tenant-scoped key; this migration has not been performed.
Unbound legacy records fail closed and are not replayed. The test fixture
exercises that contract in memory only. Real platform Data Cloud clients and
the durable shared outbox binding remain external-owner integrations; local
fixtures are UNVERIFIED_EXTERNAL, not proof of a platform effect or production
admission.

## Dependency reconciliation

Data Cloud contracts enter via `project(":services:data-cloud:delivery:api")`
and `project(":services:data-cloud:planes:shared-spi")` — source-free client
dependencies on their owning repositories' public APIs only. No Data Cloud
internals are imported; no second aggregate spec is created.
