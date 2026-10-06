# Media architecture

## Scope and ownership

Media is the runtime service for governed audio, video, speech, vision, and
multimodal processing and delivery. It owns:

- artifact identity, bounded/resumable uploads, checksum finalization,
  encryption, retention, erasure, and same-tenant/principal-compatible
  deduplication;
- asynchronous processing jobs for transcoding, STT, TTS, vision, and
  multimodal capabilities;
- provider selection, readiness, fallback eligibility, leases, fencing,
  timeouts, cancellation truth, and restart reconciliation;
- tenant-scoped streams with token identity, reconnect leases, ordered frame
  acknowledgements, bounded buffers, and explicit terminal state;
- consent, privacy, residency, classification, biometric permission, provider
  retention, and semantic-redaction decisions.

Media does not own Data Cloud governance/read models, AI Inference's generic
model/provider boundary, Event Plane durable event semantics, Action Plane
privileged effects, or Agents execution. It must not mutate another service's
database or become a general effect authority. Generic model work delegated by
a selected Media provider crosses the AI Inference contract.

The standalone HTTP composition root is launcher and its main class is
`com.ghatana.media.launcher.MediaLauncher`. The current wire/availability
projection is split deliberately across [OpenAPI](../contracts/openapi/media.yaml),
the [route manifest](../config/route-manifest.json), protobuf service contracts,
and the provider manifest. A generated aggregate `service-contract.yaml` is not
an active authority. CLEAN-2 selects these source-specific authorities; GAP-06
remains open for unresolved ownership, consumer parity, and native qualification.
This document is limited to the current local/runtime architecture and does not
claim a production-ready deployment.

## Concepts and contracts

- Artifact — durable metadata plus encrypted object bytes. An upload session
  accepts sequential bounded chunks, records per-chunk size/hash, verifies the
  complete size/hash, and finalizes one artifact. Deduplication is scoped by
  tenant, compatible principal ownership, content hash, and size.
- Processing job — an accepted, running, or terminal operation over an
  artifact. Durable stores enforce tenant/request idempotency; worker leases,
  optimistic versions, and fencing prevent concurrent ownership. Cancellation
  distinguishes provider-confirmed cancellation from
  requested-but-unconfirmed and unsupported outcomes.
- Stream session — a tenant-scoped session protected by a token hash and a
  reconnectable lease. Frames must be ordered, acknowledged with the same
  sequence, and kept within a bounded buffer. Closing is an explicit draining
  then terminal transition.
- Consent and privacy — consent is checked for purpose, residency, external
  processing, provider retention, and biometric use before a provider
  operation. Redaction must be semantic and fail closed when requested but no
  eligible redaction provider is available. Retention and erasure act on
  durable state and bytes.
- Provider — processing and streaming SPIs expose modality capability,
  identity, health, degradation, bounds, timeout, cancellation, and privacy
  requirements. External providers require an active consent authority and
  compatible governance.

The public HTTP contract is
[../contracts/openapi/media.yaml](../contracts/openapi/media.yaml). The
runtime contract types are in
runtime-contracts/src/main/java/com/ghatana/media/runtime.

## Module topology

| Module or path | Responsibility | Runtime role |
| --- | --- | --- |
| :services:media | Aggregate/build support | Not the HTTP composition root |
| :services:media:launcher | MediaLauncher, MediaRuntime, HTTP routes/security, lifecycle, local composition, privacy maintenance, consent administration | Executable runtime |
| :services:media:runtime-contracts | Artifact, job, stream, provider, consent, privacy, and modality contracts | Shared domain boundary |
| :services:media:providers:aws-postgresql | S3 artifact storage, PostgreSQL metadata/job/stream/consent state, HTTP processing/stream providers, privacy maintenance | Durable/external ServiceLoader implementations |
| :services:media:modules:audio-streaming and :services:media:modules:video-streaming | Stream capability implementations and transport/domain support | Provider/feature implementations |
| :services:media:modules:speech:stt-service and :services:media:modules:speech:tts-service | Speech recognition and synthesis capability modules | Provider/feature implementations |
| :services:media:modules:vision:vision-service and :services:media:modules:intelligence:multimodal-service | Vision and multimodal capability modules | Provider/feature implementations |
| :services:media:modules:infrastructure:* | Cache, messaging, persistence, and security support | Runtime infrastructure adapters |
| :services:media:modules:integration-tests and :services:media:integration-tests | API and end-to-end integration suites | Separate test surfaces, generally Docker/Testcontainers-backed |

