# Ghatana Media — Remaining PDP-0–3 development-only tasks

**Date:** 2026-10-12  
**Repo in scope:** `samujjwal/ghatana-media` ONLY; remote `main@5e6210088a91978f5e7eeb213e2f99f101a91155` was inspected.  
**Authority/approval:** [delegated Media owner review](../../.product-experience/reviews/2026-10-12-delegated-pdp-dev-owner-review.md), `MEDIA-PDP-DEV-OWNER-2026-10-12`.  
**Purpose:** finish/confirm all PDP **definition development** (PDP-0 Product Truth, PDP-1 Domain/Data, PDP-2 Design/Interface, PDP-3 Product Experience) with no runtime development, source migration, installed external contract publication, independent acceptance, physical-surface closure, Lifecycle evidence/receipts, convergence, CI gate or release requirement.

## Actual baseline and non-goals

All four recorded phase development gates are already `DEV_COMPLETE` with zero outstanding meaning IDs at their exact definition cuts. The existing records report 462 PDP-0 capability leaves, 462 PDP-1 capability-operation/binding identities (448 canonical operation schemas plus 14 bindings), 79 owner-action wire contracts, 31 PDP-2 component families, and 47 PDP-3 screens / 30 journeys / 130 steps. The current physical applicability baseline has 26 manifest candidates, 17 consumer records, and seven compositions (root + six semantic). The missing 47th root screen was already repaired and an exact-set regression already exists; do not repeat that task.

`docs/implementation/post-pdp-current-status.json` reports PDP-0, PDP-1 and PDP-2 post-cut source references as stale while PDP-3 is current. This is **not** evidence that all semantics are incomplete: PDP-0's stale files are source/projection/status observations, PDP-1's are a strict-parity tool and tests, and PDP-2's is an Explorer index. Classify exact deltas and preserve historical phase truth rather than arbitrarily rerunning an entire program.

The latest implementer report says both `ghatana` runtime and `ghatana-media` working trees contain **uncommitted** changes; these are not visible from the remote GitHub source used in this review. The reported full Node run was 1,465/1,466, with later focused reruns passing after an observation refresh. Do not call the full suite green without an actual rerun. A multimodal Gradle compile failure is **not a PDP definition task**; do not edit or skip runtime Gradle modules under this mandate.

**Do not work on:** `RUN-01…RUN-10`, `DEP-01…04` publication or cross-repo acceptance, `MIG-01…04` transfer/cutover, `ACC-01…03` independent certification, `LC-01/02`, `REL-01/02`, actual processing engines/scanners/providers, PostgreSQL/outbox proof, media delivery, CLI execution, full browser or live product journeys. These are separate post-definition programs. Their status may stay openly `NOT_ADMITTED` / `PENDING_EXTERNAL` without blocking development completion.

## Definition of DEV_COMPLETE for this scope

A phase is development-complete when every applicable authored record has an exact, internally consistent owner definition and necessary cross-phase reference; unsupported/unselected execution capability is explicitly typed, not claimed live; there are no undispositioned meaning IDs; the appropriate source tests/projections pass for that recorded cut; and Media engineering/product ownership is reviewed. Never substitute simulation, implementation artifacts, source presence, runtime tests, external certification or a fake receipt for semantics. The product does not need a real host, deployed backend, provider credentials or migrated source to define the complete target experience.

For *physical leaves*, attach the relevant PDP references and applicability to the actual code/package surface; avoid duplicating root canonical YAML. For *semantic compositions*, author only new direct cross-child integration meaning and aggregate child references; do not duplicate leaf records. For a CLI-only, API-only, SDK-only, event or Agent Tool surface, PDP-2/3 consists of machine interaction/error/finality/conformance *definitions*, not fictitious GUI screens.

## Remaining actions — exact what / where / how / acceptance

### A. Current source and owner-controlled definitions

