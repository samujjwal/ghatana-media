> **Historical proposal / provenance record:** This dated plan is not current status, a product-definition source, or an active task queue. Use the [canonical PDP source index](../../.product-experience/README.md) for definitions and `pdp-0-phase-dev-status.json` through `pdp-3-phase-dev-status.json` in this directory for current phase status.

# Historical PDP-0 → PDP-1 → PDP-2 → PDP-3 Development Plan (October 9–11, 2026)

**Status:** Historical planning record only; not an active plan, task queue, or phase-status authority. Use the [canonical PDP source index](../../.product-experience/README.md) and its linked source-pinned phase status records for current work.
**Source review date:** 2026-10-09; **plan initially reconciled:** 2026-10-10; **execution ledger updated:** 2026-10-11. **Original review cut:** `bda45da41fc7b334aa8d20b7fafdea72da860d4c`. **Reconciliation baseline:** `5e138efbcef02c71e3255a57e2ee13b3179f49b5` (`main` and `origin/main` at that time).
**Primary repo:** `samujjwal/ghatana-media`. Implement required public contract fixes in their actual owning repository only if essential for *definition correctness*.  
**Scope:** PDP-0 Product Truth, PDP-1 Canonical Domain & Data, PDP-2 Design Language & Interfaces, PDP-3 Complete Product Experience. The Explorer is a consumer/projection, not a phase or independent project.

### Historical execution ledger — 2026-10-11 (reported all phases development-complete at that cut)

> **Historical source-cut note (2026-10-12):** The ledger below records the four
> `DEV_COMPLETE` phase-development results. It is not an independent acceptance
> or release result. The reviewed definition cut is `adc9aa6`; `0837fef` refreshed
> only the four phase status records and verification logs. See the generated
> [historical status projection](./post-pdp-current-status.json), which checked the
> exact recorded source pins and showed later working-tree differences by file.
> Post-PDP implementation, migration, external owner acceptance, Lifecycle
> receipts, production qualification, and release authorization remain separate.

This ledger records the development-only sequence reported at its historical cut. The evaluated checkout was based on `5e138efbcef02c71e3255a57e2ee13b3179f49b5`; the local PDP-1 source cut was recorded in `pdp-1-phase-dev-status.json`. Phase status artifacts are valid only for the exact source hashes they record.

| Order | Phase | State | Exit record / next step |
| --- | --- | --- | --- |
| 1 | PDP-0 — Product Truth | `DEV_COMPLETE`, frozen | `docs/implementation/pdp-0-phase-dev-status.json`; no PDP-0 work reopens without a material contract change |
| 2 | PDP-1 — Domain & Data | `DEV_COMPLETE`, re-frozen | The bounded material correction aligns `media.action.inspect-source` with both required guards: `exact-artifact-and-immutable-version-identity` and `current-read-authority`. The source-backed regression passes; P1-01..P1-11 pass on the refreshed cut (342/342 tests, zero skipped), and the canonical PDP-1→PDP-2 handoff is intact. See `docs/implementation/pdp-1-phase-dev-status.json`. |
| 3 | PDP-2 — Design & Interfaces | `DEV_COMPLETE`, re-frozen | The source-pinned refresh passes P2-01..P2-09 (184/184 tests) with zero outstanding meaning IDs and a passing definition-only conformance check. See `docs/implementation/pdp-2-phase-dev-status.json`; the reusable handoff remains definition-only and makes no runtime-admission claim. |
| 4 | PDP-3 — Complete Experience | `DEV_COMPLETE`, frozen | The current source-pinned gate passes P3-01..P3-10 (337/337 tests, zero skipped); all three public projections are schema-valid, pass their public validators, and are current under the strict projection check. The J-02 exact artifact/version and current-read guards have typed fixture links and negative cases. See `docs/implementation/pdp-3-phase-dev-status.json`. Terminal cross-phase and repository-wide checks remain; runtime, release and external acceptance remain separate. |

At that historical cut, the report stated all four phases were frozen at `DEV_COMPLETE`. Those statuses and counts are not current; consult the live source-pinned phase status records. The historical review reported PDP-1 corrections, PDP-2 refresh, PDP-3 checks, and deferred acceptance/runtime items. Preserve these details as provenance only; current work follows the earliest unfinished phase in the live records.

> **MANDATE:** Finish **development definition**, one phase at a time. Do not run a Lifecycle closure campaign, prepare receipts, collect convergence evidence, perform release readiness, qualify GPUs/codecs/models, deploy a production Media host, or expand the general 71-task program. Do not use those deferred activities as blockers to a semantically complete phase. Continue to write and execute ordinary unit, contract, schema, UI/keyboard and negative-behavior tests needed for code quality.

## 1. Historical source-review context

The October 9–10 review inspected the then-current main/commit tree, phase overviews, package scripts, readiness reporter, exact PDP-1 action and guard catalogs, PDP-2 composition grammar, PDP-3 journey registries and transition/version/source files, and prior targeted review findings. Its source cuts and phase states below are historical. The dated ledger above supersedes those earlier observations; current phase status is recorded only in the linked source-pinned status files.

| Source fact | Directly observed | Interpretation for this plan |
| --- | --- | --- |
| Repository progress | Main at `bda45da`; comparison from `66477bc` includes one 174-file integration commit | Reconcile that commit and the three agents' outstanding local edits **once**, before starting another independent implementation |
| PDP-0 | 462 capability leaves; 19 intents, 38 requirement groups, 30 journeys; large current capability, review and channel catalogs | Count **semantically resolved meaning/applicability/constraints**, not file population or historical "unresolved" labels |
| PDP-1 | `owner-action-wire-contracts.yaml` contains **79** unique closed request/result definition records | 78 are UI-action linked, and one (`inspect-job-retry-policy`) intentionally has `actionRef:null` and a source-backed operation-only QUERY role. Do **not** auto-repair this valid non-UI exception |
| PDP-1 typed guards | `transition-guard-contracts.yaml` has **166** declared guard facts and a typed, unknown-denies expression grammar | Validate fact provenance and exact transitions by machine/operation, not merely that boolean guard names exist |
| PDP-1 other inventories | Latest domain overview records 39 domain objects, 13 value objects, 11 relationships; 27 OpenAPI operations, 43 gRPC RPCs and multiple SDK/CLI/Agent/event identities | Complete semantic mapping of *applicable* identities, with explicit transport-only, client-only and `NOT_ADMITTED` dispositions where appropriate |
| PDP-2 | 31 component families, 13 templates, 11 layouts, 13 GUI recipes; 42 central composition-region/rule records | Source-linked component/recipe catalogs exist; evaluate their meaning/consumers/variants, not repeat catalog invention |
| PDP-3 | 47 canonical screen contracts and 30 journeys/130 ordered steps; the last checked-in phase overview describes 147 actions, 145 effect/finality proposals and 31 scenarios | These are definition inventories, not proof every nested action/step is fully semantically bound. Recompute actual missing links from the current cut |
| Readiness reporter | `scripts/report-media-pdp-readiness.mjs` and `docs/implementation/media-pdp-38-readiness.*` | The checked-in Markdown report uses an **older frozen `11eb14ea` cut**, not the post-`66477bc` integration. Its 10 unbound direct step-action refs / five PDP-3 mapping blockers are historical observations |
| Recent verification | A frozen integration reported 943 Node tests passing at `11eb14ea` | Do **not** claim 943 tests passed against `bda45da` or the still-active agents' edits; rerun affected tests and one final stable integration suite |

