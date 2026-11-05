# Ghatana Media — remaining feature implementation and owner decisions

> **Current engineering selector.** This file and [machine-readable remaining work](remaining-work.json) replace dated task-run selections **for feature implementation only**. Product definitions retain semantic authority. No gtool setup, closure, evidence, convergence, release or production cutover work is authorized by this document.

## Current source and safe readiness claims

- Inspected `main@5cc47191` (November 5, 2026): the four reported commits are present; 56 intent-scoped docs exist; orphaned test-only modules were removed. The two new durable file stores are **single-host adapters**, not admission of real agent tools or Data Cloud finality.
- Safety correction `c38620ff`: exclusive link claim rather than misleading `ATOMIC_MOVE` no-replace, removed unsafe legacy upsert, persistent pre-dispatch uncertainty and correct hydration error handling, added contention/crash-phase/mismatched-identity tests. **The Media Gradle suites have not run in this review.** Verify them first.
- The source-state denominators (28 physical / 21 logical / 7 compositions; 30 journeys; 47 screens; 30 HTTP + 44 gRPC named operations) are not counts of unimplemented features. This register has 103 task units, including 30 compositional outcome tasks. Its units overlap original historic F/V/W3/quality tasks and must never be added as independent obligations.

## Binding owner decisions (implementation approval, not fabricated external credentials)

1. **CORE_RUNTIME_INDEPENDENT_OF_DATA_CLOUD.** Media implements and persists its own artifact/job/rights/stream/transcript/caption state. Data Cloud is an optional, downstream index/metadata/run-ledger projection only. The existing `MediaProcessorPort` is not an authorized processing API: it accepts artifactId, tenantId and string parameters but no trusted actor, immutable version, current source purpose or rights readback. Keep its three adapters unavailable; do not wire it as a second execution route. Absence of Data Cloud cannot block Media runtime, model work, UI or J01–J30. Positive Data Cloud publication tests are optional integration work, not a core acceptance requirement.
2. **SINGLE_OCR_GATEWAY.** Document Intelligence owns generic OCR/parser/engine selection and its public API. Media may sample frames, authorize ROI/source versions/PTS and consume DI; never add a Media OCR engine or depend on Data Cloud for OCR.
3. **DURABLE_EFFECT_FIRST.** No real Agent Tool action or external ledger write until exclusive claim, source authorization, pre-effect durable UNKNOWN and authentic post-effect reconciliation are working. File stores are single-host; multi-process must use a genuine shared CAS or reject concurrent writers. Replayed terminal results require fresh caller authorization, not merely matching envelope metadata.
4. **SDK_NO_FICTIONAL_ROUTES.** The 33-row legacy SDK registry includes three parser artifacts (`for`, `if`, `clearTimeout`); 60 source declarations are not 60 approved callable operations. Require an AST-derived per-symbol classification before any add/remove/rename. Preserve public ESM/CJS ABI. `MPSEM-0023-C002` is a stale observation about a legacy multimodal path: do not invent or enable `/api/v1/media/multimodal-analyses`. Reconcile as explicitly non-dispatched compatibility while real multimodal work proceeds via the currently admitted canonical operation/route. Update source parity and tests after verifying the actual dispatch branch.
5. **PROVIDER_RIGHTS_ARE_REAL_INPUTS.** Engineering can implement all paths/tests now, use safe synthetic fixtures for negative/fault tests and typed `NOT_ADMITTED` on missing real providers. Positive licensed inference requires exact artifact/license/export lineage, rights, voice/biometric authorization and actual reference data. Choose official source-pinned Whisper candidate and English/Nepali Common Voice v27 benchmark pathway if individually verified; Hindi/FLEURS remain deferred for this selected profile. A lawful alternative provider through the same public SPI is allowed. No self-issued vendor license or qualified corpus.
6. **CREATIVE_ENGINES_ARE_PRODUCT_WORK.** Timeline, renderer, 2D/3D, solver, sound, dubbing, review, export and Player are not covered by an effect-free compiler, UI preview or `NOT_ADMITTED` response. Implement actual usable outcomes and tests, reusing existing ecosystem engines first.
7. **DOC_CLEANUP_NONBLOCKING.** The approximately 995 MB under `docs/implementation/` must be classified by hash, refs and retention before deletion. Allow routine code work concurrently. Approve migration out of active tree for redundant dated logs/snapshots once stable reference redirects, required immutable preservation and regression checks have been completed; do not erase protected source preimages based on filename alone.
8. **ENGINEERING_AUTHORIZATION.** All local source changes, refactors, test fixtures, public-interface adapters, nonproduction simulations and documentation consolidation within the accepted product meaning are authorized without further owner prompts. Never represent this as legal model/voice consent, external-key authority, independent acceptance, deployment approval or release qualification.

## Exact reusable implementation method

Every task has one source owner and no second source of truth. Follow its `where`, `what`, `how`, `acceptance` and `requires` fields in the JSON register. Before editing, diff current code/tests against the task to avoid repeating implemented behavior. Develop with failure injection and real positive provider effects when the prerequisite is genuinely available. Run focused tests, then affected source-free consumers; keep truthful `NOT_ADMITTED` on missing external inputs rather than inventing success. Keep per-surface docs under `docs/surfaces/` current. One task can complete independently without waiting on unrelated surfaces.

## Finite dependency-ordered task register

| Domain | Count | Technical objective |
| --- | ---: | --- |
| foundations | 14 | Trusted source, store and effect/finality safety |
| interfaces | 12 | Public channel contract and truthful integration |
| modalities | 11 | Real lawful processing and quality |
| capture | 10 | Real capture, narration and recording |
| creative | 20 | Actual production, editing, solver and delivery engines |
| verification | 1 | Composition and source-free end-to-end tests |
| hygiene | 5 | Clean source and durable intent-based documentation |
| journeys | 30 | Real terminal J01–J30 outcomes |

### Per-task prescriptive plan

#### foundations

**`media.dev.source-capability-crosswalk`** · VERIFIED (all 469 PDP-0 capability leaves classified in `docs/development/capability-implementation-crosswalk.v1.json`: 463 NOT_IMPLEMENTED with exact blocking task refs, 6 OPTIONAL_DEFERRED; `check:capability-implementation-crosswalk` fails on any unclassified intent)
- **Where:** `scripts/check-media-contract-parity.mjs`, `.product-experience/pdp-0-product-truth/capabilities.yaml`, `docs/surfaces`
- **What:** Reconcile every authored capability intent to active code/delegate/test and document the truly inapplicable leaves.
- **How:** Derive an implementation inventory from current PDP0–3, routes, provider profiles and 56 topology nodes; classify IMPLEMENTED, DELEGATED, OPTIONAL, NOT_IMPLEMENTED with exact source links; make unknown counts a failing development audit.
- **Test/exit:** No unclassified active intent; no fake success/N/A; retain authoritative PDP IDs.
- **Predecessors:** None; start independently

**`media.dev.domain-contract-parity`** · OPEN
- **Where:** `runtime-contracts`, `libs/audio-video-types`, `contracts/openapi/media.yaml`, `config/route-manifest.json`
- **What:** One public domain and operation contract across Java/TS/HTTP/gRPC.
- **How:** Bind IDs, immutable artifact/version/ref, rational clocks, rights, lifecycle/UNKNOWN, inputs and outputs; preserve published ABI and add strict schema oracles.
- **Test/exit:** Roundtrip/golden/invalid/overflow/unknown-state tests and consumer ABI checks.
- **Predecessors:** `media.dev.source-capability-crosswalk`

**`media.dev.rights-and-policy`** · OPEN
- **Where:** `modules/infrastructure/security`, `runtime-contracts`, `launcher`
- **What:** Use authenticated Shared identity plus current owner rights/consent/purpose instead of caller-provided labels.
- **How:** Inject verified principal and version-scoped entitlement readback at admit, replay, provider effect and disclosure; block on stale/revoked/unknown.
- **Test/exit:** Wrong-tenant/cross-purpose/revoke-mid-flight/biometric/fake principal cause zero effects.
- **Predecessors:** `media.dev.domain-contract-parity`

**`media.dev.canonical-artifact-storage`** · OPEN
- **Where:** `providers/aws-postgresql`, `modules/infrastructure/persistence`, `launcher`
- **What:** Finalize source ingestion and immutable S3/PostgreSQL-backed artifact revisions.
- **How:** Use verified upload intent, digest, object ownership, atomic metadata CAS and idempotency; no in-memory production fallback.
- **Test/exit:** Corrupt/resume/duplicate chunk, restart, orphan object, stale version and erasure integration tests.
- **Predecessors:** `media.dev.domain-contract-parity`, `media.dev.rights-and-policy`

**`media.dev.database-upgrade-compatibility`** · OPEN
- **Where:** `providers/aws-postgresql/src/main/resources/db/media-runtime`, `modules/infrastructure/persistence`
- **What:** Verify actual compatible V001–V029 schema upgrades without duplicate writers.
- **How:** Exercise migrations on authentic nonproduction lineage; use DB-only single writer and revert-safe readback; do not claim production cutover.
- **Test/exit:** Testcontainers baseline->upgrade, interrupted migration, rollback and legacy-writer-denial.
- **Predecessors:** `media.dev.canonical-artifact-storage`

**`media.dev.canonical-job-reconciliation`** · OPEN
- **Where:** `launcher`, `providers/aws-postgresql`, `runtime-contracts`
- **What:** Prove one durable job and provider-attempt authority with no blind replay.
- **How:** Fenced submit/claim/attempt receipt, cancellable UNKNOWN, finality reconciliation and source-verified output versions; no event append as terminality.
- **Test/exit:** Kill-before/after provider, commit, ACK, restart, timeout, tenant switch, idempotent final reads.
- **Predecessors:** `media.dev.canonical-artifact-storage`, `media.dev.rights-and-policy`

