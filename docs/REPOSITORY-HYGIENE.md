# Media repository hygiene and naming

**Status:** October 12, 2026. Active source hygiene is a **Build-stage maintenance** concern. PDP-0 through PDP-3 remain `DEV_COMPLETE` with no pending PDP development tasks.

## The current cleanup boundary

The repository contains canonical authored PDP contracts, a prepared copy of the runtime still canonical in `ghatana/services/media`, supported UI/client packages, migration inventories, preserved verification records, and an archived desktop source tree. Those categories have different deletion rules. Do not count historic work packets or old test logs as active development tasks.

The October 12 cleanup removed the dead AI Voice Python success-mock backend, its obsolete desktop setup/launch scripts, invalid service Docker/Kubernetes entry points, and now-retired monitoring/endpoints. The real React `@ghatana/ai-voice-ui-react` package and historical archived desktop code remain. The former `config/docker-compose.prod.yml` was replaced with a non-deployable marker: it previously referenced missing configuration, mutable tags and insecure default passwords; it was not a qualified production deployment.

## Automated source-wide audit

Run `pnpm audit:repository-hygiene` for a read-only inventory of **every Git-tracked file**. Use `node scripts/audit-media-repository.mjs --json` to obtain path-by-path exact-duplicate groups, historical logs, archive references, compatibility names, broken relative Markdown links and nonportable Docker build recipes. Use `node scripts/audit-media-repository.mjs --check` to fail only for unreadable tracked files, broken local links in maintained entry points, or known stale phase-status claims in those guides.

The audit **does not delete** any file. Identical bytes are not enough to justify deleting a file required by a versioned source reference or a consumer. Four duplicate module-local Dockerfiles using the obsolete `products/audio-video` monorepo layout have been retired. The four canonical `docker/Dockerfile.<service>` candidates now consume only an externally built Gradle `installDist` distribution and share one restrictive root `.dockerignore`; they do not compile code inside the container, bypass tests, or imply standalone artifact availability. Generate each distribution in the approved source-composite build first. Validate its binaries, SBOM, rights and runtime before any release.

## Deployment candidates (fail-closed)

Helm's four service workloads, autoscalers and network policy are disabled by default. Enabling an individual service requires a selected lowercase `sha256` image digest; Helm no longer falls back to an implicit chart version. The retired AI Voice mock has no Helm workload. Current static `infra/kubernetes/*.yaml` service Deployments are deliberately **replicas=0** with unpullable `registry.invalid` image references and no enabled Vision autoscaler, so they cannot accidentally deploy unqualified binaries. These are compatibility/integration examples, not an approved rollout.

The Helm service templates now explicitly inject each server's `*_GRPC_PORT` and `AV_HEALTH_PORT` from their own port values rather than relying on the common HTTP health-server's default `8090`. The port contract is source-driven: STT gRPC/health `50051/8090`, TTS `50052/8091`, Vision `50054/8092`, Multimodal `50055/8093`; health uses the Media `HealthMetricsServer` `/health`, `/ready`, and `/metrics` endpoints. Apply actual immutable image digests, admitted providers, secrets, service account and qualified monitoring only in the separate release process.

## Deterministic build intent

The root Gradle `buildAll` task now delegates to the actual full Media build rather than silently invoking only the root `build` task. `buildMediaJvm` selects Media Java subprojects with real build scripts; the pnpm build scopes itself to Media apps/libs/modules instead of rebuilding linked Shared/Tools/Lifecycle siblings. The Rust workspace remains under its own Cargo build. This is a **source-level build graph correction**; it is not a recorded success of running the full polyglot build.

The historical `docs/migration/compatibility-cutover-observation.json` intentionally preserves five obsolete Docker build-context findings from the October 7 snapshot. Its regression test now checks that these problems have been **removed from current files** rather than demanding that unsafe source content be restored. Repository boundary metadata also distinguishes the already complete Media product-definition authority from the still-external canonical runtime writer.

The dependency inventory explicitly lists the four `installDist` output prerequisites required by the Docker runtime images. Those generated binaries are **not** source-pinned or admitted release artifacts. `.dockerignore` is a tracked, pinned build input and the container audit must not confuse a Dockerfile with an available distribution.

## Intent-based naming and preservation

Use Media for new product and domain names; use precise action/outcome names for operations and modules. Preserve published `audio-video` library/package/Gradle and route identities until a tested compatibility migration is admitted. Do not rename the stable 462 capability, 47 screen, or 30 journey identities. Source ownership remains one-way: Shared, Document Intelligence, AI Inference, Platform and Lifecycle generic modules are consumed through public contracts, not copied.

Keep dated verification, immutable source/crosswalk references, source-owned history and `archive/media-desktop-apps` while they have real consumers. Retire a candidate only after identifying its live imports, tests, generator outputs, migration references and release consumers, with no alias drift. Historic reports belong in explicit history and should not be linked as current implementation instructions.

## Limits of this review

A full Git tree census and targeted current-source inspections support the cleanup; the remote GitHub connection does not execute local pnpm, Gradle, cargo, container, or Python suites. Full build verification and regeneration of any affected generated source-index projections must occur against an actual checked-out source cut before claiming the implementation clean/qualified. No post-cleanup full-suite success or production release admission is asserted here.
