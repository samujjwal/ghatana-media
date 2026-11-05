# Surface: `audio-video-observability`

Media operations-behavior support module (`audio-video-observability`,
Java/Gradle, `:services:media:audio-video-observability`). It supplies
readiness, bounded workflow metrics, gRPC instrumentation and tracing for
STT, TTS, Vision, Multimodal and the launcher. It reuses Shared
observability, Micrometer and OpenTelemetry — it owns no independent
Media business RPC, provider, job store or generic telemetry engine.

## Responsibility

- `AudioVideoHealthService` — startup readiness plus a nonempty complete
  set of passing checks; shutdown clears serving state. Dependency checks
  are bounded (250 ms default, 5 s maximum).
- `MediaWorkflowMetrics` — bounded-cardinality metrics for job
  processing/delivery: stage timers, event counters, provider-profile
  gauges and quality-series samples with finite label vocabularies.
- `AudioVideoGrpcInstrumentation`, `AudioVideoTracingService` — gRPC
  instrumentation and trace context across asynchronous work.

## Public operations

| Class | Role |
| --- | --- |
| `AudioVideoHealthService` | Readiness/liveness checks with bounded dependency probes |
| `MediaWorkflowMetrics` | Bounded metrics instruments and typed samples |
| `MediaWorkflowMetrics.ProviderProfileObservation` | Provider/model profile gauge input (metric-safe identities only) |
| `MediaWorkflowMetrics.ProviderQualitySeriesSample` | Bounded quality-metric series (closed metric vocabulary, approved locale spellings) |
| `MediaWorkflowMetrics.ModalityTimingSample` | Stage timing samples |
| `AudioVideoGrpcInstrumentation` | gRPC server/client instrumentation |
| `AudioVideoTracingService` | Trace propagation and redaction |

## States and invariants

- **Bounded cardinality is mandatory**: no tenant, clip, speaker, request
  or content identifiers in metric tags; per-operation diagnosis belongs
  in access-controlled traces. New instruments must retain finite label
  vocabularies and never carry secrets or raw provider diagnostics.
- Absent series stay unknown/NaN — never fabricated zeroes; stale
  measurements and hostile labels are rejected.
- Quality metric names are a closed vocabulary; model revisions and
  locales are validated metric identities, not free text.

## Dependencies and configuration

- Shared observability primitives, Micrometer, OpenTelemetry; consumed by
  the modality services and launcher. Alert rules consume the metric
  identities — changes require consumer tests.

## Errors

`IllegalArgumentException` for out-of-vocabulary metrics/labels and
invalid profile observations; health checks report typed pass/fail
within their time bound rather than throwing provider detail.

## Tests and commands

```bash
./gradlew :services:media:audio-video-observability:test \
  -Pghatana.media.compositeScope=FOCUSED \
  -Pghatana.media.focusedModules=observability
```

Coverage: empty/missing/slow health checks, startup/shutdown, trace
scope cleanup, hostile labels, privacy markers, stale measurements,
alert rules, and the c1/16/64 resource-profile harness (local-test
workload, `NOT_ADMITTED`, not an SLO result). Deployed alert delivery and
real modality baselines are not proven by fixtures.
