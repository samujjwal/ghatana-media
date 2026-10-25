# Vision Wave 2 W0 disposition inventory

This inventory records the current service boundary, not provider qualification. The only intended executable model capability is digest-pinned YOLO object detection. Local model bytes, license rights, native runtime, and output quality still require independent evidence.

## 10 gRPC RPCs

| RPC | Current disposition | Boundary |
|---|---|---|
| DetectObjects | Conditional: detector must be initialized | Narrow YOLO object boxes/classes only |
| AnalyzeImage | UNIMPLEMENTED after authentication/input validation | No scene understanding implementation admitted; detector is never called |
| ClassifyImage | UNIMPLEMENTED after authentication/input validation | Detection confidence is not image classification; detector is never called |
| AnalyzeVideoFile | Conditional: frame extraction plus initialized detector | Per-frame detections; no temporal scene claims |
| ProcessVideo | Conditional: frame extraction plus initialized detector | Streaming detections; no tracking claims |
| LoadModel | UNIMPLEMENTED after model ID validation | No registry mutation; dynamic model loading is not supported |
| UnloadModel | UNIMPLEMENTED after model ID validation | No registry mutation; dynamic model unloading is not supported |
| ListModels | Active models only | Lists only loaded model metadata; supported task is detection only |
| GetStatus | Readiness only | Ready requires a live initialized detector |
| HealthCheck | Readiness only | Healthy requires a live initialized detector |

## 22 PDP capability intents

| Capability | Disposition |
|---|---|
| media.vision.scene-text.region.track | NOT_ADMITTED |
| media.vision.scene-text.observation.create | NOT_ADMITTED |
| media.vision.detect | Conditional narrow object detection |
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
