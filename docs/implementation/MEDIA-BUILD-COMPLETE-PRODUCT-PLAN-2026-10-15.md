# Ghatana Media — complete-product Build Plan Implementation candidate

> **October 15 R2 source-review update:** the nine-file J-27/J-16 hardening commit `7ef839fd9bb871782b112e370bb9f6c3c3a60556` is now on main. This plan remains **PREPARED ONLY**; PDP-3 successor/R7 and 200-cell Discovery PASS have not been proved. R2 internal decisions and the remaining PDP-3 plan are [here](MEDIA-DISCOVERY-TO-BUILD-OWNER-REVIEW-2026-10-15.md) and [here](MEDIA-DISCOVERY-PDP3-FINISH-2026-10-15.md). No Build code is authorized by this planning review. In addition to 50/30/47, `PBI-00` must materialize and validate the exact PDP0 **462-capability-leaf** implementation bridge before calling Plan Implementation complete.

**Planning disposition:** `APPROVED_FOR_DETAILED_PREPARATION_ONLY`, **NOT an entered BUILD campaign**. **Source reviewed:** `samujjwal/ghatana-media@8c4a3ef8c037a8808d2744139d95f146e70f12d3`, October 15, 2026. **Prerequisite:** exact PDP-0/1/2/3 current `DEV_COMPLETE` and 200-cell Discovery barrier `PASS`. See [Discovery execution](MEDIA-DISCOVERY-PDP3-FINISH-2026-10-15.md) and [owner decisions](MEDIA-DISCOVERY-TO-BUILD-OWNER-REVIEW-2026-10-15.md).

**Goal:** deliver a coherent actual, tested Media product for **all applicable definitions**—not simply four simulated journeys or green source validators. Reuse existing Media/Ghatana/Shared/Tools/Lifecycle technology and source; build real governed audio, video, image, speech, stream, timeline, editing, generation/simulation, versioning, rights, quality, delivery and machine experiences. No copied upstream engines, bypassed runtime admission or unsupported release claims.

## Product meaning and completeness denominators

- PDP-0: 38 requirement groups, historically 462 capability leaves, actors, goals, quality/rights/policy/retention, 30 journeys. **Recompute actual exact identifiers at frozen Discovery handoff**; counts here are orientation, not release gates by themselves.
- PDP-1: exact versioned artifact/project/job/session/result identities, operations/requests/results, guards/authority, unknown/cancel/retry/finality, events, provenance, privacy and offline semantics. Existing terminal and negative contracts govern implementations.
- PDP-2: canonical GUI tokens/components/layout/template/recipes, accessibility/localization and headless HTTP/gRPC/SDK/CLI/events/Agent/integration grammar. Use Shared artifacts only after their actual published admissibility, with allowed dev-only source composite.
- PDP-3: 47 screens, 30 journeys/130 steps, 147 action identities, 31 scenario definitions, 105 bounded recovery oracles (historical counts), **61 intended channel edges**. Distinguish *functional* authorized product screens/channels from `CONTRACT_PREVIEW` or `LOCAL_SIMULATION`. Existing 43 gRPC and 27 HTTP observed operations, 11 plan CLI commands and four Agent Tool contracts are reconciliation inventories, **not proof of runtime equivalence**.
- Surface denominator: **26 physical candidates** (12 physical + 12 support-only + 2 subsumed), **six semantic compositions + one root**, **17 consumer crosswalks** (16 active + one archived N/A) = 50 identities. Deduplicate shared physical dependencies across compositions. The separate [machine coverage map](media-build-coverage-plan-2026-10-15.json) assigns a *planned* Build package to every identity and lead package to all 30 journeys; it does not admit implementation.
- Preserve the existing **47 stable post-PDP tasks** in `post-pdp-owner-reviewed-execution-directive-2026-10-12.md`. Its historical statuses are not new verification; map all to Build, independent acceptance/PDP closure, or Delivery (see machine crosswalk). Do not resurrect historically complete BASE tasks.

**Full-product definition of done (Build):** each in-scope capability/requirement/operation/screen/journey/consumer is traceable to one build owner, source implementation/host or explicitly owner-approved unsupported applicability, negative/unknown/recovery behavior, tests and an actual observed qualification result. Required capabilities cannot be silently relabeled “preview” or “future” to claim completion. Independent PDP closure and Delivery qualification are separate transitions.

## Non-negotiable architecture / approved reuse

| Boundary | Concrete direction |
| --- | --- |
| **Canonical runtime/writer** | Until an authorized reversible `MIG-04` source/writer cutover, production-authoritative Java/service changes belong in **`samujjwal/ghatana:services/media`**; the `ghatana-media` runtime copy is a prepared destination, not a second live writer. Reconcile exact code and route/protobuf/DB migrations on both cuts before promotion. |
| **Media core** | Reuse existing `runtime-contracts/`, `launcher/` `MediaLauncher/MediaRuntime`, `providers/aws-postgresql/`, `modules/infrastructure/{persistence,messaging,security,cache}`, streams, STT/TTS/vision/multimodal modules. No generic job/workflow/event bus reinvention. |
| **Shared platform** | Use published/approved Shared typed Java/TS identity, audit/observability/security, `OutboxPublicationSource` / `ClaimedOutboxPublisher` and Shared design system. No imports of sibling private internals in releasable runtime. Dev source composites may prove contracts with `TEST_ONLY` status. |
| **Platform Data Cloud/Event/AI/DI** | Data Cloud: generic governed metadata/read models; Event Plane: durable publication/consumer receipts; AI Inference: model/profiles/provider governance; Document Intelligence: generic OCR/parsing/extraction. Media owns frame/scene/time/track/overlay semantics and consumes those **public** boundaries only. No copied OCR/model router. |
| **Clients and interface source** | `libs/audio-video-types`, `libs/audio-video-client`, `libs/audio-video-ui`, `apps/media-experience-explorer`, `libs/media-experience-simulation`, `contracts/openapi/media.yaml`, `config/route-manifest.json` and protobuf are source inventories. Make one canonical typed operation/request/result/error owner; generated clients, actual UI host and all shipped transports must agree with it. Explorer remains nonexecuting inspection tooling. |
| **External OSS** | Reuse existing approved engines and adapters first. Any codec, renderer, audio, vision or GPU dependency must undergo version/license/SBOM/security/reproducibility/CPU-GPU/fidelity and external data-retention review before use; do not assume FFmpeg/Blender/model assets have universally permissive redistribution terms. `NOT_ADMITTED` must be explicit before qualification. |
| **Reliability and data** | Tenant isolation, immutable SHA-256 version identity, idempotency, transactional artifact/metadata/outbox joins, lease/fence and attempt ownership, at-least-once publication with consumer idempotency, no provider replay from `UNKNOWN`, retention/holds/tombstones and verifiable deletion without false finality. |
| **Process** | Kernel `KDEV-STAGE-PLAN-IMPLEMENTATION → IMPLEMENT → VERIFY → DEVELOPMENT_COMPLETE`. Concurrent PDP phase closure *only after Discovery PASS*; Release/Deliver/Operate remain independent. No GitHub Actions as default mandatory gate; use source-bound focused local suites + stable-cut integrated qualification. |

