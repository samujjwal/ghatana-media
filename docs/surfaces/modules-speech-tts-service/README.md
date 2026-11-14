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

TTS delivery encodings and the artifact: `LINEAR16`/`WAV` are PCM16 WAV; `MP3` (libmp3lame) and `OGG_OPUS` (libopus) are
encoded by `LocalAudioEncoder` through one bounded FFmpeg process (absolute `MEDIA_FFMPEG`, argument array, cleared
environment, deadline, output ceiling) and read back by a second bounded decode pass plus container-signature check, so a
failed or truncated encode is a typed failure, never a success. `LocalKokoroTtsProvider.supportedEncodings()` reports what the
host can really produce; a host composes `MediaToolJobBridge.withSupportedTtsEncodings(...)` so an unsupported encoding is
refused as `TTS_AUDIO_ENCODING_NOT_SUPPORTED` before any job exists, and the provider itself answers invalid text, voice,
pitch or encoding with a `NO_EFFECT_PROVEN` submission (the job is `FAILED`, never `OUTCOME_UNKNOWN`). A completed TTS job
registers the synthesized audio through the canonical durable upload path (begin, chunked append, complete; idempotency key
derived from tenant, principal and job id) as an immutable artifact version whose metadata carries lineage (source artifact
and version, job and request ids, provider, model id/key/sha256, voice, text SHA-256, encoding). The job result carries
`audioArtifactRef`, `audioArtifactId`, `audioArtifactVersion` and `audioArtifactSha256` and never the inline bytes; a
registration failure fails the job as `TTS_OUTPUT_REGISTRATION_FAILED`.

### Shared manifest, digest cache and warm-up (2026-11-14 follow-up)

There is now exactly one `LocalModelManifest` (`libs/java/common`, `com.ghatana.media.runtime.localmodel`). Speech reads
`manifest.json` (`LocalModelManifest.read`); vision and multimodal read `ghatana-model-manifest.json`
(`LocalModelManifest.readDirectory`, which maps the tools/model-runtimes layout onto the same record). Both go through the
same `verify`: owner-approved SPDX per modality (`MIT` for STT and Florence-2, `Apache-2.0` for TTS and Qwen2.5-VL),
verbatim owner decision, regular non-symlink files, exact size and SHA-256. Digests come from `FileDigestCache`: a digest is
reused only while the file's size, nanosecond mtime and inode (device and inode) are unchanged; a file modified within the
last two seconds, or whose stat key changed while it was hashed, is never cached; any change re-hashes and withdraws the
profile (`stillCurrent()` also compares inode). Setting `MEDIA_LOCAL_MODEL_DIGEST_CACHE` (or system property
`ghatana.media.localModel.digestCacheFile`) persists the cache in an owner-only JSON file so a restart skips re-hashing
unchanged multi-gigabyte weights; it is off by default and the vision sidecar honours the same variable (own sibling file).
`MEDIA_LOCAL_MODEL_PRELOAD=true` starts a background warm-up when the provider is composed (`warmUp()` on the Whisper, Kokoro
and local vision providers; vision additionally warms Qwen only with `MEDIA_LOCAL_MODEL_PRELOAD_QWEN=true`). Warm-up output is
discarded and is never evidence.

### Persistent Kokoro worker (opt-in, `MEDIA_KOKORO_WORKER=true`)

`tools/model-runtimes/kokoro_worker.py` is a loopback-only, bearer-token-authenticated Kokoro-82M worker that loads the
model once (CUDA when `torch.cuda.is_available()`, else CPU; `MEDIA_KOKORO_DEVICE=auto|cpu|cuda`; the device actually used
is reported by `GET /v1/health` and the `X-Kokoro-Device` header). `LocalKokoroWorker` starts it lazily as a child process
(`python -I`, argument array, cleared environment, random per-process token, free loopback port, stdout/stderr discarded),
restarts it after a crash (at most `maxConsecutiveFailures`=3 in a row, then a 30 s cool-down), retries a call once after a
crash (synthesis has no external effect), stops it on JVM exit and gives the worker a `--parent-pid` watchdog. One worker is
shared per JVM for the same interpreter/script/model. Without the variable the per-call `kokoro_synth.py` path is unchanged;
with it there is deliberately no silent fallback: a dead, unreachable, unverified, cooling-down or credential-refusing worker
is a typed `LocalTtsException` (`WORKER_UNAVAILABLE`, `WORKER_BUSY`, `FILES_CHANGED`, `TIMEOUT`), never a success.

Integrity: the manifest pins the worker script (`runtime.workerSha256`, written by `make_manifest.py --runtime-worker`; an
older manifest without it simply offers no worker and the provider is not ready in worker mode). The worker refuses to serve
unless the weights, config, voice packs, licence/card files and its own script match the manifest; it re-checks (stat, then
re-hash on change) before each request and after synthesis and turns permanently `REFUSED` (503 `FILES_CHANGED`, audio
discarded) on a mismatch. The Java side additionally withdraws readiness and stops the worker when `LocalModelInstall` or
the worker script change. Bounds: 64 KiB body, 2000 characters of text, speed 0.5-2.0, deadline 1 ms-180 s (checked while
queued and between synthesis chunks), one synthesis at a time plus two waiting, anything beyond that is 429 `BUSY`, output at
most 8 MiB. Only manifest-listed voice packs work; there is no embedding or cloning input. After changing either script,
re-run `tools/model-runtimes/install-local-manifests.sh`. Python unit tests (stub engine, no model):
`kokoro-venv/bin/python tools/model-runtimes/test_kokoro_worker.py`.

Measured on the development host (Quadro RTX 5000 shared with other agents, load average about 26-30, so absolute numbers
are noisy): per-call CPU sidecar 35-48 s per call; worker cold start (interpreter, torch import, CUDA init, digest check of
327 MB, load, warm-up) about 18.5 s in a quiet moment and 34.8 s under load; warm call 0.15 s quiet (0.2-1.4 s under load);
the worker is about 0.7-0.8 GB of VRAM. `MediaDevSpeechTimingTest` (launcher) re-measures this on real models and prints
`TIMING ...` lines; `MEDIA_SPEECH_BENCH_BASELINE=true` adds the per-call baseline.

Whisper stays one bounded `whisper-cli` process per call. A persistent `whisper-server` (examples/server) was evaluated and
not adopted: it has no authentication, `POST /load` lets any local process swap the model file after the digest was verified,
it has no per-request deadline or cancellation (inference holds one mutex until finished), and its request size and upload
handling are not bounded by us; its optional `--convert` path shells out to `ffmpeg` through `system()`. Those cannot be
bounded or verified from outside the pinned binary.

Rights and consent: STT on a source version needs a `PROCESSING` admission from `RightsConsentResolver`
(`MEDIA_RIGHTS_DEV_ENABLED` in the DEV lane; otherwise `RIGHTS_AUTHORITY_UNAVAILABLE`). Synthesis accepts only request
text and a manifest-listed stock voice; it has no reference-audio or voice-sample input (unknown fields are rejected),
so no media-rights statement is required. Any future reference/voice-sample input must require
`VOICE_OR_LIKENESS_USE`. DEV routes: `GET /dev/v1/speech/capabilities`, `POST /dev/v1/speech/transcriptions`
(transcript JSON plus unreviewed derived WebVTT artifacts), `POST /dev/v1/speech/syntheses` (WAV artifact),
`GET /dev/v1/speech/outputs/{id}`. Agent tools use `MediaToolJobBridge` with a server-owned `SpeechProfilePin`, a
host-owned governance context and a bounded await for the terminal job state.
