# Ghatana Media — all-surface lifecycle and gtool implementation runbook

> **Execution handoff, not a replacement for any canonical product definition, method, task ledger, proof authority, or independent acceptance.** Authored 2026-10-30 from Media main `8d109b7bac98af20c326e3e37387aa3775409021`, Lifecycle main `87a3c76ccb9d3dfa874656c2f971115e8bfe6ada`, Ghatana main `cb568c5f05f53288b7548c7b3684ebc4b32fcaec`. This file's own commit moves Media HEAD: refresh every source/method/material pin before running. **No test, deployment, gtool transition, protected admission, legal rights grant or native receipt is claimed by authoring this file.**

## 0. Controlling sources and ownership

- Media meaning and applicability: `.product-experience/{surface-registry.yaml,surfaces/media-physical-topology.v1.json,pdp-0-product-truth/,pdp-1-domain-data/,pdp-2-design-interface-system/,pdp-3-product-experience/}`.
- Product development method target: Lifecycle `tools/documentation-model/presets/methods/ghatana-product-development.v3.yaml`, with media owner binding/selector adoption; older `media-product-development.v1.json` is historical source-status reader, not all-stage substitute.
- Existing Lifecycle native phase program: Media `config/closure/media-product-definition/{phase-program.json,phase-binding.json,obligations.json,surface.json}`; generator `scripts/generate-media-lifecycle-source-inputs.mjs`.
- Build task authority: `docs/implementation/MEDIA-BUILD-IMPLEMENTATION-PLAN.md` (F00–F13, V01–V30, L01–L03, X01–X03) and exact generated `MEDIA-BUILD-WORK-PACKAGES.v1.json`. **Do not create parallel F/V/L/X IDs.**
- Wave 2: `MEDIA-WAVE2-R8-FULL-ACCEPTANCE-MATRIX.json`, `MEDIA-WAVE2-R10-OWNER-BLOCKER-RESOLUTION.json`, `MEDIA-WAVE2-COMPLETION-EXECUTION-2026-10-29.md#10`. Preserve **58** original IDs and the recorded **22 verified / 30 partial / 6 external** classification; **36** still require full-row acceptance.
- Additional physical/consumer engineering: `MEDIA-BACKEND-REMAINING-SURFACES-2026-10-30.md` with **88** tasks over 15 backend/support areas + **8 H logical tasks**, and `MEDIA-BACKEND-REMAINDER-SOURCE-COVERAGE.v1.json`; **96** W3/H rows require source/test/positive-effect readback, not code re-implementation solely for a green checkbox.
- Terminal qualification: `MEDIA-BACKEND-TERMINAL-QUALIFICATION-2026-10-30.md` and its **Q00–Q16** owner/corpus/real-effect/integration acceptance coordination; these are not new canonical task identities.
- OCR: `docs/migration/decisions/MDI-001-document-intelligence-ownership.md` and `docs/migration/document-intelligence-media-crosswalk.md` (OCR-C01/D01/D02/M01/M02/K01/M03/X01). Ghatana `services/document-intelligence/` owns OCR; Shared `@ghatana/document-extraction` owns provider-neutral types.
- Native closure/execution authority: Lifecycle `docs/engineering/MEDIA_GTOOL_PHASE_MANAGEMENT_RUNBOOK.md`, `tools/gtool/README.md`, Work Planner, Verification Planner, Evidence Generator and Surface Convergence. Do not conflate `DEV_COMPLETE`, `CLOSED/CURRENT`, Build acceptance and production eligibility.
- Product outcomes and recordings: 47 GUI screens, 30 journeys, 27 HTTP operations, 43 gRPC RPCs, 4 declared agent handlers, 11 plan CLI commands (12 observed fixture commands); source facts are validated at each run.

## 1. Exact denominator and change-impact correction (first mandatory execution gate)

The older canonical native handoff describes 26 physical + 21 consumer + 7 composition = **54 source identities**. Current topology at reviewed Media main declares **29 physical manifest candidates + 21 logical consumer records + 7 compositions = 57 declared IDs** (one consumer, `media.surface.desktop-archive`, is archived). These are **not 57 independently deployable services**, not necessarily 57 admitted ClosureSurfaces, and 57 × 4 is not automatically an obligation denominator.

1. Recompute all IDs from current tracked topology, source registry, manifest candidates, declared closure composition, physical ownership, generated PDP matrices, live consumers and archived sources. Identify the three physical-candidate delta entries against the frozen 54 roster by set difference, not by guessing names. Check all 57 unique names and any rows intentionally excluded by Lifecycle identity contract.
2. For each: classify PHYSICAL | LOGICAL_CONSUMER | SEMANTIC_COMPOSITION | ROOT; ACTIVE | SUPPORT/SUBSUMED | ARCHIVED; independently executable owner boundary; source applicability per PDP0–3; closure unit and parent/dependency edges; Build/Deliver/Enhance applicability. Require source-authorized N/A rationale; keep `UNKNOWN` explicit.
3. Repair source-owned mapping/generators/rosters through their rightful owner, emit a reconciled current population and audit whether the 54-row source matrices need **impacted three-row extension** rather than reopening 54 unchanged cells. Never bulk-edit status flags or change historical receipts. Verify source authority, duplicate IDs, absent members, dependency cycles and cross-parent sharing.
4. Recalculate all source obligation/case memberships (historical 4,028 + 2,336 + 436 + 1,864 = 8,664 candidates), prove every bound obligation/case/owner and direct composite invariant; do not multiply candidate counts by number of consumers or claim 8,664 independent executions.
5. Freeze exact git trees, material SHA-256, versioned method binding, selected phase, and source epochs. If a material source edit occurs, apply scoped impact invalidation; reuse prior current unaffected work. No caller-supplied source hash substitutes for Work Planner currentness or AP-03.

**Exit:** exact current source roster and Lifecycle-admitted closure-unit roster reconcile by stable IDs; all differences have authoritative dispositions; four source matrices/generator checks pass; no skipped active orphan, no invented N/A, no stale selected source. Record this reconciliation before selecting tasks.

## 2. Per-surface stage/phase state machine — full Product Development v3

**Discovery (stage `discovery`):** `pdp-0-product-truth` → `pdp-1-canonical-domain-data` → `pdp-2-design-language-interface-system` → `pdp-3-complete-product-experience`. At each applicable node evaluate source bytes/currentness, owner-selected direct criteria, zero phase-local definition tasks and applicable predecessor; source N/A must be authoritative. PDP-3 includes real Explorer, deterministic curated data, narrated/captioned source-tied recording per adopted edition. Explorer is not another PDP phase and does not prove real effects.