### 1.1 October 10 review integration and execution baseline

This plan incorporates the user-provided **Ghatana Media — PDP Development Completion Review** and the accompanying **Remaining PDP-0–PDP-3 Development Implementation Plan**. They preserve the same four canonical phases and 38-task ledger; their more specific source observations below refine the audit work without creating a fifth phase or new task identities.

At reconciliation, `main` and `origin/main` were both `5e138efbcef02c71e3255a57e2ee13b3179f49b5`. The recorded PDP-0 status was `DEV_COMPLETE` and PDP-1 was active. PXD-142's eight capability corrections passed their then-current focused regression suite and finite PDP-0 reporter gate. A subsequent source audit reopened PDP-0 only for `media.artifact.upload.ownerDefinition.parameterSchema.properties.declaredByteLength.minimum` (0→1), under PXD-153. The focused regression passed (1/1), and the finite P0 reporter gate now passes all P0-01 through P0-08 criteria; P0 is frozen at `DEV_COMPLETE`. The PXD-142 source fingerprint remains historical. PDP-1 is active; its current task gates still require their own revalidation before any P1 completion claim. PDP-2 and PDP-3 remain sequenced behind PDP-1.

The October 10 review's published-cut counts are **verification targets, not current failure counts**. Recompute them on the source cut being gated. In particular, audit: 79 existing owner-action wire contracts (preserving the operation-only query exception); 55 guards, 166 fact definitions, and 43 exclusivity groups; the 147 action dispositions (96 operation intents, 49 local/session actions, 2 Shared handoffs) separately from the historical **132 unresolved cross-interface binding snapshot** (14 mapped proposals, 1 owner-defined intent only, 132 unresolved); 27 HTTP and 43 gRPC identities; 47 screens, 30 journeys/130 steps, and 55 transition definitions. The 132 count is not the number of UI actions lacking a PDP-1 operation or non-operation disposition. The review also calls out 4 seeded versus 26 unseeded journeys despite prose saying 27, 54 transition records with no direct journey binding on its inspected cut, and a J-08 typed-input regression candidate. Revalidate each against current bytes; classify internal/event-only transitions without inventing user actions; fix the scenario prose only if the discrepancy remains.

The execution order is now explicit: PDP-0 is corrected and its finite development gate passes; freeze the corrected handoff; then integrate/reconcile existing PDP-1 work, finish P1-01 identities, complete the P1-02 state/guard authority audit, semantically review all 462 P1-03 mappings and 79 action-wire contracts, resolve P1-04/05 interface mappings, and close P1-06/07 and P1-08/09/10 before the P1-11 phase gate. No broad PDP-0 reconstruction or PDP-2/PDP-3 implementation starts during this sequence.

### 1.2 Historical execution checkpoint (October 10, 2026; superseded by the dated ledger above)

The shared checkout is on `main` at reconciliation baseline `5e138efbcef02c71e3255a57e2ee13b3179f49b5`; integrated PDP-1 work remains uncommitted and active. PXD-142's eight-item reopen and its 62/62 focused suite plus finite P0 gate are historical evidence for that earlier source cut. PXD-153 reopened P0 only for `media.artifact.upload.ownerDefinition.parameterSchema.properties.declaredByteLength.minimum` from 0 to 1, matching the positive `begin-upload.expectedSizeBytes` contract. The focused PXD-153 regression passed (1/1), and the final finite gate passes P0-01 through P0-08; P0 is frozen at `DEV_COMPLETE`. P0-03 records 50 passed and 10 historical skips; P0-08 passes 96/96. This is development verification only; no independent acceptance, runtime admission, or Lifecycle evidence is implied. Other P0 meaning and boundaries remain outside this reopen.

The same audit found separate PDP-1 mapping work: 42 direct rows with input mismatches, 26 output identity mismatches, 9 success-output guarantee gaps, 30 missing typed input source schemas, incomplete typed mappings across the 14 existing-operation bindings, and a byte-ceiling mismatch for `media.artifact.derive` and `media.artifact.output.register` (owner bounds allow 2,147,483,648 bytes while request schemas cap at 1,073,741,824). These downstream gaps do not expand the PDP-0 reopen; they remain queued for PDP-1 after the corrected upstream handoff is frozen. Reconcile all 462 effective capability-operation contracts, including 29 overlays and 14 existing-operation wire bindings, before accepting the P1 review or starting PDP-2. For the two byte ceilings, reconcile every effective request/result and overlay to the currently selected owner bound; do not silently raise the wire cap or change a PDP-0 bound to make the mapping pass. P1-04/05 retains the source-backed SDK census (33 registry records, 30 public methods, 3 excluded parser tokens); the 147 UI action roles remain distinct from the historical 132 cross-interface binding snapshot. P1-06 retains 20 exported TypeScript types, 21 public schemas, and 21 source-role bindings.

The PXD-142 focused evidence of **62/62** and its P0-08 95/95 result are historical. The final finite P0 gate reports P0-01 22/22, P0-02 11/11, P0-03 PASS (50 passed, 10 historical skips), P0-04 5/5, P0-05 8/8, P0-06 10/10, P0-07 8/8, and P0-08 96/96. PXD-153 and `pdp-0-phase-dev-status.json` record the current P0 correction and frozen development handoff. The prior P1 focused evidence remains historical until rerun on the current reconciled source cut. P1-07/08/09/10 edits and their existing tests are preserved; runtime and Shared/Event Plane admission remain `NOT_ADMITTED` where recorded. The read-only P1 lane review confirms the dependency order P1-01 identities → P1-02 states/guards → P1-03 full capability mappings/action wires, followed by P1-04/05 through P1-11. The existing edits are uncommitted and require current-source revalidation before they can support a P1 completion claim.

Historical execution note: at that plan's source cut, the report said PDP-1 and PDP-2 gates passed and described PDP-3 as the sole active phase. That sequence and status are not current; use the live source-pinned phase records.

**Size and change risk:** the current Git tree reports approximately 10.5 MB for `pdp-1-domain-data/operations.yaml`, 7.4 MB for `pdp-1-domain-data/transitions.yaml`, 7.9 MB for `pdp-0-product-truth/capability-leaf-review.yaml`, 6 MB for `pdp-0-product-truth/capabilities.yaml`, and 2.8 MB for `pdp-0-product-truth/migration-semantics-review.yaml`. These large normalized/proposal and derived populations are fragile if edited wholesale. Do not create a second competing source-of-truth catalog or rerun expensive global qualification for every single-record change. Use existing source-owned records and bounded selectors, with full-denominator validation once per phase.

**Historical status caution at that source cut:** direct source criteria previously marked satisfied might have needed **affected-source revalidation** after the then-latest 174-file commit. Previously reviewed unrelated scope was to remain frozen, not implicitly reopened. This note does not describe current phase status.

## 2. Non-negotiable execution and ownership rules

