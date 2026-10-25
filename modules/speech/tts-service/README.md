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
| `CreateProfile` | EXPLICITLY_NOT_ADMITTED | Returns `UNIMPLEMENTED` before engine/storage access; no tenant/principal-scoped profile store or consent authority is wired. |
| `GetProfile` | EXPLICITLY_NOT_ADMITTED | Returns `UNIMPLEMENTED` before engine/storage access; profile ownership cannot be established. |
| `UpdateProfile` | EXPLICITLY_NOT_ADMITTED | Returns `UNIMPLEMENTED` before engine/storage access; profile ownership cannot be established. |
| `CloneVoice` | EXPLICITLY_NOT_ADMITTED | Returns `UNIMPLEMENTED` before calling an engine until owner consent, biometric purpose, and retention checks are wired. |
| `SubmitFeedback` | NOT_IMPLEMENTED | Returns `UNIMPLEMENTED` because no persistence/learning provider is wired. |

The proto declares `PCM_S16LE`, `PCM_F32LE`, `WAV`, and `MP3` enum values, but `TtsGrpcService` currently does not map `output_format` into `SynthesisOptions` or verify the returned bytes. The enum is not evidence that those encodings are produced. The standalone `TtsSynthesisEngine` now refuses all encodings without a real provider. Shared `TtsEngine` implementations, including ONNX/Piper, are separate provider integrations; no model weights, model license, decoder verification, or real speech quality were qualified by this inventory.

### W1 admission and SSML boundaries

`ProductionTtsGrpcService` requires explicit `TTS_PROVIDER_MODE=LOCAL_ONNX`, a readable regular local model file, matching SHA-256, and model id/version/license/language/region/retention/hardware metadata. This records and checks a local profile, but the profile remains `NOT_ADMITTED`: license, voice rights, hardware and quality evidence are not established here. Production composition therefore fails closed before warming or exposing readiness. It does not download a model or permit synthetic fallback. The provider manifest also reports `readiness: false`.

`SsmlProcessor` uses a hardened XML parser with DTD, external entities, external schema access and XInclude disabled. Inputs are limited to 65,536 characters, nesting to 16 levels, each pause to 10 seconds and total pause to 30 seconds. It accepts only the canonical `speak`, `break`, `prosody`, `emphasis`, `say-as`, `phoneme`, `voice`, `lang` and `sub` subset with constrained attributes; malformed XML, unsupported tags/attributes, entities and out-of-limit input fail with `IllegalArgumentException`. These parsing tests establish boundary handling, not provider prosody effects.

### TTS-05 voice and owner boundary

`PersistentTtsGrpcService` requires the authenticated tenant and a UUID-formatted subject before persistent synthesis; it no longer substitutes a random principal. Explicit caller-selected voice/profile IDs are rejected before provider or persistence work because no authoritative owner/rights decision exists. The current Shared gRPC identity context provides tenant and subject only. It has no trusted voice-purpose, consent grant/version, source-owner proof, expiry/revocation decision, or retention authority. The `consent_status` and `retention_policy` proto fields are caller-supplied and are not accepted as authority.

Voice cloning remains `UNIMPLEMENTED` / `NOT_ADMITTED` before any engine call. Create/Get/Update Profile also fail closed before engine or storage access because the current profile SPI is not tenant/principal scoped and has no consent/retention authority. This preserves wire IDs while preventing cross-owner access or treating profile upload as legal consent. `EmbeddingEncryptionService` provides tested AES-256-GCM primitives, but no embedding persistence or KMS-backed key lifecycle is wired; it does not establish encrypted retained embeddings or erasure. The next owner integration seam is a trusted Media/Shared consent decision plus tenant/principal-scoped profile/voice store with expiry/revocation and KMS-managed keys.

### TTS-06 control limits

The gRPC controls are checked for finite values, documented units and bounds: speed `[0.5, 2.0]`, pitch `[-12, 12]` semitones, and energy `[0, 2]`. Proto3 has no presence bit for these scalar fields; wire zero is treated as the omitted default (speed 1, neutral pitch, energy 1), so an explicit zero-energy request cannot be distinguished from omission. The service dispatches only neutral controls. Valid non-neutral speed/pitch/energy/emotion values receive `UNIMPLEMENTED` with `NOT_ADMITTED` because no qualified provider effect exists; unknown emotions and out-of-range/non-finite values receive `INVALID_ARGUMENT`. SSML rate accepts canonical labels or `50%..200%`, pitch requires `%` or `st` units within `[-12,12]`, and volume accepts canonical labels, `0%..200%`, or `-20dB..6dB`; any valid markup is still rejected before provider dispatch until a qualified adapter maps its segments. The emotion helper emits a proposed SSML string only; it does not prove an audible effect. Mixing volume/pan are finite and bounded to `[0,1]` / `[-1,1]`; no gRPC synthesis path claims those effects.

### TTS-01 capability inventory (17 registered intents)

| PDP-0 capability | Current disposition | Work owner |
| --- | --- | --- |
| `media.speech.synthesis.text-to-speech` | PROVIDER_DEPENDENT | TTS-07 |
| `media.speech.synthesis.streaming` | PROVIDER_DEPENDENT | TTS-08 |
| `media.speech.synthesis.multilingual` | PROVIDER_DEPENDENT | TTS-10 |
| `media.speech.synthesis.cross-lingual` | NOT_IMPLEMENTED | TTS-10 |
| `media.speech.synthesis.expressive` | EXPLICITLY_NOT_ADMITTED | TTS-06 |
| `media.speech.synthesis.control.prosody` | EXPLICITLY_NOT_ADMITTED | TTS-06 |
| `media.speech.synthesis.control.rate` | EXPLICITLY_NOT_ADMITTED | TTS-06 |
| `media.speech.synthesis.control.pitch` | EXPLICITLY_NOT_ADMITTED | TTS-06 |
| `media.speech.synthesis.control.emotion-style` | EXPLICITLY_NOT_ADMITTED | TTS-06 |
| `media.speech.synthesis.control.pronunciation` | EXPLICITLY_NOT_ADMITTED | TTS-06 |
| `media.speech.synthesis.control.phoneme` | EXPLICITLY_NOT_ADMITTED | TTS-06 |
| `media.speech.synthesis.speaker.condition` | EXPLICITLY_NOT_ADMITTED | TTS-05 |
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
