# Ghatana Media — prescriptive Discovery source-currentness reconciliation and exit plan

**Campaign scope:** Entire `samujjwal/ghatana-media` Discovery (PDP-0→3), including physical leaves, semantic compositions/root and channel consumers.
**Baseline:** GitHub `main@90065c229debe88ca2143e58cad708d5ebc83cf5` on 2026-10-13; validate `HEAD` and source digests again before execution.
**Stage:** DISCOVERY. **Active phase:** PDP-0; PDP-1/PDP-2/PDP-3 sections below are dependency-ordered future tasks, **not current-phase authorization**.
**Denominator:** 26 physical manifest candidates (12 PHYSICAL, 12 SUPPORT_ONLY, 2 SUBSUMED), six semantic compositions and one repository root; 17 separate consumer-crosswalk entries (one archived). The 17 are not independent copies of 26 physical units.
**Prerequisite/gate:** PDP-0 currentness FAIL/UNKNOWN, despite prior `DEV_COMPLETE` definition cut; later PDPs currentness UNKNOWN; Build not entered.
**Owner decision:** [MEDIA-DISCOVERY-CURRENTNESS-OWNER-2026-10-13](../../.product-experience/reviews/2026-10-13-pdp0-discovery-delegated-review.md), APPROVED WITH COMMENTS.

## Outcome, non-goals and completion rule

**Deliver one source-current Discovery outcome without redoing already complete meaning.** All four PDPs must have `DEV_COMPLETE` and zero outstanding *meaning* IDs **and independently observed current source sets for every applicable physical, compositional and consumer binding**, with explicit N/A reasons. A historical phase `DEV_COMPLETE` is not the same as currentness. The existing records are immutable historical witnesses until a new, separately source-bound observation is produced. An actual new meaning defect is fixed in its owning phase with narrow downstream invalidation.

Do **not** treat build integration, provider deployment, migration, independent legal/security/accessibility review, Lifecycle closure, receipts or release qualification as Discovery authoring. **Do** verify the developer Experience Explorer can inspect the latest complete definitions and failures honestly; it is a Discovery presentation/projection, not a fifth phase or proof of a live product.

Existing input sources and single-owner contracts:
- `.product-experience/pdp-0-product-truth/` (intent, actor, requirement, capability, policy, ownership, applicability);
- `.product-experience/pdp-1-domain-data/`, `.product-experience/interface-parity/` (canonical objects, operations, states, guards and typed channel boundaries);
- `.product-experience/pdp-2-design-interface-system/` (GUI and headless interface grammar, Shared design bindings, components/tokens/layouts);
- `.product-experience/pdp-3-product-experience/` (screen, journey, command, RPC, event, agent and other complete user/machine experiences);
- `.product-experience/surface-registry.yaml` and `.product-experience/surfaces/media-physical-topology.v1.json` (separate channel and physical/composition ownership);
- `docs/implementation/pdp-{0,1,2,3}-phase-dev-status.json` (historical source cuts), `docs/implementation/post-pdp-current-status.json` (prior derived projection), and `config/closure/media-product-definition/` (**separate future Lifecycle closure lane**).

## Review and engineering rules, already authorized

