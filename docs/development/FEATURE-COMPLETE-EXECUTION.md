# Ghatana Media — Feature-Complete Development Execution

**Purpose:** fully working Media tools, libraries, APIs, Studio and defined business journeys with correctness and complete test coverage. This plan is a **source-level implementation and acceptance overlay**, not gtool execution, lifecycle closure, evidence campaign or release. Current code is newer than the original 30-verified/72-open/1-optional task status; do not reimplement shipped functionality or self-promote a stale task.

## Working-result milestones and acceptance

1. **Reusable creative library:** Actual decoder-readable PNG/GIF, WAV, GLB and bounded scientific simulation results via existing engines and isolated consumer. Validate source versions, units, output digests, format/memory limits, invalid/unknown/revoked cases. Not a hosted Studio or a qualified real-world measurement.
2. **Real headless Media:** Authenticated DEV_ONLY host and ESM/CJS SDK/CLI upload, signed scan, range read, inspect, jobs/status/cancel, durable Postgres+object store and restart. Show exact result, not request acceptance as success.
3. **Actual recorded video:** Use existing browser/desktop/mobile/terminal/API/file/camera/gRPC capture, rights and frame clocks, narration/VTT/TTML, pinned real FFmpeg mux, independently decode playable output and register immutable artifact. No synthetic Explorer screen accepted as actual recording.
4. **Real project and Studio:** Bind selected ProjectRevision/Timeline semantics to single CAS store; browser create/open/edit/undo and conflict; real preview/render/master, versioned review, keyboard/a11y; human approval only when issued by actual owner.
5. **Lawful modalities:** STT/TTS/Vision/DI/multimodal only use real lawful selected models/voice/reference, installed DI client/worker, exact source/PTS/rights and independent quality on named host. Keep unadmitted providers honest while other work proceeds.
6. **Delivery and final integration:** Real authorized recipient checksum/ACK and replay/readback; Tools delegation to canonical Media, privacy/retention; all 30 applicable journeys under real source-free consumer positive, wrong tenant/revoke, timeout/UNKNOWN and restart.

**Complete a feature only when:** one stable public caller returns a verifiable real output, every exact authored input/permission/error/finality/version is implemented, denial/retry/restart/resource tests pass, and its permanent surface README says what works and what remains genuinely unqualified. No class-only or mock-only success.

## No-rerun and resource efficiency

Use the already implemented `scripts/local-test-pass-cache.mjs` and `scripts/check-media-surface-delivery.mjs --affected=<base-commit>`; **do not create another cache**. Fingerprints must include transitive source/contracts/tests/fixtures, package locks, toolchain/OS/arch, real provider/host/source version and command. Only matching deterministic PASS may be reused; missing/failed/skipped/volatile/live external behavior must execute its targeted check. Default Gradle/pnpm/Rust incremental builds, never blanket `--rerun-tasks` or every 56 surface every edit. Run changed unit, changed installed consumer, then one relevant real Jxx scenario. Update the original task status only after its existing acceptance actually passes.

## Nine executable surface-area plans

### Playable creative preview libraries

**Owners:** `modules/production/animation`, `modules/production/audio-mixing`, `modules/production/simulation`, `modules/production/spatial`, `libs/audio-video-ui/src/player`, `modules/production/rendering`.

**Immediately usable output:** One documented, runnable local consumer produces decoded PNG/GIF frame animation, valid WAV from original PCM, supported GLB and numeric simulation output; all labeled as local preview, not a hosted Media product.

**Integrated development exit:** Bind exact artifact/project source versions and registered output lineage. Complete J07/J12/J13/J14/J15/J17/J28 at their real stated scopes without invented quality or scientific measurements.

**Open task IDs (original register only):** `audio-repair-and-comparison`, `foley-stems-mix-master`, `spatial-and-interactive-export`, `interactive-demo-player`, `outcome-audio-restoration`, `outcome-two-dimensional-animation`, `outcome-three-dimensional-animation`, `outcome-scientific-simulation`, `outcome-validated-simulation-pass`, `outcome-music-effects-master`, `outcome-spatial-interactive-delivery`.

**Affected test selectors:** `./gradlew :services:media:modules:production:animation:test :services:media:modules:production:simulation:test :services:media:modules:production:spatial:test :services:media:modules:production:audio-mixing:test` / `pnpm --filter @audio-video/ui exec vitest run src/player/interactiveDemoPlayer.test.ts`. Run only those whose transitive inputs changed; preserve prior verified passes.

### Usable headless artifact and job API

**Owners:** `launcher/src/main/java/com/ghatana/media/launcher/MediaHttpHandler.java`, `runtime-contracts`, `providers/aws-postgresql`, `modules/infrastructure/messaging`, `modules/infrastructure/cache`, `audio-video-observability`, `libs/audio-video-client/src/cli.ts`, `integration-tests`, `libs/audio-video-client/src/operations.ts`, `libs/audio-video-client/src/canonical-operations.ts`.

**Immediately usable output:** Authenticated development-host workflow: begin upload -> send chunks -> complete -> inspect immutable artifact -> submit supported processing job -> poll/read canonical outcome -> restart and read back the same state; CLI exposes real supported commands.

**Integrated development exit:** J02/J20/J24/J27 complete with real installed source-free client, PostgreSQL/object storage, source policy, cancellation/UNKNOWN, Event Plane outbox when used, crash recovery and no duplicate effects.