## Build dependencies (no cycles and no all-or-nothing external dependency)

`PBI-00` gates `PBI-01`; `PBI-01` establishes build/contract baseline for `PBI-02/03/14`; `PBI-03` secures `PBI-04`; `PBI-04` feeds `PBI-05`; `PBI-05` feeds `PBI-06`. **First real vertical:** `J-01 (PBI-03) → J-02 (PBI-04) → J-20 (PBI-05) → J-03 (PBI-07)` with PBI-06 durability and PBI-11 UI. Thereafter speech/audio `PBI-08`, vision `PBI-09`, creation/simulation `PBI-10`, machine `PBI-12` and rights/delivery `PBI-13` can develop in bounded disjoint lanes. `PBI-14` measures every integrated vertical, `PBI-15` prepares cutover only after compatibility parity. A missing production publisher/profile blocks its own *admission*, not contract-correct local development or another admitted vertical.

## Work packages — exact what / where / how / tests / done

### PBI-00 — Enter Build Plan Implementation only on a verified Discovery handoff

**Owner:** Media engineering/stage owner. **Depends:** D-10 `DISCOVERY=PASS`, zero current PDP0–3 definition tasks, current 200-cell matrix and scope-approved source fingerprint. **Where:** `docs/implementation/`, `.product-experience/pdp-3-product-experience/generated/implementation-handoff.v1.json` successor, `config/`, existing `post-pdp-task-dispositions-2026-10-12.md`.

**Do:** import frozen capability/requirement/operation, 47-screen/30-journey/61-edge/17-consumer identities into an exact implementation coverage manifest; dedupe sources by authoritative package. Preserve historical statuses. For **every currently applicable** PDP-0 capability leaf, require a named Build owner, implementation target, provider/license admission state, end-user or machine outcome, and negative/unknown acceptance test. Record source digest and wave ID per item; fail missing mapping. Mark an externally governed effect `BLOCKED_EXTERNAL_OWNER`, not an implemented feature. Create one staged source/consumer dependency lock with approved/test-only origin classification, no local path as release evidence.

**Verify/exit:** no unassigned in-scope requirements/capability leaves, all 50 surface bindings, 30 journeys and 47 post-PDP task IDs covered, actual `Plan Implementation` admission after Discovery, not a self-published `DEV_COMPLETE` or `CLOSED`.

### PBI-01 — Clean source/toolchain, package and current canonical runtime baseline

**Owner:** Media runtime/build integrator. **Depends:** PBI-00. **Where:** canonical `ghatana/services/media/{build.gradle.kts,settings.gradle.kts,launcher/,runtime-contracts/}`, mirrored `ghatana-media` Gradle/pnpm files and `migration/`; existing `RUN-10/MIG-01/DEP-01` records.

**Do:** compile the canonical unchanged baseline **without `-x compileJava`** and resolve actual ABI/Gradle drift (historically `AbstractTypedAgent` import moved from `com.ghatana.agent.framework.runtime` to `com.ghatana.agent.runtime.turn`; verify *current* dependencies/method parity first). Pin JVM/Node/Rust build, protobuf/OpenAPI generators, dependency/license policies, native codec/module applicability; ensure reproducible dev-source-composite builds and source-free release-artifact checks. Keep concurrent workspace changes out of owned commits, no opportunistic refactor of other services.

**Verify/exit:** reproducible compile/typecheck/typed-client builds with focused tests; previously excluded compilation not called qualified; explicit missing immutable public package list with a dev-only safe route, clean owned cut.

### PBI-02 — Typed public interface contracts and generated consumers

**Owner:** Media API/types/protocol owner. **Depends:** PBI-01. **Where:** `runtime-contracts/`, `contracts/openapi/media.yaml`, `config/route-manifest.json`, `modules/{speech,vision,intelligence}/*/src/main/proto/`, `libs/audio-video-types/`, `libs/audio-video-client/`, `.product-experience/interface-parity/`.

**Do:** freeze operation IDs, schema requests/results/errors, versioning and pagination/stream finality against P1/P2, then generate compatible HTTP/gRPC/SDK/CLI consumers from one authority. Preserve historical 27 HTTP operations, 43 RPCs and 61 logical journey/channel mappings as **observed/declared reconcilable sets**, never infer parity from matching names. Test cross-language wire JSON/protobuf evolution, unknown enum/field compatibility, timeout/cancel/deadline, idempotency, replay and hostile input. Agent Tools go through Media-delegated bounded action and public Tools schema, not service internal imports.

**Verify/exit:** every **advertised** public operation is routed, authenticated, source-bound and contract-tested in both producer/consumer; every declared but not implemented channel is explicitly not shipped and cannot be counted as a supported complete product route without approved scope disposition.

### PBI-03 — Identity, workspace, authorization, trust and admission (J-01)

**Owner:** Media security + platform identity integrator. **Depends:** PBI-01/02. **Where:** `launcher/`, `modules/infrastructure/security/`, `runtime-contracts/`, `libs/audio-video-ui/`, `libs/audio-video-client/`; relevant P0/P1 policy/ownership and `DEP-03`.