1. Earliest failing phase first; classify `NORMATIVE_MEANING`, `SCOPE/APPLICABILITY`, `OWNER_CONTRACT`, `PROJECTION/STATUS`, `TEST/TOOL`, `BUILD_IMPLEMENTATION`, `EXTERNAL_OBSERVATION`. Fail closed on unknown. Record exact source paths, meaning IDs, owners, dependency effect and before/after material digests. No source-status changes merely because time or a Git SHA changed.
2. Prove material membership as well as bytes: the 107 historical PDP-0 pins do not bind current `surface-registry.yaml` or `media-physical-topology.v1.json`. A new reviewed material set must. Do not recursively pin generated state into itself; avoid circular dependencies. Keep source-authoritative paths separate from derived views and from runtime code.
3. Reuse Lifecycle's `ghatana.repository-source-currentness.v1` if its versioned **public** export exists. Its declared-path content/membership fingerprint, owner graph, physical catalog, provider-registry fingerprint, continuity and conservative full-revalidation semantics are appropriate. Verify public API contracts before importing. Otherwise file a small generic Lifecycle API/adaptor contract request, not a second Media hashing engine; a temporary Media observer may report `UNKNOWN`, never `CURRENT` without authority.
4. For every physical phase cell, retain exact topology `phaseApplicability[phase]` disposition, rationale, source/authority refs and implementation ref *as observations*; `NO_IMPLEMENTATION_ADMITTED` does not erase product intent. `NOT_APPLICABLE_SUPPORT` and `REFERENCED_ONLY` require provenance. For components, distinguish `CONTAINS` (deduplicated physical membership) and `DEPENDS_ON` (non-containment); direct cross-child meaning belongs to compositions, not copied child definitions. Root is aggregate/reference, not duplicate owner.
5. Consumer contract compatibility gets a single inventory identity in `surface-registry.yaml` and exact physical/cross-channel mapping in topology. An API-only/CLI-only/SDK/event/tool experience must still have relevant PDP-2 and PDP-3 typed grammar and error/denied/unknown/recovery model; it does not need a GUI or pretend runtime admission.
6. Preserve 462 PDP-0 leaf decisions, 448 PDP-1 canonical schemas+14 capability bindings, 79 action wires, 55 guards, 31 design component families, 47 screens, 30 journeys/130 ordered steps, 147 actions and 31 scenarios. Reconcile numbers from actual canonical sources if they change, do not enforce stale constants as product intent. No full re-review of unchanged content.
7. Execute bounded parallel **read-only** membership/hash classification across files, but serialize canonical status writes, generated manifest writes and ownership decisions. Stop and recalculate affected set if HEAD or any declared content changes between capture and publication. Do not make GitHub CI or unrelated large test sweeps a discovery gate.

## Executable task graph

| ID | Phase | Exact work | Predecessor | Owner |
| --- | --- | --- | --- | --- |
| **MDC-00** | PDP-0 | Freeze and classify current source cut | none | Media Product Truth/status |
| **MDC-01** | PDP-0 | Reconcile Product Truth status statement | MDC-00 | Media Product Truth/status |
| **MDC-02** | PDP-0 | Bind exact physical, composite and consumer scope | MDC-00 | Media product/surface owners |
| **MDC-03** | PDP-0 | Classify source-manifest and external impacts | MDC-00, MDC-02 | Media product/contract owners |
| **MDC-04** | PDP-0 | Wire authoritative source-currentness observation | MDC-02, MDC-03 | Media status adapter; Lifecycle public contract owner |
| **MDC-05** | PDP-0 | Validate every physical, composition and consumer phase cell | MDC-01, MDC-04 | Media Product Truth/surface owners |
| **MDC-06** | PDP-0 | Publish source-current PDP-0 exit observation | MDC-05 | Media Product Truth/status |
| **MDC-10** | PDP-1 | Classify contract parity script/test drift | MDC-06 | Media domain/interface owners |
| **MDC-11** | PDP-1 | Revalidate per-surface canonical domain and transitions | MDC-10 | Media domain/surface owners |
| **MDC-12** | PDP-1 | Record current PDP-1 phase cut | MDC-11 | Media domain/status owner |
| **MDC-20** | PDP-2 | Reconcile design and implementation-projection source drift | MDC-12 | Media design/interface owner |
| **MDC-21** | PDP-2 | Per-surface design currentness and exit | MDC-20 | Media design/status owner |
| **MDC-30** | PDP-3 | Reconcile complete journey and interface contracts | MDC-21 | Media experience owner |
| **MDC-31** | PDP-3 | Make Experience Explorer genuinely usable as a Discovery projection | MDC-30 | Media Explorer/design owners |
| **MDC-32** | PDP-3 | Record current PDP-3 phase cut | MDC-31 | Media experience/status owner |
| **MDC-40** | DISCOVERY_EXIT | Aggregate final Discovery barrier | MDC-06, MDC-12, MDC-21, MDC-32 | Media product/status authority |
| **MDC-41** | DISCOVERY_EXIT | Release Build handoff without conflating closure | MDC-40 | Media engineering owner |

### P0 — immediate resolution (MDC-00–06)

**MDC-00 — Capture:** fetch HEAD and the four historical status sourceShaSets; enumerate all source additions/removals/changed bytes since each cut, current P0 six mismatches, and the two missing inventory files. Generate a **new observation** with exact path and digest pairs plus semantic-effect classification. Do not rewrite historical `mainSha`, `sourceShaSet`, test counts or timestamps. Snapshot current `git status --porcelain` and upstream contract digests; if dirty, classify relevant files rather than ignoring them. **Done:** no unexplained PDP-0 source change/membership delta.