**`media.dev.transactional-event-outbox`** · OPEN
- **Where:** `modules/infrastructure/messaging`, `providers/aws-postgresql`, `launcher`
- **What:** Publish lifecycle events transactionally without conflating delivery ACK with job finality.
- **How:** Use existing outbox identity with claim leases, destination status and backoff; separate appended/delivered/consumed/effected.
- **Test/exit:** Lost ACK, double consumer, partition, crash-after-publish and readback parity tests.
- **Predecessors:** `media.dev.canonical-job-reconciliation`

**`media.dev.rights-aware-cache`** · OPEN
- **Where:** `modules/infrastructure/cache`, `launcher`
- **What:** Ensure caches cannot outlive source version, tenant rights or revocation.
- **How:** Include immutable source/tenant/policy epoch in cache key; invalidate on retention/consent/right changes; fail closed on stale authority.
- **Test/exit:** Cross-tenant, revocation, restart, eviction, stale metadata, stampede and outage tests.
- **Predecessors:** `media.dev.rights-and-policy`

**`media.dev.stream-session-authority`** · OPEN
- **Where:** `modules/audio-streaming`, `modules/video-streaming`, `launcher`
- **What:** Complete canonical stream frame ordering, consent, lease, source clock and recovery.
- **How:** Bind both streams to one canonical session and durable ACK cursor; keep module helpers as non-authoritative implementation details.
- **Test/exit:** Gap/reorder/lease expiry/revoke while live, backpressure, EOS, abort, restart and 1/16/64 clients.
- **Predecessors:** `media.dev.canonical-job-reconciliation`

**`media.dev.exclusive-invocation-claim-verification`** · VERIFIED (macOS focused suite green: 6-process contention → exactly one claim, crash-after-claim fence, unwritable-dir fail-closed)
- **Where:** `adapters/agent-tools-media/src/main/java/com/ghatana/audio/video/tools/FileInvocationLedger.java`, `adapters/agent-tools-media/src/test/java/com/ghatana/audio/video/tools/FileInvocationLedgerTest.java`
- **What:** Verify committed claim hard-link exclusivity and restricted legacy record semantics.
- **How:** Run focused tests on macOS and Linux, including independent processes, crash and unsupported filesystem; require exactly one claim; review read/complete/lock path.
- **Test/exit:** All focused tests green, no existing fence overwrite and no terminal injection through record().
- **Predecessors:** None; start independently

**`media.dev.projection-pre-dispatch-fence-verification`** · VERIFIED (macOS focused suite green: real JVM halt at effect boundary → durable PENDING_RECONCILIATION, no duplicate dispatch, exact-readback reconcile, corrupt state fail-closed)
- **Where:** `adapters/ledger/src/main/java/com/ghatana/audiovideo/adapter/ledger/RunLedgerProjection.java`, `adapters/ledger/src/test/java/com/ghatana/audiovideo/adapter/ledger/FileRunLedgerProjectionStateTest.java`
- **What:** Verify committed pre-dispatch uncertainty durability and hydration correction.
- **How:** Run focused tests, kill process at pre-store/after-store/before-final-persist points, verify corrupt read fails and readback must match exact record.
- **Test/exit:** No duplicate sink call after ambiguous crash, no stale floor reset or cross-run state injection.
- **Predecessors:** None; start independently

**`media.dev.invocation-store-security`** · OPEN
- **Where:** `adapters/agent-tools-media`, `providers/aws-postgresql`
- **What:** Constrain filesystem ledger to secure single-host development; provide durable Media-owned backing for scale where required.
- **How:** Validate directory ownership, file permissions, symlink rejection, result encryption/retention and authenticated replay; build Postgres CAS backing through existing ports if multi-process host is needed.
- **Test/exit:** No replay leaks across actors/tenants, retention tested, concurrent independent host tests or fail-closed single-writer mode.
- **Predecessors:** `media.dev.exclusive-invocation-claim-verification`, `media.dev.rights-and-policy`

**`media.dev.projection-single-writer-policy`** · VERIFIED (exclusive writer fence via `forExclusiveWriter` hard-link claim; per-op ownership reverify; 6-JVM race → exactly one claimant; fail-closed on conflict/reclaim)
- **Where:** `adapters/ledger`, `adapters/data-cloud-media`
- **What:** Make optional ledger projection fail closed for concurrent writers on shared storage.
- **How:** Explicitly enforce single process/host ownership or use a transactional DB CAS and destination readback; never call file rename distributed compare-and-set.
- **Test/exit:** Two independent projector instances cannot both dispatch a stale/duplicate update; no Data Cloud dependency on Media.
- **Predecessors:** `media.dev.projection-pre-dispatch-fence-verification`

**`media.dev.service-observability`** · OPEN
- **Where:** `audio-video-observability`, `launcher`, `infra/monitoring`
- **What:** Expose truthful runtime/provider/capture/render health and resource limits.
- **How:** Reuse real registry and metrics route; bound label cardinality; report quality absence UNKNOWN rather than zero and trace/secret redaction.
- **Test/exit:** Local Prometheus scrape, alert fire/clear, restart, no provider leakage; 1/16/64 budgets.
- **Predecessors:** `media.dev.canonical-job-reconciliation`

#### interfaces

**`media.dev.http-operation-parity`** · OPEN
- **Where:** `launcher/src/main/java/com/ghatana/media/launcher/MediaHttpHandler.java`, `contracts/openapi/media.yaml`, `config/route-manifest.json`
- **What:** Implement declared HTTP operations with shared identity, exact request/version and typed responses.
- **How:** Compare route manifest, OpenAPI and handler one by one; exercise actual call and negative effects via source-free client.
- **Test/exit:** All declared current HTTP routes have real/typed unavailable semantics with auth, schema, timeout and replay tests.
- **Predecessors:** `media.dev.domain-contract-parity`, `media.dev.canonical-job-reconciliation`

**`media.dev.grpc-operation-parity`** · OPEN
- **Where:** `modules/speech/stt-service`, `modules/speech/tts-service`, `modules/vision/vision-service`, `modules/intelligence/multimodal-service`, `libs/common`
- **What:** Implement all declared gRPC methods correctly with mTLS/JWT, bounded streaming and typed error mapping.
- **How:** Audit proto descriptors against servers and generated clients; route to actual engine or explicit unavailable without arbitrary stub success.
- **Test/exit:** 44 named RPCs plus proposal-only OCR route classified; consumer tests for all methods and auth/restart cases.
- **Predecessors:** `media.dev.domain-contract-parity`

**`media.dev.sdk-source-declaration-crosswalk`** · VERIFIED (AST crosswalk `.product-experience/pdp-3-product-experience/sdk/declaration-crosswalk.v1.json`: 60 public class-member declarations = 30 registry-backed + 2 overload signatures + 28 classified unregistered surface; 3 parser artifacts; ESM/CJS consumer checks green)
- **Where:** `.product-experience/pdp-3-product-experience/sdk/operation-registry.yaml`, `libs/audio-video-client/src`, `scripts/check-media-contract-parity.mjs`
- **What:** Resolve 60 observed declarations versus 33 registry rows without inventing 27 new public methods.
- **How:** Use TypeScript AST to enumerate class methods, exported functions, inherited/overloaded methods and compatibility exports; distinguish 3 known parser artifacts (for/if/clearTimeout), true public SDK and internal declarations; generate stable per-symbol crosswalk.
- **Test/exit:** Every real export classified, no parser tokens in registry, source-free ESM/CJS consumers pass, semantic source unchanged except reviewed crosswalk.
- **Predecessors:** `media.dev.domain-contract-parity`

**`media.dev.sdk-canonical-migration`** · OPEN
- **Where:** `libs/audio-video-client/src/operations.ts`, `libs/audio-video-client/src/canonical-operations.ts`, `libs/audio-video-client/src/index.ts`
- **What:** Align SDK methods with canonical routes without breaking legacy consumers.
- **How:** For each method verify request/response/auth/idempotency/finality; delegate only exact mappings; keep unsupported legacy method as typed NOT_ADMITTED until a real contract exists; deprecate after consumer tests.
- **Test/exit:** No fabricated route; no legacy success to missing path; backwards-compatible isolated package tests.
- **Predecessors:** `media.dev.sdk-source-declaration-crosswalk`, `media.dev.http-operation-parity`

**`media.dev.multimodal-legacy-route-disposition`** · VERIFIED (MPSEM-0023-C002 `observedRoute: none` + `historicalObservedRoute` retained; `analyzeMultimodal` throws before transport, zero-dispatch proven by dispositions test; strict + definition-only parity green; observation digest refreshed)
- **Where:** `.product-experience/interface-parity/operation-parity.yaml`, `scripts/check-media-contract-parity.mjs`, `tests/media-contract-parity-definition-only-cli.test.mjs`
- **What:** Resolve MPSEM-0023-C002 stale SDK route observation as an explicit non-dispatching compatibility method, not an active transport.
- **How:** Read live MediaOperationClient.analyzeMultimodal body and active route manifest; classify old /api/v1/media/multimodal-analyses as nonadmitted/absent; update exact parity observation, verifier logic and regression tests by review rather than changing expected strings alone.
- **Test/exit:** Strict parity green for this disposition with zero dispatch; real canonical multimodal processing remains separate until provider admissible.
- **Predecessors:** `media.dev.sdk-source-declaration-crosswalk`

