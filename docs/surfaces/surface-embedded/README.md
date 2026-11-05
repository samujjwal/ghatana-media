# Logical surface: `media.surface.embedded`

Sandboxed, origin-bound media/player embed channel. Physical owner:
`libs/audio-video-ui` (player implementation under
`src/player/` per plan; current screen/component families provide the
embed primitives).

## Supported operations

- Embedded media/player with read-only or scoped delegated operations,
  controls and captions.
- Origin-bound sandboxing: the embed cannot exceed its granted scope.

## States and invariants

- No host privilege leakage: embedded content receives only the scoped
  delegated operations it was granted; identity, uploads, providers and
  effects are never implied by embed presence.
- Simulation-versus-live declaration is explicit — fixture content is
  labeled, never disguised as a real host.
- Branching timed playback, replay, keyboard/screen-reader navigation
  are plan targets for the interactive player; current status follows
  the physical surface's verified capabilities only.

## Dependencies

`@audio-video/ui`; host page supplies origin and scope grant.

## Errors

Out-of-scope actions are rejected at the port boundary; cross-origin or
unbound operations fail closed.

## Tests

Component/port contract tests in `libs/audio-video-ui` (vitest); embed
scope and origin-binding coverage tracked under the interactive-demo-
player plan item.
