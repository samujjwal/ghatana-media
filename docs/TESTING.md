# Media testing

## Scope and intent

The active Media test surface covers runtime contracts, artifact upload and
durability, job lifecycle and recovery, streams and backpressure, consent and
privacy, provider governance/fallback, HTTP security/routes, and the durable
S3/PostgreSQL adapters. Local closure is intentionally split by dependency:
fast tests use in-memory fakes; durable tests use H2 or Testcontainers; the
full integration surface requires Docker. None of these focused commands
requires real customer media or a remote provider.

There is no active aggregate `service-contract.yaml`. Contract validation uses
the source-specific authorities: OpenAPI plus the route manifest for HTTP,
protobuf descriptors for gRPC, provider manifest entries for provider
availability, and the canonical PDP-1/PDP-3 registries for semantic and
experience parity. Do not recreate an aggregate file as a second source of
truth.

Media tests and structural checkers produce local observations only.
`ghatana-tools` supplies reusable Product Definition/Experience validation and
generic Explorer mechanics; `ghatana-lifecycle` owns cross-repository evidence
admission, currentness, receipts, readiness, and convergence outputs. A passing
Media test or applicability audit does not assign `CLOSED`, `CURRENT`, or
`READY` and does not issue receipts or calculate convergence distance.

## Test layers