**Do:** bind trusted auth/tenant/principal/workspace membership, scope/roles/delegation, consent/rights, request identity and policy guard to *actual* authoritatively selected host; deny unknown, stale, revoked, crossed tenant/scope, missing membership and forged header context. Fail closed if Shared public identity continuation remains not admitted. Implement real project create/read/status with immutable or optimistic target version and idempotency; instrument authority audits without leaking content. No synthetic Explorer login counted as an authenticated product.

**Verify/exit:** positive authorized J-01 create + readback on admitted host; tenant escape, spoofed principal, stale grants, duplicate keys and uncertain create are denied/reconciled. No state shown without trusted membership. Source-only host fixtures may proceed but cannot satisfy real admission.

### PBI-04 — Governed upload, immutable versions, storage/lineage (J-02)

**Owner:** Media artifact/DB/object-store owners. **Depends:** PBI-03. **Where:** `launcher/`, `runtime-contracts/`, `modules/infrastructure/{persistence,security,cache}/`, `providers/aws-postgresql/`, `adapters/ledger/`; `RUN-02`.

**Do:** verify begin/append/complete upload using sequential bounded chunks, durable resumable session, SHA-256 + size/hash validation, scanner quarantine, tenant-aware object keys, source-version immutability, idempotent create, compare-and-set version, provenance lineage, derived artifact atomic registration, hold/retention. Reuse existing V008 and observed `registerDerived()` candidate; missing production scanner/rights means fail closed before effect, not silently skip. Object-store/DB crashes and partial writes reconcile without duplicate visible artifact.

**Verify/exit:** real authorized J-02 upload and exact-version readback over durable PostgreSQL/object storage, no cross-tenant dedup disclosure, verified restart/partial upload/scan REJECT/UNAVAILABLE/unknown/retry, no phantom available state.

### PBI-05 — Durable jobs, state/attempt finality, cancel/retry and recovery (J-20, J-27, J-29)

**Owner:** Media runtime/lifecycle owner. **Depends:** PBI-04. **Where:** `launcher/`, `runtime-contracts/`, `modules/infrastructure/{persistence,cache}/`, `providers/aws-postgresql/`, `RUN-03/04`; P1 transition/guard authority.

**Do:** implement durable job+attempt identity, job version, persisted input/result snapshots, lease/fence, bounded concurrency, worker owner eligibility, idempotency and terminal classification. Preserve `UNKNOWN` through timeouts/restart/late ACK, reconcile provider receipt against the same attempt before any retry. Cancel request ≠ provider `CANCELLED`; deadline expiration ≠ provider failure; optimistic job status from UI ≠ authoritative finality. J-27 fallback must require exact original job/request, alternative version, current rights/license/quality/resources/budget and separate opt-in *before* any effect. J-29 session recovery preserves exact identity and consent freshness.

**Verify/exit:** real J-20 submit/status/cancel/outcome trace with crash-before/after-effect, delayed/duplicate receipt, missing provider ACK, leased concurrency and fenced restart; zero unapproved replay, data leakage or fabricated terminal result. Run multi-worker durable PostgreSQL tests, not only H2/in-memory.

### PBI-06 — Transactional outbox, Event Plane and consumer acknowledgment

**Owner:** Media persistence/event owner. **Depends:** PBI-04/05. **Where:** `modules/infrastructure/{messaging,persistence}/`, `providers/aws-postgresql/`, `launcher/`, shared public `OutboxPublicationSource/ClaimedOutboxPublisher`, `RUN-08`.

**Do:** complete a single durable DB transaction for authoritative state + outbound event, leased publisher, exponential backoff bounded retry/dead-letter, ordered/claimed publishing, consumer idempotency, poison message isolation, compensating reconciliation and provider-vs-consumer ACK finality distinction. Reuse V012 outbox candidate and Shared SPI; do not call `ConcurrentHashMap` outbox production durable. Restrict telemetry to hashed identifiers/typed outcomes, not media bytes.

**Verify/exit:** crash/restart/duplicate/partial transaction and concurrent claim tests on PostgreSQL, canonical last-effect truth reconstructable after restart; Event Plane receipt goes to accepted consumer and backpressure does not promote job completion.

### PBI-07 — Speech-to-text, transcript and immutable caption editing (J-03)

**Owner:** Media STT/transcript/UI owners. **Depends:** PBI-05/06, admitted suitable processing profile. **Where:** `modules/speech/stt-service/`, `modules/intelligence/speech/libs/speech-audio-rust/`, `runtime-contracts/`, `libs/audio-video-client/`, `libs/audio-video-ui/src/screens/TranscriptCaptionScreen.tsx`, `RUN-05`.

**Do:** after exact artifact/rights/profile authorization, run real STT, preserve diarization/timing/confidence/no-speech/error/locale/timeline, register immutable transcript version, editable session-local caption draft, guarded timing/correction and new immutable caption version. The source artifact never changes. Reuse V011 append-only transcript revision store and typed error model; session edit ≠ immutable registration or rights approval. Provider timeout is `UNKNOWN` pending readback. Qualified profile/model selection and licensing remain explicit.

**Verify/exit:** authenticated J-03 source→processing→typed transcript→edited immutable caption-version comparison in UI and headless client on a qualified profile, with stale base, missing alignments, consent revoked, language uncertainty, negative and restart tests. If no admitted provider, happy-path remains `NOT_ADMITTED`, not a Build-complete product claim.

### PBI-08 — TTS, dubbing, audio cleanup, effects and streaming (J-04, J-07, J-16, J-17)

**Owner:** Media speech/audio owners. **Depends:** PBI-05/06, PBI-07 where timed captions used. **Where:** `modules/speech/tts-service/`, `modules/audio-streaming/`, `modules/intelligence/speech/libs/speech-audio-rust/`, `modules/intelligence/ai-voice/libs/ai-voice-ui-react/`, `libs/audio-video-ui/`.

**Do:** implement source-/consent-/voice-profile-governed TTS and optional voice cloning only with explicit biometric/rights approvals; same-timebase dubbing/translation and review, bounded stream sequencing/reconnect/latency/backpressure, audio restoration/noise cleanup, stems, mix/master and exact versioned output. Do not assume that source-internal Rust/audio libraries are licensed production engines or that successful synthesis means publication approval. Separate provider/cost/region/retention eligibility and deterministic offline processing where defined.

