# Media Text-to-Speech Service

Media-owned TTS implementation source and typed gRPC contracts. New Media code belongs in this repository; the historical `ghatana/services/media` tree is read-only. The presence of an implementation or configured voice does not qualify its model, license, consent, codec, or live synthesis endpoint.

## Current implementation and admission status

The gRPC façade delegates to the injected shared `TtsEngine`. Its actual output depends on the configured engine/model and is **provider-dependent, not independently qualified here**. `com.ghatana.tts.engine.TtsSynthesisEngine` has no model/provider integration and therefore returns `NOT_ADMITTED`; it must not be used to claim audio output. Voice cloning is explicitly `UNIMPLEMENTED` at the gRPC boundary until owner consent, biometric purpose, and retention can be verified. Feedback remains `UNIMPLEMENTED` pending a persistence/learning provider.

### TTS-01 RPC inventory (11 declared methods)

| Proto RPC | Current disposition | Source observation |
| --- | --- | --- |
| `Synthesize` | PROVIDER_DEPENDENT | Delegates to configured `TtsEngine`; no qualified model/license/voice profile is established by this module. |
| `StreamSynthesize` | PROVIDER_DEPENDENT | Uses configured engine streaming API; real output, bounds, and finality require provider qualification. |
| `GetStatus` | IMPLEMENTED | Projects the configured engine status; it does not itself establish model quality or readiness policy. |
| `GetMetrics` | IMPLEMENTED | Projects configured engine metrics. |
| `GetVoices` | PROVIDER_DEPENDENT | Lists engine-reported voices; a listed/configured voice is not proof of rights or provider readiness. |
| `LoadVoice` | PROVIDER_DEPENDENT | Delegates model/voice loading to the configured engine. |
| `CreateProfile` | PROVIDER_DEPENDENT | Delegates to engine profile storage; durable owner-scoped storage must be configured. |
| `GetProfile` | PROVIDER_DEPENDENT | Delegates profile lookup to the configured engine/storage. |
| `UpdateProfile` | PROVIDER_DEPENDENT | Delegates profile update to the configured engine/storage. |
| `CloneVoice` | EXPLICITLY_NOT_ADMITTED | Returns `UNIMPLEMENTED` before calling an engine until owner consent, biometric purpose, and retention checks are wired. |
| `SubmitFeedback` | NOT_IMPLEMENTED | Returns `UNIMPLEMENTED` because no persistence/learning provider is wired. |

The proto declares `PCM_S16LE`, `PCM_F32LE`, `WAV`, and `MP3` enum values, but `TtsGrpcService` currently does not map `output_format` into `SynthesisOptions` or verify the returned bytes. The enum is not evidence that those encodings are produced. The standalone `TtsSynthesisEngine` now refuses all encodings without a real provider. Shared `TtsEngine` implementations, including ONNX/Piper, are separate provider integrations; no model weights, model license, decoder verification, or real speech quality were qualified by this inventory.

### TTS-01 capability inventory (17 registered intents)

| PDP-0 capability | Current disposition | Work owner |
| --- | --- | --- |
| `media.speech.synthesis.text-to-speech` | PROVIDER_DEPENDENT | TTS-07 |
| `media.speech.synthesis.streaming` | PROVIDER_DEPENDENT | TTS-08 |
| `media.speech.synthesis.multilingual` | PROVIDER_DEPENDENT | TTS-10 |
| `media.speech.synthesis.cross-lingual` | NOT_IMPLEMENTED | TTS-10 |
| `media.speech.synthesis.expressive` | PROVIDER_DEPENDENT | TTS-06 |
| `media.speech.synthesis.control.prosody` | PROVIDER_DEPENDENT | TTS-06 |
| `media.speech.synthesis.control.rate` | PROVIDER_DEPENDENT | TTS-06 |
| `media.speech.synthesis.control.pitch` | PROVIDER_DEPENDENT | TTS-06 |
| `media.speech.synthesis.control.emotion-style` | PROVIDER_DEPENDENT | TTS-06 |
| `media.speech.synthesis.control.pronunciation` | PROVIDER_DEPENDENT | TTS-06 |
| `media.speech.synthesis.control.phoneme` | PROVIDER_DEPENDENT | TTS-06 |
| `media.speech.synthesis.speaker.condition` | PROVIDER_DEPENDENT | TTS-05 |
| `media.speech.synthesis.speaker.clone-authorized` | EXPLICITLY_NOT_ADMITTED | TTS-05 |
| `media.speech.synthesis.voice.convert` | NOT_IMPLEMENTED | TTS-10 |
| `media.speech.synthesis.speech-to-speech` | NOT_IMPLEMENTED | TTS-10 |
| `media.speech.synthesis.speech.translate` | NOT_IMPLEMENTED | TTS-10 |
| `media.speech.synthesis.dub` | NOT_IMPLEMENTED | TTS-10 |

`PROVIDER_DEPENDENT` means the API can delegate to an engine but this module has not established a qualified positive effect. It is not a claim of logical completion.

## Purpose

The intended product capability is synthesis of natural-language text into audio through an admitted engine. Voice adaptation, streaming, prosody, multilingual behavior, and other advanced capabilities remain provider- and rights-dependent as listed above.

## Layer

`product` — owns the TTS runtime; extends `libs/java/common` and `modules/infrastructure/*`.

## Key Components

| Class | Responsibility |
|---|---|
| `VoiceMixingService` | Mixes synthesised audio from multiple voice profiles |
| `SynthesisResult` | Value object carrying the synthesised audio payload |
| `UserProfile` / `ProfileSettings` | Per-user voice customisation preferences |
| `AdaptationMode` | Enum of voice adaptation strategies (e.g. `CLONE`, `BLEND`) |
| `EngineState` / `EngineMetrics` | Runtime state and performance metrics of the synthesis engine |

## Configuration

Configuration is loaded through `libs/java/common` (`TtsConfig`):

```properties
tts.engine=local
tts.sample-rate=24000
tts.default-voice=neutral-en
```

## Dependencies

- `libs/java/common` — shared config and cloud fallback
- `modules/infrastructure/persistence` — persisting synthesised audio references
- `modules/infrastructure/security` — authentication interceptor
- `platform:java:observability` — metrics and tracing

## Testing

```bash
./gradlew :services:media:modules:speech:tts-service:test
```
