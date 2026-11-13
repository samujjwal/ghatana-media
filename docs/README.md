# Ghatana Media documentation

## Current feature-development execution

**Use this hierarchy:** [Feature-Complete Development Execution](development/FEATURE-COMPLETE-EXECUTION.md) defines the overall development increments and completion standard; [Per-Surface Feature Acceptance](development/SURFACE-FEATURE-ACCEPTANCE.md) supplies the unique source-specific work and falsifiable oracle; [Usable Surface Delivery](development/USABLE-SURFACE-DELIVERY.md) routes the original task IDs by area. [The existing task register](development/remaining-work.json) alone owns task status. All are feature-only and keep later gtool metadata declaratively compatible without running gtool, formal evidence or closure.

The [Per-Surface Feature Acceptance annex](development/SURFACE-FEATURE-ACCEPTANCE.md) and its [development configuration](../config/development/media-feature-surface-acceptance.v1.json) specify functionality, implementation steps and validation for each stable canonical surface and the newer support components. The static checker is `pnpm check:media-feature-acceptance`; it does **not** run gtool or formal closure.


For source-composite pnpm installs, see [pnpm source-composite manifest authority](development/PNPM-SOURCE-COMPOSITE-MANIFEST-AUTHORITY.md); sibling `package.json` files remain npm dependency truth when temporary Kernel `package.yaml` projections are present.

The [area/task map](development/surface-delivery.json) retains stable original task IDs without duplicate definitions. The historical November 8 handoff is a status snapshot, not another execution source. Selective changed-input testing is the default; completed feature work should not be repeated.

The [Engineering Contract and Work-Start Decisions](development/ENGINEERING-DECISIONS.md) clarify semantic boundaries, independent work start, and [historical content preservation](development/historical-content-preservation.json). The [Remaining Media Development Work](development/REMAINING-WORK.md) and its [structured register](development/remaining-work.json) contain the current owner decisions, fixes and ordered implementation-only tasks. They take precedence over older dated execution packets for feature work.

The [Media Surface Development Implementation Plan](development/SURFACE-IMPLEMENTATION-PLAN.md) is the active **implementation-only** plan for all registered surfaces, 30 product outcomes and repository hygiene. It covers feature logic, APIs, tests and stable per-surface documentation; it does not direct gtool, evidence/closure or release work. Existing dated implementation/qualification records remain source material, not a substitute for this maintained development plan.

## Historical build and formal-stage references

The historical **BUILD / Plan Implementation**, backend Wave 2 and PDP/gtool execution packets are collected in the [historical implementation index](implementation/README.md). The maintained feature-development references above remain the current selectors.

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
| Source-free storyboard draft example | [Runnable consumer guide](../examples/media-storyboard-draft/README.md); it emits a local, non-persisted, non-renderable authored plan candidate |
| Test, debug or operate | [Testing](TESTING.md), [examples](EXAMPLES.md), [operations](OPERATIONS.md), [verification history](EVIDENCE.md) |
| Check tracked-file hygiene and retired code | [Repository hygiene](REPOSITORY-HYGIENE.md), `pnpm audit:repository-hygiene` |
| Privacy, qualification and source transfer | [Privacy/retention](MEDIA_PRIVACY_AND_RETENTION_POLICY.md), [qualification](qualification/R-05-release-profile-admission.md), [migration status](migration/repository-preparation-status.md) |

## Source identity and runtime boundaries

### API / config / contracts — manifest-backed inventory

The current public API/config/schema contracts have separate owners. This inventory is navigation, not an aggregate specification:

| Boundary | Owning source and usage |
| --- | --- |
| HTTP requests, errors and routes | [OpenAPI](../contracts/openapi/media.yaml) and [route manifest](../config/route-manifest.json); launcher composes the HTTP runtime |
| STT RPCs and provider selection | [STT protobuf](../modules/speech/stt-service/src/main/proto/stt_service.proto) and [module guide](../modules/speech/stt-service/README.md) |
| TTS RPCs and voice/control restrictions | [TTS protobuf](../modules/speech/tts-service/src/main/proto/tts_service.proto) and [module guide](../modules/speech/tts-service/README.md) |
| Vision RPCs, native processing and model preflight | [Vision protobuf](../modules/vision/vision-service/src/main/proto/vision_service.proto) and [module guide](../modules/vision/vision-service/README.md) |
| Multimodal RPCs and composition | [Multimodal protobuf](../modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto) and [module guide](../modules/intelligence/multimodal-service/README.md) |
| Runtime Java SPI and state contracts | [runtime contract sources](../runtime-contracts/src/main/java/com/ghatana/media/runtime/) and [architecture](ARCHITECTURE.md); consumers must preserve tenant, version, attempt and finality semantics |
| Provider availability and configuration | [provider manifest](../config/provider-manifest.json), module guides and [operations](OPERATIONS.md); configured metadata does not grant provider rights or admission |
| Health, metrics and traces | [observability module](../audio-video-observability/README.md); shared instrumentation support has no independent Media business RPC |

Protobuf Java output is generated by the module build from each authored `.proto`; preserve method identities and field numbers, and do not edit generated output. Physical membership comes from the [topology registry](../.product-experience/surfaces/media-physical-topology.v1.json); the Wave 2 plan maps its selected five surfaces to 99 capability memberships and 43 RPCs without narrowing the full product denominator.

- `.product-experience/` owns canonical Media product meaning. PDPs are specifications, not assertions of deployed functionality. API-only, CLI-only, SDK, Event, and Agent Tool consumers do not require invented GUI screens.
- Shared, Tools, Lifecycle, Document Intelligence, AI Inference, and the Platform retain their generic contract and runtime responsibilities. Media consumes admitted public interfaces.
- Provider execution, rights, credentials, independent certification, release, and source transfer have separate requirements and status records.

There is no active `service-contract.yaml`. The source-specific wire authorities are OpenAPI and route manifests, module protobufs, provider metadata, and accepted canonical PDP operation and experience meaning. Do not create a duplicate umbrella contract.

## Historical records

Dated plans, migration records, and verification logs preserve provenance. See the [historical implementation index](implementation/README.md) for the legacy execution packets and the preservation inventory. These records are not live task queues or product-definition authorities unless a current source manifest explicitly assigns that role. Do not infer current status from an old report, commit, heading, checklist, or filename.