**MDC-01 — Status:** record that the new `PRODUCT-TRUTH.md` line 3 says `DEV_COMPLETE` *at its historical cut*; line-66 ownership-link correction is documentation. Reconcile `docs/PRODUCT-DEFINITION-COVERAGE.md` status table, historical cut label and any semantics implied by status wording. Never infer P0-010 independent signoff from internal completion. **Done:** explicit `changedMeaningIds=[]` only if exact canonical P0 meanings compare equal; otherwise reopen those IDs at P0.

**MDC-02 — Scope:** inspect all 26 `manifestCandidates`, six direct-meaning `compositions`, root and 17 `consumerCrosswalk` rows; verify against `surface-registry.yaml`, package manifests, public boundaries and inverse mappings. **The observed source includes** AI Voice React `PDP-0` TTS-only intent and `PDP-2: GUI_LIBRARY_HOST_DEPENDENT`; reject spurious full speech-family association. Bind observed legacy `libs/common/src/main/java/com/ghatana/audio/video/tools/` as `SUBSUMED` support; four Agent Tools remain nonadmitted. `NO_IMPLEMENTATION_ADMITTED` streaming/tooling cannot silently disappear from planned product channels. **Done:** exact 26/6+1/17 with explicit N/A, real authority refs, no unexplained owner/source drift or duplicate root counting.

**MDC-03 — Dependencies:** compare every declared Media-facing external content digest in `source-manifest.yaml` before/after, not just upstream repo revision. Old/current manifest shows Ghatana commit and GharBatai lockfile changes but unchanged listed Media-facing Ghatana contract digests and unchanged GharBatai Document Intelligence config digest. Classify those as **external/projection observations** for this cut; if later contract digests change, map to actual owning Media requirements/phase IDs. Generated `artifact-identities.yaml`, gap overlay and Explorer index are indexes, not normative semantic edits. **Done:** no unknown external edge; unrelated upstream metadata cannot invalidate all four PDPs.

**MDC-04 — Currentness adapter:** create bounded Media-side file set resolver + public Lifecycle adapter, keyed by physical/composition/consumer and phase, with exact material paths. Include owner-graph, physical-catalog, contract-provider fingerprints; no null placeholders pretending usable continuity. Compare old and current snapshots at file + membership level. Verify full rebuild on journal reset/lock failure, fail-closed on missing file/change during read, no accidental zero-work reuse. Model outputs separately as `DEFINITION_DEV_STATUS`, `SOURCE_CURRENTNESS`, `INDEPENDENT_ACCEPTANCE`, `LIFECYCLE_CLOSURE`, `BUILD`, `DELIVERY`. **Done:** deterministic field-by-field source-currentness observations with no hand-authored receipts.

**MDC-05 — Surface gate:** validate every current phase cell and inverse consumer mapping; attach current declared source-set digest and exact applicability decision per physical node; evaluate direct composition meaning, dependency changes and root aggregate via stable physical IDs. Do not allow a green root over an `UNKNOWN` child; child `SUPPORT_ONLY` with justified N/A is a valid non-blocking decision. **Done:** all applicable P0 cells `sourceCurrent=true` or exact blocker; any true material change opens the affected phase-local meaning task only.

**MDC-06 — PDP-0 exit:** run `pnpm check:physical-topology`, `pnpm test:physical-topology`, `pnpm check:product-definition-authority`, `pnpm check:product-experience-local` and relevant P0 targeted tests; retain real counts/10 historical skips, do not assert skipped tests ran. Publish a separately source-bound, owner-accepted **current** status observation with P0 `DEV_COMPLETE`, zero meaning IDs, exact material scope, and `sourceCurrent=true` only on actual validation. **Done:** P0 currentness PASS; otherwise halt phase advance and report exact IDs.

### P1 — after P0 PASS (MDC-10–12)

**MDC-10:** review `scripts/check-media-contract-parity.mjs` and its two changed tests. Source diff adds fail-closed `NOT_ADMITTED` disposition for all four Agent Tools, changing a historical strict parity gap count but not authorizing execution. Re-run the strict and definition-only modes, validate live owner bindings. One outstanding strict public-owner parity question is NOT proof of a new unimplemented PDP-1 domain definition. If validator changes reveal a genuinely missing typed contract, create exact ID/owner defect at PDP-1.

