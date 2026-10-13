# Media repository hygiene and naming

**Status:** October 12, 2026. Active source hygiene is a **Build-stage maintenance** concern. PDP-0 through PDP-3 remain `DEV_COMPLETE` with no pending PDP development tasks.

## The current cleanup boundary

The repository contains canonical authored PDP contracts, a prepared copy of the runtime still canonical in `ghatana/services/media`, supported UI/client packages, migration inventories, preserved verification records, and an archived desktop source tree. Those categories have different deletion rules. Do not count historic work packets or old test logs as active development tasks.

The October 12 cleanup removed the dead AI Voice Python success-mock backend, its obsolete desktop setup/launch scripts, invalid service Docker/Kubernetes entry points, and now-retired monitoring/endpoints. The real React `@ghatana/ai-voice-ui-react` package and historical archived desktop code remain. The former `config/docker-compose.prod.yml` was replaced with a non-deployable marker: it previously referenced missing configuration, mutable tags and insecure default passwords; it was not a qualified production deployment.

## Automated source-wide audit

Run `pnpm audit:repository-hygiene` for a read-only inventory of **every Git-tracked file**. Use `node scripts/audit-media-repository.mjs --json` to obtain path-by-path exact-duplicate groups, historical logs, archive references, compatibility names, broken relative Markdown links and nonportable Docker build recipes. Use `node scripts/audit-media-repository.mjs --check` to fail only for unreadable tracked files, broken local links in maintained entry points, or known stale phase-status claims in those guides.

The audit **does not delete** any file. Identical bytes are not enough to justify deleting a file required by a versioned source reference or a consumer. Four module-local Dockerfiles still reference the obsolete `products/audio-video` monorepo layout, while four repository-root Dockerfile candidates have separate build-context issues. They are not qualified images. Review genuine consumers and owner-approved build packaging before consolidating these paths.

## Intent-based naming and preservation

Use Media for new product and domain names; use precise action/outcome names for operations and modules. Preserve published `audio-video` library/package/Gradle and route identities until a tested compatibility migration is admitted. Do not rename the stable 462 capability, 47 screen, or 30 journey identities. Source ownership remains one-way: Shared, Document Intelligence, AI Inference, Platform and Lifecycle generic modules are consumed through public contracts, not copied.

Keep dated verification, immutable source/crosswalk references, source-owned history and `archive/media-desktop-apps` while they have real consumers. Retire a candidate only after identifying its live imports, tests, generator outputs, migration references and release consumers, with no alias drift. Historic reports belong in explicit history and should not be linked as current implementation instructions.

## Limits of this review

A full Git tree census and targeted current-source inspections support the cleanup; the remote GitHub connection does not execute local pnpm, Gradle, cargo, container, or Python suites. Full build verification and regeneration of any affected generated source-index projections must occur against an actual checked-out source cut before claiming the implementation clean/qualified. No post-cleanup full-suite success or production release admission is asserted here.
