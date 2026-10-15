# Media PDP-1 MDC-30 definition-surface audit

**Campaign scope:** Discovery / PDP-1 operation and typed-result definitions required by `MDC30-C-03`, `C-04`, `C-16`, `C-22`, `C-25`, and `C-27`; 18 affected PDP-3 channel edges are downstream consumers, not additional PDP-1 surfaces.\
**Source baseline:** `e58e67084a4871dc21fb10523f0bcd0df8167d47`; `operations.yaml` SHA-256 `317878be9ebe9c978f356a4e81060620fcb69af02ea25c2ff1d47bd20180c069`.\
**Macro stage / phase:** DISCOVERY / PDP-1.\
**Prerequisite state:** PDP-0 R5 and PDP-1 R13 technical source-current records are current at this baseline; PDP-1 exact-cut owner acceptance is not recorded. PDP-3 remains incomplete; the Discovery barrier is FAIL.\
**Permitted work:** repair the file's intent header and stale guidance inventory, record the delegated internal Media decisions, define the missing PDP-1 operation/result joins, add focused negative tests, then recapture affected phases in order. No transport admission, runtime implementation, Lifecycle closure, independent specialist signoff, or release claim.

## Surface and audit inputs

The selected surface is the normative Media PDP-1 operation registry, `.product-experience/pdp-1-domain-data/operations.yaml`, validated by the Media source checks and tests rather than a standalone runtime build unit. The six task groups and exact missing joins are recorded in `docs/implementation/observations/media-discovery-pdp3-mdc30-implementation-progress-2026-10-14-r4.json`; task acceptance and ordering are defined in `docs/implementation/MEDIA-DISCOVERY-REMAINING-CURRENT-CUT-EXECUTION-2026-10-13.md`.

Inspected: root `AGENTS.md`; root and `docs/` READMEs; `.product-experience/README.md`; `docs/VISION.md`, `REQUIREMENTS.md`, `ARCHITECTURE.md`, `DESIGN.md`, `EXAMPLES.md`, `TESTING.md`, and `EVIDENCE.md`; PDP-1 `DOMAIN-MODEL.md`, `authority.yaml`, `operations.yaml`, and its source review; the relevant J03/J04/J16/J22/J25/J27 journey contracts; PDP-3 channel bindings, purpose bindings, operation-binding tests, channel-binding tests, and operation-state proof code; and the R4 implementation-progress record.

## Mandatory Surface Closure Matrix