1. **Single active phase.** Start with the earliest phase not already `DEV_COMPLETE`; freeze each phase when its finite exit gate passes, then run the terminal cross-phase and full-suite checks. Work in a later phase may be read-only to supply facts or consume a handoff, but implementation begins only after its predecessor is `DEV_COMPLETE` and its handoff is frozen.
2. **One integrator owns `main`.** Read actual worktree; allow current agents to finish their in-flight patches; review, test, commit/push or merge them onto main in source ownership order. Do not overwrite others' dirty work, force-push or introduce long-lived branches. Source/manifest/registry regeneration and integration commits are serialized.
3. **PDP authority direction only:** PDP-0 declares *WHAT and WHY*, including outcomes/constraints and stable product identities. PDP-1 defines *domain HOW/WHEN* (canonical commands, objects, states, policy/effects). PDP-2 defines *how meaning is presented/invoked* consistently across GUI/API/CLI/SDK/Agent/event. PDP-3 composes these into concrete human and machine experiences. No later phase may invent a new canonical PDP-0 capability or PDP-1 state to patch a missing view.
4. **Break dependency cycles with handoff contracts.** PDP-0 can be definition-complete with a stable `capabilityIntentId`, actor, outcome, allowed channels, preconditions, input/output *semantic shapes*, exclusions and qualification/availability declarations; it does not require every future PDP-1 implementation `operationId` or executable route. PDP-1 must back-bind the exact `capabilityIntentId` with one or more typed operations, or an explicit legitimate non-domain/no-operation disposition. This is **not** permission to leave PDP-0 meaning vague.
5. **Phase lock and limited reopen.** Record `DEV_COMPLETE` with source revision, stable IDs, quality checks, and exported handoff. A completed phase may reopen only for a changed normative requirement, a real upstream contract incompatibility, an invalid direct meaning exposed by a negative test, or a materially changed dependency; use an impact-specific change request with precise affected IDs. Cosmetic prose, historical dependency labels, unchanged source snippets and regenerated fingerprints do not reopen it.
6. **No artificial progress:** no optional new capability/operation/component/journey to make progress counters bigger; no blanket "accepted" by ID similarity, no fake `NOT_APPLICABLE` for real required semantics, no meaningless test-count inflation and no mass LLM-generated repeated boilerplate replacing exact decisions. A packet must close a finite existing missing semantic population or a necessary root defect.
7. **Use actual supported components and packages.** Media product semantics stay Media-owned; Shared owns generic tokens/theme/layout/headless components, Tools owns public contract schema/projectors, and platform domains own their own public adapters. Reuse pinned current public exports where correct; do not upgrade unrelated libraries or copy Tools/Shared internals during PDP authoring.
8. **Development quality ≠ external qualification.** Keep `DEFINED` / `IMPLEMENTED` / `QUALIFIED` / `AVAILABLE` / `RELEASE_READY` separate. A definition can be complete with runtime support explicitly `NOT_ADMITTED`, but must still correctly specify denial, unknown outcome, idempotency, finality and safe recovery. Independently signed specialist reports, hosted performance, native evidence providers, Lifecycle receipts, closure gates, SBOMs and convergence are outside this four-phase **development** effort.
9. **No unbounded re-review.** Preserve approved exact decisions and impacted-source test results. Recheck changed records and their dependency neighborhood; run a full phase denominator check at its phase exit, then one cross-phase final verification. If a script mixes definition issues with deferred release or external review, introduce a separate `--definition-only` check **without weakening its existing strict default**, and test both classifications.

### Phase-local definition exit record (not a closure engine)

Use a small, development-only `phase-dev-status` summary (prefer extending the existing readiness script with a *dev-only output mode*, not adding a parallel evidence/closure subsystem):

- `phase`, `mainSha`, `sourceShaSet`, `sourceRecordCount`, `semanticallyResolvedCount`, `outstandingMeaningIds`, `testsActuallyRun`, `directDevelopmentCriteria`, `exportedHandoffIds`, `approvedMediaDecisions`, `DEV_COMPLETE | IN_PROGRESS`.
- **Explicitly exclude** Lifecycle obligation counts, receipts/currentness, convergence states, release/production/certification status and independent signoff as required fields.
- Keep original 38-/71-task ledger status historically truthful; a phase's `DEV_COMPLETE` is NOT proof that an original criterion requiring independent certification/operational test has passed.

## 3. Common development methodology — for every phase

**I. Material source inventory:** enumerate stable IDs and exact source meaning from current `main`, plus reviewed unmerged patches; classify `READY / INCOMPLETE / CONTRADICTORY / INTENTIONALLY_NONAPPLICABLE`. Avoid treating historical source review suggestions as current gaps without comparing present values.

**II. Typed source fixes:** for each incomplete record write exact owner intent, identity/refs, affected dimension, constraints and safe unknown/nonadmission behavior, resolving duplicate authority instead of adding an alternative authority.

**III. Negative regression first:** add a test that fails if missing/wrong semantics are reintroduced. Failing cases should cover swapped IDs, stale source/version, unauthorized tenant/consent, invalid units/ranges, unsafe retry/replay, conditional reversibility, orphaned screen/action, wrong interface type or missing recovery.

**IV. Bounded implementation packet:** make one cohesive change to the owning source plus smallest consumer adaptation and tests. Work **by existing domain family or cross-record root issue**, not arbitrary one-line microtasks. As a default, handle one complete semantic family or 10–25 related records per packet, then move to the next; adjust for natural coupling.

**V. Changed-impact validation:** run the affected tests and the particular phase's schema/public source checks. Preserve test outcomes and existing reviewed decisions only if exact material inputs did not change. If the phase check still fails, report the **actual remaining IDs**, not a repeated generic PENDING message.

**VI. Merge and move:** integrate reviewed code on `main` and record which finite unresolved population decreased, *before* opening a different domain family. No new expansion of requirements solely to keep agents busy.

## 4. PDP-0 — Product Truth (narrowly reopened, corrected and frozen)

**Exact authority:** `.product-experience/pdp-0-product-truth/`. **Do not edit PDP-1 operation semantics to complete PDP-0**; consume existing observed interface context read-only and record PDP-1 handoff obligations.

The prior status record declared PDP-0 complete and frozen. A current downstream contract audit proved a material upstream semantic defect, meeting the plan's narrow reopen condition. The phase was reopened only for the eight IDs listed below; these corrections and their negative regressions are now reviewed under PXD-142, and the complete finite gate passes. PDP-0 is frozen again for the current source cut. The correction register below documents the bounded work and does not authorize reconstructing accepted capability, migration, actor, policy, or channel reviews.

### Current bounded reopen

| Capability ID | Correction required | Exit evidence |
| --- | --- | --- |
| `media.project.source-asset.attach` | Bind the exact immutable source asset version and selected project version; distinguish membership from copying or byte preservation. | Exact typed slots/outcome plus mapping negative tests |
| `media.artifact.derive` | Bind exact source version(s), transformation profile identity/version/configuration digest, output artifact/media type and byte budget, purpose, and rights decision. | Exact typed slots/outcome plus operation-mapping tests |
| `media.artifact.output.register` | Bind candidate/lineage, digest, media type/byte length, policy decision, and authorized target workspace. Workspace-only registration may omit the exact project version; project-targeted registration requires it for stale-version checking. | Keep the general input slot optional (`ZERO_OR_ONE`); enforce the project-target precondition and cover both branches with mapping tests |
| `media.artifact.upload`, `.upload.resume`, `.import`, `.inspect`, `media.speech.transcription.file` | Mark outputs “if issued/when registered/when authorized/if produced/when provided” as optional-on-success while retaining unconditional outputs. | Requiredness regression tests and effective result-schema reconciliation |
| `media.artifact.upload` | PXD-153 reopens only `ownerDefinition.parameterSchema.properties.declaredByteLength.minimum` from 0 to 1 to match P1's positive `begin-upload.expectedSizeBytes` source contract. Preserve `NOT_EMPTY`, the 2,147,483,648 maximum, request-body limit, and runtime/qualification boundaries. | Focused PXD-153 regression PASS (1/1); finite P0 gate PASS, PDP-0 frozen at DEV_COMPLETE |

