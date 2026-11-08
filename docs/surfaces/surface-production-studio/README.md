# Logical surface: `media.surface.production-studio`

Creative production channel. Physical owner: `libs/audio-video-ui`
(studio-facing components/ports); dedicated execution engines remain
plan work.

`StoryboardPlanner` produces deterministic bounded local draft candidates with
exact source-version references and fresh rights checks. Canonical scene-plan /
scene-graph / timeline mapping and durable review authority remain unresolved.
Plan-wide source references use the declared 16,384 aggregate ceiling while
individual authored collections retain their 4,096 ceiling. The reference-
guided planner also rejects conflicting digests for one immutable source
version across roles before rights checks. Model generation and J-10 result
binding remain unresolved.

## Supported operations (plan target)

Project/timeline/asset/track/audio/video/annotation interfaces over one
canonical revision, with edit history, render/preview, review,
delivery and undo. Source definitions exist for storyboard, simulation,
3D, dubbing, mixing, delivery and interactive experiences; dedicated
execution engines and end-to-end implementation are not yet
established.

## States and invariants

- One canonical revision owns project state — no forked client-side
  truth; undo/edit history are revision-bound.
- Render/mix/delivery effects require the same admission/rights gates
  as other Media operations; unqualified engines stay fail-closed.
- UI surfaces bind through typed host ports; the library never
  fabricates render output.

## Dependencies

`@audio-video/ui` ports; canonical SDK/runtime for persistence and
effects; creative engine surfaces as they are admitted.

## Errors

Unadmitted operations render typed refusal; ambiguous render/provider
outcomes remain `UNKNOWN`.

## Tests

UI contract/renderer tests in `libs/audio-video-ui`; end-to-end studio
journeys tracked under the plan's creative-production workstream.