**Build (stage `build`):** `build-plan-implementation` → `build-implement` → `build-verify` → `build-development-complete`. Plan exit requires F/V/L/X exact tasks and source-dependent prerequisites, owner/work-planner KCRIT criteria; Implement exit requires working real product behavior; Verify exit requires actual positive, negative, replay, rights, QA and interface conformance. Development Complete requires zero unresolved mandatory development work **for the selected surface and its declared predecessors**, independently evaluated; never impose a global all-surface barrier if the admitted method/graph contains none. Keep impossible production-only rights claims separate from developmental negative proof; do not green a mandatory real positive using NOT_ADMITTED.

**Deliver (stage `deliver`):** `deliver-release` → `deliver-deliver` → `deliver-operate`. Per deployable leaf: signed/pinned artifact, SBOM/license/vulnerability/ABI, authorized real provider profile, qualifying tests, deployment plan with safe rollback, source/contract DB migration plan, live service/consumer probes, actual post-deploy receipts; then SLOs, paging, retention, supported platforms and incidents. Support libraries inherit release binding from their actual artifact and consumer, not fictional individual deployments. No user-goal declaration grants rights, remote credentials or production promotion.

**Enhance (stage `enhance`):** `enhance-measure-outcomes` → `enhance-learn` → `enhance-evolve`: collect privacy-safe actual quality/latency/cost/failure/outcome, test alternative provider/model/UX hypotheses, select improvements with explicit owner criteria and create a versioned impact-scoped re-entry. No unconditional regression or re-closing unaffected leaves.

**Independent native closure lane:** For every applicable admitted ClosureUnit, exact Lifecycle PhaseProgram phase names are `media.product-truth.definition-acceptance`, `media.canonical-domain-data.definition-acceptance`, `media.design-interface-system.definition-acceptance`, `media.complete-product-experience.definition-acceptance`. Progress an individual leaf through eligible successive phases as its own declared predecessors permit; compositions and root prove **direct cross-child meaning**, reference authenticated child receipts, and never copy their proofs. If current admission graph incorrectly imposes whole-repository barriers, fix it in Lifecycle with schema/negative/installed consumer tests, rather than bypass. Existing `DEV_COMPLETE` source cells are not native `CLOSED/CURRENT`.

## 3. Binding gtool operations and structured I/O

Run from a trusted Lifecycle checkout. Distinguish **read-only stock CLI** from the host-registered method reader, planner, implementer, executor, Evidence Generator and protected native admission; repository-local scripts cannot self-register trusted authority.

```bash
export MEDIA_ROOT=/absolute/path/to/ghatana-media
export LIFECYCLE_ROOT=/absolute/path/to/ghatana-lifecycle
cd "$LIFECYCLE_ROOT"
node tools/gtool/bin/gtool.mjs method inspect --definition tools/documentation-model/presets/methods/ghatana-product-development.v3.yaml --json
node tools/gtool/bin/gtool.mjs method progress --root "$MEDIA_ROOT" --json
node tools/gtool/bin/gtool.mjs provider health --capability proof-producer --json
node tools/gtool/bin/gtool.mjs closure validate --json
node tools/gtool/bin/gtool.mjs closure config check --root "$MEDIA_ROOT" --no-write --json

# Per subject: use a generated source-pinned, repo-contained selector configuration;
# exact schema/fingerprint are validated by Work Planner, not arbitrary prose.
node tools/gtool/bin/gtool.mjs method plan --subject '<CANONICAL_SURFACE_ID>' \
  --proof-mode SOURCE_STATUS --source-status-config '<ACTUAL_PINNED_SOURCE_STATUS_CONFIG>' --json

# These authenticated routes require real host registration; without it BLOCKED is correct.
node tools/gtool/bin/gtool.mjs method tasks --proof-mode AUTHENTICATED_OWNER_READBACK \
  --roster '<ACTUAL_OWNER_PINNED_ROSTER>' --node '<ACTUAL_METHOD_NODE_ID>' --json
node tools/gtool/bin/gtool.mjs method verify --subject '<CANONICAL_SURFACE_ID>' \
  --node '<ACTUAL_METHOD_NODE_ID>' --json
node tools/gtool/bin/gtool.mjs method evidence --request '<VALIDATED_OWNER_ACTION_REQUEST_JSON>' \
  --root "$MEDIA_ROOT" --json
```

For implementation assignment, use the authenticated `method run` route and `method run status/recover` with their exact installed `--help` signatures, owner/Implementer host adapters, bounded journal and stable idempotency keys. For actual stage transition use the authenticated `method execute` SDK/host or `gtool development transition --complete --input <validated-owner-transition.json>` only when selected method and owner have a supported target. **None of the read-only commands applies a stage or phase transition.** Reconcile `UNKNOWN_OUTCOME`/ambiguous dispatch by owner operation ID; never dispatch twice blindly.

Native phase proof, **only after AP-02/AP-03 + graph/case/proof authority**:

```bash
node tools/gtool/bin/gtool.mjs closure phase-projection \
  --repository-id '<ACTUAL_REPOSITORY_ID>' --program-id '<ACTUAL_PROGRAM_ID>' \
  --surface '<ACTUAL_ADMITTED_CLOSURE_SURFACE>' \
  --phase media.product-truth.definition-acceptance --selection-mode EXACT_UNIT --json
node tools/gtool/bin/gtool.mjs closure run-plan prepare \
  --unit-id '<EXACT_ADMITTED_CLOSURE_UNIT_ID>' --json
node tools/gtool/bin/gtool.mjs closure run --run-plan '<OWNER_RETURNED_RUNPLAN_REF>' --execute --json
# Only when native workflow explicitly requires and permits adoption:
node tools/gtool/bin/gtool.mjs closure adopt-native-receipt \
  --surface '<ACTUAL_ADMITTED_CLOSURE_SURFACE>' \
  --phase media.product-truth.definition-acceptance \
  --native-run-result '<UNCHANGED_AUTHENTIC_NATIVE_RESULT>' --json
```

Replace phase ID for PDP1–3 only when source-bound predecessor graph is admitted. Exact ClosureUnit ID comes from `closure graph/phase-projection` readback; do not construct it by naive string concatenation. Record input and output with stable `repositoryId,surfaceId,methodId,methodRevision,nodeId,phaseId,sourceEpoch,materialFingerprint,expectedOwnerRevision,decisionRef,ownerAction,idempotencyKey,proofStatus,resultRef,receiptRef,reasonCodes,resourceBudget`; these are **conceptual report fields**, not a new gtool schema or permission to inject unknown request properties. Use the actual versioned request/result schemas.

