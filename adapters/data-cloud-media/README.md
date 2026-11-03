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

The external Data Cloud contract owner must publish the versioned public
projection API/client and consumer receipt/readback contract (Ghatana #254).
Until then, retain the source-composite dependency for local compilation, keep
all operations unavailable, and do not claim latency or live publication
qualification. Do not copy Data Cloud internals, add a second aggregate spec,
or transfer Media lifecycle ownership.
