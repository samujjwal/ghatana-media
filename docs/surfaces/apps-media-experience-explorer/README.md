# Surface: `apps-media-experience-explorer`

Media-owned browser client (`apps/media-experience-explorer`, Vite/TS) that
reviews deterministic product scenarios. It is a **frontend-only
projection of authored product definitions** — it does not connect to the
Media runtime, Shared identity, a project service, or a processing
provider, and its fixtures must never be presented as real product
behavior.

## Responsibility

- Render the curated first-use, artifact-intake, verification-job,
  transcription-job and transcript/caption simulations across Product,
  Explore, Specification, Verify and Tools Review modes.
- Host the in-browser terminal running registered synthetic
  `ghatana-media` commands against the same fixture state/reducer (paired
  with `libs/media-experience-simulation`).
- Carry the two-pass demo-recording discipline: `EXPLORER_SIMULATED`
  captures show visible simulation disclosure; `PRODUCT_EXECUTED`
  captures require a real authorized host. Mock finality is never business
  evidence.

## Public operations

| Entry | Contents |
| --- | --- |
| `src/main.ts` / `product-review.tsx` / `strict-csp-controls.tsx` | App shell and review surfaces |
| `src/specification.ts`, `physical-topology.ts`, `topology-route.js` | Authored-definition projections and routing |
| `src/lifecycle-pack-adapter.js`, `tools-consumer.ts` | Fixture/lifecycle-pack and tool-consumer adapters |
| `src/keyboard-shortcuts.mjs` | Keyboard/a11y shortcuts |
| Vite dev server (`vite.config.mjs`) | Local preview; strict CSP controls page included |

## States and invariants

- All state is synthetic fixture state; labels must keep the simulation
  disclosure visible. The 26 unseeded journeys are explicitly deferred,
  not classified N/A.
- The Explorer is not the generic `ghatana-tools` host and not a fifth
  PDP — `.product-experience/` sources remain authoritative.
- The J-03 `EXPLORER_SIMULATED` r2 recording exists as criterion P3-11
  evidence (deterministic simulated state only); the real-product Build
  recording is `NOT_RECORDED` and semantic equivalence `NOT_VERIFIED`.

## Dependencies and configuration

- `libs/media-experience-simulation` for the fixture terminal;
  `specification-artifacts.json` for authored projections. No backend,
  identity or provider configuration exists — none is required or
  permitted.

## Errors

Fixture/validation errors surface in the review UI; there is no runtime
error taxonomy because no runtime is contacted.

## Tests and commands

```bash
pnpm --filter @ghatana/media-experience-explorer test
pnpm dlx vite@7.3.1 --config apps/media-experience-explorer/vite.config.mjs
```

Coverage: static scenario/contract reconciliation, CSP, keyboard/a11y and
responsive behavior, correct simulated labeling, and representation of the
defined screens. Browser tests must keep simulated labeling truthful.
