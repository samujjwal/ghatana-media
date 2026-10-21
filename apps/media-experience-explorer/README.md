# Media Experience Explorer

This Media-owned browser client reviews deterministic first-use,
artifact-intake, verification-job, transcription-job, and transcript/caption simulations. It
provides Product, Explore, Specification, Verify, and Tools Review modes for these slices.
The in-browser terminal runs the registered synthetic `ghatana-media`
commands against the same fixture state and reducer. It is not the generic
`ghatana-tools` Explorer host for its Product and Explore modes, and it does not
connect to the Media runtime, Shared identity, a project service, or a processing
provider.

## Two-pass demo recording — planned PDP-3 adoption

The target PDP-3 standard is to **record the actual frontend-only Explorer scenario with audible narration and synchronized captions using the deterministic, centrally mocked data**, then reuse the **same source-owned scenario, semantic beat IDs and narrative intent** in BUILD to record the real product's business flow. These are **two separate recordings**, with independent source/capture hashes, evidence, review and truth labels:

- `EXPLORER_SIMULATED`: record this app's real Product/Explore or headless view while its central synthetic fixtures run. Show a visible simulation disclosure and never claim login, upload, model execution, saved artifacts or real provider effects.
- `PRODUCT_EXECUTED`: later capture an actual authorized product host, verified state transitions and owner effect/terminal readbacks. Narration may describe a completed result only once actually observed; never reuse mock finality as business evidence.

The shared scenario belongs to the product's source-current PDP-0 through PDP-3 definitions; the generic recorder mechanics reuse the existing Gharbatai product-neutral recorder where qualified. PDP-3's **new proposed completion gate includes the actual Explorer video, voice track, captions and source-bound film manifest**, not just fixtures or a storyboarding proposal. BUILD's actual film and semantic parity report are separate evidence.

**Current status:** this is an implementation target, **not a recording that already exists**. This Explorer currently has richer seeded experience coverage for J-01/J-02/J-03/J-20, not verified narrated films across all 30 journeys. Do not treat source-only mock video as real runtime behavior or claim the stronger PDP-3 rule has been adopted retroactively.

