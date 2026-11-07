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
- `InteractiveDemoPlayer` implements a deterministic branch/seek/caption
  state machine. Scene, cue, seek and playback positions use nonnegative
  safe-integer milliseconds; cue intervals are half-open `[startMs, endMs)`.
- Native media is attached only after the supplied host verifier attests the
  exact manifest and embedding origin. The player exposes source truth as
  simulated, curated, or evidence-bound live output and dispatches no product
  mutations.
- React component tests and browser/host playback qualification remain open;
  the local reducer suite does not qualify live output or a deployed host.

## Dependencies

`@audio-video/ui`; host page supplies origin and scope grant.

## Errors

Out-of-scope actions are rejected at the port boundary; cross-origin or
unbound operations fail closed.

## Tests

`pnpm test:interactive-demo-player-state` covers the source-free reducer and
manifest boundaries. React component and browser tests remain required for
keyboard/screen-reader behavior, media events, and host-origin enforcement.