No new PDP-1 operations are needed to make these P0 meanings complete. PDP-1 mapping work must consume the stable corrected shapes rather than redefine them.

### Work packages — ordered

| ID | What / where | How to complete efficiently | Development exit |
| --- | --- | --- | --- |
| **P0-A / P0-01** | All 462 capability leaves: `capabilities.yaml`, `capability-leaf-review.yaml`, `requirements.yaml` | Partition by existing family (artifact/project/rights; speech/audio; image/vision; video/compose/delivery; spatial/animation/simulation; machine integration). Give each stable leaf: outcome/actor, in/out meaning, applicable/unsupported channels, profile/fidelity, version/provenance/rights constraints, allowed local vs canonical effects, fallback/unavailable behavior and `DEFINED/IMPLEMENTED/QUALIFIED/AVAILABLE` truth. Map to PDP-0 intent, journey or machine capability; a future PDP-1 concrete operation ID is a **handoff**, not a PDP-0 prerequisite. Detect source-free creation vs source-derived transformation explicitly. | `462/462` uniquely defined, none silently excluded or semantically UNKNOWN for an applicable product requirement; negative stale/duplicate/wrong-channel/wrong-provenance tests |
| **P0-B / P0-02** | Operation/request bounds: `requirements.yaml`, `profile-semantics.yaml`, `qualification-policy.yaml`, `nonfunctional-requirements.yaml` | Select exact units, bounds, required/optional fields, defaults, profile eligibility and support state **only when product policy actually specifies them**. For unknown measured limits use honest defined constraint strategy/`NOT_EVALUATED` rather than fabricated numbers. Reuse common input-shape families with explicit per-leaf exceptions. | Every applicable leaf has a falsifiable product-level contract; no "available because defined", no unlimited unbounded operation |
| **P0-C / P0-03** | Historic migration semantics: `migration-semantics-review.yaml`, `docs/migration/master-plan-source-change-claims.yaml`, current PDP source | Determine current outstanding normative claims by semantic diff against latest source (the prior count of 260 is historical). Group by **one current owning artifact**, classify as adopted/clarified/superseded/execution-only/external-owner/out-of-current-product-scope with exact reason. Do not make a 2.8 MB migration review an additional source of live normative Media meaning. Already reviewed claims stay reviewed unless changed. | No **applicable** normative product meaning exists only in the old master plan; no duplicate/conflicting owner. Historical implementation tasks are not added to product definition |
| **P0-D / P0-04** | `goals-jtbd.yaml`, `intent-resolutions.yaml`, `journey-actor-resolutions.yaml`, `journey-catalog.yaml` | **Reuse** already supported 19 intent actor/priority, 30 journey initiator, 66 requirement crossrefs. Only recheck their changed dependencies; do not reconstruct these three populations. Distinguish actor intent from authentication and authorization. | Existing direct mapping invariant holds; no orphan intent/actor/outcome |
| **P0-E / P0-05** | `constitution.yaml`, `policy-authority-model.yaml`, `dependency-contracts.yaml` | Define product policy invariants, violator meaning, trusted identity context, version/consent/rights provenance and Media-vs-platform ownership. Do **not** duplicate PDP-1 machines or pretend a runtime provider is admitted. | One source authority per rule; no unsafe policy/trust contradiction |
| **P0-F / P0-06** | `goals-jtbd.yaml`, `quality-policy.yaml`, `nonfunctional-requirements.yaml`, `time-units-fidelity.yaml` | Reuse four measured intent definitions; reconcile their applicability/measurement *method* across selected outcomes and leaf families. Define denominator, unit, missing measurement behavior, success condition and source/time scope. Baseline/target may honestly be `NOT_SET / NOT_EVALUATED` if not needed to define a metric. | No unsupported statistical/numerical quality promise; complete metric-to-applicable capability mapping |
| **P0-G / P0-07** | `applications-channels.yaml`, `docs/PRODUCT-DEFINITION-COVERAGE.md`, requirements and capabilities | Recheck existing `15` review dimensions, `38` requirement groups, `11` channel/profile mappings **for material source changes only**. Web is not compulsory for API/CLI-only capabilities. Preserve explicit channel nonadmission. | Every applicable capability has correct channel/consumer/discovery support or reasoned non-applicability |
| **P0-H / P0-08** | `PRODUCT-TRUTH.md` + phase exit verification | Conduct **internal development semantic review** of the full current 462 ID and requirement inventory; fix material contradictions. Independent formal P0-010 acceptance is *not* this effort's gate. | PDP-0 `DEV_COMPLETE` and a stable capability/requirement/intent/profile/policy handoff |

**Known risk to recheck before locking P0:** a recorded reviewer found source-free animation creation/edit outputs mislabeled as necessarily `SOURCE_DERIVED_TRANSFORMATION`. Confirm latest current authoring logic; source-free authored scene/edit creation needs an epistemic/provenance disposition distinct from a derivation of an identified source. Check the exact 2D/3D/vector/timeline branch schemas and outputs; do not erase source-derived correctness for genuinely derived branches.

### PDP-0 stopping rule

Run changed-source focused tests and the complete PDP-0 ID/negative validation once:

```bash
pnpm generate:product-definition-manifest
node scripts/generate-media-phase-projections.mjs --check --strict
pnpm check:product-definition-authority
node --test tests/pdp-truth-domain*.test.mjs tests/pdp-0-final.test.mjs \
  tests/pdp-capability-family-definition.test.mjs \
  tests/pdp-migration-semantic-reconciliation.test.mjs \
  tests/pdp-migration-capability-material-claims.test.mjs
git diff --check
node scripts/report-media-pdp-readiness.mjs --verify --phase-dev-status=PDP-0
```

Adapt exact test globs to files actually present. **Do not run all repository tests or Lifecycle tools per PDP-0 packet.** The phase cannot advance if any current PDP-0 leaf, intended policy or applicable normative migration claim remains semantically unaddressed, irrespective of structural schema validity. Freeze the PDP-0 handoff IDs and proceed to PDP-1 once this finite condition holds.

## 5. PDP-1 — complete Canonical Domain and Data second

**Exact authority:** `.product-experience/pdp-1-domain-data/`. Read locked PDP-0 meaning and reuse existing source proposals; no new PDP-0 capability to explain a type. Actual storage/worker release qualification is deferred.

### Work packages — ordered

