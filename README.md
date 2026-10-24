# Ghatana Media

**Ghatana Media** defines governed audio, video, image, speech, and time-based product experiences—from exact source ingestion to review, creation, transformation, and authorized delivery.

## Product definition source

The canonical editable Media product-definition root is [`.product-experience/`](.product-experience/README.md). [Product Truth](.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md) owns PDP-0 meaning; each later PDP owns its definitions in its phase directory. The generated source manifest indexes declared artifact identities, locations, and roles; it does not establish semantic currentness or acceptance. The Experience Explorer is a projection, not another definition source.

The [PDP-0](docs/implementation/pdp-0-phase-dev-status.json), [PDP-1](docs/implementation/pdp-1-phase-dev-status.json), [PDP-2](docs/implementation/pdp-2-phase-dev-status.json), and [PDP-3](docs/implementation/pdp-3-phase-dev-status.json) records own the recorded development statuses. A status is current for this source cut only when its pins pass the owning phase's native validation. Read the earliest unfinished phase; this README and other plans do not mirror phase status. `DEV_COMPLETE` describes definition development only, separate from acceptance, implementation, qualification, and release. No Media application has been released.

## Start here

Read the [documentation index](docs/README.md) for product, architecture, testing, integration, operations and migration references. The primary contract owners are:

- [Product Truth](.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md): outcomes, capability scope, rights, trust, quality and requirements.
- [Domain/Data](.product-experience/pdp-1-domain-data/DOMAIN-MODEL.md): exact identities, operations, states, guards, versions, events and finality.
- [Design/Interface](.product-experience/pdp-2-design-interface-system/DESIGN-LANGUAGE.md): accessible GUI/headless grammar, components, presentation and API/CLI/SDK/event semantics.
- [Product Experience](.product-experience/pdp-3-product-experience/COMPLETE-PRODUCT-EXPERIENCE.md): supported and unsupported experience definitions, with canonical screen and journey records.
- [Experience Explorer](apps/media-experience-explorer/README.md): a separate source-linked review tool, **not** a fifth PDP or production host.

The phase-specific status records distinguish definition development from implementation, independent review, production qualification and release.

## Architecture and ownership

**October 24 owner decision:** `ghatana-media` is the sole destination for new Media code. The historical `ghatana/services/media` was an earlier monorepo host; it must not be edited for new Media work and must only be consulted for missing/divergent source and safe migration. The former runtime may remain actively deployed until tests, data/schema reconciliation and single-writer cutover complete. See the [five-foundation implementation plan](docs/implementation/MEDIA-BACKEND-FOUNDATION-DEEP-IMPLEMENTATION-2026-10-24.md).


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

These are source checks, not live-runtime or release qualification. **All new Media backend code and its JVM/integration tests belong in this repository.** For focused runtime tests use the local `./gradlew` project coordinates in [testing](docs/TESTING.md). Sibling Ghatana *platform* modules may still supply development composite dependencies, but `ghatana/services/media` is a read-only migration reference, not the implementation test target. No active data/queue writer cutover is implied; do not claim unfiltered builds passed when modules/tasks were excluded.

## Repository structure

| Directory | Current purpose |
| --- | --- |
| `.product-experience/` | Single Media normative PDP definition root, surface references, decision history and Explorer source projections |
| `apps/media-experience-explorer/` | Source-linked developer inspection |
| `libs/audio-video-ui/`, `libs/audio-video-client/`, `libs/audio-video-types/` | Media React UI, SDK client and typed interface packages |
| `modules/`, `launcher/`, `runtime-contracts/`, `providers/`, `adapters/` | **Designated implementation source** for all Media-specific backend code, under source reconciliation and local build hardening; old deployed runtime cutover still pending |
| `contracts/`, `config/` | OpenAPI, runtime route/provider source and configuration contracts |
| `tests/`, module-local tests | Definition and implementation regression suites |
| `docs/implementation/` | Source-pinned phase status records, verification results, and provenance |
| `migration/`, `docs/migration/` | Source/consumer comparisons and still-unauthorized migration preparation |
| `archive/media-desktop-apps/` | Inactive, intentionally archived desktops referenced by migration provenance; not active product apps |

**Naming:** New domain concepts should say **Media** and use intent-based names. Existing `audio-video` external paths, binary IDs and Gradle/package coordinates require compatibility review before renaming. Never mechanically rename stable PDP identities to improve aesthetics.
