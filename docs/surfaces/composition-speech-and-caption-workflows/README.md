# Composition: `media.composition.speech-and-caption-workflows`

Lawful source → decoded STT/TTS → transcript version → corrected caption
version → approved playable output with word clock and consent lineage.

## Input / output

Input: authorized audio sources and text. Output: versioned transcripts,
corrected caption drafts, approved playable captioned media — each step
consent/rights-lineage bound.

## Authority

- STT: `modules/speech/stt-service` (provider modes all `NOT_ADMITTED`
  pending model/license/quality gates).
- TTS: `modules/speech/tts-service` (synthesis `EXPLICITLY_NOT_ADMITTED`
  absent voice-language-rights profile; cloning `UNIMPLEMENTED`).
- Captions/transcripts: `runtime-contracts` caption/transcript
  contracts; `PostgresqlMediaCaptionStore`,
  `PostgresqlMediaTranscriptStore`; SDK `CaptionDraftSession`.
- Audio DSP: `speech-audio-rust` crate (bounded decode/resample/mix —
  utility, not provider).

## Failure / rollback

Unqualified provider → typed rejection before effect; caption approval
requires explicit review state; word-clock gaps stay unknown rather
than interpolated; consent revocation invalidates downstream reads
(cache adapter enforces source-backed invalidation).

## Cross-child behavior test

Journey-level: source → (admitted) STT → transcript version → caption
draft → correction → approval → playable output; denial at each gate
verified; consent lineage traced end-to-end. Real-provider legs remain
blocked on admission — tests assert fail-closed behavior today.

## Data flow

Source artifact → STT attempt (fenced) → transcript store → caption
draft session → human/system correction → approved caption version →
playable composition → delivery.
