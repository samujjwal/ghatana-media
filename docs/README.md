# Ghatana Media documentation

> **Controlling status — October 15, 2026:** Discovery **FAIL**; PDP-0 R15, PDP-1 R30 and PDP-2 R19 technical PASS at recorded cuts; PDP-3 R6 **UNKNOWN** (source-gap/currentness resolution active). Build **NOT_ENTERED**, PDP closure **NOT_ENTERED**, Delivery **BLOCKED**. Use [the phase-locked remaining Discovery plan](implementation/MEDIA-DISCOVERY-PDP3-FINISH-2026-10-15.md), [delegated owner review](implementation/MEDIA-DISCOVERY-TO-BUILD-OWNER-REVIEW-2026-10-15.md), [full-product future Build plan](implementation/MEDIA-BUILD-COMPLETE-PRODUCT-PLAN-2026-10-15.md), and [50-surface/30-journey/47-task planning matrix](implementation/media-build-coverage-plan-2026-10-15.json). The October 12 completion claims below are historical, not the current PDP-3 technical exit.

**Maintained entry point (October 12, 2026).** Media's four PDP definitions are `DEV_COMPLETE` with **zero remaining PDP development tasks**. The active program is [Build → Integration/Test → Delivery](implementation/MEDIA-POST-PDP-BUILD-IMPLEMENT-TEST-DELIVER-2026-10-12.md). Historical source notes do not supersede the four completed definition cuts.

## Find the owning source

| Reader goal | Authoritative or maintained reference |
| --- | --- |
| Product vision and responsibilities | [Vision](VISION.md), [boundary](../BOUNDARY.md), [product coverage](PRODUCT-DEFINITION-COVERAGE.md) |
| Product Truth, Domain/Data, Design/Interface, Product Experience | [PDP definition index](../.product-experience/README.md) and [source decision log](../.product-experience/decision-log.md) |
| Current implementation and integration | [Build handoff](implementation/MEDIA-POST-PDP-BUILD-IMPLEMENT-TEST-DELIVER-2026-10-12.md), [architecture](ARCHITECTURE.md), [design](DESIGN.md) |
| Product API and provider boundaries | [OpenAPI](../contracts/openapi/media.yaml), [route manifest](../config/route-manifest.json), [surface registry](../.product-experience/surface-registry.yaml) |
| Clients and screen experiences | [Media SDK](../libs/audio-video-client/README.md), [Media Explorer](../apps/media-experience-explorer/README.md), [screen registry](../.product-experience/pdp-3-product-experience/screen-registry.yaml) |
| Machine-only operation experiences | [CLI registry](../.product-experience/pdp-3-product-experience/cli/command-registry.yaml), [Agent Tool registry](../.product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml), [events](../.product-experience/pdp-1-domain-data/events.yaml) |
| Test, debug or operate | [Testing](TESTING.md), [examples](EXAMPLES.md), [operations](OPERATIONS.md), [verification history](EVIDENCE.md) |
| Check tracked-file hygiene and retired code | [Repository hygiene](REPOSITORY-HYGIENE.md), `pnpm audit:repository-hygiene` |
| Privacy, production readiness and source move | [Privacy/retention](MEDIA_PRIVACY_AND_RETENTION_POLICY.md), [qualification](qualification/R-05-release-profile-admission.md), [migration status](migration/repository-preparation-status.md) |

## Source identity and runtime boundaries

- `.product-experience/` owns **canonical Media product meaning**. PDPs are a specification, **not an assertion of deployed functionality**. API-only/CLI-only/SDK/Event/Agent consumers do not require invented GUI screens.
- `ghatana/services/media` remains the canonical executable runtime; this repository's runtime files are a prepared transfer copy and must not claim a second live writer.
- Shared, Tools, Lifecycle, Document Intelligence, AI Inference and the Platform retain their own generic contract/runtime responsibilities. Consume admitted public interfaces, not sibling private implementation code.
- Real provider execution, copyright/rights, credentials, independent certification, release and migration are separately gated. A local simulated workflow or typed proposal does not prove success.

There is no active `service-contract.yaml`. The **source-specific** wire authorities are OpenAPI/route manifest, module protobufs, provider metadata, and accepted canonical PDP operation/experience meaning. Do not reintroduce a duplicate umbrella contract.

## Current versus historical documentation

Use the [Build handoff](implementation/MEDIA-POST-PDP-BUILD-IMPLEMENT-TEST-DELIVER-2026-10-12.md) for actual remaining engineering work. The [previous 15-task “remaining PDP” plan](implementation/MEDIA-PDP-0-3-DEV-ONLY-REMAINING-2026-10-12.md) is explicitly withdrawn. Older `IMPLEMENTER-MASTER-PROMPT`, `EXECUTE-MEDIA-PDP`, `SEQUENTIAL-DEVELOPMENT`, dated checklists and verification logs are retained as historical provenance, **not live task queues**.

Generated manifests and source-pin reports carry intentionally stable IDs and dated observations. Do not delete/rename them solely because the filenames are old or a historical hash is stale; first prove their generator and consumer relationships. Refer to the [current status](implementation/post-pdp-current-status.json) for separated definition/implementation/release dimensions.
