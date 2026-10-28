# Ghatana Media — consolidated candidate and architecture decisions

**Date:** 2026-10-28. **Scope:** all Media capability families, not only Wave 2. **Authority:** source-linked historical reconciliation. This document does not select new providers, change PDP-0, grant model/voice/recording rights, qualify a runtime or perform Lifecycle closure.

## 1. Controlling records and exhaustive inventory

The technology authority remains **.product-experience/pdp-0-product-truth/reuse-decisions.yaml**, under **selectionRegister**: **38** owner decisions (**21 SELECTED, 15 CONDITIONAL, one NOT_REQUIRED, one REJECTED**). They select preferred *architectural roles*, not model weight licenses, executable binaries, published dependency artifacts or real provider acceptance.

The [read-only candidate crosswalk](observations/media-candidate-decision-crosswalk-2026-10-28.json) preserves **157 source observations**: 38 PDP-0 technology decisions; 32 unified blueprint §3 candidates; 30 blueprint §13.2 research entries; five animation and five simulation options; 32 migration Appendix-B options; six exact R9 Wave 2 reference assets; and nine historical conversation-only candidates. Repeated technologies are deliberately counted in separate source tables, not 157 unique packages or admitted capabilities. Every recorded source table retains exact source path, row number, role, license observation and original disposition.

The [historical discussion supplement](observations/media-prior-candidate-discussions-2026-10-28.json) also preserves **nine dated architectural decisions**, including superseded owner directions. The crosswalk indexes **all 22 Media source feature families**, not an assertion that its 428 base audit-local feature checks or later third-pass additions have individual runtime/rights proofs. The original [unified blueprint](references/MEDIA-UNIFIED-DATA-DRIVEN-PRODUCTION-BLUEPRINT-V3-2026-10-17.md) and PDP0–3 retain full feature authority.

The [R9 reference catalog](../../config/qualification/wave2-reference-candidates.v1.json) continues to carry six *evaluation-only* assets. It is **not** the global technology register, and no reviewed model can silently take priority over an unrelated capability.

## 2. Candidate roles across all 22 source domains

| Domain | Source-selected or evaluated roles (not provider admission) |
|---|---|
| SPEC | Tools Product Definition/Experience contracts, canonical Media production spec compiler; FireRed-OpenStoryline planning candidate |
| CAP | Media capture and recorder orchestrator; reuse GharBatai neutral experience-recorder only after qualified public interface; Chromium/CDP and Playwright capture options |
| ASSET | Existing Media project/artifact store; glTF Transform, Assimp, Draco, conditional OpenImageIO |
| EDIT | Media 52 typed edit operations; selective MIT OpenReel, OpenTimelineIO interchange, OpenCut research, OpenChatCut AGPL behavior-only |
| COLOR | OpenColorIO selected; OpenEXR, MaterialX, conditional OpenImageIO |
| ASR | Official Whisper tiny reference asset; conditional whisper.cpp/sherpa-onnx; older WhisperX/Faster-Whisper/Parakeet alternatives |
| TTS | Existing Piper + R9 LJSpeech medium voice candidate; Chatterbox, Qwen3-TTS, CosyVoice; older PocketTTS/Supertonic-3/KittenTTS options |
| CLONE | Media voice/biometric rights authority; conditionally evaluated Chatterbox/Qwen engines, Voicebox MIT subsets; VoiceStudio AGPL requirements only, OmniVoice NC-risk |
| DUB | Real STT/TTS, MuseTalk and LatentSync video/lip-sync candidates; NLLB translation research |
| DSP | rubato, libebur128, RNNoise code only pending weights, DeepFilterNet and proven resampling/mixing |
| MUSIC | ACE-Step and HeartMuLa high-priority research; AudioCraft code-only while NC model weights excluded |
| GEN | Diffusers at Ghatana AI Inference boundary; Wan2.2, Kandinsky 6, Mochi, LTX and Hunyuan per-weight/hardware research |
| VISION | OpenCV, R9 YOLOX-Nano with distinct decoder, SAM2 masks/tracking, PySceneDetect; Ghatana Document Intelligence owns OCR |
| MOTION | Motion Canvas, Manim, Theatre core, Three.js/PixiJS, glTF, Rive/Lottie conditional; Theatre Studio AGPL excluded |
| DIRECT | FireRed-OpenStoryline, OpenReel narrow subset, OpenChatCut behavior only; same typed operations for manual/agent |
| SOCIAL | Media production derivatives, Open-Generative-AI partial MIT patterns and actual brand/rights constraints |
| INTER | Media interactive demo player; conditional Shaka Player, Lottie/Rive; LiveKit SFU currently NOT_REQUIRED |
| COLLAB | Media project versions, locks and approvals with Shared identity/messaging; no second editor database |
| DELIV | SVT-AV1, dav1d, libopus selected; libvpx/Shaka Packager conditional, MP4Box.js mux only; FFmpeg test-only exception |
| QA | libebur128 selected, VMAF conditional; measured decoded media and domain-specific thresholds |
| TRUST | Shared policy/Media consent and rights; c2pa-rs conditional, AudioSeal history-only |
| OPS | AI Inference model router, ONNX Runtime at admitted provider boundary, resource isolation and truthful Mac/Linux profiles |

