# Media Experience Explorer Package

**Authority:** Phase 3 proposal projecting Phase 0–2 records\
**Acceptance:** blocked on P2-008, published Tools bindings, full baseline coverage, and human visual/accessibility review\
**Implemented here:** deterministic J-01 first-use fixtures, J-02 upload-metadata fixtures, J-20 transcription-job observation/cancellation fixtures, selected J-03 transcript/caption simulation, and a local browser review client

The package is Media-specific. It projects synthetic J-01 project setup, the
J-02 artifact-intake scenarios, a bounded J-20 transcription-job recovery slice,
and one defined audio transcript-review lane. It does not establish runtime
capability, provider success, quality, licensing, or production availability.
Media owns the simulated product state and actions; Tools owns the generic
Experience Explorer host and package contracts.

The current Tools checkout contains the headless `@ghatana/product-dev-explorer`
package and the four workspace contracts, but its explorer package declares
`standaloneProven: false` and has no generic browser renderer in the inspected
source. `apps/media-experience-explorer/` is a Media-owned local browser client
for one selected lane. It does not replace the Tools host or provide the
published, isolated-consumer binding. Those remain open under `GAP-11` and
`GAP-MEDIA-TOOLS-SCHEMA-BINDING`; the reducer is ready for an owner-bound Media
package adapter when those contracts are admitted.

## Four host modes

| Mode | Media behavior in the selected lane |
|---|---|
| Product | Shows the selected first-use, artifact-intake, transcription, caption-review, or job-status surface, or a route-addressable, read-only projection of one of the 47 Phase 2 screen contracts. Proposal actions are visibly disabled. The header, mode tabs, Explorer tabpanel, and Explorer controls are absent; the document title follows the selected view. |
| Explore | Selects a named scenario, supported web or CLI projection, preview width, and accessibility profile; actor and locale remain fixture-declared. J-01 is Web-only; J-02 upload recovery and J-20 transcription job status, cancellation, and outcome checking have local CLI commands. |
| Specification | Inspects the Phase 0 outcome/capability, Phase 1 component/state rule, and Phase 2 action/view/journey records. All 41 baseline view contracts and six selected-lane specializations have read-only previews of their declared structure, states, actions, channels, and guidance; actions remain labeled as not connected. Each screen preview opens its Product proposal route. Search filters records by title and filename, with the source YAML retained below the preview. |
| Verify | Reports current package bindings, reducer observations, structural and action coverage, and the required browser/accessibility evidence still missing. |

The workbench opens in Explore mode. Opening the product preview enters a
standalone Product route; browser history returns to the workbench. The host
owns mode navigation and diagnostics. Product mode owns its intended content.
All modes call the same deterministic Media action/effect model.
Explorer mode labels describe host functions; Product meaning continues to use
the Phase 2 view and action identifiers under the Phase 0 naming policy.

## Implemented and pending

- `libs/media-experience-simulation/` implements a deterministic state factory,
  guarded reducer, explicit simulated events, a shared channel projection, the
  `media-experience-fixture` fixture runner, and the `ghatana-media` canonical
  command simulator for synthetic fixtures. Its JSON and JSONL outputs expose
  the same projection used by the model tests; they do not connect to the Media
  runtime or a provider.
- `apps/media-experience-explorer/` renders Product, Explore, Specification,
  and Verify modes for six synthetic J-01 first-use states, J-02 metadata-only
  artifact intake and verification-job states, J-20 transcription-job state,
  and the selected transcript/caption lane. Product mode has three first-use
  routes, three J-02 artifact-intake views, one synthetic activity view, and a
  shared job-status view for verification and transcription jobs; four J-03
  view labels remain. In addition, all 47 screen contracts open as direct
  Product routes with source-derived purpose, declared regions and states,
  and disabled action proposals. These are navigable proposal projections,
  not implementations of the 41 baseline views or the six selected-lane
  specializations. Specification mode indexes all 147 source records and
  previews all 47 screen contracts without claiming their proposals are
  executable. The app does not implement all required journeys.
- Product proposal routes use `#product/view/<URL-encoded-contract-path>`;
  refreshing a route loads its source contract, and browser history returns to
  the Specification selection that opened it. Invalid proposal paths show an
  explicit not-found view.