**MDC-11:** for each applicable physical/support/composition/consumer binding, verify identity, tenant scope, immutable source/result versions, job lifecycle/finality, state guards, event and operation semantics, HTTP/gRPC/SDK/CLI/Agent-wire source mapping. No phantom deployed endpoint; `NOT_ADMITTED` is explicit. Preserve 448 canonical +14 capability bindings, 79 wires, 55 guards until source-authoritative evidence warrants a change.

**MDC-12:** run `node --test tests/media-pdp-p1-dev-status.test.mjs tests/media-contract-parity.test.mjs tests/media-contract-parity-definition-only-cli.test.mjs` and affected authoritative contract suites; issue a **new** current PDP-1 record only with complete per-unit source scope, observed results and zero meaning defects. Preserve historical cuts.

### P2 — after P1 PASS (MDC-20–21)

**MDC-20:** distinguish Explorer artifact-index drift and React `TranscriptCaptionScreen.tsx` implementation edits from normative design grammar. Verify version-aware action dispatch and status rendering agree with approved design; actual product runtime UI integration remains Build. Check `@ghatana/ai-voice-ui-react` as a host-dependent GUI package without inventing deployment. Validate Shared design tokens/components public-owner references without claiming an independently qualified package.

**MDC-21:** check all applicable interface cells: GUI tokens, semantics, typography, layout, responsive accessibility, keyboard/focus, reduced motion, forced colors; machine grammar for async state, typed schemas, auth, error/finality, idempotency, cancellation and version/recovery. Use `pnpm check:product-experience-local` plus `node --test tests/media-pdp-p2-dev-status.test.mjs tests/pdp-design-interface-parity.test.mjs` and affected design suites. Stamp current only when per-unit sources and definitions match.

### P3 — after P2 PASS (MDC-30–32)

**MDC-30:** assert complete, exact 47 screen IDs, 30 journeys/130 steps, 147 UI actions, 31 synthetic scenario definitions (four seeded, 26 explicitly unseeded), 105 bounded recovery oracles, actor/intent, precondition, guards, success/denied/unknown outcomes, exact source/result version, locale/accessibility and resume/failure semantics. Audit every API/RPC/SDK/CLI/event/tool consumer: source-only definitions can be complete without a working host; no fake success, action dispatch, release or universal GUI treatment.

**MDC-31:** run the Explorer locally and inspect root → composition → physical → consumer plus cross-phase record links, screen/component/recipe/step artifacts, API/SDK/CLI/Agent/event models, search/index/deep links, phase status and currentness failure display. Deterministic fixture walk-throughs must be interactive and accurately distinguish `CONTRACT_PREVIEW`, `LOCAL_SIMULATION`, `HOST_DEPENDENT`, `NOT_ADMITTED` from observed live effects. Run `pnpm test:experience-browser` and applicable `tests/media-explorer-*.test.mjs`. Tooling repair required for **Discovery inspectability** is permitted; building actual product endpoints is not. If browser prerequisites unavailable, record a truthful unverified tooling exit rather than claiming usable full Explorer.

**MDC-32:** run `node --test tests/media-pdp-p3-dev-status.test.mjs tests/pdp-3-overview-denominator.test.mjs tests/pdp-3-screen-source-bindings.test.mjs` and affected negative-fixture suites. Record per-unit `sourceCurrent`, `DEV_COMPLETE`, zero pending meaning IDs only for validated exact cut; no synthetic fixture counts masquerading as live journeys.

### Exit and Build handoff — only after four current phase passes

**MDC-40:** require a machine-readable barrier report with `baselineSha`, exact source digests, `materialSourceSet`, `topologyFingerprint`, `ownerGraphFingerprint`, external-contract fingerprints, `surfaceId`, `phase`, applicability, `devStatus`, `currentness`, `outstandingMeaningIds`, affected-tests and reviewer disposition. **`DISCOVERY=PASS` iff** all applicable phase cells for 26 candidates, six composites and root plus 17 consumer crosswalks are current, `DEV_COMPLETE`, zero outstanding authoring meaning IDs and all required Explorer definition-inspection checks pass. Explicit archived/excluded surfaces must be reasoned; no duplicated root leaf counts. If any mandatory field is unknown, `DISCOVERY=FAIL`. Do not run Lifecycle closure evidence or production deployment as a surrogate.

