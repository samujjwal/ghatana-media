# Ghatana Media — surface development implementation plan

**Purpose:** Ship complete, correct, tested and documented Media capabilities and a clean, intent-named repository. This is the **active implementation-only engineering plan**, not a status/approval/closure document.

**Source reviewed:** `samujjwal/ghatana-media` remote `main@e3847ab80c61d6088528319a1293e6464c6e6298` (2026-11-04). This review inspected the current repository tree, source-owned surface roster, authored product definitions, existing plans and selected executable code. No Gradle, pnpm, Rust, browser, container, inference or host tests were executed as part of this review; prior test reports are not reclassified as independent new passes. Reconcile any changes after this source cut before execution.

## 1. Scope, invariants and source of truth

- **In scope:** functionality, algorithms, public APIs, typed domain contracts, security/rights logic, persistence, integrations, clients, accessibility, runtime behavior, code quality, test completeness, performance tests, maintainable per-surface engineering documentation, repository hygiene and compatibility-preserving refactors.
- **Out of scope:** gtool, lifecycle stage/phase execution, setup for closure, receipts, evidence recording, convergence, protected verification, release admission and production cutover approval. Keep source definitions in `.product-experience/` as the semantic requirements; do not mutate formal status to make code appear complete.
- **Exact coverage dimensions:** 28 registered physical sources, 21 logical surfaces and seven compositions (including root); 30 authored end-to-end journeys; 47 defined screens; current proposal inventory of 30 HTTP operations and 44 gRPC RPCs. These are related but **not additive** feature counts. Support/subsumed nodes need their real code and tests, not separate deployment. The archived desktop is not active.
- **Preserve immutable semantic and public identities.** Do not rename published routes, protobufs, stable contracts, database migration versions, capability IDs, journey IDs or the historical `audio-video` package names without consumer-compatible migration. New **internal** names should express intent and ownership, not wave/batch/session/phase/reviewer context.
- **Single owner per semantic concern:** Media owns artifacts, revisions, jobs, streaming, frame/clock identity, media transformation and presentation. Ghatana Document Intelligence alone owns generic OCR execution, models and public OCR gateway; Media is its authorized, time/ROI-aware client. Data Cloud is an optional read-model/metadata consumer, not a mandatory job writer or OCR dependency. Reuse Shared and other ecosystem owners only through supported public contracts.
- **Real behavior over simulated success:** A live API must either perform the declared effect, delegate to its qualified public owner, or return an accurate typed refusal/unknown. Unadmitted model, unavailable adapter or missing rights cannot silently yield synthetic audio, fake pixels, fabricated analysis, guessed confidence or a successful job.
- **Current-source rule:** Existing tests and code are starting assets, not assumptions of readiness. When inspection proves a requirement fully covered, record that in the normal implementation task list and do not reimplement it.

## 2. Confirmed source issues and priority decisions

1. `libs/audio-video-client/src/recorder-orchestrator.ts` is explicitly dry-run by default. `capture-adapters.ts` defines admission and defaults to `NOT_ADMITTED`. Finish genuine trusted capture, not another planner.
2. `libs/java/common/.../AnimationSpecCompiler.java` creates a reference plan but explicitly reports `ANIMATION_RENDERER_NOT_ADMITTED`. The actual 2D/3D rendering and simulation pipeline remains a required implementation outcome.
3. `libs/audio-video-ui/src/screens/MediaProductRenderer.tsx` implements four presentation families while other declared screens can be fixture/contract previews. Implement genuine hosted workflows and truthfully separate Explorer.
4. `adapters/agent-tools-media/README.md` describes four typed handlers that currently refuse before provider dispatch. Finish authorized real handler delegation and negative tests.
5. `modules/infrastructure/security/MediaProcessingSecurityValidator.java` currently requires actual authenticated authority for permission evaluation; don't weaken that guard to accept caller metadata.
6. The existing large backend code and tests (including caption V029, runtime job replay, real OCI worker, Whisper/Piper candidates and multimodal executor) must be extended rather than copied or restarted from scratch.
7. The source tree has test-only/atypical paths `modules/audio-processing`, `modules/video-processing`, `modules/format-compatibility`, `modules/session-management`, root `src/`, `modules/common` and `api/grpc-consumer`. Verify which are live build targets, then merge into an actual owner or remove after consumer-safe relocation.
8. The active repository is documentation-heavy: `docs/implementation/` contains 1,178 tracked files totaling about 995 MB uncompressed, including repeated 8–19 MB JSON readbacks, historical logs and demonstration movies; `archive/` contains 180 files. These bytes are not all live documentation and cannot be blindly deleted.
9. Keep model, voice, biometric, provider, and sample rights as explicit implementation inputs. The active STT candidate concerns English/Nepali, with Hindi and FLEURS currently deferred per the existing owner note. Missing lawful inputs do **not** authorize a made-up real-output test or a false development-complete result.

## 3. Complete means executable, not a document label

For **every applicable active** physical or logical surface:

