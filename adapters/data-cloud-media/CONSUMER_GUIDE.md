# Data Cloud media consumer guide

This adapter is an optional compatibility boundary. Media remains the source
of truth for artifacts, uploads, jobs, streams, consent, processing results,
and finality. A Data Cloud read-model or publication failure does not change
Media state.

## Current SPI behavior

`DataCloudSttAdapter`, `DataCloudVisionAdapter`, and
`DataCloudMultimodalAdapter` implement Data Cloud's
`com.ghatana.datacloud.memory.media.MediaProcessorPort`. The SPI accepts an
artifact ID, tenant ID, operation selector, and string parameters. Those
arguments do not include an authenticated principal, immutable artifact
version, purpose, or live rights/disclosure readback.

Because those bindings are absent, every adapter currently reports
`isAvailable(...) == false`, advertises no supported operation values, and
fails closed for direct supported-operation calls. Legacy unsupported
operation methods retain their compatibility behavior. Neither a constructed
adapter nor a local service result is evidence of source authority, provider
admission, publication, or destination readback.

## Projection and publication seams

`MediaSemanticObservationProjector` validates tenant and artifact-version
consistency, classification, provenance references, and redaction metadata
before constructing a bounded semantic object. It does not authenticate those
references or authorize disclosure.

`MediaObservationPublicationCoordinator` accepts injected source-readback,
publication-client, and outbox seams. The default outbox claim returns
unavailable, and no installed Data Cloud client or real destination receipt is
wired by this module. The coordinator's in-memory tests verify local boundary
behavior only. Missing or ambiguous publication evidence is not success and
must not be converted into Media job finality.

## Build and external contract

In `DEV_SOURCE_COMPOSITE`, the adapter compiles against Data Cloud's
`:services:data-cloud:delivery:api` and `:services:data-cloud:planes:shared-spi`
projects and Media's STT, Vision, and Multimodal service projects. This source
graph supports local compilation; it is not a source-free installed consumer
or proof that the public API is versioned and compatible. Media core modality
projects do not depend on this adapter.

The Data Cloud contract owner (Ghatana #254) must supply the versioned public
projection client and receipt/readback contract. Until that owner contract and
installed consumer are available, keep the integration unavailable. Do not
send raw media bytes, credentials, or content excluded by source rights or
redaction policy.
