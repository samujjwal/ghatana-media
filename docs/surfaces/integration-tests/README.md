# Surface: `integration-tests`

Composable Media integration test module (`integration-tests`,
`:services:media:integration-tests`). Exercises the canonical REST/gRPC
surfaces, provider workers, source authorization, outbox and restart
behavior — not fixture-only unit coverage.

## Responsibility

- Compositional tests of canonical REST/gRPC against configured server
  capabilities; provider effects are **observed** (job/artifact/store
  state) rather than inferred from HTTP 202 or event append.
- Reusable fixtures are kept with their owning modules; scenario tests
  live here.
- `MediaTestHarnessCatalogTest` keeps the executable inventory
  [`media-integration-test-census.v1.json`](../../docs/implementation/
  media-integration-test-census.v1.json) aligned with source files and
  JUnit selectors — every Java test source is classified with runnable
  selectors, owning paths, JUnit/Gradle profile, infrastructure, input
  assets, prerequisites, safety boundaries and evidence limits.

## Public operations

Test classes under `com.ghatana.media.integration`,
`com.ghatana.media.launcher`, `com.ghatana.audio.video.integration`
(e.g. `MediaLauncherEndToEndIT`, `MediaRuntimePostgresWorkflowMetricsIT`,
`MediaMultimodalParentChildRestartPostgresIT`,
`MediaProviderPolicyDeniedFinalityPostgresIT`,
`MediaSttTranscriptCommitFenceIT`, `MediaProviderJobLifecycleE2ETest`,
`MediaPdp3BusinessRecordingIT`, `PerformanceIntegrationTest`).

## States and invariants

- `:services:media:integration-tests:test` includes **only** JUnit tests
  tagged `integration`; a class selector does not include untagged or
  `@Disabled` scaffolds.
- Container suites use `IntegrationImagesCondition` and report a skip
  unless both selected images are immutable `repository@sha256:<64-hex>`
  references and Docker reports each exact repository digest locally.
  This proves digest availability only — not image approval,
  signature, provenance or host qualification. Image variables
  `AUDIO_VIDEO_STT_IMAGE` / `AUDIO_VIDEO_TTS_IMAGE` default to mutable
  `:latest` tags and are **not** qualification inputs.
- Positive, denied, UNKNOWN and restart paths are all in scope; tests
  must run from a clean source checkout.

## Dependencies and configuration

- Docker + Testcontainers for Postgres/LocalStack profiles; H2/
  LocalStack alternatives documented per suite.
- Provider model fixtures are local/synthetic; no live provider
  credentials.

## Errors

Skipped-vs-passed is explicit: container suites skip honestly when
immutable digests are absent rather than fabricating a pass.

## Tests and commands

```bash
# Inventory contract only — no Docker or provider/model execution
./gradlew :services:media:integration-tests:test \
  --tests com.ghatana.media.integration.MediaTestHarnessCatalogTest

# Local fixture selectors (synthetic/local state only)
./gradlew :services:media:integration-tests:test \
  --tests com.ghatana.media.integration.MediaProviderJobLifecycleE2ETest \
  --tests com.ghatana.media.integration.MediaPdp3BusinessRecordingIT

# Synthetic 1/16/64 workload — local dispatcher fixture, not transport/provider evidence
./gradlew :services:media:integration-tests:test \
  --tests com.ghatana.audio.video.integration.PerformanceIntegrationTest

# Isolated Docker-backed Postgres/LocalStack or H2/LocalStack profiles
./gradlew :services:media:integration-tests:test \
  --tests com.ghatana.media.integration.MediaLauncherEndToEndIT \
  --tests com.ghatana.media.integration.MediaRuntimePostgresWorkflowMetricsIT \
  --tests com.ghatana.media.launcher.MediaMultimodalParentChildRestartPostgresIT \
  --tests com.ghatana.media.launcher.MediaProviderPolicyDeniedFinalityPostgresIT \
  --tests com.ghatana.media.launcher.MediaSttTranscriptCommitFenceIT
```

See the module README for the full census-driven selector list and
image-digest prerequisites.
