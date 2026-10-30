# Media operations

> This guide describes operational behavior and does not report current PDP status or product meaning. Consult the [PDP source index](../.product-experience/README.md) for phase-owned definitions and live source-pinned status. No Media application has been released.

## Operational posture

Media has an active local runtime and an internal-preview service contract.
The local profile is a diagnostic composition; production-like profiles are
gated on durable artifact/job/stream state, consent/privacy maintenance,
eligible providers, and configured integrations. A local run must not be
reported as production durability, media quality, privacy-erasure, or
availability certification.

The executable entrypoint is
com.ghatana.media.launcher.MediaLauncher in launcher.
Configuration is parsed by MediaRuntimeConfig and provider/store
implementations in the launcher and durable provider modules.

## Profiles and configuration

Supported profiles are local, dev, development, test, ci, staging, production,
and sovereign, selected by MEDIA_RUNTIME_ENVIRONMENT or MEDIA_PROFILE. The
default is local.

| Area | Configuration | Default or rule |
| --- | --- | --- |
| Enablement | MEDIA_RUNTIME_ENABLED | false; must be true to bind HTTP |
| HTTP/body | MEDIA_HTTP_PORT, MEDIA_MAX_BODY_BYTES, MEDIA_MAX_CHUNK_BYTES | Port 8093; body 8 MiB max 32 MiB; chunk 4 MiB and no larger than body |
| Artifact/job bounds | MEDIA_MAX_ARTIFACT_BYTES, MEDIA_JOB_TIMEOUT_MS, MEDIA_MAX_CONCURRENT_JOBS | Artifact 10 GiB max 1 TiB; job timeout 900000 ms max 24h; concurrency 64 max 10000 |
| Store selection | MEDIA_ARTIFACT_STORE_ID, MEDIA_JOB_STORE_ID, MEDIA_STREAM_STORE_ID | Required durable store IDs in staging/production/sovereign |
| Local stores | MEDIA_LOCAL_STORES_ENABLED, MEDIA_LOCAL_PROVIDER_ENABLED, MEDIA_LOCAL_STORAGE_ROOT | Disabled by default; root build/media-runtime-local; local stores/providers are non-durable/non-production-eligible |
| External provider | MEDIA_HTTP_PROVIDER_ENDPOINT, MEDIA_HTTP_PROVIDER_TIMEOUT_MS, MEDIA_HTTP_PROVIDER_PRIORITY, MEDIA_HTTP_PROVIDER_MAX_RESPONSE_BYTES, MEDIA_HTTP_PROVIDER_REGION, MEDIA_HTTP_PROVIDER_DATA_RETENTION, MEDIA_HTTP_PROVIDER_TOKEN_REFERENCE, MEDIA_HTTP_PROVIDER_JOB_TYPES | Endpoint blank means unconfigured; production requires HTTPS, token reference, region, and known retention; remote fallback is not safe for ambiguous timeouts |
| Durable PostgreSQL | MEDIA_POSTGRES_JDBC_URL, MEDIA_POSTGRES_USER, MEDIA_POSTGRES_PASSWORD_REFERENCE, MEDIA_POSTGRES_DRIVER, MEDIA_POSTGRES_POOL_SIZE, MEDIA_POSTGRES_CONNECTION_TIMEOUT_MS | Typed password reference; pool default 16, connection timeout 10000 ms |
| Durable object store | MEDIA_S3_BUCKET, MEDIA_S3_PREFIX, MEDIA_S3_REGION, MEDIA_S3_ENDPOINT, MEDIA_S3_PATH_STYLE, MEDIA_S3_REQUEST_CHECKSUM_CALCULATION, MEDIA_S3_ACCESS_KEY_REFERENCE, MEDIA_S3_SECRET_KEY_REFERENCE | Prefix default media-runtime, region default us-east-1; use encrypted object storage and typed references |
| Consent/admin | MEDIA_CONSENT_ADMINISTRATION_ID, MEDIA_PRIVACY_MAINTENANCE_ID, MEDIA_PRIVACY_MAINTENANCE_INTERVAL_SECONDS, MEDIA_PRIVACY_PURGE_BATCH_SIZE | Consent authority and privacy maintenance must be selected for durable operation; maintenance interval default is one day |
| Retention | MEDIA_JOB_RETENTION_DAYS, MEDIA_STREAM_RETENTION_DAYS | Configure according to approved retention policy; maintenance must remove physical data, not only metadata |
| Event Plane | MEDIA_EVENT_PLANE_URL, _STREAM_ID, _TOKEN_REFERENCE, _TIMEOUT_MS | Optional locally; stream ID default media-lifecycle, timeout default 5000 ms; local publisher is synchronous best-effort, while production-like profiles require the contract's durable queue-and-retry adapter |
| Redaction | MEDIA_SEMANTIC_REDACTION_PROVIDER_ID | Required when a request demands semantic de-identification |
| Auth | MEDIA_API_KEY, bootstrap API-key settings, MEDIA_JWT_HMAC_SECRET_REFERENCE, MEDIA_JWT_ISSUER, MEDIA_JWT_AUDIENCE | Business routes require tenant/principal identity and permission; use typed secret references |