## 3. Decision chronology and apparent contradictions

**Recorder source ownership:** October 6 discussions suggested a neutral recorder under Tools. Later Media Build owner decisions place capture/Studio production mechanics with Media; GharBatai neutral recorder remains a candidate for reusing a public package and Tools keeps Product Definition/Experience. The earlier direction is **retained as superseded**, not silently presented as an implemented Tools recorder.

**FFmpeg licensing:** The PDP-0 technology entry **TECH-FFMPEG = REJECTED** applies to a *default bundled strict-permissive* framework. The subsequent R7 decision permits a source-pinned LGPL FFmpeg binary as an **external development-test tool**. These policies have different scopes. Test-only use does not approve default bundled distribution or codec patent obligations.

**Voice and speech engine versus weight:** Whisper.cpp and sherpa entries are conditional engines; R9 official Whisper tiny, Piper LJSpeech medium and the matching tokenizer are narrow reference assets. Neither choice grants training-data rights, speaker/likeness consent, commercial redistribution or model qualification. Research-limited Lessac-derived voices do not become unconditional commercial references. Earlier OmniVoice, PocketTTS, Supertonic-3, KittenTTS, WhisperX, Faster-Whisper, Parakeet, NLLB and AudioSeal are preserved as **DISCUSSION_ONLY**, not source-pinned owner selections.

**Vision models:** An existing YOLOv8 80-class output parser and selected R9 YOLOX-Nano ONNX model have different tensor interfaces; independent model-specific shape, class and non-max-suppression tests are mandatory. SAM2 segmentation is a separate capability, not substitute detector proof.

**Reuse/OSS constraints:** Voicebox/OpenReel MIT *subsets* are conditional on isolating GPL Pedalboard, MPL MediaBunny, native FFmpeg and model rights. AGPL VoiceStudio/OpenChatCut provide behavioral requirements, not imported source. ComfyUI GPL, WanGP restrictions, Remotion paid terms, AudioCraft NC weights, Wav2Lip research restrictions and OpenVDB MPL remain separately gated. External execution alone cannot waive licensing.

**Animation versus simulation:** Media owns declarative animation and rendered media, while a scientific simulation requires an approved source Model IR, real solver and fidelity/units guarantee. TutorPutor owns its scientific/pedagogical truth. Rapier remains a conditional *fallback*; Box2D, SimPy, SciPy and other researched options are not automatically additional implementations.

## 4. How decisions are maintained

- To **select/change/reject a technology**: update the original PDP-0 selection authority through the normal source-owner change-impact protocol. Do not change the read-only crosswalk to create or override authority.
- To **pin a model/voice/corpus**: update the existing capability-specific R9 source candidate only when applicable; record exact asset and license independently. A candidate source hash and signed packet are not runtime permission.
- To **remember historical research**: link a source table/line or clearly label a discussion-only note; include date, prior status, superseded-by source, and rationale. Never delete previous option history.
- To **accept an actual capability**: require rights/consent/policy, correct model and provider output, security/finality, real corpus quality, host load and original PDP/source acceptance. No model becomes qualified because it appears in this register.

The read-only verifier checks exact Git source-blob fingerprints, every PDP0 decision, each row in all five research tables, the six R9 candidate IDs, nine discussion-only options and the 22-domain crosswalk. A source change triggers a failure requiring deliberate reconciliation.

```bash
pnpm check:candidate-decision-crosswalk
pnpm test:candidate-decision-crosswalk
pnpm check:wave2-reference-sources
pnpm test:wave2-evidence-intake
```

**Wave 2 acceptance is unchanged:** **58 = 22 locally verified + 30 partial + six external-owner**. Recording choices is necessary but not proof of the remaining 36 real provider/rights/quality outcomes. Continue that work in [R9 evidence acquisition](MEDIA-WAVE2-R9-EVIDENCE-ACQUISITION-AND-QUALIFICATION.md).
