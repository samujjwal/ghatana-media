# Surface: `modules-speech-stt-service`

Media-owned Speech-to-Text gRPC service (`modules/speech/stt-service`,
`:services:media:modules:speech:stt-service`). Wire contract:
`src/main/proto/stt_service.proto`; production composition:
`com.ghatana.stt.grpc.ProductionSttGrpcService`.

## Responsibility

- Implements the STT gRPC boundary: model state, transcribe, streaming,
  correction and profile operations per the proto contract.
- **Provider boundary is fail-closed**: the server composition rejects
  all provider modes until admission and fails closed **before**
  constructing or warming any model. It does not compose an upstream
  Whisper gRPC client (the `GrpcSttClientAdapter` in Multimodal is a
  *consumer* of this service, not a provider adapter for it).

## Public operations

STT RPCs per `stt_service.proto`; `ProductionSttGrpcService` requires an
explicit `STT_PROVIDER_MODE` selection:

| Mode | Required profile | Current disposition |
| --- | --- | --- |
| `GRPC` | Host, port, TLS/mTLS, model ID/version/SHA-256/license/hardware/region | `NOT_ADMITTED` — no upstream client adapter composed |
| `LOCAL_ONNX` | Readable non-symlink model file + model ID/version/SHA-256/license/hardware/region | `NOT_ADMITTED` — digest checked, but no source-authorized license/quality qualification |
| `NOP` | No provider settings | `NOT_ADMITTED` — disabled mode cannot satisfy transcription |

Missing/unknown modes, mismatched settings and model digest mismatch
fail before the server binds. Descriptive metadata does not admit a
provider; no live provider or model-quality qualification is claimed.

## States and invariants

- No model is constructed, warmed or served on any current path —
  admission requires pinned model/export rights, independent reference,
  host review and quality evidence (per plan ASR corpus policy: FLEURS
  and Hindi deferred/nonblocking; real inference `NOT_ADMITTED`).
- Engine/provider absence is an explicit typed rejection, never a
  fabricated transcript.
- PostgreSQL caption-registration replay reconstructs the stored request,
  including optional-field presence and segments, and checks it against the
  persisted fingerprint before returning a receipt. Corrupt readback maps to
  `UNKNOWN_OUTCOME`; this is storage integrity evidence, not provider admission.

## Dependencies and configuration

- `STT_PROVIDER_MODE` plus per-mode profile settings (see module README
  for exact keys); shared gRPC transport security policy.
- `modules/infrastructure/messaging` for the transcription job queue;
  `modules/infrastructure/cache` for source-backed transcript reads.

## Errors

Provider-mode/profile/digest failures reject before bind; RPC-level
rejections are typed (`FAILED_PRECONDITION`-class), not silent.
Wrapped provider `TimeoutException` values map to sanitized gRPC
`DEADLINE_EXCEEDED`; provider exception details are not returned to callers.

## Tests and commands

```bash
./gradlew :services:media:modules:speech:stt-service:test
```

Coverage: mode/profile validation, digest checks, fail-closed startup,
RPC contract behavior. Real inference is not exercised — none is
admitted.

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

Install (host-local): build `ggml-org/whisper.cpp` with the GPU (Vulkan) backend as one static binary by running
`tools/model-runtimes/build-whisper-vulkan.sh` (owner decision 2026-11-14: "Yes, download them", approving the
Khronos Vulkan-Headers v1.4.341 and SPIRV-Headers vulkan-sdk-1.4.341.0 build inputs; needs the NVIDIA Vulkan driver
and a `glslc`). The binary is `runtimes/whisper.cpp-src/build-vulkan/bin/whisper-cli`; the script refuses a build
that loads libwhisper/libggml shared objects, because only the executable's SHA-256 is pinned in the manifest. On
this host (Quadro RTX 5000) an 11-second clip transcribes in about 1.8 s warm versus 29.5 s on the earlier CPU
build; the first run after a driver update also compiles and caches GPU shaders. A CPU-only host can still use a
static CPU build by setting `WHISPER_CPP_EXE` when running `install-local-manifests.sh`. Then
download `ggml-large-v3-turbo.bin` from `ggerganov/whisper.cpp`, create a venv with `kokoro`, `misaki`, `soundfile`,
`torch` and the `en_core_web_sm` model, download `hexgrad/Kokoro-82M`, then run
`tools/model-runtimes/install-local-manifests.sh`. Configure the server with `MEDIA_LOCAL_MODEL_ROOT`,
`MEDIA_WHISPER_CPP_BIN`, `MEDIA_KOKORO_PYTHON`, `MEDIA_KOKORO_SCRIPT` (absolute path of
`tools/model-runtimes/kokoro_synth.py`) and optionally `MEDIA_WHISPER_CPP_THREADS`. Both engines run as bounded
processes (no shell, cleared environment, deadlines, output ceilings).

A source that is not a RIFF WAV (for example the MP4 of a multimodal operation) is accepted only when `MEDIA_FFMPEG` points
at an FFmpeg binary: `LocalMediaAudioExtractor` extracts its first audio stream as mono 16 kHz PCM16 WAV in one bounded
process (the same 4 MiB staging ceiling applies to the source and to the extracted WAV); without FFmpeg only WAV is accepted.

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

Rights and consent: STT on a source version needs a `PROCESSING` admission from `RightsConsentResolver`
(`MEDIA_RIGHTS_DEV_ENABLED` in the DEV lane; otherwise `RIGHTS_AUTHORITY_UNAVAILABLE`). Synthesis accepts only request
text and a manifest-listed stock voice; it has no reference-audio or voice-sample input (unknown fields are rejected),
so no media-rights statement is required. Any future reference/voice-sample input must require
`VOICE_OR_LIKENESS_USE`. DEV routes: `GET /dev/v1/speech/capabilities`, `POST /dev/v1/speech/transcriptions`
(transcript JSON plus unreviewed derived WebVTT artifacts), `POST /dev/v1/speech/syntheses` (WAV artifact),
`GET /dev/v1/speech/outputs/{id}`. Agent tools use `MediaToolJobBridge` with a server-owned `SpeechProfilePin`, a
host-owned governance context and a bounded await for the terminal job state.