Staging, production, and sovereign profiles forbid local stores/providers and
require selected durable stores, consent authority where external providers
are used, and production-eligible providers. Never put secret values in a
configuration file, command line, log, or incident ticket.

## Startup and shutdown

For a local HTTP lifecycle check:

    MEDIA_RUNTIME_ENABLED=true \
    MEDIA_RUNTIME_ENVIRONMENT=local \
    MEDIA_LOCAL_STORES_ENABLED=true \
    MEDIA_LOCAL_PROVIDER_ENABLED=true \
    MEDIA_LOCAL_STORAGE_ROOT="$PWD/build/media-runtime-local" \
    MEDIA_HTTP_PORT=8093 \
    ./gradlew :services:media:launcher:run

The launcher composes stores, consent authorities, processing/streaming
providers, semantic redaction, privacy maintenance, and lifecycle publication
before binding HTTP. It requires at least one ready processing and one ready
streaming provider. Stop with SIGTERM/Ctrl-C; the shutdown hook closes consent
administration, privacy maintenance, and runtime resources. Wait for clean exit
before restart.

The local file artifact store may leave files under the configured root, but
local job and stream indexes are in memory. A local restart therefore loses
active job/stream state and leases; it is not restart-durable.

## Health, readiness, and routes

Operational routes are public:

| Route | Meaning | Healthy response |
| --- | --- | --- |
| GET /health, GET /api/v1/health | Overall snapshot | 200 when UP; 503 when DOWN |
| GET /health/live | Process liveness | 200 LIVE |
| GET /health/startup | Startup completion | 200 STARTED; 503 STARTING while composing |
| GET /health/ready, GET /ready | Store/provider/consent readiness | 200 READY; 503 NOT_READY until required dependencies are ready |
| GET /metrics | Runtime JSON snapshot | Includes service, ready, active jobs, and active streams; do not assume a full Prometheus metric schema |
| GET /info | Runtime disclosure/integration labels | Reports service and configured integration state |

Business routes require tenant/principal headers and the route permission:

- Consent: POST/GET /api/v1/consents and GET/DELETE
  /api/v1/consents/{consentId}
- Artifacts: POST /api/v1/artifacts/uploads, GET
  /api/v1/artifacts/uploads/{uploadId}, PUT
  /api/v1/artifacts/uploads/{uploadId}/chunks/{chunkIndex}, POST
  /api/v1/artifacts/uploads/{uploadId}/complete, and GET
  /api/v1/artifacts/{artifactId}
- Jobs: POST/GET /api/v1/jobs, GET /api/v1/jobs/{jobId}, and POST
  /api/v1/jobs/{jobId}/cancel
- Streams: POST /api/v1/streams, GET /api/v1/streams/{sessionId}, POST
  /api/v1/streams/{sessionId}/connect, POST
  /api/v1/streams/{sessionId}/frames/{sequence} with X-Stream-Token, and POST
  /api/v1/streams/{sessionId}/close
- Provider metadata: GET /api/v1/providers

Smoke checks:

    curl -fsS http://localhost:8093/health/live
    curl -fsS http://localhost:8093/health/ready
    curl -fsS http://localhost:8093/health
    curl -fsS http://localhost:8093/metrics

## Local SLO/objectives and alerts

The service contract does not declare production availability, throughput, or
latency SLOs. Local objectives are the implemented safety invariants:

- liveness is HTTP 200 and readiness is 200 only when selected stores,
  providers, and required consent dependencies are ready;
- uploads never finalize without sequential size/hash verification;
- jobs have bounded concurrency, leases, timeouts, and explicit terminal or
  unknown-cancellation state;
