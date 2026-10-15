# Ghatana Media

**Ghatana Media** defines governed audio, video, image, speech, and time-based product experiences—from exact source ingestion to review, creation, transformation, and authorized delivery.

## Current state

- **Latest source-current exits:** PDP-0 R12, PDP-1 R27, and PDP-2 R17 are PASS/current; PDP-1 and PDP-2 are `DEV_COMPLETE` with zero outstanding definition tasks. PDP-2 R17 covers 405 paths and 50 cells and binds PDP-1 R27. PDP-3 is active in DISCOVERY, with source currentness `NOT_ESTABLISHED`; next, re-audit all 61 journey×channel edges and 14 consequential steps against R12/R27/R17. The R4 result of 43/61 edges and 18 gaps across six groups is historical only. Then resolve any current-source gaps, run V-01, complete MDC-31 Explorer verification, publish the PDP-3 exit in MDC-32, and evaluate MDC-40. MDC-41 remains gated until the Discovery barrier passes. Stale per-phase status projections remain historical and were not refreshed without a material-impact disposition. See the [current-cut execution plan](docs/implementation/MEDIA-DISCOVERY-REMAINING-CURRENT-CUT-EXECUTION-2026-10-13.md), [PDP-2 R17 receipt](docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r17.json), the [PDP-3 R4 progress audit](docs/implementation/observations/media-discovery-pdp3-mdc30-implementation-progress-2026-10-14-r4.json), and the [200-cell campaign matrix](docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json).
- **Discovery barrier:** `FAIL`. **Build:** `NOT_ENTERED`. **Native PDP closure:** `NOT_ENTERED`. **Delivery:** `BLOCKED`. Continue the ordered Discovery work in the [current-cut execution plan](docs/implementation/MEDIA-DISCOVERY-REMAINING-CURRENT-CUT-EXECUTION-2026-10-13.md); runtime implementation is downstream of the Discovery barrier.
- The **Media product-definition authority** is [`.product-experience/`](.product-experience/). The **canonical executable runtime** remains `ghatana/services/media` until an authorized source/writer transfer. This repository's runtime copy is not an independent live production service.
- Independent acceptance, public dependency admission, real provider availability, source cutover, and release are separate downstream matters, not unfinished PDP tasks.

## Start here

Read the [documentation index](docs/README.md) for product, architecture, testing, integration, operations and migration references. The primary contract owners are:

- [Product Truth](.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md): outcomes, capability scope, rights, trust, quality and requirements.
- [Domain/Data](.product-experience/pdp-1-domain-data/DOMAIN-MODEL.md): exact identities, operations, states, guards, versions, events and finality.
- [Design/Interface](.product-experience/pdp-2-design-interface-system/DESIGN-LANGUAGE.md): accessible GUI/headless grammar, components, presentation and API/CLI/SDK/event semantics.
- [Product Experience](.product-experience/pdp-3-product-experience/COMPLETE-PRODUCT-EXPERIENCE.md): 47 screens, 30 journeys, 130 steps and supported/unsupported interaction definitions.
- [Experience Explorer](apps/media-experience-explorer/README.md): a separate source-linked review tool, **not** a fifth PDP or production host.

The [recorded phase statuses](docs/implementation/post-pdp-current-status.json) distinguish completed definition development from implementation, independent review, production qualification and release.

## Architecture and ownership

Media owns media-specific artifacts and immutable versions, consent/rights-sensitive jobs, stream/timeline, speech/caption, vision, composition, quality/uncertainty and user/machine experience *meaning*. Shared owns reusable identity, policy, messaging, UI and observability; Tools owns generic development/experience contracts; Lifecycle owns its own verification machinery; Data Cloud/Event/Action Plane and AI Inference own generic platform mechanisms; Document Intelligence owns generic OCR/document extraction.

Media can integrate with other owners through admitted public contracts. It must not copy their engines or claim ownership because a compatibility/legacy source file exists. See [BOUNDARY.md](BOUNDARY.md) and [architecture](docs/ARCHITECTURE.md).

## Local development

With the declared pnpm/Node.js toolchain available, the following commands inspect source-owned product representations:

```sh
pnpm check:product-experience-local
pnpm test:product-experience-local
pnpm check:physical-topology
pnpm check:screen-status-matrix
```

These are source checks, not live-runtime or release qualification. For implementation-specific and JVM tests, follow [testing](docs/TESTING.md) and the canonical runtime in `ghatana/services/media`. Do not claim an unfiltered build passed when a module or compile task was excluded.

## Repository structure

| Directory | Current purpose |
| --- | --- |
| `.product-experience/` | Single Media normative PDP definition root, surface references, decision history and Explorer source projections |
| `apps/media-experience-explorer/` | Source-linked developer inspection |
| `libs/audio-video-ui/`, `libs/audio-video-client/`, `libs/audio-video-types/` | Media React UI, SDK client and typed interface packages |
| `modules/`, `launcher/`, `runtime-contracts/`, `providers/`, `adapters/` | Prepared source copy of runtime modules, pending owner-approved transfer |
| `contracts/`, `config/` | OpenAPI, runtime route/provider source and configuration contracts |
| `tests/`, module-local tests | Definition and implementation regression suites |
| `docs/implementation/` | Current Build handoff plus explicitly dated historical review/verification records |
| `migration/`, `docs/migration/` | Source/consumer comparisons and still-unauthorized migration preparation |
| `archive/media-desktop-apps/` | Inactive, intentionally archived desktops referenced by migration provenance; not active product apps |

**Naming:** New domain concepts should say **Media** and use intent-based names. Existing `audio-video` external paths, binary IDs and Gradle/package coordinates require compatibility review before renaming. Never mechanically rename stable PDP identities to improve aesthetics.

## What not to restart

The old `EXECUTE-MEDIA-PDP` and `PDP-0-3-SEQUENTIAL` plans, historical verification logs and the [withdrawn “remaining PDP” task list](docs/implementation/MEDIA-PDP-0-3-DEV-ONLY-REMAINING-2026-10-12.md) are not active work instructions. A new normative product requirement requires a **separate versioned change decision**; implementation or source-projection defects are repaired during Build.
