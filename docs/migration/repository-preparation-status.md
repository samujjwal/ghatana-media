# Repository preparation status

**Snapshot:** 2026-10-07. This is a migration and verification status summary,
not a semantic authority. Product meaning is owned by accepted decisions and
records beneath `.product-experience/`; proposals remain proposals.

## Historical phase-development status (2026-10-12)

This file's 2026-10-07 migration observations below are a historical snapshot.
At definition cut `adc9aa6`, all four phase-development status records declared
`DEV_COMPLETE`; the checkpoint at `0837fef` refreshed those records and their
verification logs without changing the pinned definition content. The phase
result does not assert independent semantic acceptance, package publication,
runtime implementation or qualification, Lifecycle receipt currentness,
migration cutover, or release authorization. These statements are retained as
historical provenance only. Consult the [canonical PDP source index](../../.product-experience/README.md)
for live source-pinned development status.

## Historical ownership and definition handoff note

At the October 12, 2026 snapshot, the phase records reported all four PDPs as
`DEV_COMPLETE`. That status is not current. Media product meaning is owned in
`ghatana-media/.product-experience/`; the historical runtime/source-transfer
observations below do not establish current status or authorization.

## Historical October 7 migration/source observations (not current PDP tasks)

The canonical **executable runtime** source remains `ghatana/services/media` until the
reviewed cross-repository cutover manifest is admitted and executed. This
checkout is still migration preparation; repository registration, local builds,
or source presence do not establish cutover, runtime qualification, production
availability, or activation. The generic Document Intelligence runtime remains
platform-owned under accepted MDI-001; public client publication and Media
rebinding remain pending.

At this **October 7 source-observation snapshot**, the four PDP directories,
source manifest, surface registry, Explorer, and local structural checks were
present. Only the bounded P0-001 migration boundary slice then had separate
formal acceptance; development semantics have since been completed in the four
recorded phase cuts, while independent review remains a separate gate.
The historic fixed source denominators were 10 P0 outcomes, 38 functional requirement
groups, 462 capability leaves, 28 PDP-2 component contracts, 47 canonical
screens in 48 screen-contract files, 30 journeys, 27 HTTP operations, 43 gRPC
RPCs, 11 CLI fixture/plan commands versus 12 broader proposal records, and four Agent
Tool handlers. These counts are inventory denominators, not acceptance or
implementation claims.

The surface registry now records applicability disposition separately from
semantic, implementation, and qualification status. Web is a target pending
admission; embedded awaits host contracts; HTTP, gRPC, and SDK remain
compatibility/canonicalization work; CLI is target scope with fixture-only
implementation evidence; Agent Tools and events/integrations retain owner
questions; desktop is archived and inactive. No surface is thereby promoted
to supported or qualified.

## Historical source observations and external gaps (October 7)

The numerical findings in this section were recorded during migration planning and have not been reasserted against the completed PDP definition cut. They must not be used to create new PDP development tasks.

- The local checker verifies structure and selected references only; it does
  not establish semantic acceptance or production behavior.
- 385 of 462 capability leaves lack explicit leaf-level journey references.
  Operation-specific bounds and owner-approved per-leaf applicability remain
  open under `GAP-MEDIA-CAPABILITY-LEAF-DETAIL`; no references or bounds are
  fabricated to close the count.
- Unique semantic extraction from the master plan remains incomplete.
  `GAP-MEDIA-MIGRATION-SEMANTICS` stays open; the plan's new disposition index
  classifies known content without claiming exhaustive extraction.
- Lifecycle-owned currentness, immutable published Shared bindings, owner-approved
  machine contracts, independent visual/accessibility review, and runtime
  qualification remain unverified or blocked by their recorded gaps.
- Explorer is a local source projection and deterministic review environment,
  not an admitted product UI. A proposed or source-derived route is not an
  executable screen admission.
- No production Web host or exact production/Explorer presentation import
  identity is established by this repository snapshot.

Consult [the canonical gap register](../../.product-experience/gaps.yaml),
[surface registry](../../.product-experience/surface-registry.yaml),
[Product Definition coverage](../PRODUCT-DEFINITION-COVERAGE.md), and
[accepted decisions](../../.product-experience/decision-log.md) for exact
record-level evidence and blockers. The expert-reviewed master plan remains an
execution/provenance reference, not a competing semantic authority.

## Source and configuration references

The source-specific HTTP contract is `contracts/openapi/media.yaml` with
`config/route-manifest.json`; gRPC contracts are the module protobuf files;
provider observations are in `config/provider-manifest.json`. No aggregate
service contract is claimed. The maintained STT gRPC configuration reference
is [stt-grpc-configuration.md](../configuration/stt-grpc-configuration.md).
The root `SERVICE_ENDPOINTS_CONFIG.md` is only a pointer to archived desktop
documentation. The archived desktop application is historical evidence, not an
active consumer surface.

## Migration and verification boundary

Migration path/consumer inventories and transfer exceptions remain under
`migration/` and require owner reconciliation before cutover. Do not relocate
source, update cutover-dependent Docker/Gradle coordinates, or infer consumer
parity from inventory records. Migration, definition acceptance, implementation
admission, licensing, qualification, and activation are separate gates.
