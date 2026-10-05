# Ghatana Media product experience authority

This directory is the authoring root for Media Product Truth and the later
design, experience, and Explorer phases. The reviewed master plan is the
planning baseline. A plan statement becomes accepted product meaning only
through the appropriate owner review and acceptance record; source presence,
repository migration, or a generated view does not confer acceptance.

## Current scope

Only the **P0-001 migration boundary slice** is accepted. Its readable record is
[`phase-0-product-truth/PRODUCT-TRUTH.md`](./phase-0-product-truth/PRODUCT-TRUTH.md),
with the accepted document-intelligence ownership overlay in
[`MDI-001`](../docs/migration/decisions/MDI-001-document-intelligence-ownership.md).
This acceptance covers the bounded product identity, ownership, consumer,
compatibility, and authority-transfer decisions described there. It does not
accept full Phase 0, cut over source authority, or claim implementation,
qualification, licensing, production readiness, or runtime availability.

P0-002 through P0-009 have authored material in this tree, but that material is
proposal or work in progress pending the relevant human and external-owner
reviews. P0-010 independent semantic acceptance is pending. Phase 1, Phase 2,
and Phase 3 remain gated and are not accepted. See
[`acceptance.yaml`](./acceptance.yaml) for acceptance inputs and
[`traceability.yaml`](./traceability.yaml) for the authored, partial relation
map.

## Authority and navigation

- [`authority-map.yaml`](./authority-map.yaml) identifies the owner and role of
  each authored, derived, or external authority.
- [`decision-log.md`](./decision-log.md) records the accepted boundary overlay
  and unresolved governance choices.
- [`source-manifest.yaml`](./source-manifest.yaml) records migration source
  observations and indexes product artifact roles, relationships, validation
  contracts, acceptance state, and fingerprint state. It records no semantic
  fingerprints until the owner-approved Tools generation binding is available.
- [`gaps.yaml`](./gaps.yaml) is the single editable cross-phase gap register.
- [`PRODUCT-CONSTITUTION.md`](./PRODUCT-CONSTITUTION.md) points to the
  structured constitutional register; `phase-0-product-truth/constitution.yaml`
  is the sole editable authority for those requirements.
- `phase-0-product-truth/` contains the proposed Phase 0 meaning and boundary
  records. Phase 1–3 directories will be authored only after their prerequisites.

Media owns its product semantics. Shared, Ghatana platform services, Tools,
Kernel, and other products retain their respective contract and runtime
authorities. In particular, Shared owns `@ghatana/documents` and
`@ghatana/document-extraction`; Ghatana owns the reusable Document Intelligence
runtime; Media owns only media-specific temporal and scene-text semantics and
may consume the public Document Intelligence API through a bounded adapter.

## Authoring and acceptance rules

1. Keep one editable authority per concept. A generated projection is not a
   second source of truth.
2. Use owner contracts for external schemas and lifecycles. Record public
   references and unresolved bindings rather than copying their meaning.
3. Keep proposed semantics, source observations, implementation evidence,
   license admission, technical qualification, and runtime availability
   distinct.
4. Treat unknown or unreviewed material as pending or blocked, not accepted.
5. A cross-reference map is authored and partial until independent P0-010
   review reconciles every required outcome, capability, state, authority,
   channel, journey, and failure path.

`currentness.yaml` is intentionally absent. The plan requires currentness and
coverage results to be generated observations, not hand-maintained readiness
claims. The Tools-owned schema/validator binding and generation path are still
open under `GAP-MEDIA-TOOLS-SCHEMA-BINDING`; no local closure engine is defined
here. The distinct generated coverage/currentness output remains open under
`GAP-MEDIA-CURRENTNESS-COVERAGE-GENERATION`, which depends on that published
validator binding.
