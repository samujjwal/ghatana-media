# Repository preparation status

**Snapshot:** 2026-10-07. This is a migration and verification status summary,
not a semantic authority. Product meaning is owned by accepted decisions and
records beneath `.product-experience/`; proposals remain proposals.

## Repository and Product Definition

The canonical editable source remains `ghatana/services/media` until the
reviewed cross-repository cutover manifest is admitted and executed. This
checkout is still migration preparation; repository registration, local builds,
or source presence do not establish cutover, runtime qualification, production
availability, or activation. The generic Document Intelligence runtime remains
platform-owned under accepted MDI-001; public client publication and Media
rebinding remain pending.

The four PDP directories, source manifest, surface registry, Explorer, and
local structural checks are present. Only the bounded P0-001 migration
boundary slice is accepted. Remaining PDP-0 meaning and independent review are
open. Current fixed denominators are 10 P0 outcomes, 38 functional requirement
groups, 462 capability leaves, 28 PDP-2 component contracts, 47 canonical
screens in 48 screen-contract files, 30 journeys, 27 HTTP operations, 43 gRPC
RPCs, 11 planned CLI commands (12 fixture entries observed), and four Agent
Tool handlers. These counts are inventory denominators, not acceptance or
implementation claims.

The surface registry now records applicability disposition separately from
semantic, implementation, and qualification status. Web is a target pending
admission; embedded awaits host contracts; HTTP, gRPC, and SDK remain
compatibility/canonicalization work; CLI is target scope with fixture-only
implementation evidence; Agent Tools and events/integrations retain owner
questions; desktop is archived and inactive. No surface is thereby promoted
to supported or qualified.

## Current evidence and gaps

- The local checker verifies structure and selected references only; it does
  not establish semantic acceptance or production behavior.
- 385 of 462 capability leaves lack explicit leaf-level journey references.
  Operation-specific bounds and owner-approved per-leaf applicability remain
  open under `GAP-MEDIA-CAPABILITY-LEAF-DETAIL`; no references or bounds are
  fabricated to close the count.
- Unique semantic extraction from the master plan remains incomplete.
  `GAP-MEDIA-MIGRATION-SEMANTICS` stays open; the plan's new disposition index
  classifies known content without claiming exhaustive extraction.
- Tools-native currentness, immutable published Shared bindings, owner-approved
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