**MDC-41:** after PASS, authorize Build code work from [Build plan](MEDIA-POST-PDP-BUILD-IMPLEMENT-TEST-DELIVER-2026-10-12.md) and allow independent PDP acceptance/closure in parallel on unchanged frozen definitions; Delivery still requires current closure + verified Build + external/release approvals. GitHub CI is not a general development gate.

## PDP-0 source mismatch classification

| Source path | Reviewed current change class | Required gate action |
| --- | --- | --- |
| `.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md` | STATUS TEXT AND DOC LINK ONLY OBSERVED | Owner-scoped non-semantic observation; bind exact current material and verify generated status, do not refresh old pins in place |
| `docs/PRODUCT-DEFINITION-COVERAGE.md` | STATUS AND COVERAGE PROJECTION ONLY OBSERVED | Owner-scoped non-semantic observation; bind exact current material and verify generated status, do not refresh old pins in place |
| `.product-experience/artifact-identities.yaml` | SOURCE INVENTORY ADDITIONS OBSERVED | Owner-scoped non-semantic observation; bind exact current material and verify generated status, do not refresh old pins in place |
| `.product-experience/gaps.yaml` | DATED DISPOSITION AND HISTORICAL GAP WORDING OBSERVED | Owner-scoped non-semantic observation; bind exact current material and verify generated status, do not refresh old pins in place |
| `apps/media-experience-explorer/specification-artifacts.json` | GENERATED EXPLORER ARTIFACT INDEX OBSERVED | Owner-scoped non-semantic observation; bind exact current material and verify generated status, do not refresh old pins in place |
| `.product-experience/source-manifest.yaml` | GENERATED SOURCE INDEX AND EXTERNAL OBSERVATIONS OBSERVED | Owner-scoped non-semantic observation; bind exact current material and verify generated status, do not refresh old pins in place |

The currentness question cannot be answered solely by refreshing old hashes. The topology is a **new required membership source after the PDP-0 cut**, and `surface-registry.yaml` is a pre-existing omitted source. These must enter the properly declared P0 material source set for all affected surface cells. Historical independent P0-010 acceptance stays distinct.

## Per-surface PDP-0 gate matrix at reviewed baseline

**Legend:** `UNKNOWN` = not proved against the newly required complete material source set; it does *not* mean the historical definition is unfinished. `MDC-02/MDC-05` = topology reconcile/currentness validation. Success acceptance for every row: exact owner/source membership, semantic refs or reasoned N/A, and correct propagation to compositions/root without inheriting green from stale children. For all rows, the next legal action is **PDP-0 reconciliation**, not Build. Phase-disposition cells are literal from the current topology, shown P0 / P1 / P2 / P3.