| Layer | Intent | External dependencies | Primary locations | Applicability |
| --- | --- | --- | --- | --- |
| Tier 0: runtime contracts | Validate modality/provider identities, disclosure sanitization, privacy sanitizers, and fallback rules | None | runtime-contracts/src/test/java | Every contract or governance change |
| Tier 1: in-memory runtime | Validate MediaRuntime state machines, local stores/providers, consent, jobs, streams, timeout, restart reconciliation, and security | None | launcher/src/test/java | Default local closure and PR feedback |
| Tier 1: feature modules | Validate STT, TTS, vision, multimodal, audio-stream, and video-stream domain behavior | Usually none; module fakes | Corresponding modules/*/src/test | When a modality or stream implementation changes |
| Tier 2: provider/storage adapter | Validate HTTP provider fences/governance and PostgreSQL/S3 store semantics with embedded or containerized dependencies | H2 for some tests; Testcontainers PostgreSQL/LocalStack for integration cases | providers/aws-postgresql/src/test/java | Storage, provider, consent, or migration changes |
| Contract/API | Verify route manifest and OpenAPI consumption | None | modules/integration-tests/src/test/java | Required when routes, schemas, or permissions change |
| Tier 3: full integration | Exercise complete workflows, provider lifecycle, durable stores, and service boundaries | Docker/Testcontainers | integration-tests/src/test | Main/release validation when infrastructure is available |

## Locations, fixtures, and providers

Important runtime-contract tests include
MediaExternalDisclosureSanitizerTest, MediaModalityContractsTest,
MediaPrivacySanitizersTest, and MediaProcessingProviderFallbackContractTest.

Launcher coverage includes MediaRuntimeActiveTest,
MediaRuntimeConfigValidationTest, MediaRuntimeJobGovernanceTest,
MediaRuntimeJobTimeoutTest, MediaRuntimeRestartReconciliationTest,
MediaRuntimeStreamTimeoutTest, MediaConsentRevocationTest,
MediaSemanticRedactionRuntimeTest, MediaSecurityFilterTest, and
MediaHttpTerminalFrameBodyTest. These tests use local stores, deterministic
providers, byte arrays, synthetic identifiers, and provider fakes to keep
failure and recovery deterministic.

The durable provider tests include PostgreSQL/H2 state tests, HTTP processing
and streaming provider tests, external governance, cancellation fences, and
close fences. Testcontainers-backed cases use PostgreSQL and LocalStack for
the S3/object-store behavior. The OpenAPI consumption test is
MediaOpenApiContractConsumptionTest under
modules/integration-tests/src/test/java.

The source has separate speech, vision, multimodal, audio-stream, and
video-stream test suites. They validate feature modules and provider contracts;
they do not by themselves prove that the standalone launcher has a configured
external provider.

## Focused local commands

Run from the repository root:

    pnpm check:development-version-policy
    pnpm test:presentation-architecture
    pnpm check:presentation-architecture
    pnpm test:tools-media-consumer
    pnpm test:shared-media-consumer
    pnpm check:product-experience-local
    pnpm test:product-experience-local
    pnpm test:experience-browser

    ./gradlew :services:media:runtime-contracts:test
    ./gradlew :services:media:launcher:test --tests 'com.ghatana.media.launcher.MediaRuntimeActiveTest'
    ./gradlew :services:media:launcher:test --tests 'com.ghatana.media.launcher.MediaRuntimeRestartReconciliationTest'
    ./gradlew :services:media:launcher:test --tests 'com.ghatana.media.launcher.MediaConsentRevocationTest'
    ./gradlew :services:media:launcher:test --tests 'com.ghatana.media.launcher.MediaRuntimeStreamTimeoutTest'
    ./gradlew :services:media:providers:aws-postgresql:test --tests 'com.ghatana.media.provider.aws.MediaAwsPostgresqlRuntimeStateTest'
    ./gradlew :services:media:providers:aws-postgresql:test --tests 'com.ghatana.media.provider.aws.MediaHttpProvidersTest'
    ./gradlew :services:media:modules:integration-tests:test \
      --tests 'com.ghatana.audio.video.integration.MediaOpenApiContractConsumptionTest'
    ./gradlew :services:media:launcher:check --no-build-cache
    ./gradlew :services:media:providers:aws-postgresql:check --no-build-cache

The full integration target is intentionally separate:

    ./gradlew :services:media:integration-tests:test

It runs integration-tagged workflows and requires Docker/Testcontainers. Use
it when durable infrastructure and external test dependencies are available,
not as the fast local closure command.

## Product-definition generation order

After changing Product Definition sources, regenerate the manifest and Explorer
index before projecting the three phase candidates. Then regenerate the manifest
and index to capture refreshed candidate source references, run that generation
again to confirm byte-stable output, and perform strict projection checks:

    pnpm generate:product-definition-manifest
    node scripts/generate-media-phase-projections.mjs
    pnpm generate:product-definition-manifest
    pnpm generate:product-definition-manifest
    node scripts/generate-media-phase-projections.mjs --check --strict
    node scripts/generate-media-phase-projections.mjs --check --strict

Each generated candidate carries the current public schema's top-level field
inventory. Generation fails when a schema field lacks a candidate mapping or
disposition, when a required field is omitted, or when an empty collection has
neither a blocker nor an explicit empty-source disposition. The residual audit
independently rereads the public schema and checks that inventory against the
candidate and mapping records. These checks catch top-level omissions; they do
not establish nested semantic completeness, owner acceptance, or Lifecycle
currentness. The regression is covered by
`tests/media-product-definition-residuals.test.mjs`.

The phase candidates are themselves indexed Product Definition files. Their
generated `sourceAuthorities` can add explicit source-path mentions, including
PDP-3 screen-contract paths, so the post-projection manifest pass updates the
provenance-only dependency edges. This is an expected synchronization step; it
does not make those edges semantic dependencies or currentness evidence.

Current isolated-build note: the focused STT compile is still blocked during
external sibling composite configuration by
`ghatana/integration-tests/service-contract-test-utils/build.gradle.kts:16`;
the shared version catalog does not expose `libs.jackson.dataformat.yaml` in
that checkout. This is recorded as a build-environment/sibling-repository
blocker, not converted into a Media build pass.

The browser experience audit starts from a running Explorer preview at
`http://127.0.0.1:4179/` and exercises all 29 synthetic scenarios, the generated
source index, all 47 valid Product proposal routes, the inline
artifact-verification specialization, Verify, keyboard mode/phase navigation,
accessible names, console/page errors, and horizontal overflow at six recorded
viewports. It writes screenshots and a JSON report to
`/tmp/media-experience-browser-audit` by default. This is deterministic browser
evidence and visual-review input; it is not independent human approval,
pixel-reference conformance, or lifecycle-owned acceptance evidence.

The 2026-10-08 rerun against the regenerated 315-record index passed across all
29 scenarios, 47 Product proposal routes, the dedicated `#tools-review` route,
and six viewports, with no assertion, console, or page errors. The Tools Review
assertion verifies the consumer result, local SNAPSHOT label, absent Lifecycle
currentness, and no owner acceptance. The report is stored under
`/tmp/media-experience-browser-audit`.

The Media manifests request Shared and Tools packages at `0.1.0-SNAPSHOT`.
The Media pnpm workspace now resolves these from sibling source packages, and
the workspace install plus the Explorer dependency-closure build and typecheck
pass. The lockfile records those dependencies as local workspace links. This
does not prove public registry resolution or immutable release binding. The
`test:shared-media-consumer` script remains a separate isolated consumer check
that packs local Shared development artifacts, compiles and packs Media UI
against those tarballs, then checks public exports in an isolated TypeScript and
Vite consumer.

The current Media Vite build passes but still reports browser-build warnings for
externalized `fs/promises` and `node:path` imports from Shared's
`AccessibilityAuditorEngine.js`, ignored `use client` directives in the
`lucide-react` dependency tree, Zod annotations, and a chunk above 500 KB. These
remain part of GAP-02.

The `test:tools-media-consumer` harness builds and packs the Tools Product
Development dependency closure in a fresh temporary directory, stages only the
Media experience package and consumer bridge, imports Tools validators, checks
schema exports, projects a synthetic Product Definition through public
Development Traceability, and exercises public exports via `createExplorer`
for load, render, inspect, and dispatch. It also checks that no Lifecycle
currentness is claimed. The Vite Tools Review route runs this same bridge; the
Product and Explore modes remain Media-owned. The harness requires the adjacent
`ghatana-tools` checkout and its installed build dependencies; it does not prove
registry publication, Tools owner acceptance, production host integration, or
Lifecycle currentness/receipts.

`pnpm check:release-version-policy` is intended for release qualification
source/artifact state; it rejects active SNAPSHOT versions and is expected to
fail on the normal development branch.

## Dependency and artifact admission boundary

The checked local profiles are development and consumer-verification profiles,
not release dependency profiles. The Media workspace pins its declared Shared
TypeScript packages to `0.1.0-SNAPSHOT`, Tools Product Development packages to
`0.1.0-SNAPSHOT`, Lifecycle TypeScript packages to `0.1.0-rc.1`, and
`@ghatana/evidence-contracts` to `0.1.0-rc.1`. Workspace substitution resolves
those coordinates from sibling source. Isolated Shared and Tools checks pack
local source artifacts; `test:lifecycle-consumer-artifact` deploys the sibling
Lifecycle Evidence Contracts package and tests it from an isolated consumer.
These checks establish local public-export/consumer behavior for those observed
artifacts, not immutable registry artifacts or upstream owner acceptance.

The reuse decision record still marks release admission and the transitive
SBOM/license review as pending. In particular, the Lifecycle Evidence Contracts
package metadata reports `UNLICENSED`; this is not a legal permission or
prohibition finding, and distribution remains blocked pending owner license
resolution and dependency review. Shared accessibility has a recorded
`axe-core` MPL-2.0 transitive-license caveat. No full distribution SBOM or
independent license decision is established by the local consumer tests.
External codecs, engines, models, model weights, fonts, and media assets remain
unadmitted until their exact version/build and distribution profile pass the
reuse, license, security, isolation, and benchmark gates. A source candidate or
successful local build does not admit it for runtime or distribution.

## Development composite builds

In a standalone checkout, `./gradlew` includes the Media Gradle projects plus
available sibling `ghatana-shared`, `ghatana-tools`, and `ghatana-kernel` builds.
Declared Shared and Tools dependencies resolve to their canonical source
projects through dependency substitution. The verified versions are Shared
`0.1.0-SNAPSHOT`, Tools Java runtime `0.1.0-rc.1`, Tools Product Development
TypeScript packages `0.1.0-SNAPSHOT`, and Kernel `0.1.0` (stable, without a
SNAPSHOT suffix). The version-policy checker enforces these Gradle coordinates
and the included Shared, Tools, and Lifecycle TypeScript package trains. The
composite is optional when a sibling checkout is absent; in that case Gradle
uses the declared published coordinates. The sibling `ghatana-lifecycle` is
also included as a separate composite and pnpm workspace source; Lifecycle
remains independently owned from Tools. Its root and TypeScript package
versions are `0.1.0-rc.1`; the Evidence Generator embeds
`0.1.0-rc.1` in its package and Gradle artifact coordinates. Its
`tool-product.json` and checked-in resource template carry `0.1.0-SNAPSHOT`
metadata; the Evidence Generator `processResources` rule rewrites the generated
JAR resource identity from the Gradle project version, verified as
`0.1.0-rc.1`. Media currently has no direct Lifecycle dependencies, so this
makes Lifecycle source projects available to local development without adding
a Media product dependency or substituting an artifact that Media does not
consume. Lifecycle's tarball overrides stay in Lifecycle's standalone
workspace configuration; this description does not assert those overrides
apply when Media is the workspace root.

`./gradlew projects` lists the included builds. Use Gradle `dependencyInsight`
for `com.ghatana.platform:core`, `com.ghatana.platform:tool-runtime`, or
`com.ghatana.kernel:kernel-product-api` to confirm source substitution. Media's
pnpm composite workspace includes the Media packages, all Shared TypeScript
packages, and the 11 Tools Product Development packages in the Media app's
dependency closure, plus Lifecycle's `libs/*` and `tools/*` packages. Named
`shared`, `tools`, and `lifecycle` catalogs keep sibling toolchain ranges
isolated, and exact SNAPSHOT dependencies
resolve to local source. From Media, `pnpm install` prepares that graph and
`pnpm --filter @ghatana/media-experience-explorer... run build` or `run typecheck`
builds/checks its dependency closure. The Tools Product Development source set
excludes Lifecycle-owned closure and evidence packages; they resolve from the
separate `ghatana-lifecycle` sibling. Tools and Shared packages outside this
Media consumer closure retain their own workspace setup.

## Failure, recovery, and concurrency coverage

| Behavior | What to exercise | Relevant tests |
| --- | --- | --- |
| Upload integrity | Sequential chunks, bounds, per-chunk/full checksum, finalization claim, dedup, incomplete cleanup | Durable runtime-state tests and launcher upload tests |
| Job idempotency and leases | Same tenant/request, optimistic version, worker lease, stale owner/fence, bounded concurrency | MediaRuntimeActiveTest and provider runtime-state tests |
| Job timeout/fallback | Provider timeout, safe fallback, terminal failure, no blind duplicate after restart | MediaRuntimeJobTimeoutTest, fallback contract, HTTP provider tests |
| Restart recovery | Non-terminal job reconciliation and unknown provider outcome | MediaRuntimeRestartReconciliationTest |
| Cancellation truth | Confirmed, unconfirmed, unsupported cancellation and close fences | Launcher cancellation tests and provider fence tests |
| Consent/privacy | Expiry, revocation, purpose/region/retention/biometric checks, semantic redaction | MediaRuntimeJobGovernanceTest, MediaConsentRevocationTest, MediaSemanticRedactionRuntimeTest, privacy tests |
| Stream safety | Token hash, reconnect lease, sequence acknowledgement, timeout, bounded buffer, close | MediaRuntimeStreamTimeoutTest, terminal-frame and stream module tests |
| Security and transport | Tenant/principal binding, permissions, request bounds, route availability | MediaSecurityFilterTest, OpenAPI consumption test |
| Durable recovery | PostgreSQL migrations, S3 object/chunk state, leases, consent, physical retention/erasure | AWS/PostgreSQL runtime-state and integration tests |

Concurrency tests must demonstrate one durable job for an idempotent request,
one valid worker lease, optimistic conflict handling, bounded active jobs,
ordered stream frames, and no buffer growth beyond the configured bound.

## Suite applicability and honest limits

- Run runtime-contract and launcher in-memory tests for every Media domain or
  policy change.
- Run the provider module tests for HTTP provider, S3/PostgreSQL, migration,
  consent, privacy, or lease changes. Container-backed cases may require Docker
  and network access to the test services.
- Run the OpenAPI consumption test for route/schema/permission changes.
- Run the full integration module only when the required containers and
  provider fixtures are available. Its success is not implied by a local
  diagnostic launcher run.
- Local stores are non-durable and local providers are diagnostic. They do not
  validate real media quality, remote cancellation truth, S3/PostgreSQL
  failover, Event Plane delivery, or production erasure guarantees.
