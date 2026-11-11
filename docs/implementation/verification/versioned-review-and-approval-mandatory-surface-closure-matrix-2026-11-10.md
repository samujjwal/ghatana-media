# Versioned review and approval — Mandatory Surface Closure Matrix

Date: 2026-11-10<br>
Scope: `modules/production/review` (sources, tests, build file, and module README), for OPEN task `media.dev.versioned-review-and-approval`.<br>
Source contracts: `.product-experience/pdp-3-product-experience/journey-contracts/review-exact-version-and-recheck-changes.yaml` (J-21); `.product-experience/pdp-1-domain-data/operations.yaml` (record-version-review-decision); `.product-experience/pdp-2-design-interface-system/gui/patterns/review-approval.yaml`.<br>
Scope excludes UI, launcher, `runtime-contracts`, and the shared remaining-work ledger.

## Audit basis and disposition

Inspected root `AGENTS.md`, module source/test/build/docs, exact PDP references above, task row in `docs/development/remaining-work.json`, and repository verification/evidence paths. The module is an additive local Java implementation. Its task row is `OPEN`; this review does not alter that canonical state. J-21 distinguishes the review-record append receipt from a separate, current `HUMAN_REVIEW_APPROVAL` observation and keeps approval mutation blocked. No approval, admission, qualification, or lifecycle status is inferred here.

The current source/test diff closes one demonstrated local race: on a stale exact-decision retry, authorization/currentness/retention are checked again after the store read and before returning the stored receipt. The regression revokes the reviewer during readback and confirms that no receipt is returned and no second record is appended. The module README now documents the source boundary, API, architecture, requirements, example, tests, evidence and change policy.

## Mandatory Surface Closure Matrix

