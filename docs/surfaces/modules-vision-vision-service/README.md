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
- The TypeScript DI scene-text consumer rejects pages above the existing v1
  block/line limits or 5,000-observation Media ceiling before materializing
  observations. Installed DI client identity, durable status, trusted video
  frame/PTS binding, and provider rights remain unresolved.

## Public operations

11 gRPC methods per `vision_service.proto` (image/video inference,
tracking, readiness, plus the proposal-only OCR descriptor route).
Authenticated host broker requests support source-only FFmpeg probes and
policy-allowlisted source-backed frame/audio operations with optional
bounded output transfer. These are broker capabilities; trusted source
binding and detector admission remain separate requirements.

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
prerequisites — it exercises authenticated source staging and bounded
output transfer, not production-host qualification. Real mAP/quality/
resource measurements need exact qualified model/input/environment.

## Local OCI qualification evidence (2026-11-07)

- `bash scripts/qualification/run-wave2-vision-oci-checks.sh stub`: 9/9
  Docker integration tests passed on Docker Desktop 29.1.3 ARM64. The
  fixture image was `sha256:43358b4ba4988fd27c9d176eb4ad21ce5d1d25bab562d03ed009716069879786`.
- The pinned FFmpeg 8.1.2 ARM64 real-codec image
  (`sha256:6d3d8a5cd41ebd8d6c2e44a696a9a26b0a6ac43716dbe0bd3434eeec7cb908d7`)
  passed `HostOciVisionRealCodecIntegrationTest` 3/3 for generated-BMP
  decode, malformed-input rejection, and output-budget overflow.
- This evidence covers local Docker Desktop fixtures and LGPL codec
  execution only. It does not qualify a Linux-native production host,
  external broker, detector license/quality, bbox/mAP, tracking, or trusted
  source-frame/version/PTS resolution. Vision remains `PROVIDER_NOT_ADMITTED`
  and the implementation task remains OPEN.