**Open task IDs (original register only):** `transactional-event-outbox`, `rights-aware-cache`, `service-observability`, `http-operation-parity`, `structured-cli`, `public-events`, `cross-surface-integration-harness`, `outcome-resumable-artifact-intake`, `outcome-durable-job-recovery`, `outcome-structured-command-batch`, `outcome-provider-outage-safe-path`.

**Affected test selectors:** `./gradlew :services:media:integration-tests:test --tests com.ghatana.media.integration.MediaLauncherArtifactIntakeRestartIT` / `pnpm --filter @audio-video/client exec vitest run src/operations.test.ts src/cli.test.ts`. Run only those whose transitive inputs changed; preserve prior verified passes.

### Project, timeline, review and usable browser shell

**Owners:** `modules/production/timeline`, `modules/production/review`, `providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/PostgresqlProjectTimelineStore.java`, `libs/audio-video-ui/src/screens`, `libs/audio-video-client/src/offline-reconnect.ts`, `runtime-contracts`.

**Immediately usable output:** A development-host browser can create a tenant-scoped owner project, persist an exact timeline revision, reopen it, display durable artifacts and job progress, and recover an edit conflict. No false shared-workspace or human-approval claims.

**Integrated development exit:** J01/J21/J23 complete after public Shared identity/workspace membership, a durable one-writer project/review CAS, authentic reviewer authority, offline key custody and installed host/browser tests.

**Open task IDs (original register only):** `web-host`, `project-timeline-engine`, `storyboard-and-shot-plan`, `versioned-review-and-approval`, `offline-reconnect`, `outcome-first-use-project`, `outcome-version-specific-review`, `outcome-offline-conflict-reconnect`.

**Affected test selectors:** `./gradlew :services:media:modules:production:timeline:test :services:media:modules:production:review:test` / `pnpm --filter @audio-video/ui exec vitest run src/screens/FirstUseProjectScreen.test.ts src/screens/ArtifactIntakeScreen.test.ts src/screens/JobRecoveryScreen.test.ts`. Run only those whose transitive inputs changed; preserve prior verified passes.

### Actual capture, live streams and playable narrated recording

**Owners:** `libs/audio-video-client/src/recorder-orchestrator.ts`, `libs/audio-video-client/src/scene-captions.ts`, `libs/audio-video-client/src/camera-capture-adapter.ts`, `modules/audio-streaming`, `modules/video-streaming`, `modules/vision/vision-service/src/main/java/com/ghatana/audio/video/vision/video/VideoFrameExtractor.java`, `modules/production/rendering`.

**Immediately usable output:** A source-authorized recording from browser/file/terminal/desktop/camera or gRPC yields actual frame bytes, approved narration, timed VTT/TTML, a decoder-playable media file and inspectable immutable source lineage.

**Integrated development exit:** Recorder and J29 complete with canonical stream lease/cursor/PTS, permission revocation, actual host transport, bounded source failure/reconnect and persisted registered output version.

**Open task IDs (original register only):** `stream-session-authority`, `grpc-source-capture`, `camera-source-capture`, `recorder-mux-and-final-artifact`, `outcome-live-session-recovery`.

**Affected test selectors:** `pnpm --filter @audio-video/client exec vitest run src/recorder-orchestrator.test.ts src/camera-capture-adapter.test.ts src/scene-captions.test.ts` / `./gradlew :services:media:modules:audio-streaming:test :services:media:modules:video-streaming:test`. Run only those whose transitive inputs changed; preserve prior verified passes.

### Real speech, captions, voice and translation

**Owners:** `modules/speech/stt-service`, `modules/speech/tts-service`, `libs/java/common/src/main/java/com/ghatana/media/stt`, `libs/java/common/src/main/java/com/ghatana/media/tts`, `modules/intelligence/ai-voice/libs/ai-voice-ui-react`, `modules/production/dubbing`, `launcher/src/main/java/com/ghatana/media/launcher/MediaCaptionRuntime.java`.

**Immediately usable output:** A source-free client can transcribe lawful supported audio into an immutable transcript/caption version and synthesize actual playable lawful voice output; missing profile/rights is typed NOT_ADMITTED.

**Integrated development exit:** J03/J04/J16 complete with verified model/license/export lineage, independent reference gold, source/word clock, consent and revocation, gRPC streaming, durable job/result restart and accurate language quality.

**Open task IDs (original register only):** `shared-engine-consolidation`, `stt-model-and-quality`, `stt-streaming-and-caption`, `tts-model-and-rights`, `tts-streaming-and-finality`, `voice-workflow-ui`, `dubbing-and-translation`, `outcome-transcript-to-reviewed-captions`, `outcome-authorized-voice-synthesis`, `outcome-translated-dubbed-video`.

**Affected test selectors:** `./gradlew :services:media:modules:speech:stt-service:test` / `./gradlew :services:media:modules:speech:tts-service:test`. Run only those whose transitive inputs changed; preserve prior verified passes.

### Source-grounded Vision, DI OCR and multimodal

**Owners:** `modules/vision/vision-service`, `modules/intelligence/multimodal-service`, `modules/video-streaming`, `launcher`, `libs/audio-video-client/src/authorized-scene-text.ts`, `runtime-contracts`.

**Immediately usable output:** Qualified still-image/ROI analysis and DI OCR return real typed boxes/text/provenance; a grounded multimodal request uses admitted child results and source clocks, not guessed fusion.

