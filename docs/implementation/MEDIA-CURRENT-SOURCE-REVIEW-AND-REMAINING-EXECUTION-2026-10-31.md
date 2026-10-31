# Ghatana Media — October 31 source-audited residual execution and owner decisions

> **Status:** owner-approved engineering execution handoff, not a claim of performed implementation/independent acceptance. Source observations: `ghatana-media@07b3df1978068d0873e7ff75f5cd3ee18c9ace58`, `ghatana@0381dc64c211ebf55bf4bfa5826a4aaec1a71357`, `ghatana-kernel@209921dea4f13c756deaa0a945580df4587ffbf3`, `ghatana-shared@13548bf7e73f8868eeba3626a763aa2cd82bddf4`, `ghatana-lifecycle@ac9e707c66338dd1a357ee055c12949cc2de5326`. Refresh all pins before running; committing this document advances Media main. **This review inspected GitHub source but did not locally run Java/TS/Python/Cargo suites or protected gtool host commands.** Last reported local passing tests are implementer observations, not new independent receipts.
>
> **Machine-readable paired handoff:** [MEDIA-REMAINING-OWNER-DISPOSITIONS-2026-10-31.v1.json](MEDIA-REMAINING-OWNER-DISPOSITIONS-2026-10-31.v1.json): 29 physical + 21 logical + 7 composite + 30 V-journey records, each with stage targets, existing task identities/paths, and 18 current corrective findings, with 3 CAP findings separately completed. This file does not replace Media PDP source, canonical F/V/L/X tasks, Wave2 R8, W3/H, Lifecycle method or actual receipts.
>
> **Prior full all-stage baseline (reuse):** [All-surface lifecycle runbook](MEDIA-ALL-SURFACE-LIFECYCLE-GTOOL-EXECUTION-2026-10-30.md). **Canonical implementation package authority:** [MEDIA-BUILD-IMPLEMENTATION-PLAN.md](MEDIA-BUILD-IMPLEMENTATION-PLAN.md); **runnable current backend work detail:** [MEDIA-BACKEND-REMAINING-SURFACES-2026-10-30.md](MEDIA-BACKEND-REMAINING-SURFACES-2026-10-30.md); **original acceptance:** [R8 matrix](MEDIA-WAVE2-R8-FULL-ACCEPTANCE-MATRIX.json) and [terminal Q00–Q16](MEDIA-BACKEND-TERMINAL-QUALIFICATION-2026-10-30.md). Do not duplicate original task IDs or invert meaning with this review.

## 0. Controlling current completion — CAP-01/02/03 finished; do not repeat

