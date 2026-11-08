# Surface: `libs-audio-video-ui`

Reusable accessible React UI library (`libs/audio-video-ui`,
`@audio-video/ui`). Media-specific components, screens and typed ports
over the canonical Ghatana design system — a UI library, not a deployed
product host.

## Responsibility

- **Component families** (`src/components/`): `MediaComponentFamilies`,
  `MediaComponentInputSchemas`, `MediaComponentRuntimeContracts`,
  `MediaComponentSchemaValidation`, `MediaComponentValueTypes`,
  `MediaProgress`, `MediaTaskFlow`, plus family accessibility tests.
- **Screens** (`src/screens/``): `FirstUseProjectScreen`,
  `ArtifactIntakeScreen`, `JobRecoveryScreen`, `TranscriptCaptionScreen`,
  `MediaTaskScreen`, `MediaContractScreen`, `MediaProductRenderer`,
  `MediaActionDispatchGuard`, `MediaLocalActionContracts`.
- **Interactive player** (`src/player/`): `InteractiveDemoPlayer` renders
  host-attested authored media with deterministic branch/replay/seek/caption
  state. Playback uses nonnegative safe-integer millisecond positions and
  does not dispatch product mutations. At the authored scene end, Play is
  disabled and reducer play is a no-op until the viewer chooses a branch or
  replays the scene.
- **Ports** (`src/ports/`): typed host ports — the library binds to a
  host-provided adapter; it does not own runtime state, identity,
  uploads or provider calls itself.
- `TranscriptCaptionScreen` can accept an optional admitted caption-version
  reader. It requests the exact tenant/principal/source-version scope, checks
  every returned row and duplicate identity, discards stale responses, and
  suppresses projected choices while the canonical read is loading or fails.
  A reader/projection scope mismatch is reported as `UNKNOWN`, even if a prior
  read for the reader's old scope was observed.
  This is a read adapter only; it does not admit caption writes, comparison
  actions, transcript generation, or a deployed product route.
- Foundations/hooks/styles consumed by product hosts and sibling UI
  packages (`ai-voice-ui-react` consumes `@audio-video/ui`).

## Public operations

Package exports `.` (index), component/hook/type subpaths via
`dist/`. Consumers supply the port implementations; screens render
authored contracts and dispatch actions through
`MediaActionDispatchGuard`/`MediaLocalActionContracts`.

## States and invariants

- Actionable screens route through the canonical SDK/runtime via host
  ports — the library never fabricates job, artifact, provider or
  identity state; loading/refusal/unknown/pending/final states are
  first-class render states.
- Accessibility is enforced by tests (`MediaFamilyAccessibility.test`,
  `shared-control-reuse.test`); components reuse Shared design-system
  controls rather than forking a state model.
- `MediaContractScreen`/renderer tests keep screen output reconciled
  with authored contract fixtures.
- The player fails closed without exact host attestation; source truth is
  labeled explicitly and unverified live evidence is not shown as live output.
  Its Node reducer tests pass, while React component tests, browser playback,
  and live-output/host qualification remain open.

## Dependencies and configuration

- Peer/host dependency on the canonical design system and typed client
  contracts; styles via `src/styles.css`.

```bash
pnpm --filter @audio-video/ui typecheck
pnpm --filter @audio-video/ui test
pnpm --filter @audio-video/ui build
```

## Errors

Dispatch guard rejects actions lacking host admission; unsupported or
unbound operations render refusal/unknown states rather than implying
success.

## Tests and commands

Vitest suites colocated with components/screens
(`MediaProductRenderer.test`, `MediaContractScreen.test`,
`TranscriptCaptionScreen.test`, `MediaProgress.test`,
`MediaFamilyAccessibility.test`, `styles.test`,
`shared-control-reuse.test`). Run via the pnpm scripts above.
The source-scope binding helper also has a dependency-free Node selector:
`node --experimental-strip-types --test src/screens/captionVersionReadBinding.test.mjs`.
The React component selector could not be run in this checkout because the UI
package has no linked Vitest/React dependencies. The latest mismatch-state
regression is added but unexecuted; the pure helper remains independently
verified.