**Integrated development exit:** J05/J06/J30 complete with selected detector/DI worker, rights-cleared gold, actual video-frame timebase, precise child/parent attempt receipts, capacity and request-scoped identity, UNKNOWN under fault.

**Open task IDs (original register only):** `grpc-operation-parity`, `vision-model-and-geometry`, `vision-document-intelligence`, `multimodal-child-orchestration`, `multimodal-grounding-and-quality`, `load-and-quality-profiles`, `outcome-vision-detection-and-tracking`, `outcome-grounded-cross-modal-result`, `outcome-eligible-provider-catalog`.

**Affected test selectors:** `./gradlew :services:media:modules:vision:vision-service:test` / `./gradlew :services:media:modules:intelligence:multimodal-service:test`. Run only those whose transitive inputs changed; preserve prior verified passes.

### Production Studio and real video composition

**Owners:** `modules/production/timeline`, `modules/production/rendering`, `modules/production/review`, `libs/audio-video-ui/src/screens`, `libs/audio-video-ui/src/player`, `launcher`.

**Immediately usable output:** A developer-host Studio edits an exact project revision, previews supported tracked region/video/audio effects, renders a playable master and shows source-bound quality/review state without fixture success.

**Integrated development exit:** J08/J09/J10/J11/J18/J19 complete with real clip/frame/audio/caption/color mux output, immutable timeline/render/undo, reference-conditioned generation only when lawful and aligned references, durable readback and version-specific review.

**Open task IDs (original register only):** `video-restoration-and-comparison`, `reference-guided-generation`, `tracked-region-reversible-edits`, `multitrack-composition-render`, `quality-comparison-and-optimization`, `production-studio-host`, `outcome-video-enhancement`, `outcome-brief-to-reviewed-media`, `outcome-reference-continuity`, `outcome-reversible-tracked-edit`, `outcome-multitrack-finished-master`, `outcome-bounded-quality-improvement`.

**Affected test selectors:** `./gradlew :services:media:modules:production:rendering:test :services:media:modules:production:timeline:test` / `pnpm --filter @audio-video/ui exec vitest run src/screens/MediaProductRenderer.test.ts`. Run only those whose transitive inputs changed; preserve prior verified passes.

### Durable delivery, authorized actions and retention

**Owners:** `modules/production/delivery`, `adapters/agent-tools-media`, `modules/infrastructure/messaging`, `providers/aws-postgresql`, `runtime-contracts`, `libs/audio-video-client/src/operations.ts`, `libs/audio-video-client/src/canonical-operations.ts`.

**Immediately usable output:** A source-free client or agent can perform an authorized Media operation exactly once and reconcile an ambiguous result; a destination upload reports its actual authenticated acknowledgment; retention/revocation prevents disclosure.

**Integrated development exit:** J22/J25/J26 complete with durable destination CAS, project/artifact rights and currentness, exact authenticated tool mappings, destination readback and copy inventory/erasure constraints.

**Open task IDs (original register only):** `authorized-agent-delegation`, `delivery-export-destination-ack`, `outcome-acknowledged-delivery`, `outcome-authorized-agent-outcome`, `outcome-retention-and-erasure`.

**Affected test selectors:** `./gradlew :services:media:modules:production:delivery:test` / `./gradlew :services:media:adapters:agent-tools-media:test`. Run only those whose transitive inputs changed; preserve prior verified passes.

### Nonblocking historical cleanup and naming

**Owners:** `docs/implementation`, `docs/development/historical-content-preservation.json`, `scripts/media-historical-artifact-inventory.mjs`, `docs/README.md`, `AGENTS.md`.

**Immediately usable output:** A clean active documentation navigation and unchanged canonical source behavior; historical records classified and pinned without deleting retention-required assets.

**Integrated development exit:** The 42 protected artifacts are copied into an authenticated immutable off-main store, independently restored/hash-checked and references migrated before exact deletion. No functional Media surface waits for that deletion.

**Open task IDs (original register only):** `historical-artifact-retirement`.

**Affected test selectors:** `pnpm check:surface-docs`. Run only those whose transitive inputs changed; preserve prior verified passes.

## The 28 physical owners — exact implementation target

**`media.physical.adapters-agent-tools-media`** (`adapters/agent-tools-media`): Four authenticated Tools actions -> canonical Media jobs, durable invocation CAS and current-rights replay. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/adapters-agent-tools-media/README.md`. **OPEN:** public-events, authorized-agent-delegation.

**`media.physical.adapters-data-cloud-media`** (`adapters/data-cloud-media`): Optional downstream metadata-only integration; no Media job writer or OCR engine. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/adapters-data-cloud-media/README.md`. **OPEN:** none directly mapped; preserve working code, no rerun if unchanged.

**`media.physical.adapters-ledger`** (`adapters/ledger`): Optional RunLedger projection, one-writer CAS, stale/unknown/lost ACK readback. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/adapters-ledger/README.md`. **OPEN:** none directly mapped; preserve working code, no rerun if unchanged.

**`media.physical.apps-media-experience-explorer`** (`apps/media-experience-explorer`): Curated 47-screen/PDP3 journeys with narration, CSP/a11y, and explicit simulation labels. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/apps-media-experience-explorer/README.md`. **OPEN:** cross-surface-integration-harness.