| Area | Status | Evidence inspected | Finding / action |
|---|---|---|---|
| Prompt/repo guidance | `gap-found` | Root `AGENTS.md`; `.product-experience/mandatory-surface-closure-matrix.yaml#repoGuidance.discovered` | **G1:** repair the inventory that incorrectly says no `AGENTS.md` exists; retain the four-stage phase protocol. |
| Recursive inventory | `reviewed-no-gap` | PDP-1 R13 source observation; `operations-current-source-review.json` | The exact source file and its material fingerprint are recorded. |
| Surface kind/build unit | `reviewed-no-gap` | PDP-1 `DOMAIN-MODEL.md`; `operations.yaml` schema/header | Normative YAML source, exercised by source checks and tests; no runtime build unit is implied. |
| Ownership/boundary/placement | `reviewed-no-gap` | `operations.yaml` header; `authority.yaml#ownership` | Media owns product-operation meaning; external identity, delegation, and execution mechanisms remain externally owned. |
| Vision/non-goals/consumers | `reviewed-no-gap` | `docs/VISION.md`; `docs/ARCHITECTURE.md`; `.product-experience/README.md` | Product scope and non-owning platform boundaries are documented. |
| Architecture/design | `gap-found` | `operations.yaml`; R4 task audit | **G2:** add exact operation/result joins, preserving typed finality and recovery without inventing transitions or endpoints. |
| Documentation/examples | `gap-found` | `operations.yaml` header; docs index; `docs/EXAMPLES.md` | **G1:** add in-file purpose, consumers, non-goals, and change policy required for a normative file. |
| Requirements/current-state alignment | `gap-found` | Root README; docs README; PDP-1 R13 exit; R4 task audit | **G3:** distinguish source currentness/`DEV_COMPLETE`, exact-cut acceptance, and the six task-local definition gaps. |
| Gap/backlog classification | `gap-found` | R4 task audit; execution plan C03/C04/C16/C22/C25/C27 | **G3:** the confirmed missing joins are current Discovery definition work, not feature backlog. |
| Feature completeness | `gap-found` | R4 six-task audit | **G2:** finish only the six task-specific operation/result joins. |
| Correctness | `gap-found` | R4; transcription submission contract; C22–C27 plan sections | **G2:** prevent false completion/approval/delivery, identity mismatch, delegated result confusion, and fallback from unknown status. |
| API/contracts/config | `gap-found` | `operations.yaml`; R4 C22/C25/C27 findings | **G2:** define the delivery fingerprint, typed delegated job/output results, and current fallback eligibility/opt-in joins. |
| Generated/source-of-truth parity | `reviewed-no-gap` | `docs/DESIGN.md`; `operations-current-source-review.json` | `operations.yaml` is authored; manifests and projections follow declared generators. |
| Naming | `reviewed-no-gap` | `operations.yaml` header and stable `media.operation.*` identities | Existing identity vocabulary is consistent with the canonical domain registry. |
| Duplication | `reviewed-no-gap` | `operations-current-source-review.json` historical reconciliation rows | Existing source reconciliation preserves distinct operation and wire roles. |
| Organization/placement | `reviewed-no-gap` | PDP-1 `DOMAIN-MODEL.md`; PDP-1 directory | Domain operation/result meaning belongs in PDP-1; journey/channel projection belongs in PDP-3. |
| Cohesion/coupling | `reviewed-no-gap` | `operations.yaml` source refs and authority header | The registry is the declared canonical operation source; no runtime coupling is asserted. |
| Tests/coverage | `gap-found` | Existing typed-observation, owner-wire, job-status, transcription, and channel-binding suites | **G4:** add focused positive/negative cases for new joins, unknowns, and stale or mismatched identities. Historical passes do not prove new material. |
| Compatibility/migration/deprecation | `reviewed-no-gap` | Operation request/recovery definitions; `docs/TESTING.md` | Transport bindings remain unadmitted; no new compatibility promise is required by this definition slice. |
| Affected-scope verification | `reviewed-no-gap` | Current-cut plan; `docs/TESTING.md` | Run the focused P1/P3 contract checks and phase recaptures only after edits settle; broad Build proof is outside Discovery. |
| Evidence Generator integration | `reviewed-no-gap` | `docs/EVIDENCE.md`; PDP-1 R13 observation | Lifecycle owns currentness and receipts; Media checks do not claim closure or convergence. |
| Missing Evidence Generator capabilities | `not-applicable` | `docs/EVIDENCE.md`; selected R4 source gaps | No missing collector is evidenced; source definitions, focused checks, and the existing Lifecycle currentness path are available. |
| Security | `gap-found` | `authority.yaml`; typed rights-decision contract; R4 C04/C25/C27 findings | **G2:** join exact consent/voice authority, delegated results, and fallback guards; never assert an external observation. |
| Privacy/data governance/compliance | `gap-found` | `operations.yaml` scoped guards; R4 C04/C27 findings | **G2:** bind consent/profile/source and exact rights/fallback evidence; retain tenant scope, retention, and fail-closed unknowns. |
| Observability/diagnostics | `gap-found` | `authority.yaml#jobStatusRead`; R4 C22/C25 findings | **G2:** bind exact request fingerprints, owner read authority/version, and result identity end to end. |
| Reliability/resilience/operability | `gap-found` | `operations.yaml` same-identity recovery semantics; R4 C22/C25/C27 findings | **G2:** complete task-specific delivery ACK, delegated result, status, and fallback recovery joins. |
| Performance/scalability | `reviewed-no-gap` | TTS request bounds; job-status freshness rules | Inspected schemas bound relevant fields and query freshness; provider capacity remains unclaimed. |
| Accessibility/internationalization | `not-applicable` | Machine operation/result scope; PDP-2 interface grammar | This source defines machine semantics; UI accessibility remains in PDP-2/PDP-3. Locale data remains explicit at operation inputs. |
| AI/ML applicability | `gap-found` | TTS and dub operation schemas; R4 C03/C04/C16 findings | **G2:** complete exact request-to-output/provenance joins; keep provider/runtime/qualification `NOT_ADMITTED`. |
| Build/dependency/release readiness | `not-applicable` | Root README; `docs/ARCHITECTURE.md` | This is Discovery source definition; Build, runtime, delivery, and release are later gates. |
| Dependency/supply-chain/licensing | `not-applicable` | `operations.yaml` source scope | No package dependency set is owned here; rights/licensing semantics are reviewed under security and privacy. |
| Repeatability/reproducibility | `reviewed-no-gap` | PDP-1 R13; `operations-current-source-review.json` | Exact material fingerprints are available; recompute after edits and do not reuse stale projections. |
| Convergence/stability | `gap-found` | R4 next-action section; PDP-1 R13 exit | **G3:** resolve phase-currentness versus exact-cut acceptance and reopen only the affected P1 definitions before downstream recaptures. |

