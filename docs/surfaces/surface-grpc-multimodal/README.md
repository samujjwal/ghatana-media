# Logical surface: `media.surface.grpc.multimodal`

Multimodal analysis gRPC channel. Physical owner:
`modules/intelligence/multimodal-service`.

## Supported operations

Cross-modal composition RPCs per the service proto; `CrossModalFusionEngine`
fuses audio/visual embeddings into a unified representation with child
source/clock identities.

## States and invariants

- Exact MM RPC semantics require durable fused/partial/unknown outcomes
  with child source/clock identities — current family processing is
  `MULTIMODAL_FAMILY_NOT_ADMITTED` (`FAILED_PRECONDITION`) until
  canonical per-operation bindings exist.
- Source authorization is unavailable in the current composition;
  runtime-port injection is a seam, not authorization. Readiness probes
  return false without qualified provider readiness.
- No duplicate STT/Vision engines, generic model routing, OCR or Data
  Cloud storage ownership.
- The SDK `POST /api/v1/media/multimodal-analyses` route is a pinned
  stale disposition pending owner review.

## Dependencies

`MULTIMODAL_GRPC_PORT` + `GrpcTransportSecurityPolicy` (`MULTIMODAL`
prefix, TLS required); STT/Vision services as admitted children;
`adapters/agent-tools-media` wrappers at the Tools SPI boundary.

## Errors

`MULTIMODAL_FAMILY_NOT_ADMITTED` typed rejection; startup fails on
missing transport security.

## Tests

`./gradlew :services:media:modules:intelligence:multimodal-service:test`;
RPC matrix guards and fail-closed admission coverage.
