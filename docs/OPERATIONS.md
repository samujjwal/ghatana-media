# Media operations

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

## Degradation, recovery, and actionable runbook

1. Check lifecycle. Run liveness, startup, readiness, health, and metrics.
   Record profile, store IDs, provider IDs, active counts, and degradation
   state without copying media bytes or tokens.
2. If not ready, verify selected artifact/job/stream stores, PostgreSQL/S3
   credentials and endpoints, provider endpoint/token/region/retention, and
   consent authority readiness. Restore dependencies before reopening traffic.
3. If uploads fail, inspect the upload ID and recorded chunk indexes/hashes;
   verify sequential ordering and configured size limits. Do not mark an
   artifact complete manually without a full digest check.
4. If jobs fail or time out, inspect job lease and provider outcome. Use a
   provider fallback only when the provider declares it safe. After restart,
   reconcile RESTART_RECONCILIATION_REQUIRED work instead of blindly
   resubmitting unknown external operations.
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

## Source-valid operational contract

The Level-A contract is resolved against the canonical Media Prometheus rules
and the registered package command:

- SLO: `slo:media-availability`
- SLO: `slo:media-latency`
- Alert rule: `alert:MediaServiceDown`
- Alert rule: `alert:MediaSLOAvailabilityBreach`
- Runbook command: `command:check:focused:media`
