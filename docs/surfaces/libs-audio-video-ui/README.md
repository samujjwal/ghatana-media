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
- **Ports** (`src/ports/`): typed host ports — the library binds to a
  host-provided adapter; it does not own runtime state, identity,
  uploads or provider calls itself.
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