**Verify/exit:** each J-04/07/16/17 has real typed input/terminal output, original preserved, A/B timing/loudness/quality measurement, consent/rights failure cases, no unapproved cloning or alternate voices, stream loss/reconnect and backpressure tests.

### PBI-09 — Vision, temporal tracking and grounded multimodal (J-05, J-06, J-08, J-11)

**Owner:** Media vision/multimodal owners. **Depends:** PBI-05/06; AI Inference/Document Intelligence public contracts for selected functions. **Where:** `modules/vision/vision-service/`, `modules/intelligence/multimodal-service/`, `modules/video-streaming/`, `runtime-contracts/`, `RUN-06`.

**Do:** implement exact frame/region/timebase normalization, model/provider/version/uncertainty, tracks/geometry, source-bounded result, reversible region-mask edit/undo, video quality repair with exact before/after metric pair, multimodal grounding, and typed denied/unavailable/unknown. Generic OCR uses Document Intelligence public boundary; generic model execution uses AI Inference, not Media-owned duplicate engines. Produce quality baseline/latency and admission per exact qualified provider/locale/profile.

**Verify/exit:** real J-05/06/08/11 terminal same-subject results or legally/technically explicit nonadmitted state; geometry/timebase/uncertainty/quality metrics, cross-tenant, malformed spatial payload, unavailable model and no-hallucinated-completion negative tests.

### PBI-10 — Creation, animation, simulation, render, composition and spatial export (J-09,10,12–15,18,19,28)

**Owner:** Media creative/render/3D/simulation owners. **Depends:** PBI-05/06, relevant PBI-08/09. **Where:** `runtime-contracts/`, `launcher/`, `modules/video-streaming/`, `libs/audio-video-ui/`, Media creation/animation/simulation domain modules **only where the current module actually owns them**; use adapters rather than inventing a duplicate generic renderer.

**Do:** for each defined capability select a qualified engine/provider/profile under approved format/license/resource constraints; implement storyboard/source-free vs source-derived generation, exact references, deterministic 2D/vector/procedural animation, 3D rig/path/scene manipulation, simulation input/output with units/fidelity, render job terminality, timeline/edit/mix/color/caption composition, bounded optimize/compare, spatial/360/interactive format conversion and explicit loss reports + receiving consumer receipt. Existing `MediaCreationContracts` are typed design candidates, not working engines; keep source-version/plan/run/output identity separate.

**Verify/exit:** source-to-render-to-deliver workflows for J09/10/12/13/14/15/18/19/28 with actual media output, reproducible format/quality/geometry fidelity experiments, control-state assertions, deterministic replay where promised, A/B review, resource/cost caps, timeout/cancel/`UNKNOWN`, invalid rig, unavailable provider and conversion-loss tests. No preview passed off as a completed render.

### PBI-11 — Production GUI/embedded UI and truthful Explorer (all 47 screens)

**Owner:** Media UI/Shared design-system owner. **Depends:** PBI-02/03 and each real runtime vertical's contracted results. **Where:** `libs/audio-video-ui/`, `libs/audio-video-client/`, `modules/intelligence/ai-voice/libs/ai-voice-ui-react/`, `apps/media-experience-explorer/`, canonical PDP2 GUI contracts.

**Do:** implement all applicable product screens using one reusable Shared-derived token/component/layout/recipe system and generated typed UI client; 47 stable screen IDs and actions mapped to real routes/states (loading, empty, denied, unavailable, partial, unknown, stale, completed, retry/undo only when safe). No local CSS patches substituting for a design-system fix. Real product must expose version/provenance/decision/quality and safe navigation/return destinations. Explorer remains a separate projection with clear `LOCAL_SIMULATION`/`CONTRACT_PREVIEW`/`REAL_IMPLEMENTATION` distinctions and read-only source drilldowns. Host-dependent React voice or embedded consumers must have source-owned host admission.

**Verify/exit:** **47/47** applicable screen contracts accounted; every required screen is a real functioning route tied to an authorized runtime or explicitly approved product N/A, not just a fixture. Desktop/tablet/mobile viewport screenshots, visual regression, RTL/localization where specified, zoom/reflow, keyboard, screen reader, reduced motion, contrast, error boundaries, pageErrors=0 and recovery/cancel honesty. Formal independent accessibility attestation remains separate.

### PBI-12 — Public machine channels: HTTP/gRPC/SDK/CLI/events/Agent/integrations (J-24, J-25, J-30)

**Owner:** Media public API/SDK/CLI/Agent and integrating-product owners. **Depends:** PBI-02/03/05 and real vertical capabilities. **Where:** `contracts/openapi/`, `config/route-manifest.json`, protobuf modules, `libs/audio-video-client/`, `libs/audio-video-types/`, `libs/common/`, `modules/infrastructure/messaging/`, `.product-experience/pdp-3-product-experience/{agent-tools,api,grpc,cli,events,services}/`.

**Do:** implement named intended consumer surfaces with compatible typed request/result/error, exact tenant/authority, version/finality, cancellation/retry/unknown and rate/cost budget. Generated SDK never adds operations absent in runtime. CLI prints machine-stable JSON and nonzero exit status; SIGINT cancellation is request only. Agent Tools enforce least privilege, bounded depth/cost, untrusted media isolation and user/host authority, no self-authorizing Action Plane effect. Event and destination ACK are separate from HTTP/gRPC 200/201. Eligibility J-30 is a read-only query, not dispatch permission.

**Verify/exit:** observed HTTP, 43 RPC source observations, 11 intended CLI command identities, SDK and four Agent Tool logical contracts each map to an actual admitted adapter or explicit excluded/unavailable public feature; end-to-end response/error parity and malicious/cross-tenant/idempotency/finality cases. 61 journey/channel pairs have evidence *per supported runtime channel*, not borrowed from a sibling.

### PBI-13 — Rights/review, delivery, consent erasure and offline (J-21,22,23,26)

