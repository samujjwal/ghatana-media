# Audio-video observability

## Purpose, consumers and boundary

This Media support module supplies readiness, bounded workflow metrics, gRPC instrumentation and tracing for STT, TTS, Vision, Multimodal and the launcher. It reuses Shared observability, Micrometer and OpenTelemetry; it owns no independent Media business RPC, provider, job store or generic telemetry engine. Its build unit is `:services:media:audio-video-observability`.

`AudioVideoHealthService` requires explicit startup readiness plus a nonempty complete set of passing checks; shutdown clears serving state. Dependency checks are bounded (250 ms default, 5 s maximum); each service may register at most 64 health checks, each with a name of at most 128 characters, and at most 128 watch subscribers. `MediaWorkflowMetrics`, `AudioVideoGrpcInstrumentation` and `AudioVideoTracingService` carry bounded dimensions and permitted correlation across asynchronous work. Production gRPC services use a process-local Prometheus registry and expose its scrape through the shared health sidecar alongside gRPC/readiness counters. The launcher registry remains process-local and separate. New instruments must retain finite label vocabularies and avoid content, tenant/user/request identifiers, secrets and raw provider diagnostics.

For gRPC health requests, an empty service name asks for overall server readiness and the configured service name asks for that service’s readiness. `Check` returns `NOT_FOUND` for another name; `Watch` initially emits `SERVICE_UNKNOWN` and stays open. A Watch retains only a fixed service classification, never the caller’s name; the name is not echoed or used as a metric label. For example, a server configured as `stt-service` answers `stt-service` with its live readiness, while `tts-service` is unknown on that server.

Tracing exports operation and tenant identifiers only as presence flags. Failure traces and structured logs omit exception messages and reduce exception classes to a fixed category (`timeout`, `security`, `invalid_argument`, `invalid_state`, `io`, `runtime`, `checked`, or `unknown`); application-defined class names never become telemetry values.

The [Wave 2 plan](../docs/implementation/MEDIA-BACKEND-MODALITY-WAVE2-EXECUTION.md) owns OBS-01–10 and current dispositions. [Operations](../docs/OPERATIONS.md), [TESTING](../docs/TESTING.md) and [EVIDENCE](../docs/EVIDENCE.md) supply runbook guidance, prerequisites and proof requirements. This module has no GUI or model inference, so direct GUI accessibility and model-quality evaluation are N/A; truthful provider/quality reporting and Unicode-safe diagnostics remain applicable.

## Testing and change policy

Run affected selectors with `-Pghatana.media.compositeScope=FOCUSED -Pghatana.media.focusedModules=observability` and the module's `test` task from the Media root. Required cases include empty/missing/slow health checks, configured and unknown service names for Check/Watch, startup/shutdown, trace scope cleanup, hostile labels, privacy markers, stale measurements and alert rules. Keep metric identities compatible with existing rules; changes require consumer tests. Fixtures do not prove deployed alert delivery or a real modality baseline.

## Local resource profile fixture

The test-only resource profiler runs bounded local workloads at concurrency 1, 16, and 64 and
records operation p50/p95/p99, throughput, JVM process CPU time, and sampled maxima for JVM heap,
process RSS, and thread count. Heap/thread samples are taken every 10 ms and process RSS samples
every 250 ms, so a short-lived spike between samples can be missed; the TSV names these values
`*_sampled_peak_*` to preserve that limitation in exported artifacts. It emits a row scoped as
`local-test-workload-no-provider`, marked `NOT_ADMITTED`, with
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