See the [single canonical plan](../../docs/implementation/MEDIA-BUILD-IMPLEMENTATION-PLAN.md#5b-two-pass-pdp-3-explorer--build-product-recording-standard) and [first paired scenario recording profile](../../docs/implementation/MEDIA-EARLY-BUSINESS-DEMO-RECORDING.v1.json).

## Run locally

From the repository root, start the browser client with:

```sh
pnpm dlx vite@7.3.1 --config apps/media-experience-explorer/vite.config.mjs
```

To typecheck and build the simulation package before using its terminal
executable:

```sh
pnpm dlx --package typescript@6.0.3 tsc -p libs/media-experience-simulation/tsconfig.json
node libs/media-experience-simulation/bin/ghatana-media.mjs \
  --scenario media.scenario.job-outcome-unknown \
  ghatana-media job check-outcome \
  --job fixture-transcription-job-unknown \
  --format json
```

The executable reads and updates only the selected synthetic fixture. It does
not submit jobs, write to a Media service, or call an external provider.

## Current scope

The client opens in Explore mode. Product mode removes Explorer navigation and
is reachable from the product preview; browser history returns to the
workbench. Product mode renders three synthetic first-use routes for J-01,
three artifact-intake views plus one separate verification-job view for J-02,
and four transcript/caption view labels for the selected audio slice of J-03.
Its shared job-detail view covers J-02 verification jobs and J-20 transcription
jobs. Its CLI projection covers J-02 upload inspection and resume, verification
job status and outcome checking, and J-20 transcription-job status viewing,
cancellation, and outcome checking; it never transfers file bytes.
J-01 fixtures hide protected data when
identity or workspace authority is unavailable and keep uncertain project
creation bound to the same request. They do not authenticate users or create
production projects. The J-02 fixtures contain upload and verification-job
metadata only; they do not transfer files, contact an artifact service, or
define production format limits. The PDP-3 registries index 47 canonical screens,
one job-family specialization file, and 30 journeys (28 baseline proposals plus
J-29/J-30 extension contracts). All 47 canonical screens have source-derived
proposal contracts and all 28 baseline journeys have proposal files. All
authored screen action intents now resolve to intent-based proposal action
references, including intent-derived registry entries. Complete action
semantics, capability authority, component interactions, state transitions,
copy, fixtures, wire/channel bindings, and owner review remain open.

Specification mode indexes the generated source manifest and all 47 canonical
screen contracts plus the job-family specialization. It renders the declared
purpose, context, anatomy, states, actions, channel dispositions, and responsive
and accessibility guidance as read-only proposal previews; actions are labeled
as not executable, and the source YAML remains available below each preview.
The record search filters by title and filename. Each selected record also
exposes a deterministic Explorer projection ID, owning phase and authority
class, canonical location, semantic-fingerprint/currentness status, declared
relation authority, and verification status. Lifecycle-generated fingerprints
and currentness remain explicitly pending until their owner binding is available.
These previews make the source contracts inspectable without implementing their
views or closing PDP-2 or PDP-3 acceptance.

The Tools Review tab (`#tools-review`) loads the Media package binding and the
actual indexed Product Truth, domain, presentation, screen, journey, action, and
Explorer verification source files. It then loads the scoped Media package
adapter through the public `@ghatana/product-dev-explorer` API and exercises
render, inspect, and dispatch. The deterministic scenario state is explicitly
still a fixture projection. The route reports blockers, absent Lifecycle
currentness and owner acceptance, and raw source authorities; source presence
and package structure validation are not semantic acceptance. The existing
Product and Explore modes remain Media-owned review surfaces. This route does
not establish full PDP-3 acceptance, registry publication, normal workspace
lockfile resolution, or Lifecycle currentness. Product Truth YAML is not
presented as a canonical `ProductDefinition` instance because no such instance
is published in the Media source tree. PDP-2 template/layout bindings to PDP-3
screens remain proposals; candidate Shared screen bodies remain labeled
unadmitted.
The current Tools source contracts are recorded in
[`tools-binding.yaml`](../../.product-experience/explorer/tools-binding.yaml):
Product Definition, Experience Language, Experience Specification, Experience
Package, Explorer Contracts, the headless Product Dev Explorer library, and
Development Traceability. The packed consumer proof and dedicated browser review
route verify local source-snapshot consumption only. In particular, the headless
Explorer library is not itself this Media-owned Vite host, Development
Traceability projects source models but does not construct or resolve the graph,
and the named contracts do not prove Media phase-verification support or host
admission. Tools owner review and the Tools-owned runtime support gap remain
open. See the
[verification matrix](../../.product-experience/explorer/verification-matrix.yaml)
and [open gaps](../../.product-experience/gaps.yaml) for current evidence and
remaining owner reviews.

Run `pnpm check:product-experience-local` from the repository root for the
read-only local invariant check that backs the closure matrix.

Run `pnpm test:experience-browser` with the Vite preview active on port 4179 to
exercise all 29 scenarios, the generated source index, 47 valid Product proposal
routes, Verify, the inline artifact-verification specialization, the Tools Review
route, keyboard navigation, accessible names, and six responsive viewports. The audit writes
fixed-viewport screenshots and `report.json` to
`/tmp/media-experience-browser-audit` by default. A repeat run must produce
identical screenshot hashes. It is browser evidence for visual review, not a
human pixel-perfect approval or Lifecycle-owned acceptance receipt.
# Shared presentation review host

The Explorer mounts the public `@audio-video/ui/screens` exports for four candidate screen bodies through a local review adapter. The Vite aliases resolve those public import specifiers to repository source for local review, with the installed sibling Shared design-system build used only to make the candidate render. This does not admit the screens, qualify the published UI package, or establish a production Web surface. Every mounted screen is labeled **CANDIDATE · NOT ADMITTED** and receives synthetic simulation state and fixture actions.

Legacy Product renderer helpers in the Explorer are not the source for these candidate screens. Source-derived PDP-3 proposals remain read-only Specification previews.