**Owner:** Media privacy/rights/lifecycle/delivery owners. **Depends:** PBI-03/04/05/06 and relevant produced outputs. **Where:** `runtime-contracts/`, `launcher/`, `providers/aws-postgresql/`, `modules/infrastructure/security/`, `modules/infrastructure/persistence/`, `libs/audio-video-ui/`, `docs/MEDIA_PRIVACY_AND_RETENTION_POLICY.md`.

**Do:** implement version-bound human review/comment and *actual approval only after accountable rights-owner authority*, destination delivery with correlated external receiver ACK (submit ≠ delivered), bounded offline queue/reconciliation with conflict+consent checks, consent revoke with authority receipts, access restriction, legal hold/retention, multi-copy storage/provider backup erasure verification and truthful `REQUESTED/IN_PROGRESS/PARTIAL/UNKNOWN/VERIFIED` states. Prevent deletion while legal hold requires retention; prevent “erased” badge from maintenance count or scoped read. J-21 remains `BLOCKED_EXCLUDED` while no real rights-owner approval path exists; do not ship an approval button that falsely succeeds.

**Verify/exit:** J-21/22/23/26 real supported states/actions verified by accountable authorities; destination ACK replay/corruption and wrong recipient; revoked rights immediately block new effects; restore/backup/provider-copy tombstone tests; hold, timeout, retention, partial and unknown erasure surfaces with exact reason. No universal erasure claim without audited all-scope proof.

### PBI-14 — Cross-product verification, telemetry, security, scalability, performance and operability

**Owner:** Media SRE/security/quality/test owners. **Depends:** PBI-01; evolves with every vertical. **Where:** `tests/`, `integration-tests/`, `modules/integration-tests/`, `benchmarks/`, `audio-video-observability/`, `monitoring/`, `prometheus.audio-video.yml`, `docs/OPERATIONS.md`, `docs/TESTING.md` and isolated durable fixtures.

**Do:** establish real source-linked SLO and experiment targets from PDP0 NFRs and measured baselines; `docs/OPERATIONS.md` currently **does not** declare production latency/throughput/availability SLOs, so do not invent numeric targets. Instrument OpenTelemetry trace span graph `request → policy → artifact → job attempt → provider → outbox → consumer → UI result` with request/tenant-safely-hashed IDs and cardinality budgets; Prometheus/structured metrics for p50/p95/p99, queue age, throughput, concurrency, backpressure, provider error, unknown finality, retry, redaction and storage growth. Test one-to-many tenant starvation/fairness, lease/fence contention, horizontal workers, DB indexes/batching, bounded event/manifest/evidence persistence, stream memory, GPU/CPU load, object lifecycle/GC, encryption, license/PII/secret scan, audit retention, crash/partition/restore, abuse and DR. Prefer rootless/local fixture experiments where valid; a test lacking production-like DB/GPU/host is `NOT_QUALIFIED`, not waived.

**Verify/exit:** actual baselines and owner-adopted budgets, reproducible profiles with adequate hardware provenance, one unfiltered integrated JVM/Node/browser/DB path per stable cut, failure-injection/property/fuzz/compatibility and multi-worker soak tests, alert/runbook correlation, zero high-severity unmitigated risks, clear SLO gaps and no media-byte telemetry. Compact receipts: digests, test summaries, sampled redacted traces, bounded screenshots—never re-archive huge source dumps for each test.

### PBI-15 — Dependency/artifact admission and reversible runtime migration readiness

**Owner:** Media + genuine canonical Ghatana/Shared/Tools/Lifecycle contract owners. **Depends:** stable PBI-01/02, real core/product verticals and PBI-14. **Where:** `migration/`, `docs/migration/`, `config/`, both repositories' manifest/route/protobuf/DB migration sources, `deploy/`, `docker/`, `infra/`.

**Do:** preserve the approved 2,854-row historical *candidate* manifest and 2,817 previously `NOT_AUTHORIZED` source keys as history; recompute **current** path/type/consumer parity instead of relying on Oct12 tree count. Verify one canonical source writer, no double-registered endpoint, HTTP/RPC/SDK/CLI/event/SQL/lineage parity, shadow read, reversible alias, DB migration and storage ownership, delegated source owner signoff, license/SBOM/release artifact hashes, downgrade/rollback and cutover window. DEV_SOURCE_COMPOSITE is not a production package. **Build scope stops at prepared, tested, owner-reviewable migration; executing canonical authority switch belongs to separately admitted Delivery/cutover.**

**Verify/exit:** exact per-file and consumer handoff, reproducible artifact-only build and source-free tests, qualified shadow/reverse migration rehearsal, signed owner decisions for external artifacts where required; missing independent/production authorization recorded, not invented.

## All 30 journeys — mandatory coverage slices

The following are **planning assignments**, not working claims. Every named J ID must trace from a PDP3 journey → P0 requirement/capabilities → P1 operations/effects/authority → P2 UI/headless grammar → physical and consumer owner → actual positive/denied/unknown/recovery integration tests. No invented “generic journey passes all.”

| Lead Build package | Journeys to actually implement and verify |
| --- | --- |
| `PBI-03 / PBI-04` | **J-01** identity/project; **J-02** governed upload/available immutable artifact |
| `PBI-05` | **J-20** job observation/cancel/retry; **J-27** provider unavailable/fallback; **J-29** live/session consent-loss recovery |
| `PBI-07` | **J-03** STT → corrected immutable captions |
| `PBI-08` | **J-04** TTS; **J-07** audio cleanup; **J-16** translate/dub; **J-17** music/stems/effects/master |
| `PBI-09` | **J-05** analysis/tracks; **J-06** grounded multimodal; **J-08** video repair/quality; **J-11** region edit/undo |
| `PBI-10` | **J-09** storyboard/render/delivery; **J-10** controlled generation; **J-12** 2D animation; **J-13** 3D rig animation; **J-14** simulation fidelity; **J-15** semantic validation; **J-18** compose/mix/captions/color; **J-19** improvement; **J-28** spatial export/loss |
| `PBI-12` | **J-24** CLI batch; **J-25** delegated Agent/product integration; **J-30** eligible options read |
| `PBI-13` | **J-21** rights/version review; **J-22** destination ACK; **J-23** offline/reconnect; **J-26** consent revoke/erasure |

`PBI-11` GUI and `PBI-12` headless implementations accompany **all applicable** journeys; `PBI-14` verifies **all**. One journey's lead package is not the only package allowed to implement it.