## Findings and acceptance

**G1 — Source intent and guidance inventory.** Add purpose, consumers, non-goals, and change policy to the top of `operations.yaml`; correct the root-guidance inventory in the existing applicability matrix. Acceptance: the source intent is explicit and the inventory matches the live checkout. Focused evidence: `pnpm check:product-experience-local` and the source manifest check.

**G2 — Six PDP-1 operation/result joins.** Root cause: individual schemas exist, but not all task-specific result, request identity, and authorization relationships are exact. Define them in canonical P1 operation/observation records, keep unavailable/stale/mismatched inputs `UNKNOWN`, add exact P1 journey-operation relations, then bind affected PDP-3 edges. Acceptance: every affected channel edge has complete exact-operation coverage, exact identities and authorities, typed denied/unknown/timeout/recovery semantics, and adversarial checks for partial or invented refs. Transport remains `UNBOUND`; runtime remains `NOT_ADMITTED`.

**G3 — Phase and task status reconciliation.** PDP-1 R13 is technical currentness at its exact input, not owner acceptance and not evidence that newly identified task gaps are already resolved. Preserve R13 as history, record the new P1 meaning decision and its affected task IDs, then issue a new source-bound PDP-1 currentness/status capture after tests pass. Reopen only PDP-1 and affected descendants.

**G4 — New-definition test evidence.** Add behavior-focused tests for exact source/request/result linkage, denied and ambiguous outcomes, stale or mismatched observations, output absence, recursion, and fallback opt-in/resource checks. Acceptance: focused suites reject malformed or partial joins and pass on the same source bytes later captured by the phase records.

## Evidence plan recorded before implementation

**Scope fingerprint input:** baseline commit above plus SHA-256 of `operations.yaml`, `authority.yaml`, the six named journey contracts, `journey-purpose-bindings.yaml`, `journey-channel-contract-bindings.yaml`, and the P1/P3 operation-binding tests. Recompute after each phase's source edits; use one stable fingerprint for each capture.

**Expected artifacts:** internal delegated P1 decision entry; authored P1 operation/observation and journey-operation definitions; focused source tests; regenerated PDP-3 step/oracle projection where required; updated source-current review; immutable PDP-1, affected PDP-2, and PDP-3 technical currentness records; actual browser evidence only if MDC-31 prerequisites pass. Historical receipts remain unchanged.

**Commands:** run affected typed-observation, transcription, TTS request-origin, owner-action-wire, job-status, P1 journey-operation-binding, PDP-3 channel-binding, and step-definition-oracle suites; `pnpm check:product-experience-local`; `pnpm check:product-definition-authority`; required P1/P2/P3 capture commands from the current-cut plan. Re-run generated projections via their repository scripts, never manual edits. No repository-native Evidence Generator enhancement is identified by this scope audit.

**Repeatability:** record command, exit status, and source fingerprint for every run; repeat deterministic source checks against unchanged bytes before publishing each observation. Run shared/generated-source mutations sequentially. Do not run runtime/build, Lifecycle closure, or Delivery work while the Discovery barrier is FAIL.

**Audit disposition:** `not-converged-actionable`; implementation may proceed for G1–G4 under the user-delegated Media semantic authority, with currentness and later phase gates preserved.