**`media.physical.audio-video-observability`** (`audio-video-observability`): Real provider readiness, timestamp freshness, Prometheus metrics and 1/16/64 bounded host checks. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/audio-video-observability/README.md`. **OPEN:** service-observability, load-and-quality-profiles, quality-comparison-and-optimization.

**`media.physical.integration-tests`** (`integration-tests`): Actual source-free process+PostgreSQL/object-store+scanner/provider/media output and 30 journey/fault suites. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/integration-tests/README.md`. **OPEN:** load-and-quality-profiles, cross-surface-integration-harness, outcome-first-use-project, outcome-resumable-artifact-intake, outcome-transcript-to-reviewed-captions, outcome-authorized-voice-synthesis, outcome-vision-detection-and-tracking, outcome-grounded-cross-modal-result, outcome-audio-restoration, outcome-video-enhancement, outcome-brief-to-reviewed-media, outcome-reference-continuity, outcome-reversible-tracked-edit, outcome-two-dimensional-animation, outcome-three-dimensional-animation, outcome-scientific-simulation, outcome-validated-simulation-pass, outcome-translated-dubbed-video, outcome-music-effects-master, outcome-multitrack-finished-master, outcome-bounded-quality-improvement, outcome-durable-job-recovery, outcome-version-specific-review, outcome-acknowledged-delivery, outcome-offline-conflict-reconnect, outcome-structured-command-batch, outcome-authorized-agent-outcome, outcome-retention-and-erasure, outcome-provider-outage-safe-path, outcome-spatial-interactive-delivery, outcome-live-session-recovery, outcome-eligible-provider-catalog.

**`media.physical.launcher`** (`launcher`): Canonical authenticated runtime HTTP host: upload, scan, artifact, job, project, stream, cancel and recovery. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/launcher/README.md`. **OPEN:** transactional-event-outbox, rights-aware-cache, stream-session-authority, service-observability, http-operation-parity, authorized-agent-delegation, web-host, stt-streaming-and-caption, multimodal-child-orchestration, delivery-export-destination-ack, production-studio-host.

**`media.physical.libs-audio-video-client`** (`libs/audio-video-client`): Published ESM/CJS SDK, real CLI, capture adapters, narration/captions and actual decoded recording. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/libs-audio-video-client/README.md`. **OPEN:** structured-cli, web-host, vision-document-intelligence, grpc-source-capture, camera-source-capture, recorder-mux-and-final-artifact, offline-reconnect, interactive-demo-player.

**`media.physical.libs-audio-video-types`** (`libs/audio-video-types`): Strict TS schema/ABI and wire/project/clock parity with Java/OpenAPI/proto. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/libs-audio-video-types/README.md`. **OPEN:** none directly mapped; preserve working code, no rerun if unchanged.

**`media.physical.libs-audio-video-ui`** (`libs/audio-video-ui`): All applicable screens with actual host actions, typed denial/UNKNOWN, WCAG and responsive behavior. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/libs-audio-video-ui/README.md`. **OPEN:** web-host, voice-workflow-ui, project-timeline-engine, storyboard-and-shot-plan, tracked-region-reversible-edits, multitrack-composition-render, quality-comparison-and-optimization, versioned-review-and-approval, offline-reconnect, spatial-and-interactive-export, interactive-demo-player, production-studio-host, outcome-first-use-project, outcome-resumable-artifact-intake, outcome-transcript-to-reviewed-captions, outcome-authorized-voice-synthesis, outcome-vision-detection-and-tracking, outcome-grounded-cross-modal-result, outcome-audio-restoration, outcome-video-enhancement, outcome-brief-to-reviewed-media, outcome-reference-continuity, outcome-reversible-tracked-edit, outcome-two-dimensional-animation, outcome-three-dimensional-animation, outcome-scientific-simulation, outcome-validated-simulation-pass, outcome-translated-dubbed-video, outcome-music-effects-master, outcome-multitrack-finished-master, outcome-bounded-quality-improvement, outcome-durable-job-recovery, outcome-version-specific-review, outcome-acknowledged-delivery, outcome-offline-conflict-reconnect, outcome-structured-command-batch, outcome-authorized-agent-outcome, outcome-retention-and-erasure, outcome-provider-outage-safe-path, outcome-spatial-interactive-delivery, outcome-live-session-recovery, outcome-eligible-provider-catalog.

**`media.physical.libs-common`** (`libs/common`): Bounded shared transport, TLS/authorization/deadline and stable consumer ABI. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/libs-common/README.md`. **OPEN:** grpc-operation-parity, shared-engine-consolidation.

**`media.physical.libs-java-common`** (`libs/java/common`): Reusable model/codec/native host primitives, no duplicate processing pipeline. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/libs-java-common/README.md`. **OPEN:** shared-engine-consolidation, stt-model-and-quality, tts-model-and-rights, vision-model-and-geometry.

**`media.physical.libs-media-experience-simulation`** (`libs/media-experience-simulation`): Reproducible authored fixtures, explicit simulated status; never count as real provider effect. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/libs-media-experience-simulation/README.md`. **OPEN:** structured-cli, interactive-demo-player.

**`media.physical.modules-audio-streaming`** (`modules/audio-streaming`): Authenticated frames, clock/cursor/lease/ACK/backpressure/revoke/restart. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/modules-audio-streaming/README.md`. **OPEN:** stream-session-authority, tts-streaming-and-finality, grpc-source-capture.