| ID | What / where | How to complete efficiently | Development exit |
| --- | --- | --- | --- |
| **P1-A / P1-01** | `domain-objects.yaml`, `value-objects.yaml`, `relationships.yaml`, `canonical-reconciliation.yaml`, `versioning.yaml` | Reconcile the live **39 object definitions / 38 registered identities / 13 values / 13 current relationships** against PDP-0 authority and named source projections; preserve the historical 11-relationship snapshot recorded under PXD-140. Specify immutable identity tuples, version lineage, cardinality, tenant, source-vs-derived/provenance, conflict and missing-value semantics. Do not equate artifact digest with version ID or legacy transcript UUID with canonical transcript-version. | Every currently applicable object has a unique typed identity and reference contract; invalid joins/lineage fail focused tests |
| **P1-B / P1-02** | `states.yaml`, `state-adjudication.yaml`, `transitions.yaml`, `transition-guard-contracts.yaml` | Complete every current machine/dimension: upload/artifact verification, job/attempt/lease, stream, delivery, consent/rights, project/caption version and other selected machines. Audit all **55 guard records**, **166 facts**, and **43 exclusivity groups** using `trusted-owner-observation`, `deterministic-derived`, `validated-session-input`, or `unsupported/unbound`; retain exact source, scope, freshness, version, consumer and unknown policy. A typed expression block count is not a proxy for missing semantics. Deny unsafe effects on UNKNOWN; distinguish acceptance, queueing, cancellation request/confirmation, and known/unknown outcome. | Every applicable edge is legal and guard-evaluable on typed model inputs; contradiction, stale-version, replay, race and unknown-outcome negative tests pass; runtime deployment is not required |
| **P1-C / P1-03** | `capabilities.yaml` → `operations.yaml` capability operation mappings, `owner-action-wire-contracts.yaml`, `action-contracts.yaml` | First reconcile all **462 P0 capability intents** to 448 direct P1 capability-operation definitions and 14 exact existing-operation bindings. Treat `capabilities.yaml#capabilities[].ownerDefinition` as the stable P0 intent authority. Compare typed input source type/order/cardinality/required/alternatives, parameter meaning, success-output identity and bounds against each effective P1 request/result schema; resolve all 14 source-owned wire schemas and preserve ordered multi-operation bindings. PXD-151 already reconciles the named artifact maxima to the 2,147,483,648-byte owner bounds while preserving the 65,536-byte request-body limit and the separate 1 GiB generic job-submit resource budget. Verify every effective schema and owner-leaf overlay against its selected P0 bound; do not silently widen limits or change P0. Do not add operation refs to P0 or mistake a stale duplicate review row for authority. Separately audit the **79 existing** owner-action wire definitions; do not duplicate them. Verify closed request/result/error schemas, exact operation/kind/source links, actor/delegated tenant, object/version, preconditions, effect, cancellation/unknown, idempotency and safe recovery. Preserve the 78 action-linked records and the operation-only `inspect-job-retry-policy` QUERY with `actionRef:null` and no mutating finality. Use bounded, disjoint semantic cohorts and record exact IDs and remaining-ID deltas. | All 462 mappings preserve P0 intent through effective P1 contracts; 14/14 bindings resolve exact source wire schemas; all 79 action wires pass schema and source-semantic validation plus malformed, unauthorized, stale, replay and unknown-path cases; no fabricated endpoint or UI action |
| **P1-D / P1-04/05** | `interface-parity/operation-parity.yaml`, `contracts/openapi/media.yaml`, gRPC protos, current SDK/CLI/Shared registries | Recompute identities on current source. Keep the **147 UI actions** (96 operation intents, 49 local/session-only, 2 Shared identity handoffs) separate from the historical **132 unresolved cross-interface binding** snapshot (14 mapped proposals, 1 owner-defined intent only, 132 unresolved). Reconcile exact method/path/request/result/error identities; preserve justified local, transport-only, versioned-compatibility, external-owner, client-only and `NOT_ADMITTED` roles. Never infer equivalence from names or route reachability. | Zero unexplained applicable semantic identities; wrong-route/version/schema/name-equality negative tests fail; production route reachability remains honestly separate |
| **P1-E / P1-06** | `typed-contract-bindings.json`, `libs/audio-video-types/src/contracts.ts` | **Preserve** already complete exact TypeScript source-role census, adding bindings only if a real source type/schema changed. | Previously complete focused negative tests still pass |
| **P1-F / P1-07** | `agent-tools` definitions under PDP-2/PDP-3 as projections of PDP-1; 4 observed handlers | Define closed tool input/result/error, tenant/delegation/rights/budget/deadline/idempotency/cancel/unknown/provenance for each handler with a public invocation shape. `NOT_ADMITTED` remains truthful until actual runtime/Shared approval; no model or cross-modal service fabricated. | All four authoring contracts semantically complete with injection/untrusted media/authority negative tests |
| **P1-G / P1-08** | `events.yaml`, `provenance.yaml`, `evidence.yaml` (domain evidence semantics, not an Evidence Generator), current Event Plane public adapter | Separate nine previously inventoried publisher/event identities and 15 client notifications; define publisher, resource version, event type/schema, ordering, replay/dedup, correlation, privacy and unknown delivery state. Event Plane accepted HTTP response is not the final consumer effect. | No event/notification conflation; executable model tests reject duplicate/out-of-order/untrusted deliveries |
| **P1-H / P1-09** | `value-objects.yaml`, `interoperability.yaml`, PDP-0 time/fidelity authority | Define rational frame/sample times, clock origin, variable-frame-rate, spatial basis/units, transformation/loss, rounding, overflow and provider confidence. Test round trips and negative incompatible-coordinate/time mappings; do not invent scientific calibration. | Selected profiles have accurate typed measurement meaning, precision and loss semantics |
| **P1-I / P1-10** | `authority.yaml`, `privacy.yaml`, `offline-sync.yaml`, `versioning.yaml` | Model denial, consent revocation/change, immutable subject version, tenant/principal delegation, retention/legal hold, stale draft, idempotent duplicates and conflict reconciliation. Define what requires live/trusted owner observation; user-provided boolean is never authorization. | Source-defined effect guards are deny-by-default, with realistic negative tests; runtime operation/load testing deferred |
| **P1-J / P1-11** | `DOMAIN-MODEL.md`, domain registries and focused consumer model tests | Do internal cross-interface **development review** on ALL applicable object/state/action/guard/protocol identities, not only one audio/caption slice. Defer formal independent domain/security certification, Lifecycle admission and deployment. | PDP-1 `DEV_COMPLETE` and a frozen canonical object/operation/state/action/error/event handoff |

**Material known defects — test against latest source before approving P1:**
- A previous current-source review found `phase-noise-floor` output schema ID, metric ID and measurement-window field inconsistent. Require exact output/metric join plus a typed window or qualified omission.
- The TTS optional authorized speaker-reference helper previously accepted its own fixture fields while rejecting the canonical selected-speaker input (`speakerRef`, `consentRef`, `rightsEvidenceRefs`). Resolve the canonical schema + owner-read-adapter, not by loosening the input.
- Examine mutation/creation versus source-derived output provenance and AI-Inference modality boundaries as semantic tests, not provider admission.
These findings are **observations from an earlier moving cut**; mark fixed only after inspecting current code and executing their explicit regression tests.

### PDP-1 stopping rule

Run focused current source model suites for identity/state/transition/guard/action-wire/protocol and one overall semantic identity census, then regenerate the public projection. Existing `pnpm check:contract-parity` mixes semantic and runtime admission: if non-green *solely* because a correctly specified route has `runtimeAdmission: NOT_ADMITTED`, introduce a **definition-only semantic parity mode** without weakening the original full checker or claiming production parity. No semantic mismatch, unknown owner or unclassified identity may be ignored.