At every step emit separately: `sourceDefinitionStatus`, `engineeringTaskStatus`, `ownerTransitionStatus`, `nativeReceiptStatus`, `providerQualificationStatus`, `deliveryStatus`, `enhanceStatus`. Never infer one from another. Use exact selected surface/project readback, not a repository-wide check when only a leaf changed.

## 4. Immediate unblock and owner responsibilities (parallel, no blanket approval pauses)

1. **AP-02 (Lifecycle Evidence Contracts + trusted host):** issue actual owner-selected `ghatana.closure@1` and `ghatana.assurance@1` distribution DAG, all required material/contract/verifier/admission/revocation fields, register protected verifier in its owning host, test stale/revoked/wrong bytes/installed-consumer. Follow Lifecycle issue #24; signed selection and verifier readback—not a local JSON claim—are exit.
2. **AP-03 (Media source owner + Lifecycle Verification Planner host):** pin full tracked membership/archive SHA/current bytes, select source epoch, register authenticated source-snapshot verifier and Planner admission, test omitted files, symlinks, case collisions, revocation and mutation. Follow Lifecycle issue #25. No Git HEAD-only substitution.
3. **Case/proof graph (Media source/case owner, Lifecycle gtool):** map exact requirements/phase/physical owner/case/positive/negative oracle/observer/profile to the **reconciled** roster; L02/L03 candidates are not admitted. Prove one narrow real leaf PDP-0 ClosureUnit with qualified Evidence Generator, independent verdict and canonical receipt, then process eligible leaves in parallel, then direct composite/root meaning. Follow Media issue #20.
4. **Method v3 adoption (Lifecycle Documentation Model + Work Planner + Media):** bind actual Media source selectors/currentness/owner phase decisions for all active/archived/support subjects to v3 nodes and versioned PDP-3 demo recording v2; preserve source-only history and both old/new negative parity readbacks. Confirm v3 Build/Deliver/Enhance transitions in installed source-free consumer before selecting it as active Media method; no competing method authority.
5. **Cross-repo writer cutover (Media runtime + Ghatana old runtime owner):** keep `ghatana/services/media` comparison-only for code while old deployed runtime may still be current writer. Reconcile canonical Flyway V001–V016 with Media mirror V007–V009 collisions against *applied* DB history; back up/verify/dual-read parity, fence queues/leases, quiesce old writer, perform admitted additive migration and single-writer cutover, prove rollback and zero double dispatch. Never run competing writers against same DB.
6. **External rights/providers:** engineering authority is approved, but legally signed voices/biometric consent, proprietary model/recording rights, protected verifier/operator keys, independent labeled gold and external pager/host/test environments must be acquired through real holders. Where unavailable, keep that exact capability disabled and independently continue unrelated work; record concrete owner/input/ETA-unspecified missing prerequisite, not a fake PASS.

## 5. OCR cutover — single Document Intelligence authority

**Start in parallel with foundation work; every OCR consumer must be classified, migrated or retired.**

| Existing ID | Owned implementation and exact exit |
| --- | --- |
| OCR-C01 | All repos: source/current registration + call-site graph (Media, historical Ghatana Media, Kernel, Data Cloud, TutorPutor, GharBatai, Agents, AEP). Distinguish actual OCR execution/consumer from tests, helper names and disabled manifests. Every actual caller has one `DI_MIGRATED/RETIRED/REQUIRES_WORK` disposition. |
| OCR-D01 | Ghatana DI/Shared: independently build and install `@ghatana/document-intelligence-client@0.1.0`; resolve `@ghatana/document-extraction@0.1.0-SNAPSHOT` peer to a stable compatible owner-selected release/consumption profile; preserve frozen DI v1 `GET /v1/providers`, `POST /v1/parse`, generation-aware cancel; test real packed consumer and Python contract. |
| OCR-D02 | DI provider owner: pin and license internal PaddleOCR/Tesseract/other adapters by real corpus/language/MIME/ROI/source/quality/limits, use bounded isolated worker and truthful unavailable, cancel, timeout and crash outcomes. No unqualified fallback accepted as success. |
| OCR-M01 | Media TS: `libs/audio-video-client/src/authorized-scene-text.ts` verifies tenant/principal/purpose/version/digest/frame crop before constructing DI-only adapter; `scene-text-adapter.ts` maps DI lines/boxes to frame timestamp without a local recognizer; run `pnpm test:ocr-single-authority`, packed client, wrong tenant/ROI/cancel/DI outage. |
| OCR-M02 | Media Java Vision: `modules/vision/vision-service` passes selected source/version/frame/ROI/PTS via reviewed DI v1 Java/HTTP client; receives actual text/bounding polygons and models source/frame coordinate transforms; no Paddle/Tesseract dependency in Java Vision. Real installed worker test, source denial, cancel and duplicate prove VIS-09. |
| OCR-K01 | Kernel/product owners: live `ProductRuntimeFacets.OcrProvider`, `KernelOcrProviderAdapter`, materializer and product callers bind DI's public contract; source-free conformance and no alternate OCR registry/Media URL. |
| OCR-M03 | Media/Kernel owners: after consumers pass, delete `adapters/ocr-compat` implementations and unused Vision `OcrService`/`extractText` shims/registrations/Gradle imports. Preserve non-OCR vision features and historical evidence. Run negative grep + package/public ABI + consumer tests. |
| OCR-X01 | Cross-repo: one real source-authorized Media frame (ROI+PTS) and one actual document/PDF consumer through **same** DI gateway; DI offline keeps non-OCR Media jobs alive, Data Cloud offline never blocks Media, cancellation/revocation/restart and true source-relative geometry pass. Ghatana #252 owner readback remains separate. |

Failure policy: DI absent → only OCR-dependent operation `NOT_ADMITTED`/typed unavailable. Do not reactivate Media OCR or imply an open-rights model is qualified merely because a package installs.

## 6. Foundations first; existing 50 Build packages, not new identities