| Physical candidate / disposition | Phase applicability (P0 / P1 / P2 / P3) | P0 source-current | Phase-local gate work | Owner / acceptance |
| --- | --- | --- | --- | --- |
| `media.physical.adapters-ledger` (SUPPORT_ONLY) | NOT_APPLICABLE_SUPPORT / REFERENCED_ONLY / NOT_APPLICABLE / TOOLING_OR_SUPPORT | UNKNOWN | MDC-02, MDC-05 | media-platform; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.apps-media-experience-explorer` (PHYSICAL) | NO_IMPLEMENTATION_ADMITTED / REFERENCED_ONLY / NOT_APPLICABLE / TOOLING_OR_SUPPORT | UNKNOWN | MDC-02, MDC-05 | media-product-engineering; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.audio-video-observability` (SUPPORT_ONLY) | APPLICABLE / APPLICABLE / NOT_APPLICABLE / CONSUMER_CONTRACT | UNKNOWN | MDC-02, MDC-05 | media-platform; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.integration-tests` (SUPPORT_ONLY) | NOT_APPLICABLE_SUPPORT / REFERENCED_ONLY / NOT_APPLICABLE / TOOLING_OR_SUPPORT | UNKNOWN | MDC-02, MDC-05 | media-platform; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.launcher` (PHYSICAL) | APPLICABLE / APPLICABLE / HEADLESS_CONTRACT / CONSUMER_CONTRACT | UNKNOWN | MDC-02, MDC-05 | media-runtime; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.libs-audio-video-client` (PHYSICAL) | APPLICABLE / APPLICABLE / HEADLESS_CONTRACT / CONSUMER_CONTRACT | UNKNOWN | MDC-02, MDC-05 | media-client-owner; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.libs-audio-video-types` (PHYSICAL) | APPLICABLE / APPLICABLE / HEADLESS_CONTRACT / CONSUMER_CONTRACT | UNKNOWN | MDC-02, MDC-05 | media-types-owner; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.libs-audio-video-ui` (PHYSICAL) | APPLICABLE / APPLICABLE / GUI_LIBRARY / CONSUMER_CONTRACT | UNKNOWN | MDC-02, MDC-05 | media-ui-owner; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.libs-common` (SUBSUMED) | NOT_APPLICABLE_SUPPORT / REFERENCED_ONLY / NOT_APPLICABLE / TOOLING_OR_SUPPORT | UNKNOWN | MDC-02, MDC-05 | media-runtime; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.libs-java-common` (SUBSUMED) | NOT_APPLICABLE_SUPPORT / REFERENCED_ONLY / NOT_APPLICABLE / TOOLING_OR_SUPPORT | UNKNOWN | MDC-02, MDC-05 | media-runtime; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.libs-media-experience-simulation` (SUPPORT_ONLY) | NOT_APPLICABLE_SUPPORT / REFERENCED_ONLY / NOT_APPLICABLE / TOOLING_OR_SUPPORT | UNKNOWN | MDC-02, MDC-05 | media-product-engineering; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.modules-audio-streaming` (SUPPORT_ONLY) | NO_IMPLEMENTATION_ADMITTED / REFERENCED_ONLY / HEADLESS_CONTRACT / CONSUMER_CONTRACT | UNKNOWN | MDC-02, MDC-05 | media-runtime; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.modules-infrastructure-cache` (SUPPORT_ONLY) | NOT_APPLICABLE_SUPPORT / REFERENCED_ONLY / NOT_APPLICABLE / TOOLING_OR_SUPPORT | UNKNOWN | MDC-02, MDC-05 | media-platform; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.modules-infrastructure-messaging` (SUPPORT_ONLY) | NOT_APPLICABLE_SUPPORT / REFERENCED_ONLY / NOT_APPLICABLE / TOOLING_OR_SUPPORT | UNKNOWN | MDC-02, MDC-05 | media-platform; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.modules-infrastructure-persistence` (SUPPORT_ONLY) | APPLICABLE / APPLICABLE / NOT_APPLICABLE / CONSUMER_CONTRACT | UNKNOWN | MDC-02, MDC-05 | media-platform; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.modules-infrastructure-security` (SUPPORT_ONLY) | APPLICABLE / APPLICABLE / NOT_APPLICABLE / CONSUMER_CONTRACT | UNKNOWN | MDC-02, MDC-05 | media-platform; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.modules-integration-tests` (SUPPORT_ONLY) | NOT_APPLICABLE_SUPPORT / REFERENCED_ONLY / NOT_APPLICABLE / TOOLING_OR_SUPPORT | UNKNOWN | MDC-02, MDC-05 | media-platform; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.modules-intelligence-ai-voice-libs-ai-voice-ui-react` (PHYSICAL) | APPLICABLE / APPLICABLE / GUI_LIBRARY_HOST_DEPENDENT / HOST_DEPENDENT_EXPERIENCE | UNKNOWN | MDC-02, MDC-05 | media-ui-owner; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.modules-intelligence-multimodal-service` (PHYSICAL) | APPLICABLE / APPLICABLE / HEADLESS_CONTRACT / CONSUMER_CONTRACT | UNKNOWN | MDC-02, MDC-05 | media-runtime; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.modules-intelligence-speech-libs-speech-audio-rust` (SUPPORT_ONLY) | APPLICABLE / APPLICABLE / NOT_APPLICABLE / CONSUMER_CONTRACT | UNKNOWN | MDC-02, MDC-05 | media-runtime; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.modules-speech-stt-service` (PHYSICAL) | APPLICABLE / APPLICABLE / HEADLESS_CONTRACT / CONSUMER_CONTRACT | UNKNOWN | MDC-02, MDC-05 | media-runtime; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.modules-speech-tts-service` (PHYSICAL) | APPLICABLE / APPLICABLE / HEADLESS_CONTRACT / CONSUMER_CONTRACT | UNKNOWN | MDC-02, MDC-05 | media-runtime; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.modules-video-streaming` (SUPPORT_ONLY) | NO_IMPLEMENTATION_ADMITTED / REFERENCED_ONLY / HEADLESS_CONTRACT / CONSUMER_CONTRACT | UNKNOWN | MDC-02, MDC-05 | media-runtime; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.modules-vision-vision-service` (PHYSICAL) | APPLICABLE / APPLICABLE / HEADLESS_CONTRACT / CONSUMER_CONTRACT | UNKNOWN | MDC-02, MDC-05 | media-runtime; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.providers-aws-postgresql` (PHYSICAL) | APPLICABLE / APPLICABLE / NOT_APPLICABLE / HOST_DEPENDENT_EXPERIENCE | UNKNOWN | MDC-02, MDC-05 | media-runtime; validate declared authority refs, source set and rationale before P0 exit |
| `media.physical.runtime-contracts` (PHYSICAL) | APPLICABLE / APPLICABLE / HEADLESS_CONTRACT / CONSUMER_CONTRACT | UNKNOWN | MDC-02, MDC-05 | media-runtime; validate declared authority refs, source set and rationale before P0 exit |