| Area | Status | Evidence inspected/artifact | Findings | Action |
|---|---|---|---|---|
| Prompt/repo guidance | reviewed-no-gap | Root `AGENTS.md`; no nested module `AGENTS.md`; scoped instructions in this audit | Guidance permits local engineering but forbids implying lifecycle/approval authority. | Preserve the distinction in code/docs. |
| Recursive inventory | reviewed-no-gap | `find modules/production/review -type f`; tracked source/test/build/README inventory | Main source is `ReviewContracts`, `VersionedReviewEngine`, `InMemoryReviewStore`; one focused test class. Existing build outputs are generated artifacts. | Keep build outputs out of source edits. |
| Surface kind/build unit | reviewed-no-gap | `modules/production/review/build.gradle.kts`; Gradle project path in task evidence | Java module; focused owning selector is `:services:media:modules:production:review:test`. | Compile/test this unit. |
| Ownership/boundary/placement | reviewed-no-gap | Module README; `ReviewStore`, `AuthorizationPort`; `AGENTS.md` boundary rules | Local engine owns validation/reconciliation; host owns identity, issued cases, roles and approval. | Do not wire forbidden external surfaces in this task. |
| Vision/non-goals/consumers | implemented | Updated module README purpose, vision, non-goals and consumers | Prior README described behavior but omitted explicit required surface sections. | README repair is in scope and complete. |
| Architecture/design | implemented | README; `VersionedReviewEngine.java`; `ReviewContracts.java`; `InMemoryReviewStore.java` | Stale exact replay readback needed a second authority check before its receipt was disclosed. | Reauthorize after readback; preserve typed fail-closed behavior. |
| Documentation/examples | implemented | Updated module README | Adds API/boundary, architecture, requirements, example, test/evidence commands, compatibility/change policy. | Keep references aligned as contracts evolve. |
| Requirements/current-state alignment | reviewed-no-gap | Task row and J-21/PDP-1/PDP-2 source references; module README | Local append/read behavior is a partial task increment; durable owner authority, project CAS, UI/runtime, and actual approval remain absent. | Keep task OPEN and these owner gaps explicit. |
| Gap/backlog classification | reviewed-no-gap | Current code contracts, task acceptance, J-21 approval boundary | Post-readback authorization is a current security/correctness gap; real owner integration is an external task gate. No new feature proposed. | Repair only the local race. |
| Feature completeness | reviewed-no-gap | `VersionedReviewEngineTest`; task acceptance; module README | Exact-version append/replay/read behavior is local only; the complete user journey is intentionally partial. | Do not claim end-to-end review/approval completion. |
| Correctness | implemented | `VersionedReviewEngine.java` stale-replay branch; test `staleExactRetryRechecksAuthorizationAfterStoreReadback` | A revocation during `ReviewStore.read` previously could race with receipt return after authorization was checked before readback. | Fresh authority check now occurs after readback; denied caller gets no receipt. |
| API/contracts/config | implemented | `ReviewContracts.java`; PDP-1 operation; `config/intentional-public-api.json` | The additive local review API is mapped to existing `MEDIA-REQ-CAP-PROJECT`; verifier aligns all 39 compiled public types. No public wire schema or approval semantics changed. | Preserve the project-review requirement mapping; do not treat registry alignment as admission or approval. |
| Generated/source-of-truth parity | reviewed-no-gap | Java contracts versus exact PDP selectors; no generated source in module inventory | No local generated artifacts or schema generator for the selected package. | No generation action applies; preserve PDP source refs. |
| Naming | reviewed-no-gap | Package/class/record names in module inventory | Names distinguish review records, receipt, authority and approval. | No rename needed. |
| Duplication | reviewed-no-gap | Source/test inventory and the single engine/store implementation | The reauthorization uses the existing `authorize` validator; no parallel authorization path added. | Keep validation centralized. |
| Organization/placement | reviewed-no-gap | Module path and `build.gradle.kts` dependencies | Production review logic is isolated in its production module and uses runtime contracts. | No placement change needed. |
| Cohesion/coupling | reviewed-no-gap | Engine dependencies and port interfaces | Engine is coupled only to local contracts/ports and injected collaborators. | Owner integrations remain adapters in their owning surfaces. |
| Tests/coverage | implemented | Focused regressions `staleExactRetryRechecksAuthorizationAfterStoreReadback` and `staleExactRetryRejectsAuthorityThatExpiresDuringStoreReadback`; adjacent stale replay and denial tests | Regressions deterministically revoke or expire authority during the exact store read. | Run complete focused class; retain no-write and no-disclosure assertions. |
| Compatibility/migration/deprecation | reviewed-no-gap | Public receipt/contract types; build dependency list | No schema, migration, or dependency changed. | No migration/deprecation required. |
| Affected-scope verification | reviewed-no-gap | Evidence plan companion | Focused Gradle test is sufficient for local engine behavior; wider runtime/UI tests are excluded because those paths are not changed. | Run owning module selector and diff checks. |
| Evidence Generator integration | blocked | Checkout has no `tools/`, `discover-evidence-tools.mjs`, or local generator command; `docs/EVIDENCE.md` assigns canonical artifacts to Lifecycle | Required repository-native generator artifacts and score provenance cannot be produced here. | Owner-native run is needed for convergence; see EG task below. |
| Missing Evidence Generator capabilities | blocked | Same repository inventory and `docs/EVIDENCE.md` | No path-scoped collector/gate for review receipt redaction, authority-after-readback, exact-version binding, or repeatability was discoverable. | Define/implement the exact generator capability at the owning Lifecycle generator. |
| Security | implemented | `VersionedReviewEngine.java`; focused revocation and expiry regressions; J-21 | Stale retry receipt must not disclose after reviewer revocation/expiry. This path now reevaluates the injected authority after readback. | Focused tests assert revoke/expiry yields no receipt and does not append another record. |
| Privacy/data governance/compliance | reviewed-no-gap | `ReviewContracts.java`; `redacted`/`sanitize`; README | Tenant and exact case/version are bounded; text is sanitized before store and disclosure. No compliance certification is present. | Do not claim compliance or approval from local tests. |
| Observability/diagnostics | reviewed-no-gap | Typed errors in `ReviewContracts.java`; engine exception boundaries | Adapter/sanitizer details are hidden behind typed unavailable outcomes; this local module defines no metrics/tracing surface. | Host may add diagnostics without exposing review text or secrets. |
| Reliability/resilience/operability | reviewed-no-gap | Engine replay handling; store port contract; failure tests | Uncertain store outcomes fail closed and callers retain request ID for reconciliation. Durable restart behavior belongs to external store integration. | Preserve unknown-outcome semantics. |
| Performance/scalability | reviewed-no-gap | Stale retry does one additional authorization evaluation after its read | Added one authority call only on stale exact decision reconciliation; no benchmark/production scale claim. | Measure at host integration if this path is material. |
| Accessibility/internationalization | not-applicable | Headless Java module; no UI or user-rendered surface in scope | Accessibility belongs to the UI consumer; locale-stable exact version formatting is separately tested. | UI review remains outside this scope. |
| AI/ML applicability | not-applicable | Deterministic record validation/storage; no model dependency or inference path | AI/ML does not improve authorization or exact receipt reconciliation. | Keep authority decisions deterministic and host-owned. |
| Build/dependency/release readiness | implemented | `modules/production/review/build.gradle.kts`; serialized `:services:media:modules:production:review:check` | Full module check now passes, including `verifyIntentionalPublicApi` (39 public types aligned); checkstyle/PMD ran and emitted non-fatal style warnings. | Keep the owner registry aligned as the public API evolves; use no verifier exclusions. |
| Dependency/supply-chain/licensing | reviewed-no-gap | Module dependency declaration | Uses existing Java module, JUnit Jupiter and AssertJ; no dependency was introduced. | No dependency/license action in this slice. |
| Repeatability/reproducibility | reviewed-no-gap | Deterministic test fixture and companion evidence plan | Regression uses fixed clock, explicit IDs and ordered store wrapper; canonical score repeatability is unavailable with no generator. | Re-run the same focused command under recorded environment. |
| Convergence/stability | blocked | Matrix and evidence plan; task row remains OPEN | Local source fix can be verified, but owner ports and generator-backed proof remain open; this is not task or surface convergence. | Retain OPEN; next review focuses on authentic authority, shared project CAS, runtime/UI, durable store evidence and generator route. |

