# Finish Ghatana Media's 71 tasks — execution contract, not another review
**Owner instruction:** 2026-10-08, delegated Media owner. All implementation changes go to `main`, in small, validated changes; do not create long-lived integration branches. **Execution base:** `main@fcfba7c94c6bf5c86760b08b2ea9c3acc9d33849` (plus subsequent main-only repairs).  
**Canonical obligations and task Done semantics:** `.product-experience/pdp-0-product-truth/implementation-status-2026-10-07.json` (71 original task IDs and criteria), `docs/implementation/media-pdp-71-task-owner-execution-plan-2026-10-08.md`, and owning PDP source files.  
**Latest implementation batch:** `docs/implementation/media-owner-execution-batch-2026-10-08.{md,json}`. Source reports are historical captures; never rewrite past verification to make a current run look green.

## 0. Owner decision: measurable completion rather than proposal volume

1. No new optional capability families, template candidates, component identities or closure obligations just to increase apparent coverage. New **necessary** source requirements are allowed, but each added obligation must name its consumer need, owning source, source-derived test/oracle method and the corresponding impact on the 71-task goal. Record the denominator change; do not delete existing obligations to improve percentages. Current denominator after the 2026-10-08 source batch is **344**, not 319.
2. Finish selected scope *end to end*, then expand to the next source slice. Prefer changing actual typed operations, caller/worker contracts, test outcomes and source references to writing another narrative proposal. Any task remains `partial` until its original Done criterion is satisfied.
3. Media product-owner decisions are delegated and may be made for actual Media semantics backed by source. Do not ask again for the already approved PXD-026…PXD-039 decisions. Do not self-approve another repository's public contract, a specialist's independent review, legal licensing, model qualification or a Lifecycle receipt.
4. Four PDP phases describe complete **product definition**. A missing production Web host, optional codec or model activation must be reported on the implementation/release lane rather than used as a blanket definition-phase veto. A selected normative capability must nevertheless have an accurate source contract and affected error/finality/unknown behavior. Never use `NOT_APPLICABLE` to hide an in-scope requirement.
5. Every change batch must reduce at least one original criterion's open sub-obligations **or** resolve a concrete blocking defect. Proposals are inputs, not a completion event. Require a reproducible result under the exact source/dependency revision. Negative tests must fail under the violating input, not merely assert the desired state.
6. Cross-repository changes must be implemented in their owning repository's `main` after source-specific validation. Media should consume versioned public exports and never fork the Tools, Shared, Ghatana or Lifecycle implementation into an unowned local copy.
7. For 71/71, an actual legal/license/qualified/independent gate cannot be marked COMPLETE by a delegated owner who lacks that evidence. Request the concrete reviewer/provider deliverable; continue all unrelated source-backed work. No false completion promises.

## 1. Reconciled actual baseline and two denominator views

| Dimension | Verified in last committed batch | Must reach before declaring the relevant task complete |
| --- | --- | --- |
| Task status | **6 complete / 51 partial / 14 externally or independently gated** | All 71 original Done criteria satisfied; separate phase and release receipts |
| Public PDP projection fields | 1 PDP-0 / 0 PDP-2 / 10 PDP-3 semantic source mapping blockers | Zero unresolved *applicable* field mappings and current semantic-review results |
| Capabilities | 462 total; 383 unresolved exact leaf targets; 445 lack source-selected bounds | Every applicable leaf identifies typed intent/operation or proper nonapplicability; per-operation units/ranges/defaults/availability rules |
| Migration | 349 historical structural observations; 89 exact nonsemantic classifications; 260 semantic-content items including 124 mixed | Every normative claim reconciled once, changed plan compared claim-by-claim; historical pin not silently refreshed |
| Interface parity | 51 historical checker findings, 48 source-dispositioned and 3 open; **284** observed individual identities / **192** source-unresolved / **0** accepted full cross-interface bindings | Each historical finding and applicable individual interface has accepted exact source/operation identity and method-appropriate negative proof |
| PDP-3 experience | 47/47 definition-level template/layout links (0 independently admitted), 30 journeys and 130 step-screen refs, 18 step-action refs, 112 action gaps, 130 legal-transition gaps | Every applicable screen/step has complete named state, action, domain, guard, effect, finality, failure and accessibility/permission behavior |
| Lifecycle | 344 obligations: PDP-0 **38**, PDP-1 **146**, PDP-2 **83**, PDP-3 **77**; 282 without authored case ID, 337 without L-02 candidate link, 0 admitted provider/observer/oracle/receipt | 344 applicable source-scoped admitted proof routes (or independently reviewed N/A for genuine nonapplicable), native authoritative phase receipts |
| Technical verification | Affected tests 47/47; initial full Node 334/335 with *one sibling dirty-snapshot check failure* | Rerun full Node and affected integration/consumer suites; all failures classified and fixed, no stale source proof |
| Release | `INTERNAL_VALIDATION_ONLY` reference profile; models/codecs/providers NOT_ADMITTED | Separate immutable artifact, license/security/SBOM, native qualification, actual host/cutover and authorized release signoff |