**PDP-D01 — Reconcile actual Media source cut, without another repository.**  
- **Where:** `.product-experience/`, `docs/implementation/pdp-{0,1,2,3}-phase-dev-status.json`, `docs/implementation/post-pdp-current-status.json`, `docs/implementation/post-pdp-task-dispositions-2026-10-12.md`.  
- **How:** On the implementer's actual local checkout, enumerate `git status --short` and `git diff` limited to this repo. Identify all new/changed **normative** PDP YAML, generated-only material, tests, visual preview code, or unrelated runtime mirrors. Review deltas relative to the four recorded phase cuts. Partition changes into `NORMATIVE_MEANING_CHANGE`, `REFERENCE/APPLICABILITY_CORRECTION`, `PROJECTION_ONLY`, `TEST_ONLY`, `EXTERNAL_OBSERVATION_ONLY`. Cite exact paths/IDs. No `ghatana` changes in this task.  
- **Exit:** A deterministic current source-cut classification with zero unclassified Media PDP edits; changes in local-only files are not represented as GitHub-reviewed until available.

**PDP-D02 — Reaffirm, do not overwrite, completed phase authority.**  
- **Where:** `.product-experience/decision-log.md`, `.product-experience/acceptance.yaml`, `.product-experience/reviews/`, phase status files.  
- **How:** Apply the linked delegated owner decisions to Media development source, preserving existing PXD-001…PXD-161 decisions and all source IDs. Only write additional per-record PXD decisions for *new substantive meaning* that is not already decided. Preserve prior `DEV_COMPLETE` and immutable source hashes; if a new material semantic cut exists, create a successor versioned review/cut with exact affected IDs and check that phase. Record "Media product owner development scope approved" separately from "independently accepted/certified", which remains unasserted.  
- **Exit:** Every new normative decision has one accountable Media owner, one canonical source location, and an explicit accepted/corrected/excluded outcome; no fabricated external approval.

### B. PDP-0 — Product Truth

**PDP-D03 — Exact capability/requirement/channel ownership sweep (review; repair only counterexamples).**  
- **Where:** `.product-experience/pdp-0-product-truth/capabilities.yaml`, `capability-leaf-review.yaml`, `requirements.yaml`, `applications-channels.yaml`, `profile-semantics.yaml`, `goals-jtbd.yaml`, `policy-authority-model.yaml`, `dependency-contracts.yaml`, `.product-experience/surfaces/media-physical-topology.v1.json`.  
- **How:** For each of the 462 stable leaves, ensure an explicit selected/conditional/excluded *product* meaning, initiating actor/intent/outcome, normative requirement, source/version or relevant quality/profile bounds, chosen GUI/machine channel applicability, and physical/composite *reference* where applicable. Verify unique semantic owner (generic OCR belongs to Document Intelligence; generic model routing to AI Inference; Shared owns reusable primitives). Check a sampling of cross-cutting negative semantics: stale artifact, revoked rights/consent, no qualified provider, unknown external finality. Do not invent numeric success, license, language or codec support. Preserve historical migration claim decisions without authorizing migration.  
- **Exit:** Exact 462-ID equality and no missing semantic owner/reference on applicable surface groups; no capability deleted to make a denominator green. No P0 normative rework if source checker already proves this.

**PDP-D04 — Confirm product-wide vs composition-local boundary.**  
- **Where:** `.product-experience/pdp-0-product-truth/{information-architecture,goals-jtbd,requirements,capabilities}.yaml` and topology `compositions[].phaseApplicability["PDP-0"]`.  
- **How:** Keep global outcomes, policy and capability identity at PDP-0 root; for each of six semantic compositions retain only its source-justified direct cross-child user value/constraints and links to root IDs. A pure support/test module can be `NOT_APPLICABLE_SUPPORT`; a host-dependent UI package can be `APPLICABLE` without claiming deployment. A multi-channel product requirement does not become a GUI-only requirement.  
- **Exit:** No root/leaf duplicated canonical requirements; each cross-child contract is exact and inspectable, not a blanket inheritance guess.

### C. PDP-1 — Domain and Data

**PDP-D05 — Accept exact logical operations and guards, not runtime endpoints.**  
- **Where:** `.product-experience/pdp-1-domain-data/{operations,owner-action-wire-contracts,domain-objects,states,transitions,transition-guard-contracts,events,privacy,versioning,provenance,relationships}.yaml`; `operations-current-source-review.json`; `.product-experience/interface-parity/`.  
- **How:** Review exact 448 canonical operation schemas, 14 capability bindings, 79 owner-action wire records, typed result variants, 55 state transition guards and tenant/rights/version/finality meaning. Every logical operation must have canonical intent, request/result shapes, authorization and precondition, mutation/read classification, idempotency/recovery, trusted input vs owner-resolved facts and clear `UNKNOWN` consequences. Distinguish a source-defined contract from a publicly admitted endpoint. Repair an actual contradictory YAML selector or missing decision; do not build a service or mechanically turn proposals into runtime admission.  
- **Exit:** No undefined normative meaning ID; source-only parity and cross-phase selectors agree; external transport contracts remain explicitly proposal/`NOT_ADMITTED` where warranted.