1. **Meaning/coverage:** map every applicable authored capability leaf, operation, state transition, UI action and journey to its implementation owner, delegate or semantically approved exclusion. Check the entire source inventory (including the large `capabilities.yaml`), not just the 30 journeys.
2. **Behavior:** implement a bounded, deterministic contract with real positive effects where promised, full validation, source/tenant/version/time binding, rights, typed error and UNKNOWN semantics, retry/cancel/timeout/restart behavior, and no shadow authority.
3. **Public boundary:** verify runtime implementation and compatibility for each public HTTP/gRPC/SDK/CLI/Event/Tool call. Successful serialization alone is not an implemented operation.
4. **Tests:** unit/property/codec/fuzz; negative authorization; provider unavailable; resource budgets; real persistence and failure injection; crash/restart; client contract and ABI; packaged consumer; UI a11y/browser; true end-to-end journey. Include exact limitations and guard invariants.
5. **Documentation:** keep a short permanent surface README under `docs/surfaces/<intent>/README.md`, package-local README where necessary, diagrams for ownership/state transitions, API examples, state/error tables, configuration and reproducible test commands. Do not create session report documents as the only explanation.
6. **Cleanup:** delete superseded internal code, unused compatibility shims, stale fixtures, unused API duplicates and dead entry points only after source/reference/consumer tests. No global legacy rename that breaks existing clients.
7. **Independent completion:** a module can be fully implemented before another unrelated module, but no user-facing journey is complete until its **real** composed success/negative/recovery tests pass. Do not replace a failed positive test with a `NOT_ADMITTED` response unless the original authored requirement explicitly permits unavailability.

Baseline adverse matrix for every active API: valid positive; malformed/oversize/overflow; missing and cross-tenant authority; revoke between admission and effect; nonexistent/stale version; provider not ready; timeout/cancel; lost ACK and ambiguous effect; duplicate request/restart; concurrency and resource saturation; unsupported input; output integrity. UI adds a11y, keyboard, responsive, privacy and truthful state rendering.

## 4. Physical sources — exact implementation and testing tasks (28)

### 01. `adapters-agent-tools-media` — Tools & integrations

**Code owner:** `adapters/agent-tools-media`. **Implement:** Finish `MediaToolExecutionBinder` and four handlers as authorized, typed delegates to the canonical Media runtime; bind source identity, operation rights, quotas, idempotency, cancellation, ambiguous outcomes and result redaction. No direct provider bypass.

**Executable completion:** Package consumer tests for all four handlers; forged delegation, duplicate call, revoked rights, outage and effect-after-timeout; no false success.

**Documentation:** `docs/surfaces/adapters-agent-tools-media/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 02. `adapters-data-cloud-media` — Optional integration

**Code owner:** `adapters/data-cloud-media`. **Implement:** Complete `DataCloudSttAdapter`, `DataCloudVisionAdapter`, `DataCloudMultimodalAdapter`, `MediaObservationPublicationCoordinator` and `MediaSemanticObservationProjector` against owner public ports. Keep Data Cloud optional; metadata projection never owns Media job/artifact finality.

**Executable completion:** Installed-public-port tests, version/digest mapping, permission denial, lag, retry, duplicate event, outage isolation, no second writer.

**Documentation:** `docs/surfaces/adapters-data-cloud-media/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 03. `adapters-ledger` — Durable integration

**Code owner:** `adapters/ledger`. **Implement:** Finish `AudioVideoRunLedgerAdapter` and `RunLedgerProjection` as a projection of canonical job attempts; use a real durable compare-and-set backing interface, no independent job status authority.

**Executable completion:** Conflict/restart/replay/lost acknowledgement tests against real storage adapter and public ledger client; terminal status matches Media writer.

**Documentation:** `docs/surfaces/adapters-ledger/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 04. `apps-media-experience-explorer` — Curated experience

**Code owner:** `apps/media-experience-explorer`. **Implement:** Keep the Explorer a frontend-only projection of authored product scenarios. Consolidate source bindings, keyboard/a11y, responsive behavior and narration/captions. Do not disguise Explorer fixtures as a real host.

**Executable completion:** Static scenario/contract reconciliation, CSP, browser keyboard/a11y and responsive tests, correct simulated labeling; all 47 defined screens represented.

**Documentation:** `docs/surfaces/apps-media-experience-explorer/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 05. `audio-video-observability` — Operations behavior

**Code owner:** `audio-video-observability`. **Implement:** Use `MediaWorkflowMetrics`, real provider registry, health/tracing and live metrics route. Finish truthful readiness/quality freshness, attempt finality, unknown counts and bounded high-cardinality labels; retain useful alert rules.

**Executable completion:** Actual scrape and receiver fire/clear tests, absent-series remains unknown/NaN, trace redaction, c1/16/64 resource and latency budgets.

**Documentation:** `docs/surfaces/audio-video-observability/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 06. `integration-tests` — Cross-module tests

**Code owner:** `integration-tests`. **Implement:** Replace fixture-only broad coverage with compositional tests of canonical REST/gRPC, S3/PostgreSQL, provider workers, source authorization, outbox and restart. Split reusable fixtures from scenario tests.

**Executable completion:** All positive/denied/UNKNOWN/restart paths; provider effects are observed rather than inferred from HTTP 202 or event append; tests run from clean source checkout.

**Documentation:** `docs/surfaces/integration-tests/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 07. `launcher` — Canonical runtime

**Code owner:** `launcher`. **Implement:** Finish `MediaRuntime`, `MediaHttpHandler`, caption runtime, dependency injection and persistent canonical job orchestration: versioned upload, identity, rights, provider attempt fencing, reconcile-after-crash and stable terminal reads. No second writer.