**Important counter policy:** Do not conflate historical checker findings with 284 interface identities or the 349 migration-history rows with 260 currently actionable semantic claims. Do not claim that source-anchored Lifecycle case IDs equal admitted evidence.

## 2. Execution batches: source paths, exact targets, and completion gates

### B00 — Repair the actual full-suite failure and establish the current main proof
**Tasks:** G-01/G-02/G-04, L-08, X-04/X-05/X-06 freshness. **Where:** `tests/media-external-platform-contract-observation.test.mjs`, `docs/migration/external-platform-contract-observation.json`, `docs/implementation/verification/`.  
**Already changed on main:** test now compares the **seven exact reviewed Ghatana public contract files** against the pinned Git commit's file bytes and validates historical captured dirty-path classifications separately. Unrelated changes to the sibling worktree no longer make a historical source capture inconsistent. Changing a contract still fails.  
**Execute:** `node --test tests/media-external-platform-contract-observation.test.mjs`; then `node --test tests/*.test.mjs`; `pnpm generate:product-definition-manifest`; `node scripts/generate-media-phase-projections.mjs --check --strict`; `pnpm report:product-definition-residuals --json`.  
**Exit:** fresh documented full-suite outcome in the pinned checkout; no false green from skipped/unavailable sibling source or removed strict check. If a real watched source changed, adjudicate source semantics and update the snapshot *after* review. Always retain historical 334/335 evidence. GitHub CI is not currently reporting a check on main, so local logs must name exact head/toolchain.

### B01 — First canonical end-to-end domain slice: tenant/rights → upload → artifact → job
**Tasks:** P0-01/02/04/05/07, P1-01/02/03/05/10, P3-03/04.  
**Where:** `pdp-0-product-truth/{capability-leaf-review,capabilities,requirements,qualification-policy}.yaml`, `pdp-1-domain-data/{operations,action-contracts,states,transitions,authority,versioning,privacy}.yaml`, `contracts/openapi/media.yaml`, `runtime-contracts/`, `launcher/`, `libs/audio-video-client/`.  
**Do:** pick **one concrete operation at a time**; write exact stable ID, requester/tenant/project/source version, input schema/units/bounds, relevant rights/consent, idempotency, command/query type, legal state guard, emitted effect/finality, error and unknown-outcome resolution. Back-link every selected PDP-0 leaf, user/CLI/SDK action and wire handler. Add negative tests for cross-tenant request, revoked consent, stale artifact/job revision, duplicate idempotency key, cancellation race and missing admitted provider. Reuse real accepted contracts, not new organizational family names.  
**Exit:** first batch of actual leaves and identities becomes `SOURCE_BOUND_AND_TESTED`, with reviewer-scoped owner acceptance; counts decrease and **no corresponding unproven capability becomes runtime AVAILABLE**. Continue through nine bounded families, including caption/version, synthesis/authorized voice, vision/multimodal, stream, composition/render/delivery, simulation/spatial and provider/health.

### B02 — Real interface parity: 3 checker gaps, then the 192 individual identities
**Tasks:** P1-03/04/05/06/07/08, P2-07, P3-04/07.  
**Where:** `interface-parity/operation-parity.yaml`, `scripts/check-media-contract-parity.mjs`, `pdp-1-domain-data/operations.yaml`, `pdp-3-product-experience/{sdk,api,grpc,cli,agent-tools,events}/`.  
**Specific unresolved findings:**
1. `media.sdk.documentIntelligenceSceneTextAdapter.recognizeFrame`: distinguish a **Document Intelligence public client adapter** with Media temporal mapping from a Media HTTP endpoint. Record exact provider version/protocol/source identity; unless an actual matching Media wire operation exists, disposition as `NOT_ADMITTED` to Media OpenAPI, **not** as a successful Media route or generic OCR implementation. Regenerate manifests after changing PDP sources.
2. **Four Agent Tool handlers**: require closed input/result/error contract, qualified Shared invocation principal/delegation/tenant, bounded deadline, idempotent effect behavior, cancellation race, model/privacy/rights policy and safe `UNKNOWN` before declaring handler equivalence. Method names alone do not qualify.
3. **Canonical PDP-1 operation status**: owner-adjudicate each exact command/query *below* the nine families; do not change `scopeStatus` to ACCEPTED as a shortcut. Separate typed semantic identity from executable runtime parity and source-role classifications.
**Also:** SDK `retryOperation` still calls an absent legacy `/api/v1/media/operations/:retry` route; the current canonical job API has cancel but no retry. Implement a truthful canonical retry contract/server admission and client upgrade **only** with attempt/rights/policy/budget/nonce and unknown-outcome protection, or fail-closed without claiming retry support. Do not silently route to a nonmatching HTTP path.  
**Exit:** all 51 historical findings source-dispositioned and genuine accepted per-identity semantics for the relevant 284 current identities (increase/decrease only with documented source delta). Preserve exact OpenAPI, runtime, gRPC, SDK and CLI negative tests.