ServiceLoader registrations in the durable provider module supply the
S3/PostgreSQL stores, consent authority, HTTP processing/stream providers, and
privacy maintenance. Local composition can add file/in-memory stores and
diagnostic providers.

## Runtime flows

### Artifact flow

1. An authenticated tenant/principal starts an upload with classification,
   retention, size, and digest constraints.
2. Media accepts sequential chunks only when each is within the configured
   chunk/body bounds, records the chunk digest, and keeps incomplete state.
3. Completion claims finalization, re-reads/verifies chunk and full-object
   size/hash, writes encrypted object bytes and durable metadata, applies
   deduplication rules, and removes temporary chunks. A stale finalization
   claim can be recovered after its timeout.
4. Any mismatch or storage failure leaves an explicit error rather than an
   apparently complete artifact.

### Job flow

1. Submission verifies the artifact, principal, modality/request, consent, and
   provider governance. An idempotent durable job record is accepted.
2. The runtime acquires a worker lease, transitions the job to RUNNING, and
   limits active work with the configured concurrency semaphore.
3. The provider runs under the job timeout. Fallback is attempted only when
   the provider contract marks the failure safe and another eligible provider
   exists. Semantic redaction is applied when required and available.
4. The result and provider identity are persisted as a terminal outcome. A
   confirmed cancellation becomes terminal; an unconfirmed or unsupported
   cancellation remains an explicit request state.
5. On launcher startup, recoverable non-terminal jobs are reconciled. The
   current runtime marks work whose provider outcome is unknown as failed with
   RESTART_RECONCILIATION_REQUIRED; it does not silently replay it.

The current launcher starts accepted jobs through an asynchronous in-process
future. A durable job store and lease protect state when selected, but the
launcher is not itself a durable queue/worker deployment; local jobs therefore
do not survive process restart.

### Stream flow

1. Opening a stream selects a provider and validates consent, then persists a
   token hash and OPEN session.
2. Connecting verifies the token, consent, and a short reconnect lease.
3. Each frame checks token, connection, degradation, lease, sequence, and
   bounded buffer state before calling the provider. The returned
   acknowledgement must match the submitted sequence.
4. Closing transitions through DRAINING, closes provider work, cancels active
   operations, and persists CLOSED. Lease expiry or provider failure is an
   explicit degraded/terminal path, not an unbounded retry.

### Consent, privacy, and lifecycle events

Consent administration persists tenant/principal grants and expiry/revocation.
Privacy maintenance purges expired artifacts, jobs, and streams and performs
the configured erasure work. Media can publish lifecycle events to Event Plane.
The contract's production-like degradation policy is `queue-and-retry`, which
requires a durable publication queue/worker before lifecycle exposure. The
current local `MediaLifecyclePublisher` is intentionally a bounded synchronous
HTTP publisher: it uses the lifecycle event ID as the idempotency key and
reports failure as unconfirmed; local composition does not provide restart-safe
publication retry.

## Dependencies and boundaries

| Dependency | Contract relationship | Current behavior |
| --- | --- | --- |
| Data Cloud | Optional, best-effort governed metadata integration when activated | Not required for local artifact/job/stream composition |
| AI Inference | Optional boundary for generic model delegation; fail-closed when a selected Media provider needs it | Local diagnostic providers do not require remote AI Inference |
| Event Plane | Optional lifecycle/progress/outcome publication | Production-like profiles require a durable queue-and-retry adapter; local uses bounded synchronous HTTP and explicit unconfirmed failure |
| PostgreSQL + S3 | Durable artifact, job, stream, consent, and privacy state | Activated by the s3-postgresql store IDs in durable profiles |
| External media providers | Processing/streaming capabilities | Require endpoint, token, region, retention, and compatible consent/governance |

