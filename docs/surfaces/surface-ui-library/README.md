# Logical surface: `media.surface.ui-library`

Reusable UI component channel. Physical owners:
`libs/audio-video-ui` (`@audio-video/ui`) and
`modules/intelligence/ai-voice/libs/ai-voice-ui-react`
(`@ghatana/ai-voice-ui-react`).

## Supported operations

Accessible components, screens, hooks and typed host ports for Studio,
voice and captions experiences — `MediaComponentFamilies`,
`MediaTaskFlow`, `MediaProgress`, screen families (first-use, artifact
intake, job recovery, transcript/captions, task, contract), plus
`PhraseTimeline`, `StemTrack`, `TrainingProgress`,
`VoiceProductionWorkflow`, `Waveform` in the voice package.

## States and invariants

- Components bind through host-provided ports — no forked state model;
  the libraries never own runtime, identity, uploads or provider calls.
- Accessibility and Shared design-system reuse are test-enforced.
- Voice UI interactions bind to authorized TTS/voice SDK ports; no mock
  or unauthorized clone is presented as output (mirrors TTS service
  `UNIMPLEMENTED` cloning boundary).

## Dependencies

`@audio-video/ui` ↔ `@ghatana/ai-voice-ui-react` composition;
Shared token/theme/design components; typed client contracts.

## Errors

Port-level typed refusals; unadmitted actions rejected by dispatch
guard.

## Tests

`pnpm --filter @audio-video/ui test`; `pnpm --filter
@ghatana/ai-voice-ui-react typecheck|test|build`.
