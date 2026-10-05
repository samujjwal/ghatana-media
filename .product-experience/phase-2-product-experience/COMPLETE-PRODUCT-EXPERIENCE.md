# Media Product Experience Specification

**Authority:** Phase 2 proposal over Phase 0 and Phase 1\
**Acceptance:** blocked on P0-010 and P1-006; no complete-experience acceptance is recorded\
**Detailed work slices:** J-01 project setup, J-02 artifact intake, J-20 job observation/recovery, and `media.lane.transcribe-and-correct-captions`
**Lane media scope:** Audio sources only; video audio-extraction and source-time mapping are outside this slice of J-03.

Phase 2 specifies user-visible consequences independently of Explorer code.
The canonical meaning remains in Phase 0; reusable presentation rules remain
in Phase 1. The registries index all 41 planned baseline views and all 30
Phase 0 journeys. J-01 has a proposal journey contract with five supporting
view fragments. J-02 has a proposal contract with five artifact/job view
fragments, seven metadata-only upload payloads, and three synthetic
verification-job payloads implemented in Phase 3. J-20 adds a proposed
transcription-job observation, cancellation, and policy-gated retry path through
the shared `media.view.job-status` contract; owner job-runtime bindings remain
unbound. Retry requires a classified retryable attempt and fresh authority,
policy, and budget checks; the local fixture CLI does not execute it.
J-03 retains its audio-only lane contract with six lane-specific view
specializations. These do not close the full screen denominator:
complete contracts for all 41 baseline views, full action/state/scenario/channel coverage across the 28 required journeys, API wire bindings, journey-wide CLI behavior, and embedded-host behavior remain open. All authored screen action intents now resolve to intent-based proposal action references; detailed action effects, authority, component interactions, state transitions, and owner approval remain open. The 24 added journey files are Phase 0-grounded proposals with ordered screen references, not complete or accepted contracts. The local
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
`media.intent.understand`, and Phase 0 journey `J-03`. It does not claim a
supported locale, a callable wire route, provider availability, or a qualified
runtime. API wire bindings remain open under `GAP-05`; Tools validation and
Explorer bindings remain open under `GAP-MEDIA-TOOLS-SCHEMA-BINDING` and
`GAP-11`.

## Reading the specification

- `screen-registry.yaml` indexes the complete baseline view denominator with
  intent-based Media IDs and keeps the six selected-lane views as contextual
  specializations.
- `screen-contracts/` contains six selected-lane specializations, five J-01
  view fragments, five J-02 artifact/job view fragments, and a J-20 state-path
  contract for the shared job-status view; full contracts for all 41 baseline
  views remain pending.
- `journey-contracts/` contains proposals for J-01 project setup, J-02 artifact
  intake, J-20 transcription-job observation/recovery, and the selected audio
  slice of J-03. The 24 added journey proposals record Phase 0 outcomes and ordered screen references; all 28 journey files remain incomplete until action/state/scenario/channel bindings and owner review are complete.
- Registries and bindings define action identity, component interactions,
  state projection, CLI/API parity, realistic synthetic scenarios, and recovery.
- `scenario-fixture-registry.yaml` references Phase 3 fixture content; it does
  not duplicate fixture payloads.

The reviewed plan's legacy `M-*` view IDs remain crosswalk references. New
view, action, CLI-command, and scenario identifiers follow the canonical
naming policy in Phase 0 `glossary.yaml`; their human-readable labels describe
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
