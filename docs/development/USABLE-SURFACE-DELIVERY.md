# Ghatana Media — Usable Surface Delivery

**Engineering source:** [`main@9b0fd9683fa5`](https://github.com/samujjwal/ghatana-media/commit/9b0fd9683fa5c516b9791a4bf4655f21d938f420) · **Scope:** Media features, public APIs, tests, real usable artifacts and permanent surface documentation only. This is **not** gtool, lifecycle closure, formal evidence or release.

This is the **implementation selector**. Keep [the 103-task source register](remaining-work.json) for one authoritative task definition and [the 72-task November 8 snapshot](EXECUTION-HANDOFF-2026-11-08.md) as historical status input. [Structured delivery map](surface-delivery.json) binds each of the **72 currently OPEN tasks exactly once** to an outcome-oriented area; it does not change status or create new task IDs.

## Product rule: deliver something actually usable

Each area has two different exits: **usable locally** (real executable output with exact limitations), then **integrated development complete** (correct source/identity/rights/version/job, all advertised positive/negative/restart outcomes, public client and hosted consumer where applicable). Passing an in-memory unit test alone is insufficient for integrated completion. A missing external model/authority may block only that exact positive outcome—not unrelated local algorithms, code, fault tests or packages. Preserve the 30 VERIFIED task units without reimplementing them.

## Priority portfolio

| Area | Open units | Immediate usable deliverable | Strategy |
| --- | ---: | --- | --- |
| [Playable creative preview libraries](#creative-preview) | 11 | One documented, runnable local consumer produces decoded PNG/GIF frame animation, valid WAV from original PCM, supported GLB and numeric simulati | START_NOW_PARALLEL |
| [Usable headless artifact and job API](#headless-media) | 11 | Authenticated development-host workflow: begin upload -> send chunks -> complete -> inspect immutable artifact -> submit supported processing job | START_NOW_PARALLEL |
| [Project, timeline, review and usable browser shell](#workspace-project) | 8 | A development-host browser can create a tenant-scoped owner project, persist an exact timeline revision, reopen it, display durable artifacts and | START_WITH_PARALLEL_IMPLEMENTATION |
| [Actual capture, live streams and playable narrated recording](#recorder-live) | 5 | A source-authorized recording from browser/file/terminal/desktop/camera or gRPC yields actual frame bytes, approved narration, timed VTT/TTML, a  | START_NOW_PARALLEL |
| [Real speech, captions, voice and translation](#speech-voice) | 10 | A source-free client can transcribe lawful supported audio into an immutable transcript/caption version and synthesize actual playable lawful voi | CODE_START_READY_POSITIVE_MODELS_GATED |
| [Source-grounded Vision, DI OCR and multimodal](#vision-multimodal) | 9 | Qualified still-image/ROI analysis and DI OCR return real typed boxes/text/provenance; a grounded multimodal request uses admitted child results  | CODE_START_READY_POSITIVE_MODELS_GATED |
| [Production Studio and real video composition](#studio-video) | 12 | A developer-host Studio edits an exact project revision, previews supported tracked region/video/audio effects, renders a playable master and sho | IMPLEMENT_IN_PARALLEL_WITH_HOST |
| [Durable delivery, authorized actions and retention](#delivery-agents) | 5 | A source-free client or agent can perform an authorized Media operation exactly once and reconcile an ambiguous result; a destination upload repo | START_INTERFACES_PARALLEL |
| [Nonblocking historical cleanup and naming](#history-retention) | 1 | A clean active documentation navigation and unchanged canonical source behavior; historical records classified and pinned without deleting retent | PARALLEL_NONBLOCKING |

**Parallel first front:** `creative-preview` and `headless-media` deliver outputs immediately; `recorder-live` owns executable media output and immutable frame clock; `workspace-project` can implement owner-principal-only development flows, without impersonating Shared workspace authority. `speech-voice` and `vision-multimodal` implement source/negative/host seams while lawful model/DI providers are obtained. The Studio and delivery lanes consume reusable outputs when ready. History retention never blocks features.

## Completion rubric and reuse rules

1. Select one area's **one concrete next consumer outcome**, not a broad feature family. Inspect the named source before coding and reuse existing working modules. Document the exact input/operation/output and limitations in its permanent surface README.
2. Implement the smallest end-to-end path including a **real public consumer** (Java package/CLI/SDK/browser), then exact output bytes or durable state. Synthetic fixtures prove only controls and failure semantics, not model/quality or human approvals.
3. Run a **focused changed-source test** and its affected contract/consumer tests. Use Gradle incremental/build cache, pnpm/Vitest focused files, and Rust incremental compilation. Do not force `--rerun-tasks`. Reuse previous passing test results only if the transitive source, test files/fixtures, dependency locks, tool versions, architecture, OS, configuration and signed external input identity are unchanged. Real volatile external effects and measurements must be checked on their actual current host.
4. Preserve a local developer test-pass cache keyed by `{checkId, source+transitive-input hashes, toolchain/OS/arch, provider profile/source revision, test command, test fixture digest}`. A missing/failed/partial or untrusted cache entry **never** skips execution; only a recorded PASS from a real invocation may be reused. This cache is an efficiency mechanism, **not** a lifecycle/evidence/closure receipt.
5. Do not re-execute a verified source task after unrelated docs/feature changes. If a shared public contract changes, invalidate only affected downstream tests. Run a complete host/business journey once its actual contract is ready; avoid 30 overlapping giant suites in each edit loop.
6. Every task leaves an owner-intent code path, runnable focused test, bounded adverse matrix (auth/tenant/revoke/cancel/timeout/restart/UNKNOWN/resources), a stable caller-visible API/error, short surface documentation, and an observable usable example. No new wave/batch/session-named docs or duplicate product state.
7. A journey remains OPEN until its actual required integrated outcome is exercised; **local usable** must be tracked as an intermediate product fact, not falsely promoted to the whole-task VERIFIED state. Never interpret the capability crosswalk's 463 `NOT_IMPLEMENTED` leaf classifications as proof there is no usable local code; those were computed from family-level task completion.

## Shared contract decisions that prevent repeated blockers

| Boundary | Exact engineering action | Legitimate gate that remains |
| --- | --- | --- |
| Shared identity/workspace [#242](https://github.com/samujjwal/ghatana-shared/issues/242) | Define a public issuer-verified identity continuation + `(tenant,principal,workspace,membershipRevision,expiry,nonce)` receipt and current-status/revocation contract; implement Media auth adapter and local signed DEV_ONLY issuer. Distinguish initial handoff from authenticated workspace access. | Real authenticated owner-issued identity/membership before production shared-workspace effects |
| Media frame source [#23](https://github.com/samujjwal/ghatana-media/issues/23) | Media owns resolver from canonical artifact version/digest to `(frameId,PTS,timebase,epoch,ROI,frameDigest,cropDigest)` and fresh rights. Reuse VideoFrameExtractor/OCI; add public readback and negative VFR/identity/crop tests. | Qualified codec/host and lawful real video corpus for actual decoder effects |
| DI public ABI [Shared #246](https://github.com/samujjwal/ghatana-shared/issues/246), [Ghatana #252](https://github.com/samujjwal/ghatana/issues/252) | Maintain frozen DI v1 and source-composite development profile; publish real compatible installed pair and worker when authenticated owner is available. Media uses public DI client and no OCR engine. | Real installed DI pair/worker/model and lawful annotated gold for positive OCR |
| Kernel DI [#99](https://github.com/samujjwal/ghatana-kernel/issues/99) | Kernel's DI consumer security and admission are independent. Media may use DI's public API directly; do not route Media source text through Kernel or block Media still-image DI on Kernel's own acceptance. | Kernel-specific provider use only |
| Speech/Vision provider profiles | Pin selected model/license/source/export SHA, exact rights and independent gold; implement logic, negative and resource tests now. | Genuine positive inference/quality requires lawful model, voice, reference and supported host |
| Codec/production host | Select a fixed developer WebM/MP4 capable encoder/ffprobe pair and backend-managed version; confirm codec rights and exact decode on host. Never fake success when missing. | Production/release packaging and host qualification separate from development |
| Data Cloud [Ghatana #254](https://github.com/samujjwal/ghatana/issues/254) | Keep optional, fail-closed metadata/RunLedger projection; Media owns all artifact/job state. | No core Media blocker |
| Historical records | Retain all 42 pinned artifacts until independently immutable off-main copy, SHA-256 readback, privacy and reference migration are proven; avoid scanning old proof packets during feature work. | Only destructive cleanup requires external archive |

## Playable creative preview libraries
<a id="creative-preview"></a>

**Source owners:** `modules/production/animation`, `modules/production/audio-mixing`, `modules/production/simulation`, `modules/production/spatial`, `libs/audio-video-ui/src/player`, `modules/production/rendering`.

**Reuse first:** AnimationRenderer (PNG and exact-centisecond GIF), PhysicalSimulation (force/spring), SpatialRigEngine (bounded GLB), PcmStemMixer, AudioRepairComparison, InteractiveDemoPlayer. Do not rewrite these working local engines.

**Usable local acceptance:** One documented, runnable local consumer produces decoded PNG/GIF frame animation, valid WAV from original PCM, supported GLB and numeric simulation output; all labeled as local preview, not a hosted Media product.

**Full integrated acceptance:** Bind exact artifact/project source versions and registered output lineage. Complete J07/J12/J13/J14/J15/J17/J28 at their real stated scopes without invented quality or scientific measurements.

### Implementation work (what / where / how)

1. **Package a real executable example.** Owner: `examples/media-creative-preview/ (new thin consumer, no new engine authority)`. Call existing public Java modules on explicitly versioned, locally authored safe fixtures; generate exact PNG/GIF, WAV, GLB, and solver JSON. Confirm each output is independently decoded/reopened and carries source/version/clock.
2. **Finish honest audio and spatial limitations.** Owner: `modules/production/audio-mixing; modules/production/spatial`. Add playable PCM/WAV serialization and test local owned stems; report peak/true-peak distinctions. Keep narrow spatial axis/profile, float32 loss and unsupported 360/host-viewer behaviors explicit.
3. **Make preview player usable.** Owner: `libs/audio-video-ui/src/player`. Exercise browser embedded deterministic branches, caption seek, keyboard and safe origins on real preview media, without claiming a deployed host or GLB playback.
4. **Separate local outputs from journey completion.** Owner: `modules/integration-tests; docs/surfaces`. Export a reusable library example with a deterministic input, output and error contract. J12/J13/J14/J15/J17/J28 remain OPEN until the actual source/project/job/rights/readback requirements pass.

### Exact 72-task handoff mapping (no duplicate tasks)

| Existing task | Exact next execution step |
| --- | --- |
| `audio-repair-and-comparison` | use a lawful pinned corpus and objective A/B criteria; keep fixture DSP separate from real quality claims. |
| `foley-stems-mix-master` | use rights-cleared stems and owner-defined mastering limits, then verify playable master and delivery. |
| `spatial-and-interactive-export` | owner defines the profile and conversion-loss output, then verify actual export and playback. |
| `interactive-demo-player` | connect only after a qualified export profile and exact artifact identity exist. |
| `outcome-audio-restoration` | run on pinned source-preserving fixtures with owner-approved metrics and verify no source overwrite. |
| `outcome-two-dimensional-animation` | bind the owner scenario and run the actual terminal journey. |
| `outcome-three-dimensional-animation` | obtain coordinate/profile mappings and verify a delivered GLB in the supported viewer. |
| `outcome-scientific-simulation` | obtain the seed and independent measurements; deterministic simulation alone is not measurement. |
| `outcome-validated-simulation-pass` | bind those inputs and verify a real constrained pass; local simulation remains `DETERMINISTIC_SIMULATION_ONLY`. |
| `outcome-music-effects-master` | obtain source rights and validate decoded final master and destination receipt. |
| `outcome-spatial-interactive-delivery` | qualify profile/encoder and verify actual delivery/playback with truthful loss metadata. |

**Test selector:**
`./gradlew :services:media:modules:production:animation:test :services:media:modules:production:simulation:test :services:media:modules:production:spatial:test :services:media:modules:production:audio-mixing:test` — Change-affected modules only; run relevant task selectors rather than every test after each edit.
`pnpm --filter @audio-video/ui exec vitest run src/player/interactiveDemoPlayer.test.ts` — Run only when player inputs or dependencies change.

**Source limitations/owner decisions:** Original authored/generated assets may serve as legal local demo inputs; do not substitute test waveforms for certified model quality. Nonproduction preview outputs are legitimately usable libraries but do not imply Media job finality or source-rights admission.

**Journeys in this area:** J-07, J-12, J-13, J-14, J-15, J-17, J-28. Preserve current task status until the full integration criteria, not just the local preview, pass.

## Usable headless artifact and job API
<a id="headless-media"></a>

**Source owners:** `launcher/src/main/java/com/ghatana/media/launcher/MediaHttpHandler.java`, `runtime-contracts`, `providers/aws-postgresql`, `modules/infrastructure/messaging`, `modules/infrastructure/cache`, `audio-video-observability`, `libs/audio-video-client/src/cli.ts`, `integration-tests`.

**Reuse first:** Durable upload/job stores, HTTP handlers, caption store, lifecycle metrics and focused restart tests exist. CLI currently admits artifact inspect only. Do not rebuild established writers or run old all-surface qualification loops.

**Usable local acceptance:** Authenticated development-host workflow: begin upload -> send chunks -> complete -> inspect immutable artifact -> submit supported processing job -> poll/read canonical outcome -> restart and read back the same state; CLI exposes real supported commands.

**Full integrated acceptance:** J02/J20/J24/J27 complete with real installed source-free client, PostgreSQL/object storage, source policy, cancellation/UNKNOWN, Event Plane outbox when used, crash recovery and no duplicate effects.

### Implementation work (what / where / how)

1. **Finish a visible working CLI/API journey.** Owner: `libs/audio-video-client/src/cli.ts; launcher/src/main/java/com/ghatana/media/launcher`. Expose upload / artifact inspect / job get / job cancel for actual supported HTTP operations. Derive status from durable readback, not 202/201 transport acceptance; preserve fail-closed absent identity.
2. **Use real local development persistence.** Owner: `providers/aws-postgresql; integration-tests/src/test/java/com/ghatana/media/integration/MediaLauncherArtifactIntakeRestartIT.java`. Prove bytes, checksum, tenant-scope, immutable version and restart using Testcontainers S3-compatible store/PostgreSQL. Testhost authentication must be trusted and DEV_ONLY, not forged principal metadata.
3. **Complete negative execution and event semantics.** Owner: `modules/infrastructure/messaging; modules/infrastructure/cache; audio-video-observability`. Make Event Plane append vs consumer ACK explicit, source-rights epoch cache invalidation, provider missing/UNKNOWN, and scrape readiness under missing observations.
4. **Use the same exact public API from CLI and SDK.** Owner: `contracts/openapi/media.yaml; config/route-manifest.json; libs/audio-video-client`. Extend only admitted routes with stable response/error schemas, idempotency and no-effect proof; test source-free packaged consumer.

### Exact 72-task handoff mapping (no duplicate tasks)

| Existing task | Exact next execution step |
| --- | --- |
| `transactional-event-outbox` | bind the approved fingerprint/ACK contract, then prove crash/restart reconciliation without duplicate publication. |
| `rights-aware-cache` | connect source-version and revocation observations to cache read/write admission and test stale, revoked, and replay cases. |
| `service-observability` | run pinned rules on an available Docker host, then verify deployed fire/clear and runtime producers. |
| `http-operation-parity` | obtain exact Shared identity and operation contracts; keep those effects NOT_ADMITTED until then. |
| `structured-cli` | add commands only after their exact public operations are bound. |
| `public-events` | bind the public payload and source-free consumer to the owner receipt contract; keep ACK separate from job finality. |
| `cross-surface-integration-harness` | close each supported workflow selector and add real positives only when its provider/rights/host gate is satisfied. |
| `outcome-resumable-artifact-intake` | verify real isolated-store bytes and restart on the admitted upload route. |
| `outcome-durable-job-recovery` | use an admitted provider receipt and verify the same job/result after process restart. |
| `outcome-structured-command-batch` | define the public batch contract, then prove per-item auth, typed failures and true finality. |
| `outcome-provider-outage-safe-path` | qualify real provider observations and restart-safe fail-closed behavior. |

**Test selector:**
`./gradlew :services:media:integration-tests:test --tests com.ghatana.media.integration.MediaLauncherArtifactIntakeRestartIT` — PostgreSQL/S3 integration only after artifact/storage/launcher change or host qualification.
`pnpm --filter @audio-video/client exec vitest run src/operations.test.ts src/cli.test.ts` — Run when canonical SDK, CLI, route or type contract changes.

**Source limitations/owner decisions:** Create the development-host product flow without waiting for Shared workspace continuation; admit only host-verified DEV_ONLY identity, never caller self-attestation. Data Cloud is optional downstream read-model and not on the upload/job critical path.

**Journeys in this area:** J-02, J-20, J-24, J-27. Preserve current task status until the full integration criteria, not just the local preview, pass.

## Project, timeline, review and usable browser shell
<a id="workspace-project"></a>

**Source owners:** `modules/production/timeline`, `modules/production/review`, `providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/PostgresqlProjectTimelineStore.java`, `libs/audio-video-ui/src/screens`, `libs/audio-video-client/src/offline-reconnect.ts`, `runtime-contracts`.

**Reuse first:** ProjectTimelineEngine, project-scoped in-memory/test stores, V030 PostgreSQL development adapter, StoryboardPlanner, VersionedReviewEngine and UI screens exist. V030 is NOT launcher-wired; reviewer statement is NOT human approval.

**Usable local acceptance:** A development-host browser can create a tenant-scoped owner project, persist an exact timeline revision, reopen it, display durable artifacts and job progress, and recover an edit conflict. No false shared-workspace or human-approval claims.

**Full integrated acceptance:** J01/J21/J23 complete after public Shared identity/workspace membership, a durable one-writer project/review CAS, authentic reviewer authority, offline key custody and installed host/browser tests.

### Implementation work (what / where / how)

1. **Select canonical project graph semantics.** Owner: `runtime-contracts; .product-experience/pdp-1-domain-data/domain-objects.yaml; modules/production/timeline`. Bind project ID, immutable revision/head, scene/track/clip and source-version/PTS; define overlap/undo/redo meaning and one CAS writer. Only semantics backed by owner PDP become public; no arbitrary graph-to-PDP equivalence.
2. **Harden and wire a local durable project lane.** Owner: `providers/aws-postgresql; launcher`. Exercise V030 migration in isolated development schema, atomic head+revision, CAS conflicts, restart and tenant ACL. Wire only to DEV_ONLY host after correct mapping, not automatic production migration/cutover.
3. **Make browser actions real one by one.** Owner: `libs/audio-video-ui/src/screens/FirstUseProjectScreen.tsx; ArtifactIntakeScreen.tsx; JobRecoveryScreen.tsx`. Use canonical SDK ports with real backend; every action displays accepted/running/denied/unknown/final and no simulation badge on actual effects. Keep remaining defined screens as truthful previews until supported.
4. **Keep human review as an authority-bound operation.** Owner: `modules/production/review; libs/audio-video-client/src/offline-reconnect.ts`. Persist review statements and invalidation on edited material; only owner-issued reviewer/case authority may claim approval. Offline edits must reauthorize against current version and key on reconnect.

### Exact 72-task handoff mapping (no duplicate tasks)

| Existing task | Exact next execution step |
| --- | --- |
| `web-host` | bind supported operations first, then add accessible UI actions with typed denial/unknown states. |
| `project-timeline-engine` | obtain the project owner mapping, then bind edits/undo to durable revision readback. |
| `storyboard-and-shot-plan` | obtain those owner contracts before wiring a generated plan to a project or renderer. |
| `versioned-review-and-approval` | bind review to the project owner and gather authentic reviewer evidence; keep local ACCEPT as a review statement only. |
| `offline-reconnect` | bind fresh rights and project version to the offline edit; keep local encrypted-store behavior separate from production effects. |
| `outcome-first-use-project` | obtain #242's public contract, then test duplicate, wrong-tenant, and revision readback. |
| `outcome-version-specific-review` | integrate the canonical project revision fence and obtain real reviewer evidence. |
| `outcome-offline-conflict-reconnect` | bind host-held key, fresh authorization and exact project version to the real endpoint. |

**Test selector:**
`./gradlew :services:media:modules:production:timeline:test :services:media:modules:production:review:test` — Only changed relevant modules, then project data migration integration.
`pnpm --filter @audio-video/ui exec vitest run src/screens/FirstUseProjectScreen.test.ts src/screens/ArtifactIntakeScreen.test.ts src/screens/JobRecoveryScreen.test.ts` — UI affected tests and real host E2E after wiring.

**Source limitations/owner decisions:** Shared #242 must publish a trusted continuation/membership contract. The dev host may use a signed test issuer; it cannot grant production workspace access. Do not label a local ACCEPT reviewer statement as a human approval or consent grant.

**Journeys in this area:** J-01, J-21, J-23. Preserve current task status until the full integration criteria, not just the local preview, pass.

## Actual capture, live streams and playable narrated recording
<a id="recorder-live"></a>

**Source owners:** `libs/audio-video-client/src/recorder-orchestrator.ts`, `libs/audio-video-client/src/scene-captions.ts`, `libs/audio-video-client/src/camera-capture-adapter.ts`, `modules/audio-streaming`, `modules/video-streaming`, `modules/vision/vision-service/src/main/java/com/ghatana/audio/video/vision/video/VideoFrameExtractor.java`, `modules/production/rendering`.

**Reuse first:** executeScenario, browser/desktop/mobile/terminal/file/HTTP source adapters, consent checks and integer-tick VTT/TTML already exist. Audio 27/27 and video 32/32 focused tests were reported for current gRPC cursor/result checks.

**Usable local acceptance:** A source-authorized recording from browser/file/terminal/desktop/camera or gRPC yields actual frame bytes, approved narration, timed VTT/TTML, a decoder-playable media file and inspectable immutable source lineage.

**Full integrated acceptance:** Recorder and J29 complete with canonical stream lease/cursor/PTS, permission revocation, actual host transport, bounded source failure/reconnect and persisted registered output version.

### Implementation work (what / where / how)

1. **Own the canonical source/frame contract in Media.** Owner: `runtime-contracts; modules/video-streaming; modules/vision/vision-service`. Implement verified (tenant,sourceArtifactVersion,sourceDigest,frameId,PTS/timebase,epoch,ROI,frameDigest,cropDigest) readback from canonical source store and bounded decoder. Never derive frame=0/PTS=0 for an arbitrary video; reject untrusted clocks.
2. **Finish gRPC and camera capture on real transport.** Owner: `modules/audio-streaming; modules/video-streaming; libs/audio-video-client/src/camera-capture-adapter.ts`. Bind caller auth, device consent, bounded stream cursor/ack and connected lease; loss/revoke/reconnect must not produce extra pixels or duplicate frames. Reuse the already verified local cursor-count guard.
3. **Select one real developer codec profile.** Owner: `modules/production/rendering; libs/audio-video-client/src/recorder-orchestrator.ts`. Use a pinned local FFmpeg/ffprobe distribution/profile for a genuine WebM/MP4 depending on licensed capabilities; validate decoded video/audio/captions and output checksum. When absent return CODEC_UNAVAILABLE; GIF/no-audio preview is not a narrated recording.
4. **Reopen exact recorded output.** Owner: `launcher; providers/aws-postgresql; apps/media-experience-explorer`. Persist immutable artifact/version and narration/caption/source time mapping. Exercise the same curated semantic beats against the actual host, clearly distinguishing Explorer simulation.

### Exact 72-task handoff mapping (no duplicate tasks)

| Existing task | Exact next execution step |
| --- | --- |
| `stream-session-authority` | obtain the owner resolver, bind durable lease and cursor readback, then run restart and measured-load cases. |
| `grpc-source-capture` | bind the owner request/receipt mapping; the local result-count/cursor invariant now passes audio 27/27 and video 32/32. |
| `camera-source-capture` | integrate with the canonical session owner and verify permission loss/revoke/reconnect on real supported hosts. |
| `recorder-mux-and-final-artifact` | obtain a licensed pinned profile and durable upload recovery, then create and inspect a genuinely decodable versioned recording. |
| `outcome-live-session-recovery` | bind host lifecycle to durable session authority, then test loss/reconnect/revoke at qualified load. |

**Test selector:**
`pnpm --filter @audio-video/client exec vitest run src/recorder-orchestrator.test.ts src/camera-capture-adapter.test.ts src/scene-captions.test.ts` — Focused component and real dev-host byte tests.
`./gradlew :services:media:modules:audio-streaming:test :services:media:modules:video-streaming:test` — Changed stream owner modules only; 1/16/64 actual transport later.

**Source limitations/owner decisions:** Media, not Shared/Kernel/Data Cloud, owns the trusted source/frame/PTS/crop resolver. The cross-repo dependency is only on public identity/rights and DI OCR execution. Select and pin a legitimate development codec toolchain and test actual playable bytes; do not wait for a production release to test local mux.

**Journeys in this area:** J-29. Preserve current task status until the full integration criteria, not just the local preview, pass.

## Real speech, captions, voice and translation
<a id="speech-voice"></a>

**Source owners:** `modules/speech/stt-service`, `modules/speech/tts-service`, `libs/java/common/src/main/java/com/ghatana/media/stt`, `libs/java/common/src/main/java/com/ghatana/media/tts`, `modules/intelligence/ai-voice/libs/ai-voice-ui-react`, `modules/production/dubbing`, `launcher/src/main/java/com/ghatana/media/launcher/MediaCaptionRuntime.java`.

**Reuse first:** Whisper/Piper engines, broker and bounded gRPC servers, transcript store and caption V029 implementation are substantial. Real licensed checkpoint/export/voice and reference corpus still need verified positive admission.

**Usable local acceptance:** A source-free client can transcribe lawful supported audio into an immutable transcript/caption version and synthesize actual playable lawful voice output; missing profile/rights is typed NOT_ADMITTED.

**Full integrated acceptance:** J03/J04/J16 complete with verified model/license/export lineage, independent reference gold, source/word clock, consent and revocation, gRPC streaming, durable job/result restart and accurate language quality.

### Implementation work (what / where / how)

1. **Keep exact STT output real and restart-safe.** Owner: `modules/speech/stt-service; launcher; providers/aws-postgresql`. Pin selected lawful Whisper checkpoint/export, verify bytes+license+conversion lineage, run source audio->word timing->transcriptVersionRef->corrected captionVersionRef, enforce revocation and provider-attempt UNKNOWN.
2. **Finish lawful TTS voice profile.** Owner: `modules/speech/tts-service; libs/java/common`. Pin Piper voice/phonemizer/profile and consent; return actual decodable PCM/codec/duration, typed unsupported SSML and no silent clone. Stream with limits/cancel and immutable output commit.
3. **Connect voice UI and dubbing only to admitted effects.** Owner: `modules/intelligence/ai-voice/libs/ai-voice-ui-react; modules/production/dubbing`. Align source transcript, authorized translation and legal voice timing. Keep unsupported locale/forced alignment typed and leave honest unfinished state.
4. **Qualify at feature level.** Owner: `integration-tests; modules/integration-tests`. Run English/Nepali rights-cleared independent references and per-host resource/accuracy tests once per pinned profile; never rerun known unsuccessful/lawful-input-absent inference automatically.

### Exact 72-task handoff mapping (no duplicate tasks)

| Existing task | Exact next execution step |
| --- | --- |
| `shared-engine-consolidation` | continue the native lifecycle/leak and auth-parity audit without merging distinct retry contracts. |
| `stt-model-and-quality` | once supplied, compare complete transcript on the pinned artifact and run same-input 0/1/2/4-thread A/B; current model-free guards passed only. |
| `stt-streaming-and-caption` | bind the canonical session and provider attempt, then test corrected transcript/caption persistence, revoke, lost ACK, and restart. |
| `tts-model-and-rights` | obtain those inputs, then verify real bytes, profile identity, quality, and denied/revoked cases. |
| `tts-streaming-and-finality` | connect admitted TTS output to canonical storage/outbox and prove one-write/restart behavior before load qualification. |
| `voice-workflow-ui` | wait for voice rights/model and canonical TTS contract, then wire accessible phrase/voice/stem controls to admitted operations. |
| `dubbing-and-translation` | obtain licensed voice and translation semantics, then qualify timing/lip metadata and lost-ACK behavior. |
| `outcome-transcript-to-reviewed-captions` | bind exact audio/version and test revoke/UNKNOWN/restart. |
| `outcome-authorized-voice-synthesis` | qualify a pinned voice, prove denied locale/profile and revocation, then decode returned bytes. |
| `outcome-translated-dubbed-video` | qualify voice and translation rights, then verify playable, source-aligned dubbed output. |

**Test selector:**
`./gradlew :services:media:modules:speech:stt-service:test` — Changed STT/runtimes only; real inference requires pinned licensed fixture.
`./gradlew :services:media:modules:speech:tts-service:test` — Changed TTS/voice inputs only; model-quality tests are separate noncached gate.

**Source limitations/owner decisions:** English and Nepali are active ASR evaluation languages; Hindi and FLEURS deferred in this selected scope, not silent broad support. Never fabricate licensed voice, speaker consent, output audio or model quality. Code, error, negative and source composition work can proceed without them.

**Journeys in this area:** J-03, J-04, J-16. Preserve current task status until the full integration criteria, not just the local preview, pass.

## Source-grounded Vision, DI OCR and multimodal
<a id="vision-multimodal"></a>

**Source owners:** `modules/vision/vision-service`, `modules/intelligence/multimodal-service`, `modules/video-streaming`, `launcher`, `libs/audio-video-client/src/authorized-scene-text.ts`, `runtime-contracts`.

**Reuse first:** OCI Vision isolation, `MediaRuntimeSceneTextSource` still-image authority, `MediaCanonicalOperationExecutor` and `DelegatingMultimodalProvider` already exist. Current Media frame resolver is still-image limited; Docker fixture pass is not full model/host qualification.

**Usable local acceptance:** Qualified still-image/ROI analysis and DI OCR return real typed boxes/text/provenance; a grounded multimodal request uses admitted child results and source clocks, not guessed fusion.

**Full integrated acceptance:** J05/J06/J30 complete with selected detector/DI worker, rights-cleared gold, actual video-frame timebase, precise child/parent attempt receipts, capacity and request-scoped identity, UNKNOWN under fault.

### Implementation work (what / where / how)

1. **Complete the Media-owned video-frame resolver.** Owner: `modules/vision/vision-service/src/main/java/com/ghatana/audio/video/vision/scenetext/MediaRuntimeSceneTextSource.java; modules/video-streaming`. Derive verified version/ROI/PTS from immutable source and qualified OCI decoder, preserving frame epoch, original and cropped digests. Gate rights at extraction and result exposure, reject mismatches.
2. **Consume DI independently of Kernel.** Owner: `modules/vision/vision-service/src/main/java/com/ghatana/audio/video/vision/scenetext; libs/audio-video-client/src/authorized-scene-text.ts`. Use DI frozen v1 public API with independently selected endpoint trust and installed client/worker. Kernel #99 is a separate consumer, not a prerequisite for Media invoking a real DI worker; Shared #246/DI #252 public package/worker positive remains exact gate.
3. **Run real detector and tracker.** Owner: `modules/vision/vision-service; libs/java/common`. Select lawful pinned weights and independent labeled frames, verify RGB/BGR/letterbox/EXIF/VFR tracking and native OCI cgroup/deadline/kill on supported host.
4. **Fuse only matched children.** Owner: `modules/intelligence/multimodal-service; launcher`. Bind each child exact source version+clock+rights; durable child attempts, partial/UNKNOWN and recovery; return typed confidence provenance or SYNC_UNDETERMINED.

### Exact 72-task handoff mapping (no duplicate tasks)

| Existing task | Exact next execution step |
| --- | --- |
| `grpc-operation-parity` | obtain per-method authorization semantics, then implement/test mTLS/JWT, bounded streams, and typed outcomes; preserve default-deny meanwhile. |
| `vision-model-and-geometry` | acquire pinned rights-cleared weights and independent labels, bind source frame/version/PTS, then qualify real decode/detection/tracking; Docker fixture passed 9/9 only. |
| `vision-document-intelligence` | DI/Shared owners publish the compatible package and worker; Media consumes only the public client and keeps video OCR NOT_ADMITTED until frame authority exists. |
| `multimodal-child-orchestration` | bind exact child attempts/receipts to the parent and prove restart/readback with real admitted children. |
| `multimodal-grounding-and-quality` | add only owner-supplied source mappings and calibration evidence; keep results `SYNC_UNDETERMINED` or `HEURISTIC_UNCALIBRATED` otherwise. |
| `load-and-quality-profiles` | after each exact provider is admitted, record c1/c16/c64 latency, throughput, CPU/RSS/fd/pid and saturation evidence. |
| `outcome-vision-detection-and-tracking` | qualify exact image/video inputs and independent bbox/mAP references. |
| `outcome-grounded-cross-modal-result` | execute source-free installed consumers and deny wrong-clock/right cases. |
| `outcome-eligible-provider-catalog` | consume owner-qualified profiles and verify currentness, expiry, revocation, and zero-effect unavailability. |

**Test selector:**
`./gradlew :services:media:modules:vision:vision-service:test` — Run modified Vision/ROI contract tests; real worker positives only when owned gold/model ready.
`./gradlew :services:media:modules:intelligence:multimodal-service:test` — Changed parent/child mapping and restart tests.

**Source limitations/owner decisions:** DI is the only generic OCR executor. Kernel #99 is not on the Media-only DI client critical path; its own consumer qualification remains separate. Media #23 is a Media code responsibility, not an undefined upstream provider granting frame authority; implement the canonical immutable video-frame reader in Media.

**Journeys in this area:** J-05, J-06, J-30. Preserve current task status until the full integration criteria, not just the local preview, pass.

## Production Studio and real video composition
<a id="studio-video"></a>

**Source owners:** `modules/production/timeline`, `modules/production/rendering`, `modules/production/review`, `libs/audio-video-ui/src/screens`, `libs/audio-video-ui/src/player`, `launcher`.

**Reuse first:** MultitrackRenderPlanner, PngFrameCodec, temporal RGB filters and references, ReversibleRegionEditEngine, ReferenceGuidedScenePlanner and UI renderer exist. Many are local plans/candidates, not canonical playable output.

**Usable local acceptance:** A developer-host Studio edits an exact project revision, previews supported tracked region/video/audio effects, renders a playable master and shows source-bound quality/review state without fixture success.

**Full integrated acceptance:** J08/J09/J10/J11/J18/J19 complete with real clip/frame/audio/caption/color mux output, immutable timeline/render/undo, reference-conditioned generation only when lawful and aligned references, durable readback and version-specific review.

### Implementation work (what / where / how)

1. **Bind one editorial timeline.** Owner: `modules/production/timeline; runtime-contracts`. Freeze project-revision/scene/track/clip/time mapping with CAS and rights; prepare scene graph and reversible edits tied to exact source assets; reject stale undo/overlap ambiguities.
2. **Make one playable timeline master.** Owner: `modules/production/rendering; launcher`. Implement actual video/audio/caption composition through pinned encoder/mux, deterministic output/source digest, bounded frame/audio buffers, and transactional artifact registration with abort/UNKNOWN.
3. **Connect Studio surface.** Owner: `libs/audio-video-ui/src/screens; libs/audio-video-client`. Replace preview-only actions one route at a time with real project/render/review SDK, keyboard/a11y, progress, cancellation, re-open and visual parity. Reuse existing ProductRenderer, not a second app shell.
4. **Make quality and generation claims truthful.** Owner: `modules/production/rendering; modules/production/timeline`. Compare with independently authorized aligned reference; SSIM/PSNR describe the selected metric only. J10 continuity requires an exact candidate-to-version/quality join, not a shape-valid generated placeholder.

### Exact 72-task handoff mapping (no duplicate tasks)

| Existing task | Exact next execution step |
| --- | --- |
| `video-restoration-and-comparison` | bind the source frame map and run measured decode/restore/encode comparisons on qualified inputs. |
| `reference-guided-generation` | specify the output/continuity join with its owner and verify source lineage before admitting generated output. |
| `tracked-region-reversible-edits` | bind the exact source/version and edit operation to the project owner, then test real tracking and revision-specific undo. |
| `multitrack-composition-render` | bind the selected timeline versions and render dependencies, then decode and verify the assembled artifact. |
| `quality-comparison-and-optimization` | define source-bound metrics and bounded reversible changes against qualified references. |
| `production-studio-host` | consume owner-approved public operations and verify real host-to-runtime finality without enabling NOT_ADMITTED effects. |
| `outcome-video-enhancement` | prove playable output and measured A/B on lawful video. |
| `outcome-brief-to-reviewed-media` | join storyboard to the project and test version-stale review without fabricating approval. |
| `outcome-reference-continuity` | define exact output provenance/continuity receipt with its owner before positive generation. |
| `outcome-reversible-tracked-edit` | bind masks and undo to exact source revision and verify the real rendered result. |
| `outcome-multitrack-finished-master` | bind all track revisions, render/decode, and prove restart-safe readback. |
| `outcome-bounded-quality-improvement` | define independent metric and demonstrate a bounded, reversible comparison. |

**Test selector:**
`./gradlew :services:media:modules:production:rendering:test :services:media:modules:production:timeline:test` — Affected modules only; actual mux decode acceptance is separate.
`pnpm --filter @audio-video/ui exec vitest run src/screens/MediaProductRenderer.test.ts` — UI change smoke and browser E2E on actual routes.

**Source limitations/owner decisions:** The exact project graph mapping belongs to Media owner, chosen from existing authored PDP structures; missing external review is not permission to invent semantic equivalence. Source-rights and quality references are genuine positive input gates; local render/undo and negative tests proceed immediately.

**Journeys in this area:** J-08, J-09, J-10, J-11, J-18, J-19. Preserve current task status until the full integration criteria, not just the local preview, pass.

## Durable delivery, authorized actions and retention
<a id="delivery-agents"></a>

**Source owners:** `modules/production/delivery`, `adapters/agent-tools-media`, `modules/infrastructure/messaging`, `providers/aws-postgresql`, `runtime-contracts`, `libs/audio-video-client`.

**Reuse first:** FileInvocationLedger, Tools execution fence, Postgresql delivery state with V031/V032 candidate, and MediaDeliveryEngine exist. No real destination FencedDestinationPort or authorized Tool-to-canonical operation effect is admitted.

**Usable local acceptance:** A source-free client or agent can perform an authorized Media operation exactly once and reconcile an ambiguous result; a destination upload reports its actual authenticated acknowledgment; retention/revocation prevents disclosure.

**Full integrated acceptance:** J22/J25/J26 complete with durable destination CAS, project/artifact rights and currentness, exact authenticated tool mappings, destination readback and copy inventory/erasure constraints.

### Implementation work (what / where / how)

1. **Implement real destination transport.** Owner: `modules/production/delivery; providers/aws-postgresql`. Bind destination identity, checksum, request fingerprint and monotonic durable claim; use authenticated destination adapter with exact receipt/readback. Do not convert HTTP 201 to delivered finality.
2. **Bind four agent tools.** Owner: `adapters/agent-tools-media; launcher; runtime-contracts`. Map STT/TTS/Vision/Multimodal tools to canonical operations, verify trusted Tools caller/tenant/purpose and source rights, pre-dispatch exclusive fence, stale authorization/UNKNOWN, no duplicate provider call.
3. **Make retention lifecycle explicit.** Owner: `providers/aws-postgresql; modules/infrastructure/cache; launcher`. Inventorize copies in object/DB/cache/derivatives/exports/backups and external projections. Prove current rights and no disclosure post-erasure; coordinate authentic store deletion only when policy permits.
4. **Expose status to actual consumer.** Owner: `libs/audio-video-client; modules/integration-tests`. Provide typed status and destination ack via supported API/client, with source-free fault/restart test and no unadmitted auto retry.

### Exact 72-task handoff mapping (no duplicate tasks)

| Existing task | Exact next execution step |
| --- | --- |
| `authorized-agent-delegation` | obtain those bindings and prove exclusive claim plus pre-dispatch fence before any real dispatch. |
| `delivery-export-destination-ack` | obtain the owner receipt schema and prove same-key replay/readback; timeout stays UNKNOWN. |
| `outcome-acknowledged-delivery` | implement owner-bound receipt/readback and test exact same-key recovery. |
| `outcome-authorized-agent-outcome` | establish actor mapping and durable exact output receipt, then test one dispatch per claim. |
| `outcome-retention-and-erasure` | inventory every copy and prove post-erasure no-disclosure before any purge. |

**Test selector:**
`./gradlew :services:media:modules:production:delivery:test` — Changed delivery engine/stores only.
`./gradlew :services:media:adapters:agent-tools-media:test` — Changed Tools/source rights/delegation only; effect positives after verified identity.

**Source limitations/owner decisions:** The optional Data Cloud ledger/projection is not Media domain finality. Do not make delivery/agent operation depend on Data Cloud. An externally sent effect cannot be replayed after timeout until the same destination/operation is authoritatively read back.

**Journeys in this area:** J-22, J-25, J-26. Preserve current task status until the full integration criteria, not just the local preview, pass.

## Nonblocking historical cleanup and naming
<a id="history-retention"></a>

**Source owners:** `docs/implementation`, `docs/development/historical-content-preservation.json`, `scripts/media-historical-artifact-inventory.mjs`, `docs/README.md`, `AGENTS.md`.

**Reuse first:** 1,375 tracked historic files were classified; 42 candidates totaling 428,652,561 bytes remain preserved on main, no verified external immutable archive exists.

**Usable local acceptance:** A clean active documentation navigation and unchanged canonical source behavior; historical records classified and pinned without deleting retention-required assets.

**Full integrated acceptance:** The 42 protected artifacts are copied into an authenticated immutable off-main store, independently restored/hash-checked and references migrated before exact deletion. No functional Media surface waits for that deletion.

### Implementation work (what / where / how)

1. **Keep cleanup off feature critical path.** Owner: `docs/implementation; AGENTS.md`. Do not regenerate or review old logs while implementing a functional slice. Retain historical docs behind one index and stop new dated execution packets.
2. **Archive only after real proof of byte preservation.** Owner: `docs/development/historical-content-preservation.json`. Use an independently immutable destination with per-object SHA-256, retention policy, tested read-after-write restore and source-reference migration; then delete only selected candidate bytes.
3. **Protect public/semantic identity.** Owner: `docs/surfaces; scripts/check-surface-docs.mjs`. Name internals by intent; retain public audio-video ABI and migration/PDP stable identifiers until compatible consumers migrate.

### Exact 72-task handoff mapping (no duplicate tasks)

| Existing task | Exact next execution step |
| --- | --- |
| `historical-artifact-retirement` | verify all 42 pinned artifacts externally before any deletion; deletion remains held. |

**Test selector:**
`pnpm check:surface-docs` — Run only on source/README changes; reclassification only when historical inputs change.

**Source limitations/owner decisions:** Archive deletion has no dependency edge to any functional Media journey. Never treat basename-based zero references as authority to delete a frozen preimage.

**Journeys in this area:** none (maintenance only). Preserve current task status until the full integration criteria, not just the local preview, pass.

## Surface and requirement denominator checks

All 56 source-defined physical/logical/composition identities are retained in the structured map, each with any OPEN task IDs and their primary areas. All 30 journeys are assigned to one area. The 469 PDP0 capability leaves are not copied or edited: they remain under `.product-experience/pdp-0-product-truth/capabilities.yaml` and `docs/development/capability-implementation-crosswalk.v1.json`; the map includes family counts/relevant areas. A development audit must fail on a missing task/surface/journey family mapping rather than silently counting unmapped capability as implemented.

## Final dev-complete standard (without gtool)

Every advertised surface API and input has a real bounded implementation or a truthful source-authorized exclusion; all supported app/library outputs are usable by source-free clients; permanent docs and naming are clean; negative/unknown/restart/tenant/rights tests pass; true media results are independently decoded and persisted; every applicable J01–J30 end-to-end terminal outcome is actually reproduced at its supported scope. Tests and accepted local outputs may be reused when inputs are unchanged. Do **not** call 72 tasks complete, formal closure complete, or production provider admitted merely because this plan is published.