```bash
node --test tests/pdp-owner-logical-command-contracts.test.mjs \
  tests/pdp1-transition-guard-definition-evaluator.test.mjs \
  tests/pdp-truth-domain-owner-identity-contracts.test.mjs \
  tests/pdp-truth-domain-race-semantics.test.mjs \
  tests/pdp-truth-domain-transition-coverage.test.mjs \
  tests/media-contract-parity.test.mjs \
  tests/pdp-tts-request-origin-binding.test.mjs
pnpm test:typed-contract-bindings
node scripts/generate-media-phase-projections.mjs --check --strict
git diff --check
```

The phase closes for development only when PDP-1 source model, guard/protocol compatibility and non-operation dispositions are complete for the locked PDP-0 scope. Freeze canonical IDs and proceed to PDP-2; no need for production DB/service proof.

### P1-03 bounded contract cohorts

Partition the existing 79 records by canonical operation and shared guard requirements, with exact non-overlapping IDs whose union is 79: (A) project/workspace/artifact and authorized source reads; (B) logical jobs, retry/readiness and observation; (C) speech, voice, captions and dubbing; (D) vision/measurement/review and version comparisons; (E) image/video/audio edit, composition, animation and simulation; (F) export, approval, consent, delivery, settings and integrations. For each cohort, record happy and denial cases per distinct operation meaning plus stale-version, unknown-finality and replay cases where applicable. A cross-cutting action belongs to one cohort only; other cohorts consume its reviewed contract. Do not invent endpoints or operation families to reach 79.

## 6. PDP-2 — complete Design and Interfaces third

**Exact authority:** `.product-experience/pdp-2-design-interface-system/`. This phase defines the **reusable** UI/interface grammar, not completion of the 47 individual PDP-3 screens. PDP-2's mature current catalogs are primarily an **admission/consistency** task, not a new design catalog task.

| ID | What / where | How to complete efficiently | Development exit |
| --- | --- | --- | --- |
| **P2-A / P2-01** | `typography-layout.yaml`, `accessibility.yaml`, `action-finality-grammar.yaml`, generated ExperienceLanguage | **Preserve** six resolved public mappings and exact source-approved density, disclosure, recovery and 13 recipe definitions. Only retest if its dependencies materially changed. | Public field mapping and enum/negative tests green |
| **P2-B / P2-02/03** | `media-token-aliases.yaml`, `gui/primitives.yaml`, `gui/style-authority.yaml`, `design-governance.json` | Bind required public Shared token/theme/headless interfaces from exact pinned source/development artifact, not by copying private Shared internals. Check light/dark/forced-colors/reduced-motion/RTL, typed token units, available control classes and restrictive CSP. The 5/7 owner gate decision count is not a development failure. Public registry publication and external owner signatures are deferred; incomplete **actual** aliases/consumer compatibility must be fixed. | All tokens and actually used public primitives resolve with correct types/variants; no incompatible style or silent native fallback |
| **P2-C / P2-04** | `component-contracts.yaml`, `component-value-types.yaml`, `gui/semantic-component-bindings.yaml`, `gui/reuse-audit.yaml`, `libs/audio-video-ui/` | Review existing 31 typed component families for anatomy, props/defaults, disabled/unknown/denial/loading/selection/keyboard/announcement, source-vs-derived provenance. Decide one of `SHARED_PUBLIC_EXPORT`, `MEDIA_PUBLIC_COMPOSITION` or `CONTRACT_ONLY_NOT_IMPLEMENTED` for each. Use Shared only when behavior matches; never force Shared Stepper/Progress if it loses Media rights/finality meaning. Validate the four already implemented Media screen families and AI Voice reuse without pretending all 31 exist in runtime. | Every family has an intentional source-coherent reuse/contract classification and testable interaction grammar |
| **P2-D / P2-05** | `gui/{templates,recipes}/catalog.yaml`, `gui/layout.yaml`, `gui/composition-validation-grammar.yaml` | Reuse existing **13 templates, 11 layouts, 13 recipes, 42 grammar records**. Confirm all required template/region/pattern/interaction relations, overlays, required anatomy, keyboard/focus, unknown finality and responsive reading order. Do **not** require all 47 PDP-3 screen instances to be semantically complete here; only ensure the reusable grammar can represent them without false assumptions. | Reference and negative composition grammar checks pass; 47 selected links stay valid inputs to PDP-3 |
| **P2-E / P2-06** | `typography-layout.yaml`, `responsive-adaptive.yaml`, `motion.yaml`, `localization-content.yaml`, `gui/style-authority.yaml` | Define best-quality consistent hierarchy, spacing, typography scales, density profiles, token use, responsive/reflow, light/dark/forced colors and reduced-motion rules. Use progressive disclosure; essential rights, job state, source/version, unknown finality and safe recovery never vanish at narrow widths. Provide representative render/keyboard references, not screen-specific CSS patches. | Consistent reusable responsive design with runnable renderer/keyboard/contrast/zoom tests for representative patterns |
| **P2-F / P2-07** | `api/*.yaml`, `interface-grammar.yaml`, the exact PDP-1 gRPC proto/source inventory, `cli/conventions.yaml`, `sdk/conventions.yaml`, `events/conventions.yaml`, `agent-tools/conventions.yaml` | Preserve PDP-1 source meaning across HTTP, gRPC, SDK, CLI, event, and Agent Tool interfaces: stable typed error/result, exact tenant+version, long-running status, pagination/search, cancellation requested vs confirmed, unknown effects and machine-readable output. Consume all **43 current gRPC RPC identities** with exact service/method, stream shape, request/response fields, and existing dispositions; explicitly leave semantic field parity unresolved and runtime `NOT_ADMITTED` where the source review does. Do not invent equivalence or GUIs for API-/CLI-only services. | All applicable interface styles internally consistent and contract-testable; all gRPC identities have exact source dispositions without fabricated semantic parity or runtime admission |
| **P2-G / P2-08/09** | `DESIGN-LANGUAGE.md`, `accessibility.yaml`, public Shared consumer, representative Playwright/DOM tests | Run **development-grade accessibility and visual usability verification**: keyboard-only, ARIA/live-region focus, target sizing, labels, zoom, RTL stress, contrast, forced colors, reduced motion. Fix defects in reusable templates/components/tokens, not 47 patches. Formal independent AT certification and a formal external phase-authority signoff are deliberately deferred and must not be faked. | PDP-2 `DEV_COMPLETE`; valid frozen Design Language/Interface System handoff to PDP-3 |

**Checker separation:** `pnpm check:design-conformance` historically reports source-correct work as BLOCKED because Shared owner/independent reviews are not filed. Preserve that stricter behavior for later qualification; provide a separate **`--definition-only`** checker or named targeted suite that enforces *semantic source conformance* without requesting independent credentials. It must still fail on missing token references, invalid composition, broken keyboard semantics, unaccepted screen-local primitive duplication or unsafe finality presentation.

**PDP-2 stopping rule:** no applicable reusable grammar/variant/semantic token gap; all relevant contract-only UI components explicitly labeled; definition-side Shared consumer behaves correctly under CSP/accessibility checks. Freeze design tokens, component family contracts, interface conventions and pattern IDs. Move to PDP-3; individual screen-state completeness is NOT a PDP-2 blocker.

## 7. PDP-3 — complete every concrete Product Experience last

**Exact authority:** `.product-experience/pdp-3-product-experience/`. Consume frozen PDP-0/1/2 definitions; no runtime product launch.

