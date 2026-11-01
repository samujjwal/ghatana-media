# Media integration test inventory

The executable IT-01 inventory is [`media-integration-test-census.v1.json`](../docs/implementation/media-integration-test-census.v1.json). It classifies every Java test source under this module and records runnable selectors, owning source paths, JUnit/Gradle profile, infrastructure, input assets, prerequisites, safety boundaries, and evidence limits. `MediaTestHarnessCatalogTest` checks that the inventory remains aligned with source files and JUnit selectors.

## How the Gradle task selects tests

Run from the repository root. The `:services:media:integration-tests:test` task includes only JUnit tests tagged `integration`; passing a class selector does not include an untagged or `@Disabled` scaffold. Container suites use `IntegrationImagesCondition` and report a skip when their selected images are absent. Image variables are `AUDIO_VIDEO_STT_IMAGE` and `AUDIO_VIDEO_TTS_IMAGE`; defaults are mutable `:latest` tags and are not qualification inputs.

```bash
# Inventory contract only; no Docker or provider/model execution
./gradlew :services:media:integration-tests:test \
  --tests com.ghatana.media.integration.MediaTestHarnessCatalogTest

# Local fixture selectors (synthetic/local state only)
./gradlew :services:media:integration-tests:test \
  --tests com.ghatana.media.integration.MediaProviderJobLifecycleE2ETest \
  --tests com.ghatana.media.integration.MediaPdp3BusinessRecordingIT

# Isolated Docker-backed Postgres/LocalStack or H2/LocalStack profiles
./gradlew :services:media:integration-tests:test \
  --tests com.ghatana.media.integration.MediaLauncherEndToEndIT \
  --tests com.ghatana.media.integration.MediaRuntimePostgresWorkflowMetricsIT \
  --tests com.ghatana.media.launcher.MediaMultimodalParentChildRestartPostgresIT \
  --tests com.ghatana.media.launcher.MediaProviderPolicyDeniedFinalityPostgresIT \
  --tests com.ghatana.media.launcher.MediaSttTranscriptCommitFenceIT
```

These fixture profiles use generated or test-authored payloads and isolated databases, buckets, and keys. Never point them at the active legacy Media store. H2 compatibility mode is not PostgreSQL-engine evidence; LocalStack is not AWS-production evidence; fixture providers do not establish model quality, rights, or provider effects. The child-process PostgreSQL metrics variant is separately run with `./gradlew :services:media:integration-tests:postgresWorkflowProcessRestart`.

The `MediaAuthorizedSttTranscriptRestartIT` is an external qualification profile, not part of routine local fixture execution. It requires separately reviewed `GHATANA_MEDIA_WHISPER_PROFILE`, `GHATANA_MEDIA_WHISPER_AUDIO`, and `GHATANA_MEDIA_WHISPER_GOLD_TRANSCRIPT` inputs plus independently verified rights for both model and source audio. The repository contains no such licensed corpus or profile. Do not copy customer/private inputs into the repository or test reports; missing inputs are not grounds to weaken the admission gate.

The Compose startup-refusal selectors require `AUDIO_VIDEO_STT_IMAGE` and `AUDIO_VIDEO_TTS_IMAGE` pinned by owner-approved digest and Docker Compose. A passing refusal test proves only typed startup refusal, not a successful provider operation. Previously recorded Wave 2 Compose results are tracked separately and are not changed by this inventory.

Other modules own additional integration suites: `:services:media:modules:integration-tests`, `:services:media:providers:aws-postgresql`, and `:services:media:audio-video-observability`. They are outside this module's selector and are listed as unrepresented source areas in the canonical census.