**`media.dev.structured-cli`** · OPEN
- **Where:** `libs/audio-video-client/src`, `libs/media-experience-simulation/src/cli.ts`
- **What:** Provide real authenticated CLI for artifact/job/capture/recorder operations.
- **How:** Separate fixture command names from production CLI, strict JSON schema, exact exit codes, no sync job-success guessing; use the canonical SDK.
- **Test/exit:** Source-free binary tests with successful result, forbidden operations, timeout/UNKNOWN, schema error and process restart.
- **Predecessors:** `media.dev.sdk-canonical-migration`

**`media.dev.public-events`** · OPEN
- **Where:** `runtime-contracts`, `modules/infrastructure/messaging`, `adapters/agent-tools-media`
- **What:** Offer versioned, typed lifecycle events and consumer semantics.
- **How:** Map event schemas to public contracts and outbox, disclose redacted IDs only; nonfinal append never promises provider effect.
- **Test/exit:** Consumer test replay/out-of-order, auth and event payload ABI, distinct terminal job readback.
- **Predecessors:** `media.dev.transactional-event-outbox`

**`media.dev.authorized-agent-delegation`** · OPEN
- **Where:** `adapters/agent-tools-media/src/main/java/com/ghatana/audio/video/tools`, `launcher`, `runtime-contracts`
- **What:** Replace four handler NOT_ADMITTED-only paths with vetted delegation to Media canonical public ports.
- **How:** Host supplies verified Tools envelope/actor identity and current rights; binder claim before effect; map to canonical job submit/readback; reauthorize every replay and redact result.
- **Test/exit:** Four tools: real positive for qualified operation, duplicate, wrong tenant, revoked consent, ambiguous retry, no provider bypass.
- **Predecessors:** `media.dev.exclusive-invocation-claim-verification`, `media.dev.rights-and-policy`, `media.dev.canonical-job-reconciliation`

**`media.dev.optional-data-cloud-adapter`** · OPTIONAL_DEFERRED_NO_CORE_BLOCKER
- **Where:** `adapters/data-cloud-media`, `adapters/ledger`, `docs/surfaces/adapters-data-cloud-media/README.md`
- **What:** Keep Data Cloud entirely optional, with no role in core Media readiness.
- **How:** Retain legacy MediaProcessorPort as compatibility-unavailable because it lacks principal/sourceVersion/purpose/rights; offer a separate rights-bound read-model publication adapter only when opted-in by actual consumer; do not build Data Cloud OCR or job writer.
- **Test/exit:** No execution via legacy SPI, zero canonical state change on Data Cloud outage, standalone compile and negative tests.
- **Predecessors:** None; start independently

**`media.dev.web-host`** · OPEN
- **Where:** `libs/audio-video-ui/src/screens/MediaProductRenderer.tsx`, `libs/audio-video-client`, `launcher`
- **What:** Ship real authenticated product-host actions beyond the four implemented presentation families.
- **How:** Build typed SDK ports for all applicable 47 screens, route versioned actions to real backend, and render pending/denied/unknown/terminal states without fixture claims.
- **Test/exit:** Browser E2E against local backend, a11y/keyboard/responsive/tenant and visual regression.
- **Predecessors:** `media.dev.sdk-canonical-migration`, `media.dev.rights-and-policy`

**`media.dev.explorer-fidelity`** · VERIFIED (strict CSP, always-labeled simulated state, no live fetch, deterministic scenario replay, caption sync — `test/explorer-fidelity.test.mjs` green)
- **Where:** `apps/media-experience-explorer`, `libs/media-experience-simulation`, `.product-experience/pdp-3-product-experience`
- **What:** Keep 47-screen curated Explorer accurate and never imply backend admission.
- **How:** Reuse authored scenario package and narration metadata; preserve source screen IDs and clearly labeled simulated state; no live-service dependency.
- **Test/exit:** CSP, browser/a11y, deterministic scenario and narration/caption sync tests.
- **Predecessors:** None; start independently

**`media.dev.voice-workflow-ui`** · OPEN
- **Where:** `modules/intelligence/ai-voice/libs/ai-voice-ui-react`, `libs/audio-video-ui`
- **What:** Complete accessible voice/phrase/stem controls against real authorized TTS/voice operations.
- **How:** Connect typed player/mixer/training views to consent/revocation and actual selected engine; no sample output as live synthesis.
- **Test/exit:** Real hosted UI and consent negative, playback integrity, keyboard/a11y and responsive tests.
- **Predecessors:** `media.dev.web-host`

#### modalities

**`media.dev.native-media-dsp`** · OPEN
- **Where:** `modules/intelligence/speech/libs/speech-audio-rust/src/lib.rs`, `libs/java/common`
- **What:** Qualify bounded native audio decode/resample/mix and codec sample/clock accuracy.
- **How:** Reuse existing Blackman windowed-sinc, verify overflow/alias/long duration, native resource ownership; avoid second modality provider.
- **Test/exit:** Rust property/fuzz, codec roundtrip, stereo, alias rejection, peak RSS and JNI cross-process behavior.
- **Predecessors:** None; start independently

**`media.dev.shared-engine-consolidation`** · OPEN
- **Where:** `libs/java/common`, `libs/common`
- **What:** Deduplicate engine pools, security transport helpers and model/codec adapters safely.
- **How:** One ownership for Whisper/Piper/vision/native worker, TLS/JWT/deadline and errors; retain ABI until all installed consumers migrate.
- **Test/exit:** Source-free ABI, 4-service auth and no native leaks, test retries under cancellation.
- **Predecessors:** `media.dev.domain-contract-parity`

**`media.dev.stt-model-and-quality`** · OPEN
- **Where:** `modules/speech/stt-service`, `libs/java/common/src/main/java/com/ghatana/media/stt`, `config/qualification/common-voice-v27-asr-alternative.v1.json`
- **What:** Build a real source-pinned Whisper STT candidate and meaningful language quality suite.
- **How:** Prefer verified official OpenAI checkpoint + reproducible local ONNX export; verify license/model bytes/export tools; English/Nepali Common Voice benchmark plus separately consented app-domain refs; do not admit synthetic transcripts.
- **Test/exit:** Real WER/CER/latency, reference provenance, decoder EOT/PCM, failed model pin, no other actor content exposure.
- **Predecessors:** `media.dev.rights-and-policy`, `media.dev.native-media-dsp`

**`media.dev.stt-streaming-and-caption`** · OPEN
- **Where:** `modules/speech/stt-service`, `launcher/src/main/java/com/ghatana/media/launcher/MediaCaptionRuntime.java`, `providers/aws-postgresql`
- **What:** Finish bounded STT stream -> exact transcript revision -> correction/caption version flow.
- **How:** Use word PTS/locale, anonymous diarization, source rights and immutable parents; persist idempotent commit with provider-attempt fence.
- **Test/exit:** 12 STT RPCs, real audio, partial/final, gap/restart, corrected caption parent exact match, revoked rights.
- **Predecessors:** `media.dev.stt-model-and-quality`, `media.dev.canonical-job-reconciliation`, `media.dev.stream-session-authority`

**`media.dev.tts-model-and-rights`** · OPEN
- **Where:** `modules/speech/tts-service`, `libs/java/common/src/main/java/com/ghatana/media/tts`
- **What:** Make qualified lawful Piper voice profiles produce real decoded audio, not success-shaped placeholders.
- **How:** Choose specific voice/model/phoneme map with exact license/sha/locale/consent; bound SSML/prosody controls and explicit unavailable features; no unconsented voice clone.
- **Test/exit:** Decoded PCM checksum/duration/playback/reference, absent voice, revoke, unsupported locale/control, no cloned embedding leak.
- **Predecessors:** `media.dev.rights-and-policy`, `media.dev.shared-engine-consolidation`

**`media.dev.tts-streaming-and-finality`** · OPEN
- **Where:** `modules/speech/tts-service`, `providers/aws-postgresql`, `modules/audio-streaming`
- **What:** Stream lawful audio and persist output exactly once.
- **How:** Fence session chunking, backpressure/abort, source-version audio artifact and outbox; voice rights on every admission.
- **Test/exit:** gRPC synthesis/stream tests real bytes, zero output after revoke, lost ACK/restart and 1/16/64 clients.
- **Predecessors:** `media.dev.tts-model-and-rights`, `media.dev.canonical-job-reconciliation`, `media.dev.stream-session-authority`

**`media.dev.vision-model-and-geometry`** · OPEN
- **Where:** `modules/vision/vision-service`, `libs/java/common/src/main/java/com/ghatana/media/vision`
- **What:** Select legally usable pinned detector and finish real image/video geometry, tracking and OCI isolation.
- **How:** Reuse YOLOX/OCI broker and verify RGB/BGR, EXIF, rotation, inverse letterbox, frame/ROI/version/PTS; remove any synthetic provider fallback.
- **Test/exit:** Real bbox/classes, mAP/reference, VFR, multi-object tracking and worker OOM/PID/deadline/cancel tests.
- **Predecessors:** `media.dev.rights-and-policy`, `media.dev.shared-engine-consolidation`

**`media.dev.vision-document-intelligence`** · OPEN
- **Where:** `modules/vision/vision-service/src/main/java/com/ghatana/audio/video/vision/scenetext`, `libs/audio-video-client/src/authorized-scene-text.ts`
- **What:** Keep OCR inference exclusively in Ghatana Document Intelligence.
- **How:** Retain Media time/ROI and rights; send exact authorized crop/source digest to DI public contract; verify returned version/region and reject stale/forged results.
- **Test/exit:** Live supported DI client positive where available, stubbed negative/timeout/source change; no Media OCR engine.
- **Predecessors:** `media.dev.rights-and-policy`