## Findings

### RV-01 — Authorization race while reconciling a stale exact retry

- Priority: P1; area: correctness/security.
- Where: `VersionedReviewEngine.append`, stale `DecisionRecord` replay branch after `findExactReplay`; regression in `VersionedReviewEngineTest.staleExactRetryRechecksAuthorizationAfterStoreReadback`.
- Problem/root cause: authorization was checked before the store read. If the reviewer was revoked while that read was in flight, the old logic returned the committed receipt using the stale decision.
- Production-ready fix: re-evaluate the same operation against the same actor/case after readback; require expected authority version, known currentness and non-expired validity before constructing the receipt. Existing `authorize` also rejects denial, identity/scope mismatch, and inactive retention.
- Acceptance: revocation during read returns `ReviewDeniedException`; expiry during read returns `ReviewUnavailableException`; neither path returns the receipt or appends another record; ordinary exact stale retry still returns its original stale receipt when authority is current.
- Path tests: full `VersionedReviewEngineTest`, including stale replay success, revocation-during-read, and expiry-during-read regressions.
- Path evidence: focused Gradle JUnit report/log plus source/test hashes from companion evidence plan.
- Evidence Generator enhancement: `EG-MEDIA-REVIEW-EXACT-REPLAY-AUTHORITY-001` (below) for canonical collection and provenance; generator absent in this checkout.
- Classification: current-state gap, now locally implemented.
- Convergence impact: closes local receipt-disclosure race only; no approval or task completion claim.

### RV-02 — Public API ownership registry was incomplete (resolved locally)

- Priority: P1; areas: API/contracts/config and build/dependency/release readiness.
- Where: root `config/intentional-public-api.json`, review package selector.
- Resolution: the coordinator added `type-family:com.ghatana.media.production.review.*` with classification `requirements` and the existing `MEDIA-REQ-CAP-PROJECT` source requirement. The verifier now aligns all 39 compiled types; no API was hidden and no gate was bypassed.
- Verification: focused `VersionedReviewEngineTest` passes 40/40; serialized module `:check` passes.
- Scope: this resolves local API ownership/build readiness only. J-21 approval, runtime wiring, durable case/revision authority, and Evidence Generator convergence remain separate OPEN work.

### EG-01 — Missing repository-native path evidence and convergence proof

- Priority: P2; areas: Evidence Generator integration, missing capabilities, convergence/stability.
- Where: repository evidence tooling inventory; no local `tools/`, discovery script, or path-scoped Evidence Generator entrypoint.
- Problem/root cause: this checkout cannot generate required scope fingerprints, affected-unit/test manifests, schema-validated gates, score inputs/provenance, repeatability, or convergence result for this surface.
- Production-ready fix: Lifecycle Evidence Generator owner adds path scope `media.production.review.versioned-review-and-approval` and a collector/gate for exact receipt identity, stale replay, post-readback authority, typed denial/expiry, and no duplicate append. Produce generator-owned schema-valid artifacts and score provenance from the local JUnit output and source fingerprint.
- Acceptance: same scope+revision+environment repeat deterministically; stale/wrong-scope/manual artifacts fail; revocation or expiry between read and disclosure blocks receipt; artifact distinguishes review receipt from `HUMAN_REVIEW_APPROVAL`; generated gate and score inputs validate.
- Path-scoped tests/evidence: generator schema/collector/gate tests and this module's focused JUnit selector; generator command, run ID, artifact directory, schema validation and repeatability output.
- Evidence Generator enhancement: required as `EG-MEDIA-REVIEW-EXACT-REPLAY-AUTHORITY-001`; no local implementation attempted because owner tool is absent.
- Classification: current-state evidence gap for convergence; no source-code behavior gap remains from this finding.
- Convergence impact: blocks `trusted-converged`; local implementation may be reported only as engineering progress.

## Final closure decision

`blocked-on-evidence-generator`. Local repair and audit artifacts are prepared, but the Lifecycle-owned evidence route is absent from this checkout, and the module's full `check` remains blocked on the public API ownership registry. The task remains OPEN for owner authority, shared project-revision CAS, durable/runtime/UI integration, registry reconciliation, and authentic approval evidence. Do not alter the canonical task state from this local review.