| ID | What / where | How to complete efficiently | Development exit |
| --- | --- | --- | --- |
| **P3-A / P3-01** | `scripts/generate-media-phase-projections.mjs`, `generated/experience-specification.candidate.json` | Recompute remaining semantic field blockers from current main; the frozen overview listed **5** (`journeys, transitions, actions, effects, finality`), not an assured current count. Resolve nested field references, not only public schema-required array presence. Keep conditional reversibility distinct from false boolean. | Public v1 schema + semantic cross-reference/guard/effect validation; **zero unresolved applicable PDP-3 definitions** |
| **P3-B / P3-02** | `screen-registry.yaml`, `screen-contracts/*.yaml` | For 47 canonical screens verify exact view intent, actor/rights, bound object/version, template/layout/recipe/component contract, supported channels, states/empty/loading/denial/error/unknown, allowed actions, confirmation/recovery and responsive/keyboard semantics. Leave implementation as `CONTRACT_ONLY` where appropriate; 47 screens do **not** mean 47 shipped routes. | 47/47 current source-complete screen definitions with no dangling or contradictory contract refs |
| **P3-C / P3-03** | `journey-registry.yaml`, `journey-contracts/*.yaml`, `journey-purpose-bindings.yaml`, `step-version-binding-contracts.yaml` | Exhaustively validate **30 journeys/130 steps**. Each step needs exact stable ID; actor/task intent; object/revision; authority; action or a justified passive observation; applicable state/guard/transition or typed NO_DOMAIN_MUTATION reason; expected result/finality; denial/unknown/conflict/recovery; scenario/method reference. Do not use view links as substitute for actual step semantics. | All 130 step contracts pass referential and negative model tests, and 30/30 journeys have complete happy + critical nonhappy branches |
| **P3-D / P3-04** | `action-registry.yaml`, `action-reconciliation-contracts.yaml`, `local-step-effect-contracts.yaml`, `journey-transition-edge-bindings.yaml` | Reconcile every current UI/machine action to PDP-1 command/query, local-only, navigation, observable read, or explicit unadmitted role. Use the existing **79 typed owner-action wire contracts** where relevant, not a second action contract registry. Validate legal outcome/guard and effect for source-derived vs authored outputs, cancellation, irreversible/delete, retry eligibility, unknown result. A justifiably passive step does not need an invented canonical state transition. | All applicable action/effect/finality meanings are semantically exact, with zero arbitrary null/success inference |
| **P3-E / P3-05** | `scenario-fixture-registry.yaml`, `libs/media-experience-simulation/src/fixtures.ts`, `step-definition-oracles.yaml` | Use the existing 31 scenarios; cover each journey with appropriate positive, denied, stale, outcome-unknown and recovery **definition fixtures**. If a retry-eligible path requires a prior attempt, either construct a valid contract-based synthetic prior attempt with all predicates true, or make the eligible branch a documented conditional scenario with denial tests; never fabricate authorization or runtime support. | Every applicable critical journey/step has a reproducible bounded definition oracle; seeded/conditional/unimplemented clearly distinguished |
| **P3-F / P3-06** | `libs/audio-video-ui/src/screens/MediaProductRenderer.tsx`, public exports and PDP-3 render adapters | Preserve a **single Media renderer** shared by product-like previews and Explorer. For source-backed implemented families test exact inputs/events/DOM/a11y. For other screen definitions use honest contract preview without claiming executable product functionality. A deployed Web host is outside scope. | No duplicate renderer semantics; implemented vs definition-only routes are correctly identified |
| **P3-G / P3-07** | `api-experience-mapping.yaml`, `api/`, `grpc/`, `cli/`, `sdk/`, `agent-tools/`, `events/`, `search-inspection-contracts.yaml` | Complete complete typed machine experiences: request/result/errors/authorization/version, collection/search/inspection, progress, denial/unknown and safe retry grammar, deterministic test adapters. API-only, CLI-only and Agent-only capability needs no fake Web page. | Every applicable channel has an inspectable source-complete contract or explicit `NOT_ADMITTED` and functional definition fixture |
| **P3-H / P3-08** | `docs/EXAMPLES.md`, journey and scenario source | Cover each current feature family with an accepted definition-grade end-to-end example or justified out-of-scope classification. Include source or authored creation, exact IDs, constraints, permission, action, resulting version, uncertainty, provenance, failure/recovery, and channel. | Complete representative family coverage without implying codecs/models/runtime are qualified |
| **P3-I / P3-09** | `responsive-variants.yaml`, `content-copy-catalog.yaml`, `libs/audio-video-ui/`, targeted browser smoke suites | Verify representative compositions and all source-defined screen states at narrow/standard/wide viewports; keyboard focus, labels/announcements, localization/RTL, reduced-motion, touch and no lost advanced controls. This validates development quality, not a formal independent AT certificate. | No unhandled semantic UI variant or broken accessible source behavior |
| **P3-J / P3-10** | `COMPLETE-PRODUCT-EXPERIENCE.md`, 47 screen + 30 journey inventories and contracts | Conduct an internal full denominator/critical-flow development review against frozen P0/P1/P2 handoffs and all current PDP-3 source records; fix mismatches. Do not require native Lifecycle results, independent phase-signoff paperwork or a production host. | PDP-3 `DEV_COMPLETE`; complete, self-consistent, testable canonical experience specification |

### PDP-3 stopping rule

Run exact current tests for screens, journeys, effect/guard/transition semantics, scenario/model cases, typed channel adapters, renderer and applicable UI variants. At phase exit regenerate all three public projections and manifest once, then run the final **cross-phase** subset and full Node development suite on an immutable source cut. No custom closure/evidence tooling. One final repaired source check is better than repeated 900+ test runs after every micro-edit.

**Recommended focused commands** (discover the current test files and package script names; correct globs when needed):

```bash
node --test tests/pdp-experience-step-semantics.test.mjs \
  tests/pdp-experience-transition-edge-bindings.test.mjs \
  tests/pdp-experience-action-reconciliation-contract.test.mjs \
  tests/pdp-experience-step-definition-oracle.test.mjs \
  tests/pdp-experience-journey-scenario-bindings.test.mjs \
  tests/pdp-3-screen-journey-crosslinks.test.mjs \
  tests/pdp-design-composition.test.mjs \
  tests/pdp-ui-action-local-semantics.test.mjs
pnpm check:presentation-architecture
pnpm check:product-experience-local
node scripts/generate-media-phase-projections.mjs --check --strict
git diff --check
```

Final frozen integration only:

Generate phase projections before the product manifest: the manifest records the generated PDP-3 candidate's exact bytes in `semanticFingerprint.contentSha256`.
After all enumerated source edits, refresh the persisted source digests and denominator so the repository-wide audit compares the same source cut. This source-input refresh does not assign observers, oracles, admissions, or receipts; changed proof-route candidates remain explicitly pending rerun and review.

```bash
node scripts/generate-media-phase-projections.mjs
pnpm generate:product-definition-manifest
node scripts/generate-media-lifecycle-source-inputs.mjs
node scripts/generate-media-phase-projections.mjs --check --strict
node scripts/generate-media-lifecycle-source-inputs.mjs --check
pnpm check:product-definition-authority
pnpm check:product-experience-local
pnpm check:presentation-architecture
node --test --test-concurrency=4 tests/*.test.mjs
git diff --check
git status --short
git rev-parse HEAD
```