| Compositional surface | PDP-0 applicability | P0 source-current | Phase-local gate work | Owner / acceptance |
| --- | --- | --- | --- | --- |
| `media.composition.ingestion-and-versioned-artifacts` | DIRECT_CROSS_CHILD_MEANING | UNKNOWN | MDC-02, MDC-05 | Media composition owner; verify direct meaning and deduplicated children |
| `media.composition.governed-job-execution` | DIRECT_CROSS_CHILD_MEANING | UNKNOWN | MDC-02, MDC-05 | Media composition owner; verify direct meaning and deduplicated children |
| `media.composition.speech-and-caption-workflows` | DIRECT_CROSS_CHILD_MEANING | UNKNOWN | MDC-02, MDC-05 | Media composition owner; verify direct meaning and deduplicated children |
| `media.composition.vision-and-multimodal-analysis` | DIRECT_CROSS_CHILD_MEANING | UNKNOWN | MDC-02, MDC-05 | Media composition owner; verify direct meaning and deduplicated children |
| `media.composition.creation-composition-and-delivery` | DIRECT_CROSS_CHILD_MEANING | UNKNOWN | MDC-02, MDC-05 | Media composition owner; verify direct meaning and deduplicated children |
| `media.composition.client-and-machine-interfaces` | DIRECT_CROSS_CHILD_MEANING | UNKNOWN | MDC-02, MDC-05 | Media composition owner; verify direct meaning and deduplicated children |
| `media.composition.repository-root` | ROOT_AUTHORITY_REFERENCE | UNKNOWN | MDC-01–MDC-06 | Media product/root owner; all six compositions and direct children reconcile |

