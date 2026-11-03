# Data Cloud media adapter boundary (DC-06)

Data Cloud is an optional downstream consumer of governed Media metadata. It
does not own Media artifacts, uploads, jobs, attempts, streams, consent,
processing results, or finality. A Data Cloud outage or an unavailable adapter
must not change canonical Media state.

## Current integration state

- `DataCloudSttAdapter`, `DataCloudVisionAdapter`, and
  `DataCloudMultimodalAdapter` are compatibility implementations of Data
  Cloud's `MediaProcessorPort`. All three currently report unavailable for
  every operation. Their legacy calls fail closed (or return `null` for
  unsupported operations); constructing an adapter does not admit provider
  work.
- `MediaObservationPublicationCoordinator` is a source-side integration seam.
  Its publication client, live source authority, and durable outbox are
  injected. The default outbox claim is unavailable. No installed Data Cloud
  public client or real destination receipt/readback is wired here, so local
  fixtures do not prove a platform effect.
- `MediaSemanticObservationProjector` validates and bounds a proposed
  semantic projection. Its references are not authenticated by projection,
  and it does not authorize disclosure or publication.
- The adapter surface has no Media job-state mutation API. Media retains job
  and processing finality; an ambiguous downstream publication remains
  unresolved at the publication boundary and is never promoted to job success
  or failure.

## DC-01 source, consumer, and parity inventory (2026-11-03)

PDP-0 is applicable to this adapter surface, but the current topology maps
**zero direct PDP-0 capability IDs** to it. The adapter is a Data Cloud
consumer boundary, not a newly identified product capability; do not assign a
capability ID to make the inventory appear complete.

| Contract/source owner | Direction and current Media consumer | Contract parity and disposition |
| --- | --- | --- |
| `com.ghatana.datacloud.memory.media.MediaProcessorPort` in Data Cloud `delivery/api` | Data Cloud-to-Media SPI. `DataCloudSttAdapter`, `DataCloudVisionAdapter`, and `DataCloudMultimodalAdapter` implement `transcribeAudio`, `analyzeVision`, `indexMultimodal`, availability, and capability-list methods. | The SPI accepts artifact ID, tenant ID, an operation selector, and string parameters. It does not carry an authenticated principal, immutable source version/timebase, purpose, or live rights/disclosure decision. Media adapters advertise no available operations and do not invoke the corresponding persistent service. This is compatibility shape parity only; tenant request scope is not authentication or processing admission. |
| `com.ghatana.datacloud.entity.media.Classification` and `com.ghatana.datacloud.semantic.OperationalSemanticContext` in Data Cloud `planes/shared-spi` | Data Cloud-owned types consumed locally by `MediaSemanticObservationProjector`. | Media constructs a typed `SemanticObject` with tenant, source/event/artifact/version/provider/redaction/consent references, classification, governance, trust, provenance, effective period, and known source-PTS facts. This is an in-process projection candidate, not a Data Cloud read/write call. Structural checks do not authenticate those references or authorize disclosure. |
| `com.ghatana.datacloud.memory.media.MediaObservationProjectionService` in Data Cloud `delivery/api`; `MediaObservationController` and `POST_MEDIA_OBSERVATIONS` / `GET_MEDIA_OBSERVATION` routes in `delivery/launcher` | Data Cloud-owned source API; **no Media consumer is wired**. Source defines `POST /api/v1/media/observations` and `GET /api/v1/media/observations/{operationId}`. | The POST accepts a `media.observation.v1` envelope bound to authenticated tenant/principal, source reference/version/digest, job/attempt, purpose/rights, payload reference/digest, issuer signature, and idempotency key; route policy requires auth, tenant, operator permission, policy, audit, and idempotency. POST returns `202` with a status URL; GET returns source-owned projection state, including `UNKNOWN` for unresolved/nonterminal outcomes. This API stores/readbacks the envelope's projection metadata, not the `SemanticObject` emitted by Media's projector. No adapter/client maps or invokes these routes. Source-code presence is not installed-client or live-effect parity. |

The available Data Cloud server wiring currently constructs this projection
service with an in-memory repository and a null issuer verifier. That makes
owner signature verification unavailable (POST returns unavailable); the
source route is not a qualified live Media destination. The Media publication
coordinator remains an injected seam: its publication client, live
source/disclosure authority, and durable outbox have no admitted Data Cloud
client wiring here. No Data Cloud read or write call is made by the current
Media adapter.

**Exact external inputs still needed:** Ghatana/Data Cloud owner issue #254
must provide the versioned, Java 21-compatible, installable public client and
consumer contract, including authenticated source-issuer verification and
source/readback authority bindings, durable destination repository and
readback/receipt semantics for accepted/pending/committed/unknown outcomes,
and a supported Java 27 Media consumer artifact. Media must then bind the
client through the existing publication coordinator and source-owned
idempotent outbox. Until those owner inputs are available, keep the optional
integration unavailable; do not infer a successful write or Data Cloud
finality from the local semantic projection or the API source.

Only bounded, redacted, source-grounded metadata may cross a future admitted
public client. Raw media bytes, credentials, and disallowed transcript or
biometric content must not be sent to Data Cloud.

## Build and dependency boundary

The adapter is a separate Gradle project, so Data Cloud is not a dependency of
Media's core modality projects. In the current `DEV_SOURCE_COMPOSITE` build,
this adapter compiles against the source projects
`:services:data-cloud:delivery:api` and `:services:data-cloud:planes:shared-spi`.
The delivery API currently brings a broad source-composite transitive graph;
this is not evidence of a source-free installed client or a stable published
consumer contract. The adapter also depends on Media STT, Vision, and
Multimodal service projects to preserve the existing SPI implementation
signatures.

The external Data Cloud contract owner must publish an installable versioned
consumer client and receipt/readback contract (Ghatana #254), and wire the
issuer verifier and durable repository behind the source API. Until then,
retain the source-composite dependency for local compilation, keep all Media
operations unavailable, and do not claim latency or live publication
qualification. Do not copy Data Cloud internals, add a second aggregate spec,
or transfer Media lifecycle ownership.
