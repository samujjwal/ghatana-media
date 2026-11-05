# Logical surface: `media.surface.grpc.tts`

TTS gRPC channel. Physical owner: `modules/speech/tts-service`.

## Supported operations

11 declared methods (TTS-01 inventory): `Synthesize`,
`StreamSynthesize`, `GetStatus`, `GetMetrics`, `GetVoices`,
`LoadVoice`, `CreateProfile`, `GetProfile`, `UpdateProfile`,
`CloneVoice`, `SubmitFeedback` — exact dispositions in the physical
surface doc (`modules-speech-tts-service`).

## States and invariants

- Lawful voices only: synthesis rejects before engine lookup absent an
  exact admitted voice-language-rights profile; voice cloning is
  `UNIMPLEMENTED` pending owner consent, biometric purpose and
  retention; feedback `UNIMPLEMENTED` pending persistence/learning
  provider.
- No unsupported controls are disguised as executed — proto3-absent
  fields are never serialized as misleading zeros.
- Only `PCM_S16LE`/unspecified encodings map to the admitted raw-PCM
  response shape; `PCM_F32LE`/`WAV`/`MP3` reject before engine access.

## Dependencies

Injected shared `TtsEngine`; shared gRPC security policy.

## Errors

`UNIMPLEMENTED`/`FAILED_PRECONDITION`-class typed rejections; provider
diagnostics not exposed.

## Tests

`./gradlew :services:media:modules:speech:tts-service:test` — per-RPC
disposition matrix, encoding rejection, response-shape validation.