**PDP-D06 — Correct the contract-parity *development* interpretation.**  
- **Where:** `scripts/check-media-contract-parity.mjs`, `.product-experience/pdp-1-domain-data/operations.yaml`, `.product-experience/pdp-3-product-experience/agent-tools/runtime-dispositions.json`, `tests/media-contract-parity*.test.mjs`.  
- **How:** Preserve the recorded 47 strict source findings and the honest one owner/runtime-bound PDP-1 operation acceptance finding. Preserve all four Agent Tools as `NOT_ADMITTED` because actual handler execution request/results are dynamic and no complete typed public adapter is accepted. Definition-only parity must verify exact logical/typed source joins and deliberate non-admission. **Do not** require strict deployed-operation parity to pass before definition completion; **do not** clear strict findings by changing labels or inventing owners. Include a distinct, inspectable `DEFINITION_DEV_PASS` versus `RUNTIME_BINDING_PENDING` result if a current report incorrectly treats them as one status.  
- **Exit:** Definition-only check green; strict report honestly records its one non-development gate; no fake executable Agent Tools or removed findings.

### D. PDP-2 — Design and interface system

**PDP-D07 — Fix React AI Voice physical PDP-2 applicability (source defect).**  
- **Where:** `.product-experience/surfaces/media-physical-topology.v1.json` → `media.physical.modules-intelligence-ai-voice-libs-ai-voice-ui-react.phaseApplicability["PDP-2"]`; `modules/intelligence/ai-voice/libs/ai-voice-ui-react/package.json` and `src/index.ts`; `.product-experience/pdp-2-design-interface-system/{component-contracts,component-value-types,interface-grammar}.yaml` and `gui/`; `tests/media-physical-topology.test.mjs`.  
- **How:** It exports real React components (`PhraseTimeline`, `Waveform`, `VoiceProductionWorkflow`) and is referenced from `media.surface.ui-library`, yet is classified `HEADLESS_CONTRACT` with a service-only rationale. Change to a justified GUI-library/host-dependent UI applicability referencing the existing PDP-2 GUI grammar. Narrowly review its PDP-0 applicability too: a React component package does not prove that every selected speech-synthesis processing leaf is an implemented UI action. Preserve lack of host availability and public Shared admission.  
- **Exit:** PDP-2 GUI/host classification matches package reality, canonical refs resolve and a negative topology test rejects a GUI package mislabeled headless.

**PDP-D08 — Verify reusable GUI and headless grammar completeness without implementation.**  
- **Where:** `.product-experience/pdp-2-design-interface-system/{DESIGN-LANGUAGE.md,component-contracts.yaml,component-value-types.yaml,media-token-aliases.yaml,interface-grammar.yaml,accessibility.yaml,localization-content.yaml,semantic-state-grammar.yaml,action-finality-grammar.yaml,gui/,api/,cli/,sdk/,events/,agent-tools/}`.  
- **How:** Check the existing 31 component families, 13 templates, 11 layouts, 13 recipes, 42 composition rules and 19 interaction patterns against product requirements. Ensure keyboard, focus, responsive/zoom, forced-colors, reduced motion, language/RTL applicability, density/progressive disclosure, timing/uncertainty/finality, consent, safe cancellation and revision comparison are specified centrally where applicable. For API/CLI/SDK/event/Agent, bind typed request/result/error, pagination/watch, authentication and unknown/reconciliation grammar without suggesting a visible screen or installed adapter. The Shared package is an external *implementation* dependency, not a requirement to recreate its UI primitives here.  
- **Exit:** Exact source-only design validator passes; no unexplained component/route/interaction grammar gaps. No screenshots, independent AT review or live browser are demanded for dev-complete source semantics.

### E. PDP-3 — Complete product experience

