# Media integration test inventory

The executable IT-01 inventory is [`media-integration-test-census.v1.json`](../docs/implementation/media-integration-test-census.v1.json). It classifies every Java test source under this module and records runnable selectors, owning source paths, JUnit/Gradle profile, infrastructure, input assets, prerequisites, safety boundaries, and evidence limits. `MediaTestHarnessCatalogTest` checks that the inventory remains aligned with source files and JUnit selectors.

## How the Gradle task selects tests

Run from the repository root. The `:services:media:integration-tests:test` task includes only JUnit tests tagged `integration`; passing a class selector does not include an untagged or `@Disabled` scaffold. Container suites use `IntegrationImagesCondition` and report a skip unless both selected images are immutable `repository@sha256:<64-hex>` references and Docker reports each exact repository digest locally. This proves selected-digest availability only; it does not verify image approval, signature, provenance, or host qualification. Image variables are `AUDIO_VIDEO_STT_IMAGE` and `AUDIO_VIDEO_TTS_IMAGE`; defaults are mutable `:latest` tags and are not qualification inputs. The image suite separately checks the container Java 27 runtime; record the exact image digests and host/version for any qualification run.

```bash
# Inventory contract only; no Docker or provider/model execution
./gradlew :services:media:integration-tests:test \
  --tests com.ghatana.media.integration.MediaTestHarnessCatalogTest

# Source-free DEV_ONLY client/host compositions, forced against FULL source composites
./gradlew -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE \
  -Pghatana.media.compositeScope=FULL \
  :services:media:integration-tests:test \
  --tests 'com.ghatana.media.integration.MediaTestHarnessCatalogTest' \
  --tests 'com.ghatana.media.integration.MediaDevIssuerHeadlessRestartIT.ownerIssuedDevIdentityCompletesAndReadsBackUploadAndDiagnosticJobAcrossRestart' \
  --tests 'com.ghatana.media.integration.MediaDevProjectTimelineRestartIT.realExplorerUploadsThenLinksExactArtifactVersionAcrossLauncherRestart' \
  --tests 'com.ghatana.media.launcher.MediaDevOnlyJobCancellationFinalityPostgresIT.definitiveProviderSuccessFinalizesAfterUnconfirmedCancellation' \
  --tests 'com.ghatana.media.launcher.MediaDevOnlyJobCancellationRestartPostgresIT.hardProcessLossDuringCancelDispatchReplaysUnknownWithoutRedispatch' \
  --rerun-tasks

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

These fixture profiles use generated or test-authored payloads and isolated databases, buckets, and keys. Never point them at the active legacy Media store. H2 compatibility mode is not PostgreSQL-engine evidence; LocalStack is not AWS-production evidence; fixture providers do not establish model quality, rights, or provider effects. The child-process PostgreSQL metrics variant is separately run with `./gradlew :services:media:integration-tests:postgresWorkflowProcessRestart`.

The FULL source-composite command above covers a bounded local diagnostic SDK upload/readback and CLI read observation, an Explorer upload-to-timeline exact-version link across launcher restarts, synthetic-provider cancellation finality, and UNKNOWN replay after hard process loss during local cancellation dispatch. The catalog test checks selector/source traceability. These DEV_ONLY fixtures do not establish hosted identity, rights, qualified provider output, production authority, or complete J-01–J-30 acceptance.

`MediaProviderJobLifecycleE2ETest` uses only `MediaTestHarness` in-memory maps and simulated provider results. It is selected by the `integration` tag for compatibility, but deliberately has no `production` tag. The name and lifecycle-shaped assertions do not imply durable storage or real provider behavior.

The PostgreSQL/LocalStack restart profiles have bounded evidence: `MediaLauncherEndToEndIT` covers artifact byte/hash readback; `MediaLauncherSttProcessIT` verifies artifact readback and no job/attempt/transcript/outbox change after an admitted STT request is rejected as not admitted; `MediaSttTranscriptCommitFenceIT` exercises fixture-provider commit/UNKNOWN/cancellation paths across runtime/process recovery; and the multimodal restart test checks parent/child durable state and replay without provider redispatch. These are isolated test stores and fixtures, not deployed Flyway history, the active legacy writer, AWS, or real model qualification.

`PerformanceIntegrationTest` and `MixedMediaFrameContractIT` are synthetic local selections. They exercise a test-owned bounded dispatcher and generated frame/timebase fixtures respectively. Neither measures a real codec or host CPU/RSS, frames per second, real-time factor, source PTS/VFR behavior, or transport reconnect; absent codec/provider measurements remain unverified. The Data Cloud/AEP journey classes remain disabled literal/simulated scaffolds. `MediaOptionalPlatformBoundaryIT` is a local no-effect boundary test, not a live Action Plane or Data Cloud integration.

The `MediaAuthorizedSttTranscriptRestartIT` is an external qualification profile, not part of routine local fixture execution. It requires separately reviewed `GHATANA_MEDIA_WHISPER_PROFILE`, `GHATANA_MEDIA_WHISPER_AUDIO`, and `GHATANA_MEDIA_WHISPER_GOLD_TRANSCRIPT` inputs plus independently verified rights for both model and source audio. The repository contains no such licensed corpus or profile. Do not copy customer/private inputs into the repository or test reports; missing inputs are not grounds to weaken the admission gate.

The Compose startup-refusal selectors require `AUDIO_VIDEO_STT_IMAGE` and `AUDIO_VIDEO_TTS_IMAGE` selected by immutable digest and available in Docker Compose. This local digest check does not prove owner approval or provenance. A passing refusal test proves only typed startup refusal, not a successful provider operation. Previously recorded Wave 2 Compose results are tracked separately and are not changed by this inventory.

Other modules own additional integration suites: `:services:media:modules:integration-tests`, `:services:media:providers:aws-postgresql`, and `:services:media:audio-video-observability`. They are outside this module's selector and are listed as unrepresented source areas in the canonical census.
