# Logical surface: `media.surface.interactive-demo-player`

Interactive demo playback channel. Physical owner:
`libs/audio-video-ui` (new player implementation under `src/player/`
per plan; not yet established).

## Supported operations (plan target)

Branching timed playback, captions, controls, replay, safe host embed,
explicit simulation-versus-live declaration, keyboard/screen-reader
navigation.

## States and invariants

- Deterministic branching: seek/replay/branch behavior is reproducible
  from authored scenario definitions.
- Simulation content is visibly declared — never presented as live
  product behavior.
- Sandboxed origin-bound embed with scoped delegated operations only;
  no host privilege leakage (shared boundary with
  `media.surface.embedded`).
- Accessibility (keyboard, screen reader) and responsive behavior are
  required, test-enforced properties.

## Dependencies

`@audio-video/ui`; authored scenario/fixture definitions;
`libs/media-experience-simulation` for deterministic state where
applicable.

## Errors

Cross-origin/unbound operations fail closed; unsupported branches
render explicit unavailable states.

## Tests

Planned: seek/replay/branch determinism, cross-origin denial,
keyboard/a11y suites — tracked under the plan's UI/capture workstream.