## Exact 47-task backward-compatibility crosswalk

Re-use `docs/implementation/post-pdp-owner-reviewed-execution-directive-2026-10-12.md` and [machine map](media-build-coverage-plan-2026-10-15.json). Preserve its 47 IDs/statuses and classify:

- **BASE-01…05, SUR-10, EXP-07:** historical local completion / **reuse**, no repeat implementation without changed source.
- **SUR-01…09:** hierarchy/source/admission/Explorer owner review and implementation adoption distributed `PBI-00/11/12/15`, not new PDP tasks.
- **DEP-01…04:** artifact/Shared identity/design/Platform public-contract admission `PBI-01/02/03/12/15`. External-owner decision remains genuinely external; permitted dev fixture/test-only composition cannot masquerade as publication.
- **MIG-01…04:** parity and migration `PBI-01/15`; actual source writer switch is Delivery-gated.
- **RUN-01…10:** runtime, uploads, jobs, speech, vision, creation, outbox, observability, production-like tests `PBI-03…10/14`.
- **EXP-01…07:** product screens, journeys, parity and Explorer `PBI-11/12`.
- **ACC-01…03, LC-01…02:** **independent semantic acceptance and PDP closure lane**, source-bound and parallel to Build **only after Discovery PASS**; not substitutes for test or a demand that unqualified agents fabricate signoffs.
- **REL-01/02:** **DELIVER** qualification/canary/GA after actual Build Development Complete, closure and authentic release decisions; not current Build tasks.

## Experiments/quality matrix — don't treat happy-path unit tests as completion

| Test/experiment | Required proof and no-false-success criterion |
| --- | --- |
| Source/ABI/route compatibility | JVM/Node/Rust native compilation + HTTP/OpenAPI/gRPC descriptor compatibility, SDK/CLI consumer tests, package artifact source-free and legal license provenance |
| Governance/security | Tenant/actor isolation, consent/rights/biometric guard, stale/wrong version, malicious upload, SSRF/agent untrusted output, auth-expired midstream; refusal **before effect** |
| Data/recovery | Concurrent chunk writes, durable hash/scan, DB-object atomicity, restore from backups, lease owner/fence, late/duplicate provider/destination receipt, idempotent event replay, partial erasure with honest status |
| Performance/scalability | 1→multiple workers/tenants, load + sustained soak, queue/backpressure, DB transaction/index latency, object/media growth, CPU/GPU pressure, first-class metric baseline and real sampled spans without high cardinality |
| Rendering/media quality | Format/codec/coordinate/timebase fidelity, A/B quality/latency/cost, deterministic algorithm where defined, model/voice/locale per-profile admission, insufficient compute/unsupported license errors |
| Product UX | 47 actual screens + responsive design system and accessibility checks, 30 real supported journey runs, headless/API cases, 61 channel contracts with honest per-transport dispositions, real and preview clearly separated |
| O11y/runbooks | Typed OpenTelemetry trace correlation, Prometheus target viability, no source media/PII in telemetry, alert/action diagnosis under failed provider/DB/Event Plane, release fail-safe/rollback rehearsal |

**Experiment tooling:** Use rootless/local container execution and deterministic fixtures where supported to avoid needless sudo/GPU bottlenecks; never label a CPU-only synthetic test a GPU/model-quality certification. Store evidence references, digests and minimal telemetry samples rather than duplicates of media, videos, giant logs or full frozen manifests.

## Stage transition and incremental closure: exact stop/go

1. **Before Discovery PASS:** this Build document is a plan and an owner-approved target design. No `PBI-*` execution and no native PDP closure.
2. **Plan Implementation entry:** exact pinned four-PDP source handoff, complete crosswalk with zero unassigned mandatory capability/source/consumer, external/test-only dependency dispositions, stable Build DAG and test architecture. Then allow bounded source code in `ghatana/services/media` under actual writer authority.
3. **Implement/Verify:** incrementally integrate authenticated vertical slices; a leaf with a real qualified implementation and tests can finish **its Build work** without the entire product being done. Keep per-surface work independent, rerun only affected dependency descendants. In parallel, have actual qualified actors issue PDP acceptance/closure receipts for completed frozen definitions.
4. **Build DEV_COMPLETE:** **all applicable** planned product functions, 47 screens, 30 journeys, 17 consumers, source capability denominator, negative/cross-tenant/finality tests, NFR and production-like security/reliability qualification pass against exact source; no unreviewed required feature masked by preview. Missing qualified provider or real rights owner means blocked on that effect, not declared complete.
5. **DELIVER gate:** independently accepted/closed required PDP units + Build development completion + immutable signed packages, rollback/source cutover authority, real operator and environmental admission. No manufactured production evidence.

**Implementation efficiency:** one owner of `operations.yaml`/shared registries/migrations, 2–3 resource-bounded parallel workers on non-overlapping packages, serialize DB/real browser/GPU qualification; granular source-diff selection, one integrated suite per stable cut. Observability and failure semantics are part of each slice, not an end-of-project patch. All owner choices here concern **Media internal planning**; external professional/signature/public-contract/production decisions remain pending their genuine accountable parties.


---

## R2 Build acceptance hardening — PDP source → exactly one implementation owner

This section **strengthens existing PBI-00…15**, it is not another Build backlog or a replacement for the 16 work packages. It is authored while Discovery is active and becomes eligible for execution only after all four PDPs are current `DEV_COMPLETE` and 200/200 phase cells pass.

### B-01: 462 exact PDP-0 capability leaf obligations

**Canonical source:** `.product-experience/pdp-0-product-truth/capability-leaf-review.yaml` and `capabilities.yaml`, connected to `requirements.yaml`, `journey-catalog.yaml`, `applications-channels.yaml`. Existing owner-observed split is **77 journey-step capabilities + 383 machine channel capabilities + 2 platform-owned dependencies = 462**; counts must be recomputed from the actual frozen source, not hardcoded as a substitute for presence.

**Implementation output (PBI-00 owned):** generate a stable source-derived `media-build-capability-coverage.v1.json` with exactly one row per current `capabilityIntentId`, fields:

