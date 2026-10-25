# Vision Wave 2 W0 disposition inventory

This inventory records the current service boundary, not provider qualification. Digest, class, and device checks are local model preflight only. No trusted license/provider admission source is wired, so production model initialization and traffic remain NOT_ADMITTED even when an operator supplies a license identifier and matching model digest. The narrow YOLO detector behavior is conditional on that separate trusted admission.

## 10 gRPC RPCs

| RPC | Current disposition | Boundary |
|---|---|---|
| DetectObjects | Production NOT_ADMITTED; conditional only after trusted provider admission and initialized detector | Narrow YOLO object boxes/classes only |
| AnalyzeImage | UNIMPLEMENTED after authentication/input validation | No scene understanding implementation admitted; detector is never called |
| ClassifyImage | UNIMPLEMENTED after authentication/input validation | Detection confidence is not image classification; detector is never called |
| AnalyzeVideoFile | Production NOT_ADMITTED; conditional only after trusted provider admission and initialized detector | Per-frame detections; no temporal scene claims |
| ProcessVideo | Production NOT_ADMITTED; conditional only after trusted provider admission and initialized detector | Streaming detections; no tracking claims |
| LoadModel | UNIMPLEMENTED after model ID validation | No registry mutation; dynamic model loading is not supported |
| UnloadModel | UNIMPLEMENTED after model ID validation | No registry mutation; dynamic model unloading is not supported |
| ListModels | Active models only after admission | Lists only actually loaded model metadata; supported task is detection only |
| GetStatus | Readiness only | Ready requires trusted admission and a live initialized detector |
| HealthCheck | Readiness only | Healthy requires trusted admission and a live initialized detector |

## 22 PDP capability intents

| Capability | Disposition |
|---|---|
| media.vision.scene-text.region.track | NOT_ADMITTED |
| media.vision.scene-text.observation.create | NOT_ADMITTED |
| media.vision.detect | NOT_ADMITTED in production pending trusted provider admission; local implementation is narrow object detection only |
| media.vision.classify | NOT_ADMITTED |
| media.vision.segment.image | NOT_ADMITTED |
| media.vision.segment.video | NOT_ADMITTED |
| media.vision.track.object | NOT_ADMITTED |
| media.vision.track.point | NOT_ADMITTED |
| media.vision.estimate.optical-flow | NOT_ADMITTED |
| media.vision.estimate.depth | NOT_ADMITTED |
| media.vision.estimate.surface-normals | NOT_ADMITTED |
| media.vision.estimate.human-pose | NOT_ADMITTED |
| media.vision.estimate.hand-pose | NOT_ADMITTED |
| media.vision.estimate.face-landmarks | NOT_ADMITTED |
| media.vision.analyze.expression | NOT_ADMITTED |
| media.vision.analyze.gaze | NOT_ADMITTED |
| media.vision.matte.foreground-background | NOT_ADMITTED |
| media.vision.segment.motion | NOT_ADMITTED |
| media.vision.estimate.saliency | NOT_ADMITTED |
| media.vision.classify.scene | NOT_ADMITTED |
| media.vision.detect.shot-boundary | NOT_ADMITTED |
| media.vision.estimate.camera-motion | NOT_ADMITTED |
