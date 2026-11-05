# Surface: `modules-vision-vision-service`

Media-owned Vision gRPC service (`modules/vision/vision-service`,
`:services:media:modules:vision:vision-service`). Supplies the Vision
gRPC boundary, bounded image/video preparation, source-raster geometry
and conditional detector integration. Consumers: Media runtime adapters,
Multimodal and authorized gRPC clients.

## Responsibility

- `src/main/proto/vision_service.proto` owns the 10 wire methods and
  field numbers; generated Java is build output.
  `WAVE2-RPC-CAPABILITY-MATRIX.md` indexes method/capability
  relationships.
- `VisionGrpcService` validates/authenticates requests;
  `ProductionVisionGrpcService` validates `VisionModelProfile`, requires
  trusted admission, and only then initializes `YoloV8Adapter`.
  `VisionProviderAdmission.requireAdmitted` currently **rejects**
  production initialization because a trusted license/provider admission
  source is absent — file metadata and a matching digest do not make the
  detector available.
- `BoundedImageDecoder`, EXIF/source-raster transforms and
  `VideoFrameExtractor` provide Media-specific input preparation.
- `YoloXNanoAdapter` is a separate experimental adapter (416×416
  preprocessing, `[1,3549,85]` decoder) that does not reuse the YOLOv8
  parser; its catalog digest identifies official release bytes only —
  provider admission, ONNX export lineage, COCO rights and quality
  remain unverified.
- Generic OCR belongs to Document Intelligence — no Media-owned OCR
  engine exists here.

## Public operations

10 gRPC methods per `vision_service.proto` (image/video inference,
tracking, readiness); authenticated host broker path supports a
source-only FFmpeg probe over one 0440 sentinel file (`file` protocol
whitelist, null muxer to stdout); requests with writable output remain
rejected until a bounded output-transfer protocol exists. Frame
extraction and audio demux through the broker remain unavailable.

## States and invariants

- Detector execution is `PROVIDER_NOT_ADMITTED` until trusted admission
  is integrated; no generated detections are expected on that path.
- The OCI broker enforces digest-pinned image allowlist, worker
  UID/GID isolation, read-only rootfs/no-network/dropped-caps worker,
  staged SHA-256 verification (closing hash-to-mount race), durable
  HMAC-protected nonce replay journal (65,536 live cap; backward
  wall-clock jump fails closed), retained-snapshot blocks on unknown
  cleanup, and `SO_PEERCRED` peer verification — identity checks do not
  trust the overridable `user.name` property.
- Disconnect/cleanup/response ambiguity after request transmission is
  `UNKNOWN` until reconciliation; the protocol has no cancellation
  operation.
- Configured-but-unqualified profiles never produce output; readiness
  probes report false without qualified provider readiness.

## Dependencies and configuration

- `VISION_GRPC_PORT` (default 50054); shared Media gRPC transport
  security policy; `VISION_MODEL_*` preflight (path/name/version/
  SHA-256/license/classes/device — CPU only, ≤2 GiB regular ONNX file;
  preflight is not admission).
- Broker env: `GHATANA_MEDIA_VISION_OCI_BROKER_SOCKET`,
  `GHATANA_MEDIA_VISION_OCI_BROKER_TOKEN_FILE`,
  `GHATANA_MEDIA_VISION_OCI_BROKER_REQUIRED`,
  `GHATANA_MEDIA_VISION_WORKER_IMAGE`; daemon-side
  `MEDIA_OCI_BROKER_*` identity/group/stage/image bindings.
- `VISION_CONFIDENCE_THRESHOLD`/`VISION_NMS_THRESHOLD` default 0.5/0.4.
- Reuses Media runtime contracts and Shared identity/observability — no
  second job, policy or OCR engine.

## Errors

Admission failures are typed (`PROVIDER_NOT_ADMITTED`); writable-output
requests rejected; ambiguous cleanup → `UNKNOWN`; broker integrity
failure fails closed.

## Tests and commands

```bash
./gradlew -Pghatana.media.compositeScope=FOCUSED \
  -Pghatana.media.focusedModules=vision \
  :services:media:modules:vision:vision-service:test \
  --tests '*VisionGrpcServiceInProcessIntegrationTest'
```

`bash scripts/qualification/run-wave2-vision-oci-checks.sh broker` is
external-broker-only (never builds an image or starts a daemon);
requires preprovisioned `GHATANA_MEDIA_VISION_OCI_BROKER_TEST_*`
prerequisites — it exercises source validation/staging and writable-
output rejection, not media decoding qualification. Real mAP/quality/
resource measurements need exact qualified model/input/environment.