**Accepted engineering handoff (from implementer's real host evidence, with source commits checked):** `a5be0f60` implements CAP-01/02/03 and `07b3df19` corrects V028–V029 migration-lineage fixture counts. Reviewed `ghatana-media@07b3df19`. *Preserve the local source-linked test observations; this remote audit did not re-execute them.* CAP is **HOST_VERIFIED_ENGINEERING_COMPLETE**, not universally Build/R8/PDP/native/release complete.

| Verified component | Observed new code / test boundary | Disposition |
| --- | --- | --- |
| PostgreSQL caption and transcripts | `V029__media_transcript_version_ref_readback.sql`, `PostgresqlMediaTranscriptStore.revisionByVersionRef(...)`, exact immutable parent, V001–V009→V010–V029 replay-fenced migration, full provider suite **111+ reported green** | **CAP-03 COMPLETED**; retain actual one-writer/production cutover and whole-journey proof separately |
| Launcher/security/profiles | `MediaDeploymentProfiles` shared by launcher, security, persistence and modality hosts; caption/consent missing returns typed HTTP 503; launcher/runtime-contract suites reported green | **CAP-02 COMPLETED**; other feature readiness, security and release proof remain |
| TS SDK | Credential supplier/Bearer, scoped exact single-caption readback, typed read error, request fingerprint/reconciliation; **12/12 reported green**, TypeScript typecheck clean | **CAP-01 COMPLETED**; independent packed consumer/full J03 workflow still to prove |
| Other modality compile | STT/TTS/Multimodal compiled on reported host; 3 pre-existing test classes fail reproducibly on unmodified main | **NO CAP REGRESSION**, but open baseline quality defects; cannot make full modality suite green by exclusion |

**Live remaining priorities:** (1) VIS-09 production binding with trusted Media source/crop and DI provider, independently qualified resource/YOLO startup profiles; (2) DI-owned Kernel `OcrProvider` plus Shared client peer, real DI worker/2 source-free consumers; (3) Track B 57/54 roster and current pins, PDP0 `IN_PROGRESS`, two parity findings; (4) Kernel KCRIT and protected Lifecycle AP-02/AP-03/native receipt; (5) three real baseline TTS/Multimodal failures; (6) all remaining original F/V/L/X, Wave2 R8/W3/H, UI/Recorder/Studio/Player, real model and stream outcomes. No unrelated surface is blocked merely because DI or native gtool proof is unavailable.

**New critical architecture finding:** `VisionGrpcServer.createProductionRuntime()` constructs `ProductionVisionGrpcService` whose `compose()` requires qualified YOLO before service bind. Thus current DI-only `RecognizeSceneText` can be unavailable solely because YOLO lacks admission, even if DI has a valid provider. Owner decision: **implement an explicit source-approved `OCR_ONLY` Vision host profile with independent per-RPC admission and readiness while preserving existing `FULL_VISION` detector fail-before-bind behavior**. This is a deliberate source-visible new host profile, **not** removal of existing safety gates. A no-detector dummy does not count as qualification.

**Source integrity finding:** the current scene-text seam compares caller-provided cropped bytes with their caller-provided SHA; without a source-owned crop check that does not prove those bytes are the actual authorized frame ROI. Bind immutable source/frame/PTS and independently derive crop bytes/digest (or validate an owner-attested exact crop receipt) under current tenant/purpose/rights. The DI HTTP client currently accumulates a full response via `BodyHandlers.ofByteArray()` *before* the 32 MiB rejection check; bound allocation during reading, not afterward, and qualify endpoint/service identity.

### Three baseline failures — real work, not CAP blockers

| Original failing test | Source finding | Corrective owner action and no-weakening criterion |
| --- | --- | --- |
| `TtsWave2InventoryTest` | Confirmed text test expects `super(library, metrics,`; current `ProductionTtsGrpcService` uses `super(runtimeAdmission.library(), metrics,` | TTS engineer: capture exact failure and replace stale literal check with contract/constructor/admission behavior; preserve all 11 TTS RPCs, 17 source synthesis intents, denied-provider semantics and source-free descriptors |
| `TtsGrpcServerReadinessTest` | Reportedly reproduced on unmodified main; exact failing method/assertion not supplied | TTS engineer: inspect JUnit failure; run class alone and with neighbors, verify provider health transitions, `TtsRequestAuthorization.isReady`, borrowed engine close, strict NOT_SERVING without qualified authority. Fix code/test to actual declared behavior, never force ready to pass |
| `MultimodalGrpcServerCompositionTest` | Reportedly reproduced on unmodified main; exact assertion not supplied. Test uses JWT system property, global `MetricsServerInterceptor`, `freePort()` and exact unary method/count expectations | Multimodal engineer: record XML, compare isolated/batched; investigate exact error, metrics bleed or port race **as hypotheses only**. Fix measured cause, preserving one child attempt, no duplicate dispatch, UNAVAILABLE on child loss and NOT_SERVING when required provider absent |

Use scoped original Gradle selectors and JUnit XML; do not skip/disable tests or loosen model/rights policy. These may run independently of DI/Track B.

---
## 1. Current source-based findings and remaining boundaries

The **14 Media commits preceding the CAP work** added actual caption HTTP contracts, Java/TS fingerprint parity, V028 persistence, VIS-09 DI-only Java client and gRPC `RecognizeSceneText`, bringing route manifest **27→30 HTTP** and proto **43→44 gRPC**. CAP's two additional commits are on current `main` and fix the previously documented caption seams. This is a **source observation plus separate user-reported test evidence**, not a new completed R8 whole-row count.

- **CAP source no longer blocked:** the current `caption-version.ts` has credential supplier, typed read errors, `GET` exact snapshot and fingerprint-verified reconciliation. `MediaCaptionParentClockLookup` uses `MediaTranscriptStore.revisionByVersionRef`, backed by real PostgreSQL `transcriptVersionRef` in V029; the common profile classifier covers production/staging/sovereign/integration/e2e. Current `MediaHttpHandler` returns typed 503 for missing caption/consent. Preserve this code and its reported host tests.
- **Vision DI gRPC still source-only in production:** `RecognizeSceneText` calls `SceneTextRecognitionService` and obtains tenant/principal from verified gRPC Context, but `sceneTextService` is null unless installed. `ProductionVisionGrpcService` does not install it; it also requires YOLO model admission before startup. Source authority and frame-ROI pixels must be independently bound. No real DI worker/qualified OCR report or source-free positive observed.
- **DI/Kernel ownership still open:** Ghatana DI client `0.1.0` declares Shared `@ghatana/document-extraction@0.1.0-SNAPSHOT`; there is no independently qualified installed release/worker claimed by this review. Kernel still recognizes `media.ocr` and Media `adapters/ocr-compat` is intentionally NOT_ADMITTED. Move actual `OcrProvider` implementation/registry owner to DI, then delete the old Media engine/registration; keep source-visible compatibility where needed until source-free consumers prove replacement. Public TS named provider adapters are **DI gateway wrappers, not separate model executors**.
- **Track B owner sources unchanged after CAP:** current topology declares **29 physical + 21 logical + 7 compositions = 57**; 54 historical phase-matrix subjects are bound. Exactly two active/support physical additions need scoped generator rows (agent tools and optional Data Cloud); legacy OCR adapter is `RETIRE_UNDER_OCR_M03` and should be removed after Kernel switch, producing 56 expected declarations, **not necessarily 56 ClosureUnits**. Four PDP source status files record **872** source selectors (188/137/180/367) and still reference `mainSha=b7685542...`. Host previously reported **67 stale selectors**, which must be **recounted after CAP changes** rather than assumed still equal 67. PDP-0 still records `IN_PROGRESS`, zero outstanding meaning IDs, and 29 P0-03 skipped cases; P1/2/3 record `DEV_COMPLETE` at older source. Real owner impact and direct criterion evaluation required, not blind pin refresh.
- **Parity remains two reported findings:** retrieve current machine-readable IDs and test exact behavior, not the reported count alone. Source bridge inventory currently projects zero unresolved P1 operation joins and 8,667 edges; this is planning trace, not KCRIT Plan Ready, actual implementation or native closure.
- **Baseline regression debt:** `TtsGrpcServerReadinessTest`, `TtsWave2InventoryTest`, `MultimodalGrpcServerCompositionTest` reported failing on unchanged pre-CAP source. The TTS inventory test has at least one confirmed obsolete literal, but full failure logs are required to attribute the others. Fix and rerun normal suites without skipping.
- **Protected lifecycle owners:** the recent Lifecycle source adds storage/receipt and bounded execution work, but this does **not** create an authentic Media AP-02/AP-03 selection, method transition, independent reviewer or native receipt. Lifecycle owns both Media-specific issues #24/#25 and its separate own-repo AP02/03 issue #29; don't conflate those authorities.
- **Original engineering ledgers not promoted:** 58 Wave2 IDs still have 22 previously locally verified and **36 whole rows not accepted** by current R8; 96 W3/H rows separately require exact source/test/positive-effect readback. These may overlap existing F/V/L/X packages and are not additive unique capability counts. The 19 owner-dispositioned Build task blockers are approved for work, not completed by that approval.

### Current triage

**P0 executable coding:** VIS-09 runtime/DI profile/source crop/response limits; DI-owned Kernel OCR/public Shared peer; owner source Track B and exact P0 status; old/writer Flyway real applied-history check, KCRIT per eligible surface and true Lifecycle AP02/03 private host setup. These run concurrently; none is another CAP repair.

**P1 quality/complete product:** fix 3 preexisting baseline suites, real STT/TTS/Vision/MM licensed model/voice/quality, 5 missing WebRTC/adaptive-HTTP/HLS/DASH/lease intents, agent/event/data integrations, all 30 live journeys and 47 GUI screens, Recorder/Studio/Player, 30 HTTP/44 gRPC parity.

**P2 release/operate/enhance:** actual protected releases and owned host/pager, measured performance, source-retention/erasure, actual outcome learning and next scoped iteration.

## 2. Binding architecture and technical owner approvals

**Owner decision A — all ordinary work APPROVED.** Implementers are preauthorized to repair Media/Ghatana/Kernel/Shared/Lifecycle code, schemas, generators, tests, package and public contract consumption, and to update current source-owned documentation. No additional approval request for deterministic decisions that respect existing public ABI, policy, phase and owner boundaries. One source writer per conflicting file and migration; parallel disjoint leaves.

**Owner decision B — DI is OCR execution owner; Media remains source/time authorizer.** Two parallel mandatory tracks: (a) production SceneTextRecognitionService composed into Media Vision, (b) DI-owned Kernel `OcrProvider` with real public client and source-free contract. OCR-M03 is a *post-adoption destructive source cleanup* only. DI model selection/provider qualification stays in Ghatana; Media may observe the catalog and enforce its own allowed processing profile, not run a competing engine. Data Cloud is optional downstream projection.

**Owner decision C — caption semantics are immutable and source-rights-gated.** Client must use JWT/delegated identity; never treat caller-supplied principal as authority. Exact transcript-version parent and source-tick tuple are mandatory. Requests with ambiguous remote commit have one stable request ID and fingerprint, are reconciled before any repeat dispatch. Version reads obey current authorization and explicit retention/audit purpose; no hidden exposure after revocation.

**Owner decision D — full lifecycle v3 with independent leaf work.** Use Lifecycle `tools/documentation-model/presets/methods/ghatana-product-development.v3.yaml`, Work Planner, Verification Planner, Evidence Generator and Surface Convergence. Source PDP status, implementation task status, owner method transitions, native closure receipt, provider admission and Delivery are six distinct axes. No Media-local phase state writer, no global barrier from unrelated surfaces before development-complete.

**Owner decision E — security and availability.** Use existing Shared/Kernal auth and MediaSecurityFilter, a canonical trusted deployment-profile classification, per-feature availability where possible, bounded time/resource/network and truthful typed failures. The DI worker is not a global Media lifecycle dependency; absent Data Cloud cannot prevent Media jobs. A full product ready probe may still truthfully report incomplete required capability.

**Owner decision F — infrastructure and migration.** Code ownership moves to `ghatana-media`; historical `ghatana/services/media` is read-only source comparison until actual deployed writer transfer. F01/F05 must use real applied Flyway history (historical canonical V001–V016 versus conflicting Media mirror V007–V009, now V028/V029 caption and exact transcript-version extension), quiesce/fence writers, and rehearse rollback/forward recovery. No same-DB dual writer and no blind migration renumbering.

**Owner decision G — proof and rights are not delegated by prose.** Engineering approval does **not** grant source/media/model/voice/biometric license, protected signer enrollment, independent research/visual/security review, production release keys, destructive production DB cutover or release admission. Create explicit owner-provisioning actions with input/consumer/test/oracle, continue independent work; never fake eligibility or receipts.

## 3. Fixed original acceptance and preservation accounting

Canonical package inventory: **F00–F13 (14), V01–V30 (30), L01–L03 (3), X01–X03 (3) = 50 packages** with 57 original Build plan tasks. The separate 88 backend-support local tasks and 8 H logical tasks are *not* substitutions for the 50-package plan. 58 original Wave 2 tasks remain immutable identifiers, 36 unaccepted against original R8 oracles; Q00–Q16 coordinate genuine acquisition/qualification without creating new task authority. Do not mark a row accepted because code exists or related module tests are green.

For every original task ID in its owning ledger, require `sourceCommit`, `surfaceId`, `methodNodeId`, `owner`, `originalCriterionRef`, exact positive+negative+recovery tests, legal rights/model/host profile when relevant, observed output and fail-closed absence behavior, linked consumer test, explicit reviewer disposition, and status from the **canonical owner**. Preexisting passed tests are reused only when source/material/ABI remains current. Every unproven positive remains a real work item.

## 4. Exact remaining corrective implementation and owner dispositions

Review finding IDs below are coordination handles, **not new PDP, F/V/L/X, R8, W3/H or gtool identity authorities**. The prior CAP-01/02/03 rows have been **removed from active corrective work** and retained under `completedEngineeringFindings` in the paired JSON.

| Finding | Owner repo | Exact implementation | Exit test/oracle |
| --- | --- | --- | --- |
| **VIS-09-PROD** | `ghatana-media` | Explicit env/config source-bound composition with trusted Media SourceAuthority and DI policy, qualified provider, bounded DI endpoint + TLS/auth, no Media OCR model fallback; bound blocking provider call in worker pool away from gRPC event loop. | Real DI worker PNG/ROI text+boxes PTS over installed DI and real gRPC client; cross-tenant, bad frame/hash, cancel, timeout, DNS and DI outage no stale text. |
| **OCR-K01** | `ghatana` | Implement DI-owned Java Kernel ProductRuntimeFacets.OcrProvider/ ProductRuntimeProvider adapter in DI owning module; bind existing media.ocr compatibility capability ID to DI provider through Kernel registry without a second OCR engine; support extract, cancel, status, exact terminal and source version. | Packed Kernel source-free provider materialization and real image→text / outage / rights / cancellation conformance; zero Media registry owner. |
| **OCR-D01** | `ghatana` | Resolve Shared @ghatana/document-extraction 0.1.0-SNAPSHOT peer release contract; qualify immutable client package and DI v1 provider catalog/parse/cancel; model rights+real quality separately. Existing named client adapters wrap DI only; do not misclassify them as local OCR execution. | Packed TS+Java consumer, Python strict contract, PNG+PDF independently labeled qualified OCR, invalid media/locale, provider outage and privacy tests. |
| **OCR-M03** | `ghatana-media` | After DI-owned Kernel binding and live consumers qualify, remove OcrService, stale extractText shims, Media OcrProvider adapter, Gradle/settings/exports/manifests and retired topology candidate; preserve non-OCR geometry/tracking. | No production old OCR symbols, tests or registered provider; 56 surviving declared roster IDs with authoritative phase projection, public consumers pass. |
| **TRACK-B** | `ghatana-media` | Re-evaluate reported 67 stale sourceShaSet pinned selectors against actual source/member digests; collect exact two current parity diagnostic IDs; owner-review every changed meaning, then generator-only refresh impacted pins. Extend active agent-tools/support and DataCloud/optional rows, preserve 54 unchanged and retire OCR row only after migration. | Current P0 actual status reconciled (present file IN_PROGRESS, P1-P3 DEV_COMPLETE), correct full selected 56-row roster after retirement, no hidden skipped/UNKNOWN cells, scoped source tests and parity oracles. |
| **KCRIT** | `ghatana-kernel` | Evaluate actual canonical 50 packages/57 original plan task IDs and remaining 19 blockers for exact independently eligible Build surfaces; owner-supported revision/idempotency and genuine source fingerprint, not Media-owned stage engine. | Source-current KCRIT-PLAN-TASK-CLOSURE and KCRIT-PLAN-READY authentic owner readback/transition; N/A/UNKNOWN explicit. |
| **AP02-AP03** | `ghatana-lifecycle` | Complete trusted AP02 contract distribution, AP03 source snapshot selection+verifier and real host binding; correct independent physical-to-composition closure graph and source-to-case/observer/oracle binding, bounded native gtool first leaf and separate phases. | Authentic signer/verifier/receipt/currentness, revocation and source mutation negatives; never provision fake keys or advertise closure from source-only checks. |
| **STREAM-QUAL** | `ghatana-media` | Finish previously unadmitted WebRTC, adaptive HTTP, HLS, DASH and lease renewal by existing public Media session authority; actual 1/16/64 performance, backpressure/ACK/VFR/rights/no double delivery. | Real end-to-end stream in tested host with recovery and exact original R8/W3 oracles. |
| **MODEL-QUAL** | `ghatana-media` | Use licensed pinned model & legal first-party or licensed gold for real STT/TTS/Vision/MM, source/voice/biometric restrictions, true WER/CER/mAP and audio sample/fidelity profiles. Cannot self-grant external rights. | R8 original whole-row independent quality/rights/recovery receipts; blocked modes remain unadmitted if no lawful input. |
| **WRITER** | `ghatana-media` | Review applied old Ghatana writer schema V001–V016, prepared Media conflicting V007–V009 and new V028; perform rehearsed snapshot migration, quiesce/fence old producers, one writer, rollback/forward-only schema evolution. | No two live writers, no conflicting Flyway histories or lost/duplicated leases, captions remain available after restart. |
| **WHOLE-PRODUCT** | `ghatana-media` | Retain F00–F13, V01–V30, L01–L03, X01–X03; complete 47 real UI screens, 30 real journey terminals, two-pass per-edition recording, 30 HTTP/44 gRPC and SDK/CLI/agent/events parity with native closure separate. | 30 live journeys + 47 real screens + original 36 R8 and 96 W3/H accepted, no new source-without-runtime success. |
| **EXTERNAL-PLATFORM** | `ghatana` | Prove Event Plane HTTP 201 append and distinct eventual consumption, Action Plane remote acknowledgement, Data Cloud authorized optional projection, 32 relevant AEP cases; owner source-free ABI. | Owner-qualified real restart/partition/outage/receipt and Media non-dependency on Data Cloud. |
| **VIS-09-CAPABILITY-PROFILES** | `ghatana-media` | Current VisionGrpcServer creates ProductionVisionGrpcService which requires admitted YOLO before port bind; new DI-only OCR must not inherit YOLO prerequisite silently. Choose source-approved explicit OCR_ONLY host profile with independent per-RPC readiness/dispatch, preserving existing FULL_VISION detector fail-before-bind contract and never using dummy detector. Qualify gRPC admission/status for each capability. | With DI qualified but YOLO absent, OCR_ONLY RecognizeSceneText proves real positive while detect/classify unavailable; FULL_VISION unchanged missing-YOLO fail startup; DI unavailable does not affect admitted non-OCR detection; no weak global health. |
| **VIS-09-SOURCE-PIXEL-FENCE** | `ghatana-media` | Existing service checks caller crop self-hash and authority's original frame hash, but no authoritative re-derivation of actual ROI pixel bytes is present in this seam. Implement trusted frame-crop resolver under source-rights authority (or authenticated immutable crop receipt with content-bound ROI and source digest). Verify source version, true original frame bytes, PTS/timebase, ROI crop digest and owner policy before DI. Do not treat caller self-hash as provenance. | Malicious arbitrary crop with a valid self-hash cannot reach DI; exact source-digest, wrong ROI, frameId/PTS mismatch, tenant principal/purpose/revocation, late cancellation and true positive geometry tests. |
| **VIS-09-HTTP-RESOURCE-BOUNDARY** | `ghatana-media` | Current client uses HttpResponse.BodyHandlers.ofByteArray() and validates the 32MiB cap only after buffering. Replace with bounded streaming body subscriber / size-limited input, finite whole deadline, true cancel/reconcile, allowlisted host/TLS trust; use DI v1 unchanged. Production security is mTLS or owner-approved service gateway consistent with DI published authority; do not invent a new DI auth header. | Malicious >max response fails with bounded allocations; bad TLS/host/redirect/DNS, response spoof, unknown operation, timeout/cancel, workers under concurrency and no data leak. Real eligible DI worker parse returned. |
| **BASELINE-TTS-READY** | `ghatana-media` | Inspect provider health probe, readiness markReady/setNotServing, borrowed engine close, TtsRequestAuthorization.isReady gating and 100% fixture isolation. Do not change fail-closed readiness to make test green. | Full class and selected adjacent readiness tests pass on clean main with no ignored tests or weakened security, plus source-current R8 subset. |
| **BASELINE-TTS-INVENTORY** | `ghatana-media` | Test requires text super(library, metrics, but ProductionTtsGrpcService source now calls super(runtimeAdmission.library(), metrics,. Replace source-literal assertion with structured or behavioral admission/constructor conformance; retain exact RPC/capability inventory and provider/rights deny cases. Additional failing assertions need JUnit readback. | Actual public ABI/schema and source currentness pass with genuine denial; no string-only false failure, no waived capability. |
| **BASELINE-MM-GRPC** | `ghatana-media` | Inspect fixture JWT system-property restoration, actual context authentication, global MetricsServerInterceptor counter isolation, freePort() bind race and child-error UNAVAILABLE/readiness after shutdown. Diagnose from exact XML; do not assert a root cause without it. | Class + relevant modality integration PASS on unchanged source scope with provider still fail-closed; no global singleton leakage or green from disabled assertions. |

### Immediate architecture and execution orders

**M-VIS is first:** change the current `VisionGrpcServer`/production composition to inject trusted Media SourceAuthority, immutable source/frame/ROI crop verification, DI-v1 HTTP transport and source-approved provider policy; bind `sceneTextService` only after true DI admission. Introduce an **explicit** qualified OCR_ONLY host profile only after source change-impact review, preserving existing FULL_VISION YOLO admission behavior; expose independent per-RPC status and meaningful health (not a fake healthy detector). Make HTTP response bytes bounded **as received**, cap concurrency/latency and cancel by generation. Test installed DI worker and real image→text/normalized boxes/PTS; denied/changed source, forged crop, redirect/host/TLS mismatch, oversized malicious DI response, provider crash and DI absent all fail without OCR text, while other Media workflows remain independent.

**G-DI + Kernel next, in parallel:** freeze and package public `@ghatana/document-extraction` peer and `@ghatana/document-intelligence-client` release or explicit dev-consumption profile. Implement DI-owned Kernel `ProductRuntimeFacets.OcrProvider` backed solely by DI worker v1 with source/rights/tenant, `extract/status/cancel` and truthful provider receipt. Verify installed Kernel/materializer/Media/product consumers before OCR-M03 deletes Media generic shims/Gradle/module/provider registry/topology. Model/provider/license/quality admission still requires actual lawful image/PDF gold and real worker, not a first-party engineering permission.

**Track B and LFC concurrently:** regenerate **two** impacted physical PDP matrix rows, defer OCR retirement until replacement, freeze/cross-check current source content and recorded pin set; run source-current owner reviews on meaningful changes and separate 29 skipped PDP0 P0-03 cases from old test skips that may be legitimate. Solve current two actual parity IDs with operation semantics, then Work Planner/Kernel `KCRIT-PLAN-TASK-CLOSURE` and `KCRIT-PLAN-READY` for selected independently eligible Build units. Lifecycle AP02/AP03 require current authenticated owner-issued contract snapshot, trusted installed host/helper, native source/case/observer/oracle graph and genuinely accepted receipt, not a consumer JSON, historical 54 count, or code-only fixture. Its own gtool v4/finite storage campaign remains separate: consume qualified published ABI only.

**Baseline TTS/MM issue triage independent of VIS/Track B:** run three named test classes with clean real Gradle JUnit XML (both isolated and neighboring suites). For TTS inventory, repair already-observed stale `super(library, metrics,` assertion to reflect `super(runtimeAdmission.library(), metrics,` **only insofar as real constructor/admission semantics validate it**; replace brittle source text with behavior-based checks where practical. TTS readiness verifies real provider status/authorization and engine lifecycle; MM composition verifies real JWT/gRPC/metrics and one child attempt, no false success/retry. Do not waive these tests to make a green dashboard.

**Runtime/whole-product:** V029's clean Testcontainers migration rehearsal is an important component proof, but `ghatana/services/media` live writer quiesce/fencing and actual deployed Flyway history are still separate. Preserve R8/W3/H whole-row original oracles, finish 50 canonical F/V/L/X packages and Q00–Q16 qualification; any required real positive must use licensed actual provider/host and exact effect, not NOT_ADMITTED. Data Cloud always optional, external Action Plane needs terminal remote receipt, Event Plane 201 is transport acceptance not job completion.

## 5. Every physical surface — exact remaining engineering or acceptance

Every row below inherits **all 14 source-defined Lifecycle v3 nodes** where applicable: PDP0→3, Build Plan→Implement→Verify→Development Complete, Deliver Release→Deliver→Operate, Enhance Measure→Learn→Evolve. Support or archived nodes must have owner-selected N/A or inherited-artifact binding; an empty UI is not a completion result. Phase applicability in the machine ledger is **source class**, not current native status. "Current" always requires owner readback.

| Physical surface | Code path | Existing task IDs | Remaining what / where / how; acceptance oracles | PDP source class |
| --- | --- | --- | --- | --- |
| 1. `adapters-agent-tools-media` | `adapters/agent-tools-media` | AT-01…AT-06 | Audit four declared handler IDs and their source operation/agent permissions; Route real job dispatch and readback through existing Tools/Action Plane owner contracts; enforce budget/idempotency/rights; Installed Agent consumer positive/deny/timeout/restart/UNKNOWN tests; no fifth fabricated handler | 0:NOT_APPLICABLE_SUPPORT; 1:REFERENCED_ONLY; 2:NOT_APPLICABLE; 3:TOOLING_OR_SUPPORT |
| 2. `adapters-data-cloud-media` | `adapters/data-cloud-media` | DC-01…DC-06 | Extend PDP matrix for active optional Data Cloud adapter and specify owner semantics; Implement redacted version-immutable projections through public Data Cloud interface with outbox/dedupe; Prove source Media succeeds when Data Cloud unavailable and does not await metadata finality | 0:APPLICABLE; 1:REFERENCED_ONLY; 2:HEADLESS_CONTRACT; 3:CONSUMER_CONTRACT |
| 3. `adapters-ledger` | `adapters/ledger` | LD-01…LD-05 | Compare ledger with canonical job/version/outbox and retain only unique semantic projection; Bind bounded redacted request/attempt/receipt identities and idempotent replay; Duplicate, lost ACK, wrong tenant, no source payload logging | 0:NOT_APPLICABLE_SUPPORT; 1:REFERENCED_ONLY; 2:NOT_APPLICABLE; 3:TOOLING_OR_SUPPORT |
| 4. `adapters-ocr-compat` | `adapters/ocr-compat` | OC-01…OC-04 | After DI Kernel provider registration, delete Module, OcrService and stale extractText engines/registrations; Remove Media media.ocr dependency request, manifest and generator references; update source topology and phase disposition; Zero source-free caller of old adapter; all DI and Kernel packed consumers green; no second engine | 0:NOT_APPLICABLE_SUPPORT; 1:REFERENCED_ONLY; 2:NOT_APPLICABLE; 3:TOOLING_OR_SUPPORT |
| 5. `apps-media-experience-explorer` | `apps/media-experience-explorer` | F/V/L/X, R8 | Source-current 47 screens/30 journeys with deterministic curated fixtures, no backend; Capture edition-specific narrated/captioned source-bound demos and negative journeys; Headless visual/a11y/CSP and scenario replay; mock evidence never satisfies live outcome | 0:NO_IMPLEMENTATION_ADMITTED; 1:REFERENCED_ONLY; 2:GUI_TOOLING_CONSUMER; 3:TOOLING_OR_SUPPORT |
| 6. `audio-video-observability` | `audio-video-observability` | F/V/L/X, R8 | Retain production runtime provider quality/freshness capacity gauges and truth labels; Add measured alert firing/resolved to authorized operator/receiver and per-source quality invalidation; No green for NaN/unknown data; low-cardinality, privacy-safe, fault and lifecycle tests | 0:APPLICABLE; 1:APPLICABLE; 2:NOT_APPLICABLE; 3:CONSUMER_CONTRACT |
| 7. `integration-tests` | `integration-tests` | IT-01…IT-06 | Reconcile previous Postgres/OCI/Compose tests with current source and public ABI; Exercise rights-version upload→job→transcript/caption→outbox→SDK/GUI and DI real text; Real positive/negative/restart, full R8, failed-before-commit and unknown-after-commit | 0:NOT_APPLICABLE_SUPPORT; 1:REFERENCED_ONLY; 2:NOT_APPLICABLE; 3:TOOLING_OR_SUPPORT |
| 8. `launcher` | `launcher` | F/V/L/X, R8 | CAP-02 startup/security/typed 503 reported PASS on real host; remaining job/rights/provider/one-writer lifecycle and full 30-route/installed-consumer closure. | 0:APPLICABLE; 1:APPLICABLE; 2:HEADLESS_CONTRACT; 3:CONSUMER_CONTRACT |
| 9. `libs-audio-video-client` | `libs/audio-video-client` | SK-01…SK-08 | CAP-01 credential-aware exact read/error/reconcile reported 12/12 + tsc PASS; remaining whole SDK/CLI/public DI consumer and live J03/source-free integration. | 0:APPLICABLE; 1:APPLICABLE; 2:HEADLESS_CONTRACT; 3:CONSUMER_CONTRACT |
| 10. `libs-audio-video-types` | `libs/audio-video-types` | TY-01…TY-06 | Reconcile source-intended domain operations/HTTP30/gRPC44 with current canonical DTO and strict validators; Preserve version/PTS/safe-int and language/rights semantics; typed production/scene/caption contracts; Java/TS/JSON golden + malformed/overflow/unknown-field and source-free ABI | 0:APPLICABLE; 1:APPLICABLE; 2:HEADLESS_CONTRACT; 3:CONSUMER_CONTRACT |
| 11. `libs-audio-video-ui` | `libs/audio-video-ui` | F/V/L/X, R8 | Create admitted production host wiring, not reuse Explorer runtime as host; Bind source screen actions (caption save/EXACT_PAIR compare, jobs, rights, stream, render, version) to real SDK; 47 actual screens and negative/recovery/keyboard/reflow/screen-reader tests | 0:APPLICABLE; 1:APPLICABLE; 2:GUI_LIBRARY; 3:CONSUMER_CONTRACT |
| 12. `libs-common` | `libs/common` | JC-01…JC-04 | Audit transport/gRPC/security peer identity and Shared public ABI; Bound TLS, retries/deadlines, principal propagation and concurrency; eliminate duplicate primitives; mTLS/authorization/denial/backpressure + installed consumer conformance | 0:NOT_APPLICABLE_SUPPORT; 1:REFERENCED_ONLY; 2:NOT_APPLICABLE; 3:TOOLING_OR_SUPPORT |
| 13. `libs-java-common` | `libs/java/common` | MC-01…MC-05 | Retain proven decoder/resampler/FFI; enforce checked samples/clocks/codec buffers; Reuse only bounded native provider SPIs for STT/TTS/Vision/render with lifecycle controls; Resource/overflow/decoder fuzz, deterministic DSP golden and measured throughput | 0:NOT_APPLICABLE_SUPPORT; 1:REFERENCED_ONLY; 2:NOT_APPLICABLE; 3:TOOLING_OR_SUPPORT |
| 14. `libs-media-experience-simulation` | `libs/media-experience-simulation` | F/V/L/X, R8 | Use curated static source PDP3 fixture runner, never claim physics or production; Backfill required next-edition cases, narrator tracks and source-scoped recapture; Per-journey negative/replay golden; independent simulation solver acceptance elsewhere | 0:NOT_APPLICABLE_SUPPORT; 1:REFERENCED_ONLY; 2:NOT_APPLICABLE; 3:TOOLING_OR_SUPPORT |
| 15. `modules-audio-streaming` | `modules/audio-streaming` | AS-01…AS-07 | Implement five missing stream capabilities via typed supported public SPI and existing Media session store; Real ACK/backpressure/lease renew/revocation, WebRTC and adaptive HTTP/HLS/DASH with source timing; Host 1/16/64 concurrent audio streams and real frame/codec/gap/reconnect/cancel proof | 0:NO_IMPLEMENTATION_ADMITTED; 1:REFERENCED_ONLY; 2:HEADLESS_CONTRACT; 3:CONSUMER_CONTRACT |
| 16. `modules-infrastructure-cache` | `modules/infrastructure/cache` | CA-01…CA-05 | Keep cache as non-authoritative projection, bound TTL/keys/size; Always recheck current source/consent/tenant on cache hit, invalidate on revocation; Cache stale/collision/Redis outage and bounded memory/secret logging | 0:NOT_APPLICABLE_SUPPORT; 1:REFERENCED_ONLY; 2:NOT_APPLICABLE; 3:TOOLING_OR_SUPPORT |
| 17. `modules-infrastructure-messaging` | `modules/infrastructure/messaging` | F/V/L/X, R8 | Event Plane public append must accept exact 201 not infer completed from transport; Durable outbox leases/replay/epoch/fencing and optional external absence handling; Real lost ACK/duplicate/timeout and no double completion | 0:NOT_APPLICABLE_SUPPORT; 1:REFERENCED_ONLY; 2:NOT_APPLICABLE; 3:TOOLING_OR_SUPPORT |
| 18. `modules-infrastructure-persistence` | `modules/infrastructure/persistence` | IP-01…IP-07 | Canonicalize JPA/adapter read/write authority to Postgres provider, no split DAL; Tenant/version fencing, bounded executor, transcript/caption CAS and migration contract; Real DB startup, schema history, race/restart/revoke/erasure and no unsafe dual writer | 0:APPLICABLE; 1:APPLICABLE; 2:NOT_APPLICABLE; 3:CONSUMER_CONTRACT |
| 19. `modules-infrastructure-security` | `modules/infrastructure/security` | F/V/L/X, R8 | Reuse Shared auth/rights/current-source verifier and protect all Media entrypoints; Enforce source version, tenant, consent, purpose/biometric before provider, each retry and read; JWT delegated identity/permission boundaries, TTL/revoke across restart, disabled provider fail-closed | 0:APPLICABLE; 1:APPLICABLE; 2:NOT_APPLICABLE; 3:CONSUMER_CONTRACT |
| 20. `modules-integration-tests` | `modules/integration-tests` | CT-01…CT-05 | Prove 30 HTTP/44 gRPC against current manifests and Java/TS client; reconcile two parity findings; Source-free test suite for real multimodal/DI/stream/caption, event/agent and negative cases; No N/A based on name only; exact counts/EXIT; JUnit XML with real effects | 0:NOT_APPLICABLE_SUPPORT; 1:REFERENCED_ONLY; 2:NOT_APPLICABLE; 3:TOOLING_OR_SUPPORT |
| 21. `modules-intelligence-ai-voice-libs-ai-voice-ui-react` | `modules/intelligence/ai-voice/libs/ai-voice-ui-react` | F/V/L/X, R8 | Real host voice selection using qualified provider catalog, user consent and preview; Accessible negative/revoked/unknown states and voice-specific job outcome; No fake human voice output or unqualified clones; interaction/keyboard/a11y tests | 0:APPLICABLE; 1:APPLICABLE; 2:GUI_LIBRARY_HOST_DEPENDENT; 3:HOST_DEPENDENT_EXPERIENCE |
| 22. `modules-intelligence-multimodal-service` | `modules/intelligence/multimodal-service` | F/V/L/X, R8 | Real child STT/Vision receipts/clock source-grounded outcomes still needed; baseline MultimodalGrpcServerCompositionTest fails unchanged main; isolate exact JWT/metrics/port/child assertion and fix without loosening denial; Data Cloud nonblocking. | 0:APPLICABLE; 1:APPLICABLE; 2:HEADLESS_CONTRACT; 3:CONSUMER_CONTRACT |
| 23. `modules-intelligence-speech-libs-speech-audio-rust` | `modules/intelligence/speech/libs/speech-audio-rust` | RS-01…RS-07 | Preserve Blackman windowed-sinc and rational offsets; no regression reimplementation; Qualify public FFI and exact decoder/clocks for 1/16/64 real streaming; Rust focused tests, no-panic/overflow, real platform measurements | 0:APPLICABLE; 1:APPLICABLE; 2:NOT_APPLICABLE; 3:CONSUMER_CONTRACT |
| 24. `modules-speech-stt-service` | `modules/speech/stt-service` | F/V/L/X, R8 | Real lawful model/audio pinned WER/CER en/hi/ne; source version and voice consent; Streaming frame/word/phoneme timing/diarization, durable version/outbox and crash reconciliation; Original R8 STT whole-row oracles and true source-audio corpus | 0:APPLICABLE; 1:APPLICABLE; 2:HEADLESS_CONTRACT; 3:CONSUMER_CONTRACT |
| 25. `modules-speech-tts-service` | `modules/speech/tts-service` | F/V/L/X, R8 | Real qualified/permissioned TTS/stream/voice/SSML effects still needed; baseline TtsGrpcServerReadinessTest + TtsWave2InventoryTest fail on unchanged main; one confirmed stale constructor text oracle. Fix both, then R8 whole-row gold. | 0:APPLICABLE; 1:APPLICABLE; 2:HEADLESS_CONTRACT; 3:CONSUMER_CONTRACT |
| 26. `modules-video-streaming` | `modules/video-streaming` | VS-01…VS-07 | Real PTS/VFR/ROI codec and session lease/ACK/reconnect to MediaRuntime; Typed actual WebRTC/HLS/DASH/adaptive capabilities, revocation/cancel; 1/16/64 host measured source-clock/dupe/restart and negative cases | 0:NO_IMPLEMENTATION_ADMITTED; 1:REFERENCED_ONLY; 2:HEADLESS_CONTRACT; 3:CONSUMER_CONTRACT |
| 27. `modules-vision-vision-service` | `modules/vision/vision-service` | F/V/L/X, R8 | VIS09 gRPC and DI-only client source present; **no production binding**. Add explicit OCR_ONLY independent YOLO profile, trusted original frame/ROI crop and PTS evidence, capped response allocation, owner-pinned DI endpoint; real worker and source-free positive required. | 0:APPLICABLE; 1:APPLICABLE; 2:HEADLESS_CONTRACT; 3:CONSUMER_CONTRACT |
| 28. `providers-aws-postgresql` | `providers/aws-postgresql` | F/V/L/X, R8 | CAP-03 V029/transcriptVersionRef and real Postgres migration lineage reported 111+ PASS; remaining production applied-history/old-writer cutover, full domain retention/erasure, other original R8/W3. | 0:APPLICABLE; 1:APPLICABLE; 2:NOT_APPLICABLE; 3:HOST_DEPENDENT_EXPERIENCE |
| 29. `runtime-contracts` | `runtime-contracts` | F/V/L/X, R8 | CAP-02/03 MediaDeploymentProfiles and exact transcript version contract reported PASS; remaining full 30 HTTP/44 RPC/channel cross-language ABI and current source owner admission. | 0:APPLICABLE; 1:APPLICABLE; 2:HEADLESS_CONTRACT; 3:CONSUMER_CONTRACT |

### Physical surface processing protocol

For each physical leaf: (1) read current manifest and applicable PDP references; (2) obtain selected method node, owner and source fingerprint; (3) list original accepted/open tasks and code artifacts; (4) classify needed source work (including real positive cases), internal dependency and external entitlement; (5) implement only its own source paths; (6) run focused compile/unit/security/race/real integration and installed-client tests; (7) obtain authenticated Work Planner transition for this leaf's stage when allowed; (8) native gtool proof/receipt after actual AP02/03/case admission; (9) release artifact and operation only when deployable/authorized; (10) record Enhance actual metrics after operating. One leaf's BLOCKED receipt is not an entire repo implementation freeze.

**Special retirement:** `adapters-ocr-compat` is an approved `RETIRING` topology row and should **not** be added as a permanent third 57th matrix row. Its source removal and exact consumer proof are the required final outcome. A retired module receives an owner-backed retirement applicability/obsolete reference, not a fake successful runtime.

## 6. All logical consumer surfaces — exact real terminal tests

These are **source-defined consumer contracts**, not one deployable service each. Bind actual code/test owner and build artifact; logical consumer status may be complete independently of an unrelated product, but its real positive depends on its declared backing package.

| Logical surface | Current binding | Physical owner(s) | Remaining consumer acceptance |
| --- | --- | --- | --- |
| 1. `web` | HOST_DEPENDENT | `libs-audio-video-ui` | Real authenticated production host, 47 screens, source screen actions and finality |
| 2. `embedded` | HOST_DEPENDENT | `libs-audio-video-ui` | Sandboxed origin/auth/player and exact simulated-vs-real label and a11y |
| 3. `public-http` | HOST_DEPENDENT | `launcher`, `runtime-contracts` | 30 HTTP operations, JWT permission mapping, error/result parity, real positive |
| 4. `service-grpc` | CONTRACT_ONLY | `runtime-contracts`, `modules-speech-stt-service`, `modules-speech-tts-service`, `modules-vision-vision-service`, `modules-intelligence-multimodal-service` | 44 RPCs, mTLS/JWT identity, quota/cancel/timeout, generated source-free client |
| 5. `grpc.stt` | CONTRACT_ONLY | `modules-speech-stt-service` | True STT voice/audio stream, finality, gold, negative cases |
| 6. `grpc.tts` | CONTRACT_ONLY | `modules-speech-tts-service` | True TTS audio stream and licensed voice rights, negative cases |
| 7. `grpc.vision` | CONTRACT_ONLY | `modules-vision-vision-service` | Real Vision geometry and DI-only OCR VIS09, real DI binding |
| 8. `grpc.multimodal` | CONTRACT_ONLY | `modules-intelligence-multimodal-service` | True STT/Vision child receipts and fused source result |
| 9. `sdk` | PHYSICAL | `libs-audio-video-client`, `libs-audio-video-types` | Installed TS public client, authenticated caption and DI transport, no empty-on-error |
| 10. `cli` | HOST_DEPENDENT | `libs-audio-video-client`, `libs-media-experience-simulation` | Source-bound real artifact/job/recorder operations with deterministic JSON and error semantics |
| 11. `agent-tools` | CONTRACT_ONLY | `runtime-contracts`, `adapters-agent-tools-media` | Four exact handlers with Tools/Action Plane policy and no fake admission |
| 12. `events` | CONTRACT_ONLY | `modules-infrastructure-messaging`, `runtime-contracts` | Event Plane outbox, 201 append, durable consumer true finality |
| 13. `integrations` | HOST_DEPENDENT | `adapters-data-cloud-media`, `adapters-ledger`, `modules-infrastructure-cache`, `modules-infrastructure-messaging`, `modules-infrastructure-persistence`, `modules-infrastructure-security`, `providers-aws-postgresql` | DI/Kernel/DataCloud/AEP/Agents/Shared source-free public boundary and outage isolation |
| 14. `types-library` | PHYSICAL | `libs-audio-video-types` | Strict published validators and Java/TS/JSON contract parity |
| 15. `ui-library` | HOST_DEPENDENT | `libs-audio-video-ui`, `modules-intelligence-ai-voice-libs-ai-voice-ui-react` | Packaged accessible Studio/caption/player/voice components in real host |
| 16. `explorer` | PHYSICAL | `apps-media-experience-explorer`, `libs-media-experience-simulation` | PDP3 curated static data, narration/caption demo and negative/a11y cases |
| 17. `desktop-archive` | ARCHIVED | Archived; no owner package | Keep NOT_ACTIVE_ARCHIVED and historical receipt; no fabricated deployable |
| 18. `recorder-orchestrator` | HOST_DEPENDENT | `libs-audio-video-client`, `libs-media-experience-simulation` | Automated source-driven deterministic capture, selective recapture, narration and provenance |
| 19. `capture-adapters` | CONTRACT_ONLY | `runtime-contracts` | Qualified desktop/mobile/browser/terminal/API/gRPC/camera/media capture with rights and clocks |
| 20. `production-studio` | HOST_DEPENDENT | `libs-audio-video-ui` | Professional GUI timeline/caption/animation/edit/render/undo and real backend effects |
| 21. `interactive-demo-player` | HOST_DEPENDENT | `libs-audio-video-ui` | Sandboxed branching player, captions, a11y, evidence-mode/real truth labels |

**Current published method/channel denominator:** 30 HTTP routes and 44 gRPC RPCs after the new caption/VIS-09 work, not the old 27/43. Refresh OpenAPI, proto, route manifests, PDP-2/PDP-3 operation mappings, SDK/CLI/Agent/GUI and source-free compiled consumers under the existing generators. No automatic 31st route, 45th RPC or fifth Agent Tool without source-defined semantics. The 47 screen catalog and 30 journey catalog remain separate, not "44 UI screens".

## 7. Direct composition and root obligations

| Composition surface | Kind | Children | Required direct acceptance |
| --- | --- | --- | --- |
| 1. `repository-root` | REPOSITORY_ROOT | 16 | Reference current children plus root-only completeness; no copied proof |
| 2. `ingestion-and-versioned-artifacts` | SEMANTIC_COMPOSITION | 8 | Direct obligations: media.composition.ingestion-and-versioned-artifacts.direct-integration |
| 3. `governed-job-execution` | SEMANTIC_COMPOSITION | 6 | Direct obligations: media.composition.governed-job-execution.direct-integration |
| 4. `speech-and-caption-workflows` | SEMANTIC_COMPOSITION | 4 | Direct obligations: media.composition.speech-and-caption-workflows.direct-integration |
| 5. `vision-and-multimodal-analysis` | SEMANTIC_COMPOSITION | 4 | Direct obligations: media.composition.vision-and-multimodal-analysis.direct-integration |
| 6. `creation-composition-and-delivery` | SEMANTIC_COMPOSITION | 7 | Direct obligations: media.composition.creation-composition-and-delivery.direct-integration |
| 7. `client-and-machine-interfaces` | SEMANTIC_COMPOSITION | 9 | Direct obligations: media.composition.client-and-machine-interfaces.direct-integration |

Compositions must enforce their **direct cross-child invariant** and owner-authorized source/receipt joins. Do not replay child suites for every parent or bulk mark 8,664 candidate obligations closed. Authenticate child receipts and independently test the one direct integration result. The repository root cannot be marked CURRENT while an applicable mandatory child has no authoritative disposition; support/archived N/A is permitted with source-approved rationale only.

## 8. All 30 vertical business outcomes (V01–V30) with real product parity

Follow source `.product-experience/pdp-3-product-experience/journey-contracts/` and current `MEDIA-BUILD-IMPLEMENTATION-PLAN.md` for precise input/actor/terminal. Required feature implementation includes positive and negative/recovery, independent evidence, exact version/rights, source-grounded output, channel parity and UI states; no simulated fixture counts as a real effect.

| Existing package | Business outcome | Stage and evidence obligation |
| --- | --- | --- |
| `M-BLD-V01` / J-01 | First use, authentication, context, and project creation | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V02` / J-02 | Upload/import, inspect, and produce a usable artifact | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V03` / J-03 | Audio/video transcription through corrected captions | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V04` / J-04 | Authorized text-to-speech to approved audio | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V05` / J-05 | Image/video analysis, geometry, and tracks | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V06` / J-06 | Multimodal or document consumer request to grounded typed result | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V07` / J-07 | Noisy/clipped interview cleanup with preservation and comparison | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V08` / J-08 | Low-quality video repair with measured comparison | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V09` / J-09 | Prompt/brief to storyboard, composition, render, review, and delivery | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V10` / J-10 | Controlled generation with references and continuity review | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V11` / J-11 | Region mask/tracking edit with comparison and undo | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V12` / J-12 | Deterministic 2D/vector/procedural animation | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V13` / J-13 | 3D character, rig, path, or control animation | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V14` / J-14 | Explore a domain simulation and its measurements | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V15` / J-15 | Simulation/procedural passes with protected semantic validation | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V16` / J-16 | Existing-video translation/dubbing and voice/timing review | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V17` / J-17 | Music, effects, Foley, stems, mix, and mastering | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V18` / J-18 | Compose clips, captions, exact graphics, color, and audio master | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V19` / J-19 | Review media quality and improve it within declared limits | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V20` / J-20 | Observe a long-running job and check its outcome | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V21` / J-21 | Review/comment/approve exact version and re-review changed material | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V22` / J-22 | Export/download/publish with destination acknowledgement | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V23` / J-23 | Private/local workflow while disconnected and reconnect | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V24` / J-24 | CLI batch/JSON plan through verified outputs | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V25` / J-25 | Agent or product integration with bounded delegated Media action | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V26` / J-26 | Delete/revoke/retention/hold and visible lifecycle | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V27` / J-27 | Continue safely when processing is unavailable | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V28` / J-28 | Spatial/360/interactive/synthetic-data export to declared consumer | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V29` / J-29 | Live session loss, consent change, and bounded recovery | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |
| `M-BLD-V30` / J-30 | Check which processing options are eligible | Actual source-pinned command/effect and negative/recovery, 47-screen subset and public consumer; match PDP-3 source demo and live film where applicable |

**Early acceptance chain:** V01 first-use/project → V02 upload/import → V20 job observation/UNKNOWN recovery → V03 genuine STT transcript/caption correction/immutable registration and exact version pair readback. The first real product capture happens after this true end-to-end terminal, with independent rights to assets and narration. The PDP-3 Explorer recording is a separate narrated/captioned, centrally-fixtured demonstration labeled `EXPLORER_SIMULATED`. Build product film is labeled `LIVE_PRODUCT_VERIFIED` only after authentic effects and exact semantic comparison. Current v1 PDP-3 edition selects J03; never retroactively require all 30 recordings without a formally versioned new edition and source-impact admission. Future full 30-journey demos are an approved next-edition target rather than a false v1 failure.

**Recorder, animation, simulation, Studio, Player:** the F13 shared declarative source compiler is not the runtime solver or professional editor. L01 must provide qualified recorder/capture adapters, selective recapture and real narration synchronization; L02 real editable timeline/FX/captions/revisions/export; L03 sandboxed branchable interactive playback with truth-mode labels. V12/13 require actual 2D/3D animated frame outputs and deterministic specs; V14/15 require executable physical/domain simulation and independently validated numerical/scientific correctness, not Explorer static fixtures. L02/L03 real product outputs must work in a separately admitted production GUI/embedded host.

## 9. Every lifecycle stage and phase — structured gtool execution

Canonical method: Lifecycle `tools/documentation-model/presets/methods/ghatana-product-development.v3.yaml`. Before adoption validate Media owner mappings and installed host ABI, preserve historical Media v1 source-only reader for consistency. Exact nodes:

| Stage | Phases/nodes | Owner result required before advancing *this selected surface* |
| --- | --- | --- |
| Discovery | `pdp-0-product-truth`, `pdp-1-canonical-domain-data`, `pdp-2-design-language-interface-system`, `pdp-3-complete-product-experience` | Current source/owner direct criteria, phase tasks zero/explicit N/A, affected static narrated recording proof, real source selector and change-impact checks. PDP0 source recorded IN_PROGRESS must be resolved truthfully. |
| Build | `build-plan-implementation`, `build-implement`, `build-verify`, `build-development-complete` | Original F/V/L/X task binding, KCRIT plan admission, real code positive/negative/recovery, installed public consumers, originality/quality/rights evidence where required, independent Build acceptance. |
| Deliver | `deliver-release`, `deliver-deliver`, `deliver-operate` | Qualified signed artifact, SBOM/licenses/host/ports, fenced DB migration, versioned contract consumer, actual deployment and rollback, owned observability/SLO/pager, realistic incident/retention evidence. Support-only library may inherit published artifact/consumer proof when method explicitly allows; no invented deployment. |
| Enhance | `enhance-measure-outcomes`, `enhance-learn`, `enhance-evolve` | Actual monitored business/quality/cost/privacy-safe results, alternative evaluation and versioned scoped changes; no made-up operations or full re-opening of closed unaffected phases. |

**Do not conflate method node evaluation with native acceptance.** Native PDP-0..3 use the four existing `config/closure/media-product-definition/phase-program.json` phase IDs: `media.product-truth.definition-acceptance`, `media.canonical-domain-data.definition-acceptance`, `media.design-interface-system.definition-acceptance`, and `media.complete-product-experience.definition-acceptance`. They require AP02/AP03 true authority, executable source→case→observer/oracle mapping, Evidence Generator results and authenticated native receipts, **one selected leaf/phase at a time**. Compositions/root add direct meaning.

### gtool command playbook (executed only against installed owner host)

```bash
export MEDIA_ROOT=/absolute/path/to/ghatana-media
export LIFECYCLE_ROOT=/absolute/path/to/ghatana-lifecycle
cd "$LIFECYCLE_ROOT"
node tools/gtool/bin/gtool.mjs method inspect --definition tools/documentation-model/presets/methods/ghatana-product-development.v3.yaml --json
node tools/gtool/bin/gtool.mjs method progress --root "$MEDIA_ROOT" --json
node tools/gtool/bin/gtool.mjs provider health --capability proof-producer --json
node tools/gtool/bin/gtool.mjs closure validate --json
node tools/gtool/bin/gtool.mjs closure config check --root "$MEDIA_ROOT" --no-write --json

# Source-only plan is advisory, explicit source-status config must contain actual exact pins.
node tools/gtool/bin/gtool.mjs method plan --subject '<ACTUAL_SURFACE_ID>' \
  --proof-mode SOURCE_STATUS --source-status-config '<ACTUAL_SOURCE_CONFIG>' --json

# Authenticated host registration required: absence returns BLOCKED, never synthesize.
node tools/gtool/bin/gtool.mjs method tasks --proof-mode AUTHENTICATED_OWNER_READBACK \
  --roster '<OWNER_PINNED_ROSTER>' --node '<ACTUAL_METHOD_NODE_ID>' --json
node tools/gtool/bin/gtool.mjs method verify --subject '<ACTUAL_SURFACE_ID>' --node '<ACTUAL_METHOD_NODE_ID>' --json

# After admitted AP02/AP03 + independent case/oracle proof and native closure graph:
node tools/gtool/bin/gtool.mjs closure phase-projection \
  --repository-id '<ACTUAL_REPOSITORY_ID>' --program-id '<ACTUAL_PROGRAM_ID>' \
  --surface '<ACTUAL_CLOSURE_SURFACE_ID>' --phase media.product-truth.definition-acceptance \
  --selection-mode EXACT_UNIT --json
node tools/gtool/bin/gtool.mjs closure run-plan prepare --unit-id '<ACTUAL_RETURNED_UNIT_ID>' --json
node tools/gtool/bin/gtool.mjs closure run --run-plan '<IMMUTABLE_RETURNED_PLAN_REF>' --execute --json
```

Only if the **actual native workflow** returns a result requiring adoption, call `closure adopt-native-receipt --surface ... --phase ... --native-run-result ... --json`, and verify canonical readback; no duplicate adoption or fictional receipt. Use `method evidence` request with exact installed schema, journal and owner action ID, `method run` for implementer dispatch, and authenticated `method execute`/owner-supported `development transition --complete` for actual phase/stage changes. Do not assume a stock read-only CLI has write authority. Every action carries stable original owner task ID, selected source epoch/fingerprint, method revision, node, expected owner revision, idempotency key, input and result digests, typed reason codes, resource limits, evidence/readback refs and exact permitted effects; validate against existing versioned schema rather than inventing a new CLI flag.

## 10. Track B exact repair steps and non-mutating diagnostics

1. Read `git rev-parse HEAD` (current *working checkout*, not a document-pinned SHA) and `git status --porcelain`; source manifest/topology, all 4 `pdp-*-phase-dev-status.json`, all 4 `pdp*-surface-phase-status-matrix.json`, bridge/work-package projection and DI/Kernel ownership records. Build exact changed selector set and identify the reported 67 stale pins from current bytes. Preserve affected source ref and expected/observed SHA-256, source author and impact class.
2. Run existing source validations first, **not** a blind pin replacement. `pnpm run check:surface-roster`, `pnpm run test:surface-roster`, `pnpm run check:contract-parity`, `pnpm run check:build-contract-bridge`, `pnpm run check:build-work-packages`, `pnpm run check:build-plan-task-closure`, `pnpm run check:lifecycle-closure-inputs` and phase-specific generator/check outputs. Preserve exact two parity diagnostics; raw count is not task identity.
3. Author **two impacted rows** to four matrix generators: agent-tools support-only N/A/referenced dispositions according to source; Data Cloud active applicable optional integration and direct per-phase source tests. Do not mark the 54 existing rows stale unless their material meaning changed; preserve all existing historical sealed receipts. OCR compatibility stays `RETIRE_UNDER_OCR_M03` until verified DI Kernel switch; then delete its manifest candidate/topology membership and run affected negative denominator tests.
4. Source-authored revision semantics: if semantic contract/source meaning changed (caption P1/P2/P3 new ops, VIS09 new RPC, MDI1, Data Cloud), run owner current-cut review, update only those impacted source statuses/source selectors through existing preparation helpers and regenerate derived projections. If change is generated-only/reformat, prove semantic fingerprint equivalence; adjust only legitimate currentness selectors and original observation, never force `DEV_COMPLETE`. Negative fixtures: altered required edge, stale candidate, duplicate member, incorrect N/A, missing owner, invalid phase dependency, and 2 parity failures.
5. Re-evaluate P0 specifically: determine why top-level source `IN_PROGRESS` despite zero `outstandingMeaningIds` and passing reported P0 direct testStatus (29 skipped in P0-03). Classify skipped cases by actual applicability/independent evidence; do not claim complete unless mandatory source criteria, reviewer status and latest source bytes pass. Re-evaluate P1/P2/P3 currentness only on impact graph. Work Planner readback then confirms selected subject definitions, not just a 54-row matrix.
6. Rebuild consumer PhaseProgram and AP03 tracked-source snapshot after source freeze. **Do not edit generated files manually**, change native receipt status from data projection, or cause expensive unrelated leaf runs.

**Exit:** current roster and exact semantics reconciled with source guards; no unexplained stale selector/parity finding or ghost matrix row; candid PDP0 state; reproducible generator `--check`; independent gtool source/owner current readback when available. It is legitimate for native closure to remain BLOCKED after source repairs until authentic protected host authority arrives.

## 11. Cross-repo blockers with executable owner outcomes

| Repository and issue | Required owner action and exact evidence |
| --- | --- |
| Ghatana #252 — DI | Stable installed `@ghatana/document-intelligence-client` and Shared extraction peer; DI-owned Kernel Java adapter + lawful real worker/model and source-free Media PNG and PDF consumer. Packed package, real network/cancel/rights tests. |
| Kernel provider owner | Map existing `media.ocr` public SPI to DI provider instance without Kernel importing Media implementation; Materializer declared support, health, terminal/cancel/status and installed consumer proof. |
| Ghatana #254 — Data/Action/Event | Owner-issued public API contracts, Event Plane 201 append separate from consumption, optional Data Cloud, real Action Plane effect receipt, 32 AEP case accounting, fail-closed partitions. |
| Lifecycle #24 AP02 | Actual contract distribution DAG+signed owner selection, verifier/registration/currentness/revocation and negative source-free consumer proof. |
| Lifecycle #25 AP03 | Actual tracked-source snapshot membership/archive bytes and authenticated Planner verifier, race/path/symlink/revocation negatives and host-admitted readback. |
| Media #19/#20 | Exact source roster→admitted ClosureUnit/case/oracle plan, first genuine bounded PDP0 physical leaf native proof and receipt, then eligible leaves/compositions/root, PDP1–3. |
| Media #22 | Canonical 50/57 Build plan, 19 prior owner dispositions resolved by actual Work Planner KCRIT task+plan readiness; no status promotion from planning.
| Media #6 and source Track B | Capture current parity diagnostics, retire actual semantic conflicts, impacted PDP0/1/2/3 generator additions and source-currentness/reviewer work. |
| Rights/data/operator owners | Real licensed models/voices/biometric/source assets, third-party and independent reviewers, qualified hardware, protected trust/private credentials. No engineering shortcut; owner input is an exact external prerequisite, not discretionary unapproved code work. |

## 11A. All currently open Media issues — owner disposition and canonical next proof

The table is a **current issue coordination view**, not a new task registry. Historical dated issue bodies and older denominators are not automatically current source facts. Keep a necessary issue OPEN until original owner effects/independent review are verified; close/retire only after source-current acceptance.

| Open issue | Owner disposition, exact next work |
| --- | --- |
| `media#3` | **HISTORICAL_COUNTS_RECHECK_PDP0_CURRENTNESS_AND_NATIVE_PROOF** — Do not recreate old 383-leaf/27-route/43-RPC counts; source PDP0 IN_PROGRESS, PDP1/2/3 recorded prior DEV_COMPLETE; current source impact and independent proof #4/#20. |
| `media#4` | **INDEPENDENT_REVIEW_REQUIRED** — Actual qualified product/domain, accessibility, visual, simulation and rights reviewer outcomes with specific source/host/assistive-tech evidence; owner engineering approval not a reviewer signature. |
| `media#5` | **FIRST_SLICE_REQUALIFY_CURRENT_IMPLEMENTATION** — Artifact/upload/job source/route/rights/attempt/UNKNOWN and installed client oracles; preserve completed parts, not blanket task COMPLETE. |
| `media#6` | **REPORTED_TWO_PARITY_FINDINGS_TO_IDENTIFY** — Current pnpm contract parity output/IDs; fix exact operation semantics, no retired historical 3/51 phantom blocker. |
| `media#7` | **REAL_L02_L03_CASE_ORACLES_NOT_ADMITTED** — Bind current native obligation roster/case/observer/independent receipt; historical 344 counts not current authority. |
| `media#8` | **HISTORICAL_PDP_GAPS_SCOPE_IMPACT_RECHECK** — Do not treat 383 leaves or 260 old migration items as new current tasks; source-current P0 status and actual 30 journeys/130 steps + 30 HTTP/44 gRPC. |
| `media#19` | **57_DECLARED_VS_54_MATRIX_SOURCE_DELTA** — 2 rows add through generators, one OCR retire after DI replacement; exact native ClosureUnit owner graph not 57 units. |
| `media#20` | **NATIVE_FIRST_LEAF_RECEIPT_PENDING** — After true AP02/AP03, independent case+oracle+Evidence Generator and native gtool receipt; not code-only source links. |
| `media#21` | **LAST_GENERATED_SOURCE_JOINS_ZERO_OWNER_PLAN_REVIEW_PENDING** — No redo historic 17 P1 joins; current regen + original F00.T02 work plan owner acceptance. |
| `media#22` | **KCRIT_PER_SURFACE_PENDING** — Approved code work; exact original 50-package/57-task Work Planner source-current KCRIT, not fake Plan Ready. |
| `media#23` | **VIS09_CODE_OPEN** — Source crop/rights, DI only, YOLO-independent explicit OCR_ONLY profile and bounded HTTP, real worker. |
| `media#24` | **BASELINE_DEFECTS_OPEN_NOT_CAP_REGRESSION** — 3 original TTS/MM classes with exact Gradle XML, no ignored tests; one stale textual constructor oracle confirmed. |
| `ghatana#252` | **DI_PUBLIC_CLIENT_AND_KERNEL_OWNED_PROVIDER_PENDING** — Shared peer, DI worker/qualified model, DI-owned Kernel OcrProvider and source-free PNG/PDF consumers. |
| `kernel#99` | **DI_OWNED_KERNEL_OCR_PROVIDER_AND_SOURCE_FREE_ABI_PENDING** — Kernel's historical `media.ocr` ID must resolve actual DI-owned `OcrProvider` with real cancellation/status/rights and installed Java consumer proof, not Media compatibility |
| `shared#246` | **PUBLIC_EXTRACTION_PACKAGE_RELEASE_PROFILE_PENDING** — Replace incompatible/unproven `0.1.0-SNAPSHOT` peer with owner-selected stable public package and installed DI/Media consumer or explicit truthful dev-only profile |
| `ghatana#254` | **DATA_ACTION_EVENT_PUBLIC_OWNER_ACCEPTANCE_PENDING** — Optional Data Cloud, EventPlane 201 append vs finality, ActionPlane remote receipt and 32 AEP case provenance. |
| `lifecycle#24` | **MEDIA_AP02_GENUINE_HOST_REQUIRED** — Actual contract distribution owner, verifier and revocation; no local signature substitute. |
| `lifecycle#25` | **MEDIA_AP03_GENUINE_SNAPSHOT_REQUIRED** — Exact post-TrackB membership/source epoch, trusted Planner verifier, no historical manifest. |
| `lifecycle#29` | **LIFECYCLE_OWN_REPOSITORY_AP02_AP03_DISTINCT_FROM_MEDIA** — Lifecycle own source/governance host stage-nine authority, not a Media fixture; native proofs separately admitted. |

**Decision:** the recently completed CAP engineering is no longer an open corrective lane; preserve existing source/test evidence and return to it only for a proven source-impact regression. Media [#23](https://github.com/samujjwal/ghatana-media/issues/23) and [#24](https://github.com/samujjwal/ghatana-media/issues/24) are executable ownership issues linked to the original VIS/TTS/MM requirements—not new PDP/F/V/L/X task identities. Lifecycle's separate own-repo R12 AP-02/AP-03 issue [#29](https://github.com/samujjwal/ghatana-lifecycle/issues/29) does not replace Media protected-source issues #24/#25 in Lifecycle.

## 12. Dependency order and parallel assignments — no global execution pause

**Batch 0 / immediate P0, independent owners:**
- Media Source/Track B: 67 pin currentness review, exact P0 status/29 skipped, two matrix extensions, two parity diagnostics, route 30/RPC44 source links.
- CAP completed: reuse a5be0f60/07b3df19 and host-reported passing provider/launcher/client tests, **do not re-implement**; integrate the real accepted caption terminal into J01/J02/J20/J03.
- Media Vision: VIS09 trusted frame/crop+PTS and per-RPC OCR_ONLY/YOLO explicit admission, DI bounded transport/service composition; source-free tests and actual DI worker later.
- Ghatana DI: installed Shared peer/DI v1 real worker contract + DI-owned Kernel OcrProvider.
- Lifecycle trusted operator: AP02 and AP03 real host provisioning concurrently; Media closure owner maps selected leaf cases.
- Media runtime database owner: reuse passing V029 host migration fixture; rehearse *actual deployed* old/new applied history/one-writer fencing (no production cutover).

**Batch 1 / baseline defects and prereq-complete leaf development:** first fix TtsWave2InventoryTest obsolete source literal and both TTS readiness/Multimodal composition actual JUnit defects on clean main (no skips). Independently proceed with F00–F13 applicable current tasks and V01/V02/V20/V03 first genuine corrected-captions end-to-end; DI real Media frame + document consumer; OCR-K01 provider materialization; record first paired source/demo and true real product film when outcome actually exists. Current 30 HTTP/44 RPC and client abi stable for affected routes. Do not gate ready non-OCR work on DI external model rights.

**Batch 2 / independent full verticals:** V04–V30 by modality and shared code owner; audio/video streams transport; model and voice qualification; animation/render/simulation actual solver/quality; GUI 47 screens, Recorder L01, Studio L02, Player L03, agents and products. Assign original 36 R8 plus 96 W3/H tasks to their true owner surfaces; no double count, no blanket reruns.

**Batch 3 / integration and acceptance:** X01 full channel/public ABI matrix, X02 whole-product privacy/correctness/fault/performance/a11y, 32 AEP real cases, source-free installed product consumers, J03 effect/recording parity, current live model/host rights, 1/16/64 concurrency and staged provider-quality alerts. Q00–Q16 owner qualification outcomes and every original whole-row acceptance; X03 Work Planner Build Development Complete per eligible surface.

**Batch 4 / independent native closure and Deliver:** execute admitted PDP0→PDP3 phase proof per eligible physical leaf, then direct composite/root; reuse current receipts, no forced 8,664 executions. Deliver Release/Deliver/Operate only for actual deployable artifacts and qualified operator/grants; support-only surface inherits ABI/release consumer when selected method permits.

**Batch 5 / Enhance:** actual operational quality, business value, carbon/compute/cost/latency, model drift, failure/retry, accessibility and privacy-safe user outcome measurements. Compare alternatives and enter scoped approved next iteration. Do not claim future real operational measurements as satisfied today.

**Resource rule:** cheap gtool per-unit evaluation, file-hash reuse, selected dependency graph, no repeated current closed tests, 1–4 parallel heavy host suites only if declared quotas, private local model/corpus subset instead of huge downloads, tmpdir cleanup and content-addressed bounded receipts. Verify source SHA/model/host fingerprint before reusing real qualifications. User's no-CI-gate preference remains; local owner-run verified tests are acceptance input, not bypass of independent protected proof.

## 13. Run these existing read-only/focused commands first

```bash
cd /absolute/path/to/ghatana-media
git rev-parse HEAD
git status --porcelain
pnpm run check:surface-roster
pnpm run test:surface-roster
pnpm run check:ocr-consumer-inventory
pnpm run test:ocr-single-authority
pnpm run check:contract-parity
pnpm run check:build-contract-bridge
pnpm run check:build-bridge-blockers
pnpm run check:build-work-packages
pnpm run check:build-plan-task-closure
pnpm run check:lifecycle-closure-inputs
pnpm run test:build-contract-bridge
pnpm run test:build-plan-task-closure
pnpm run test:backend-remaining-surfaces-plan
pnpm run test:backend-terminal-qualification
pnpm run test:pdp3-recording-source
pnpm run test:gtool-closure-source
```

Then run **targeted original** Java Gradle/JUnit (caption registration, source clock, PostgreSQL Testcontainers, HTTP JWT, real DI Vision RPC), TS/Vitest caption SDK, independent DI Python strict worker tests, Kernel public provider tests, and only changed-scope Rust/OCI/model/host cases. Use scoped Gradle project selectors from the actual checkout (standalone Media retains `services:media` prefix); don't invent top-level all-repo test plans that cannot run under bounded host setup. All test/report outputs must state original required positive/negative/restart, exact duration/resource and external provider edition; a passing isolated test is not a whole-row R8 receipt.


### Baseline test commands (existing Gradle project selectors, actual checkout required)

```bash
./gradlew -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE \
  -Pghatana.media.compositeScope=FOCUSED -Pghatana.media.focusedModules=tts \
  :services:media:modules:speech:tts-service:test \
  --tests '*TtsWave2InventoryTest' --tests '*TtsGrpcServerReadinessTest' \
  --no-daemon --no-parallel --max-workers=2 --console=plain

./gradlew -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE \
  -Pghatana.media.compositeScope=FOCUSED -Pghatana.media.focusedModules=multimodal \
  :services:media:modules:intelligence:multimodal-service:test \
  --tests '*MultimodalGrpcServerCompositionTest' \
  --no-daemon --no-parallel --max-workers=2 --console=plain
```

Collect the actual `build/test-results/test/*.xml` failing testcase and stack for each. Report exact baseline SHA/diff/OS/profile, method name and first assertion; run a single test method, then full class, then full changed module. Do not infer remaining root causes from test class names or mark as external owner. These commands are planned, **not executed by this review**.

## 14. Terminal completion proof — exact zero-remainer condition

Only declare the selected unit `DEV_COMPLETE` when canonical owner direct criteria and source/current task inventory pass, real mandatory feature behaviors (positive, denial, UNKNOWN/recovery) are proved, public ABI is installed/tested, required rights/model/provider readiness are genuine, and a current Work Planner owner transition readback confirms it. Do not tie it to unrelated native/root closure.

Whole Media Build completion additionally requires: **50 packages completely accounted for; 36 R8 formerly unaccepted whole rows accepted; all 96 W3/H rows reconciled/accepted to original criteria; 47 real screens; 30 real journey terminals; 30 HTTP and 44 gRPC correct active operations; four Agent Tools, SDK, CLI, events and product integrations; deterministic simulation and real animation/render; recorder/studio/player; a DI-only global OCR execution path with Kernel migrated and obsolete Media adapter deleted; one writer and safe DB schema; no orphan source task, negative case or admission.**

Native PDP closure needs **genuine** protected owner graph/proof and receipts for applicable admitted units/phase; full Delivery needs actual rights/license, signed release and operational readback; Enhance only after actual measured operation. Missing external rights/trust/independent review can remain explicit BLOCKED while other engineering advances, but never qualify as universal "no tasks remaining." The final status board must be generated from exact original source and owner receipts, with none of `UNKNOWN`, `BLOCKED`, or stale silently interpreted as `N/A`, `DEV_COMPLETE`, `CLOSED` or `RELEASED`.

**Next implementer instruction:** preserve verified CAP-01/02/03 unchanged; start Batch 0 now on disjoint source ownership: Media VIS09 trusted DI-only production composition and independent provider profiles + Ghatana DI-owned Kernel provider/Shared peer + Track B source roster/generator/pin repairs + three pre-existing TTS/MM test failures + genuine Lifecycle AP02/AP03 owner provisioning. Complete real code, focused tests, source currentness and original owner task readbacks before assigning successor work. Do not request another routine owner approval and do not reimplement already proven features. Preserve actual blocked permissions/rights as exact typed prerequisites, not false success or generic "needs owner decision".