`capabilityIntentId`; `requirementRef`; `sourceSha256`; `pdp0MeaningClass`; `actor/tenant/authorityRefs`; `pdp1OperationRefs`; `pdp1RequestResultVersion/errorRefs`; `pdp2ConsumerGrammarRefs`; `pdp3JourneyOrHeadlessExperienceRefs`; `physicalSurfaceId`; `consumerSurfaceIds`; `pbiWorkPackageId`; `sourceOwner`; `implementationModulePath`; `implementationStatus`; `profileAndProviderAdmission`; `positiveDeniedUnknownRecoveryTestRefs`; `performancePrivacyO11yAcceptanceRefs`; `externalOwnerDependencyIfAny`.

**Generation rules:** canonical PDP artifacts remain the sole editable authority. Require exact P0 requirement/capability/actor/channel joins, P1 typed operation/result and P2 interface binding where applicable; preserve legitimate machine-only capabilities without fake journey/screens; platform-owned functions become explicit upstream consumer contract work, not copied into Media. An otherwise required unimplemented capability stays `OPEN` or `NOT_ADMITTED` and cannot vanish under `N/A` or a generic “future” label. Fail duplicate, missing, ambiguous or foreign-owner links. Deduplicate each leaf, do not count each transport as a new leaf. The existing 50 surface/30 journey/47 task map is the stable **planning** crosswalk, while the generated 462 rows prove no feature is omitted.

**Acceptance:** recomputed 462/462 or source-current successor denominator, zero orphan capability IDs, every required leaf has one lead PBI owner with nonempty exact source and tests, no false runtime admission. Missing model/provider/rights/public artifact remains a named, independent external blocker only to the specific required operation; Plan Implementation can be authored safely while production activation remains separate. Reconcile required technical Build completion against all applicable rows, not the easiest seeded demo.

### B-02: strict single-responsibility interfaces and cross-repo ownership

| Normative concern | Single authoritative owning location | Permitted generated/consumed representations |
| --- | --- | --- |
| Product purpose, capability/actor/quality/policy | PDP-0 Media `.product-experience/pdp-0-product-truth/` | PBI-00 implementation assignment, tests, Explorer specification projection |
| Canonical Media effect, versions, finality, privacy, domain events | PDP-1 Media `pdp-1-domain-data/` | Java/TS typed DTOs, persistence schemas, transport adapters and PDP-3 observations |
| GUI tokens/recipes, headless grammar, accessibility | PDP-2 Media interface declarations + admitted Shared public design primitives | Reusable UI views, exact REST/RPC/SDK/CLI/event adapters; never duplicate design tokens per screen |
| Action/journey/screen-specific semantics and safe next step | PDP-3 Media `pdp-3-product-experience/` | Explorer preview and real product presentation via same semantics; Explorer is not a second business rules engine |
| Artifact/job transactional state | Currently authoritative `ghatana/services/media` runtime and Media DB owner | Generated clients/selected consumer views only; standby repo does not create another live state writer |
| Identity, messaging, generic agent framework, observability | The respective Shared/Platform/Event/Tools/Lifecycle **public** boundary | Media domain adapters, never private package imports or forked engines |
| Generic OCR/document extraction/model governance | Document Intelligence and AI Inference public boundaries | Media frame/scene/track/time and provenance adapters |
| Lifecycle source-currentness and closure receipts | Lifecycle public issuer | Media source-bound producer inputs, per-leaf evidence references; no Media-issued “closed” receipts |

**Verification:** contract parity is typed and bidirectional (producer/consumer), no auto-generated executable surface without admitted host, and no two sources allowed to independently set the same normative meaning. Generated projections are deterministic and stable on no-op reruns.

### B-03: vertical execution and partial-failure policy

- **Foundation:** PBI-01 source-free compile (JVM/Node/Rust) and PBI-02 stable typed contracts, PBI-03 trusted tenant/workspace/consent. Start each actual run with exact freeze ID, owner, test environment and source-defined result. All external integrations fail closed until admitted; unqualified profiles are not silently substituted.
- **First real vertical:** PBI-03 `J-01` → PBI-04 `J-02` → PBI-05/06 `J-20` → PBI-07 `J-03`. Each slice must include positive outcome, denial/timeout/unknown, idempotency, concurrency and crash/restart, a real UI or relevant headless route and actual authoritative readback. Zero unreconciled provider outcome replay. A submitted job is not a rendered/transcribed/delivered output.
- **Capability-family expansion:** PBI-08 audio/TTS/dubbing/music; PBI-09 vision/grounded multimodal/repair; PBI-10 2D+3D/animation/simulation/render/spatial; PBI-11 all applicable 47 real product screens and design system; PBI-12 headless interfaces including API/SDK/gRPC/CLI/Agent/events; PBI-13 rights/ack/offline/erasure. Build one *real* governed vertical at a time per domain, share stable artifacts and retries. Existing 30 journey IDs remain the integrated verification and coverage denominator; the 383 machine capability leaves remain separately visible.
- **Cross-cutting from the first vertical:** PBI-14 observability/cost/SLO/security/abuse/data retention and real performance experiments and PBI-15 migration readiness. Do not postpone monitoring or hardening to release or store unbounded repeated evidence. Use request → auth/consent → exact source version → job/attempt → provider → outbox → consumer receipt → UI result linked trace context with bounded cardinality, secure/redacted logs and deterministic source digests.
- **Acceptance by leaf:** no Build leaf marked `DEV_COMPLETE` until actual runtime/function and all its required positive/negative/adversarial and qualification cases pass. An explicitly unused or archived physical candidate does not become an implicitly supported public consumer. An external unavailable profile/approval can keep that exact effect blocked without preventing completion of unrelated leaves; whole-product Build `DEV_COMPLETE` must still account for every required capability and qualified channel.

### B-04: performance, scalability and storage/observability budget design

