# Ghatana Media — Owner-reviewed post-PDP execution directive

> **PDP stages finished (owner correction, October 12, 2026):** PDP-0…PDP-3 are `DEV_COMPLETE`, with **0 remaining PDP development tasks**. All open IDs in this dated document belong to **Build/Integration/Test/Delivery** or real release/qualification decisions, not PDP authoring. Follow the [Build-stage handoff](MEDIA-POST-PDP-BUILD-IMPLEMENT-TEST-DELIVER-2026-10-12.md); the former 15-card remaining-PDP list is superseded. Dated implementation dispositions and authentic external authority requirements remain unchanged.

**Date:** 2026-10-12 · **Media source:** [39ebe9f](https://github.com/samujjwal/ghatana-media/commit/39ebe9f982b50a85c4a1c6a64c62222a4f118c0b) · **Canonical ghatana runtime:** [fd6d91f](https://github.com/samujjwal/ghatana/commit/fd6d91fb919748a2be9532f7a8f22d02f086b2a1).

**Mandate:** implement all still-open work from the existing 47-task ledger with source-grounded decisions, no artificial approval dependency or task ping-pong. This is a **delegated Media product/engineering direction**, NOT an independent human review signature, another repository owner's approval, native Lifecycle receipt, license, production deployment or release approval. Preserve unrelated uncommitted Ghatana AEP files. Use actual current HEAD/worktree before any edits.

**Status census:** 7 LOCAL_COMPLETE; 8 LOCAL_COMPLETE_EXTERNAL_REVIEW_PENDING; 17 PARTIAL; 9 EXTERNAL_PENDING; 2 UPSTREAM_NOT_AVAILABLE; 2 BLOCKED_DEPENDENCY; 2 DEFERRED. This document retains all 47 stable IDs and does not invent PDP-4. PDP-0..PDP-3 definition development stays DEV_COMPLETE at its accepted source cut. The dated checklist is [post-pdp-remaining-items-2026-10-12.md](./post-pdp-remaining-items-2026-10-12.md); this directive supersedes its order/blocker treatment, not historical evidence or original task IDs.

## Verified new review corrections

- **SUR-07 real source defect:** canonical 47 screen IDs versus repository-root topology's 46; missing `media.view.review-workspace-settings`. Fix authored topology source and make its validator test exact sets, not just individual references.
- **SUR-03 graph ambiguity:** root lists all 26 physical candidates as direct children plus the six semantic compositions. Nineteen physical nodes have multiple containments, including redundant root membership. An authored semantic DAG may share leaves, but aggregation needs canonical ownership, explicit direct-membership semantics, deduped denominators, and no dependence-as-membership.
- **SUR-08/EXP-06 stale availability label:** Lifecycle **current main** has a source-level `SurfaceExperiencePack` producer, [v1 schema](https://github.com/samujjwal/ghatana-lifecycle/blob/main/explorer/surface-experience-pack.schema.json), and `gtool` source candidate. An admitted, licensed public artifact, Media owner binding and program-qualified native issuer semantics are **not yet established**. Rename the state `SOURCE_CANDIDATE_AVAILABLE_PUBLIC_ADMISSION_PENDING`; allow version-negotiated test-only consumer work now.
- **RUN-03/04 finality defect:** canonical `MediaRuntime.reconcileJobsAfterRestart` currently maps uncertain work to `FAILED/RESTART_RECONCILIATION_REQUIRED`; do not claim this proves provider failure. Preserve UNKNOWN through restart with durable attempt/fence/reconcile evidence.
- **RUN-08 real durability gap:** legacy `AudioVideoOutboxStoreImpl` uses `ConcurrentHashMap`; it is not a production durable outbox despite its comments. Shared already supplies a claim-aware publication SPI. Reuse it with Media-owned PostgreSQL transaction state.
- **MIG-03/RUN-10 compile root:** canonical multimodal agents import `com.ghatana.agent.framework.runtime.AbstractTypedAgent`, while Shared's current public implementation resides at `com.ghatana.agent.runtime.turn.AbstractTypedAgent`. Resolve ABI/method parity, not by hiding the entire compile task.
- **EXP-05 parity semantics:** the two strict findings cover Agent Tool runtime adapters and proposal-vs-accepted operation semantics. Definition-only was already green; do not change status strings to counterfeit executable endpoints.
- **MIG-01 old path counts:** 652/537/103/12 were a historical committed-tree comparison predating both new heads; rerun all exact tree+wire maps before owner-reviewed transfer.

## Owner technical decisions and authorization boundaries

| Decision | Disposition | Binding instruction |
|---|---|---|
| M-01 | APPROVED NOW | Keep canonical PDP-0..3 DEV_COMPLETE; reopen only exact affected semantic IDs for a proved product-contract contradiction. |
| M-02 | APPROVED FOR IMPLEMENTATION | The 26 physical candidates, 17 consumer surfaces and root-plus-six Media compositions are accepted as an internal *source-owned planning baseline*. Fix the 47th root screen and clarify direct containment before treating the hierarchy as current. |
| M-03 | APPROVED FOR IMPLEMENTATION | Media may bind per-surface PDP applicability by *reference* and author only direct cross-child integration semantics; copying product truth into each package is prohibited. |
| M-04 | APPROVED FOR IMPLEMENTATION | Use immutable artifact version sha256:<64-lowercase-hex> and existing optional expected-version capture semantics. Reject explicit blank, stale, mismatched and cross-tenant versions. One canonical authoritative source until MIG-04 cutover. |
| M-05 | APPROVED FOR IMPLEMENTATION | Ambiguous provider or external delivery outcome is UNKNOWN, never FAILED/COMPLETED/CANCELLED by timeout/restart assumption; no automatic replay unless same-effect idempotency and read-back are proven. |
| M-06 | APPROVED FOR IMPLEMENTATION | Reuse Shared OutboxPublicationSource/ClaimedOutboxPublisher and Media transactional DB adapter; treat legacy ConcurrentHashMap outbox as test-only. Do not build another general messaging engine. |
| M-07 | APPROVED FOR IMPLEMENTATION | One implementation per exact capability/profile; Ghatana public contracts first, then permissive external OSS if needed and qualified. No implicit provider fallback, no private sibling imports, and no generic OCR/AI model routing relocation. |
| M-08 | APPROVED FOR IMPLEMENTATION | Sequence admitted verticals J-01 -> J-02 -> J-20 -> J-03; use exact denial/unknown tests. API/CLI-only experiences remain headless and never require fabricated GUI. |
| M-09 | APPROVED FOR PREPARATION ONLY | Prepare reversible manifest, aliases, shadow reads and nonproduction migration. Canonical runtime remains ghatana/services/media until actual source/cutover authority and rollback conditions are satisfied. |
| M-10 | APPROVED FOR DEVELOPMENT ONLY | Use source-pinned local composite/packed candidates and test fixtures with truth labels. Unpublished/UNLICENSED/unknown-compatibility components may not be promoted as immutable public production dependencies. |
| M-11 | NOT DELEGABLE BY THIS REVIEW | Independent specialist/AT signature, another repository's public contract publication/license authority, native Lifecycle receipt and production release approval require their authentic accountable principals. |
| M-12 | APPROVED PROCESS | Local tests and targeted source proof govern developer progression; GitHub CI is not a universal development blocker. One integrator owns overlapping catalogs, two or three parallel ownership lanes, complete coherent vertical batches, no broad rerun until source changes warrant one. |

**No-wait rule:** every external dependency has a defined internal source/contract/test-only lane. Missing a publisher, independent signatory, production credential or public release window blocks *only the claim/effect requiring that authority*, not neighboring implementation. Never infer a signed verdict, invent an issuer identity, enable a provider, or relabel a stale receipt.

## Critical path and resource-aware wave plan

| Wave | Finish and integrate | Parallel, never-blocked lanes | Advance when |
|---|---|---|---|
| **W0 — correction and owner source** | SUR-07 47th screen, SUR-03 direct membership, SUR-08 availability classification; preserve BASE and SUR-10 | SUR-01/02/04/05/06/09 reviews; DEP-01 inventory | Exact topology, stage/selector and source tests pass |
| **W1 — secured artifact** | RUN-01 then RUN-02; J-01/J-02 source-backed adapters | Shared #234/#242 owner packets, DEV_SOURCE_COMPOSITE, EXP-01/02 | Artifact/version authority tests, no effect on denied/unknown |
| **W2 — durable job and events** | RUN-03 + RUN-04 + RUN-08 as ONE transactional design; RUN-09 instrumentation | Public platform contract review, EXP-05 typed machine parity | Fault-injection crash/replay/ack results honest and deterministic |
| **W3 — first real product lane** | RUN-05 and EXP-03 J-01/02/20/03 on one guarded canonical runtime | EXP-04 selective synthetic scenes, EXP-02 UI, SRC-free packaging | One complete admitted journey with versioned observed outputs, then next |
| **W4 — media capability expansion** | RUN-06 qualified profile, RUN-07 source-free and derived media verticals | EXP-05 machine consumers, SUR-08 candidate pack, ACC review preparations | Every admitted profile has typed inputs/outcomes, no false fallbacks |
| **W5 — migration-ready integration** | MIG-01/02 contract parity, fix multimodal compile, prepare MIG-03 aliases | DEP artifact publication, RUN-10 test matrix, EXP-06 client | No unclassified supported consumer, clean isolated build and cutover draft |
| **W6 — staged infrastructure and owner acceptance** | RUN-10 actual infrastructure tests; ACC-01/02/03; source-free artifacts | LC-01/02 leaf candidates, test-only packaged Explorer | Real qualified results and authentic owner verdicts for affected surfaces |
| **W7 — authorized transfer and release** | MIG-03/04 under explicit source/writer switch approval; REL-01/02 under release owner | Continue independent unrelated surfaces; no global closure rerun | One canonical writer, rollback proven, signed authorization and canary readback |

**Parallelism:** use at most one writer for Media `operations.yaml`, topology JSON, manifest, Gradle settings, database migration ordering, shared phase/status catalogs. Agents can work concurrently on separate source-owner files and independent capability families. Serialize DB/browser/provider-exclusive tests, prefer two or three resource-bounded workers. Run focused positive + negative tests per batch; one full Node and canonical Gradle suite per stable integration cut, not after each record.

## Forty-seven task execution cards

The **Do** clause is the owner's prescriptive design selection. **Exit** requires real behavioral/test facts for the stated boundary. **Proceed without** is a safe way to keep engineering moving before external authorities act; it is never permission to misreport readiness.

## Foundation: preserve 7 completed tasks

### BASE-01 — `LOCAL_COMPLETE`

- **Where:** docs/implementation/pdp-{0,1,2,3}-phase-dev-status.json; scripts/generate-media-post-pdp-status.mjs
- **Do:** Retain source-pinned DEV_COMPLETE records; run strict status check only when materially affected, not as a new campaign.
- **Exit:** Exact changed-source fingerprints match; historical 1,423 and current 1,439 suites are not conflated.
- **Proceed without external gates:** No action unless a new normative counterexample; never reopen from regenerated timestamps.

### BASE-02 — `LOCAL_COMPLETE`

- **Where:** .product-experience/gap-current-status.yaml; .product-experience/gaps.yaml; README.md
- **Do:** Maintain dated current-status overlay while preserving the historical 27 gap records.
- **Exit:** Every new gap status has an exact source and date; historical counts remain historical.
- **Proceed without external gates:** Update only impacted entries; do not recreate prior definition backlogs.

### BASE-03 — `LOCAL_COMPLETE`

- **Where:** docs/implementation/post-pdp-current-status.json; .product-experience/acceptance.yaml
- **Do:** Keep development, independent review, runtime, published contracts, Lifecycle, migration and release as distinct states.
- **Exit:** No status projection upgrades another authority from local tests.
- **Proceed without external gates:** Status is an observation, not a gate or signature.

### BASE-04 — `LOCAL_COMPLETE`

- **Where:** scripts/generate-media-product-manifest.mjs; scripts/generate-media-phase-projections.mjs; topology/handoff checkers
- **Do:** Retain deterministic authored-source-to-projection checks, source ID consistency, negative reference cases.
- **Exit:** Changed projections regenerate twice identically; zero applicable unresolved source refs.
- **Proceed without external gates:** Run changed-impact checks per batch, complete generation at each stable integration cut.

### BASE-05 — `LOCAL_COMPLETE`

- **Where:** .product-experience/pdp-3-product-experience/generated/implementation-handoff.v1.json; scripts/generate-media-pdp3-implementation-handoff.mjs
- **Do:** Retain source-pinned implementation handoff; downstream adapters consume it read-only.
- **Exit:** 47 screen and 30 journey identities preserved, no invented runtime availability.
- **Proceed without external gates:** Implementation may advance from handoff without external acceptance; do not edit generated JSON as authority.

## Physical and composite PDP adoption

### SUR-01 — `LOCAL_COMPLETE_EXTERNAL_REVIEW_PENDING`

- **Where:** .product-experience/surfaces/media-physical-topology.v1.json; settings.gradle.kts; pnpm-workspace.yaml; Cargo.toml
- **Do:** Approve the 26-candidate inventory as Media's internal planning baseline (12 PHYSICAL, 12 SUPPORT_ONLY, 2 SUBSUMED). Add source and release-branch checks for omitted CLIs/proto/runtime endpoints and record owner/build/deployability per candidate; modify only demonstrated misclassifications.
- **Exit:** All actual build/exec entrypoints have one stable identity or explicit non-independent rationale; deterministic delta scan reports additions/removals.
- **Proceed without external gates:** Media may use this mapping for development now; external branch/host confirmations affect only the matching consumer/cutover.

### SUR-02 — `LOCAL_COMPLETE_EXTERNAL_REVIEW_PENDING`

- **Where:** .product-experience/surface-registry.yaml; .product-experience/surfaces/media-physical-topology.v1.json; migration/consumer-inventory.yaml
- **Do:** Approve 17 channel-to-physical crosswalk dispositions as provisional Media consumer truth. Reconcile reverse refs for HTTP/gRPC/SDK/CLI/Agent/events, distinguish HOST_DEPENDENT, CONTRACT_ONLY and executable; request only changed consumer owners' confirmations.
- **Exit:** 17/17 bi-directional referential checks; every physical surface has exactly named consumers or SUPPORT_ONLY disposition; incompatible runtime routes remain NOT_ADMITTED.
- **Proceed without external gates:** Do not wait for third-party publication to complete Media-owned inventory.

### SUR-03 — `LOCAL_COMPLETE_EXTERNAL_REVIEW_PENDING`

- **Where:** .product-experience/surfaces/media-physical-topology.v1.json; scripts/check-media-physical-topology.mjs
- **Do:** Approve one root plus six named semantic compositions as the Media source model, not Lifecycle receipt authority. Make CONTAINS direct rather than implicitly duplicating every physical leaf under both root and composite; root links six compositions plus genuinely ungrouped support units. Keep multi-parent membership only for a stated distinct semantic role; dependencies use DEPENDS_ON.
- **Exit:** Unique root, every active physical reachable, no orphan/cycle/double-count, explicit canonical owner and direct cross-child obligations. Tests cover multi-parent dedup and prohibited dependency-as-membership.
- **Proceed without external gates:** Publish Media source model independently; wait for Lifecycle wire adapter only for native admission.

### SUR-04 — `LOCAL_COMPLETE_EXTERNAL_REVIEW_PENDING`

- **Where:** .product-experience/surfaces/media-physical-topology.v1.json; pdp-0-product-truth/{capabilities,requirements,goals-jtbd}.yaml
- **Do:** Approve references to already frozen product-truth source IDs, not replicated leaf definitions. Inspect exact capability families/intent/requirement applicability for every PHYSICAL and composition node; target-only operation remains NO_IMPLEMENTATION_ADMITTED.
- **Exit:** Every applicable PDP-0 cell has exact source identity and rationale; no new capability/rights/availability claim follows from membership.
- **Proceed without external gates:** Use delegated Media product-owner decisions for local applicability; independent formal signoff is a separate ACC-01 lane.

### SUR-05 — `LOCAL_COMPLETE_EXTERNAL_REVIEW_PENDING`

- **Where:** .product-experience/surfaces/media-physical-topology.v1.json; pdp-1-domain-data/{domain-objects,operations,states,transition-guard-contracts}.yaml
- **Do:** Adopt canonical PDP-1 objects/guards/79 action wires by exact IDs and assign the physical implementation owner, caller and persistence authority; keep protocol-only and nonoperation roles explicit. Do not make a second operation registry.
- **Exit:** No duplicate canonical owner; all applicable object/action/transition references and implementation ports resolve; negative stale ID and swapped operation tests.
- **Proceed without external gates:** Finish Media ownership mapping without waiting on external runtime qualification.

### SUR-06 — `LOCAL_COMPLETE_EXTERNAL_REVIEW_PENDING`

- **Where:** .product-experience/surfaces/media-physical-topology.v1.json; pdp-2-design-interface-system/{gui,api,cli,sdk,events,agent-tools}/; libs/audio-video-ui/
- **Do:** Approve actual GUI and non-GUI grammar applicability; API-only surfaces need no fake page. Pin public Shared export candidate and exact Media facade; keep unpublished versions development-only.
- **Exit:** Every selected surface has correct interface type, typed state/error semantics, token/primitive source, honest NOT_APPLICABLE, CSP/keyboard regression.
- **Proceed without external gates:** Shared publication and formal independent AT review are DEP-02/ACC-02, not blockers to local composition work.

### SUR-07 — `LOCAL_COMPLETE_EXTERNAL_REVIEW_PENDING`

- **Where:** .product-experience/surfaces/media-physical-topology.v1.json; .product-experience/pdp-3-product-experience/{screen-registry,journey-registry}.yaml; scripts/check-media-physical-topology.mjs; tests/media-physical-topology.test.mjs
- **Do:** FIX VERIFIED DEFECT: root PDP-3 screen IDs are 46 whereas canonical registry has 47; add media.view.review-workspace-settings. Compare exact ID SET equality (not only subset membership), catch duplicates, and ensure responsible physical host/composition for every journey and screen. Use cross-leaf handoff refs rather than copying PDP-3 contracts.
- **Exit:** 47/47 exact root screen IDs, 30/30 journeys, 17/17 consumer mappings, no orphan responsible owner; mutation test removing any screen fails.
- **Proceed without external gates:** The topology JSON is an authored Media crosswalk; fix it and its validator, then refresh downstream projections. PDP-3 semantic freeze stays intact.

### SUR-08 — `UPSTREAM_NOT_AVAILABLE (RECHECK)`

- **Where:** ghatana-lifecycle/tools/verification-planner/src/closure/surface-experience-pack.mjs; explorer/surface-experience-pack.schema.json; tools/gtool/src/surface-definition-cli.mjs; Media Explorer consumer adapter
- **Do:** Reclassify the old blanket 'not available': current Lifecycle main contains a SurfaceExperiencePack producer, schema and gtool candidate APIs. Inspect exact exported package and source support, create a version-negotiated read-only Media adapter and TEST_ONLY candidate usage; reject unknown source/protocol/selector. Require published immutable and appropriately licensed package plus multi-program admission before native use.
- **Exit:** Candidate adapter validates one physical, one composite and root against exact schema without side effects. Native status stays NOT_ADMITTED until Lifecycle publishes/adopts required program/identity/storage contract.
- **Proceed without external gates:** Continue Media Explorer against local topology with CANDIDATE_SOURCE mode; do not fork ClosureGraph, receipts, fingerprints or issuer.

### SUR-09 — `LOCAL_COMPLETE_EXTERNAL_REVIEW_PENDING`

- **Where:** apps/media-experience-explorer/src/{main,physical-topology,topology-route}.ts; .product-experience/explorer/; libs/media-experience-simulation/
- **Do:** Accept existing topology route as development-grade. Add selected root/composite/physical navigable pack presentation, exact direct-vs-inherited meaning, read-only API/CLI/event cases, unsupported/error/deep-link behavior; later switch data input through SUR-08 public adapter.
- **Exit:** Keyboard/focus/zoom/RTL and malformed-path tests, deterministic reload links, no product side effects and no false CURRENT/QUALIFIED labels.
- **Proceed without external gates:** One shared viewer; local topology mode remains usable until upstream pack admission.

### SUR-10 — `LOCAL_COMPLETE`

- **Where:** scripts/check-media-physical-topology.mjs; tests/media-physical-topology.test.mjs
- **Do:** Preserve present 26/17/7 structural checks; strengthen them only under SUR-03/07 to enforce exact-root-denominator and unambiguous membership.
- **Exit:** Positive and mutation/regression tests green; no copied graph engine.
- **Proceed without external gates:** Never count one supporting leaf twice in root aggregate readiness.

## Public dependencies and migration preparation

### DEP-01 — `EXTERNAL_PENDING`

- **Where:** pnpm-workspace.yaml; pnpm-lock.yaml; settings.gradle.kts; gradle/libs.versions.toml; ghatana-toolchain managed version policy; docs/migration/post-pdp-dependency-cutover-checklist-2026-10-12.md
- **Do:** Choose a two-profile dependency policy: DEV_SOURCE_COMPOSITE permits pinned sibling sources; RELEASE_ARTIFACT_ONLY requires immutable owner-issued public coordinates, checksums, license/SBOM and clean installed consumer. Classify each Shared, Tools-runtime, Toolchain, Lifecycle, Kernel, AI/platform dependency as build/runtime/test. Toolchain manages defaults, Media declares surface-specific needs.
- **Exit:** Reproducible source-only integration now; later install exact packed Java/TS/Rust artifacts into empty consumer with no sibling source substitutions and pass compatibility tests.
- **Proceed without external gates:** Missing published artifact blocks only RELEASE_ARTIFACT_ONLY promotion, not Media implementation.

### DEP-02 — `EXTERNAL_PENDING`

- **Where:** ghatana-shared #234; libs/audio-video-ui/src/foundations/; pdp-2-design-interface-system/{media-token-aliases,gui/style-authority}.yaml
- **Do:** Use Shared public tokens/themes/headless exports where API actually matches; Media may compose state/finality-specific wrappers. Remove inline-style/unsafe CSS violations rather than disabling CSP; test light/dark/forced color/reduced motion and labels.
- **Exit:** Packed consumer + strict-CSP + keyboard tests pass; immutable published export approval and independent AT decision separately recorded.
- **Proceed without external gates:** Proceed on pinned Shared development exports with explicit unresolved-release status; no copied private Shared primitives.

### DEP-03 — `EXTERNAL_PENDING`

- **Where:** ghatana-shared #242; Media PDP-3 handoff-bindings.yaml; ghatana/services/media/launcher/MediaSecurityFilter.java and trusted-context adapters
- **Do:** Define Media-owned IdentityContinuationPort and WorkspaceMembershipPort contract consuming only Shared/host-attested identity; no caller-asserted tenant/delegation. Bind final Shared public implementation only when published; until then use TEST_ONLY fake provider and deny interactive external effects.
- **Exit:** Authenticated positive, expired/revoked/cross-tenant denial, stale session/redirect loss and no unauthorized effect; exact Shared version qualified before enabling.
- **Proceed without external gates:** Missing upstream identity must not block CLI definition or local simulations; protected live screens show sign-in/unsupported.

### DEP-04 — `EXTERNAL_PENDING`

- **Where:** ghatana #254; Media interface-parity/operation-parity.yaml; Ghatana Data Cloud, Action Plane, Event Plane, AI Inference public contracts
- **Do:** Implement port-per-boundary: append acceptance != consumer observation; Action Plane reserved effect != final effect; Data Cloud generic read-model owner stays external; AI Inference owns generic model routing. Request versioned schemas and exact idempotency/error/read-back. Use contract mocks and HTTP negative oracles until owners publish.
- **Exit:** One current owner-approved version/contract per external effect before activation, with identity, privacy, deadline, no-blind-retry and finality assertions.
- **Proceed without external gates:** Independent runtime slices run with blocked/unavailable external adapters; do not fabricate public endpoints.

### MIG-01 — `PARTIAL`

- **Where:** ghatana/services/media/; ghatana-media/migration/{path-map,consumer-inventory,contract-compatibility}.yaml; contracts/openapi; protobuf; SDK and events
- **Do:** Rescan both *current* heads (ghatana fd6d91f; Media 39ebe9f), all supported release branches and declared deployment manifests. Use git ls-tree -rz path/mode/blob crosswalk, then contract-semantic diff, route/proto generated clients and actual named consumers; disposition every missing/different path, including intentionally target-only PDP files.
- **Exit:** Machine-readable per-path/source-owner and per-public-operation backward-compatibility matrix, 0 unclassified supported consumers. Avoid reusing historic 652/537/103/12 counts as fresh.
- **Proceed without external gates:** Media can complete local source/contract reconciliation before consumer-owner response; only migration admission awaits changed consumer decisions.

### MIG-02 — `PARTIAL`

- **Where:** migration/{path-map,transfer-exceptions,transfer-receipt}.yaml; BOUNDARY.md; docs/migration/decisions/MDI-001*; ghatana config/route manifests
- **Do:** Approve PREPARATION: create exact signed-review-ready transfer manifest per source file, destination, owner, canonical generator, conflicts, DB/data/secret ownership, rollback link, start/stop triggers. Generic OCR/Document Intelligence stays Ghatana; Data Cloud/AI Inference/Shared retain their meanings. Request source/target owner sign-off and an actual release window only for cutover.
- **Exit:** Every migrated identity has authoritative transfer/rollback rule, no double-writer or orphan contract; reviewer changes recorded. No authority switch before true cutover approval.
- **Proceed without external gates:** Dry-run static/package migration and simulation allowed now; runtime switch not preapproved.

### MIG-03 — `BLOCKED_DEPENDENCY`

- **Where:** ghatana-media/settings.gradle.kts; build.gradle.kts; launchers; Dockerfiles; route manifests; Gradle aliases; consumers
- **Do:** Prepare versioned aliases for legacy audio-video, services:media and Toolchain/Tools names; prove new standalone Java/TS/Rust compilation and isolated artifact consumption. FIX ROOT COMPILE ISSUE: multimodal agents import com.ghatana.agent.framework.runtime.AbstractTypedAgent but Shared public class is com.ghatana.agent.runtime.turn.AbstractTypedAgent; update source against actual published API and method contract, never skip multimodal compile for final qualification.
- **Exit:** Clean build without -x multimodal compile/exclusion init scripts; public routes/client methods preserved or explicitly versioned; no duplicate registries.
- **Proceed without external gates:** Can prepare aliases and fix compile on canonical ghatana now. Activate changed coordinates only after MIG-01 compatibility review.

### MIG-04 — `BLOCKED_DEPENDENCY`

- **Where:** ghatana/services/media; ghatana-media runtime counterpart; migration/transfer-receipt.yaml; each consumer config
- **Do:** Transfer in ordered waves (contracts/types -> tests/adapters -> read-only consumers -> one nonproduction vertical -> production writer with controlled switch). Keep ONE canonical writer at all times, shadow-read/compare before switching, rehearsed rollback, bounded backout and data migration. Remove original source only after owner-confirmed new endpoint consumption.
- **Exit:** Reviewed manifest, rollback test and exact source/release fingerprints; supported consumer compatibility and one authoritative writer verified after each wave.
- **Proceed without external gates:** Do not suspend RUN or EXP development while awaiting production window; isolated staging migration is allowed.

## Canonical runtime vertical slices

### RUN-01 — `PARTIAL`

- **Where:** ghatana/services/media/launcher/MediaSecurityFilter.java; MediaRuntime.java; runtime-contracts/MediaRuntimeContracts.java; providers/aws-postgresql
- **Do:** Use one trusted authority context created by authenticated host filter, tenant/principal/delegation/rights/consent/purpose/current version at *every effect boundary*. Enforce policy decision freshness and deny if UNKNOWN; make persisted request digest bind complete normalized submission/provider plan.
- **Exit:** Permitted authenticated positive path plus denied/revoked/stale/cross-tenant/forged claims -> zero effects and auditable reason; integration uses real issuer for live admission.
- **Proceed without external gates:** Use test-only trusted-context issuer for local tests until Shared #242; do not enable live external effects.

### RUN-02 — `PARTIAL`

- **Where:** ghatana/services/media/launcher/MediaRuntime.java; runtime-contracts/MediaRuntimeContracts.java; providers/aws-postgresql/src/main; S3PostgresqlMediaArtifactStore; contracts/openapi/media.yaml
- **Do:** Preserve current sha256 immutable artifact-version and optional capture-vs-explicit-blank rules. Add quarantine/format/parser/security/rights/consent checks before AVAILABLE; atomic version-bound derived output registration, append-only ancestry and exact digest. Persist upload/verification/registration state and background cleanup/hold distinctions.
- **Exit:** Real bounded S3/PostgreSQL round-trip plus corrupted payload, extension spoof, traversal, revoked rights, digest/CAS mismatch, restart, erasure/hold and failed-output registration negatives.
- **Proceed without external gates:** Use local MinIO/Postgres/Testcontainers for repeatable integration when real AWS absent; no claim that local stack qualifies AWS.

### RUN-03 — `PARTIAL`

- **Where:** ghatana/services/media/launcher/MediaRuntime.java; providers/aws-postgresql migrations V007/V008 and next version; Shared messaging OutboxPublicationSource/ClaimedOutboxPublisher
- **Do:** Design one durable logical Job + Attempt + DispatchIntent + DeliveryEvent model. In one DB transaction reserve idempotent request and version, create fenced attempt and outbox intent. Claim lease with compare-and-swap, record provider dispatch identity, and preserve OUTCOME_UNKNOWN across restart. Current restart mapping possible provider effect -> FAILED with RESTART_RECONCILIATION_REQUIRED must become UNKNOWN/reconciling (with explicit legacy transition), not fake failure.
- **Exit:** Crash before/after commit, before/after provider dispatch/ack, lease expiry, fencing, duplicate key and concurrent runner tests prove no unguarded redispatch and no false completed/failed state.
- **Proceed without external gates:** Reuse Shared outbox publisher SPI; implement only Media persistence adapter. If provider cannot query/idempotently replay, retain UNKNOWN and require operator resolution.

### RUN-04 — `PARTIAL`

- **Where:** ghatana/services/media/launcher/{MediaRuntime,MediaJobReconciliationReadTest}.java; contracts/openapi/media.yaml; provider callback/read ports
- **Do:** Extend exact requestId-scoped GET job read into trusted same-job/attempt/provider receipt reconciliation. Model retry eligibility separately from job status; require positive no-effect or admitted idempotent same-request replay, current policy/budget/consent, attempt/fence and destination. Cancellation requested != confirmed; unknown delivery uses destination receipt.
- **Exit:** Adversarial request mismatch 404, cross-tenant concealment, conflict winner read, provider timeout, retry budget, partial irreversible effect and cancellation race tests; no auto replay when UNKNOWN.
- **Proceed without external gates:** Read-only reconciliation and operator safe guidance can ship before a provider-specific query exists; keep retry/cancel-confirm unavailable.

### RUN-05 — `PARTIAL`

- **Where:** ghatana/services/media/modules/speech/stt-service; libs/audio-video-client; libs/audio-video-ui/screens/TranscriptCaptionScreen.tsx; PDP-3 J-03 contracts
- **Do:** Implement one continuous artifactVersion -> STT request receipt/job -> immutable transcriptVersion with qualified clock -> session-local correction -> new immutable captionVersion registration, no mutation of source. Bind rights revocation to both submission and output; keep TTS speaker consent a distinct pre-effect path.
- **Exit:** J-03 real API/client/UI happy, denied, stale version, language/timing missing, revoked voice, unknown and recovery tests; exact transcript/caption ancestry.
- **Proceed without external gates:** Qualify one available STT profile first; unqualified language/voice profiles return explicit NOT_ADMITTED, not fake transcript.

### RUN-06 — `PARTIAL`

- **Where:** ghatana/services/media/modules/{vision,multimodal-service}; MediaModalityContracts; Ghatana AI Inference public AiInferenceClient; Document Intelligence public client
- **Do:** Build explicit modality adapters with typed request/result/error and clock/span/coordinate bounds. Keep model routing with AI Inference and generic OCR with Document Intelligence; adapt scene-text to Media frame/timeline identity. Qualify each profile separately and report uncertainty/unsupported alternatives.
- **Exit:** Real selected-profile result tests for coordinate/time precision, metadata/locale/uncertainty, incompatible input, wrong provider/profile and consent denial; no implied quality.
- **Proceed without external gates:** When real inference/DI owner endpoint unavailable, complete local contract integration and disabled-live profile with a narrow mock; do not vendor their runtime.

### RUN-07 — `PARTIAL`

- **Where:** ghatana/services/media provider/adapters and launcher; PDP-1 operation contracts; runtime-contracts; media UI creation/render screens
- **Do:** Implement first source-free creation vertical and one source-derived edit/composition/render vertical with immutable specification/plan/run/output IDs, output verifier and quality rules. Select a single eligible provider/profile per lane, explicit creative-vs-preserve provenance and no implicit alternatives. Delivery is separate destination-effect step.
- **Exit:** Each path has exact input/version, output digest, provenance, source preservation, policy/rights/quality and known/unknown delivery outcome; no source overwrite or false engine admission.
- **Proceed without external gates:** If provider not qualified, finish deterministic local staging/specification and return NOT_ADMITTED for generation; do not make second replacement provider to satisfy tests.

### RUN-08 — `PARTIAL`

- **Where:** ghatana/services/media/launcher/MediaLifecyclePublisher.java; providers/aws-postgresql; Shared platform/java/messaging OutboxPublicationSource, ClaimedOutboxPublisher
- **Do:** Use RUN-03's *same* transactional outbox, not another mechanism. Production adapter persists events, claim token/lease, delivery attempt/fingerprint, ordered publish, durable publish-ack and consumer observation separately. The legacy AudioVideoOutboxStoreImpl uses ConcurrentHashMap and is explicitly TEST_ONLY until replaced with transactionally durable storage.
- **Exit:** Two-publisher claim race, broker-accepted/db-ack-lost, duplicate/out-of-order delivery, shutdown/restart, privacy, tenant, consumer receipt and no reexecution of domain effect tests.
- **Proceed without external gates:** Use fake broker and local Postgres first; Event Plane final-delivery integration waits for a real public owner contract, but outbox correctness can finish.

### RUN-09 — `PARTIAL`

- **Where:** ghatana/services/media/audio-video-observability/; launcher/; prometheus.audio-video.yml; monitoring/
- **Do:** Instrument version-scoped traces across request -> policy -> job -> attempt -> outbox -> provider -> consumer; counters for UNKNOWN/retries/fencing/denials, histograms for latency/queue/backlog, finite-cardinality tenant-safe labels and log redaction. Add rule tests, operator dashboards and alert runbooks.
- **Exit:** Injected fault produces bounded measured signals and firing alerts for stuck lease, UNKNOWN backlog, publication ambiguity, high-denial and capacity; no raw payload/credentials or high-cardinality IDs in labels.
- **Proceed without external gates:** Run local OTEL/Prometheus test stack before deployed service; qualification must later identify real profile and environment.

### RUN-10 — `PARTIAL`

- **Where:** ghatana/services/media/integration-tests/; providers/aws-postgresql tests; tests/load; security/retention/runbooks; multimodal module
- **Do:** Qualify all implemented verticals on an environment manifest with source/profile/engine/build versions and real selected infrastructure. Repair multimodal AbstractTypedAgent package/ABI mismatch first; do not promote Gradle tests run with -x multimodal compile or excluded Java source. Test saturation, crash/retry, S3 corruption, hold/erasure, multi-tenant privacy, auth abuse and restore/DR.
- **Exit:** Pinned repeatable non-skipped integration matrix and measured budgets; defects triaged to exact implementation owner, new release work only for affected surfaces.
- **Proceed without external gates:** Nonproduction Testcontainers/load preparation may run alongside RUN-01..09; production-like qualification waits for the real selected profile.

## Product experience, review, Lifecycle and release

### EXP-01 — `PARTIAL`

- **Where:** pdp-3-product-experience/screen-registry.yaml; apps/media-experience-explorer/; libs/audio-video-ui/src/screens/
- **Do:** Generate a complete 47-screen status matrix from exact product route/runtime bindings: LIVE_IMPLEMENTED, LOCAL_SIMULATION, CONTRACT_PREVIEW, NOT_ADMITTED. Preserve one Media renderer and independent Product vs Explorer contexts.
- **Exit:** 47 exact IDs including review-workspace-settings; no preview route claims network capability; negative route/status tests.
- **Proceed without external gates:** Contract previews stay inspectable before production web host is ready.

### EXP-02 — `PARTIAL`

- **Where:** pdp-2-design-interface-system/gui; libs/audio-video-ui/styles.css and components; Shared theme primitives
- **Do:** Apply one source-owned token/type/spacing/interaction system, not CSS patches per page. Verify narrow/wide/zoom, RTL, contrast/forced colors, reduced motion, keyboard, focus, time-based captions and unknown-finality confirmations in representative functional screens.
- **Exit:** Browser render/keyboard/axe plus documented manual assistive-tech paths; zero critical a11y regressions, no CSP relaxation.
- **Proceed without external gates:** Develop with current compatible Shared source exports; independent signoff stays ACC-02.

### EXP-03 — `PARTIAL`

- **Where:** PDP-3 journey-contracts/J-01,J-02,J-20,J-03; libs/audio-video-ui; launcher/API/SDK
- **Do:** Deliver four ordered **functional** journeys: J-01 identity/workspace/project -> J-02 upload/verification/artifact -> J-20 job inspect/reconcile -> J-03 transcript/caption version. Wire real guarded actions, deny/unknown/conflict/recover and strict tenant/version isolation.
- **Exit:** For each admitted journey: positive, denied, stale, timeout, restart, unknown and recovery E2E fixture + real host/provider result with source-bound IDs.
- **Proceed without external gates:** Work one journey at a time; unavailable Shared auth/provider keeps only that live step disabled while fixtures remain truthful.

### EXP-04 — `PARTIAL`

- **Where:** pdp-3-product-experience/scenario-fixture-registry.yaml; libs/media-experience-simulation/src/{fixtures,definition-oracles}.ts
- **Do:** Approve preservation of 4 seeded journeys and 26 bounded-oracle-only journeys; do NOT demand 26 fabricated rich fixtures. Select next rich scenarios by user value: J-04,05,07,08,09,16,18,26 where exact owner facts exist; test deterministic denial/UNKNOWN cases; record intentionally conditional paths.
- **Exit:** Counts remain accurate, every selected rich scenario has reproducible typed inputs/negative expected effect, remaining bounded oracles explicit.
- **Proceed without external gates:** No rich fixture for unsupported provider, false rights/consent or unknown outcome.

### EXP-05 — `PARTIAL`

- **Where:** scripts/check-media-contract-parity.mjs; pdp-2 agent-tools/conventions.yaml; pdp-3/agent-tools/tool-registry.yaml; SDK/CLI; canonical media routes
- **Do:** Close the two STRICT parity findings by implementing actual four Agent Tool adapters and exact typed request/result/error/operation mapping, or classify as unsupported runtime at specific boundaries. Reconcile proposal-only PDP-1 role with the actual implemented endpoint/source review; do not flip accepted status by text edit. Typecheck/sdk-pack gRPC/HTTP consumers with explicit error/cancel/retry model.
- **Exit:** Strict parity has zero genuine behavioral gaps for all ADMITTED operations; unsupported bindings deliberately fail and remain NOT_ADMITTED. Definition-only check stays independently green.
- **Proceed without external gates:** Do not block other non-Agent channels on pending Agent Tool publisher; owner review status separate from runtime parity.

### EXP-06 — `UPSTREAM_NOT_AVAILABLE (RECHECK)`

- **Where:** Lifecycle source pack producer and gtool; Media Explorer topology adapter; Lifecycle qualified package manifest
- **Do:** Reuse one read-only viewer for selected root, composite and physical packs. Integrate SUR-08 source candidate behind explicit development flag, then replace by admitted version/digest and authoritative phase program; validate source selectors, tenant-hidden paths and no writes.
- **Exit:** Exact pack schema/contract version and selected-source digest; three-node navigation and API/CLI-only view without invented UI; native status claimed only after issuer API.
- **Proceed without external gates:** Current local topology Explorer remains available; missing publication never blocks Media-owned screen work.

### EXP-07 — `LOCAL_COMPLETE`

- **Where:** docs/EXAMPLES.md; pnpm check:product-experience-local
- **Do:** Preserve the current source-linked CLI/API/GUI synthetic examples and status labels. Extend only when a new live vertical is admitted.
- **Exit:** Current samples never claim production effect without a route and readback.
- **Proceed without external gates:** No rework on unchanged examples.

### ACC-01 — `EXTERNAL_PENDING`

- **Where:** ghatana-media #4; .product-experience/acceptance.yaml; phase dev gate records
- **Do:** Prepare read-only independent domain/security assessment packet for 462 capability leaves, PDP-1 state/authority/privacy and exact material deltas. Record qualified reviewer identity, independence, methods, source SHA, adverse findings and changes; distinct Media delegated-owner review is already available for engineering.
- **Exit:** Real independent accepted/changes-requested decision on fixed revision, all high-severity findings resolved before certification.
- **Proceed without external gates:** Proceed with implementation and internal peer review, but label formal independent outcome PENDING until actual reviewer signs.

### ACC-02 — `EXTERNAL_PENDING`

- **Where:** ghatana-media #4; Shared #234; UI/browser reference and a11y audits
- **Do:** Book/assign an actual qualified human visual/accessibility reviewer; give exact routes, fixtures, locales, browsers, screen-reader versions, zoom/forced-color/reduced motion cases. Implement findings at shared component/template level.
- **Exit:** Attributed acceptance decision + tested fix/waiver with genuine grounds; assistive-tech observations rather than automated-only assertions.
- **Proceed without external gates:** Local UX fixes and automated audits proceed without waiting; human acceptance cannot be self-issued.

### ACC-03 — `EXTERNAL_PENDING`

- **Where:** Shared #234/#242; Ghatana #254; Tools #31; typed public package/release manifests
- **Do:** Split four owner packets by contract and version: UI exports, trusted identity, platform event/action/read models, nonbinary effect/finality. Tools #31 reports source implementation; verify compatibility before requesting remaining publication/owner acceptance. Pin each receipt to exact upstream commit and package digest.
- **Exit:** Four owner decisions or narrow declared unsupported contract paths, with installed consumer tests. Any library license/publication gap remains explicit.
- **Proceed without external gates:** An absent upstream signature cannot be replaced with a Media signature; invoke local typed mock and deny live paths.

### LC-01 — `EXTERNAL_PENDING`

- **Where:** ghatana-lifecycle #1; config/closure/media-product-definition/; gtool public contracts; Media topology
- **Do:** After published program-qualified units and admitted installer exist, register exact direct per-leaf/composition PDP applicability, native source tests, independent observer/oracle and qualified source artifact. Namespace (repository,surface,program,phase); no fabricated currentness.
- **Exit:** Lifecycle issuer accepts scoped cases and can independently read back current receipts; no duplicate/excluded cases.
- **Proceed without external gates:** Prepare import candidates and independently closable leaves now; run native admission later without rerunning unrelated functional tests.

### LC-02 — `EXTERNAL_PENDING`

- **Where:** Lifecycle Surface Convergence / Work Planner public issuer; Media config/closure/; topology
- **Do:** Close small groups of current physical leaves then direct composite integration and root, respecting CONTAINS vs DEPENDS_ON. Reuse prior receipts unless material input changed; tolerate independently open siblings where parent policy allows.
- **Exit:** Authenticated current receipts and convergence per program-qualified unit; negative change invalidates exactly affected membership/prerequisites.
- **Proceed without external gates:** Keep explicit local developer readiness outside issuer, never emulate receipts.

### REL-01 — `DEFERRED`

- **Where:** release manifests; Toolchain selected dependency policy; Docker/infra; SLO/DR/security artifacts
- **Do:** Qualify immutable release image/package + transitive license/SBOM/security signatures, bounded admitted media/profile/provider configurations, secrets/key rotation, load/restore/hold/erasure, alert/rollback drills. Differentiate internal canary from GA.
- **Exit:** Real environment/profiles satisfy measured criteria; release/security/ops owners authorize staged activation and rollback.
- **Proceed without external gates:** Build candidate and run unprivileged nonproduction tests early; do not label production-qualified before evidence.

### REL-02 — `DEFERRED`

- **Where:** migration/transfer-receipt.yaml; ghatana and ghatana-media runbooks; Data Cloud/TutorPutor/DI consumer manifests
- **Do:** Execute an explicitly authorized one-writer canary on approved date/window after MIG parity, stable artifacts, secrets, telemetry, restore and backout proven. Start smallest allowed slice; observe real contracts and consumer outcomes; rollback on unknown or unsafe effect.
- **Exit:** Named release owner approves rollout based on actual canary/rollback measurements; old runtime authority retired only after consumer readback.
- **Proceed without external gates:** No unconditional preapproval of production cutover; continue nonproduction rehearsal until required authority is available.

## Mandatory engineer handoff, final checks and stopping rules

Each cohesive task packet must identify **task IDs, exact changed source IDs/files, canonical owner, prior/source HEAD, semantic decision, source/application status, affected dependent surfaces, positive and negative tests, unresolved upstream claims, and next single concrete action**. Do not report a task complete because source files exist or tests unrelated to its external effect are green. An unchanged reviewed input does not reopen a phase; a changed normative input reopens only its affected selection/contract and watchers.

Representative commands (discover current scripts on the active branch before running):

```bash
# Media: fast changed-source/local semantic checks
node --test tests/media-physical-topology.test.mjs
node scripts/check-media-physical-topology.mjs
node scripts/generate-media-pdp3-implementation-handoff.mjs --check
node scripts/generate-media-post-pdp-status.mjs --check --strict
node scripts/generate-media-phase-projections.mjs --check --strict
node scripts/check-media-contract-parity.mjs --definition-only
# Also run strict parity after real runtime adapters are implemented:
node scripts/check-media-contract-parity.mjs

# On canonical ghatana, do not claim full qualification with -x compileJava:
./gradlew -Pghatana.shared.profile=development \
  :services:media:runtime-contracts:test \
  :services:media:providers:aws-postgresql:test \
  :services:media:launcher:test --console=plain

# Full Media Node integration once the source cut has stabilized:
node --test --test-concurrency=4 tests/*.test.mjs
```

**Completion** means the 7 already-complete tasks retain their reviewed source invariants; 8 reviewed mapping tasks have Media engineering decisions and exact current evidence; partial implementation tasks pass their selected live/local contracts; each external and deferred task either obtains its **actual owner-issued** acceptance or remains explicitly `NOT_ADMITTED`/not released, while independent tasks continue. Production handover requires real compatibility/rollback, owner identity, licensed artifacts and release approval. No blanket assertion that all 47 are closed until those facts exist.

**Current actions to execute first:** fix SUR-07 exact 47-screen coverage; tighten SUR-03 DAG/dedup policy; update SUR-08 current Lifecycle source-candidate classification; repair multimodal agent API binding on the canonical runtime; implement RUN-03/RUN-04/RUN-08 as a single durable transaction/reconciliation vertical while other agents advance RUN-01/02 and UI. Do not delay this for approvals unrelated to those code paths.
