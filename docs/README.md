# Ghatana Media documentation

## Vision, intended consumers, and non-goals

Media makes governed media work reviewable from intent through an approved
output, preserving source, authority, rights, provenance, and uncertain outcomes.
Consumers are Media owners, integrating products, HTTP/gRPC and SDK callers,
embedded UI consumers, and product-definition reviewers. Generic identity, OCR,
model routing, read models, platform event delivery, and privileged effects stay
with their existing owners. See [VISION](VISION.md) and [BOUNDARY](../BOUNDARY.md).

## Boundary and ownership

This is a product/service scope with Java/Gradle, TypeScript/pnpm, and Rust/Cargo
build units. `launcher/` composes HTTP runtime behavior; `runtime-contracts/`
contains runtime types/SPIs; module and provider implementations remain internal
to their public contracts. The prepared runtime copy is migration-only until
source cutover. Product Definition has one authoring root at
[.product-experience](../.product-experience/); its proposals and accepted boundary
slice retain the existing acceptance records.

The user's Four-Phase Product Definition Hardening Plan is the governing minimum.
[REQUIREMENTS](REQUIREMENTS.md) preserves all task IDs, waves, fixed denominators,
and decision gates. The active authoring tree now follows the canonical PDP-0
through PDP-3 layout; Explorer is outside those phases. The migration plan is
retained as execution provenance and does not supersede phase-owned meaning.

## API / config / contracts — manifest-backed inventory

| Family | Present source / manifest | Current status |
| --- | --- | --- |
| HTTP API | [OpenAPI](../contracts/openapi/media.yaml), [route manifest](../config/route-manifest.json), launcher route registry | 27 observed operations; full PDP-3 behavior contracts pending |
| STT gRPC | [stt_service.proto](../modules/speech/stt-service/src/main/proto/stt_service.proto) | 12 RPCs |
| TTS gRPC | [tts_service.proto](../modules/speech/tts-service/src/main/proto/tts_service.proto) | 11 RPCs |
| Vision gRPC | [vision_service.proto](../modules/vision/vision-service/src/main/proto/vision_service.proto) | 10 RPCs |
| Multimodal gRPC | [multimodal_service.proto](../modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto) | 10 RPCs; full gRPC experience admission pending |
| SDK/types | [client metadata](../libs/audio-video-client/package.json), [type metadata](../libs/audio-video-types/package.json) | Competing client route families; GAP-05 / PDP3-003 |
| UI / embedded GUI | [UI metadata](../libs/audio-video-ui/package.json), applications/channels and screen registries | Shared-backed library; embedded surface contract pending |
| Agent tools | [handler source](../libs/common/src/main/java/com/ghatana/audio/video/tools/) | Four `av.*` handlers; canonical/compatibility identity decision pending |
| Lifecycle/events | [publisher](../launcher/src/main/java/com/ghatana/media/launcher/MediaLifecyclePublisher.java), [provider manifest](../config/provider-manifest.json) | Local publication exists; canonical event registry and durable proof pending |
| CLI / Explorer | [simulation](../libs/media-experience-simulation/README.md), [browser](../apps/media-experience-explorer/README.md) | Synthetic fixture commands and local preview; production CLI/Web not admitted |
| Product integration | [handoff contracts](../.product-experience/pdp-0-product-truth/handoff-contracts.yaml), [dependency contracts](../.product-experience/pdp-0-product-truth/dependency-contracts.yaml) | Public bindings and system-to-system surface records pending |
| Runtime configuration | [OPERATIONS](OPERATIONS.md), [repository boundary](../config/repo-boundary.json) | Enablement, profiles, stores, provider endpoints, bounds, and typed secret references |

There is no active `service-contract.yaml`. CLEAN-2 selects the separate
OpenAPI, route-manifest, protobuf, and provider-manifest surfaces as the current
source-specific contract authorities; no aggregate is manufactured. GAP-06
remains open for unresolved ownership, consumer parity, and native qualification.
Package versions/exports,
workspace catalogs, Gradle coordinates, and Cargo membership remain declared
in their build metadata; sibling-source builds do not prove isolated delivery.

## Current state and verification

Implemented behavior includes the prepared artifact/job/stream runtime and
deterministic Explorer fixtures.

### Current tests and checks

Available checks include Node local invariant tests, simulation tests,
module/launcher/provider tests, API consumption tests, and a Playwright browser
audit. The repository-recorded 2026-10-07 report exercised 29 scenarios, 47
Product proposal routes, the 296-record Specification index, and six viewports;
it reports no failed assertions, console errors, or page errors. That report
predates subsequent Explorer package-consumer edits, so rerun the browser audit
before using it as evidence for the current checkout. It does not establish
Tools-native acceptance, owner review, build isolation, or Lifecycle currentness.

### Repairable documentation drift

When repository sources establish a documentation correction, update the owning
prose page and preserve unresolved ownership or acceptance decisions as pending.
Current local checks do not validate documentation freshness or grant phase
acceptance.

Unresolved contract, ownership, and acceptance choices are listed in
[REQUIREMENTS](REQUIREMENTS.md). Source presence does not establish ownership or
readiness.

## Security, privacy, observability, and reliability / operability

Tenant/principal authorization, consent, bounded inputs, safe disclosure,
idempotency, leases, cancellation truth, and restart reconciliation are runtime
requirements. See [ARCHITECTURE](ARCHITECTURE.md),
[privacy / data governance](MEDIA_PRIVACY_AND_RETENTION_POLICY.md), and
[OPERATIONS](OPERATIONS.md) for current enforcement maps, health/readiness,
diagnostics, retention/erasure, retry, and recovery limits. Local publication and
in-memory stores do not establish durable recovery.

## Performance, accessibility / i18n, and AI/ML applicability

Job concurrency, upload/frame bounds, timeouts, and backpressure are explicit;
quality, scale, GPU, and SLO evidence remain pending. GUI/embedded surfaces require
keyboard, reflow/zoom, screen-reader, localization, and visual proof; API-only
paths have no GUI rendering obligations but retain interface/error language.
Media has model/provider behavior, so AI/ML applicability is material: quality,
uncertainty, provenance, consent, and specialist acceptance are required.
The Explorer simulator and local checker are deterministic-only and do not run
or qualify models.

## Dependency / supply-chain / licensing

Shared owns reusable contracts and design values; Tools owns generic development
contracts/validators; platform services retain their mechanics. Public version,
isolated consumer, license, model/asset provenance, and supply-chain admission
remain governed by GAP-02/GAP-09 and the migration plan. Manifest presence does
not prove published availability or qualification.

## Examples, testing and coverage, evidence and convergence

[EXAMPLES](EXAMPLES.md) provides inputs, expected results, and fixture error cases.
[TESTING](TESTING.md) lists exact commands, prerequisites, and failure/coverage
expectations. [EVIDENCE](EVIDENCE.md) distinguishes terminal/browser output from
owner-native artifacts, fingerprints, repeatability, and convergence proof.

## Document index

- [Architecture](ARCHITECTURE.md)
- [Design](DESIGN.md)
- [Vision](VISION.md)
- [Requirements and current state](REQUIREMENTS.md)
- [Product Definition coverage](PRODUCT-DEFINITION-COVERAGE.md)
- [Examples](EXAMPLES.md)
- [Testing](TESTING.md)
- [Verification records](EVIDENCE.md)
- [Operations](OPERATIONS.md)
- [Repository boundary](../BOUNDARY.md)
- [Privacy and retention](MEDIA_PRIVACY_AND_RETENTION_POLICY.md)