### B03 — Complete PDP-0 truth and migration without re-opening already closed local gates
**Tasks:** P0-01…08, G-03/G-05/G-06.  
**Where:** `pdp-0-product-truth/{goals-jtbd,quality-policy,requirements,capabilities,capability-leaf-review,migration-semantics-review}.yaml`, `docs/migration/{expert-reviewed-master-plan.md,master-plan-source-change-claims.yaml}`.  
**Do:** allocate all **383** unresolved leaves and **445** unbounded selected operation leaves to the typed operations/owner/constraints produced in B01/B02. Source-adjudicate the remaining **260** semantic claims one at a time (including **124 mixed**); retain exact PXD-033 and PXD-034 classifications; do not refingerprint an edited master plan until each changed claim's meaning is reviewed. Qualify the remaining PDP-0 success-measure mapping with explicit measurable intent/profile/acceptable qualitative or binary criterion; never invent measured baseline or model scores.  
**Exit:** zero source-ambiguous applicable leaves, normative migration semantics and PDP-0 projection fields, qualified independent P0-010 review packet ready. Treat missing model weights or deployed host separately.

### B04 — Repair Shared/CSP and finish reusable design authority
**Tasks:** P2-02/03/04/05/06/07/08/09, E-03/E-05, X-03.  
**Where:** `pdp-2-design-interface-system/design-governance.json`, `gui/{semantic-component-bindings,style-authority,templates/catalog,layout,recipes/catalog}.yaml`, `libs/audio-video-ui/`, Shared public design-system packages.  
**Do:** close three actual open gates (concrete export/prop binding, immutable Shared consumer/version, independent visual and assistive review). User-authorized Media design policy remains accepted for four already resolved gates. Fix Shared Button/Badge/Select/TextArea/TextField strict-CSP inline-style issues **at the Shared owner**; do not weaken production CSP, invent copies of Shared controls or auto-accept 47 screen implementations. Reconcile token units and light/dark/forced-colors, source/derived distinctions and zoom.  
**Exit:** 7/7 design gates with exact owner evidence and independent WCAG 2.2 AA reviews; 47 registered screen compositions only become accepted when their true reusable anatomy and behavior are proved.

### B05 — Complete PDP-3 actions, legal transitions, scenarios and machine experiences
**Tasks:** P3-01…10, E-01…05.  
**Where:** `pdp-3-product-experience/{journey-contracts,screen-contracts,action-registry,state-transition-bindings,recovery-finality-contracts,scenario-fixture-registry,search-inspection-contracts}.yaml`, `libs/media-experience-simulation/`, `libs/audio-video-ui/src/screens/MediaProductRenderer.tsx`, `apps/media-experience-explorer/`.  
**Do:** link **112 remaining** step actions and **130 legal transition contracts** to source-admitted PDP-1 operations, enforce effect/unknown/race/rights semantics, provide exact objects/state/authority and step-by-step success/failure/degraded postconditions. Close the **10** remaining ExperienceSpecification field mappings, 31 scenario fixture identities (the retry-eligible fixture cannot be fabricated), and all applicable Web/API/CLI/SDK/Agent/event exploration. Keep one public Media renderer and distinguish Explorer simulation from actual product implementation.  
**Exit:** 47 screen definition contracts and all 30 journeys/130 steps source complete with valid negative oracles; independent task and accessibility reviewers accept representative flows; no fake deployed product host.