**Executable completion:** J01/J02/J20/J03 integration; process-kill before/after commit, stale tenant, idempotency, cancel/late response, startup readiness, bounded threads and memory.

**Documentation:** `docs/surfaces/launcher/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 08. `libs-audio-video-client` — SDK, CLI, recorder

**Code owner:** `libs/audio-video-client`. **Implement:** Harden SDK fetch/abort, authenticated typed routes, immutable source refs, DI-only scene text, `capture-adapters.ts` and `recorder-orchestrator.ts`. Replace dry-run-only recording with authorized adapter execution while preserving deliberate dry-run.

**Executable completion:** Isolated ESM/CJS package consumer; real route+error parity, abort->UNKNOWN and reconciliation, authorized capture with real frame bytes, selective recapture; no fake video/audio.

**Documentation:** `docs/surfaces/libs-audio-video-client/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 09. `libs-audio-video-types` — Public types

**Code owner:** `libs/audio-video-types`. **Implement:** Consolidate `src/contracts.ts` and exports to a strict canonical contract projection: exact clocks, version refs, job states, content digests, rights, production specs and typed errors. Preserve wire compatibility.

**Executable completion:** Java/TS/OpenAPI/proto golden round trips, decimal-int64/overflow/fuzz, unknown enum handling and isolated installed package tests.

**Documentation:** `docs/surfaces/libs-audio-video-types/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 10. `libs-audio-video-ui` — Hosted UI & Studio

**Code owner:** `libs/audio-video-ui`. **Implement:** Extend `src/screens/MediaProductRenderer.tsx` beyond four implemented presentation families and preview-only screens. Connect all 47 authored screens through typed SDK ports; implement timeline, revision lock, undo, effects, render, review and accessible states.

**Executable completion:** Real-host navigation and backend effect tests across defined screens; keyboard/ARIA/WCAG, desktop/mobile, adverse job states, tenant isolation and visual regression.

**Documentation:** `docs/surfaces/libs-audio-video-ui/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 11. `libs-common` — Shared transport helpers

**Code owner:** `libs/common`. **Implement:** Reconcile the SUBSUMED gRPC infrastructure with `libs/java/common`; retain one TLS/auth/deadline/quota/error implementation, and delete duplicate exports only after all service clients migrate.

**Executable completion:** STT/TTS/Vision/MM in-process and source-free client tests for auth, cancellation, unavailable provider, noncooperative deadline, streaming flow control and ABI compatibility.

**Documentation:** `docs/surfaces/libs-common/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 12. `libs-java-common` — Shared media engines

**Code owner:** `libs/java/common`. **Implement:** Consolidate PCM/codec/clock parsing, Whisper/Piper/Vision engines, pool and breaker lifecycles, `AnimationSpecCompiler` and AV sync. Separate true engine outputs from synthetic test fixtures; add selected real model/renderer implementations.

**Executable completion:** Codec property/fuzz/reference tests, exact PTS, output decodability, bounds and leak tests; real provider model parity and legal-source checks; no default synthetic success.

**Documentation:** `docs/surfaces/libs-java-common/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 13. `libs-media-experience-simulation` — Experience fixtures

**Code owner:** `libs/media-experience-simulation`. **Implement:** Keep declarative fixtures and scenario oracles deterministic and clearly nonproduction. Extract reusable scenario contract validation for recorder and Explorer; do not use fixture values as solver or model outputs.

**Executable completion:** Seed/clock repeatability, no network side effects, schema corruption cases, same semantic beats for narrated Explorer and actual-product recordings.

**Documentation:** `docs/surfaces/libs-media-experience-simulation/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 14. `modules-audio-streaming` — Live audio

**Code owner:** `modules/audio-streaming`. **Implement:** Complete guarded session, PCM framing and canonical frame port with real transport adapters, source sample clock, lease/consent refresh, EOS, backpressure, reconnect and replay fence.

**Executable completion:** Real audio transport at 1/16/64 clients, reordered/missing frames, source rights revoked midstream, cancel, disconnect/reconnect and bounded decoded memory.

**Documentation:** `docs/surfaces/modules-audio-streaming/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 15. `modules-infrastructure-cache` — Caching

**Code owner:** `modules/infrastructure/cache`. **Implement:** Finish tenant+rights+source-version keyed caches; cache only decisions proven fresh, invalidate on consent/revocation/retention/source revision, bound Redis errors and stampede control.

**Executable completion:** Cross-tenant, stale source, revoke, restart, outage, eviction and duplicate-effect tests; cache miss must not authorize fallback.

**Documentation:** `docs/surfaces/modules-infrastructure-cache/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 16. `modules-infrastructure-messaging` — Outbox & events

**Code owner:** `modules/infrastructure/messaging`. **Implement:** Route transcription events and lifecycle events through canonical transactional outbox; distinguish append ACK, delivery, consumer effect and durable job terminal state.

**Executable completion:** Lost-ACK, duplicate delivery, dead-letter, lease expiry, simultaneous consumers, crash and backlog tests; no status promotion from event append.

**Documentation:** `docs/surfaces/modules-infrastructure-messaging/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 17. `modules-infrastructure-persistence` — Durable domain

**Code owner:** `modules/infrastructure/persistence`. **Implement:** Unify run ledger, uploads, attempts, immutable transcript/caption/artifact revisions and tenant-aware transactions; implement atomic CAS and replay-safe failure modes, retire in-memory production fallback.

