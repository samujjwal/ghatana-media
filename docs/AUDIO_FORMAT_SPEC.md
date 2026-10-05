# Audio Format Specification

This document defines the canonical audio contract shared by the Java platform library, the Rust desktop bridge, and the TypeScript clients.

## Canonical Descriptor

Every audio payload is described by the following fields:

- `sampleRate`: samples per second
- `channels`: number of audio channels
- `bitsPerSample`: PCM precision for raw audio payloads
- `format`: one of `pcm`, `wav`, `mp3`, `flac`, `ogg`, `aac`
- `durationMs`: media duration in milliseconds when known

## Defaults

The default cross-platform capture profile is:

- `sampleRate = 16000`
- `channels = 1`
- `bitsPerSample = 16`
- `format = pcm`

This matches the platform STT defaults and avoids unnecessary resampling for speech workloads.

## Guidance By Layer

- Java platform: use `AudioData` and `CanonicalAudioFormat` in `com.ghatana.media.common`.
- TypeScript clients: use `AudioData` from `@audio-video/types` and preserve `bitsPerSample`.
- Rust desktop bridge: preserve the descriptor when forwarding bytes to gRPC services.

## Compatibility Rules

- `pcm` represents raw audio bytes and requires `bitsPerSample`.
- Container formats such as `wav`, `mp3`, `flac`, `ogg`, and `aac` must still declare the playback or decode sample rate when it is known.
- Missing duration should be computed from raw PCM size whenever possible instead of leaving it undefined.