**`media.dev.multimodal-child-orchestration`** · OPEN
- **Where:** `modules/intelligence/multimodal-service`, `launcher`
- **What:** Finish governed STT/Vision child fanout and durable typed parent result.
- **How:** Use `MediaCanonicalOperationExecutor` and `DelegatingMultimodalProvider`, common source/time, independent child attempt outcomes and bounded concurrency; do not invent missing child data.
- **Test/exit:** Real licensed child fusion, mismatched PTS/tenant/rights, crash/UNKNOWN/readback, one child unavailable and no false completed.
- **Predecessors:** `media.dev.stt-streaming-and-caption`, `media.dev.vision-model-and-geometry`, `media.dev.canonical-job-reconciliation`

**`media.dev.multimodal-grounding-and-quality`** · OPEN
- **Where:** `modules/intelligence/multimodal-service`
- **What:** Ensure fused observations are source-grounded with calibrated or expressly uncalibrated quality.
- **How:** Bind spans/regions/PTS and provenance to exact immutable versions, distinguish observed evidence and inferred relation; no biometric identity without rights.
- **Test/exit:** Ambiguous clock, conflicting child outputs, confidence provenance, replay and threshold tests.
- **Predecessors:** `media.dev.multimodal-child-orchestration`

**`media.dev.load-and-quality-profiles`** · OPEN
- **Where:** `audio-video-observability`, `integration-tests`, `modules/speech`, `modules/vision`, `modules/intelligence`
- **What:** Measure real reference, speed, memory and saturation for all admitted modalities.
- **How:** Choose explicit per-locale/model/host profile and 1/16/64 concurrency budgets; preserve comparison fixtures and fail-closed readiness metrics.
- **Test/exit:** Real baseline/heldout, load/deadline/FD/memory/timeout; no claimed quality for missing measurements.
- **Predecessors:** `media.dev.stt-model-and-quality`, `media.dev.tts-model-and-rights`, `media.dev.vision-model-and-geometry`

#### capture

**`media.dev.capture-http-and-file-regression`** · VERIFIED (existing adapters preserved; per-hop redirect revalidation, origin allowlist, realpath containment, byte bounds — 381 vitest baseline + adversarial cases + isolated package consumer green)
- **Where:** `libs/audio-video-client/src/http-capture-adapter.ts`, `libs/audio-video-client/src/file-capture-adapter.ts`, `libs/audio-video-client/src/recorder-orchestrator.ts`
- **What:** Preserve existing real HTTP and file capture (do not reimplement) and verify secure E2E behavior.
- **How:** Review content bounds, redirects, TLS/SSRF, file roots, symlinks, sourceVersion/rights/clock echo and recapture with real bytes.
- **Test/exit:** Existing 381-client-suite baseline plus security adversarial cases and isolated package tests.
- **Predecessors:** None; start independently

**`media.dev.browser-source-capture`** · OPEN
- **Where:** `libs/audio-video-client/src/capture-adapters.ts`, `apps/media-experience-explorer`, `libs/audio-video-ui`
- **What:** Implement browser DOM/screen capture through approved host-controlled adapter.
- **How:** Use Playwright/MediaRecorder supported capture, exact viewport/scroll/clock and origin permission, deterministic frame bytes, no arbitrary browser privilege.
- **Test/exit:** Permission revoked, hidden/overlay, CSP, clock drift, source-version mismatch and actual video playback.
- **Predecessors:** `media.dev.capture-http-and-file-regression`

**`media.dev.desktop-source-capture`** · OPEN
- **Where:** `libs/audio-video-client/src/capture-adapters.ts`, `modules/intelligence/ai-voice`
- **What:** Implement opt-in desktop/window capture without resurrecting archived Tauri backend.
- **How:** Host adapter behind OS capture rights, source and crop geometry, device changes and cancellation, no secret/window leakage.
- **Test/exit:** Real desktop source fixture, permission denial, display change, no pixels after revoke.
- **Predecessors:** `media.dev.capture-http-and-file-regression`

**`media.dev.mobile-source-capture`** · OPEN
- **Where:** `libs/audio-video-client/src/capture-adapters.ts`
- **What:** Implement mobile device capture through supported device/host remote contract.
- **How:** Honor device-specific permissions, frame clock, foreground/background and reconnect; isolate camera/video data under consent.
- **Test/exit:** Device/web-emulator E2E for denied permission, background, reconnect and real frame payload.
- **Predecessors:** `media.dev.capture-http-and-file-regression`

**`media.dev.terminal-source-capture`** · OPEN
- **Where:** `libs/audio-video-client/src/capture-adapters.ts`
- **What:** Implement bounded terminal transcript/viewport recording.
- **How:** Capture only explicit session/PTY, redact secrets, normalize ANSI/terminal geometry, preserve timing and close on detach.
- **Test/exit:** TTY resize, escape injection, secret redaction, cancellation, no off-session capture.
- **Predecessors:** `media.dev.capture-http-and-file-regression`

**`media.dev.grpc-source-capture`** · OPEN
- **Where:** `libs/audio-video-client/src/capture-adapters.ts`, `modules/audio-streaming`, `modules/video-streaming`
- **What:** Capture authorized gRPC stream sources without replacing the canonical session writer.
- **How:** Use authenticated stream cursor/PTS and bounded backpressure; return no frames on unknown/denied readback.
- **Test/exit:** Stream gap, revoke, lost ACK, reorder, EOS and exact source-version tests.
- **Predecessors:** `media.dev.stream-session-authority`

**`media.dev.camera-source-capture`** · OPEN
- **Where:** `libs/audio-video-client/src/capture-adapters.ts`, `modules/video-streaming`
- **What:** Implement camera source intake with permission and device-state handling.
- **How:** Host camera permission and actual encoder with bounded buffers, camera/mic indicators, timestamps and hot unplug recovery.
- **Test/exit:** Consent revoked midframe, device switch, no leaked capture and PTS ordering.
- **Predecessors:** `media.dev.stream-session-authority`

**`media.dev.recorder-actual-execution`** · OPEN
- **Where:** `libs/audio-video-client/src/recorder-orchestrator.ts`, `runtime-contracts`
- **What:** Execute admitted scenario captures unattended with deterministic selective recapture.
- **How:** Use existing `orchestrateScenario` and `recaptureScenario`, schedule bounded adapters and record real source digest/scene revision/attempt outcome; never coerce UNKNOWN.
- **Test/exit:** Two-run identical scenes skip, changed scene alone recaptures, provider denies and lost ACK leave honest status.
- **Predecessors:** `media.dev.capture-http-and-file-regression`

**`media.dev.recorder-narration-and-captions`** · OPEN
- **Where:** `libs/audio-video-client/src/recorder-orchestrator.ts`, `libs/media-experience-simulation`
- **What:** Bind scenario cue times to real captured frames and legitimate narration.
- **How:** Use deterministic timebase and approved TTS or user-provided narration, redact private content and generate validated VTT/TTML captions.
- **Test/exit:** Cue offset/seek/cancel, no unsupported voice substitution, captions readable and frame-aligned.
- **Predecessors:** `media.dev.recorder-actual-execution`

**`media.dev.recorder-mux-and-final-artifact`** · OPEN
- **Where:** `libs/audio-video-client/src/recorder-orchestrator.ts`, `modules/production/rendering`
- **What:** Produce actual decodable, versioned recording including narration, subtitles and credits.
- **How:** Mux qualified image/audio streams with deterministic FPS or VFR, timebase, content hash and source lineage; publish via canonical Media artifact store.
- **Test/exit:** Actual file playable, ffprobe/decoder accurate, caption timing, partial export rollback and duplicate render fence.
- **Predecessors:** `media.dev.recorder-narration-and-captions`, `media.dev.canonical-artifact-storage`

#### creative

**`media.dev.project-timeline-engine`** · OPEN
- **Where:** `runtime-contracts`, `modules/production/timeline`, `libs/audio-video-ui`
- **What:** Create single-authority creative project/scene/clip/track graph and revisioned edits.
- **How:** Reuse immutable Media artifact refs, rational composition clock and CAS; define deterministic edit/undo/diff and no second client source-of-truth.
- **Test/exit:** Edit algebra, conflicting version, undo/redo, source revocation, long-duration no clock drift.
- **Predecessors:** `media.dev.domain-contract-parity`, `media.dev.canonical-artifact-storage`

**`media.dev.storyboard-and-shot-plan`** · OPEN
- **Where:** `modules/production/timeline`, `runtime-contracts`, `libs/audio-video-ui`
- **What:** Turn a brief into versioned storyboard/shot plan with asset rights.
- **How:** Use deterministic scene spec, source refs and explicit optional model generation step; persist draft/reviewed immutable editions.
- **Test/exit:** Scene ordering, rights, story time, stale edit and no fake renderer readiness.
- **Predecessors:** `media.dev.project-timeline-engine`

**`media.dev.animation-2d-renderer`** · OPEN
- **Where:** `libs/java/common/src/main/java/com/ghatana/media/production/AnimationSpecCompiler.java`, `modules/production/animation`
- **What:** Implement real 2D/vector/procedural frame rendering on current AnimationSpec parser.
- **How:** Compile typed curves/transforms/asset references into bounded raster/vector frames with exact story time; no effect-free plan mistaken for render.
- **Test/exit:** Golden frames, easing/units/overflow/fps, renderer errors and codec playback.
- **Predecessors:** `media.dev.project-timeline-engine`