These are development tests. An unrelated test that specifically requires Lifecycle evidence publication or production host deployment is **not** a PDP dev-completion gate; record it under the deferred separate program without weakening its original assertion.

## 8. Explicit blocker/quality correction queue

The following are *material source issues* to inspect at the present main cut. Some were recorded before the latest bulk integration and may already be fixed. Never automatically carry over historical "PENDING" without verifying the actual source branch and affected tests.

| Risk/finding | Phase owner | Required corrective decision/test |
| --- | --- | --- |
| Authored source-free scene/edit returned as a derivative of an absent original | P0 | Distinguish authored creation, source-derived transformation, generated inference and unknown provenance; material scope/identity tests |
| Wrong/partial input optionality and incorrectly assumed output producer readiness | P0 → P1 | Per-profile optionality and capability input/output variants explicit; no false available provider from a defined capability |
| TTS authorized speaker-ref canonical input versus helper's unrelated fixture fields | P1 | Canonical `speakerRef/consentRef/rightsEvidenceRefs` with trusted read adapter and missing-rights negatives |
| Phase-noise measurement schema ID/metric identity/measurement window | P1 | Match declared output schema/metric references; carry bounded measurement interval or refuse to assert recorded window |
| Guard boolean considered authoritative without typed current fact; unknown outcome accepted as a safe retry | P1 | Typed fact origin/freshness/version check and fail-closed guards; attempt identity and cancellation-race tests |
| Old SDK route names equated to canonical HTTP operations without identical semantics | P1 | Source-exact non-admission/compatibility classifications; reject wrong wire request/result/error |
| UI reuse by matching component name but with lost consent/finality/state semantics | P2 | Reuse only public export with exact anatomy and interactions; preserve strict CSP and no duplicate main/heading landmarks |
| Nested public fields filled by empty placeholder arrays and declared "complete" | P3 | Validate exact nested action/object/authority/guard/effect/finality semantics and justified no-domain-mutation |
| Historical ready-source cut advertised as current after large integration | All | Source-diff by exact IDs and live recomputation; no approval automatically reopened/reused if its material source bytes changed |
| Source-model overexpansion (large catalogs and duplicate boilerplate) | All | Bounded source selectors, unique canonical owner refs, targeted tests, explicit generated/derived markers; no duplicate new authority |

Do not let these corrections become a **fifth** phase or an open-ended cleanup workstream. A finding is done when its current exact owner source and negative test pass, and all materially dependent records are updated. Otherwise record the **single** remaining concrete source defect and proceed with other eligible work in the current phase.

## 9. Cross-phase integration tasks (outside PDP numbering; not PDP-4)

| ID | Work | Development completion |
| --- | --- | --- |
| **INT-01** | Integrate the three already-started PDP-1 agent workstreams into one reviewed source cut; record the exact SHA and changed IDs. | No useful dirty work is discarded, high-contention catalogs have one writer, focused tests pass, and `main` contains the integrated cut. |
| **INT-02** | Extend the existing readiness reporter with development-only phase output. | Report source SHA/IDs, denominator, resolved count, exact remaining meaning IDs, tests actually run, material scope and handoff refs; keep Lifecycle/independent acceptance separate. |
| **INT-03** | Separate definition semantics from later external qualification in parity/design checks only where required. | A named `--definition-only` mode retains strict meaning/reference/error checks and has negative tests; existing strict default remains unchanged. |
| **INT-04** | Regenerate owner-source projections and manifest after phase integration. | Verify exact references and public schemas, then run generation/check twice without drift; never patch generated candidates to conceal missing source meaning. |
| **INT-05** | Run final development verification on one terminal source cut. | Applicable phase gates, negative cases, projections and representative UI/headless checks pass; report actual commands/results without claiming Lifecycle closure or release. |

These integration tasks do not create new PDP task IDs or an extra phase. INT-01 is the current integrator action; INT-02 through INT-05 are completed at the relevant phase or terminal gate.

## 10. Work allocation for the existing three agents

**Historical staffing plan (not current assignments):**

| Active phase | Agent A | Agent B | Agent C | Integrator |
| --- | --- | --- | --- | --- |
| PDP-0 | Capability/requirements/profiles, bounded families | Migration normative claims by owning PDP0 file | Product policy/quality/channel/actor crosswalk and negative tests | Review semantics, material source diff, unify PDP-0 source, run phase gate, lock handoff |
| PDP-1 | Objects/identity/value/version lineage and current-source review | State/guard authority matrix, typed fact evaluation, provenance/offline/privacy within non-overlapping files | Operations/79 action wire contracts and applicable interface/Agent mappings | Integrate in dependency order, resolve cross-authority IDs, run phase gate, freeze handoff |
| PDP-2 | Shared tokens/typed component contracts | Templates/layouts/recipes/accessibility/responsive | API/CLI/SDK/events/Agent interface grammar and keyboard/copy tests | Whole design source consistency, no duplicate styling rules, phase lock |
| PDP-3 | Screen contracts and UI state/anatomy | Journey-step action/transition/effect/finality | Scenarios/headless channels/renderer/contracts/examples | Whole 47/30/130 denominator and negative cases, final integration |

**Historical conflict rules and disposition:** the October 2026 plan required one author at a time for `capability-leaf-review.yaml`, `operations.yaml`, `transitions.yaml`, `owner-action-wire-contracts.yaml`, `action-registry.yaml`, `journey-registry.yaml`, generated candidates, and the shared decision log. The plan's report that PDP-0 through PDP-3 were frozen at `DEV_COMPLETE` applies only to its recorded cut. Current phase order and status come from the live source-pinned records linked in the canonical PDP index.

**No task ping-pong:** A downstream discrepancy is submitted as an *interface change request*: {phase owner, exact record IDs, violated invariant, minimal patch, affected tests}. The prior phase owner decides to fix a real semantic defect or rejects an invalid downstream assumption. Approved frozen records not impacted by that request are never re-reviewed.

## 11. Exact milestone report and terminal result

After **each phase only** (not each tiny commit), provide:

- `phase`, `DEV_COMPLETE / IN_PROGRESS`, `mainCommit`, `changedRecordIds`, `materialDiffScope`;
- the phase's full denominator and exactly **which semantic gaps remain**, rather than a vague partial row status;
- owned direct product decisions and source contracts; explicit handoff contract to the next phase;
- applicable changed-source tests, PASS/FAIL/NOT_RUN and negative cases, not an evidence/closure bundle;
- any materially necessary next-phase correction request, no broad reopened task sets.

**Terminal result requested by the user:** `PDP-0 DEV_COMPLETE, PDP-1 DEV_COMPLETE, PDP-2 DEV_COMPLETE, PDP-3 DEV_COMPLETE` on `main`, with a stable single-source-of-truth model, all applicable capability/domain/design/experience semantics complete, source-current public schema checks, development test suite green, and no contradictory ownership. **Do not claim** independent certification, production readiness, Lifecycle closure, convergence or release qualification.

**Current status authority:** the source-pinned PDP-0 through PDP-3 records linked from the [canonical PDP index](../../.product-experience/README.md) determine current phase status. The historical reopen notes, source counts, verification results, and terminal goal in this document describe their recorded cuts only; they do not report today’s phase state or schedule current work.