| Existing package | Implementation target and acceptance prerequisite |
| --- | --- |
| F00 | Reconcile all PDP capability→domain→P2→P3→code/owner/evidence links; 3,186 identity trace/8,667 source-bridge edges as historical bounded readback. Regenerate and check, exact diff/negative fixture. |
| F01 | Single canonical writer and migration/cutover as §4, exact old/new live ABI and rollback. |
| F02 | Java 27/Gradle, Node/pnpm, Rust/Cargo, native/OCI, installed Shared/Kernel/Ghatana/Tools ABI, pinned resource/runtime profile; no network-floating provider. |
| F03 | Canonical project/artifact/version/job/source clocks, strict typed outcomes/units/compare-and-set and stable JSON/Java/TS equivalence. |
| F04 | Shared identity/tenant/rights/purpose/consent/biometric and auditable policy decisions at every read/dispatch/retry/export/retention boundary. |
| F05 | Bounded upload/resume/chunk hash, source integrity, artifact versions, durable store/erasure and schema migration safety. |
| F06 | Durable worker leases/fencing, job/attempt/cancel/retry/UNKNOWN reconciliation, idempotent effects after host crash. |
| F07 | Transactional outbox/ledger and Event Plane public 201 append with consumer retries, eventual result finality and dedupe. |
| F08 | DI-only OCR, AI Inference/provider selection, STT/TTS/Vision qualified model/capabilities, license/region/latency/cost denial. |
| F09 | 27 HTTP/43 gRPC/SDK/CLI/agent/event public contract/source-free host semantic equivalence, versioning and errors. |
| F10 | Production GUI/embedded authenticated host + reusable a11y shell/component contract; individual 47 screen outcomes remain owned by V/L, Explorer remains static. |
| F11 | Rational clocks/frame/scene/codec, animation/model primitives, reproducible bounded render and real semantic validations. |
| F12 | Structured privacy-safe OTel/Prometheus, provider quality freshness, per-host performance, fault testing, documented quotas/load/monitoring. |
| F13 | ProductionSpec/Capture/Animation/Simulation typed deterministic compiler, neutral GharBatai recorder adapter, TutorPutor AEF public IR; only compiler substrate gate, not full solver or recorder terminal. |

**F-READY:** all common foundation prereqs necessary for the selected vertical actually work; freeze code-owner boundaries and true public ABI. Do not wait for every later foundation performance/real-licensing check before starting a vertical whose own bounded dependencies are ready. Do not promote incomplete F packages; keep exact remaining original tasks visible. Serialized writers for `launcher/`, canonical migrations, source manifests and generated contracts; independent leaves test in parallel on isolated inputs.

## 7. All 29 physical surfaces — exact engineering implementation matrix

Vector `PDP0/PDP1/PDP2/PDP3` transcribes the October 30 remainder-index **source applicability class**, not a fresh gtool verdict: A=applicable; S=support N/A candidate; R=referenced; H=headless contract; C=consumer contract; G=GUI; M=no implementation admitted; N/A=source not applicable; S*=support/tooling; H*=host-dependent experience. Recompute and owner-review per §1. Every listed physical row also requires the applicable Build/Deliver/Enhance stages of §2, source-selected owner tasks, tests, documented public surface, and separate phase/native proof.

| Physical identity | Code owner directory | P0/P1/P2/P3 | Existing local work | What, where, how and acceptance focus |
| --- | --- | --- | --- | --- |
| `media.physical.adapters-agent-tools-media` | `adapters/agent-tools-media` | S/R/N/A/S* | AT-01…06 | Validate four agent tool handlers and exact Tools/Action Plane delegation; bounded schema, signed context, real job/result/finality, denial/retry; no generic agent executor. |
| `media.physical.adapters-data-cloud-media` | `adapters/data-cloud-media` | A/R/H/C | DC-01…06 | Publish optional redacted tenant/version-bound provenance, transcript and geometry projections via installed Data Cloud public API; source owner remains Media; Data Cloud outage must not block Media. |
| `media.physical.adapters-ledger` | `adapters/ledger` | S/R/N/A/S* | LD-01…05 | Bind immutable job/attempt/delivery/quality events to canonical RunLedger, redaction and idempotency; prohibit second outcome authority. |
| `media.physical.adapters-ocr-compat` | `adapters/ocr-compat` | S/R/N/A/S* | OC-01…04 | After DI installed client, Java Vision and Kernel replacements pass, delete active legacy OCR providers/registrations/shims and remove unused module; keep historical evidence only. |
| `media.physical.apps-media-experience-explorer` | `apps/media-experience-explorer` | M/R/G/S* | Wave 1/2; F/V/X | Keep fixture-only PDP-3 source experience; repair navigation, all 47 screen contracts, 30 journey fixtures, narration/captions/recording source and accessibility without backend execution. |
| `media.physical.audio-video-observability` | `audio-video-observability` | A/A/N/A/C | Wave 1/2; F/V/X | Accept source-bound real runtime gauges, traces, redacted cardinality, provider-quality freshness, capacity, alerts firing/resolving and owned receiver; no green from NaN quality. |
| `media.physical.integration-tests` | `integration-tests` | S/R/N/A/S* | IT-01…06 | One bounded real Postgres/object-store/queue/process harness, live client equivalence, crash/rollback, versioned source/finality/rights; reuse proved Compose 9/9 results. |
| `media.physical.launcher` | `launcher` | A/A/H/C | Wave 1/2; F/V/X | One canonical runtime dispatch/writer/worker lifecycle, route versions, work leases, job finality, cancellation, provider policy; cut over only after migrations and parity. |
| `media.physical.libs-audio-video-client` | `libs/audio-video-client` | A/A/H/C | SK-01…08 | Complete source-free packed TS SDK and CLI, normalized errors/cursors/retry, DI-only authorized-scene-text, recorder/capture APIs, REST parity and negative tests. |
| `media.physical.libs-audio-video-types` | `libs/audio-video-types` | A/A/H/C | TY-01…06 | Strict canonical JSON/TS/Java time/version/rights/outcome schemas, all source operations and declarative production specs; reject overflow/unknown fields. |
| `media.physical.libs-audio-video-ui` | `libs/audio-video-ui` | A/A/G/C | Wave 1/2; F/V/X | Qualified reusable Studio/video/audio/caption/project/timeline components inside a real authenticated production host; 47 real-screen behavior owned by journeys, not Explorer. |
| `media.physical.libs-common` | `libs/common` | S/R/N/A/S* | JC-01…04 | Transport, TLS, tenant context and resource bounds; consume existing Shared public contracts; move duplicate logic to owning reusable module. |
| `media.physical.libs-java-common` | `libs/java/common` | S/R/N/A/S* | MC-01…05 | Codec/DSP/media engine helpers, checked dimensions/timestamps, safe native/FFI lifecycle, published SPI/ABI; retain verified Rust resampler behavior. |
| `media.physical.libs-media-experience-simulation` | `libs/media-experience-simulation` | S/R/N/A/S* | Wave 1/2; F/V/X | Deterministic PDP-3 curated fixtures and replay only; no solver/model/runtime correctness claim; all needed scenario coverage and recording automation. |
| `media.physical.modules-audio-streaming` | `modules/audio-streaming` | M/R/H/C | AS-01…07 | Real admitted audio streaming sessions: framing, PCM/Opus clock/lease/backpressure/ACK/cancel, rights at every step, WebRTC/adaptive transport semantics and measured 1/16/64. |
| `media.physical.modules-infrastructure-cache` | `modules/infrastructure/cache` | S/R/N/A/S* | CA-01…05 | Cache is non-authoritative: bounded TTL/size/keys, no stale consent/tenant leakage, cancellation/revision invalidation, Redis failure and restart tests. |
| `media.physical.modules-infrastructure-messaging` | `modules/infrastructure/messaging` | S/R/N/A/S* | Wave 1/2; F/V/X | Transactional outbox and Event Plane 201 acceptance, idempotent consumers, exact completion semantics and replay/UNKNOWN; optional external transport. |
| `media.physical.modules-infrastructure-persistence` | `modules/infrastructure/persistence` | A/A/N/A/C | IP-01…07 | Collapse duplicate JPA DAL to canonical provider store, tenant/version predicates, bounded executors, CAS, transcript and artifact currentness, migration proof. |
| `media.physical.modules-infrastructure-security` | `modules/infrastructure/security` | A/A/N/A/C | Wave 1/2; F/V/X | Shared-auth integration, purpose/consent/revocation and source provenance before dispatch and reuse, tenant/data minimization, denial and expiry tests. |
| `media.physical.modules-integration-tests` | `modules/integration-tests` | S/R/N/A/S* | CT-01…05 | Public HTTP 27/gRPC 43/tools/CLI/SDK semantic matrices, auth/rights/errors/recovery, cross-language parity and scoped test runner. |
| `media.physical.modules-intelligence-ai-voice-libs-ai-voice-ui-react` | `modules/intelligence/ai-voice/libs/ai-voice-ui-react` | A/A/G/H* | Wave 1/2; F/V/X | Accessible real host UI for lawful voice selection, purpose, consent, preview, denied/unknown states and real TTS playback, no synthetic success. |
| `media.physical.modules-intelligence-multimodal-service` | `modules/intelligence/multimodal-service` | A/A/H/C | Wave 1/2; F/V/X | Genuine child STT/Vision receipts and source clocks, grounded association, per-op finality, persisted causal references, Data Cloud optional. |
| `media.physical.modules-intelligence-speech-libs-speech-audio-rust` | `modules/intelligence/speech/libs/speech-audio-rust` | A/A/N/A/C | RS-01…07 | Retain known-good Blackman windowed-sinc, sample/timestamp/bit-depth/overflow boundaries, FFI ABI, measured bounded throughput. |
| `media.physical.modules-speech-stt-service` | `modules/speech/stt-service` | A/A/H/C | Wave 1/2; F/V/X | Authorized real WAV/FLAC/streaming STT with pinned Whisper/qualified alternative, language+WER/CER, diarization and timestamps, durable transcript/CAS. |
| `media.physical.modules-speech-tts-service` | `modules/speech/tts-service` | A/A/H/C | Wave 1/2; F/V/X | Lawful qualified voice/model, real decoded audio/SSML/phonemes/prosody, stream cancel/restart, clone-deny without consent, playable output receipts. |
| `media.physical.modules-video-streaming` | `modules/video-streaming` | M/R/H/C | VS-01…07 | Correct VFR/PTS/keyframe/lease/reconnect and WebRTC/HLS/DASH/adaptive profiles with no false finality or duplicate session delivery. |
| `media.physical.modules-vision-vision-service` | `modules/vision/vision-service` | A/A/H/C | Wave 1/2; F/V/X | Source-authorized real video/image model, exact ROI/EXIF/rotation inverse geometry, OCI isolation, frame tracking; OCR only through DI public gateway. |
| `media.physical.providers-aws-postgresql` | `providers/aws-postgresql` | A/A/N/A/H* | Wave 1/2; F/V/X | Reconcile canonical V001–V016 vs mirror conflicting V007–V009 using real applied history, additive migration/rollback and single writer; no dual DB writes. |
| `media.physical.runtime-contracts` | `runtime-contracts` | A/A/H/C | Wave 1/2; F/V/X | Canonical Media REST/proto/domain/status/command schemas; DI only for OCR; deterministic public compatibility and generated client parity. |