**`media.dev.animation-3d-rig-and-spatial`** · OPEN
- **Where:** `modules/production/spatial`, `runtime-contracts`
- **What:** Implement real 3D rig/path animation and coordinate-transform pipeline.
- **How:** Select bounded renderer backend after reusable-engine review; implement skeleton transforms, interpolation, camera/scene graph, spatial metadata and export.
- **Test/exit:** Rig/joint constraints, reference poses, coordinate roundtrip, source rights, decodable spatial output.
- **Predecessors:** `media.dev.project-timeline-engine`

**`media.dev.scientific-simulation-engine`** · OPEN
- **Where:** `modules/production/simulation`, `runtime-contracts`
- **What:** Implement typed domain simulation with real solver, observables and uncertainty.
- **How:** Reuse numerical engine where possible; enforce SI units, integration scheme, step tolerance, bounded iterations and instrument views.
- **Test/exit:** Newton m=2kg F=6N t=2s -> a=3,v=6,x=6; dimensional/step convergence, conservation/uncertainty negative.
- **Predecessors:** `media.dev.project-timeline-engine`

**`media.dev.simulation-semantic-validation`** · OPEN
- **Where:** `modules/production/simulation`, `libs/media-experience-simulation`
- **What:** Validate each procedural/simulation pass against declared semantic invariants.
- **How:** Distinguish simulation physics from visual animation, fail or ABSTAIN when model/units/constraints unavailable; version all pass inputs.
- **Test/exit:** Unstable solver, incompatible units, incomplete references, repeatability and no fabricated measurement.
- **Predecessors:** `media.dev.scientific-simulation-engine`

**`media.dev.audio-repair-and-comparison`** · OPEN
- **Where:** `modules/production/audio-mixing`, `modules/intelligence/speech/libs/speech-audio-rust`
- **What:** Implement real bounded denoise/declip and source-preserving comparison.
- **How:** Use selected DSP algorithms with transparent loss/quality metrics and immutable A/B revisions.
- **Test/exit:** SNR/clip/phase/reference tests, silence, drift, checksum and undo.
- **Predecessors:** `media.dev.native-media-dsp`, `media.dev.project-timeline-engine`

**`media.dev.video-restoration-and-comparison`** · OPEN
- **Where:** `modules/production/rendering`, `modules/vision/vision-service`
- **What:** Implement honest video noise/blur/color restoration with measured A/B output.
- **How:** Select actual codec/image filters, preserve frame order/timebase/ROI and source revisions; expose fidelity and loss bounds.
- **Test/exit:** Reference frame set, perceptual metric+PSNR where meaningful, no resolution/quality false claim.
- **Predecessors:** `media.dev.vision-model-and-geometry`

**`media.dev.reference-guided-generation`** · OPEN
- **Where:** `modules/production/timeline`, `modules/production/rendering`
- **What:** Generate source-conditioned scenes only with rights and real model or deterministic authored templates.
- **How:** Bind prompts/references/version/continuity checks, call admitted AI Inference public API when available, otherwise typed unavailable.
- **Test/exit:** No unauthorized reference use, seed/content provenance, continuity, model unavailable and truthful failure.
- **Predecessors:** `media.dev.storyboard-and-shot-plan`

**`media.dev.tracked-region-reversible-edits`** · OPEN
- **Where:** `modules/production/timeline`, `modules/vision/vision-service`, `libs/audio-video-ui`
- **What:** Apply tracked ROI edits with immutable source and revision-specific undo.
- **How:** Track PTS and mask coordinates through original->edited frame transforms; CAS edit commit and source-rights refresh.
- **Test/exit:** Mask/bbox drift, VFR, undo exact bytes/metadata, stale editor conflict.
- **Predecessors:** `media.dev.project-timeline-engine`, `media.dev.vision-model-and-geometry`

**`media.dev.dubbing-and-translation`** · OPEN
- **Where:** `modules/production/dubbing`, `modules/speech/stt-service`, `modules/speech/tts-service`
- **What:** Produce real translated/dubbed audio bound to source transcript timing.
- **How:** Use admitted translation public capability, legal TTS voice, source/locale revision and forced alignment; label unavailable language/control.
- **Test/exit:** Actual intelligible output, word time alignment, no clone/translation if unadmitted, visual lip timing metadata.
- **Predecessors:** `media.dev.stt-streaming-and-caption`, `media.dev.tts-streaming-and-finality`

**`media.dev.foley-stems-mix-master`** · OPEN
- **Where:** `modules/production/audio-mixing`, `modules/intelligence/speech/libs/speech-audio-rust`
- **What:** Produce rights-cleared original audio stems and final master.
- **How:** Define audio stem version refs, gain/pan/loudness/peak, deterministic sample clock and preview/render; reject clips and unlicensed content.
- **Test/exit:** Stereo reference, true peak, no clipping, silence/large inputs, final decodable audio.
- **Predecessors:** `media.dev.native-media-dsp`, `media.dev.project-timeline-engine`

**`media.dev.multitrack-composition-render`** · OPEN
- **Where:** `modules/production/rendering`, `libs/audio-video-ui`
- **What:** Render combined clips, narration, captions, graphics, audio and color accurately.
- **How:** Implement bounded media graph -> FFmpeg/qualified codec pipeline, VFR time map, subtitle mux, transition effects, exact output digest.
- **Test/exit:** Playable mux and audio/visual/caption sync, cancellation/partial result/space budget.
- **Predecessors:** `media.dev.project-timeline-engine`, `media.dev.animation-2d-renderer`, `media.dev.foley-stems-mix-master`

**`media.dev.quality-comparison-and-optimization`** · OPEN
- **Where:** `modules/production/rendering`, `audio-video-observability`, `libs/audio-video-ui`
- **What:** Measure quality from real outputs and apply bounded reversible optimization.
- **How:** Separate independent metrics from heuristics, retain source and candidate versions and declared caps; no fabricated improvement.
- **Test/exit:** Reference metrics/golden compare, invalid bounds, multiple attempts, deterministic report, undo.
- **Predecessors:** `media.dev.multitrack-composition-render`

**`media.dev.versioned-review-and-approval`** · OPEN
- **Where:** `modules/production/review`, `libs/audio-video-ui`, `runtime-contracts`
- **What:** Implement review/comments/approval on exact immutable revision only.
- **How:** CAS reviewers and roles, invalidation on any material edit, annotation time/ROI, redacted disclosures.
- **Test/exit:** Stale approval, wrong role, simultaneous edit, retention and revision identity.
- **Predecessors:** `media.dev.project-timeline-engine`, `media.dev.rights-and-policy`

**`media.dev.delivery-export-destination-ack`** · OPEN
- **Where:** `modules/production/delivery`, `launcher`, `providers/aws-postgresql`
- **What:** Implement download/export/publication with exact destination acknowledgment.
- **How:** Produce bounded immutable artifact; sign scoped transfer; distinguish queued/sent/destination confirmed; never infer from transport 201.
- **Test/exit:** Wrong destination, lost ACK, token revoke, duplicate export, checksum and resume.
- **Predecessors:** `media.dev.multitrack-composition-render`, `media.dev.versioned-review-and-approval`

**`media.dev.offline-reconnect`** · OPEN
- **Where:** `modules/production/delivery`, `libs/audio-video-client`, `libs/audio-video-ui`
- **What:** Support private local edits/capture with safe reconnect and conflict reconciliation.
- **How:** Bound encrypted offline queue per tenant/project, renew rights before push, compare version and idempotency; never replay after revoke.
- **Test/exit:** Offline dirty state, conflict resolution, stale authorization, loss/retry and no duplicate effect.
- **Predecessors:** `media.dev.sdk-canonical-migration`, `media.dev.project-timeline-engine`

**`media.dev.spatial-and-interactive-export`** · OPEN
- **Where:** `modules/production/spatial`, `modules/production/rendering`, `libs/audio-video-ui`
- **What:** Export real 360/spatial/interactive content with accurate fidelity reporting.
- **How:** Map projection/coordinate systems and timelines into supported file format/player; explicitly declare loss or unavailable features.
- **Test/exit:** Decode, image orientation, timestamps/coordinates, viewer parity and zero invented spatial metadata.
- **Predecessors:** `media.dev.animation-3d-rig-and-spatial`

**`media.dev.interactive-demo-player`** · OPEN
- **Where:** `libs/audio-video-ui/src/player`, `libs/media-experience-simulation`, `libs/audio-video-client`
- **What:** Implement sandboxed branching player for authored interactive demo and real outputs.
- **How:** Use deterministic branch/seek/cue state machine, origin-bound permissions and simulated-vs-live label; strict keyboard/screen-reader controls.
- **Test/exit:** Branch replay/seek, cross-origin denial, stale asset/caption, a11y and live-vs-curated truth.
- **Predecessors:** `media.dev.web-host`, `media.dev.explorer-fidelity`

**`media.dev.production-studio-host`** · OPEN
- **Where:** `libs/audio-video-ui`, `launcher`
- **What:** Ship professional Studio over one canonical revision with timeline/edit/render/review/export.
- **How:** Combine typed hooks for project graph, preview, 2D/3D/sim/audio and version-specific approvals; missing engines show truthful unavailable.
- **Test/exit:** Actual J09/J11/J12/J18/J21/J22 UI journeys, a11y, visual regression and backend state consistency.
- **Predecessors:** `media.dev.project-timeline-engine`, `media.dev.multitrack-composition-render`, `media.dev.versioned-review-and-approval`, `media.dev.web-host`

#### verification

