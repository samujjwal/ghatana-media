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
  gauges and quality-series samples with finite label vocabularies. The
  canonical launcher stream-frame path records `media.capture.frames` only
  after exact provider acknowledgement and canonical-store readback; ambiguous
  frame finality is counted as `outcome="unknown"`. Labels are limited to the
  fixed `kind`, `outcome`, `service`, and contract version values.
- Each gRPC service supplies its process-local Prometheus registry to the
  shared `HealthMetricsServer`; that sidecar combines those instruments with
  the bounded gRPC/readiness exposition. The standalone launcher keeps its
  separate registry and `/metrics` route because it is a separate process.
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
- An inconclusive provider poll carries its start timestamp. A slow failure
  cannot clear a newer health or quality snapshot published while it was
  waiting; equal-time outcomes stay conservative because their order is
  ambiguous.
- `ProviderProfileObservation` rejects recognizable credential-shaped
  identities, including GitHub PAT and app-token prefixes, before the value
  can enter registry tags. This is label redaction at the metrics boundary;
  it does not qualify deployed scrape or alert delivery.
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

bash infra/monitoring/tests/promtool-rules.sh

RUN_MEDIA_ALERT_DELIVERY_TEST=1 bash infra/monitoring/tests/alert-delivery-smoke.sh
```

Coverage: empty/missing/slow health checks, startup/shutdown, trace
scope cleanup, hostile labels, privacy markers, stale measurements,
alert rules, and the c1/16/64 resource-profile harness (local-test
workload, `NOT_ADMITTED`, not an SLO result). Deployed alert delivery and
real modality baselines are not proven by fixtures.

The resource-profile harness validates report bounds and latency percentile
ordering at construction, including explicit unavailable percentiles for a
zero-sample run. These checks protect fixture reports; they do not establish
provider capacity or quality.

`MediaWorkflowMetricsTest.prometheusScrapePreservesUnknownQualityAsNanWithoutIdentityLabels`
checks the actual Prometheus exposition format: readiness may be measured
while absent quality freshness remains `NaN`. The promtool suite exercises
alert activation and recovery from recorded fixtures. The opt-in Docker smoke
uses pinned, locally cached Prometheus and Alertmanager images and verifies a
test-only firing **and** resolved webhook POST; it does not contact an external
receiver or establish production delivery. Set `MEDIA_RESOURCE_PROFILE_OUTPUT`
when running `MediaResourceProfileHarnessTest` to retain its local TSV report.
Each production service composition must pass its own registry into its
`MediaWorkflowMetrics` instrumentation and sidecar scrape. The standalone
launcher exposes a separate runtime registry at `/metrics`. Real authorized
profile and quality observations still come from their owning providers.
Canonical capture frame outcomes have a runtime-owned success/unknown counter
and a warning rule for recent ambiguous outcomes. This does not provide a
render metric: the render path has no canonical runtime producer or metrics
handoff, so render remains absent/unknown rather than zero. Capture telemetry
does not establish model quality or provider eligibility.