**Executable completion:** PostgreSQL migrations/restart/crash-phase tests, backend termination rollback, lock/conflict/retention/erasure, version and source identity correctness.

**Documentation:** `docs/surfaces/modules-infrastructure-persistence/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 18. `modules-infrastructure-security` — Authorization

**Code owner:** `modules/infrastructure/security`. **Implement:** Upgrade `MediaProcessingSecurityValidator` from metadata validation to explicit trusted principal/policy/consent integration via Shared and public owner APIs. Fail closed when authority absent; never trust caller-provided consent labels.

**Executable completion:** Wrong actor/tenant/purpose, revoked biometric rights, forged header, rights change mid-job, provider effect count stays zero on denial.

**Documentation:** `docs/surfaces/modules-infrastructure-security/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 19. `modules-integration-tests` — API interoperability

**Code owner:** `modules/integration-tests`. **Implement:** Exercise public wire and installed client consumption independently of implementation unit tests. Combine generated protobuf/OpenAPI clients with identity, rights, job reconciliation and provider faults.

**Executable completion:** 30 HTTP operations and 44 gRPC RPCs exercised against configured server capabilities with positive/negative/unsupported/timeout cases and source-free clients.

**Documentation:** `docs/surfaces/modules-integration-tests/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 20. `modules-intelligence-ai-voice-libs-ai-voice-ui-react` — Voice UI

**Code owner:** `modules/intelligence/ai-voice/libs/ai-voice-ui-react`. **Implement:** Complete `VoiceProductionWorkflow`, `PhraseTimeline`, `StemTrack`, playback/mixer and recording interactions against authorized TTS/voice SDK; no mock or unauthorized clone disguised as output.

**Executable completion:** Real hosted voice/phrase controls, consent/voice revocation and inaccessible-state tests; audio playback metadata validated; responsive a11y and keyboard.

**Documentation:** `docs/surfaces/modules-intelligence-ai-voice-libs-ai-voice-ui-react/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 21. `modules-intelligence-multimodal-service` — Cross-modal execution

**Code owner:** `modules/intelligence/multimodal-service`. **Implement:** Finish `MediaCanonicalOperationExecutor` + `DelegatingMultimodalProvider`: bounded STT/Vision child work, common source version, rational audio/video clocks, independent child outcomes, grounded fusion and durable parent/child reconciliation.

**Executable completion:** Real STT+Vision child output and mismatch rejection; crash/restart/UNKNOWN, lost ACK, denied rights, unrelated clock, load 1/16/64 and no invented confidence.

**Documentation:** `docs/surfaces/modules-intelligence-multimodal-service/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 22. `modules-intelligence-speech-libs-speech-audio-rust` — Native DSP

**Code owner:** `modules/intelligence/speech/libs/speech-audio-rust`. **Implement:** Harden `src/lib.rs` decoding, sinc resampling, transforms, slicing, mixing, clock bounds, WAV output and FFI/resource lifetime; expose reusable primitives, not a second STT/TTS authority.

**Executable completion:** Rust unit/property/fuzz and codec round-trip, aliased sine/impulse, stereo fidelity, long-duration drift, peak RSS, sanitizer where supported.

**Documentation:** `docs/surfaces/modules-intelligence-speech-libs-speech-audio-rust/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 23. `modules-speech-stt-service` — Speech recognition

**Code owner:** `modules/speech/stt-service`. **Implement:** Complete `ProductionSttGrpcService`, Whisper worker/ONNX provider, authenticated source resolver, codecs, streaming/diarization, transcript revisions, correction and caption lineage. Choose exact lawful model and evaluation sources.

**Executable completion:** Real decoded speech, English/Nepali transcript correctness, WER/CER/DER where applicable, 12 gRPC methods, revoke, timeout/cancel and restart with no duplicate transcript.

**Documentation:** `docs/surfaces/modules-speech-stt-service/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 24. `modules-speech-tts-service` — Speech synthesis

**Code owner:** `modules/speech/tts-service`. **Implement:** Complete `ProductionTtsGrpcService`, Piper/phoneme profile, voice consent and actual PCM output, streaming and typed control support/denial. No fake playable audio or unapproved speaker cloning.

**Executable completion:** Real waveform and codec/duration, selected locale/voice reference quality, clone/revoke/SSML faults, idempotent durable output and 1/16/64 streams.

**Documentation:** `docs/surfaces/modules-speech-tts-service/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 25. `modules-video-streaming` — Live video

**Code owner:** `modules/video-streaming`. **Implement:** Complete `GuardedVideoStreamSession`, `VideoFrameTimebase`, real video transport and source PTS/VFR, lease, sequence, drop/reorder/reconnect and adaptive output.

**Executable completion:** Camera/file-to-consumer video with 1/16/64 sessions; VFR/frame-order, rights changed while streaming, memory caps, cancel and recovery.

**Documentation:** `docs/surfaces/modules-video-streaming/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 26. `modules-vision-vision-service` — Vision analysis

**Code owner:** `modules/vision/vision-service`. **Implement:** Complete OCI/codec worker, model qualification and geometry transforms, tracking, frame and ROI authority, real image/video detection. `SceneTextRecognitionService` must delegate OCR to Document Intelligence only; no Media OCR engine.

**Executable completion:** Real model detection/track + mAP against lawful reference, PTS/EXIF/rotation/ROI errors, DI positive/negative, native OOM/PID/deadline and restart safety.

**Documentation:** `docs/surfaces/modules-vision-vision-service/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 27. `providers-aws-postgresql` — Durable adapters

