# Logical surface: `media.surface.grpc.vision`

Vision gRPC channel. Physical owner: `modules/vision/vision-service`.
Contract: `src/main/proto/vision_service.proto` (10 methods).

## Supported operations

Image/video inference, tracking and readiness RPCs; bounded image/video
preparation (`BoundedImageDecoder`, EXIF transforms,
`VideoFrameExtractor`); conditional detector integration via
`YoloV8Adapter`/`YoloXNanoAdapter` behind `VisionProviderAdmission`.

## States and invariants

- Backward OCR RPC compatibility is preserved only as a Document
  Intelligence delegate or typed unsupported response — Media does not
  operate a competing OCR engine.
- Production detector initialization is rejected
  (`PROVIDER_NOT_ADMITTED`) until a trusted license/provider admission
  source exists; file metadata + digest match is not admission.
- Broker-mediated codec execution is source-only (writable outputs
  rejected pending bounded output-transfer protocol); ambiguous
  disconnect/cleanup is `UNKNOWN` until reconciliation.

## Dependencies

`VISION_MODEL_*` preflight profile; OCI broker env contract; shared
gRPC security policy; Media runtime contracts.

## Errors

Typed admission/preflight rejections; broker integrity failures fail
closed; no generated detections on unadmitted paths.

## Tests

`./gradlew :services:media:modules:vision:vision-service:test` (focused
selector in physical doc); external-broker qualification script
`run-wave2-vision-oci-checks.sh broker`.