**`media.physical.modules-infrastructure-cache`** (`modules/infrastructure/cache`): SourceVersion+tenant+policyEpoch cache, immediate revocation/erasure safe invalidation. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/modules-infrastructure-cache/README.md`. **OPEN:** rights-aware-cache.

**`media.physical.modules-infrastructure-messaging`** (`modules/infrastructure/messaging`): Transactional event outbox, append/consumer/destination ACK separate from job finality. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/modules-infrastructure-messaging/README.md`. **OPEN:** transactional-event-outbox, public-events.

**`media.physical.modules-infrastructure-persistence`** (`modules/infrastructure/persistence`): One database authority, immutable revisions, atomic CAS and migration/restart. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/modules-infrastructure-persistence/README.md`. **OPEN:** none directly mapped; preserve working code, no rerun if unchanged.

**`media.physical.modules-infrastructure-security`** (`modules/infrastructure/security`): Trusted current principal/rights/consent/retention and zero effect on unknown. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/modules-infrastructure-security/README.md`. **OPEN:** none directly mapped; preserve working code, no rerun if unchanged.

**`media.physical.modules-integration-tests`** (`modules/integration-tests`): Cross-module contract and source-free positive/negative/restart consumer coverage. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/modules-integration-tests/README.md`. **OPEN:** cross-surface-integration-harness, outcome-first-use-project, outcome-resumable-artifact-intake, outcome-transcript-to-reviewed-captions, outcome-authorized-voice-synthesis, outcome-vision-detection-and-tracking, outcome-grounded-cross-modal-result, outcome-audio-restoration, outcome-video-enhancement, outcome-brief-to-reviewed-media, outcome-reference-continuity, outcome-reversible-tracked-edit, outcome-two-dimensional-animation, outcome-three-dimensional-animation, outcome-scientific-simulation, outcome-validated-simulation-pass, outcome-translated-dubbed-video, outcome-music-effects-master, outcome-multitrack-finished-master, outcome-bounded-quality-improvement, outcome-durable-job-recovery, outcome-version-specific-review, outcome-acknowledged-delivery, outcome-offline-conflict-reconnect, outcome-structured-command-batch, outcome-authorized-agent-outcome, outcome-retention-and-erasure, outcome-provider-outage-safe-path, outcome-spatial-interactive-delivery, outcome-live-session-recovery, outcome-eligible-provider-catalog.

**`media.physical.modules-intelligence-ai-voice-libs-ai-voice-ui-react`** (`modules/intelligence/ai-voice/libs/ai-voice-ui-react`): Lawful accessible voice/phrase UI connected to approved TTS outputs. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/modules-intelligence-ai-voice-libs-ai-voice-ui-react/README.md`. **OPEN:** voice-workflow-ui.

**`media.physical.modules-intelligence-multimodal-service`** (`modules/intelligence/multimodal-service`): Grounded source+time+rights child joins with durable parent and uncertainty. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/modules-intelligence-multimodal-service/README.md`. **OPEN:** grpc-operation-parity, multimodal-child-orchestration, multimodal-grounding-and-quality.

**`media.physical.modules-intelligence-speech-libs-speech-audio-rust`** (`modules/intelligence/speech/libs/speech-audio-rust`): Native DSP/codec bounds, alias/cancellation/memory/JNI lifecycle. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/modules-intelligence-speech-libs-speech-audio-rust/README.md`. **OPEN:** audio-repair-and-comparison, foley-stems-mix-master.

**`media.physical.modules-speech-stt-service`** (`modules/speech/stt-service`): Real lawful Whisper output, immutable word-clock transcript/caption and WER/CER. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/modules-speech-stt-service/README.md`. **OPEN:** grpc-operation-parity, stt-model-and-quality, stt-streaming-and-caption, dubbing-and-translation.

**`media.physical.modules-speech-tts-service`** (`modules/speech/tts-service`): Real lawful Piper voice PCM/stream/audio artifact with rights/finality. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/modules-speech-tts-service/README.md`. **OPEN:** grpc-operation-parity, tts-model-and-rights, tts-streaming-and-finality, dubbing-and-translation.

**`media.physical.modules-video-streaming`** (`modules/video-streaming`): Immutable video frame/sourceVersion/PTS/ROI/epoch stream readback. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/modules-video-streaming/README.md`. **OPEN:** stream-session-authority, grpc-source-capture, camera-source-capture.

**`media.physical.modules-vision-vision-service`** (`modules/vision/vision-service`): Real OCI Vision detector/tracker and DI-only scene OCR with authenticated frame source. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/modules-vision-vision-service/README.md`. **OPEN:** grpc-operation-parity, vision-model-and-geometry, vision-document-intelligence, video-restoration-and-comparison, tracked-region-reversible-edits.

