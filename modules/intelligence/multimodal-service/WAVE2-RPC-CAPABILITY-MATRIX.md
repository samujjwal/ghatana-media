# Multimodal Wave 2 RPC and capability matrix

This is an implementation coverage projection for MM-01, not a new capability
definition or an admission record. Product meaning remains in the PDP sources
listed below; protobuf messages remain the wire authority. The seven direct
capabilities and delegated capability memberships are taken from the Wave 2
execution plan's registered-surface projection.

## RPC inventory

`multimodal_service.proto` declares 10 RPCs. A `partial` disposition means a
caller may receive an audio-only or visual-only result. Current proto responses
do not carry a typed modality-finality, provenance, or uncertainty field, so
the service must not imply those facts from a successful transport response.

| RPC | Input → output | Capability relationship | Current semantic disposition |
| --- | --- | --- | --- |
| `ProcessMultimodal` | audio/image/video/text → combined analysis, optional audio and visual results | `media.multimodal.observe.source-grounded`; uses delegated STT and Vision | Optional modality results are partial. The wire response has no source/version provenance or typed uncertainty. |
| `AnalyzeVideoWithAudio` | video plus extraction/frame flags → transcript, frame observations, narrative | `media.multimodal.relate.scene-audio`; uses delegated STT and Vision | Timestamp association is available; synchronization measurement is `SYNC_UNDETERMINED` until qualified signal features and an algorithm are supplied. |
| `GenerateDescription` | audio/image/context/style → description, confidence, key elements | `media.multimodal.describe`; uses delegated STT and Vision | Source-grounded description and calibrated confidence are not established by this RPC's current heuristic implementation. |
| `AnalyzeCrossModal` | audio/video/window → score, events, summary | `media.multimodal.analyze.cross-modal`; uses delegated STT and Vision | Current keyword overlap heuristic is not a measured synchronization or calibrated alignment score; disposition remains provisional pending MM-06. |
| `GetInsights` | audio/video/image/text/types → sentiment, topics, entities, actions, confidence map | `media.multimodal.summarize`, `media.multimodal.extract.structured`; uses delegated STT and Vision | Current rules are heuristic; fixed confidence values do not establish model quality or source-grounded evidence. |
| `LoadModel` | model id → success/message/id/load time | Runtime management only; no standalone PDP capability | Must remain unavailable unless a provider/model is admitted and actually loaded. |
| `UnloadModel` | model id → success/message/memory freed | Runtime management only; no standalone PDP capability | A response is valid only for a real registry-managed model lifecycle. |
| `ListModels` | loaded-only flag → model metadata/counts | Runtime management only; no standalone PDP capability | Lists registry observations; it does not establish model qualification. |
| `GetStatus` | empty request → service counters/average processing time | Runtime status projection; no new capability | Operational status only, not readiness or provider qualification. |
| `HealthCheck` | empty request → healthy/message | Runtime health projection; no new capability | Must reflect required provider checks; an empty check set cannot mean serving. |

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