### Wave 2 areas not re-evaluated by the backend remainder census

The `PREVIOUS_WAVES_NOT_REEVALUATED` class (launcher, security, messaging, observability, speech STT/TTS, Vision, Multimodal, AWS PostgreSQL, runtime contracts) is **not completion**; preserve last accepted original IDs, inspect only impacted source/code, qualify the remaining R8 rows using full original criteria. Do not silently drop these physical rows because the W3 index focuses on 15 additional backend/support areas.

### Required non-backend handoff

The Explorer, main UI library, voice React UI and curated fixture simulation package are **four physical areas intentionally excluded from the backend-only 88 tasks**. They must receive separate GUI/Explorer/recording/host build packages and per-surface gtool evaluations; otherwise backend-green is never whole-product-green.

## 8. All 21 logical consumers — independently accounted for, no invented physical executable

These are consumer surface contracts, not independently deployable packages unless an admitted manifest/path/host is materialized. All applicable source PDP and Build outcomes are independently evaluated through the source-owned logical identity; release/delivery inherits actual owning artifact/host. Archived remains explicit N/A with authority.

| Logical surface | Current binding class | Physical implementations | Exact outcome and acceptance |
| --- | --- | --- | --- |
| `media.surface.web` | HOST_DEPENDENT | `libs-audio-video-ui` | Create/qualify separate production web host; real 47-screen routes, auth+accessibility, every source-defined action and outcome. Explorer cannot be promoted. |
| `media.surface.embedded` | HOST_DEPENDENT | `libs-audio-video-ui` | Sandboxed embed origin/auth/CSP/capability controls; player events, fallback, sizing and safe proof of user-facing real state. |
| `media.surface.public-http` | HOST_DEPENDENT | `launcher`, `runtime-contracts` | Prove all 27 source HTTP operations, exact schemas, auth/tenant/error/timeout/idempotency, source-free live client and status parity. |
| `media.surface.service-grpc` | CONTRACT_ONLY | `runtime-contracts`, `modules-speech-stt-service`, `modules-speech-tts-service`, `modules-vision-vision-service`, `modules-intelligence-multimodal-service` | Prove 43 public RPCs through actual service implementation, mTLS, cancellation, quotas, typed unavailability, source-free protobuf. |
| `media.surface.grpc.stt` | CONTRACT_ONLY | `modules-speech-stt-service` | Real STT RPCs/stream, transcript/finality, denial/quality and sample-clock proof. |
| `media.surface.grpc.tts` | CONTRACT_ONLY | `modules-speech-tts-service` | Real TTS RPCs/stream, qualified voice, playable bytes, auth/cancel. |
| `media.surface.grpc.vision` | CONTRACT_ONLY | `modules-vision-vision-service` | Vision RPC/ROI/PTS/native bounds plus DI-only OCR delegation; rights/negative tests. |
| `media.surface.grpc.multimodal` | CONTRACT_ONLY | `modules-intelligence-multimodal-service` | Real child receipt and correlated result RPC, timeout/partial/UNKNOWN recovery. |
| `media.surface.sdk` | PHYSICAL | `libs-audio-video-client`, `libs-audio-video-types` | Packed installed client with exact cross-channel outcomes, source/permission enforcement and DI client peer resolution. |
| `media.surface.cli` | HOST_DEPENDENT | `libs-audio-video-client`, `libs-media-experience-simulation` | Source-bound plan/execute/show/cancel/recorder commands, deterministic JSON and exit semantics, real job outcomes. |
| `media.surface.agent-tools` | CONTRACT_ONLY | `runtime-contracts`, `adapters-agent-tools-media` | Four canonical handlers, role-limited Action Plane delegation and actual job readback; no fabricated fifth public handler. |
| `media.surface.events` | CONTRACT_ONLY | `modules-infrastructure-messaging`, `runtime-contracts` | Emit immutable outbox events with owner-controlled schema/ACL, consumer replay/dedupe and true finality distinction. |
| `media.surface.integrations` | HOST_DEPENDENT | `adapters-data-cloud-media`, `adapters-ledger`, `modules-infrastructure-cache`, `modules-infrastructure-messaging`, `modules-infrastructure-persistence`, `modules-infrastructure-security`, `providers-aws-postgresql` | DI, Data Cloud, Event Plane, Action Plane, Kernel, Agents, products public-only ABI; optional external service failure isolation. |
| `media.surface.types-library` | PHYSICAL | `libs-audio-video-types` | Publish correct strict type/validator package and source-free Java/TS/JSON conformance. |
| `media.surface.ui-library` | HOST_DEPENDENT | `libs-audio-video-ui`, `modules-intelligence-ai-voice-libs-ai-voice-ui-react` | Accessible packed Studio/voice/player/project widgets in production host; keyboard/contrast/reflow/translation. |
| `media.surface.explorer` | PHYSICAL | `apps-media-experience-explorer`, `libs-media-experience-simulation` | Static source-driven 30-journey/47-screen PDP experience; capture nominated narrated scenarios, record truth-label EXPLORER_SIMULATED. |
| `media.surface.desktop-archive` | ARCHIVED | No active physical | Preserve owner-approved NOT_ACTIVE_ARCHIVED history; no fake implementation or delivery; reintroduce only through new edition/admission. |
| `media.surface.recorder-orchestrator` | HOST_DEPENDENT | `libs-audio-video-client`, `libs-media-experience-simulation` | Config-driven unattended scenario-run, capture/retry/selective recapture, provenance, narration/caption synchronization and audit. |
| `media.surface.capture-adapters` | CONTRACT_ONLY | `runtime-contracts` | Browser/desktop/mobile/terminal/API/gRPC/camera/file adapters with explicit rights, timebase, permissions, source digest and bounded capture. |
| `media.surface.production-studio` | HOST_DEPENDENT | `libs-audio-video-ui` | Real professional timeline/asset/version editing, compositing/FX/audio/caption/export, undo/redo and revision/effect proof. |
| `media.surface.interactive-demo-player` | HOST_DEPENDENT | `libs-audio-video-ui` | Interactive, sandboxed, state-aware player with branches/captions/a11y/analytics; simulated vs real evidence labels. |

