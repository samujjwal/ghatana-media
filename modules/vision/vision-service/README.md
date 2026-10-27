# Media Vision service

This Media-owned module supplies the Vision gRPC boundary, bounded image/video preparation, source-raster geometry and conditional detector integration. Its consumers are Media runtime adapters, Multimodal and authorized gRPC clients. Product intent remains in the repository PDP sources; this guide describes implementation, not provider qualification or task acceptance.

## Boundary and architecture

The entry point is `com.ghatana.audio.video.vision.grpc.VisionGrpcServer`, in Gradle project `:services:media:modules:vision:vision-service`. [vision_service.proto](src/main/proto/vision_service.proto) owns the 10 wire methods and field numbers; generated Java is build output. [WAVE2-RPC-CAPABILITY-MATRIX](WAVE2-RPC-CAPABILITY-MATRIX.md) indexes method/capability relationships. The [Wave 2 plan](../../../docs/implementation/MEDIA-BACKEND-MODALITY-WAVE2-EXECUTION.md) owns VIS-01–12 acceptance.

`VisionGrpcService` validates/authenticates requests. `ProductionVisionGrpcService` validates `VisionModelProfile`, requires trusted admission, and only then initializes `YoloV8Adapter`. `VisionProviderAdmission.requireAdmitted` currently rejects production initialization because a trusted license/provider admission source is absent. File metadata and a matching digest do not make the detector available.

`BoundedImageDecoder`, EXIF/source-raster transforms and `VideoFrameExtractor` provide Media-specific input preparation. Their tests do not qualify a detector, prove all scene/track/biometric capabilities, or establish a production process sandbox. Generic OCR belongs to Document Intelligence. Reuse Media runtime contracts and Shared identity/observability; do not add a second job, policy or OCR engine here.

## Configuration and extension

`VISION_GRPC_PORT` defaults to 50054. Transport security follows the shared Media gRPC policy. Model preflight reads `VISION_MODEL_PATH`, `VISION_MODEL_NAME`, `VISION_MODEL_VERSION`, `VISION_MODEL_SHA256`, `VISION_MODEL_LICENSE`, `VISION_MODEL_CLASSES` and `VISION_MODEL_DEVICE`; [VisionModelProfile](src/main/java/com/ghatana/audio/video/vision/model/VisionModelProfile.java) owns validation. Confidence/NMS thresholds come from `VISION_CONFIDENCE_THRESHOLD` and `VISION_NMS_THRESHOLD`, defaulting to 0.5/0.4 within `[0,1]`.

The profile accepts only CPU device metadata and bounds a regular local ONNX file to 2 GiB; this is preflight, not admission. The module does not automatically download weights. Extend existing detector/runtime interfaces, preserve wire compatibility and test positive, boundary and failure behavior. See [design](../../../docs/DESIGN.md) and [operations](../../../docs/OPERATIONS.md).

## Usage examples and testing

From the Media root, with Java 27/Shared prerequisites in [TESTING](../../../docs/TESTING.md):

```sh
./gradlew -Pghatana.media.compositeScope=FOCUSED \
  -Pghatana.media.focusedModules=vision \
  :services:media:modules:vision:vision-service:test \
  --tests '*VisionGrpcServiceInProcessIntegrationTest'
```

This suite supplies controlled dependencies; it is not a real model benchmark. Missing/invalid model metadata must reject production startup. Even valid local metadata reaches `PROVIDER_NOT_ADMITTED` until trusted admission is integrated; no generated detection is expected on that path.

Native work uses `mac-native` and `linux-arm64-native` with the source-pinned tools in [TESTING](../../../docs/TESTING.md). Required checks include malformed/oversized input, path/codec restrictions, timeout/kill/cleanup, source clocks/ROI and provider absence. Real mAP/quality/resource measurements need exact qualified model/input/environment. [EVIDENCE](../../../docs/EVIDENCE.md) defines artifacts and repeatability; no test pass is asserted here.

## Non-functional scope

Rights, source ownership, tenant isolation and biometric authorization apply before effects; diagnostics must not expose content or model paths. Native processing needs hard resource controls or rejection. GUI accessibility is N/A for this backend; locale, script and scene-text semantics remain applicable. AI/ML quality, weights/corpus provenance and dependency/codec licensing remain qualification obligations.
