# Media Experience Explorer Package

**Authority:** Explorer proposal projecting PDP-0 through PDP-3 records; Explorer is outside the four PDP phases\
**Acceptance:** blocked on P2-008, published Tools bindings, full baseline coverage, and human visual/accessibility review\
**Implemented here:** deterministic J-01 first-use fixtures, J-02 upload-metadata fixtures, J-20 transcription-job observation/cancellation fixtures, selected J-03 transcript/caption simulation, and a local browser review client

The package is Media-specific. It projects synthetic J-01 project setup, the
J-02 artifact-intake scenarios, a bounded J-20 transcription-job recovery slice,
and one defined audio transcript-review lane. It does not establish runtime
capability, provider success, quality, licensing, or production availability.
Media owns the simulated product state and actions; Tools owns the generic
Experience Explorer host and package contracts.

Tools owns the generic Explorer host and package contracts. Media must bind to
published, owner-approved Tools contracts and prove isolated consumer loading,
Media render/inspect/dispatch behavior, and the browser presentation layer;
standalone capability itself is not a Media gap. `apps/media-experience-explorer/` is a Media-owned
local browser projection for selected lanes. It does not replace the Tools host
or manufacture duplicate schemas. The remaining binding work is tracked under
`GAP-11` and `GAP-MEDIA-TOOLS-SCHEMA-BINDING`.

## Host modes and semantic views

| Mode | Media behavior in the selected lane |
|---|---|
| Product | Shows the selected first-use, artifact-intake, transcription, caption-review, or job-status surface, or a route-addressable, read-only projection of one of the 47 PDP-3 screen contracts. Proposal actions are visibly disabled. The header, mode tabs, Explorer tabpanel, and Explorer controls are absent; the document title follows the selected view. |
| Explore | Selects a named scenario, supported web or CLI projection, preview width, and accessibility profile; actor and locale remain fixture-declared. J-01 is Web-only; J-02 upload recovery and J-20 transcription job status, cancellation, and outcome checking have local CLI commands. |
| Specification | Inspects PDP-0 outcome/capability, PDP-1 component/state rules, and PDP-3 action/view/journey records. All 47 canonical screen contracts plus the job-family specialization have read-only previews of their declared structure, states, actions, channels, and guidance; actions remain labeled as not connected. Each screen preview opens its Product proposal route. Search filters records by title and filename, with the source YAML retained below the preview. |
| Verify | Reports current package bindings, reducer observations, structural and action coverage, and the required browser/accessibility evidence still missing. |

The Explorer also exposes Overview and semantic views for Truth, Domain, Design
System, Experience, Interfaces, Journeys, States/Data, Traceability, and
Dependencies. These are local projections over the indexed source records; they
do not create a second authority or establish phase acceptance.

The workbench opens in Explore mode. Opening the product preview enters a
standalone Product route; browser history returns to the workbench. The host
owns mode navigation and diagnostics. Product mode owns its intended content.
All modes call the same deterministic Media action/effect model.
Explorer mode labels describe host functions; Product meaning continues to use
the PDP-3 view and action identifiers under the PDP-0 naming policy.

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
  not implementations of the 47 canonical views or the job-family
  specialization. Specification mode indexes the generated source records and
  previews all 47 screen contracts without claiming their proposals are
  executable. The app does not implement all required journeys.
- Product proposal routes use `#product/view/<URL-encoded-contract-path>`;
  refreshing a route loads its source contract, and browser history returns to
  the Specification selection that opened it. Invalid proposal paths show an
  explicit not-found view.
- The four Product route labels bind to PDP-3 by intent: Source renders
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
  package and their PDP-3 scenario contracts.
- `view-projections.yaml` maps the selected screens to the same product state.
- `verification-matrix.yaml` records required structural, behavior, responsive,
  accessibility, packaging, and human-review observations.
- `scripts/check-experience-browser.mjs` exercises every source-derived
  scenario, Specification record, valid Product proposal route, inline
  artifact-verification specialization, Verify surface, keyboard path, and
  responsive viewport. It emits deterministic browser diagnostics and review
  screenshots without writing lifecycle-owned Evidence Generator artifacts.
- Specification trace context exposes the manifest artifact ID, phase and
  authority class, canonical source location, pending Tools semantic
  fingerprint/currentness, declared relation fields, and verification status.
  The generator derives IDs from repository paths for newly indexed sources, so
  they are not stable semantic identities. This is a source-manifest
  projection, not a replacement semantic authority.
- The canonical command simulator uses the command IDs and guarded reducer
  declared in PDP-2/PDP-3. Versioned JSON/JSONL result and parse-error records stay
  machine-readable on stdout; human diagnostics stay on stderr. It is a local
  synthetic-fixture executable, not the production Media runtime CLI. API
  transport parity remains unspecified.
- `pnpm check:product-experience-local` is the repeatable local invariant check
  for indexed source existence, screen/action/journey denominators, proposal
  action disabling, closure-matrix coverage, and the intentional absence of
  generated `currentness.yaml`. It cannot replace lifecycle-native evidence or
  owner acceptance.
- Earlier local runs reported a simulation typecheck, 31 simulation tests, and
  a Vite browser build. Those observations predate the latest source-path and
  generated-index normalization; they are historical and do not establish a
  current build, Tools-host binding, or phase acceptance. The current generated
  index determines the record count; the older 147-record count is historical.
- The Playwright browser audit is the optional local browser-evidence lane. It
  covers all 29 Explore scenarios, the generated Specification index, all 47
  valid Product proposal routes at six viewports
  (1536x960, 1280x800, 1024x768, 768x1024, 390x844, and 320x640), the inline
  artifact-verification specialization, Verify, keyboard navigation, visible
  accessible names, console/page errors, and horizontal overflow. A previous run
  recorded 282 Product route/viewport observations and matching repeated
  fixed-viewport screenshot hashes. That run predates source-path and
  generated-index normalization and is historical; the browser audit must be
  rerun before making current browser claims. Pixel-reference conformance,
  screen-reader, zoom, forced-colors, independent visual review, and owner
  PDP-3 definitions remain unaccepted, and Explorer projection acceptance remains outstanding.
