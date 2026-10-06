# Media testing

## Scope and intent

The active Media test surface covers runtime contracts, artifact upload and
durability, job lifecycle and recovery, streams and backpressure, consent and
privacy, provider governance/fallback, HTTP security/routes, and the durable
S3/PostgreSQL adapters. Local closure is intentionally split by dependency:
fast tests use in-memory fakes; durable tests use H2 or Testcontainers; the
full integration surface requires Docker. None of these focused commands
requires real customer media or a remote provider.

The service contract is
[../service-contract.yaml](../service-contract.yaml), and the HTTP contract
is [../contracts/openapi/media.yaml](../contracts/openapi/media.yaml).

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

The browser experience audit starts from a running Explorer preview at
`http://127.0.0.1:4179/` and exercises all 29 synthetic scenarios, all 147
source artifacts, all 47 valid Product proposal routes, the inline
artifact-verification specialization, Verify, keyboard mode/phase navigation,
accessible names, console/page errors, and horizontal overflow at six recorded
viewports. It writes screenshots and a JSON report to
`/tmp/media-experience-browser-audit` by default. This is deterministic browser
evidence and visual-review input; it is not independent human approval,
pixel-reference conformance, or Tools-native acceptance.

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
