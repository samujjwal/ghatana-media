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
- Runtime `TtsConfig` uses the exact default voice captured in the candidate
  evaluated by provider admission; it does not reread a mutable environment
  value after admission. This binds configuration identity and does not prove
  voice rights or qualify a model.
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

## Local open speech models (owner decision 2026-11-14)

> "Local open models (Recommended): Whisper large-v3-turbo via whisper.cpp for speech-to-text (MIT). Kokoro-82M for text-to-speech (Apache-2.0, no voice cloning). Florence-2 for vision (MIT). Qwen2.5-VL-7B for multimodal (Apache-2.0). Media stays on this machine, with no per-use cost." The owner also said: "we will abide by all license requirements."

Weights and runtimes are **never committed**. They live under `~/.local/share/ghatana-media/{models,runtimes}/`
and are admitted only through a server-owned manifest (`<root>/models/<key>/manifest.json`; schema, template and
examples in `config/model-runtimes/`). `LocalModelManifest.verify` re-hashes every listed file and accepts only MIT
(STT) / Apache-2.0 (TTS) plus the verbatim owner decision. A missing, malformed, mismatched or swapped file leaves the
provider unready (no profile, NOT_ADMITTED). Verification proves artifact identity and licence provenance only: it is
not quality evidence, so `productionEligible()` stays false until the owner flips the manifest's own admission switch.
Licence notices: `THIRD_PARTY_NOTICES.md` (note the GPL espeak-ng/phonemizer runtime dependency of Kokoro's G2P
fallback: do not redistribute the venv).

Install (host-local): build `ggml-org/whisper.cpp` (`cmake -B build && cmake --build build --target whisper-cli`),
download `ggml-large-v3-turbo.bin` from `ggerganov/whisper.cpp`, create a venv with `kokoro`, `misaki`, `soundfile`,
`torch` and the `en_core_web_sm` model, download `hexgrad/Kokoro-82M`, then run
`tools/model-runtimes/install-local-manifests.sh`. Configure the server with `MEDIA_LOCAL_MODEL_ROOT`,
`MEDIA_WHISPER_CPP_BIN`, `MEDIA_KOKORO_PYTHON`, `MEDIA_KOKORO_SCRIPT` (absolute path of
`tools/model-runtimes/kokoro_synth.py`) and optionally `MEDIA_WHISPER_CPP_THREADS`. Both engines run as bounded
processes (no shell, cleared environment, deadlines, output ceilings).

Rights and consent: STT on a source version needs a `PROCESSING` admission from `RightsConsentResolver`
(`MEDIA_RIGHTS_DEV_ENABLED` in the DEV lane; otherwise `RIGHTS_AUTHORITY_UNAVAILABLE`). Synthesis accepts only request
text and a manifest-listed stock voice; it has no reference-audio or voice-sample input (unknown fields are rejected),
so no media-rights statement is required. Any future reference/voice-sample input must require
`VOICE_OR_LIKENESS_USE`. DEV routes: `GET /dev/v1/speech/capabilities`, `POST /dev/v1/speech/transcriptions`
(transcript JSON plus unreviewed derived WebVTT artifacts), `POST /dev/v1/speech/syntheses` (WAV artifact),
`GET /dev/v1/speech/outputs/{id}`. Agent tools use `MediaToolJobBridge` with a server-owned `SpeechProfilePin`, a
host-owned governance context and a bounded await for the terminal job state.
