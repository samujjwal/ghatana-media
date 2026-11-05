# Logical surface: `media.surface.explorer`

Media Experience Explorer channel. Physical owners:
`apps/media-experience-explorer` (frontend) and
`libs/media-experience-simulation` (deterministic fixture state).

## Supported operations

Deterministic simulation of authored journeys/scenarios — J-01, J-02
and a selected J-03 audio lane — with fixture reducers driving the
Explorer UI. Maintained, intent-based surface.

## States and invariants

- **Frontend-only projection of authored scenarios**: fixtures are
  visibly labeled simulation — they never claim real identity, uploads,
  providers, artifacts, terminal state or production evidence.
- The Explorer is a projection, never PDP authority; product meaning
  stays in `.product-experience/` sources.
- Consolidation targets: source bindings, keyboard/accessibility,
  responsive behavior, narration/captions; fixtures must not be
disguised as a real host.
- Simulation CLI: `pnpm dlx --package typescript@6.0.3 tsc -p
  libs/media-experience-simulation/tsconfig.json` then the fixture
  executable with `--scenario`, `--action`, `--format`.

## Dependencies

`libs/media-experience-simulation` fixture state; Explorer frontend;
authored scenario definitions.

## Errors

Simulation failures are local/typed; no external effects exist to
fail ambiguously.

## Tests

Explorer frontend tests (CSP, keyboard/a11y, responsive, simulation
labeling, screen coverage); simulation build/CLI verification per
physical surface docs.
