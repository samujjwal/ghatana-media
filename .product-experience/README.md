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
reviews. P0-010 independent semantic acceptance is pending. In response to the
current request, Phase 1 through Phase 3 contain proposals for the first-use,
artifact-intake, and long-running transcription-job recovery journeys plus a
bounded audio transcript and caption-correction lane. Phase 3 includes metadata-only upload fixtures, a
local browser review client, and the canonical `ghatana-media` fixture-command
simulator. Phase 2 indexes the full 41-view and 30-journey denominators. All 28 required journeys now have Phase 0-grounded proposal files; complete action/state/scenario/channel bindings and full-phase coverage remain pending. These proposals do
not pass their upstream gates or claim production behavior. See
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
- Media is registered with all four Tools lifecycle stages in
  [`../config/development-subject-authorities.v1.json`](../config/development-subject-authorities.v1.json).
  [`../.ghatana/development-subject-catalog.yaml`](../.ghatana/development-subject-catalog.yaml)
  is a generated, currentness-tracked index of those authority files; it is not
  a phase validator or acceptance result. The current Tools workspace discovers
  the subject and reports no structural catalog gaps, but all four phase
  verification runs remain `CANDIDATE_PLAN` because the planner has no
  owner-bound plan.
- [`gaps.yaml`](./gaps.yaml) is the single editable cross-phase gap register.
- [`mandatory-surface-closure-matrix.yaml`](./mandatory-surface-closure-matrix.yaml)
  is the current 33-area local convergence audit. It records exact local
  repairs and external/native blockers; it is not a phase acceptance result.
- [`vision-requirements-coverage.yaml`](./vision-requirements-coverage.yaml)
  is the machine-readable cross-phase alignment ledger. It maps the
  master-prompt authority hierarchy and Media's ten P0 outcomes through
  requirements, capabilities, journeys/views, channels, and Explorer records;
  it is an authored coverage record, not a semantic acceptance result.
- [`PRODUCT-CONSTITUTION.md`](./PRODUCT-CONSTITUTION.md) points to the
  structured constitutional register; `phase-0-product-truth/constitution.yaml`
  is the sole editable authority for those requirements.
- `phase-0-product-truth/` contains the proposed Phase 0 meaning and boundary
  records. `lanes/` names the selected implementation-definition slice. The
  `phase-1-design-language/`, `phase-2-product-experience/`, and
  `phase-3-experience-explorer/` directories contain selected-lane proposals;
  Phase 1–3 acceptance still requires the upstream acceptance gates listed in
  [`acceptance.yaml`](./acceptance.yaml).

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
validator binding. Phase 0 through Phase 2 projection targets and the Phase 3
package path are recorded in `phase-0-product-truth/schema-bindings.yaml`; those
paths identify planned outputs, not generated artifacts or owner validation.

The repeatable local source-of-truth check is `pnpm check:product-experience-local`.
It validates the bundled Explorer index, source-linked cross-phase coverage,
screen/action/journey denominators, proposal-only action guards, matrix
coverage, and the intentional absence of Tools-generated currentness. It does
not issue receipts or acceptance.
