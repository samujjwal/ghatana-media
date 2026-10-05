# Product-experience decision log

This log records product-authority decisions and governance choices. Proposed
semantics remain proposals; migration preparation and file presence do not
constitute runtime or phase acceptance.

## Accepted decisions

### PXD-001 — Accept the migration boundary slice

- **Status:** accepted, limited to P0-001.
- **Authority:** the user's explicit approval to include the minimal boundary
  slice during migration preparation.
- **Scope:** product identity, ownership, named consumers and compatibility,
  and authority-transfer conditions recorded in
  [`phase-0-product-truth/PRODUCT-TRUTH.md`](./phase-0-product-truth/PRODUCT-TRUTH.md)
  and [`BOUNDARY.md`](../BOUNDARY.md).
- **Excludes:** full Product Truth acceptance, source cutover, runtime/data
  handover, production deployment, capability qualification, and readiness.
- **Evidence:** [`acceptance.yaml`](./acceptance.yaml), the migration boundary
  record, and the target boundary document.

### PXD-002 — Keep generic Document Intelligence outside Media

- **Status:** accepted ownership overlay.
- **Authority:** the user's supplemental Document Intelligence instruction,
  recorded in [MDI-001](../docs/migration/decisions/MDI-001-document-intelligence-ownership.md).
- **Decision:** Shared owns `@ghatana/documents` and
  `@ghatana/document-extraction`; Ghatana owns the reusable
  `services/document-intelligence` runtime; Media owns media-specific temporal
  and scene-text semantics and may consume the public service API through a
  narrow adapter.
- **Scope note:** This does not add providers, formats, a new OCR API, or
  runtime activation.

## Governance decisions for this authority root

### GOV-AUTH-001 — Use authored partial relations for traceability

- **Status:** selected governance representation; not a product-semantic
  acceptance.
- **Decision:** [`traceability.yaml`](./traceability.yaml) records authored
  task/artifact relations and selected cross-artifact links. Relationship
  truth remains in the owning Phase 0 records; the map does not copy those
  records or assert complete closure.
- **Limit:** P0-010 must independently inspect reference closure and semantic
  completeness after the remaining Phase 0 owner reviews.

### GOV-AUTH-002 — Store acceptance inputs, not computed phase results

- **Status:** selected governance representation; not an acceptance result.
- **Decision:** [`acceptance.yaml`](./acceptance.yaml) stores explicit human
  decision inputs, required owner review, and evidence needs. It contains no
  generated closure/currentness result.
- **Limit:** The Tools-owned schema/validator binding and generated observation
  workflow remain open under `GAP-MEDIA-TOOLS-SCHEMA-BINDING`.

### GOV-AUTH-003 — Do not hand-maintain currentness

- **Status:** required by the master plan; generation path unresolved.
- **Decision:** No `currentness.yaml` is created until the owner-approved Tools
  binding can generate a reproducible observation. This repository does not
  introduce a generic closure engine or manually assert that artifacts are
  current.

## Product proposals awaiting acceptance

P0-002 through P0-009 have authored material, but those records remain
proposals or work in progress until their listed human and external-owner
reviews are recorded. In particular, P0-007 profile, fallback, quality,
calibration, and optimization semantics do not qualify an engine, model,
provider, metric, or measured output. Their required specialist decisions are
listed in the owning files and in [`acceptance.yaml`](./acceptance.yaml).

P0-010 independent semantic acceptance remains pending. Phase 1, Phase 2, and
Phase 3 are not accepted and remain gated by the dependencies in the master
plan. No entry in this log changes the migration source-of-truth or gap
register; see [`source-manifest.yaml`](./source-manifest.yaml) and
[`gaps.yaml`](./gaps.yaml).