### B06 — Turn source-only 344 Lifecycle obligations into admitted cases and real evidence
**Tasks:** L-01…08, X-01/X-02, P0-08/P1-11/P2-09/P3-10.  
**Where:** `config/closure/media-product-definition/{obligations,l02-source-case-links,l03-proof-route-candidates,phase-binding,phase-program,surface,pending-decisions}.json`, `scripts/conformance/evidence-definitions/`; actual Lifecycle provider public packages.  
**Do:** for every applicable obligation, identify exact semantic criterion, proof class/method, executable test/fixture, observer, positive/negative oracle, permission scope, source and transitive dependency fingerprints and accepted provider. **282** currently have no authored `caseIds`, **337** have no L-02 candidate link, all **344** have no admitted observer/oracle/provider/receipt. Reuse legitimate tests/criterion producers with obligation-specific scope; never auto-generate case IDs/observer IDs simply to fill rows. Solve [Tools #30](https://github.com/samujjwal/ghatana-tools/issues/30), [Lifecycle #1](https://github.com/samujjwal/ghatana-lifecycle/issues/1) provider ownership and actual `UNLICENSED` distribution/authorized internal-use posture. No Media-private Evidence Generator.  
**Exit:** admitted 344-applicable source proof routes (or owner-approved genuine nonapplicability), current native proof results, valid four Lifecycle phase receipts. Missing reviewer/proof outputs remain BLOCKED, not administratively approved.

### B07 — Cross-repository public contracts and independence
**Tasks:** X-01…09, P0-08, P1-11, P2-08/09, P3-10, E-05.  
**Where:** Tools [#30](https://github.com/samujjwal/ghatana-tools/issues/30), Lifecycle [#1](https://github.com/samujjwal/ghatana-lifecycle/issues/1), Shared [#234](https://github.com/samujjwal/ghatana-shared/issues/234), Ghatana [DI #252](https://github.com/samujjwal/ghatana/issues/252), [AI Inference #253](https://github.com/samujjwal/ghatana/issues/253), [Data/Action/Event #254](https://github.com/samujjwal/ghatana/issues/254); Media [independent-review #4](https://github.com/samujjwal/ghatana-media/issues/4).  
**Do:** qualify installed public artifacts, resolve DI `0.1.0`/extraction SNAPSHOT peer policy, ensure typed audio/vision/multimodal contracts are **not** passed to text-only inference endpoints, preserve exact 201 Event Plane semantics, scope TutorPutor reuse to selected capabilities, finish source cutover/rollback with all consumers. Obtain independent actual reviews of domain, quality, privacy, security, visualization, assistive technology and licensing only where required by selected claims.  
**Exit:** no unresolved **required** external semantic binding for selected PDP contract, with separate runtime activation decisions and qualified consumer tests.

### B08 — Complete the actual product and authorized release profile
**Tasks:** R-01…05, X-08/X-09.  
**Where:** `config/release/internal-validation-only.json`, `docs/qualification/`, `providers/`, `launcher/`, `runtime-contracts/`, public Media Web host and deployment/cutover manifests.  
**Do:** qualify specific codec/container/color/time/metadata profiles and model weights/language/holdout/calibration with license/tenant/rights checks; prove storage/outbox/crash/replay/erasure/resource behavior, production-host renderer and schema parity, monitored SLOs and rollback. Preserve internal-only current profile as **NOT_ADMITTED** for external effects, not a counterfeit release approval.  
**Exit:** reproducible immutable build, complete SBOM/license/signature, deployment/runtime and rollback evidence, authorized owner go-live. If public release isn't authorized, mark release tasks appropriately incomplete; PDP semantic receipts remain independent.

## 3. Implementation agent operating contract — no more review-only loops

For each batch:
- Read current `main`, historical batch report, original 71-ID ledger and exact owning source. Do **not** restart completed local tasks or fabricate progress by adding new candidate collections.
- Make bounded source changes on `main`; run focused affected test/negative oracles **before** committing, then regenerate PDP projections/source manifest when a PDP authority changed; always recheck full source denominator integrity and `git diff --check`.
- If an independently reviewable decision belongs to the Media owner and has exact source evidence, adjudicate it under user delegation and record the precise scope. If a legal/independent owner or public package is required, open/advance the exact owner ticket and continue source-only work elsewhere rather than waiting.
- For every claimed completed task, cite the original Done criterion, actual modified owning files, real command and exit code, verified source+test digests, and the signer/provider if required. A pending provider or a planned test cannot satisfy Done.
- Update the **same** 71 task ledger only for actual criterion status changes; also publish the current dynamic residual and Lifecycle denominator. A changed count with zero new completed tasks is **partial progress**, not task closure.
- Stop expanding source proposals when a smaller implementation/backfill can satisfy an existing requirement. Use bounded family/operation/step slices rather than trying to approve 383 leaves or 344 proofs in one batch.
- Do not claim background execution, pass status, independent review, four PDP receipts or release unless actual tools and authorities completed them.

**Concrete next command sequence:**
```sh
git status --short && git rev-parse HEAD
node --test tests/media-external-platform-contract-observation.test.mjs
node --test tests/*.test.mjs
pnpm generate:product-definition-manifest
node scripts/generate-media-phase-projections.mjs --check --strict
pnpm report:product-definition-residuals --json
pnpm check:contract-parity     # expected NON-GREEN until three real gaps are resolved
pnpm check:design-conformance  # expected BLOCKED until three real gates are qualified
pnpm check:lifecycle-closure-inputs
git diff --check
```

**Priority decision:** The next implementation batch after B00 must target B01/B02 exact artifact/job/action/SDK operation semantics and associated typed tests, not add new 71-task planning prose. After source changes regenerate source/phase projections. Report counts only after observing their actual output.
