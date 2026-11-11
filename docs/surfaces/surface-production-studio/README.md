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

The definition-only contract preview remains available. A separate
`dev-project-timeline` renderer is now consumed by the local Explorer host:
it edits the DEV_ONLY project's single owner revision through the existing
exact-head API and confirms each successor by reopening the current head.
Exact immutable revision reads, read-only comparison of two exact project
snapshots, and restore-as-successor are available there. Comparison reports
timeline membership and scene/track/clip reference changes with exact rational
clip-time equality; it does not evaluate source eligibility, clock mapping,
overlap behavior, or rendered output.
The workspace explicitly reports rendering as unavailable; it submits no
render request and fabricates no output. This local consumer does not create a
second graph writer or establish a hosted Studio route, Shared identity,
production rights, render engine, review approval, or delivery operation.

The original Studio contract UI is a definition-only contract preview. Its
`media.view.arrange-scenes` save action is controlled by the host-projected
action state and guarded dispatcher; the focused regression verifies disabled
actions do not dispatch and an ambiguous `intent-accepted` result stays locked
pending reconciliation. This is action-boundary coverage only: no canonical
project write, Studio route, durable revision, render, review approval, or
delivery operation is admitted.

A separate [local synthetic multitrack preview](../../../examples/recorder-mux-preview/multitrack/README.md)
demonstrates decoded video/graphic/audio/caption composition with the pinned
development FFmpeg pair. It runs outside the Studio UI and project graph; it
does not change the definition-only UI status or establish project lineage,
rights, production codec admission, or delivery.

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
journeys tracked under the plan's creative-production workstream. Run the
storyboard action-boundary regression with
`pnpm --filter @audio-video/ui exec vitest run src/screens/MediaContractScreen.test.ts --maxWorkers=1 --no-file-parallelism`.
