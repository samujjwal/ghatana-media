# Surface: `modules-speech-tts-service`

Media-owned Text-to-Speech gRPC service (`modules/speech/tts-service`,
`:services:media:modules:speech:tts-service`). Typed contracts and
implementation source; presence of code or configured voices does not
qualify models, licenses, consent, codecs or live synthesis endpoints.

## Responsibility

- gRPC façade backed by an injected shared `TtsEngine`; synthesis fails
  closed before engine lookup because no exact admitted
  voice-language-rights profile exists.
- `com.ghatana.tts.engine.TtsSynthesisEngine` has no model/provider
  integration and also returns `NOT_ADMITTED`; neither path may claim
  audio output.
- Voice cloning is explicitly `UNIMPLEMENTED` until owner consent,
  biometric purpose and retention can be verified. Feedback is
  `UNIMPLEMENTED` pending a persistence/learning provider.

## Public operations (TTS-01 inventory — 11 declared methods)

| RPC | Disposition |
| --- | --- |
| `Synthesize`, `StreamSynthesize` | `EXPLICITLY_NOT_ADMITTED` — reject before engine lookup |
| `GetStatus` | `EXPLICITLY_NOT_ADMITTED` — engine status lacks session count; unknown is not serialized as zero |
| `GetMetrics` | `EXPLICITLY_NOT_ADMITTED` — proto3 lacks presence for `real_time_factor`/`active_sessions`; no misleading defaults |
| `GetVoices` | `PROVIDER_DEPENDENT` — lists engine-reported voices; listing is not proof of rights/readiness |
| `LoadVoice` | `EXPLICITLY_NOT_ADMITTED` — awaits authoritative model/license/rights/consent profile |
| `CreateProfile`, `GetProfile`, `UpdateProfile` | `EXPLICITLY_NOT_ADMITTED` — `UNIMPLEMENTED` before engine/storage access; no tenant/principal-scoped profile store or consent authority wired |
| `CloneVoice` | `EXPLICITLY_NOT_ADMITTED` — `UNIMPLEMENTED` until consent/biometric/retention checks wired |
| `SubmitFeedback` | `NOT_IMPLEMENTED` — no persistence/learning provider wired |

The proto declares `PCM_S16LE`, `PCM_F32LE`, `WAV`, `MP3`; the service
maps unspecified/`PCM_S16LE` to raw PCM and rejects the other encodings
before engine access. Admitted response shape validates mono PCM S16LE,
requested sample rate, frame alignment, exact duration, byte bounds and
basic non-silent signal integrity — this does not establish
intelligibility, codec/container support or speech quality.

## States and invariants

- No synthesized audio is produced on any current path; unsupported
  encodings and unqualified voices reject before engine access.
- `UNIMPLEMENTED` is an honest gRPC status — never a placeholder success.

## Dependencies and configuration

- Injected shared `TtsEngine` implementations (ONNX/Piper are separate
  provider integrations — no weights/license/decoder/quality qualified
  here); shared gRPC security policy.

## Errors

Typed `UNIMPLEMENTED`/`FAILED_PRECONDITION`-class rejections; provider
diagnostics are not exposed.

## Tests and commands

```bash
./gradlew :services:media:modules:speech:tts-service:test
```

Coverage: per-RPC disposition matrix, encoding rejection, response-shape
validation, fail-closed profile/consent paths. `J30ProviderCatalogUnavailableTest`
also verifies that an engine-reported voice can appear in the informational
inventory while synthesis remains `UNAVAILABLE/NOT_ADMITTED` with zero voice
load or synthesis calls. This is a synthetic service-boundary test, not voice
rights, model, or quality qualification.