**Code owner:** `providers/aws-postgresql`. **Implement:** Finish S3 + PostgreSQL artifact, job, caption, transcript, source-rights and outbox implementations with one writer, idempotent object ownership, Flyway V001–V029 compatibility and readback.

**Executable completion:** Testcontainers and object-store integration across actual schema versions; migration upgrade/rollback path, partial object upload, stale revision, erasure and crash boundaries.

**Documentation:** `docs/surfaces/providers-aws-postgresql/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.

### 28. `runtime-contracts` — Domain contract authority

**Code owner:** `runtime-contracts`. **Implement:** Complete the canonical public Java domain/API contracts: source IDs, rights, attempts, job states, capture, creation, timebase and outbox. Resolve operation-to-engine dispatch explicitly without success placeholders or parallel grammar.

**Executable completion:** Contract/serialization tests and full HTTP/gRPC/SDK mapping; invalid provenance, unsupported control, UNKNOWN/finality and binary compatibility tests.

**Documentation:** `docs/surfaces/runtime-contracts/README.md` (responsibility, public operations, states, invariants, dependencies, configuration, errors, tests and runnable commands); update package-local README where relevant. Keep source-bound test fixtures with their owning module.


## 5. Logical user and machine surfaces (21)

These are **contract/channel responsibilities** over physical code, not 21 new deployables. For each active logical identity, create/update `docs/surfaces/<stable-id>/README.md` with its supported operations, owning implementation paths, error/state semantics, integration example and tests.

| Logical identity | Physical code owner | Remaining development and required checks |
| --- | --- | --- |
| media.surface.web | libs/audio-video-ui, launcher | Host authenticated 47-screen product UI; route all actionable screens through canonical SDK and real backend, with loading, refusal, unknown, pending and final result states. |
| media.surface.embedded | libs/audio-video-ui | Provide sandboxed origin-bound media/player embed, read-only or scoped delegated operations, controls, captions, restrictions and no host privilege leakage. |
| media.surface.public-http | launcher, runtime-contracts | Reconcile 30 documented operations with real route handler, schema, auth, tenant, idempotency, cancellation and typed error; source-free HTTP consumer tests. |
| media.surface.service-grpc | libs/common, four modality services | Reconcile 44 declared RPCs with actual channel auth/TLS/deadline/streaming behavior and generated clients; no unimplemented success response. |
| media.surface.grpc.stt | modules/speech/stt-service | Exact STT RPC semantics for model state, transcribe, streaming, correction and profile; real audio/cancel/rights positive and denial. |
| media.surface.grpc.tts | modules/speech/tts-service | Exact TTS RPC semantics for synthesis, voice/profile, streaming and feedback; lawful voices, no unsupported controls disguised as executed. |
| media.surface.grpc.vision | modules/vision/vision-service | Exact Vision RPC semantics for image/video inference, tracking, readiness; preserve backward OCR RPC only as DI delegate or typed unsupported compatibility. |
| media.surface.grpc.multimodal | modules/intelligence/multimodal-service | Exact MM RPC semantics with child source/clock identities and durable fused/partial/unknown outcomes. |
| media.surface.sdk | libs/audio-video-client, libs/audio-video-types | Published ESM/CJS/typed SDK with isolated consumer, DI-only scene text, job reconciliation, abort and idempotent retry. |
| media.surface.cli | libs/audio-video-client | Real executable structured JSON CLI for artifact/job/capture/recorder operations; strict schema and exit codes; no fixture-only success. |
| media.surface.agent-tools | adapters/agent-tools-media | Four public delegated actions bound to authenticated Tools/Action Plane identity, rights and no duplicate provider side effects. |
| media.surface.events | modules/infrastructure/messaging, runtime-contracts | Versioned lifecycle event schema, outbox publish, ordered idempotent consumption, distinct appended/delivered/effected/final states. |
| media.surface.integrations | adapters/*, providers/aws-postgresql | Installed supported owner interfaces for Shared, DI, Kernel, Data Cloud and Agents; optional integrations fail isolated, never acquire domain authority. |
| media.surface.types-library | libs/audio-video-types | Complete exported Zod/TypeScript contracts and JSON, Java, OpenAPI and protobuf parity across revisions, clocks and errors. |
| media.surface.ui-library | libs/audio-video-ui, ai-voice-ui-react | Ship reusable accessible components and typed host adapters; avoid a forked state model for Studio, voice and captions. |
| media.surface.explorer | apps/media-experience-explorer, libs/media-experience-simulation | Maintain simulated, source-defined Explorer, including narrated/captioned reproducible demos; visibly distinguish from live-product behavior. |
| media.surface.desktop-archive | archive/media-desktop-apps | Archived, not a product runtime: resolve live imports and replace with active components; remove in-tree archive once independently recoverable and no consumer depends on it. |
| media.surface.recorder-orchestrator | libs/audio-video-client/src/recorder-orchestrator.ts | Add authorized scheduling, actual adapter execution, source- and scene-keyed recapture, narration, subtitle mux and final recording; reuse scenario version refs. |
| media.surface.capture-adapters | libs/audio-video-client/src/capture-adapters.ts, runtime-contracts | Implement isolated capture providers for browser, desktop, mobile, terminal, HTTP, gRPC, camera and file with rights, frame clocks, resources and cancellation. |
| media.surface.production-studio | libs/audio-video-ui | Implement project/timeline/asset/track/audio/video/annotation interfaces over one canonical revision, edit history, render/preview, review, delivery and undo. |
| media.surface.interactive-demo-player | libs/audio-video-ui (new player implementation) | Implement branching timed playback, captions, controls, replay, safe host embed, simulation-versus-live declaration and keyboard/screen-reader navigation. |

## 6. Seven composition interfaces (including root)

Each composition owns an actual cross-child behavior test; success is not inferred from passing child unit suites. For each create `docs/surfaces/<composition-id>/README.md` documenting input, output, authority, failure/rollback and data-flow diagram.

| Composition | Required executable cross-child behavior |
| --- | --- |
| repository-root | Cross-module source/build dependency tests, one writer, ownership boundaries, no stray build targets; all relevant implemented journeys across UI/SDK/CLI/agent APIs without duplicated definitions. |
| ingestion-and-versioned-artifacts | Upload -> durable content -> verified immutable version -> authorized read -> retention/erasure, with S3/PG crash, invalid hash, replay and tenant faults. |
| governed-job-execution | Canonical job/attempt -> policy -> bounded provider effect -> transactional outbox -> exact terminal readback, including fail closed, cancellation, lost ACK and UNKNOWN. |
| speech-and-caption-workflows | Lawful source -> decoded STT/TTS -> transcript version -> corrected caption version -> approved playable output with word clock and consent lineage. |
| vision-and-multimodal-analysis | Versioned image/video/ROI -> Vision/DI and STT child analyses -> rational clock association -> grounded typed fused result, including incompatible clocks and child outages. |
| creation-composition-and-delivery | Authorized creative spec -> deterministic scene/timeline -> real rendering/mix -> review/approval -> versioned export and destination acknowledgement. |
| client-and-machine-interfaces | HTTP/gRPC/SDK/CLI/Agent/Events/Web/Embedded clients agree on schemas, identity, immutable versions, rights, errors, cancellation, replay and final state. |

## 7. Full 30-journey outcome coverage

Every journey needs an **actual terminal product outcome**, a reusable authored fixture/source version, an authorized real/qualified provider where required, an adverse/UNKNOWN/restart test, and a source-free client or hosted-UI check. The existing narrated Explorer J03 scenario remains clearly marked *simulated*; when the product host works, record the same semantic steps as real output without changing their meaning.

| Journey | Development result to implement and test |
| --- | --- |
| J-01 | Identity, authorized workspace and persisted project revision |
| J-02 | Resumable upload, digest verification and immutable artifact version |
| J-03 | Lawful STT, transcript correction, immutable caption version |
| J-04 | Consented voice/locale selection and real TTS audio output |
| J-05 | Real image/video geometry, detection, tracking and source PTS |
| J-06 | Grounded document/DI and multimodal typed consumer outcome |
| J-07 | Preserving audio denoise/declip and measured A/B comparison |
| J-08 | Actual video enhancement and source-preserving comparison |
| J-09 | Brief -> storyboard -> rendered reviewable media artifact |
| J-10 | Rights-checked reference-conditioned generation and continuity |
| J-11 | Region/track edit, immutable revision lock and undo |
| J-12 | Deterministic 2D/vector/procedural render with golden frames |
| J-13 | 3D rig/path animation and actual spatial output (or explicit scoped unavailability) |
| J-14 | Unit-correct scientific simulation and instrument measurements |
| J-15 | Validated simulation/procedural passes with meaningful abstention |
| J-16 | Translation, dubbing, licensed voice and frame-aligned timing |
| J-17 | Rights-cleared Foley, stems, mixing and playable mastering output |
| J-18 | Multitrack video/audio/caption/color composition and master export |
| J-19 | Quality evaluation, bounded improvement and reversible comparison |
| J-20 | Durable job observation, timeout, cancellation and restart reconciliation |
| J-21 | Comments, review and approval bound to exact immutable revision |
| J-22 | Export/download/publish with explicit destination acknowledgement |
| J-23 | Offline private edits, conflict detection and safe reconnection |
| J-24 | CLI JSON batch -> actual authorized operation -> typed terminal result |
| J-25 | Delegated agent/product action with precise rights and no duplicate effect |
| J-26 | Retention, revoke, hold, deletion and physical erasure correctness |
| J-27 | Unavailable/degraded provider with truthful alternatives and UNKNOWN |
| J-28 | Spatial/360/interactive export with coordinate/time semantics and viewer |
| J-29 | Live session loss/revoke and bounded stream recovery |
| J-30 | Qualified currently eligible provider/operation catalog |

**Primary true outcome:** implement and run **J-01 -> J-02 -> J-20 -> J-03**: sign in, create a versioned project, upload and hash a real owned media source, start/reconcile a canonical job, process licensed STT, correct/persist a transcript/caption version, reopen after restart and review the exact immutable final version. Include a denied-tenant/rights path and an ambiguous-provider restart path. Do not call a fixture-only Explorer recording the actual result.

**Next release-independent outcomes:** J-30 eligibility, J-04 lawful TTS, J-05 real Vision, J-06 true child-reconciled Multimodal, J-21 review, J-22 destination ACK, J-29 live recovery. Parallel creative families J-07..J-19/J-23/J-28 must still be implemented; don't redefine their absence as complete.

## 8. New product capabilities lacking a demonstrated full executor

Complete these as dedicated, reusable **Media-owned engines**, integrated through the existing domain runtime rather than as UI-only mock features:

| Capability | Proposed intent-oriented owner path (new if absent) | Required algorithm/behavior | Independent tests |
| --- | --- | --- | --- |
| Scene and timeline | `modules/production/timeline/` | Immutable project scene/clip/track graph, rational time map, undo/redo by version CAS, source rights at render | Edit algebra, no drift, conflicts, source reuse |
| 2D/vector animation | `modules/production/animation/` | Compile `AnimationSpec` into bounded deterministic frames and effect-safe render; curves, transform units, fps/PTS | Golden pixel/frame/curve/seed fixtures, parser fuzz |
| 3D/spatial | `modules/production/spatial/` | Rig, skeleton, keyframe/path and coordinate transforms with declared export fidelity and viewer | Joint limits, kinematic/coordinate invariants, scene roundtrip |
| Domain simulation | `modules/production/simulation/` | Pluggable typed solver with unit-correct observables, uncertainty/error bounds and instruments | Newton reference: m=2 kg, F=6 N, t=2 s from rest yields a=3 m/s², v=6 m/s, x=6 m; negative units and numerical convergence |
| Render/encode/export | `modules/production/rendering/` | Bounded video/audio codec/mux, subtitle, color and checksum output; selectable formats, no fake success | Actual ffprobe/decoder metadata, timestamp, codec, VFR, corruption, resource bounds |
| Translation/dubbing | `modules/production/dubbing/` | Source transcript and translation version -> lawful TTS -> timing alignment -> rendered audio and lip-sync metadata | Locale, rights, timing drift, unknown voice, audible output |
| Music/mix/mastering | `modules/production/audio-mixing/` | Rights-proven stems/Foley, gain/pan, sample-aligned mix, loudness/clip/true-peak guard | Audibility, clipped mixes, silence, sample alignment, export decoding |
| Quality and creative review | `modules/production/review/` | Version-specific comments/approval, invalidation on edit, bounded quality comparison | Stale approver, version conflict, fake metric rejection |
| Delivery/offline | `modules/production/delivery/` | Versioned export/upload destination acknowledgements, offline queue and idempotent reconnect | Lost ACK, conflict, revoked rights, checksum and destination confirm |
| Interactive player | `libs/audio-video-ui/src/player/` | Embedded branching state machine, accessible playback and typed sandboxed actions | Seek/replay/branch determinism, cross-origin denial and keyboard/a11y |

These **proposed** folders are not claimed to exist. First inspect current implementations for reusable algorithms and public Ghatana ecosystem abstractions; create a module only if no appropriate owner already exists. Do not introduce empty modules.

## 9. Parallel implementation lanes and dependencies

| Lane | Owned paths / results | Needs | Safe parallel work |
| --- | --- | --- | --- |
| **Contract and compatibility** | `runtime-contracts`, `libs/audio-video-types`, `contracts/openapi`, gRPC contract artifacts, version clocks | Existing authored definitions | Contract parity, exact route/operation mapping, strict validation |
| **Durability and authorization** | `modules/infrastructure/*`, `providers/aws-postgresql`, `adapters/ledger` | Stable identity/rights/job contracts | Parallel security and storage branches with shared contract freeze |
| **Runtime and streaming** | `launcher`, `modules/audio-streaming`, `modules/video-streaming`, `libs/common` | Contracts, storage ports | Canonical writer, frame transport, explicit state/finality |
| **Modality engines** | STT, TTS, Vision, Multimodal, Rust and shared Java engines | Provider interfaces, trusted rights and job model | STT/TTS/Vision/Rust concurrently; MM child integration after STT/Vision |
| **Public consumers** | HTTP/gRPC, SDK, CLI, Agent Tools, Data Cloud adapter | Running runtime or strict in-process ports | Consumer contract tests and independent optional boundary adapters |
| **UI and capture** | `libs/audio-video-ui`, `apps/media-experience-explorer`, recorder and capture adapters | Typed client and reusable state port | Hosted screens, a11y, capture, narrated demo in parallel |
| **Creative production** | Timeline, render, animation, solver, dubbed audio, mix, review, export, Player | Artifact/time/rights, media processors | Engines independently, then exact timeline integration |
| **Product outcomes** | `integration-tests`, `modules/integration-tests`, hosted UI | Relevant physical and logical slices | Each J journey gets own stable scenario tests; overlap reused |
| **Hygiene and docs** | `docs/`, `scripts/audit-media-repository.mjs`, old modules, package/build indexes | Path/reference inventory | Rename/retire one owner group at a time; no bulk deletion |

Recommended execution order: (1) contract truth and inventory, (2) security/durable writer/transport, (3) real media providers and public consumers, (4) first full outcome, (5) creative engines and 29 remaining outcomes, (6) whole-product regression and aggressive safe cleanup. The hygiene lane begins immediately but irreversible deletions wait for consumer classification.

Keep parallel edits disjoint. Any shared contract modification has one serialization point with a compatibility test before dependent lanes rebase. Use short PR-sized functional changes; do not create run-specific file names or new parallel authorities for each lane.

## 10. Documentation and repository hygiene actions

**Keep:** current product definitions, required public versioned contracts, authoritative migration schema history, source code, current app/surface docs, meaningful fixtures, test sources, reproducible build scripts, current provider profiles and constitutional boundary decisions.

**Remove or relocate after checks:**

1. Treat `docs/implementation/observations/`, `docs/implementation/verification/`, `docs/implementation/evidence/` and dated old plan/readback files as candidates for removal from the **active** source tree; identify all inbound links, test assertions, manifest identities, generators and legal retention requirements first. Preserve required immutable records in their proper archive/store; Git history alone is sufficient only where no other retention/reference obligation exists.
2. Generate a SHA-256 and byte-identical candidate report for the repeated multi-megabyte JSON snapshots. Replace actively needed repeated projections with one canonical derived input plus deterministic generator and a test; do not edit authored semantic authority data as if it were generated.
3. Consolidate the many dated `MEDIA-*` plans and `R*`, `WAVE2-*`, `batch`, `phase`, `round` engineering instructions into an intent-named current plan, with historical source citations only where necessary. Avoid renaming canonical PDP directories/IDs and migration versions whose semantics are intentionally phase/version-specific.
4. Remove old code/test comments and internal file names that encode the task that introduced them (for example `H-03`, `K4`, `WAVE2-RPC-CAPABILITY-MATRIX.md`), replacing with enduring behavior names. Exception: intentionally stable public task/source identities and test fixtures validating historic compatibility.
5. Audit `archive/media-desktop-apps/` for live import/build/runtime references; retire old archived code after ensuring the active voice UI and recorder actually replace it. Move necessary history out of the active workspace and update links, if retention allows.
6. Audit test-only `modules/audio-processing`, `modules/video-processing`, `modules/format-compatibility`, `modules/session-management` and root `src/` against `settings.gradle.kts`, imports and test selectors. Move tests into their real owner modules or document exactly why a distinct build target remains.
7. Deduplicate `libs/common` and `libs/java/common` per their SUBSUMED intent, without ABI breaking consumers or losing gRPC/security/codec tests.
8. Review `review/`, `service-contract-supplements/`, `config/docker-compose.prod.yml`, static Kubernetes candidates, old monitoring examples, retired compatibility files and unused scripts. Delete dead placeholders; keep useful deploy/test examples only with accurate semantics.
9. Rewrite `README.md`, `docs/README.md`, `AGENTS.md` and `docs/REPOSITORY-HYGIENE.md` as stable **present-tense** navigation and implementation rules. Old execution snapshots should not be the recommended entry point.
10. Extend existing `scripts/audit-media-repository.mjs` to detect broken internal links, orphan imports/modules, unused exports, duplicate SHA objects, unintentionally generated large files, nonsemantic internal names, obsolete preview/deployment artifacts and backwards-dependency violations. Use an explicit exception list for immutable public source identities.
11. Keep published `audio-video` consumer package/route/proto identities until compatibility-tested migration. Rebranding alone is not a development feature. No `V2` duplicate runtime or shadow API.
12. Keep documentation concise: one maintained surface README and direct API/example/test links per active leaf/logical/composition, one maintained root index, and dedicated design records only for genuine cross-owner architectural decisions.

**Clean-repository exit:** no active references to removed paths; no unexplained test-only modules; no dead service or unreachable branch; no duplicate production owner for jobs/OCR/rights; no fabricated output; no broken links; no stale session guide presented as current; scoped source-only tests, integration tests and package-compatibility checks pass after deletion.

## 11. Test execution map (development only)

Use verified existing scripts from the current package metadata. Select the narrowest relevant suite during development and rerun affected consumers before merge:

```bash
# Repository hygiene and stable surface identities
pnpm audit:repository-hygiene
pnpm check:surface-roster
pnpm check:contract-parity

# Public TypeScript consumer packages
pnpm --filter @audio-video/types check
pnpm --filter @audio-video/client test:package
pnpm --filter @audio-video/ui check
pnpm --filter @ghatana/media-experience-explorer test

# Native audio, from the root Cargo workspace
cargo test --manifest-path modules/intelligence/speech/libs/speech-audio-rust/Cargo.toml

# Java: inspect Gradle projects in the selected source-composite profile
# and run each owning test target, then integration-tests.
./gradlew projects
```

For new production engines, add explicit `test`, `test:integration`, `test:contract`, `test:performance` selectors with bounded time/memory rather than one expensive implicit all-repo test. Tests must verify real output where real functionality is claimed; synthetic fixtures remain valuable for logic and fault injection but not as substitute model/codec/solver correctness.

## 12. Definition of development complete for later tooling

Development is finished only when the 56-node inventory is reconciled (including nonactive dispositions), every active applicable capability/operation/journey has an implemented or explicitly lawful nonapplicable owner, every real public endpoint executes or truthfully refuses, every required positive/negative/recovery case passes, the 30 end-to-end journeys are exercised at their actual advertised scope, all current source-owned and new surface documentation is correct, and the active tree is clean.

**Do not call the whole product development-complete on this review.** The currently observed dry-run recorder, absent admitted capture adapters, animation renderer refusal, preview-only UI surfaces and unfinished provider/outcome integrations are concrete remaining work. Future gtool configuration should consume this completed implementation and documentation, not compensate for it.

