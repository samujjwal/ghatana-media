# Surface: `modules-intelligence-ai-voice-libs-ai-voice-ui-react`

Host-dependent React UI library for governed Media AI Voice experiences
(`modules/intelligence/ai-voice/libs/ai-voice-ui-react`,
`@ghatana/ai-voice-ui-react`). **Not** an independent deployed AI Voice
service or runnable desktop app.

## Responsibility

- Exports `PhraseTimeline`, `StemTrack`, `TrainingProgress`,
  `VoiceProductionWorkflow`, `Waveform` plus typed hooks/interfaces.
- Package subpath exports: `.` (index), `./components`, `./hooks`,
  `./types` — all from `dist/`.
- Consumes `@audio-video/ui` and Shared token/theme/design components.
  It does **not** grant a product host, model weights, authorization to
  clone voices, processing rights or a licensed audio provider.
- `VoiceProductionWorkflow`, `PhraseTimeline`, `StemTrack`,
  playback/mixer and recording interactions bind to an authorized TTS/
  voice SDK through host-provided ports — no mock or unauthorized clone
  is disguised as output.

## Public operations

React components + hooks + types only; the package is `private` and
consumed by product hosts. Canonical Media product meaning lives in
`.product-experience/` PDP-0/1/3 sources; implementation status is
separate.

## States and invariants

- UI package verification does not run a voice synthesizer, validate
  generated audio or demonstrate a production host.
- Voice cloning remains gated on owner consent, biometric purpose and
  retention (mirrors the TTS service `UNIMPLEMENTED` boundary).
- The prior `apps/desktop` application and its Python `grpc_server.py`
  (a nonfunctional placeholder returning fabricated success) were
  withdrawn — historical sources remain in Git history and
  `archive/media-desktop-apps/ai-voice-desktop` for inspection only. Any
  future AI Voice backend must be a separately qualified,
  rights-aware provider of existing Media operation contracts; it must
  not resurrect the success-mock server or silently enable cloning.

## Dependencies and configuration

- Peer dependencies on `@audio-video/ui` and Shared design components;
  build may depend on accepted Shared development artifacts.

## Errors

Host ports surface typed refusals/unknown states; the library never
fabricates provider output.

## Tests and commands

```bash
pnpm --filter @ghatana/ai-voice-ui-react typecheck
pnpm --filter @ghatana/ai-voice-ui-react test
pnpm --filter @ghatana/ai-voice-ui-react build
```

These verify the UI package only — not synthesis, audio validation or
host integration.
