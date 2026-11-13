# Logical surface: `media.surface.service-grpc`

Service-to-service gRPC channel. Physical owners: `libs/common` (shared
gRPC transport/security) and the four modality services (STT, TTS,
Vision, Multimodal). Contract source: per-service `*.proto` files
(45 observed RPCs; 43 named PDP-1 plus two unbound Vision source extras).

## Supported operations

45 source-declared RPCs across `stt_service.proto`, TTS proto,
`vision_service.proto` (12 methods) and the multimodal proto — model
state, transcribe/synthesize, streaming, correction, profile, image/
video inference, tracking, readiness, fused analysis.

## States and invariants

- Channel auth/TLS/deadline/streaming behavior follows the shared
  `GrpcTransportSecurityPolicy` per service prefix; missing
  production-like TLS rejects startup.
- **No unimplemented success response**: every RPC has an explicit
  disposition — `EXPLICITLY_NOT_ADMITTED`, `NOT_IMPLEMENTED`,
  `UNIMPLEMENTED`, `PROVIDER_DEPENDENT` or implemented — verified per
  service README inventories (e.g. TTS-01 11-method matrix, Vision
  10-method proto).
- Generated clients consume the published descriptors;
  `MediaGrpcRegistryDescriptorParityTest` keeps registry parity.

## Dependencies

`modules/infrastructure/security` (`MediaProcessingSecurityValidator`; bearer-token interception is platform-owned),
`libs/common` transport policy, per-service proto contracts.

## Errors

Typed gRPC statuses (`UNIMPLEMENTED`, `FAILED_PRECONDITION`,
`UNAUTHENTICATED`); provider diagnostics are not exposed on the wire.

## Tests

Per-service Gradle test tasks; `modules/integration-tests` RPC matrix
and authenticated suites; descriptor parity tests.
