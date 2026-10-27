# Audio-video observability

## Purpose, consumers and boundary

This Media support module supplies readiness, bounded workflow metrics, gRPC instrumentation and tracing for STT, TTS, Vision, Multimodal and the launcher. It reuses Shared observability, Micrometer and OpenTelemetry; it owns no independent Media business RPC, provider, job store or generic telemetry engine. Its build unit is `:services:media:audio-video-observability`.

`AudioVideoHealthService` requires explicit startup readiness plus a nonempty complete set of passing checks; shutdown clears serving state. Dependency checks are bounded (250 ms default, 5 s maximum). `MediaWorkflowMetrics`, `AudioVideoGrpcInstrumentation` and `AudioVideoTracingService` carry bounded dimensions and permitted correlation across asynchronous work. New instruments must retain finite label vocabularies and avoid content, tenant/user/request identifiers, secrets and raw provider diagnostics.

The [Wave 2 plan](../docs/implementation/MEDIA-BACKEND-MODALITY-WAVE2-EXECUTION.md) owns OBS-01–10 and current dispositions. [Operations](../docs/OPERATIONS.md), [TESTING](../docs/TESTING.md) and [EVIDENCE](../docs/EVIDENCE.md) supply runbook guidance, prerequisites and proof requirements. This module has no GUI or model inference, so direct GUI accessibility and model-quality evaluation are N/A; truthful provider/quality reporting and Unicode-safe diagnostics remain applicable.

## Testing and change policy

Run affected selectors with `-Pghatana.media.compositeScope=FOCUSED -Pghatana.media.focusedModules=observability` and the module's `test` task from the Media root. Required cases include empty/missing/slow health checks, startup/shutdown, trace scope cleanup, hostile labels, privacy markers, stale measurements and alert rules. Keep metric identities compatible with existing rules; changes require consumer tests. Fixtures do not prove deployed alert delivery or a real modality baseline.

## Local resource profile fixture

The test-only resource profiler runs bounded local workloads at concurrency 1, 16, and 64 and
records operation p50/p95/p99, throughput, JVM process CPU time, peak JVM heap use, and peak thread
count. It emits a TSV row scoped as `local-test-workload-no-provider`, marked `NOT_ADMITTED`, with
the requested operation count, configured time budget, runtime environment, and measured-resource
caps/results. The model and corpus are `NOT_CONFIGURED`. This is a harness check, not a Media
modality benchmark or an SLO result.

Run the focused fixture from the Media repository root:

```sh
MEDIA_RESOURCE_PROFILE_OUTPUT="$PWD/build/reports/media-resource-profile.tsv" \
  ./gradlew :services:media:audio-video-observability:test \
  --tests 'com.ghatana.audiovideo.observability.performance.MediaResourceProfileHarnessTest'
```

GPU memory, native allocator memory, connection-pool size, network bytes, FFmpeg child-process
resources, model real-time factor, and video frames per second are emitted as `NOT_MEASURED` until
the owning modality or process adapter supplies those probes. Timeout cancellation is cooperative
inside this JVM; native or FFmpeg work requiring hard termination must run behind a bounded process
boundary. No model, corpus, or provider qualification is inferred from this fixture.