**PDP-D09 — Reconfirm all 47 screen and 30 journey definitions against exact sources.**  
- **Where:** `.product-experience/pdp-3-product-experience/{screen-registry,journey-registry,action-registry,journey-purpose-bindings,journey-scenario-bindings,step-definition-oracles,step-version-binding-contracts,view-state-binding-dispositions,public-effect-finality-taxonomy,recovery-finality-contracts}.yaml`; `screen-contracts/`; `journey-contracts/`.  
- **How:** Assert exact 47 screen IDs, 30 journey IDs and 130 ordered steps, each with initiating actor and outcome, navigation/source/version references, action/operation intent, observable success/denial/unknown/recovery, and current vs stale read semantics. Keep 26 unseeded journeys as explicitly bounded definition oracles rather than inventing provider receipts or 26 rich fixtures. Preserve J-01, J-02, J-20 and J-03 as *designed* paths; do not implement their runtime or client functionality as a PDP task. Ensure `media.view.review-workspace-settings` remains in exact root PDP-3 topology coverage.  
- **Exit:** Stable ID/step set equality, no missing source or outcome oracle, exact current source projections, and no unsupported path marked `LIVE_IMPLEMENTED`.

**PDP-D10 — Cover all machine/product interfaces as experiences, not simulated successes.**  
- **Where:** `.product-experience/pdp-3-product-experience/{api/,grpc/,cli/,sdk/,events/,agent-tools/,capability-invocation-adapters.yaml,application-channel-registry.yaml,handoff-bindings.yaml}` and `.product-experience/interface-parity/`.  
- **How:** Confirm that each applicable declared operation is inspectable as an API, gRPC, SDK, CLI, Agent or event interaction definition; bind stable ID, inputs/outputs, trusted auth, request receipt vs side-effect vs final consumer observation, typed failures, limitations and explicit `NOT_ADMITTED`. Keep four Agent Tool handlers unsupported until public runtime mapping. If there is no GUI, the UI screen census must not be expanded to fabricate one. Do not require all target endpoints to be implemented as part of PDP-3 definition development.  
- **Exit:** Source-exact channel crosswalk, no phantom endpoints or fabricated finality, no missing required headless experience definition.

### F. Physical/composition aggregation, Explorer, and final verification

**PDP-D11 — Correct the Agent Tool physical owner/source crosswalk (source defect).**  
- **Where:** `.product-experience/surfaces/media-physical-topology.v1.json` → `consumerCrosswalk[media.surface.agent-tools]`, the `manifestCandidates` record for `libs/common` and its bidirectional `consumerSurfaceRefs`; `.product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml`; `tests/media-physical-topology.test.mjs`.  
- **How:** Four observed handlers are in `libs/common/src/main/java/com/ghatana/audio/video/tools/`, whereas the consumer crosswalk presently points only to `runtime-contracts`. Add a source-observation link to the existing `media.physical.libs-common` subsumed candidate (or an equally exact source-owned observed-handler binding) while retaining `runtime-contracts` as its logical contract association. Explicitly mark handler code `LEGACY/SUBSUMED/NOT_ADMITTED`; do not promote it to an independent deployed service or copy it into a new product framework. Update reverse refs and checker tests together.  
- **Exit:** Every observed Agent Tool handler resolves to its real source owner and canonical operation *candidate*; none becomes executable by this mapping.

**PDP-D12 — Recheck six compositions, all physical phase applicability and 17 consumers.**  
- **Where:** `.product-experience/surfaces/media-physical-topology.v1.json`, `.product-experience/surface-registry.yaml`, `scripts/check-media-physical-topology.mjs`, `tests/media-physical-topology.test.mjs`.  
- **How:** Compare exact source/manifest sets; all 26 physical candidates and 17 consumer records must have stable identities and real path/contract references. Review four PDP applicability cells on every applicable physical surface and one root + six semantic nodes; check `CONTAINS` vs `DEPENDS_ON`, duplicate physical membership, headless vs graphical semantics, and direct cross-child integration obligations. Keep the established root 47/30 census and reject same-count swaps, orphaned consumer refs and non-existent paths. Author phase records by reference at leaves; do not copy root Product Truth into every module.  
- **Exit:** Source-backed, unique/complete/deduplicated topology and phase references; existing checker, focused topology and negative regression tests pass.