**Special admission rule:** the four source-added Recorder/Studio/Player surfaces require physical build bindings and host/packaged consumer where genuinely executable; do not pass them as complete merely because the logical contract exists. Materialize new physical surfaces through topology/source admission (not new phantom IDs), or bind exact existing implementation owners and prove their true runnable package.

## 9. Seven composition/root surfaces — distinct direct outcome proof

| Composition | Kind | Direct members | Native and cross-child acceptance |
| --- | --- | --- | --- |
| `media.composition.repository-root` | REPOSITORY_ROOT | 16 direct members | Verify canonical member/edge/source denominator and aggregate outcome only after independently admitted children. |
| `media.composition.ingestion-and-versioned-artifacts` | SEMANTIC_COMPOSITION | 8 direct members | Prove authored direct cross-child invariant, failures, and its own assertion, not copies of leaves. |
| `media.composition.governed-job-execution` | SEMANTIC_COMPOSITION | 6 direct members | Prove authored direct cross-child invariant, failures, and its own assertion, not copies of leaves. |
| `media.composition.speech-and-caption-workflows` | SEMANTIC_COMPOSITION | 4 direct members | Prove authored direct cross-child invariant, failures, and its own assertion, not copies of leaves. |
| `media.composition.vision-and-multimodal-analysis` | SEMANTIC_COMPOSITION | 4 direct members | Prove authored direct cross-child invariant, failures, and its own assertion, not copies of leaves. |
| `media.composition.creation-composition-and-delivery` | SEMANTIC_COMPOSITION | 7 direct members | Prove authored direct cross-child invariant, failures, and its own assertion, not copies of leaves. |
| `media.composition.client-and-machine-interfaces` | SEMANTIC_COMPOSITION | 9 direct members | Prove authored direct cross-child invariant, failures, and its own assertion, not copies of leaves. |

Compositions can share a physical child; count unique memberships exactly and perform **only direct integration checks** at the composition, not repeated leaf tests. A parent reference to a closed current child is a receipt edge, not copied evidence. Root requires complete source/physical/consumer/intended outcome denominator, no outstanding mandatory direct obligation, and truthful blocked N/A/unknown report.

## 10. Thirty verticals — one real terminal business outcome each

Use existing exact V01–V30 package details and PDP-3 journey contracts. Each vertical owns its feature-specific service implementation, 47-screen subsets, channels, actual effect/error/restart/version tests, source-only demonstration and separate live-product recording. Work critical path first: **V01/J01 → V02/J02 → V20/J20 → V03/J03**, obtaining a real corrected-captions business terminal; capture it as soon as genuinely operational. Continue independent non-blocked verticals without waiting for unrelated models.