PDP-0 `nonfunctional-requirements.yaml`, `quality-policy.yaml` and `qualification-policy.yaml` set the *required* performance and fidelity meaning; `docs/OPERATIONS.md` currently supplies safety invariants but no numeric production latency/throughput/availability SLO. **No numeric target is approved solely by this plan.** PBI-14 must build a real baseline and qualify SLOs for: ingress bytes/second per tenant, maximum concurrent safe jobs, queue age/lease lag, P50/P95/P99 operation and end-to-end elapsed times, worker recovery latency, provider first-token/terminal latency, GPU/CPU and network/memory per output, artifact storage growth versus retention, outbox retry/dead-letter age, and consumer finality confirmation. Partition by profile/codec/model/resolution/timebase, never mix incompatible classes in a single average.

Use small deterministic fixtures for develop/test, rootless containerized PostgreSQL/object-store/event fixtures when valid, controlled multi-worker loads, defined soak/fault partitions, and real GPU/media quality certification only where hardware/licensing is qualified. Source-captured request/result replay must be fenced; chaos must never emit privileged external effects against production accounts. O11y emits OpenTelemetry/Prometheus redacted trace/metrics with bounded labels (no raw media, PII, unbounded object IDs), release health probes and actionable runbooks. Preserve compact source digest/test summary/sample trace references, not new copies of large logs/screenshots/assets on every rerun.

### B-05: Plan Implementation acceptance, execution closure, and delivery separation

`PBI-00` can be **planned now**, but **execution gate** is Discovery PASS and source-bound `DEV_COMPLETE` for all applicable PDP0…3 cells. At `KDEV-STAGE-PLAN-IMPLEMENTATION` entry capture actual full 462-leaf bridge and the frozen 50/30/47/61/14 trace graph, public dependency lock (released or `TEST_ONLY`), exact owner/resource paths and finite PBI DAG. Then enter Implement/Verify incrementally per leaf. Independent PDP phase acceptance/closure may progress concurrently after Discovery passes, only by authentic authorized authorities; it is neither a substitute for working software nor a global repeated prerequisite to coding. **Delivery** remains blocked until required PDP closure, actual Build development completion, signed packages/rights/security and an approved reversible `MIG-04` source/writer migration.

**Do not ship partial feature preview as complete product**: the 47 screens and machine channels must be mapped to real supported effects with honest availability; all 30 journeys get end-to-end behavior or explicitly source-approved product nonapplicability; all applicable 462 capabilities retain their identity and verification. Do not fabricate a separate architecture, duplicate Media's meaning in consumers, change a source stage to bypass a blocker, or accept test coverage numbers without real tests.

---

## 2026-10-18 unified-source successor integration (current planning reader)

The [current unified-production plan](MEDIA-UNIFIED-PRODUCTION-CURRENT-PLAN.md) now joins the [complete 428+73 source blueprint](references/MEDIA-UNIFIED-DATA-DRIVEN-PRODUCTION-BLUEPRINT-V3-2026-10-17.md), [501-item audit mapping](observations/media-unified-production-501-feature-reconciliation-2026-10-18.json), 84 Recorder and 61 declarative PDP cases, and GharBatai's [existing 32-DX single-queue adoption](https://github.com/samujjwal/gharbatai/blob/codex/gharbatai-media-editorial-pdp-handoff-20261018/docs/demo-recording/CURRENT-PROFESSIONAL-DEMO-MEDIA-HANDOFF.md). It does **not** create a 17th PBI or advance this prepared-only Build plan. All Media video/voice/audio/AI/director/color/music/collab/interactive/scientific simulation requirements in the 22 review domains remain in PBI-00…PBI-15 and must be reviewed for actual P0 leaf fit, typed P1 semantics, P2 interface parity and P3 cases before implementation scheduling.

**Build admission barrier unchanged:** actual current PDP-0, PDP-1, PDP-2 and PDP-3 source-cut DEV_COMPLETE, 216-cell successor applicability/Discovery PASS where required, exact consumer contracts, and accepted implementation ownership. The 428 original audit mappings are **unreviewed candidates**; a 501-row audit is not 501 implemented or accepted capabilities. The source-owned new phase checkers and negative tests have not run natively in this remote session. Preserve `ghatana/services/media` as executable writer pending separately authorized reversible MIG-04; Build, real GharBatai film and TutorPutor scientific/provider release require independent evidence.

### Original-attached-source preservation and blocking PDP-0 disposition — 2026-10-18

Before beginning `PBI-00`, read the [exact attached 501-item audit](references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json), the [original 73 ID/case-candidate crosswalk](observations/media-attached-third-pass-id-provenance-crosswalk-2026-10-18.json), and the [living source pipeline](MEDIA-UNIFIED-PRODUCTION-CURRENT-PLAN.md). All 428 first/second-pass original feature targets and 73 third-pass stable IDs remain preserved separately from 73 derived `AUD-FOCUS-*` rows; 71 of the latter original IDs have broad existing-case candidates, but two specialist simulation families have no scoped PDP-0 case candidate. Treat these as `PDP0_OWNER_SEMANTIC_REVIEW_REQUIRED`, not as unavailable runtime features silently excluded from the full product. P0 semantic source decisions, affected downstream P1–P3 currentness and actual Discovery barrier approval must precede Build Plan Implementation entry. `PBI-00…15` remains the **only** planned Build package schedule and is not duplicated by this audit. Do not invent costs, hardware qualification, legal clearance or a validated soft-body/epidemiology solver merely to green the Build plan.

### Original blueprint worklist — one existing PBI owner per implementation obligation

The [source-exact 86-item work-and-test crosswalk](observations/media-unified-source-task-and-experiment-crosswalk-2026-10-18.json) contains **40 original implementation/definition planning rows** (`M-00…15`, `INV-01…12`, `DAS-01…12`) and **46 original acceptance experiment rows** (`C-01…28`, `DAS-A01…A18`), with original row text and candidate PBI-00…15 associations. All 16 existing PBIs are represented. The crosswalk is **planning-only**, not another execution queue, surface, operation, stage transition or assertion that these experiments passed. Do not leave out high-cost models, professional manual editing, qualified codec/source readback, scientific validation, TutorPutor's public AEF or GharBatai's human signoff because a narrower 61-case focus already exists. At post-Discovery `PBI-00` entry, establish the exact owner/package/test/QA assignment and discard duplicate planning queues after preserving source trace. See the [dependency diagrams](MEDIA-UNIFIED-PRODUCTION-CURRENT-PLAN.md#source-dependency-diagram-for-original-planned-work).