- streams preserve token identity, lease validity, sequence acknowledgement,
  and bounded buffering;
- consent/privacy checks fail closed and retention maintenance targets both
  metadata and physical objects.

Investigate or alert on:

- liveness failure or startup stuck;
- readiness 503, especially when a durable store, consent authority, or all
  providers are unhealthy;
- upload checksum/finalization conflicts or rising incomplete sessions;
- job lease expiry, restart reconciliation, timeout, failed fallback, or
  cancellation remaining unconfirmed;
- stream reconnect, sequence, buffer, lease, or provider timeout failures;
- consent revocation/privacy purge errors or semantic-redaction absence;
- lifecycle events logged unconfirmed or Event Plane connection failures;
- metrics scraping assumptions that require series not emitted by the current
  JSON /metrics handler.

### Wave 2 signal availability and no-data handling

Validate both checked-in rule files and the alert scenarios from the repository
root with one command:

```sh
pnpm check:monitoring-rules
```

This runs the digest-pinned Prometheus v3.15.1 `promtool` in a constrained,
read-only Docker container. It pulls that exact image on first use, so no
system-wide `promtool` installation is needed. Docker must already be available
to the current user. To use the same wrapper directly, run
`bash infra/monitoring/tests/promtool.sh --version`; it accepts the normal
`promtool` arguments and only mounts the current directory read-only. For a
user-local `promtool` command, install the self-contained wrapper without
administrator access:

```sh
mkdir -p "$HOME/.local/bin"
cp infra/monitoring/tests/promtool.sh "$HOME/.local/bin/promtool"
chmod 0755 "$HOME/.local/bin/promtool"
export PATH="$HOME/.local/bin:$PATH"
```

The rule test file evaluates local Prometheus expressions only; it does not
verify alert delivery, deployment, or the Postgres process-restart scenario.
For a separate opt-in local transport smoke, run:

```sh
RUN_MEDIA_ALERT_DELIVERY_TEST=1 bash infra/monitoring/tests/alert-delivery-smoke.sh
```

The smoke starts a test-only exporter backed by Media's `MediaWorkflowMetrics`
Prometheus registry. A deterministic synthetic provider-profile readiness
observation begins healthy, changes to unavailable, and recovers; Prometheus
scrapes the Media exporter and the unavailable alert must reach the local
Alertmanager receiver and clear after recovery. The quality observation
timestamp remains `NaN`, so the fixture supplies no measured quality. This
proves local exporter-to-receiver wiring only; it does not establish real
provider health or quality, production receiver delivery, or deployment.

The current Media Runtime Prometheus scrape emits durable workflow metrics from
`MediaWorkflowMetrics`: request/event counts, workflow-stage durations, queue
depth, `OUTCOME_UNKNOWN` backlog, overdue job leases, and expired durable
outbox claim leases. Job-store queue/backlog/lease alerts require
`media_workflow_aggregate_store_queries_supported == 1`; the outbox claim alert
requires `media_workflow_outbox_aggregate_store_queries_supported == 1`. An
unavailable query clears only its own gauges to NaN, and its explicit
unavailable alert fires only for a reported `0`. Initial or missing data is
unknown, not a zero backlog and not a healthy provider result. The outbox gauge
counts unacknowledged, non-dead-lettered claims whose stored lease has expired;
it does not estimate total pending-event age or provider health.

Provider readiness and model quality are different telemetry sources. Each
modality gRPC server constructs `AudioVideoHealthService` with required provider
checks; gRPC Health `Check`/`Watch` and its HTTP health sidecar reflect startup,
provider readiness, and drain state. The shared gRPC server lifecycle exports
the low-cardinality Prometheus gauge
`av_service_readiness{service="stt|tts|vision|multimodal"}`: `1` means the
server is serving and required provider checks are healthy; `0` means it is not
ready. Modality-specific provider-not-ready alerts fire only when an observed readiness
value is `0`; an absent or NaN series does not trigger those alerts. `SttProviderNotReady`,
`TtsProviderNotReady`, `VisionProviderNotReady`, and
`MultimodalProviderNotReady` use the bounded modality value as their fixed
`component` label and do not identify a configured provider. Public health
bodies remain coarse process/readiness signals. `GET /api/v1/providers` requires tenant and
principal headers and returns provider IDs and capability profiles, without
exposing private health details. The shared gRPC interceptor chain emits bounded
per-method call counts, final gRPC status, and duration to the sidecar
`/metrics` endpoint. It creates an OpenTelemetry server span per call when an
SDK or agent is configured; only W3C trace context is extracted, and request
metadata/baggage are not added to spans. No admitted model-quality or
provider-cost series exists, so no provider-quality regression or cost alert is
defined. An unadmitted provider or a missing quality series is
`NOT_ADMITTED` / `NO_DATA`; operators must not turn that into a zero, a passing
readiness claim, or permission to dispatch.

