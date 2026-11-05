# Logical surface: `media.surface.web`

Authenticated 47-screen product UI channel. Physical owners:
`libs/audio-video-ui` (components, screens, typed ports) and `launcher`
(route hosting). This is a contract/channel responsibility, not a new
deployable.

## Supported operations

Screen families render authored contracts and dispatch actions through
host ports (`MediaActionDispatchGuard`, `MediaLocalActionContracts`)
into the canonical SDK/runtime. Implemented renderer families:
first-use project, artifact intake, job recovery, transcript/captions,
task flow, contract screen, product renderer.

## States and invariants

- Every actionable screen routes through the canonical SDK and real
  backend via host ports — no screen fabricates job, artifact, provider
  or identity state.
- Loading, refusal, unknown, pending and final result states are
  first-class; accessibility is test-enforced
  (`shared-control-reuse.test`).
- Explorer (`apps/media-experience-explorer`) is a separate simulated
  surface and must not be mistaken for this live-product channel.

## Dependencies

`@audio-video/ui` package; host supplies port implementations and
authentication; `launcher` hosts routes.

## Errors

Dispatch guard rejects unadmitted actions; unsupported operations render
typed refusal/unknown states.

## Tests

`pnpm --filter @audio-video/ui test` (vitest: renderer, contract-screen,
caption-screen, progress, a11y, style and control-reuse suites).