**`media.physical.providers-aws-postgresql`** (`providers/aws-postgresql`): Durable artifacts/job/captions/project/review/delivery schemas and clean migration. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/providers-aws-postgresql/README.md`. **OPEN:** transactional-event-outbox, stt-streaming-and-caption, tts-streaming-and-finality, delivery-export-destination-ack.

**`media.physical.runtime-contracts`** (`runtime-contracts`): Single Java domain/rights/version/clock/job/scan/project operation contracts. **Exit:** verified consumer API, exact actor/sourceVersion/rights/result and real positive+adverse/cancel/restart; affected focused suites; update `docs/surfaces/runtime-contracts/README.md`. **OPEN:** public-events, authorized-agent-delegation, project-timeline-engine, storyboard-and-shot-plan, versioned-review-and-approval.

## The 21 logical surface channels — no private implementations

**`media.surface.web`**: Real browser product project, artifact, job, edit/review/render and delivery operations. Bind to registered physical owner and actual HTTP/gRPC/SDK/CLI/UI/Tools event protocol, permissions and truthful failure; cross-interface integration test; no new writer. **OPEN:** web-host, production-studio-host.

**`media.surface.embedded`**: Sandboxed origin-bound hosted playback, captions, branch/seek/replay and no privilege leak. Bind to registered physical owner and actual HTTP/gRPC/SDK/CLI/UI/Tools event protocol, permissions and truthful failure; cross-interface integration test; no new writer. **OPEN:** interactive-demo-player.

**`media.surface.public-http`**: OpenAPI/route/implementation exact parity including authenticated errors. Bind to registered physical owner and actual HTTP/gRPC/SDK/CLI/UI/Tools event protocol, permissions and truthful failure; cross-interface integration test; no new writer. **OPEN:** http-operation-parity.

**`media.surface.service-grpc`**: Current descriptor RPC inventory, method authorization, deadlines and streaming finality. Bind to registered physical owner and actual HTTP/gRPC/SDK/CLI/UI/Tools event protocol, permissions and truthful failure; cross-interface integration test; no new writer. **OPEN:** grpc-operation-parity.

**`media.surface.grpc.stt`**: Real STT, streaming, language/model source/version and safe cancellation. Bind to registered physical owner and actual HTTP/gRPC/SDK/CLI/UI/Tools event protocol, permissions and truthful failure; cross-interface integration test; no new writer. **OPEN:** stt-streaming-and-caption, grpc-operation-parity.

**`media.surface.grpc.tts`**: Real TTS, voice scope, decoded audio and stream lifecycle. Bind to registered physical owner and actual HTTP/gRPC/SDK/CLI/UI/Tools event protocol, permissions and truthful failure; cross-interface integration test; no new writer. **OPEN:** tts-streaming-and-finality, grpc-operation-parity.

**`media.surface.grpc.vision`**: Real source-bound detection, video frame tracking and DI ROI. Bind to registered physical owner and actual HTTP/gRPC/SDK/CLI/UI/Tools event protocol, permissions and truthful failure; cross-interface integration test; no new writer. **OPEN:** vision-model-and-geometry, grpc-operation-parity.

**`media.surface.grpc.multimodal`**: Grounded child/parent orchestration and provenance. Bind to registered physical owner and actual HTTP/gRPC/SDK/CLI/UI/Tools event protocol, permissions and truthful failure; cross-interface integration test; no new writer. **OPEN:** multimodal-child-orchestration, grpc-operation-parity.

**`media.surface.sdk`**: Packaged ESM/CJS exact canonical routes, unsupported legacy calls fail closed. Bind to registered physical owner and actual HTTP/gRPC/SDK/CLI/UI/Tools event protocol, permissions and truthful failure; cross-interface integration test; no new writer. **OPEN:** already covered by unchanged child code.

**`media.surface.cli`**: Real artifact/job/capture/record commands, JSON errors and exit codes. Bind to registered physical owner and actual HTTP/gRPC/SDK/CLI/UI/Tools event protocol, permissions and truthful failure; cross-interface integration test; no new writer. **OPEN:** structured-cli.

**`media.surface.agent-tools`**: Four delegated rights-bound, once-fenced tool actions. Bind to registered physical owner and actual HTTP/gRPC/SDK/CLI/UI/Tools event protocol, permissions and truthful failure; cross-interface integration test; no new writer. **OPEN:** authorized-agent-delegation.

**`media.surface.events`**: Versioned lifecycle event identity and source state/currentness. Bind to registered physical owner and actual HTTP/gRPC/SDK/CLI/UI/Tools event protocol, permissions and truthful failure; cross-interface integration test; no new writer. **OPEN:** public-events.

**`media.surface.integrations`**: Shared public identity, DI-only OCR, optional Data Cloud. Bind to registered physical owner and actual HTTP/gRPC/SDK/CLI/UI/Tools event protocol, permissions and truthful failure; cross-interface integration test; no new writer. **OPEN:** vision-document-intelligence.

**`media.surface.types-library`**: Typed TS source parity and invalid/overflow test paths. Bind to registered physical owner and actual HTTP/gRPC/SDK/CLI/UI/Tools event protocol, permissions and truthful failure; cross-interface integration test; no new writer. **OPEN:** already covered by unchanged child code.

**`media.surface.ui-library`**: Accessible reusable screen/Studio widgets and action ports. Bind to registered physical owner and actual HTTP/gRPC/SDK/CLI/UI/Tools event protocol, permissions and truthful failure; cross-interface integration test; no new writer. **OPEN:** web-host, voice-workflow-ui.

**`media.surface.explorer`**: Authored deterministic scenario and labeled preview, not backend execution. Bind to registered physical owner and actual HTTP/gRPC/SDK/CLI/UI/Tools event protocol, permissions and truthful failure; cross-interface integration test; no new writer. **OPEN:** already covered by unchanged child code.

**`media.surface.desktop-archive`**: No active production imports; compatibility-only archived source. Bind to registered physical owner and actual HTTP/gRPC/SDK/CLI/UI/Tools event protocol, permissions and truthful failure; cross-interface integration test; no new writer. **OPEN:** already covered by unchanged child code.

**`media.surface.recorder-orchestrator`**: Unattended real recapture+approved narration+captions+playable output. Bind to registered physical owner and actual HTTP/gRPC/SDK/CLI/UI/Tools event protocol, permissions and truthful failure; cross-interface integration test; no new writer. **OPEN:** recorder-mux-and-final-artifact.

**`media.surface.capture-adapters`**: Real browser/desktop/mobile/terminal/file/API/gRPC/camera capture with permissions. Bind to registered physical owner and actual HTTP/gRPC/SDK/CLI/UI/Tools event protocol, permissions and truthful failure; cross-interface integration test; no new writer. **OPEN:** grpc-source-capture, camera-source-capture.

**`media.surface.production-studio`**: Actual revision editor, timeline, color, mix, render, review, export and accessibility. Bind to registered physical owner and actual HTTP/gRPC/SDK/CLI/UI/Tools event protocol, permissions and truthful failure; cross-interface integration test; no new writer. **OPEN:** production-studio-host.

**`media.surface.interactive-demo-player`**: Safe branching replay with exact source time, caption and origin policy. Bind to registered physical owner and actual HTTP/gRPC/SDK/CLI/UI/Tools event protocol, permissions and truthful failure; cross-interface integration test; no new writer. **OPEN:** interactive-demo-player.

## The seven composed product contracts

**`media.composition.repository-root`**: All advertised user/API/agent experiences and 469 leaf requirements are source-grounded and runnable. Run the actual installed/hosted positive outcome with shared version/actor/PTS/finality across children plus deny/restart/UNKNOWN, not a suite of mock-only child successes.

**`media.composition.ingestion-and-versioned-artifacts`**: Source-bound upload -> scanner -> immutable version -> authorized read/range and restart. Run the actual installed/hosted positive outcome with shared version/actor/PTS/finality across children plus deny/restart/UNKNOWN, not a suite of mock-only child successes.

**`media.composition.governed-job-execution`**: Authenticated request -> durable attempt -> provider receipt -> UNKNOWN/reconcile -> finality and outbox. Run the actual installed/hosted positive outcome with shared version/actor/PTS/finality across children plus deny/restart/UNKNOWN, not a suite of mock-only child successes.

**`media.composition.speech-and-caption-workflows`**: Lawful audio -> STT transcript -> corrected caption version, real TTS output. Run the actual installed/hosted positive outcome with shared version/actor/PTS/finality across children plus deny/restart/UNKNOWN, not a suite of mock-only child successes.

**`media.composition.vision-and-multimodal-analysis`**: Verified frame/ROI/PTS -> detector/DI OCR -> source-grounded child fusion. Run the actual installed/hosted positive outcome with shared version/actor/PTS/finality across children plus deny/restart/UNKNOWN, not a suite of mock-only child successes.

**`media.composition.creation-composition-and-delivery`**: Project timeline -> render/mix/animation/simulation -> review -> delivered checksum receipt. Run the actual installed/hosted positive outcome with shared version/actor/PTS/finality across children plus deny/restart/UNKNOWN, not a suite of mock-only child successes.

**`media.composition.client-and-machine-interfaces`**: Same semantic meaning across HTTP/gRPC/SDK/CLI/UI/Tools/events, no bypass or invented route. Run the actual installed/hosted positive outcome with shared version/actor/PTS/finality across children plus deny/restart/UNKNOWN, not a suite of mock-only child successes.

## Implementation submodules outside the original registered surface roster

They remain legitimate Media engineering source under existing compositions; do not invent lifecycle surface IDs just to implement/test them.

- `modules/production/animation`: Actual decoded 2D PNG/GIF with exact frame clock, bounded assets and persistent artifact later.

- `modules/production/timeline`: Canonical ProjectRevision head + Timeline/Scene/Track/Clip mapping, one durable CAS writer.

- `modules/production/simulation`: Bounded SI unit solver, deterministic output; do not call simulated data measurement.

- `modules/production/spatial`: Valid GLB with versioned coordinate conversion and disclosed float32 losses.

- `modules/production/audio-mixing`: Decoded WAV/stem mixer, actual peaks and sourced A/B comparison.

- `modules/production/rendering`: Real decodable video+audio+caption mux, exact PTS/digest and durable output.

- `modules/production/review`: Issued reviewer case/version CAS; ACCEPT statement is not human approval.

- `modules/production/delivery`: Authenticated actual destination checksum/ACK, durable lost ACK reconciliation.

- `modules/production/dubbing`: Rights-scoped translation, lawful voice, alignment and playable final audio.

- `modules/vision/vision-service/src/main/java/com/ghatana/audio/video/vision/scenetext`: Trusted Media frame/ROI/PTS reader and public DI-only OCR.

- `providers/aws-postgresql`: Scanner+artifact release decision, version-bound verified attestation and no untrusted release.

## Thirty real business outcomes: single task identity, explicit acceptance

| Journey | Area | Behavior to run through a real client |
| --- | --- | --- |
| J-01 | workspace-project | Real sign-in/workspace/project revision; wrong tenant, duplicate create.; actual output, denial, UNKNOWN/restart |
| J-02 | headless-media | Real chunked upload/versioned artifact and corrupt/resume/restart.; actual output, denial, UNKNOWN/restart |
| J-03 | speech-voice | Real licensed audio -> transcript revision -> corrected caption; revoke/UNKNOWN/restart.; actual output, denial, UNKNOWN/restart |
| J-04 | speech-voice | Lawful voice -> real decoded audio; denied locale/profile/revoke.; actual output, denial, UNKNOWN/restart |
| J-05 | vision-multimodal | Actual image/video geometry+track source PTS; malformed ROI.; actual output, denial, UNKNOWN/restart |
| J-06 | vision-multimodal | Real STT/Vision+DI child -> grounded typed response; wrong clock/rights.; actual output, denial, UNKNOWN/restart |
| J-07 | creative-preview | Real denoise/declip measured A/B with source preservation.; actual output, denial, UNKNOWN/restart |
| J-08 | studio-video | Real codec/frame repair and independent measured comparison.; actual output, denial, UNKNOWN/restart |
| J-09 | studio-video | Versioned brief/storyboard -> render -> review output.; actual output, denial, UNKNOWN/restart |
| J-10 | studio-video | Rights-checked conditioned output, continuity metrics and typed unavailability.; actual output, denial, UNKNOWN/restart |
| J-11 | studio-video | Real tracked ROI mask edit with precise version CAS and undo.; actual output, denial, UNKNOWN/restart |
| J-12 | creative-preview | Deterministic 2D animation renders decodable frames and golden curves.; actual output, denial, UNKNOWN/restart |
| J-13 | creative-preview | Rig/3D spatial render with coordinate/kinematic correctness.; actual output, denial, UNKNOWN/restart |
| J-14 | creative-preview | Unit-correct dynamics and instrument values; solver negatives.; actual output, denial, UNKNOWN/restart |
| J-15 | creative-preview | Executable constrained pass with semantic validity and abstention.; actual output, denial, UNKNOWN/restart |
| J-16 | speech-voice | Actual translation+legal dubbing, lip/timing metadata and source rights.; actual output, denial, UNKNOWN/restart |
| J-17 | creative-preview | Playable stems/foley/mix master with lawful input and peak caps.; actual output, denial, UNKNOWN/restart |
| J-18 | studio-video | Combined video+audio+caption+graphic color render with checksum.; actual output, denial, UNKNOWN/restart |
| J-19 | studio-video | Real quality metric and bounded optimization/reversible comparison.; actual output, denial, UNKNOWN/restart |
| J-20 | headless-media | Job pending/running/UNKNOWN/terminal across real process restart.; actual output, denial, UNKNOWN/restart |
| J-21 | workspace-project | Immutable-review approval invalidated by changed source revision.; actual output, denial, UNKNOWN/restart |
| J-22 | delivery-agents | Actual export/publish destination ACK, lost-ACK reconciliation.; actual output, denial, UNKNOWN/restart |
| J-23 | workspace-project | Encrypted offline edits, fresh-rights reconnect, version conflict handling.; actual output, denial, UNKNOWN/restart |
| J-24 | headless-media | Authenticated CLI JSON batch with true finality and typed failures.; actual output, denial, UNKNOWN/restart |
| J-25 | delivery-agents | Four agent handlers authorized delegate, no duplicate side effects.; actual output, denial, UNKNOWN/restart |
| J-26 | delivery-agents | Real revoke/hold/deletion and no post-erasure disclosure.; actual output, denial, UNKNOWN/restart |
| J-27 | headless-media | Unavailable/degraded/no-fallback/UNKNOWN behavior without fake success.; actual output, denial, UNKNOWN/restart |
| J-28 | creative-preview | Real 360/spatial/interactive export and viewer fidelity.; actual output, denial, UNKNOWN/restart |
| J-29 | recorder-live | Real media loss/reconnect/consent revoke and bounded stream recovery.; actual output, denial, UNKNOWN/restart |
| J-30 | vision-multimodal | Real qualified model/voice/host readiness with unavailable cases.; actual output, denial, UNKNOWN/restart |

## PDP/contract and later gtool-ready configuration — no gtool work

Keep `.product-experience/` as PDP0–3 meaning and stable surface IDs; preserve declarative `config/closure/consumer.json`, phase-program, phase-binding and obligation refs **as source paths only**. No gtool, phase status, seals or evidence actions. Run source-oriented `pnpm check:surface-roster`, `pnpm check:surface-docs`, `pnpm check:capability-implementation-crosswalk`, and affected OpenAPI/proto/SDK parity only when their inputs change. Reconcile stale registry counts against compiled current handler descriptors; never invent 45th/46th RPC to make counts match.

All **469 PDP0 leaf requirements / 38 families** remain in the original crosswalk; its 463 `NOT_IMPLEMENTED` and 6 `OPTIONAL_DEFERRED` are conservative whole-task classifications, not proof local engines are absent. For every leaf, identify exact input, public operation, actor/permission, real output, state, validation and negative case; update existing crosswalk only on direct tested behavior, not broad family inference.

Shared identity/workspace remains an owner-issued public boundary; a local signed DEV_ONLY issuer is not production membership. DI alone owns OCR, Media owns frame/ROI/PTS; Kernel OCR consumer is independent. Data Cloud is optional, not a processing dependency. Real provider rights/labeled gold and named production host remain true positive qualification inputs. The 42 retained history artifacts are not a functional blocker and may be removed only after verified immutable external archive readback.

## Definition of dev complete

Every active public API and advertised feature works at its genuine supported scope with actual client-visible data, source/rights/clock/tenant/finality, negative/revoke/timeout/UNKNOWN/restart checks, meaningful resource/quality tests, documented configured runtimes, coherent stable source registries and all 30 real journeys. Nothing is marked complete by planning or by optional gtool configuration alone.