- The four Product route labels bind to Phase 2 by intent: Source renders
  `media.view.select-source`, Transcript renders
  `media.view.review-transcript`, Captions renders
  `media.view.correct-captions`, and Versions renders
  `media.view.compare-caption-versions`. `media.view.monitor-transcription`
  and `media.view.check-job-outcome` are represented by inline job status and
  safe-action summaries in the Transcript and Captions routes; they are not
  separate routes in this local implementation.
- J-01 fixtures keep unauthenticated or denied workspace data hidden, preserve
  the same unknown project-create request, and create an empty project only in
  local synthetic state. They do not call Shared identity or project services.
- The J-02 routes show the library, upload transfer metadata, artifact
  integrity/policy disposition, and a separate verification-job view. The
  interrupted fixture can resume the same stable upload ID. No file bytes,
  real upload endpoint, production format allowlist, or verification worker is
  connected. Three synthetic job fixtures keep job and related upload
  identities separate; the owner-issued job contract remains unbound and the
  fixtures do not establish artifact availability.
- The J-02 activity route projects one synthetic verification job and opens its
  exact job view. It does not claim a production activity query, ordering,
  pagination, or event timestamps.
- The J-20 transcription job route preserves the exact job and source version,
  separates attempt state from job finality, omits unmeasured progress, and
  distinguishes stopping observation from cancellation. Cancellation remains
  pending until simulated owner confirmation; unknown outcomes retain the same
  job identity. The local CLI can view status, request cancellation, and check
  outcomes for transcription fixtures through the same reducer. Live watch, retries, job
  persistence across process restart, and runtime bindings remain unavailable.
- `media-experience-package.yaml` records the package authority boundary and
  external host dependency.
- `scenario-fixtures.yaml` indexes the fixture payloads in the simulation
  package and their Phase 2 scenario contracts.
- `view-projections.yaml` maps the selected screens to the same product state.
- `verification-matrix.yaml` records required structural, behavior, responsive,
  accessibility, packaging, and human-review observations.
- `scripts/check-experience-browser.mjs` exercises every source-derived
  scenario, Specification record, valid Product proposal route, inline
  artifact-verification specialization, Verify surface, keyboard path, and
  responsive viewport. It emits deterministic browser diagnostics and review
  screenshots without writing Evidence Generator artifacts.
- Specification trace context exposes a stable Explorer projection ID, phase and
  authority class, canonical source location, pending Tools semantic
  fingerprint/currentness, declared relation authority, and verification
  status. This is a projection of the source manifest, not a replacement
  semantic authority.
- The canonical command simulator uses the command IDs and guarded reducer
  declared in Phase 2. Versioned JSON/JSONL result and parse-error records stay
  machine-readable on stdout; human diagnostics stay on stderr. It is a local
  synthetic-fixture executable, not the production Media runtime CLI. API
  transport parity remains unspecified.
- `pnpm check:product-experience-local` is the repeatable local invariant check
  for indexed source existence, screen/action/journey denominators, proposal
  action disabling, closure-matrix coverage, and the intentional absence of
  generated `currentness.yaml`. It cannot replace Tools-native evidence or
  owner acceptance.
- The simulation package typechecks with TypeScript 6.0.3 and all 31 tests
  across the reducer and two CLI surfaces pass. The local browser client builds
  with Vite 7.3.1 and bundles 147 current specification records. These
  local observations do not establish a Tools-host binding or phase acceptance.
- The Playwright browser audit now covers all 29 Explore scenarios, all 147
  Specification records, all 47 valid Product proposal routes at six viewports
  (1536x960, 1280x800, 1024x768, 768x1024, 390x844, and 320x640), the inline
  artifact-verification specialization, Verify, keyboard navigation, visible
  accessible names, console/page errors, and horizontal overflow. It records
  282 Product route/viewport observations and repeated fixed-viewport screenshot
  hashes are identical across runs. This confirms deterministic route geometry
  and browser behavior, while the embedded CLI retains unknown job/upload
  identity and fits the 320px/390px views without overflow. Pixel-reference
  conformance, screen-reader, zoom, forced-colors, independent visual review,
  and owner acceptance remain outstanding, so Phase 3 is not accepted.