The public gRPC Health `Check` and `Watch` responses contain only the coarse
`SERVING`/`NOT_SERVING` status; the requested service name does not return
dependency names, exception messages, model paths, tenants, or credentials.
Readiness checks default to a 250 ms total deadline and can be configured up to
5 seconds. A slow, failed, or saturated check fails closed as `NOT_SERVING`;
do not increase the deadline as a substitute for restoring a slow dependency.

The gRPC service targets in `prometheus.audio-video.yml` scrape each
`HealthMetricsServer` sidecar at its configured `AV_HEALTH_PORT`; deployment
templates set STT/TTS/Vision/Multimodal ports to 8090/8091/8092/8093. The file
describes internal diagnostic targets and does not admit production
monitoring. Before relying on those rules, verify the intended targets are
deployed and that gRPC call series are present; absent series are not evidence
of a healthy model. The latency thresholds in candidate rules are not approved
reference-host budgets or model-quality claims.

The test-only `MediaResourceProfileHarness` records the JVM version, OS,
architecture, processor count, heap/thread samples, process RSS samples, and
readable Linux cgroup-v2 memory, CPU, and process limits. Linux RSS is sampled
from `/proc/self/status`; macOS RSS is sampled with `ps` every 250 ms. The
reported RSS is the maximum observed sample, so shorter workloads may miss
transient peaks. RSS is total resident process memory, not native-only memory
or a worker-isolation limit. An absent or unlimited cgroup value is emitted as
`NOT_MEASURED` with its reason; host processor count is not substituted for a
CPU quota. GPU, native allocator, network, FFmpeg-child, and model-specific
values remain `NOT_MEASURED` until an owning probe exists. The platform-matrix
JSON separately records the Docker limit arguments for its Linux test lane.
These fixtures do not measure real model throughput or qualify a provider.

Provider profile readiness exports the source-reported status and check time by
bounded provider/model revision labels. Degraded, unavailable, and checks older
than five minutes have modality-scoped alert rules. Quality freshness remains
unknown (`NaN`) until an admitted provider supplies a measured observation;
fixture quality alerts do not represent a live model result.

For privacy-safe triage, use public liveness/readiness and
`av_service_readiness` only for a yes/no signal.
Scrape Prometheus text from `/metrics` with an explicit Prometheus `Accept`
header rather than treating its default JSON response as a metric schema. Use
the existing authenticated provider metadata route for IDs/capability profiles.
Do not put tenant, principal, request, media, voice, face, token, model, or
provider identifiers in alert labels or copy media content into alert
annotations. If provider or quality detail is needed, keep dispatch closed and
handoff the missing telemetry source to the service owner; the current routes
do not expose a private provider-health dashboard.

For a modality readiness alert, follow its fixed `component`: check that
service's public readiness and lifecycle state, then review only that service's
existing provider configuration and redacted service diagnostics. Do not print
credential values, endpoint query strings, model paths, request content, or
tenant identifiers while triaging. Restore the configured dependency or keep
the service out of traffic until readiness recovers. The current readiness
metric does not identify which provider check failed. The exporter exposes a
quality-observation timestamp only when an admitted source records a measured
observation; the current fixture leaves it unknown (`NaN`), and no admitted
quality/regression source exists. The readiness alerts do not establish output
quality or production alert delivery.

The corresponding `*ReadinessTelemetryMissing` warning fires only when a
modality scrape target remains reachable while its readiness series is absent
for two minutes. This is a missing/stale status signal: treat provider state as
unknown, inspect scrape and metrics registration, and do not infer provider
failure, `NOT_ADMITTED`, or quality degradation from the alert. A reported zero
continues to drive the modality's `*ProviderNotReady` alert; absent/NaN provider
quality remains `NO_DATA` / `NOT_ADMITTED` and has no quality alert.

