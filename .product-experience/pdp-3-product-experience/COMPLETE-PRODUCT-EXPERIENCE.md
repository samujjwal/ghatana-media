# Media Product Experience Specification

**Authority:** PDP-3 proposal over PDP-0, PDP-1, and PDP-2\
**Acceptance:** proposal; depends on accepted PDP-2 and full experience review; no complete-experience acceptance is recorded\
**Development completion:** `docs/implementation/pdp-3-phase-dev-status.json` records all 10 criteria passing for the 47-screen/30-journey/130-step population, with strict current projections, valid schemas/public validators, and zero field-mapping blockers. The terminal cross-phase and full development suite are repository integration checks; they do not establish product-owner or independent acceptance, runtime admission, Lifecycle receipts or closure, or release qualification.\
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
contracts. All 30 journeys and 130 ordered steps have typed source-linked
definition semantics in the development projection. Explicit proposal,
unseeded-fixture, and unadmitted-channel dispositions remain visible in the
source records; they do not imply owner acceptance, callable API routes,
journey-wide CLI behavior, embedded-host behavior, or runtime admission.
All authored screen action intents now resolve to intent-based proposal action
references. A direct, source-checked action-capability-to-PDP-0 requirement
crosswalk exists for 21 of 47 screens and for all 18 action-bearing journey
steps; the other 26 screens have no direct action-capability requirement
crosswalk in the current registries. These are proposed references, not
semantic acceptance. Detailed action effects, authority, component
interactions, state transitions, and owner approval remain open. All 28
plan-baseline journey files are PDP-0-grounded proposals with ordered screen
references; J-29 and J-30 are explicit extension contracts. PXD-036 selects
exact intent, view, and screen-contract references for every J-29/J-30 step.
PXD-160 also defines an exact one-snapshot `QUERY` supporting observation for
J-29 step 02, including the source-owned session/version tuple; it does not
dispatch, replay, or admit a runtime route. Other unbound and conditional
references retain their explicit source dispositions. PXD-028 historically approved 41 exact top-level
template/layout links; PXD-037 reviewed the six remaining purposes and approved
five new central templates plus three layouts, bringing the definition mapping
to 47 of 47 screens. These links organize reusable Media screen composition
proposals; zero screen compositions are admitted, and Shared component/runtime
admission remains separate. The local
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
validator. Its current projection and mapping boundaries are listed below;
these checks do not constitute product-owner acceptance or runtime admission.

## Reading the specification

- `screen-registry.yaml` indexes the 47 canonical screen denominator with
  intent-based Media IDs; `screen-contracts/` also retains the separate
  artifact-verification job-family specialization file.
- `screen-contracts/` contains source-derived contracts for all 47 canonical
  screens. Capability and requirement references are checked against the
  Action Registry and PDP-0; unresolved operation/effect, domain-state, and
  behavioral-oracle links remain proposal-only. Full behavior binding, owner
  review, and acceptance remain pending.
- `journey-contracts/` contains the 28 plan-baseline journeys plus J-29/J-30
  extension contracts (30 total). The development projection resolves all 130
  typed step-oracle definitions and preserves exact action, operation,
  authority, state, transition, and fixture dispositions where each applies.
  Remaining source-unbound identities and non-executable proposals are explicit;
  source projection does not certify provider, host, or runtime behavior.
- Registries and bindings define action identity, component interactions,
  state projection, CLI/API parity, realistic synthetic scenarios, and recovery.
- `scenario-fixture-registry.yaml` references PDP-3 fixture content; it does
  not duplicate fixture payloads.
- `generated/experience-specification.candidate.json` is a structurally valid
  candidate that passes the available public validator. It projects 31
  component contracts, 47 views, 30 journey records with 130 of 130 source steps,
  20 interactions, 428 states, 1 transition, 147 actions, 145 effects, 145
  finality candidates, 5 recovery records, 31 scenarios and fixture descriptors,
  3 search definitions, and 5 inspection definitions. Its current
  `fieldMappingBlockers` is empty; all 130 steps resolve typed semantics from
  the exact step-oracle source. Four of 30 journeys carry 31 source scenario
  references; the other 26 are explicitly unseeded. The unknown-outcome corpus
  records 59 source binding occurrences across 48 distinct journey/step/
  operation bindings. Candidate dispositions retain the distinction between
  definition projection, unadmitted shared handoffs, and runtime behavior. The
  candidate passes schema and public validator checks, while `acceptance` is
  `NOT_CLAIMED` and `currentness` remains under Lifecycle authority.
  PXD-052 supplies the exact public mapping for all five existing manual recovery
  records and one immutable project-reference effect/finality definition. Conditional
  upload reversal and unknown read reversibility remain explicitly unprojected; no
  executable recovery or canonical attachment operation is admitted.
  PXD-058 through PXD-061 define only J-03 steps 7 and 8: immutable caption
  registration and exact-pair comparison, including same-request reconciliation.
  Registration is separate from review approval; internal provenance is not export.
  UNKNOWN comparison reversibility remains unprojected. The first six J-03 steps
  retained their prior definitions in that caption batch. PXD-062 through PXD-065
  now define only existing J03-4 exact transcript-version inspection, preserving
  missing timing and supplied uncertainty, with no approval or new processing.
  PXD-066 through PXD-069 now define existing J03-5/6 session-local correction
  and manual tick alignment, including guarded revisions, undo and new-identity
  rebase. Manual timing does not satisfy forced alignment. PXD-070 through
  PXD-073, with the current J03-2 decision at PXD-159, define audio request
  acceptance and same-key receipt recovery; a receipt does not assert
  recognition completion or a canonical job state. J03-1 still carries exact
  source context only: there is no source-picker operation and source selection
  validity is unresolved. J03-3 has a read-only current-job/attempt observation
  definition, but it is not runtime-admitted or bound as an executable J03-2
  recovery step. Runtime verification remains not-run.
  Four J-29 step intents and all eight J-29/J-30 step-view links are explicit
  Media owner selections from the source intent and view inventories. The J-29
  PXD-160 query is a supporting read only; the journey remains single-snapshot,
  with no dispatch or automatic recovery. Empty `transitionRefs` arrays remain
  schema placeholders where the source provides no applicable transition.
  Candidate projection does not establish full PDP-3 acceptance, independent
  review, runtime admission, or Lifecycle currentness and closure.

The reviewed plan's legacy `M-*` view IDs remain crosswalk references. New
view, action, CLI-command, and scenario identifiers follow the canonical
naming policy in PDP-0 `glossary.yaml`; their human-readable labels describe
the user's outcome or next action. No provider, model, or codec appears in the
ordinary workflow.

## Phase status

The PDP-3 development gate is `DEV_COMPLETE`; its 10 criteria, source cut, and
strict current projection are pinned in the phase status artifact. That status
is not product-owner acceptance or an acceptance-gate receipt. The generated
candidate remains a definition projection, not a runtime or release artifact.
J-01 and J-02 have baseline-view and journey contracts; J-20 has a
transcription job-state slice; the selected audio slice of J-03 has lane-specific
contracts. Owner acceptance, independent review, external channel admission,
runtime proof, and Lifecycle evidence remain separate gates.

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

PXD-028 historically approved 41 top-level links and withheld six mismatches.
PXD-037 selects exact purpose-matched central catalog links for the remaining
six, completing the 47-screen source mapping. Both decisions concern top-level
template/layout identities only; no screen composition or per-screen recipe
binding is admitted.

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
