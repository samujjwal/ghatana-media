# Multimodal Wave 2 RPC and capability matrix

This is an implementation coverage projection for MM-01, not a new capability
definition or an admission record. Product meaning remains in the PDP sources
listed below; protobuf messages remain the wire authority. The seven direct
capabilities and delegated capability memberships are taken from the Wave 2
execution plan's registered-surface projection.

## RPC inventory

`multimodal_service.proto` declares 10 RPCs. The response shapes retain legacy
combined-result fields, but the production service does not currently emit a
family-level combined or partial result. Production source authorization is
unavailable, and there is no admitted canonical per-operation executor. The
guards below describe current runtime behavior; prior heuristic response
descriptions are historical implementation notes, not current outcomes.

| RPC | Input → output | Capability relationship | Current implementation outcome |
| --- | --- | --- | --- |
| `ProcessMultimodal` | audio/image/video/text → legacy combined analysis shape | `media.multimodal.observe.source-grounded`; delegates to STT and Vision | After identity, input, and canonical-binding validation, default production source authorization returns `UNAVAILABLE`. With test-injected admitted authorization, the absent executor returns `FAILED_PRECONDITION/MULTIMODAL_FAMILY_NOT_ADMITTED`. No family response is emitted. |
| `AnalyzeVideoWithAudio` | video plus extraction/frame flags → legacy transcript/frame/narrative shape | `media.multimodal.relate.scene-audio`; delegates to STT and Vision | Same identity/input/binding checks and default source-authority/executor gates. No timestamp association or synchronization result is emitted by the production path. |
| `GenerateDescription` | audio/image/context/style → legacy description shape | `media.multimodal.describe`; delegates to STT and Vision | Same identity/input/binding checks and default source-authority/executor gates. No description or confidence is emitted. |
| `AnalyzeCrossModal` | audio/video/window → legacy score/events/summary shape | `media.multimodal.analyze.cross-modal`; delegates to STT and Vision | Same identity/input/binding checks and default source-authority/executor gates. No alignment score or combined result is emitted. |
| `GetInsights` | audio/video/image/text/types → legacy insights shape | `media.multimodal.summarize`, `media.multimodal.extract.structured`; delegates to STT and Vision | After identity and input validation, missing/invalid operation binding returns `FAILED_PRECONDITION/MULTIMODAL_FAMILY_NOT_ADMITTED`; otherwise production source authorization is unavailable, and an admitted test authority reaches `UNAVAILABLE` because no qualified source-grounded semantic provider exists. No heuristic insight is emitted. |
| `LoadModel` | model id → success/message/id/load time | Runtime management only; no standalone PDP capability | Blank model id returns `INVALID_ARGUMENT`; otherwise `UNAVAILABLE` because no qualified provider is available. |
| `UnloadModel` | model id → success/message/memory freed | Runtime management only; no standalone PDP capability | Blank model id returns `INVALID_ARGUMENT`; otherwise `UNAVAILABLE` because no admitted model lifecycle exists. |
| `ListModels` | loaded-only flag → model metadata/counts | Runtime management only; no standalone PDP capability | `UNAVAILABLE`; no qualified provider registry is available. |
| `GetStatus` | empty request → service counters/average processing time | Runtime status projection; no new capability | Returns `status=NOT_ADMITTED`; counters do not establish provider qualification. |
| `HealthCheck` | empty request → healthy/message | Runtime health projection; no new capability | Default production readiness is false and returns `MULTIMODAL_NOT_SERVING`; injected test readiness can exercise the positive transport branch only. |

## Direct Media capability intents

These seven intents are owned by the multimodal surface. The RPC mapping above
is a consumer mapping, not evidence that the capability is implemented or
qualified.

| PDP-0 capability intent | Wave 2 owner | RPC consumer |
| --- | --- | --- |
| `media.multimodal.analyze.cross-modal` | MM-06 | `AnalyzeCrossModal`, `ProcessMultimodal` |
| `media.multimodal.describe` | MM-07 | `GenerateDescription`, `ProcessMultimodal` |
| `media.multimodal.summarize` | MM-07 | `GetInsights`, `ProcessMultimodal` |
| `media.multimodal.extract.structured` | MM-07 | `GetInsights` |
| `media.multimodal.associate.speaker-face` | MM-06 | No dedicated RPC; no independent identity capability is implied |
| `media.multimodal.relate.scene-audio` | MM-04 | `AnalyzeVideoWithAudio`, `AnalyzeCrossModal` |
| `media.multimodal.observe.source-grounded` | MM-07 | `ProcessMultimodal`, `AnalyzeVideoWithAudio` |

## Delegated memberships

Multimodal delegates modality execution to STT and Vision through their
existing service boundaries; it does not own duplicate engines. The 43
multimodal surface memberships are 16 STT references, 20 Vision references,
and the 7 direct intents below. The selected MM surface references 20 of the
22 Vision intents on the Vision surface; scene-text region tracking and
scene-text observation remain outside this delegation set.

### STT — 16 delegated intents (MM-05)

- `media.speech.transcription.file`
- `media.speech.transcription.stream`
- `media.speech.transcription.language.detect`
- `media.speech.transcription.voice-activity.detect`
- `media.speech.transcription.speaker.diarize`
- `media.speech.transcription.speaker.segment`
- `media.speech.transcription.speaker.separate`
- `media.speech.transcription.speaker.identify-authorized`
- `media.speech.transcription.word-timestamp.create`
- `media.speech.transcription.phoneme-timestamp.create`
- `media.speech.transcription.forced-align`
- `media.speech.transcription.punctuate-capitalize`
- `media.speech.transcription.alternatives.provide`
- `media.speech.transcription.confidence.provide`
- `media.speech.transcription.translate`
- `media.speech.transcription.subtitle.generate`

### Vision — 20 delegated intents (MM-05)

- `media.vision.detect`
- `media.vision.classify`
- `media.vision.segment.image`
- `media.vision.segment.video`
- `media.vision.track.object`
- `media.vision.track.point`
- `media.vision.estimate.optical-flow`
- `media.vision.estimate.depth`
- `media.vision.estimate.surface-normals`
- `media.vision.estimate.human-pose`
- `media.vision.estimate.hand-pose`
- `media.vision.estimate.face-landmarks`
- `media.vision.analyze.expression`
- `media.vision.analyze.gaze`
- `media.vision.matte.foreground-background`
- `media.vision.segment.motion`
- `media.vision.estimate.saliency`
- `media.vision.classify.scene`
- `media.vision.detect.shot-boundary`
- `media.vision.estimate.camera-motion`

## Source authority

- PDP-0 capability definitions: `.product-experience/pdp-0-product-truth/capabilities.yaml`.
- Wire methods and fields: `src/main/proto/multimodal_service.proto`.
- Registered-surface membership and task mapping: `docs/implementation/MEDIA-BACKEND-MODALITY-WAVE2-EXECUTION.md`.
- The PDP-3 gRPC service registry remains proposal-only; this matrix does not admit it.
