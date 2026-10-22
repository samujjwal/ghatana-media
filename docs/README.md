# Ghatana Media documentation

## Current BUILD implementation plan

The single canonical plan for Media's post-Discovery **BUILD / Plan Implementation** lane is [Media BUILD Implementation Plan](implementation/MEDIA-BUILD-IMPLEMENTATION-PLAN.md).

**Current implementation handoff (2026-10-22):** [PDP-0–3 gtool execution board v2](implementation/MEDIA-PDP0-3-GTOOL-EXECUTION-BOARD.v2.md), [structured 19-task queue](implementation/MEDIA-GTOOL-EXECUTION-QUEUE.v2.json), and [owner-approved scope/protocol](implementation/MEDIA-PDP0-3-GTOOL-OWNER-APPROVED-EXECUTION.md). These describe dependency ordering, per-surface advancement and parallel native closure. They are **execution coordination records**, subordinate to source PDP and the canonical Build plan, not another project task authority or fake `KCRIT-PLAN-READY` proof. The Lifecycle OOB method v2 adds declarative PDP3 narrated recording artifact vocabulary; actual source-owner recording admission and transition host integration remain explicit work.
 Its [exact source-identity trace](implementation/MEDIA-BUILD-IDENTITY-TRACE.v1.json) is a subordinate read-only planning appendix, not a second product-definition or runtime authority. The plan targets all shared foundations before all 30 PDP-3 end-to-end journeys and the Recorder/Studio/Player consumers. It is source-bound planning, **not** runtime implementation, independent PDP closure or release qualification.

## Product definition source

The canonical editable Media product-definition root is [`.product-experience/`](../.product-experience/README.md). [Product Truth](../.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md) owns PDP-0 meaning; PDP-1, PDP-2 and PDP-3 have their own phase-owned sources. The generated source manifest indexes declared artifacts; Explorer views, matrices and reports are projections. None of these projections establishes semantic acceptance, currentness, implementation, or release. Consult the source-pinned phase status records and validate their pins with the owning phase's native fingerprint rules. No Media application has been released.

## Find the owning source

| Reader goal | Authoritative or maintained reference |
| --- | --- |
| Product vision and responsibilities | Canonical meaning in [Product Truth](../.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md); [Vision](VISION.md), [boundary](../BOUNDARY.md), and [product coverage](PRODUCT-DEFINITION-COVERAGE.md) are reader summaries |
| Product Truth, Domain/Data, Design/Interface, Product Experience | [PDP definition index](../.product-experience/README.md) and [source decision log](../.product-experience/decision-log.md) |
| Runtime architecture and interfaces | [architecture](ARCHITECTURE.md), [design](DESIGN.md), [testing](TESTING.md) |
| Product API and provider boundaries | [OpenAPI](../contracts/openapi/media.yaml), [route manifest](../config/route-manifest.json), [surface registry](../.product-experience/surface-registry.yaml) |
| Clients and screen experiences | [Media SDK](../libs/audio-video-client/README.md), [Media Explorer](../apps/media-experience-explorer/README.md), [screen registry](../.product-experience/pdp-3-product-experience/screen-registry.yaml) |
| Machine-only operation experiences | [CLI registry](../.product-experience/pdp-3-product-experience/cli/command-registry.yaml), [Agent Tool registry](../.product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml), [events](../.product-experience/pdp-1-domain-data/events.yaml) |
| Test, debug or operate | [Testing](TESTING.md), [examples](EXAMPLES.md), [operations](OPERATIONS.md), [verification history](EVIDENCE.md) |
| Check tracked-file hygiene and retired code | [Repository hygiene](REPOSITORY-HYGIENE.md), `pnpm audit:repository-hygiene` |
| Privacy, qualification and source transfer | [Privacy/retention](MEDIA_PRIVACY_AND_RETENTION_POLICY.md), [qualification](qualification/R-05-release-profile-admission.md), [migration status](migration/repository-preparation-status.md) |

## Source identity and runtime boundaries

- `.product-experience/` owns canonical Media product meaning. PDPs are specifications, not assertions of deployed functionality. API-only, CLI-only, SDK, Event, and Agent Tool consumers do not require invented GUI screens.
- Shared, Tools, Lifecycle, Document Intelligence, AI Inference, and the Platform retain their generic contract and runtime responsibilities. Media consumes admitted public interfaces.
- Provider execution, rights, credentials, independent certification, release, and source transfer have separate requirements and status records.

There is no active `service-contract.yaml`. The source-specific wire authorities are OpenAPI and route manifests, module protobufs, provider metadata, and accepted canonical PDP operation and experience meaning. Do not create a duplicate umbrella contract.

## Historical records

Dated plans, migration records, and verification logs preserve provenance. They are not live task queues or product-definition authorities unless a current source manifest explicitly assigns that role. Do not infer current status from an old report, commit, heading, checklist, or filename.