Media owns its stores and provider contracts. It does not use Data Cloud or
another service as an implicit source of truth for artifact bytes, job leases,
stream sequence, consent, or erasure.

## Persistence and data handling

The durable AWS/PostgreSQL implementation stores metadata and lifecycle state
in PostgreSQL and encrypted object/chunk bytes in S3. Migrations cover upload
sessions/chunks/artifacts/jobs/streams, finalization claims, consent grants,
principal ownership/deduplication, job worker leases, and cancellation truth.
PostgreSQL job and stream updates use optimistic versions; job leases and
stream token hashes prevent stale or unauthorized updates.

Upload completion verifies chunks and the complete digest before finalizing,
then deletes temporary chunks. Retention and erasure operate on physical
artifact data and metadata, not only a read-model flag.

Local/test support uses a file artifact store plus in-memory job and stream
stores. It is explicitly non-durable and non-production-eligible: local files
are useful for the process lifetime, but in-memory indexes and leases do not
survive a restart.

## Lifecycle

- Disabled: MEDIA_RUNTIME_ENABLED=false by default; the launcher exits without
  binding HTTP.
- Composing: MediaRuntime.compose loads unique stores, consent authorities,
  providers, redaction, privacy maintenance, and lifecycle publisher
  implementations, then verifies readiness.
- Started/ready: the launcher binds HTTP only after at least one processing
  and streaming provider and all selected stores are ready. External providers
  require a ready consent authority; production-like profiles additionally
  require durable store IDs and production-eligible providers.
- Running: requests use the artifact/job/stream state machines, bounded jobs,
  leases, consent checks, provider timeouts, and explicit outcomes.
- Stopping/closed: the shutdown hook closes consent administration, privacy
  maintenance, and runtime resources. Active work is cancelled or left with an
  explicit persisted outcome according to provider truth.

## Degradation and recovery

| Condition | Runtime behavior | Recovery action |
| --- | --- | --- |
| Store/provider not ready | Readiness is 503; runtime composition fails or refuses work | Restore PostgreSQL/S3/provider configuration and recheck readiness |
| Upload size/hash/finalization failure | No complete artifact is exposed; incomplete state remains recoverable | Inspect upload session/chunk hashes, clear only verified temporary state, and retry completion |
| Duplicate upload/job request | Durable uniqueness and ownership checks return the existing/compatible state or a conflict | Reuse the returned ID or correct tenant/principal/request identity |
| Job provider timeout/failure | Provider-safe fallback may run; otherwise an explicit failed/degraded terminal result is persisted | Inspect provider outcome before retry; use lease/reconciliation rather than blind duplicate submission |
| Restart with running jobs | Unknown provider outcomes are marked RESTART_RECONCILIATION_REQUIRED | Reconcile with the provider and submit a new request only after an operator/domain decision |
| Cancellation not confirmed | Persist REQUESTED_UNCONFIRMED or UNSUPPORTED; do not call it cancelled | Check provider control plane and retention/privacy state before retrying |
| Consent revoked/expired | New work and frames fail closed; active work is stopped where supported | Restore valid consent or terminate and erase according to policy |
| Stream sequence/lease/buffer violation | Frame is rejected or stream becomes degraded/terminal; no unbounded buffering | Reconnect with a valid token/lease and next expected sequence, or close and reopen |
| Lifecycle publication failure | Work remains local; event is logged unconfirmed | Restore Event Plane and reconcile from Media's durable lifecycle state |
| Privacy purge failure | Retention/erasure work remains visible as incomplete/error | Fix store access, rerun maintenance, and verify physical object plus metadata removal |

Recovery must preserve tenant, principal, request, lease, token, and provider
identity. Do not bypass consent, privacy, checksum, or fencing controls to
restore throughput.

## Local closure boundary

The local profile is a bounded diagnostic composition for HTTP, state-machine,
consent, provider, and lifecycle checks. It does not provide durable restart
recovery, real external processing, durable Event Plane queueing, or
production-eligible privacy/storage guarantees. Use the focused tests in
TESTING.md and the local runbook in OPERATIONS.md to validate what is actually
available on a developer host.
