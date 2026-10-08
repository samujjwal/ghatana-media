# Media Product Experience Specification

**Authority:** PDP-3 proposal over PDP-0, PDP-1, and PDP-2\
**Acceptance:** proposal; depends on accepted PDP-2 and full experience review; no complete-experience acceptance is recorded\
**Detailed work slices:** J-01 project setup, J-02 artifact intake, J-20 job observation/recovery, and `media.lane.transcribe-and-correct-captions`
**Lane media scope:** Audio sources only; video audio-extraction and source-time mapping are outside this slice of J-03.

PDP-3 specifies user-visible consequences independently of Explorer code.
The canonical meaning remains in PDP-0/PDP-1; reusable presentation rules
remain in PDP-2. The registries index all 47 canonical screens and all 30
journeys. J-01 has a proposal journey contract with five supporting
view fragments. J-02 has a proposal contract with five artifact/job view
fragments, seven metadata-only upload payloads, and three synthetic
verification-job payloads implemented in PDP-3. J-20 adds a proposed
transcription-job observation, cancellation, and policy-gated retry path through
the shared `media.view.job-status` contract; owner job-runtime bindings remain
unbound. Retry requires a classified retryable attempt and fresh authority,
policy, and budget checks; the local fixture CLI does not execute it.
J-03 retains its audio-only lane contract. J-29 and J-30 are explicit extension
contracts. These do not close the full screen denominator: complete
action/state/scenario/channel coverage across the 28 plan-baseline journeys and
active J-29/J-30 extensions (30 total), API wire
bindings, journey-wide CLI behavior, and embedded-host behavior remain open.
All authored screen action intents now resolve to intent-based proposal action
references. A direct, source-checked action-capability-to-PDP-0 requirement
crosswalk exists for 21 of 47 screens and for all 18 action-bearing journey
steps; the other 26 screens have no direct action-capability requirement
crosswalk in the current registries. These are proposed references, not
semantic acceptance. Detailed action effects, authority, component
interactions, state transitions, and owner approval remain open. The 24 added journey files are
PDP-0-grounded proposals with ordered screen references, not complete or
accepted contracts. The local
CLI covers selected J-02 upload inspection/resume, existing-job status viewing and
outcome checking, and J-20 transcription-job cancellation through the shared
reducer; the proposed retry command is not implemented in the fixture CLI. The
CLI does not transfer file bytes or watch a live job stream.

## Detailed outcome

A creator or editor selects an authorized audio source version, requests speech
recognition when consent and policy allow it, reviews recognized text and its
timing, corrects caption text or timing, and commits a new immutable caption
version. The original source remains unchanged. Recognition uncertainty,
missing alignment, consent revocation, and unknown remote finality are explicit
states with safe next actions.

The lane uses `media.goal.understand-media`, `media.goal.review-trustworthy-output`,
`media.intent.understand`, and PDP-0 journey `J-03`. It does not claim a
supported locale, a callable wire route, provider availability, or a qualified
runtime. API wire bindings remain open under `GAP-05`; complete Tools validation
and Explorer bindings remain open under `GAP-MEDIA-TOOLS-SCHEMA-BINDING` and
`GAP-11`. The generated ExperienceSpecification v1
(`ghatana.experience-specification.v1`) candidate passes structural schema
validation and the available public `@ghatana/experience-specification`
validator. It still reports ten
semantic field blockers and does not constitute full PDP-3 validation or
acceptance.

## Reading the specification

- `screen-registry.yaml` indexes the 47 canonical screen denominator with
  intent-based Media IDs; `screen-contracts/` also retains the separate
  artifact-verification job-family specialization file.
- `screen-contracts/` contains source-derived contracts for all 47 canonical
  screens. Capability and requirement references are checked against the
  Action Registry and PDP-0; unresolved operation/effect, domain-state, and
  behavioral-oracle links remain proposal-only. Full behavior binding, owner
  review, and acceptance remain pending.
- `journey-contracts/` contains proposals for the 28 plan-baseline journeys
  plus active J-29/J-30 extension contracts (30 total). The baseline proposals
  record PDP-0 outcomes and ordered screen references. Direct capability and
  requirement references resolve for 18 of 18 action-bearing steps across the
  four authored action-bearing journey contracts; canonical operation/state,
  oracle/fixture, scenario/channel, and owner-review bindings remain incomplete.
