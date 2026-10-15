# Ghatana Media

**Ghatana Media** defines governed audio, video, image, speech, and time-based product experiences—from exact source ingestion to review, creation, transformation, and authorized delivery.

## Current state

- **Current Discovery status:** R12/R27/R17 are historical PASS receipts for their captured source sets. PDP-0 R13 remains an immutable failed capture for its four recorded paths; R14 is the latest immutable capture and also failed (`0/50` current, `50/50` unknown) because Lifecycle continuity was `UNKNOWN` with `UNEXPECTED_REPOSITORY_MEMBERSHIP_CHANGE`. R2 exactly records the post-R13 GAP-12 denominator correction, but R14 did not apply that classification. The external Lifecycle `package.json` transition still awaits its owner. Re-establish root-wide continuity, then capture a fresh PDP-0 successor applying R2; recapture PDP-1 → PDP-2 serially before PDP-3. The latest pre-R6 audit recorded 43/61 definition-only edges, 18 incomplete, and 5/7/2 consequential-step dispositions; R6 remains pending. J21 rights approval stays excluded and blocked. See the [current-cut execution plan](docs/implementation/MEDIA-DISCOVERY-REMAINING-CURRENT-CUT-EXECUTION-2026-10-13.md).
- **Discovery barrier:** `FAIL`. **Build:** `NOT_ENTERED`. **Native PDP closure:** `NOT_ENTERED`. **Delivery:** `BLOCKED`.
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
