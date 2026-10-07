# Media Product Experience Specification

**Authority:** PDP-3 proposal over PDP-0, PDP-1, and PDP-2\
**Acceptance:** blocked on P0-010 and P1-006; no complete-experience acceptance is recorded\
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
references; detailed action effects, authority, component interactions, state
transitions, and owner approval remain open. The 24 added journey files are
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
`GAP-11`. A local generated candidate invokes available public schema and
validator contracts but fails closed on unresolved ExperienceDefinition fields
and owner references; it does not validate or accept the full PDP-3.

## Reading the specification

- `screen-registry.yaml` indexes the 47 canonical screen denominator with
  intent-based Media IDs; `screen-contracts/` also retains the separate
  artifact-verification job-family specialization file.
- `screen-contracts/` contains source-derived contracts for all 47 canonical
  screens. Full behavior binding, owner review, and acceptance remain pending.
- `journey-contracts/` contains proposals for the 28 plan-baseline journeys
  plus active J-29/J-30 extension contracts (30 total). The baseline proposals
  record PDP-0 outcomes and ordered screen references; all remain incomplete
  until the PDP3-005 per-step contract, action/state/scenario/channel bindings,
  and owner review are complete.
- Registries and bindings define action identity, component interactions,
  state projection, CLI/API parity, realistic synthetic scenarios, and recovery.
- `scenario-fixture-registry.yaml` references PDP-3 fixture content; it does
  not duplicate fixture payloads.
- `generated/experience-specification.candidate.json` records source hashes,
  observed identifiers, and a partial candidate subject/schema identity. The
  sibling schema and public validator report missing required model fields;
  external actor, outcome, guard, and context references remain unresolved.
  This generated candidate does not imply a complete ExperienceDefinition,
  acceptance, or Lifecycle currentness.

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
P2-008.