| Consumer crosswalk (not extra physical leaf) | Binding class | P0 source-current | Phase-local gate work | Acceptance |
| --- | --- | --- | --- | --- |
| `media.surface.web` (GUI_WEB) | HOST_DEPENDENT | UNKNOWN | MDC-02, MDC-05 | Bind exact contracts, physical refs and applicable channel meaning; no implied runtime admission |
| `media.surface.embedded` (GUI_EMBEDDED) | HOST_DEPENDENT | UNKNOWN | MDC-02, MDC-05 | Bind exact contracts, physical refs and applicable channel meaning; no implied runtime admission |
| `media.surface.public-http` (PUBLIC_API) | HOST_DEPENDENT | UNKNOWN | MDC-02, MDC-05 | Bind exact contracts, physical refs and applicable channel meaning; no implied runtime admission |
| `media.surface.service-grpc` (SERVICE_API) | CONTRACT_ONLY | UNKNOWN | MDC-02, MDC-05 | Bind exact contracts, physical refs and applicable channel meaning; no implied runtime admission |
| `media.surface.grpc.stt` (SERVICE_API) | CONTRACT_ONLY | UNKNOWN | MDC-02, MDC-05 | Bind exact contracts, physical refs and applicable channel meaning; no implied runtime admission |
| `media.surface.grpc.tts` (SERVICE_API) | CONTRACT_ONLY | UNKNOWN | MDC-02, MDC-05 | Bind exact contracts, physical refs and applicable channel meaning; no implied runtime admission |
| `media.surface.grpc.vision` (SERVICE_API) | CONTRACT_ONLY | UNKNOWN | MDC-02, MDC-05 | Bind exact contracts, physical refs and applicable channel meaning; no implied runtime admission |
| `media.surface.grpc.multimodal` (SERVICE_API) | CONTRACT_ONLY | UNKNOWN | MDC-02, MDC-05 | Bind exact contracts, physical refs and applicable channel meaning; no implied runtime admission |
| `media.surface.sdk` (SDK) | PHYSICAL | UNKNOWN | MDC-02, MDC-05 | Bind exact contracts, physical refs and applicable channel meaning; no implied runtime admission |
| `media.surface.cli` (CLI) | HOST_DEPENDENT | UNKNOWN | MDC-02, MDC-05 | Bind exact contracts, physical refs and applicable channel meaning; no implied runtime admission |
| `media.surface.agent-tools` (AGENT_TOOL) | CONTRACT_ONLY | UNKNOWN | MDC-02, MDC-05 | Bind exact contracts, physical refs and applicable channel meaning; no implied runtime admission |
| `media.surface.events` (EVENT_STREAM) | CONTRACT_ONLY | UNKNOWN | MDC-02, MDC-05 | Bind exact contracts, physical refs and applicable channel meaning; no implied runtime admission |
| `media.surface.integrations` (SYSTEM_TO_SYSTEM_SERVICE) | HOST_DEPENDENT | UNKNOWN | MDC-02, MDC-05 | Bind exact contracts, physical refs and applicable channel meaning; no implied runtime admission |
| `media.surface.types-library` (LIBRARY) | PHYSICAL | UNKNOWN | MDC-02, MDC-05 | Bind exact contracts, physical refs and applicable channel meaning; no implied runtime admission |
| `media.surface.ui-library` (LIBRARY) | HOST_DEPENDENT | UNKNOWN | MDC-02, MDC-05 | Bind exact contracts, physical refs and applicable channel meaning; no implied runtime admission |
| `media.surface.explorer` (EXPLORER_TOOLING) | PHYSICAL | UNKNOWN | MDC-02, MDC-05 | Bind exact contracts, physical refs and applicable channel meaning; no implied runtime admission |
| `media.surface.desktop-archive` (OBSOLETE) | ARCHIVED / EXCLUDED_ARCHIVE | UNKNOWN | MDC-02, MDC-05 | Archive excluded from active denominator; keep explicit decision |

## Verification / publication checklist

- `git rev-parse HEAD` and `git status --porcelain` observed at start and before publish; fail/redo affected snapshot if changed.
- `pnpm check:physical-topology` + `pnpm test:physical-topology` for ownership graph; check stable 26/17 + 6/root and exact reverse mappings.
- `pnpm check:product-definition-authority`, `pnpm check:product-experience-local`, and affected PDP phase-dev-status/contract/experience tests for meaning and references. No blanket expensive rereview of unaffected records.
- `pnpm generate:product-definition-manifest` **only when authored artifact registration changes**; check for drift, do not blindly regenerate to match stale input. Preserve original outputs in recorded status cuts.
- New currentness tests: changed content, added/removed membership, missing public owner fingerprint, external contract hash changes, scope changes, bad journal, lock contention, concurrent writes, neutral formatting/status-only changes, real normative change, and one stale leaf blocking aggregate root.
- Currentness report should clearly say `NOT_RUN` for unexecuted checks, `UNKNOWN` for unverified external inputs, `PASS` for actually executed checks only; acceptance/closure/release `NOT_GRANTED` unless separate actual authority returns a receipt.
- Publish one atomic source-bound current-cut observation after all required checks; never fabricate human specialist approval or use timestamp/commit SHA as a material semantic fingerprint.

**Present gate result:** Discovery FAIL (PDP-0 source-currentness unproven); Build NOT ENTERED; PDP closure NOT ENTERED; Delivery BLOCKED. **Next allowed work:** MDC-00→MDC-06. When those pass, proceed MDC-10→12, then MDC-20→21, then MDC-30→32, then MDC-40→41. This plan **does not mark any task performed** and asserts no tests run by its author.