**`media.dev.cross-surface-integration-harness`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `apps/media-experience-explorer`
- **What:** Establish deterministic source-free client/host end-to-end tests for every supported workflow.
- **How:** Use Postgres/S3 + fake authority for negatives and permitted real provider for positives; compose rather than rerun module unit suites; inject crash at boundaries.
- **Test/exit:** Test selectors for J01–J30, grants/denials/UNKNOWN/restart and actual output checks.
- **Predecessors:** `media.dev.canonical-job-reconciliation`, `media.dev.sdk-canonical-migration`

#### hygiene

**`media.dev.surface-document-contracts`** · VERIFIED (all 56 READMEs reconcile via `check:surface-docs`; stale nonexistent-type citations corrected)
- **Where:** `docs/surfaces`, `docs/development/SURFACE-IMPLEMENTATION-PLAN.md`
- **What:** Reconcile 56 existing surface READMEs with actual operations, states, diagrams and tests.
- **How:** Use current source and exact public implementation, replace stale pending assertions; remove phase/batch context from internal names except semantic immutable IDs.
- **Test/exit:** Every doc links an existing owner/test, no false completion or missing runtime caveats.
- **Predecessors:** `media.dev.source-capability-crosswalk`

**`media.dev.historical-artifact-inventory`** · VERIFIED (all 999MB tracked historical bytes classified — `generate:historical-inventory`; 42 large unreferenced artifacts flagged EXTERNAL_ARCHIVE for owner review, zero deletions)
- **Where:** `docs/implementation`, `scripts/audit-media-repository.mjs`
- **What:** Classify 995 MB of implementation artifacts and all pinned preimages before removals.
- **How:** Generate path-by-path hash, inbound references, source-vs-derived-vs-record, restore requirements and retention ownership; mark DELETE/KEEP/EXTERNAL_ARCHIVE with reason.
- **Test/exit:** Zero unclassified tracked historical bytes; read-only report and no unreviewed deletions.
- **Predecessors:** None; start independently

**`media.dev.historical-artifact-retirement`** · OPEN
- **Where:** `docs/implementation`, `.ghatana`, `.product-experience`, `docs/README.md`
- **What:** Remove superseded plans/logs/snapshots from active source after exact preservation plan.
- **How:** Move retention-required copies to authenticated immutable off-main store with verified hashes and durable pointer; use Git history only where enough; update every pinned reference and test.
- **Test/exit:** No broken links/pins; canonical authored definitions still present; Git tree materially reduced without lost source.
- **Predecessors:** `media.dev.historical-artifact-inventory`

**`media.dev.contextual-name-and-legacy-removal`** · OPEN
- **Where:** `AGENTS.md`, `README.md`, `docs`, `scripts`, `libs`, `modules`, `archive`
- **What:** Replace dated/batch/phase internal scaffolding with meaningful paths and delete dead code.
- **How:** Scan imports/package exports/Gradle/tsconfig/scripts; classify deprecated, compatibility, temporary; preserve stable public/DB/PDP IDs and run source-free consumers before retirement.
- **Test/exit:** Zero orphan modules, dead production mocks and unsupported preview deployment paths; builds and test selectors resolve.
- **Predecessors:** `media.dev.surface-document-contracts`, `media.dev.historical-artifact-inventory`

**`media.dev.documentation-and-command-navigation`** · VERIFIED (single Start-here selector, all maintained-doc links resolve, implementation vs BUILD lanes separated — `tests/media-documentation-entrypoint.test.mjs` green)
- **Where:** `README.md`, `docs/README.md`, `AGENTS.md`, `package.json`, `settings.gradle.kts`
- **What:** Make one current intent-based entrypoint with runnable bounded tests and authoritative links.
- **How:** Link development plan and remaining tasks; isolate legacy histories and lifecycle docs from the implementation selector; avoid duplicate active plans.
- **Test/exit:** Entry links valid, no stale historical 'do next' instruction in maintained docs.
- **Predecessors:** `media.dev.surface-document-contracts`

#### journeys

**`media.dev.outcome-first-use-project`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-01 — Real sign-in/workspace/project revision; wrong tenant, duplicate create.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.canonical-job-reconciliation`, `media.dev.web-host`

**`media.dev.outcome-resumable-artifact-intake`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-02 — Real chunked upload/versioned artifact and corrupt/resume/restart.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.canonical-artifact-storage`, `media.dev.web-host`

**`media.dev.outcome-transcript-to-reviewed-captions`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-03 — Real licensed audio -> transcript revision -> corrected caption; revoke/UNKNOWN/restart.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.stt-streaming-and-caption`, `media.dev.web-host`

**`media.dev.outcome-authorized-voice-synthesis`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-04 — Lawful voice -> real decoded audio; denied locale/profile/revoke.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.tts-streaming-and-finality`, `media.dev.voice-workflow-ui`

**`media.dev.outcome-vision-detection-and-tracking`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-05 — Actual image/video geometry+track source PTS; malformed ROI.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.vision-model-and-geometry`

**`media.dev.outcome-grounded-cross-modal-result`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-06 — Real STT/Vision+DI child -> grounded typed response; wrong clock/rights.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.multimodal-grounding-and-quality`

**`media.dev.outcome-audio-restoration`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-07 — Real denoise/declip measured A/B with source preservation.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.audio-repair-and-comparison`

**`media.dev.outcome-video-enhancement`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-08 — Real codec/frame repair and independent measured comparison.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.video-restoration-and-comparison`

**`media.dev.outcome-brief-to-reviewed-media`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-09 — Versioned brief/storyboard -> render -> review output.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.storyboard-and-shot-plan`, `media.dev.production-studio-host`

**`media.dev.outcome-reference-continuity`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-10 — Rights-checked conditioned output, continuity metrics and typed unavailability.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.reference-guided-generation`

**`media.dev.outcome-reversible-tracked-edit`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-11 — Real tracked ROI mask edit with precise version CAS and undo.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.tracked-region-reversible-edits`

**`media.dev.outcome-two-dimensional-animation`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-12 — Deterministic 2D animation renders decodable frames and golden curves.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.animation-2d-renderer`

**`media.dev.outcome-three-dimensional-animation`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-13 — Rig/3D spatial render with coordinate/kinematic correctness.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.animation-3d-rig-and-spatial`

**`media.dev.outcome-scientific-simulation`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-14 — Unit-correct dynamics and instrument values; solver negatives.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.scientific-simulation-engine`

**`media.dev.outcome-validated-simulation-pass`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-15 — Executable constrained pass with semantic validity and abstention.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.simulation-semantic-validation`

**`media.dev.outcome-translated-dubbed-video`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-16 — Actual translation+legal dubbing, lip/timing metadata and source rights.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.dubbing-and-translation`

**`media.dev.outcome-music-effects-master`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-17 — Playable stems/foley/mix master with lawful input and peak caps.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.foley-stems-mix-master`

**`media.dev.outcome-multitrack-finished-master`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-18 — Combined video+audio+caption+graphic color render with checksum.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.multitrack-composition-render`

**`media.dev.outcome-bounded-quality-improvement`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-19 — Real quality metric and bounded optimization/reversible comparison.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.quality-comparison-and-optimization`

**`media.dev.outcome-durable-job-recovery`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-20 — Job pending/running/UNKNOWN/terminal across real process restart.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.canonical-job-reconciliation`

**`media.dev.outcome-version-specific-review`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-21 — Immutable-review approval invalidated by changed source revision.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.versioned-review-and-approval`

**`media.dev.outcome-acknowledged-delivery`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-22 — Actual export/publish destination ACK, lost-ACK reconciliation.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.delivery-export-destination-ack`

**`media.dev.outcome-offline-conflict-reconnect`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-23 — Encrypted offline edits, fresh-rights reconnect, version conflict handling.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.offline-reconnect`

**`media.dev.outcome-structured-command-batch`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-24 — Authenticated CLI JSON batch with true finality and typed failures.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.structured-cli`

**`media.dev.outcome-authorized-agent-outcome`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-25 — Four agent handlers authorized delegate, no duplicate side effects.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.authorized-agent-delegation`

**`media.dev.outcome-retention-and-erasure`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-26 — Real revoke/hold/deletion and no post-erasure disclosure.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.rights-and-policy`, `media.dev.canonical-artifact-storage`

**`media.dev.outcome-provider-outage-safe-path`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-27 — Unavailable/degraded/no-fallback/UNKNOWN behavior without fake success.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.canonical-job-reconciliation`, `media.dev.service-observability`

**`media.dev.outcome-spatial-interactive-delivery`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-28 — Real 360/spatial/interactive export and viewer fidelity.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.spatial-and-interactive-export`, `media.dev.interactive-demo-player`