The corresponding `*ReadinessTelemetryInvalid` warning fires when the target
is reachable and the readiness gauge is present as NaN for two minutes. NaN is
invalid readiness telemetry, distinct from an absent gauge or an observed zero;
provider state remains unknown. Repair metric instrumentation and do not change,
open, close, or reroute traffic based on this warning.

## Degradation, recovery, and actionable runbook

1. Check lifecycle. Run liveness, startup, readiness, health, and metrics.
   Record profile, store IDs, provider IDs, active counts, and degradation
   state without copying media bytes or tokens.
   Treat a missing provider/quality series as `NO_DATA`/`NOT_ADMITTED`; the
   current public health routes do not provide detailed provider health.
   If `*ReadinessTelemetryMissing` fires while the scrape target is up, repair
   the scrape or readiness metric registration first. Do not use missing status
   as evidence to open, close, or reroute provider traffic.
   If `*ReadinessTelemetryInvalid` fires, repair the invalid readiness metric;
   NaN is unknown provider state and must not drive traffic changes.
2. If not ready, verify selected artifact/job/stream stores, PostgreSQL/S3
   credentials and endpoints, provider endpoint/token/region/retention, and
   consent authority readiness. Restore dependencies before reopening traffic.
3. If uploads fail, inspect the upload ID and recorded chunk indexes/hashes;
   verify sequential ordering and configured size limits. Do not mark an
   artifact complete manually without a full digest check.
4. If jobs fail or time out, inspect job lease and provider outcome. Use a
   provider fallback only when the provider declares it safe. After restart,
   reconcile OUTCOME_UNKNOWN work instead of blindly resubmitting unknown
   external operations.
5. If cancellation is unconfirmed, preserve the cancellation outcome and
   verify provider truth before retrying or erasing data. A requested cancel is
   not a confirmed cancel.
6. If streams degrade, verify the token, tenant/principal, lease, expected
   sequence, and buffer bound. Reconnect with a valid lease or close/reopen;
   never bypass sequence or backpressure checks.
7. If consent/privacy fails, stop the affected provider path, restore or
   revoke consent according to policy, rerun maintenance, and verify both
   metadata and object removal. Missing semantic-redaction capability is a
   fail-closed condition when redaction is required.
8. If lifecycle publication fails, keep Media's local/durable state as the
   source for recovery, restore Event Plane connectivity, and reconcile the
   unconfirmed event. Local publication has no durable queue; production-like
   operation must use the configured durable queue-and-retry adapter and must
   not expose a lifecycle event until the queue write is durable.
9. Restart only when needed. Send SIGTERM and wait for clean shutdown;
   remember that local in-memory job/stream state does not survive restart.
10. Verify recovery with the focused tests in TESTING.md and repeat the health
    checks before returning traffic.

## Durable lifecycle outbox replay and dead-letter handling

The durable lifecycle outbox is the only supported way to publish Media
lifecycle events in staging, production, and sovereign profiles. It provides
at-least-once delivery with safe replay; it is not exactly-once. Consumers must
be idempotent on the stable event ID and must treat redelivery after a
broker-acknowledged send as normal operation.

- State and outbox rows are written in the same transaction as the Media state
  transition. A crash after commit but before broker send, or after broker ACK
  but before the publication row is acknowledged, causes redelivery on the next
  claim. No manual re-emission is required and none should be fabricated.
- Publication claims are leased and fenced. Only one publisher/writer may be
  active; never run a second runtime instance against the same outbox.
- Failed publications retry with bounded backoff until the retry budget is
  exhausted, after which the event is dead-lettered rather than dropped or
  retried forever. A growing dead-letter set is an alert condition.
- To replay, restore Event Plane connectivity and let the publisher reclaim
  pending and dead-lettered rows in order. Replaying a dead-lettered event is
  safe for idempotent consumers; investigate the poison payload before replay
  so the same failure does not immediately re-dead-letter it.
- Do not edit, delete, or synthesize outbox rows by hand to force delivery.
  If Media local/durable state and Event Plane diverge, reconcile from the
  durable Media state as the source of truth and record the discrepancy.

## Source-valid operational contract

The Level-A contract is resolved against the canonical Media Prometheus rules
and the registered package command:

- SLO: `slo:media-availability`
- SLO: `slo:media-latency`
- Alert rule: `alert:MediaServiceDown`
- Alert rule: `alert:MediaSLOAvailabilityBreach`
- Runbook command: `command:check:focused:media`