| Existing package / journey | Product terminal | Acceptance for its stage-specific verification |
| --- | --- | --- |
| `V01` · J-01 | First use, authentication, context, and project creation | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V02` · J-02 | Upload/import, inspect, and produce a usable artifact | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V03` · J-03 | Audio/video transcription through corrected captions | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V04` · J-04 | Authorized text-to-speech to approved audio | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V05` · J-05 | Image/video analysis, geometry, and tracks | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V06` · J-06 | Multimodal or document consumer request to grounded typed result | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V07` · J-07 | Noisy/clipped interview cleanup with preservation and comparison | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V08` · J-08 | Low-quality video repair with measured comparison | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V09` · J-09 | Prompt/brief to storyboard, composition, render, review, and delivery | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V10` · J-10 | Controlled generation with references and continuity review | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V11` · J-11 | Region mask/tracking edit with comparison and undo | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V12` · J-12 | Deterministic 2D/vector/procedural animation | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V13` · J-13 | 3D character, rig, path, or control animation | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V14` · J-14 | Explore a domain simulation and its measurements | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V15` · J-15 | Simulation/procedural passes with protected semantic validation | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V16` · J-16 | Existing-video translation/dubbing and voice/timing review | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V17` · J-17 | Music, effects, Foley, stems, mix, and mastering | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V18` · J-18 | Compose clips, captions, exact graphics, color, and audio master | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V19` · J-19 | Review media quality and improve it within declared limits | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V20` · J-20 | Observe a long-running job and check its outcome | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V21` · J-21 | Review/comment/approve exact version and re-review changed material | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V22` · J-22 | Export/download/publish with destination acknowledgement | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V23` · J-23 | Private/local workflow while disconnected and reconnect | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V24` · J-24 | CLI batch/JSON plan through verified outputs | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V25` · J-25 | Agent or product integration with bounded delegated Media action | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V26` · J-26 | Delete/revoke/retention/hold and visible lifecycle | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V27` · J-27 | Continue safely when processing is unavailable | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V28` · J-28 | Spatial/360/interactive/synthetic-data export to declared consumer | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V29` · J-29 | Live session loss, consent change, and bounded recovery | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |
| `V30` · J-30 | Check which processing options are eligible | Source-bound real positive + denial + failure/restart + immutable result; matching PDP-3 simulated/real recording IDs and channel/UI parity. |

**Strong additional obligations:** V12–V15 must run deterministic 2D/3D animation and executable numerical/physical/domain simulation with validated units, convergence, scenario replay, instrument state and authoritative scientific owner where required; a curated Explorer fixture is never solver acceptance. V16–V19 require lawful assets, real audible/visible media and measured fidelity; V21/V22 require exact approvals and destination acknowledgements; V23/V26/V27/V29 require offline/erasure/failure/rights-change recovery; V28 requires specified spatial metadata and actual consumer; V30 uses live provider catalog, quality freshness and rights to report eligibility.

**Recording edition:** current `.product-experience/pdp-3-product-experience/demo-recording-standard.yaml` explicitly selects a single current-edition J03 source-only narrated recording and defers 26 richer scenario seeds; it is **not evidence that all 30 are already recorded**. Preserve J03's source-current result; adopt a versioned subsequent PDP-3 edition requiring a narrated, captioned, replayable **source-static** recording for every demoable journey (or authoritative reason why no visual demonstration applies), with qualified source ownership and tests. Bind Documentation Model v3 recording source v2 without retroactively marking old recordings accepted. Build later captures the **same semantic scenario** against actual product state and exact business receipts. Compare action/terminal equivalence, source/artifact/version/rights, distinguish `EXPLORER_SIMULATED` from `LIVE_PRODUCT_VERIFIED`. No external film publication before rights/voice approval.

## 11. Recorder/Studio/Player and integration packages

- **L01** Recorder Orchestrator: qualify neutral `@ghatana/experience-recorder` dependency, deterministic data-driven scenario compiler, browser/desktop/mobile/terminal/API/gRPC/camera/file capture permissions, sync narration+captions+screen, recapture changed scenes only, selectable editor handoff, exact source/run/failure/cleanup receipts.
- **L02** Production Studio: separate production host, real timeline tracks, immutable revisions, crop/mask/FX, compositing, keyframes, subtitle/audio editing, preview/effects equivalence, undo/redo persistence, render/export and WCAG responsive controls; source-only Explorer never passes real Studio.
- **L03** Interactive Demo Player: versioned scenario/branch state, seek/captions, source-aware media and real/simulated truth labels, sandboxed embed, privacy, accessibility, offline/fallback, strict origin/rights and telemetry boundedness.
- **X01** Contract parity: verify all active APIs/RPCs/CLI/tools/events/SDK/UI against source P1/P2/P3, installed public artifacts and original consumer expectations.
- **X02** Whole-product faults/rights/accessibility/security/load: actual provider and host availability, privileged denial, predictable resource/storage use, erased data/hold, network partition, performance profiles, real notified receiver and stable currentness.
- **X03** Development Complete: per-applicable-surface exact F/V/L/X task closure, real full-business outcome and original acceptance evidence; Work Planner authorizes stage only when its own guards pass. Native PDP closure and Deliver remain independent.

## 12. Finish 36 R8 + 96 W3/H and 17 owner qualification packages

Keep 132 distinct original engineering IDs; no new alias task registry. Preserve 22 already verified Wave 2 rows unless impact reopens them. `Q00` pins and classifies source/test/proof per task; `Q01` legal source/model/voice rights; `Q02–Q06` true STT corpus/model, lawful TTS, real Vision and Multimodal; `Q07–Q08` full streaming transports and actual 1/16/64 capacity; `Q09` Data Cloud/Action/Event public parity; `Q10` DI OCR; `Q11` real provider quality/alert receiver; `Q12` performance/recovery; `Q13` real cross-service integration including previously disabled AEP cases; `Q14` real product host/dual-mode film; `Q15` independent 132-row original-whole-task acceptance; `Q16` Lifecycle, Kernel, delivery and release handoff.

**Hard no-orphan requirements:** five currently unadmitted stream capabilities WebRTC, adaptive HTTP, HLS, DASH, lease renewal; no fake frames/recognition/audio, all required source-defined positive modes must be real. Independently accept genuine pinned native OCI, real model WER/CER/mAP/voice quality, fps/latency/capacity, backend persistence and 32 disabled Action Plane cases where still applicable. Use actual missing rights/corpus/model/profile to scope a precise external-gated row rather than mark incomplete as complete.

## 13. Parallel work batches, critical path and resource discipline