**`media.dev.outcome-live-session-recovery`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-29 — Real media loss/reconnect/consent revoke and bounded stream recovery.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.stream-session-authority`

**`media.dev.outcome-eligible-provider-catalog`** · OPEN
- **Where:** `integration-tests`, `modules/integration-tests`, `libs/audio-video-ui`
- **What:** J-30 — Real qualified model/voice/host readiness with unavailable cases.
- **How:** Drive the authored scenario via a source-free client or real hosted UI using existing physical surfaces; bind immutable source/tenant/rights/job and exact observable effect; inject denial, cancellation, ambiguity and restart.
- **Test/exit:** Reproducible genuine terminal result and fault suite; fixture-only simulation never counts.
- **Predecessors:** `media.dev.service-observability`, `media.dev.stt-model-and-quality`, `media.dev.tts-model-and-rights`, `media.dev.vision-model-and-geometry`

## Surface-by-surface accountability (all 56 source identities)

Each entry below points to at least one concrete task. Physical support/subsumed nodes are not separate deployables; the desktop archive is not active. Compositions require their own true cross-child test; no automated lifecycle status is inferred.

| Source surface | Kind / disposition | Bound engineering tasks |
| --- | --- | --- |
| `media.physical.adapters-agent-tools-media` | physical / SUPPORT_ONLY | `media.dev.exclusive-invocation-claim-verification`, `media.dev.invocation-store-security`, `media.dev.public-events`, `media.dev.authorized-agent-delegation` |
| `media.physical.adapters-data-cloud-media` | physical / PHYSICAL | `media.dev.projection-single-writer-policy`, `media.dev.optional-data-cloud-adapter` |
| `media.physical.adapters-ledger` | physical / SUPPORT_ONLY | `media.dev.projection-pre-dispatch-fence-verification`, `media.dev.projection-single-writer-policy`, `media.dev.optional-data-cloud-adapter` |
| `media.physical.apps-media-experience-explorer` | physical / PHYSICAL | `media.dev.explorer-fidelity`, `media.dev.browser-source-capture`, `media.dev.cross-surface-integration-harness` |
| `media.physical.audio-video-observability` | physical / SUPPORT_ONLY | `media.dev.service-observability`, `media.dev.load-and-quality-profiles`, `media.dev.quality-comparison-and-optimization` |
| `media.physical.integration-tests` | physical / SUPPORT_ONLY | `media.dev.load-and-quality-profiles`, `media.dev.cross-surface-integration-harness`, `media.dev.outcome-first-use-project`, `media.dev.outcome-resumable-artifact-intake`, `media.dev.outcome-transcript-to-reviewed-captions`, `media.dev.outcome-authorized-voice-synthesis`, `media.dev.outcome-vision-detection-and-tracking`, `media.dev.outcome-grounded-cross-modal-result`, `media.dev.outcome-audio-restoration`, `media.dev.outcome-video-enhancement`, `media.dev.outcome-brief-to-reviewed-media`, `media.dev.outcome-reference-continuity`, `media.dev.outcome-reversible-tracked-edit`, `media.dev.outcome-two-dimensional-animation`, `media.dev.outcome-three-dimensional-animation`, `media.dev.outcome-scientific-simulation`, `media.dev.outcome-validated-simulation-pass`, `media.dev.outcome-translated-dubbed-video`, `media.dev.outcome-music-effects-master`, `media.dev.outcome-multitrack-finished-master`, `media.dev.outcome-bounded-quality-improvement`, `media.dev.outcome-durable-job-recovery`, `media.dev.outcome-version-specific-review`, `media.dev.outcome-acknowledged-delivery`, `media.dev.outcome-offline-conflict-reconnect`, `media.dev.outcome-structured-command-batch`, `media.dev.outcome-authorized-agent-outcome`, `media.dev.outcome-retention-and-erasure`, `media.dev.outcome-provider-outage-safe-path`, `media.dev.outcome-spatial-interactive-delivery`, `media.dev.outcome-live-session-recovery`, `media.dev.outcome-eligible-provider-catalog` |
| `media.physical.launcher` | physical / PHYSICAL | `media.dev.rights-and-policy`, `media.dev.canonical-artifact-storage`, `media.dev.canonical-job-reconciliation`, `media.dev.transactional-event-outbox`, `media.dev.rights-aware-cache`, `media.dev.stream-session-authority`, `media.dev.service-observability`, `media.dev.http-operation-parity`, `media.dev.authorized-agent-delegation`, `media.dev.web-host`, `media.dev.stt-streaming-and-caption`, `media.dev.multimodal-child-orchestration`, `media.dev.delivery-export-destination-ack`, `media.dev.production-studio-host` |
| `media.physical.libs-audio-video-client` | physical / PHYSICAL | `media.dev.sdk-source-declaration-crosswalk`, `media.dev.sdk-canonical-migration`, `media.dev.structured-cli`, `media.dev.web-host`, `media.dev.vision-document-intelligence`, `media.dev.capture-http-and-file-regression`, `media.dev.browser-source-capture`, `media.dev.desktop-source-capture`, `media.dev.mobile-source-capture`, `media.dev.terminal-source-capture`, `media.dev.grpc-source-capture`, `media.dev.camera-source-capture`, `media.dev.recorder-actual-execution`, `media.dev.recorder-narration-and-captions`, `media.dev.recorder-mux-and-final-artifact`, `media.dev.offline-reconnect`, `media.dev.interactive-demo-player` |
| `media.physical.libs-audio-video-types` | physical / PHYSICAL | `media.dev.domain-contract-parity` |
| `media.physical.libs-audio-video-ui` | physical / PHYSICAL | `media.dev.web-host`, `media.dev.voice-workflow-ui`, `media.dev.browser-source-capture`, `media.dev.project-timeline-engine`, `media.dev.storyboard-and-shot-plan`, `media.dev.tracked-region-reversible-edits`, `media.dev.multitrack-composition-render`, `media.dev.quality-comparison-and-optimization`, `media.dev.versioned-review-and-approval`, `media.dev.offline-reconnect`, `media.dev.spatial-and-interactive-export`, `media.dev.interactive-demo-player`, `media.dev.production-studio-host`, `media.dev.outcome-first-use-project`, `media.dev.outcome-resumable-artifact-intake`, `media.dev.outcome-transcript-to-reviewed-captions`, `media.dev.outcome-authorized-voice-synthesis`, `media.dev.outcome-vision-detection-and-tracking`, `media.dev.outcome-grounded-cross-modal-result`, `media.dev.outcome-audio-restoration`, `media.dev.outcome-video-enhancement`, `media.dev.outcome-brief-to-reviewed-media`, `media.dev.outcome-reference-continuity`, `media.dev.outcome-reversible-tracked-edit`, `media.dev.outcome-two-dimensional-animation`, `media.dev.outcome-three-dimensional-animation`, `media.dev.outcome-scientific-simulation`, `media.dev.outcome-validated-simulation-pass`, `media.dev.outcome-translated-dubbed-video`, `media.dev.outcome-music-effects-master`, `media.dev.outcome-multitrack-finished-master`, `media.dev.outcome-bounded-quality-improvement`, `media.dev.outcome-durable-job-recovery`, `media.dev.outcome-version-specific-review`, `media.dev.outcome-acknowledged-delivery`, `media.dev.outcome-offline-conflict-reconnect`, `media.dev.outcome-structured-command-batch`, `media.dev.outcome-authorized-agent-outcome`, `media.dev.outcome-retention-and-erasure`, `media.dev.outcome-provider-outage-safe-path`, `media.dev.outcome-spatial-interactive-delivery`, `media.dev.outcome-live-session-recovery`, `media.dev.outcome-eligible-provider-catalog` |
| `media.physical.libs-common` | physical / SUBSUMED | `media.dev.grpc-operation-parity`, `media.dev.shared-engine-consolidation` |
| `media.physical.libs-java-common` | physical / SUBSUMED | `media.dev.native-media-dsp`, `media.dev.shared-engine-consolidation`, `media.dev.stt-model-and-quality`, `media.dev.tts-model-and-rights`, `media.dev.vision-model-and-geometry`, `media.dev.animation-2d-renderer` |
| `media.physical.libs-media-experience-simulation` | physical / SUPPORT_ONLY | `media.dev.structured-cli`, `media.dev.explorer-fidelity`, `media.dev.recorder-narration-and-captions`, `media.dev.simulation-semantic-validation`, `media.dev.interactive-demo-player` |
| `media.physical.modules-audio-streaming` | physical / SUPPORT_ONLY | `media.dev.stream-session-authority`, `media.dev.tts-streaming-and-finality`, `media.dev.grpc-source-capture` |
| `media.physical.modules-infrastructure-cache` | physical / SUPPORT_ONLY | `media.dev.rights-aware-cache` |
| `media.physical.modules-infrastructure-messaging` | physical / SUPPORT_ONLY | `media.dev.transactional-event-outbox`, `media.dev.public-events` |
| `media.physical.modules-infrastructure-persistence` | physical / SUPPORT_ONLY | `media.dev.canonical-artifact-storage`, `media.dev.database-upgrade-compatibility` |
| `media.physical.modules-infrastructure-security` | physical / SUPPORT_ONLY | `media.dev.rights-and-policy` |
| `media.physical.modules-integration-tests` | physical / SUPPORT_ONLY | `media.dev.cross-surface-integration-harness`, `media.dev.outcome-first-use-project`, `media.dev.outcome-resumable-artifact-intake`, `media.dev.outcome-transcript-to-reviewed-captions`, `media.dev.outcome-authorized-voice-synthesis`, `media.dev.outcome-vision-detection-and-tracking`, `media.dev.outcome-grounded-cross-modal-result`, `media.dev.outcome-audio-restoration`, `media.dev.outcome-video-enhancement`, `media.dev.outcome-brief-to-reviewed-media`, `media.dev.outcome-reference-continuity`, `media.dev.outcome-reversible-tracked-edit`, `media.dev.outcome-two-dimensional-animation`, `media.dev.outcome-three-dimensional-animation`, `media.dev.outcome-scientific-simulation`, `media.dev.outcome-validated-simulation-pass`, `media.dev.outcome-translated-dubbed-video`, `media.dev.outcome-music-effects-master`, `media.dev.outcome-multitrack-finished-master`, `media.dev.outcome-bounded-quality-improvement`, `media.dev.outcome-durable-job-recovery`, `media.dev.outcome-version-specific-review`, `media.dev.outcome-acknowledged-delivery`, `media.dev.outcome-offline-conflict-reconnect`, `media.dev.outcome-structured-command-batch`, `media.dev.outcome-authorized-agent-outcome`, `media.dev.outcome-retention-and-erasure`, `media.dev.outcome-provider-outage-safe-path`, `media.dev.outcome-spatial-interactive-delivery`, `media.dev.outcome-live-session-recovery`, `media.dev.outcome-eligible-provider-catalog` |
| `media.physical.modules-intelligence-ai-voice-libs-ai-voice-ui-react` | physical / PHYSICAL | `media.dev.voice-workflow-ui` |
| `media.physical.modules-intelligence-multimodal-service` | physical / PHYSICAL | `media.dev.grpc-operation-parity`, `media.dev.multimodal-child-orchestration`, `media.dev.multimodal-grounding-and-quality` |
| `media.physical.modules-intelligence-speech-libs-speech-audio-rust` | physical / SUPPORT_ONLY | `media.dev.native-media-dsp`, `media.dev.audio-repair-and-comparison`, `media.dev.foley-stems-mix-master` |
| `media.physical.modules-speech-stt-service` | physical / PHYSICAL | `media.dev.grpc-operation-parity`, `media.dev.stt-model-and-quality`, `media.dev.stt-streaming-and-caption`, `media.dev.dubbing-and-translation` |
| `media.physical.modules-speech-tts-service` | physical / PHYSICAL | `media.dev.grpc-operation-parity`, `media.dev.tts-model-and-rights`, `media.dev.tts-streaming-and-finality`, `media.dev.dubbing-and-translation` |
| `media.physical.modules-video-streaming` | physical / SUPPORT_ONLY | `media.dev.stream-session-authority`, `media.dev.grpc-source-capture`, `media.dev.camera-source-capture` |
| `media.physical.modules-vision-vision-service` | physical / PHYSICAL | `media.dev.grpc-operation-parity`, `media.dev.vision-model-and-geometry`, `media.dev.vision-document-intelligence`, `media.dev.video-restoration-and-comparison`, `media.dev.tracked-region-reversible-edits` |
| `media.physical.providers-aws-postgresql` | physical / PHYSICAL | `media.dev.canonical-artifact-storage`, `media.dev.database-upgrade-compatibility`, `media.dev.canonical-job-reconciliation`, `media.dev.transactional-event-outbox`, `media.dev.invocation-store-security`, `media.dev.stt-streaming-and-caption`, `media.dev.tts-streaming-and-finality`, `media.dev.delivery-export-destination-ack` |
| `media.physical.runtime-contracts` | physical / PHYSICAL | `media.dev.domain-contract-parity`, `media.dev.rights-and-policy`, `media.dev.canonical-job-reconciliation`, `media.dev.public-events`, `media.dev.authorized-agent-delegation`, `media.dev.recorder-actual-execution`, `media.dev.project-timeline-engine`, `media.dev.storyboard-and-shot-plan`, `media.dev.animation-3d-rig-and-spatial`, `media.dev.scientific-simulation-engine`, `media.dev.versioned-review-and-approval` |
| `media.composition.repository-root` | composition / REPOSITORY_ROOT | `media.dev.cross-surface-integration-harness`, `media.dev.documentation-and-command-navigation` |
| `media.composition.ingestion-and-versioned-artifacts` | composition / SEMANTIC_COMPOSITION | `media.dev.canonical-artifact-storage`, `media.dev.database-upgrade-compatibility` |
| `media.composition.governed-job-execution` | composition / SEMANTIC_COMPOSITION | `media.dev.canonical-job-reconciliation`, `media.dev.transactional-event-outbox` |
| `media.composition.speech-and-caption-workflows` | composition / SEMANTIC_COMPOSITION | `media.dev.stt-streaming-and-caption`, `media.dev.tts-streaming-and-finality` |
| `media.composition.vision-and-multimodal-analysis` | composition / SEMANTIC_COMPOSITION | `media.dev.multimodal-child-orchestration`, `media.dev.vision-document-intelligence` |
| `media.composition.creation-composition-and-delivery` | composition / SEMANTIC_COMPOSITION | `media.dev.project-timeline-engine`, `media.dev.delivery-export-destination-ack` |
| `media.composition.client-and-machine-interfaces` | composition / SEMANTIC_COMPOSITION | `media.dev.sdk-source-declaration-crosswalk`, `media.dev.http-operation-parity`, `media.dev.grpc-operation-parity` |
| `media.surface.web` | logical / HOST_DEPENDENT | `media.dev.web-host`, `media.dev.production-studio-host` |
| `media.surface.embedded` | logical / HOST_DEPENDENT | `media.dev.interactive-demo-player` |
| `media.surface.public-http` | logical / HOST_DEPENDENT | `media.dev.http-operation-parity` |
| `media.surface.service-grpc` | logical / CONTRACT_ONLY | `media.dev.grpc-operation-parity` |
| `media.surface.grpc.stt` | logical / CONTRACT_ONLY | `media.dev.stt-streaming-and-caption`, `media.dev.grpc-operation-parity` |
| `media.surface.grpc.tts` | logical / CONTRACT_ONLY | `media.dev.tts-streaming-and-finality`, `media.dev.grpc-operation-parity` |
| `media.surface.grpc.vision` | logical / CONTRACT_ONLY | `media.dev.vision-model-and-geometry`, `media.dev.grpc-operation-parity` |
| `media.surface.grpc.multimodal` | logical / CONTRACT_ONLY | `media.dev.multimodal-child-orchestration`, `media.dev.grpc-operation-parity` |
| `media.surface.sdk` | logical / PHYSICAL | `media.dev.sdk-source-declaration-crosswalk`, `media.dev.sdk-canonical-migration` |
| `media.surface.cli` | logical / HOST_DEPENDENT | `media.dev.structured-cli` |
| `media.surface.agent-tools` | logical / CONTRACT_ONLY | `media.dev.authorized-agent-delegation` |
| `media.surface.events` | logical / CONTRACT_ONLY | `media.dev.public-events` |
| `media.surface.integrations` | logical / HOST_DEPENDENT | `media.dev.optional-data-cloud-adapter`, `media.dev.vision-document-intelligence` |
| `media.surface.types-library` | logical / PHYSICAL | `media.dev.domain-contract-parity` |
| `media.surface.ui-library` | logical / HOST_DEPENDENT | `media.dev.web-host`, `media.dev.voice-workflow-ui` |
| `media.surface.explorer` | logical / PHYSICAL | `media.dev.explorer-fidelity` |
| `media.surface.desktop-archive` | logical / ARCHIVED | `media.dev.contextual-name-and-legacy-removal` |
| `media.surface.recorder-orchestrator` | logical / HOST_DEPENDENT | `media.dev.recorder-actual-execution`, `media.dev.recorder-mux-and-final-artifact` |
| `media.surface.capture-adapters` | logical / CONTRACT_ONLY | `media.dev.browser-source-capture`, `media.dev.desktop-source-capture`, `media.dev.mobile-source-capture`, `media.dev.terminal-source-capture`, `media.dev.grpc-source-capture`, `media.dev.camera-source-capture` |
| `media.surface.production-studio` | logical / HOST_DEPENDENT | `media.dev.production-studio-host` |
| `media.surface.interactive-demo-player` | logical / HOST_DEPENDENT | `media.dev.interactive-demo-player` |

## Demo/business outcome policy

Re-use the PDP3 authored Explorer semantic scenario and narrated source data, but never call a fixture recording actual product behavior. First run the real J01 → J02 → J20 → J03 journey with legal source speech, durable job restart, transcript-correction and exact caption revision; then record the same semantic beats against the real host. Follow with each of J04–J30 as its required physical engines land. For every journey, an actual correct positive effect, denied/UNKNOWN path, restart/finality and source-free consumer check are mandatory.

## Operationally independent execution

- **Parallel owners:** foundations (rights/store), modalities (STT/TTS/Vision/native), interfaces (SDK/HTTP/gRPC/Tools), capture, creative subengines, hygiene classification. Serialize edits to shared public contracts and writer semantics; no parallel duplicate implementations.
- **First tests after safety commit:** `./gradlew :services:media:adapters:agent-tools-media:test :services:media:adapters:ledger:test` in the supported repository source-composite profile; run full affected integration tests after focused suites. If single-host assumptions cannot be proven on a target filesystem, keep delegated effects disabled.
- **Source-free TS checks:** `pnpm --filter @audio-video/types check`, `pnpm --filter @audio-video/client test:package`, `pnpm --filter @audio-video/ui check`, followed by real browser/client route and journey tests.
- **Other relevant tests:** native Rust, provider contract and fault suites, Testcontainers PostgreSQL/S3/OCI worker, 1/16/64 resource budgets, a11y/CSP and actual encoded media verification.
- **Owner-only gates do not block unrelated work:** real vendor rights, voice consent, DI installed endpoint and production host access limit only their exact positive integration/qualified mode; they never justify faking success or stopping code/docs/security tests.

## Clean-repository finish

After each task's consumers are updated, remove old internal wrappers, test-only/orphan directories, and dated redundant documents. Keep PDP semantic IDs, externally published `audio-video` ABI/protos/routes and DB migration versions until a tested compatibility migration. The current root `README.md`, `AGENTS.md` and docs navigation must select these two development documents, not historical run context. Keep an exception registry for named immutable source artifacts whose version/date is semantically required.

## Claims boundary

This is a current-source, owner-approved implementation plan. It does not assert fresh Gradle, pnpm, JUnit, Rust, container, browser or model-inference results; it does not provide external credentials, license rights or production admission. A task exits only on its requested tests and real contract/behavior. The repo does not yet meet whole-product development completeness.