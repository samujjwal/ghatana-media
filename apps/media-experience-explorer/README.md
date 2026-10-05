# Media Experience Explorer

This Media-owned browser client reviews deterministic first-use,
artifact-intake, verification-job, transcription-job, and transcript/caption simulations. It
provides Product, Explore, Specification, and Verify modes for these slices.
The in-browser terminal runs the registered synthetic `ghatana-media`
commands against the same fixture state and reducer. It is not the generic
`ghatana-tools` Explorer host and does not connect to the Media runtime, Shared
identity, a project service, or a processing provider.

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
define production format limits. The Phase 2 registries index 41 baseline views and 30 journeys (28
required by the master plan, plus two supplementary Phase 0 journeys). All 41 baseline
views have proposal contracts, and six selected-lane specializations are indexed. All 28 required journeys have proposal files: four retain scoped J-01/J-02/J-03/J-20 slices, and 24 add Phase 0-grounded outcomes and ordered screen paths. All authored screen action intents now resolve to intent-based proposal action references, including intent-derived registry entries. Complete action semantics, capability authority, component interactions, state transitions, copy, fixtures, wire/channel bindings, and owner review remain open.

Specification mode indexes all 146 source records, including all 41 baseline view
contracts and six selected-lane view specializations. It renders the declared
purpose, context, anatomy, states, actions, channel dispositions, and responsive
and accessibility guidance as read-only proposal previews; actions are labeled
as not executable, and the source YAML remains available below each preview.
The record search filters by title and filename. These previews make the source
contracts inspectable without implementing their views or closing Phase 2 or 3
acceptance.
The browser client does not constitute
full Phase 3 acceptance or a `ghatana-tools` host binding. See the
[verification matrix](../../.product-experience/phase-3-experience-explorer/verification-matrix.yaml)
and [open gaps](../../.product-experience/gaps.yaml) for current evidence and
remaining owner reviews.