- **Batch A — authority and topology (parallel):** exact 57/54 roster reconciliation; method v3 owner binding; AP-02/AP-03 protected host provisioning; source-case L02/L03 graph; OCR-C01; Q00. Owner writes are single-serialized per authority material.
- **Batch B — external integration + foundations:** OCR-D01/D02, Media TS/Java/Kernel consumers; F00–F09 and F11–F13 current technical prerequisites; canonical writer/DB cutover in fenced isolated lane; native first PDP0 leaf after real host admission. Retain user-reported verified source and avoid blanket reruns.
- **Batch C — early demonstrable vertical:** F10 real product shell, V01/V02/V20/V03, L01 source-only recapture and dual-mode first real recording after true J03 terminal, source DI frame and PDF positive, no inference from fixtures.
- **Batch D — independent vertical lanes:** V04–V30 in clusters (speech/vision/multimodal; render/generate/compose; simulation/animation; admin/retention/integrations; streaming). Enforce disjoint file ownership and module-specific focus tests; only block dependencies actually used.
- **Batch E — nonbackend and consumer parity:** all 47 product screens, real recorder/studio/player, 21 consumer surfaces (archive disposition), X01/X02, 36 R8 & 96 W3/H whole-row real positives and independent acceptance; recording edition v2 source work.
- **Batch F — source/phase and stage convergence:** gtool per-leaf/source-eligible method progression; independent native PDP phase receipts per admitted graph, composite direct obligations, root truth; X03 Build Development Complete; Deliver release/deploy/operate only on real host/protected authorizations.
- **Batch G — Enhance:** actual usage/quality/cost/latency and privacy-safe outcome baselines, investigate alternatives, record evolution proposals and versioned scoped re-entry. This is a planned future stage, never falsely reported as already operational.

**Efficiency:** read/calculate each source fingerprint once per impacted material; single content-addressed CAS with dedupe/retention; tmpdirs and bounded fixture clips/frames; avoid unbounded Docker/Gradle/Cargo evidence duplication, multi-GB model corpus pulls, repeated previously closed leaf testing, hidden full-workspace scans, and owner proof retries after UNKNOWN. Run tests on changed packages plus contract/consumer dependency cone; pin independent high-resource host tests to digest and re-run only on host/profile/material change. Separate disk, CPU/memory and network budgets in actual versioned gtool task inputs.

## 14. Reproducible validation before acceptance

```bash
cd "$MEDIA_ROOT"
pnpm run test:physical-topology
pnpm run check:build-contract-bridge
pnpm run check:build-bridge-blockers
pnpm run check:build-work-packages
pnpm run check:build-plan-task-closure
pnpm run check:gtool-owner-dispositions
pnpm run check:gtool-execution-queue
pnpm run check:lifecycle-closure-inputs
pnpm run test:gtool-closure-source
pnpm run audit:gtool-closure-source
pnpm run test:pdp3-recording-source
pnpm run test:ocr-single-authority
pnpm run test:backend-remaining-surfaces-plan
pnpm run test:backend-terminal-qualification
pnpm run test:media-core-independence
```

Use tested affected Gradle/Cargo/Node selectors and actual JUnit XML, Java 27/container/model profile, installed DI/Shared/Kernel/Tools/Media public package tests, full orig R8 oracle and legal documents as needed. Generator `--check` verifies outputs without silently replacing owner authority. Run actual host-integrated Lifecycle `method plan/tasks/verify/evidence/run/execute/phase-projection/closure run` with typed readback for selected unit. If tool lacks a trusted owner host, `BLOCKED/UNKNOWN` is a correct non-admitted result, not permission to create a local bypass.

For every subject/phase/stage write a **derived, regenerable report**: source pins, applicable vs N/A with decisionRef, owner/implementer, original task IDs, exact tests positive/negative/recovery, real model/provider/host identity, source-current readback, allowed effect, invocation/result digest, owner review and disposition, actual native receipt if admitted, and outstanding reason. Reports are observations, not status writers. One `CLOSED/CURRENT` receipt per authentic native unit/phase; one `DEV_COMPLETE` owner decision per eligible method node. Do not duplicate evidence for other phases without their own semantic bindings.

## 15. Exact exit criteria / what counts as no work left

1. **Roster:** every current physical, logical, composition, root, archive identity accounted for, with current source topology and no ghost or unbound active surface; no stale 54/57 counting.
2. **Discovery:** applicable source-current PDP0–3 owner statuses and adopted narrated PDP-3 edition source obligations complete; no automatic retroactive requalification.
3. **Build:** all 50 canonical packages fully accounted for (F00–F13, V01–V30, L01–L03, X01–X03), every source-defined capability and per-channel contract mapped to an actual effect or an explicit authorized nonapplicability; 36 R8 and 96 W3/H rows individually accepted with original oracles; real OCR only DI.
4. **Cross-repo:** DI client + Shared peer installed, Java/TS/Kernel/product callers migrated, old Media OCR registry deleted, Data Cloud optional, Event/Action Plane API and writer/DB semantics proven.
5. **Product:** 30 actual journey terminals, all 47 GUI screen behaviors, 27 HTTP, 43 gRPC, 4 agent and CLI/SDK/event/embedded channels; first source and real dual-mode recording, subsequent full chosen edition; real simulation/animation/render and recovery.
6. **Native:** all applicable admitted units obtain real phase-specific verified receipts after AP-02/AP-03, executable cases, independent verdict, and exact source/currentness/contract checks; valid owner-backed support/N/A/archive members accounted, comps/root have direct proofs.
7. **Deliver:** release artifacts, real host/providering/profile rights, deployment/rollback, operational SLOs/alerts/retention and consumer acceptance. If rights/independent authority are unavailable, surface remains truthfully BLOCKED; engineering alone cannot claim release.
8. **Enhance:** real monitored outcomes, prioritized learning, versioned approved evolution and scoped re-entry. A product cannot claim a stage's future operational measurements before operating.
9. **Final reconciliation:** regenerated differences among original task IDs, source requirements, physical/logical registry, coverage and tests yield **zero unowned required row, zero unclassified blocker, zero unqualified claim**, all untouched prior receipts current, and no legacy alternate OCR implementation. New findings create linked tasks in their canonical owner ledger, never vanish.

## 16. Immediate implementer handoff

**First run:** read current commit/method IDs; compute exact inventory delta; repair 54/57 application/closure crosswalk; kick off real AP-02/AP-03 host provisioning and DI public peer qualification in parallel; run source hygiene/check commands; select smallest admissible PDP0 leaf with real cases/independent oracle; start F/first J01–J03 feature path and preserve already-green code. Do not ask for another routine implementation approval. Return machine-readable task/surface/stage/phase actions with the precise missing external inputs and credible evidence, then dispatch disjoint bounded work packages. No forced global stop because another leaf remains blocked.

This runbook is a *cross-stage scheduler/traceability handoff*. Existing source files remain the single authorities for product definition, package/task identity, gtool method, proof, native receipt, live provider, and owner decision.