**PDP-D13 — Preserve source-only Experience Explorer of all applicable surfaces.**  
- **Where:** `apps/media-experience-explorer/src/{physical-topology.ts,main.ts,lifecycle-pack-adapter.js,product-review.tsx}`, `.product-experience/surfaces/`, `tests/media-explorer-physical-topology.test.mjs` and `tests/media-explorer-lifecycle-pack-adapter.test.mjs`.  
- **How:** From repository root to compositions to physical leaves, show exact PDP0-3 sources, defined product channels, non-GUI machine interfaces, safe source-linked preview and explicit absent/unavailable labels. Never render a contract preview as deployed. Reuse existing renderer and source candidates; do not build a second Explorer or wait for a published Lifecycle package. The Lifecycle candidate adapter may remain `TEST_ONLY`.  
- **Exit:** Source navigation and product-definition inspection with stable deep links and no fabricated live operation, phase acceptance, receipt, or requirement to activate external tools.

**PDP-D14 — Regenerate/check only affected product projections and phase tests.**  
- **Where:** `scripts/{check-media-physical-topology.mjs,generate-media-phase-projections.mjs,generate-media-pdp3-implementation-handoff.mjs,generate-media-post-pdp-status.mjs,report-media-pdp-readiness.mjs,check-media-contract-parity.mjs}`; `docs/implementation/pdp-{0,1,2,3}-phase-dev-status.json`.  
- **How:** Complete Media source changes, then run targeted tests for D03–D13 and `node scripts/check-media-physical-topology.mjs`, `node scripts/check-media-contract-parity.mjs --definition-only`, `node scripts/generate-media-phase-projections.mjs --check --strict`, `node scripts/generate-media-pdp3-implementation-handoff.mjs --check`, `node scripts/generate-media-post-pdp-status.mjs --check --strict`. If a phase's *normative* content actually changed, use `node scripts/report-media-pdp-readiness.mjs --verify --phase-dev-status=PDP-N --write` for that phase; do not bulk rewrite historical SHA sets after a mere projection change. If a full Node run is claimed, rerun it unfiltered on the new stable source cut, not merely 14 targeted follow-ups. Preserve P0-03's 51 pass/10 skip truth unless a new run changes it. No Gradle compile/CI is a PDP source gate.  
- **Exit:** Zero actual PDP-definition regressions; latest source delta is classified, affected phase checks pass, historic cuts remain intact, current projection is honest and reproducible.

**PDP-D15 — Record final scoped Media development disposition.**  
- **Where:** This owner-review packet, `.product-experience/reviews/`, `docs/implementation/post-pdp-current-status.json` and a short new cut-specific status note if needed; no false change to `acceptance.yaml`.  
- **How:** Report each of PDP-0…PDP-3 as (1) `DEV_COMPLETE` at recorded definition cut; (2) `CURRENT_SOURCE_REVIEWED` only if exact current source was inspected and tested; (3) owner semantic decision with scope and affected IDs; (4) external admission explicitly separate. Record any unresolved exact Media meaning ID as a **real development blocker** with a prescriptive source repair, not a generic request for approvals. The source-owner decision above already authorizes the two known topology corrections; no new confirmation round is needed.  
- **Exit:** Four separate truthful development-complete declarations, zero outstanding semantic development issues for the reviewed cut, an explicit minimal list (possibly empty) of remaining PDP source changes, and **no** artificial dependency on runtime, migration, certification, closure, evidence or convergence.

## Execution order / parallelism

**Batch A — Source truth and two concrete corrections:** D01, D02, D07, D11, D12. One writer owns `media-physical-topology.v1.json` and its checker; other reviewers inspect PDP-0/PDP-1 records. Finish the exact AI Voice GUI and Agent Tool source mapping fixes first.

**Batch B — Four phase semantic consistency checks:** D03–D06 and D08–D10. Parallelize PDP-0/PDP-1 review separately from PDP-2/PDP-3 review; use one integrator for shared registries and cross-phase references. Only edit a normative artifact when a specific counterexample exists.

**Batch C — Projection/explorer, final acceptance of development scope:** D13–D15. Run one focused source-only validation set and (only if changed scope warrants it) one full Node check. Record the source cut, distinctions and truthful final status; no broad runtime or closure work.

## Stopping rule

Stop when all four definition phases are source-complete and their affected checks pass, with no outstanding Media-owned *meaning* ID. **Do not** convert production scan/voice/legal authority, migration of 2,817 candidates, Shared/Ghatana/Lifecycle publication or final Event Plane receipts into prerequisites. Do not pursue actual STT/visual/generation runtime or undo unrelated local `ghatana` changes as part of this PDP-only assignment. A required authentic external approval remains preserved for its separate later claim, not falsely granted by this owner packet.