- Registries and bindings define action identity, component interactions,
  state projection, CLI/API parity, realistic synthetic scenarios, and recovery.
- `scenario-fixture-registry.yaml` references PDP-3 fixture content; it does
  not duplicate fixture payloads.
- `generated/experience-specification.candidate.json` is a schema-valid
  candidate that passes its available public validator. It projects 30
  component contracts, 47 views, 0 schema-shaped journeys, 20 interactions,
  49 states, 0 transitions, 146 actions, 0 effects, 18 finality candidates,
  0 recovery records, 14 scenarios, 14 fixture descriptors, 3 search
  definitions, and 5 inspection definitions. Its ten semantic blockers are
  `componentContracts`, `views`,
  `journeys`, `transitions`, `actions`, `effects`, `finality`, `recovery`,
  `scenarios`, and `fixtures`; the file records exact reasons and source refs.
  In particular, no schema-shaped journey is emitted from the 30 journey
  contracts because actor/step mappings remain partial, and action/effect/state
  links remain proposals. The validator pass does not imply a complete
  ExperienceSpecification, owner acceptance, independent review, or Lifecycle
  currentness.

The reviewed plan's legacy `M-*` view IDs remain crosswalk references. New
view, action, CLI-command, and scenario identifiers follow the canonical
naming policy in PDP-0 `glossary.yaml`; their human-readable labels describe
the user's outcome or next action. No provider, model, or codec appears in the
ordinary workflow.

## Phase status

All records are proposals that require upstream acceptance and role review.
The registries expose the full view and journey denominator. J-01 and J-02
have partial baseline-view and journey contracts; J-20 has a transcription
job-state slice; the selected audio slice of J-03 has lane-specific contracts.
The full baseline-view denominator is authored, while complete journey,
channel, action, state, copy, fixture, and owner-review coverage remains an
explicit completion gap. This work does not pass
the PDP-3 acceptance gate.

## Authority, dependencies, review, and proof

The complete PDP-3 artifact inventory and stable IDs are indexed by
[`../source-manifest.yaml`](../source-manifest.yaml) and
[`../artifact-identities.yaml`](../artifact-identities.yaml). The primary
registries are `screen-registry.yaml`, `journey-registry.yaml`,
`action-registry.yaml`, `interaction-registry.yaml`,
`application-channel-registry.yaml`, `scenario-fixture-registry.yaml`,
`data-view-contracts.yaml`, `state-transition-bindings.yaml`,
`recovery-finality-contracts.yaml`, `responsive-variants.yaml`,
`navigation-contracts.yaml`, `search-inspection-contracts.yaml`, and
`experience-source-bindings.yaml`. API, CLI, gRPC, event, and Agent Tool
surfaces are indexed in their respective registries and binding files; detailed
screen and journey proposals remain in `screen-contracts/` and
`journey-contracts/`.

PDP-3 depends on accepted PDP-2; upstream source and dependency boundaries are
in [`../authority-map.yaml`](../authority-map.yaml),
[`../traceability.yaml`](../traceability.yaml),
[`../gaps.yaml`](../gaps.yaml), and
[`../acceptance.yaml`](../acceptance.yaml) (`ACCEPT-INPUT-PDP-3`). Its named
review roles are UX information architect, product UX/distributed-systems
analyst, generation/editing/quality experience lead, animation/simulation/
domain-integration architect, audio/speech/streaming experience lead, and
API/SDK/CLI contract owner. P0-010, independent experience review, Shared/Tools
publication and validation, external owner decisions, and Lifecycle evidence
remain separate pending gates.

Current local proof inputs include
`tests/pdp-3-screen-journey-crosslinks.test.mjs`,
`tests/pdp-2-experience-language-projection.test.mjs`,
`tests/product-definition-authority.test.mjs`,
`pnpm check:product-experience-local`, and
`node ../../scripts/generate-media-phase-projections.mjs --check --strict`.
These checks validate source structure and available public schemas; they do
not establish semantic acceptance, execution behavior, independent review,
or Lifecycle currentness/receipts.
