# Ghatana Media execution handoff — 2026-11-08

This is a dated status snapshot requested by the owner. The canonical task definition and current evidence remain in [remaining-work.json](remaining-work.json) and [REMAINING-WORK.md](REMAINING-WORK.md); this file does not add requirements or change task states.

## Current position

- The 103-task register contains **30 VERIFIED, 72 OPEN, and 1 OPTIONAL_DEFERRED_NO_CORE_BLOCKER**. The optional item is FLEURS; Hindi is deferred for the current ASR phase.
- This run completed the local gRPC capture result-invariant increment and tested audio 27/27 and video 32/32. The task remains OPEN for owner-defined authenticated transport and durable source cursor/version/PTS readback.
- The local Vision Docker fixture passed 9/9 on Docker Desktop ARM64; this is not production Linux host, model-rights, or detector-quality qualification.
- No formal BUILD admission, PDP acceptance/closure, release, deployment, provider admission, or source/data-writer cutover is claimed.
- The local worktree is intended to be clean after the handoff commits. Push must remain a normal fast-forward; never force-push.

## Bottlenecks that affect multiple tasks

1. **Shared identity and workspace authority:** [Shared #242](https://github.com/samujjwal/ghatana-shared/issues/242) is open with no comments. Public continuation, workspace membership, currentness, expiry, revocation, and reconciliation semantics are still absent. This blocks sign-in/workspace actions and reliable host/principal binding.
2. **Installed Document Intelligence ABI:** [Shared #246](https://github.com/samujjwal/ghatana-shared/issues/246) and [Ghatana #252](https://github.com/samujjwal/ghatana/issues/252) remain open. The public DI client still pairs with a SNAPSHOT extraction peer; no immutable installed consumer pair, qualified worker/model, or real licensed gold was found. DI remains the sole OCR executor. [Kernel #99](https://github.com/samujjwal/ghatana-kernel/issues/99) also remains test-transport-only and NOT_ADMITTED.
3. **Source/frame/clock ownership:** [Media #23](https://github.com/samujjwal/ghatana-media/issues/23) remains open. Media's still-image path cannot establish immutable video frame identity, source version, PTS/timebase, or a qualified extraction receipt. The source owner must provide the resolver and authenticated transport contract.
4. **Rights, models, and independent gold:** no rights-reviewed Whisper checkpoint/export plus complete independent transcript/audio, lawful Piper voice/profile, or detector weights/labeled gold are available for real inference. Do not process FLEURS or Hindi for this phase and do not replace missing gold with synthetic output.
5. **Host and codec qualification:** Docker Desktop fixture tests are not Linux production cgroup qualification. FFmpeg/ffprobe and an owner-approved pinned recorder codec profile are absent. Actual playable mux output, source-free positive modality tests, and 1/16/64 host measurements remain outstanding.
6. **Canonical project and effect receipts:** project/scene/timeline mapping, J-10 candidate-to-continuity result join, durable destination ACKs, shared project/review CAS, and per-tool agent operation mappings need their owning contracts. Unknown outcomes must not be retried as success.
7. **Archive deletion:** the 42 pinned artifacts (428,652,561 bytes) remain in the active tree until an authenticated immutable off-main copy, independent hash/restore readback, and reference migration are proven. No deletion is admitted.
8. **Downstream platform projection:** [Ghatana #254](https://github.com/samujjwal/ghatana/issues/254) remains open, but Data Cloud is optional and is **not** a core Media blocker. Do not make Media jobs, uploads, or modality paths depend on it.

## All OPEN task units and their next completion gates

### Foundations

- **`media.dev.transactional-event-outbox`** — Blocker: owner-defined event identity/finality and durable Event Plane receipt semantics. Next: bind the approved fingerprint/ACK contract, then prove crash/restart reconciliation without duplicate publication.
- **`media.dev.rights-aware-cache`** — Blocker: current rights owner and replayable invalidation identity are not wired. Next: connect source-version and revocation observations to cache read/write admission and test stale, revoked, and replay cases.
- **`media.dev.stream-session-authority`** — Blocker: authenticated session/consent plus source cursor/version/PTS/timebase authority is missing. Next: obtain the owner resolver, bind durable lease and cursor readback, then run restart and measured-load cases.
- **`media.dev.service-observability`** — Blocker: the new missing/NaN timestamp alert has not run under pinned `promtool` because Docker is unavailable; deployed scrape/Alertmanager, render producers, and 1/16/64 evidence are also absent. Next: run pinned rules on an available Docker host, then verify deployed fire/clear and runtime producers.

### Interfaces

- **`media.dev.http-operation-parity`** — Blocker: all declared routes have local handlers, but consent-grant request/receipt binding and durable stream-open replay identity remain owner-defined gaps. Next: obtain exact Shared identity and operation contracts; keep those effects NOT_ADMITTED until then.
- **`media.dev.grpc-operation-parity`** — Blocker: source permissions for 28 role grants are undefined. Next: obtain per-method authorization semantics, then implement/test mTLS/JWT, bounded streams, and typed outcomes; preserve default-deny meanwhile.
- **`media.dev.structured-cli`** — Blocker: production CLI currently admits only `artifact inspect`; job/capture/recorder/batch operations lack admitted routes and finality semantics. Next: add commands only after their exact public operations are bound.
- **`media.dev.public-events`** — Blocker: canonical event/outbox identity, durable receipt, and consumer restart semantics are incomplete. Next: bind the public payload and source-free consumer to the owner receipt contract; keep ACK separate from job finality.
- **`media.dev.authorized-agent-delegation`** — Blocker: four tools lack per-tool canonical operation mapping, verified actor/source rights, and durable output receipt. Next: obtain those bindings and prove exclusive claim plus pre-dispatch fence before any real dispatch.
- **`media.dev.web-host`** — Blocker: additional product actions lack admitted route/identity semantics (cancel/retry, project edits, exact-version inspection). Next: bind supported operations first, then add accessible UI actions with typed denial/unknown states.
- **`media.dev.voice-workflow-ui`** — Blocker: no qualified lawful TTS voice operation or durable audio result exists. Next: wait for voice rights/model and canonical TTS contract, then wire accessible phrase/voice/stem controls to admitted operations.

### Modalities

- **`media.dev.shared-engine-consolidation`** — Blocker: no behavior-preserving retry or auth/TLS merge is justified; native leak audit and broader host/provider qualification remain. Next: continue the native lifecycle/leak and auth-parity audit without merging distinct retry contracts.
- **`media.dev.stt-model-and-quality`** — Blocker: exact Whisper checkpoint/export rights, complete independent audio/transcript gold, and named-host evidence are absent. Next: once supplied, compare complete transcript on the pinned artifact and run same-input 0/1/2/4-thread A/B; current model-free guards passed only.
- **`media.dev.stt-streaming-and-caption`** — Blocker: trusted stream session/consent/source clock, lawful audio/provider output, and durable transcript/caption revision readback are absent. Next: bind the canonical session and provider attempt, then test corrected transcript/caption persistence, revoke, lost ACK, and restart.
- **`media.dev.tts-model-and-rights`** — Blocker: licensed pinned voice/model, consent, and independently qualified decoded output are absent. Next: obtain those inputs, then verify real bytes, profile identity, quality, and denied/revoked cases.
- **`media.dev.tts-streaming-and-finality`** — Blocker: no lawful voice bytes or exact durable artifact/outbox identity/lost-ACK recovery exists. Next: connect admitted TTS output to canonical storage/outbox and prove one-write/restart behavior before load qualification.
- **`media.dev.vision-model-and-geometry`** — Blocker: detector rights/gold, trusted video frame resolver, tracking quality, and production Linux host qualification are absent. Next: acquire pinned rights-cleared weights and independent labels, bind source frame/version/PTS, then qualify real decode/detection/tracking; Docker fixture passed 9/9 only.
- **`media.dev.vision-document-intelligence`** — Blocker: immutable installed Shared/DI ABI, authenticated DI endpoint/identity, lawful worker/model and source rights are absent. Next: DI/Shared owners publish the compatible package and worker; Media consumes only the public client and keeps video OCR NOT_ADMITTED until frame authority exists.
- **`media.dev.multimodal-child-orchestration`** — Blocker: qualified STT/Vision child results, source/clock/rights joins, and integrated durable parent finality are absent. Next: bind exact child attempts/receipts to the parent and prove restart/readback with real admitted children.
- **`media.dev.multimodal-grounding-and-quality`** — Blocker: retained source-frame map, authoritative source clock, durable child source/version identity, and calibrated provider metrics are absent. Next: add only owner-supplied source mappings and calibration evidence; keep results `SYNC_UNDETERMINED` or `HEURISTIC_UNCALIBRATED` otherwise.
- **`media.dev.load-and-quality-profiles`** — Blocker: no admitted real modality model, rights-cleared gold, or named measured host. Next: after each exact provider is admitted, record c1/c16/c64 latency, throughput, CPU/RSS/fd/pid and saturation evidence.

### Capture

- **`media.dev.grpc-source-capture`** — Blocker: authenticated transport/readback and durable source cursor/version/PTS/timebase contract are missing. Next: bind the owner request/receipt mapping; the local result-count/cursor invariant now passes audio 27/27 and video 32/32.
- **`media.dev.camera-source-capture`** — Blocker: canonical session/consent binding, device permission/readiness, indicators, and hardware/browser qualification are incomplete. Next: integrate with the canonical session owner and verify permission loss/revoke/reconnect on real supported hosts.
- **`media.dev.recorder-mux-and-final-artifact`** — Blocker: no owner-approved pinned mux/decoder profile or ffprobe evidence; FFmpeg/ffprobe are absent. Next: obtain a licensed pinned profile and durable upload recovery, then create and inspect a genuinely decodable versioned recording.

### Creative and host surfaces

- **`media.dev.project-timeline-engine`** — Blocker: canonical project/scene/timeline mapping and shared source-revision CAS/identity are unresolved. Next: obtain the project owner mapping, then bind edits/undo to durable revision readback.
- **`media.dev.storyboard-and-shot-plan`** — Blocker: `AuthoredBrief` lacks tenant/project identity and no canonical SceneGraph/timeline mapping or reviewer authority is admitted. Next: obtain those owner contracts before wiring a generated plan to a project or renderer.
- **`media.dev.audio-repair-and-comparison`** — Blocker: rights-cleared input/reference and independent denoise/declip quality evidence are absent. Next: use a lawful pinned corpus and objective A/B criteria; keep fixture DSP separate from real quality claims.
- **`media.dev.video-restoration-and-comparison`** — Blocker: trusted frame/PTS source and licensed restore codec/model plus independent A/B reference are absent. Next: bind the source frame map and run measured decode/restore/encode comparisons on qualified inputs.
- **`media.dev.reference-guided-generation`** — Blocker: rights-bound model or approved deterministic template output and the durable J-10 output join (`MDC30-C-10`) are missing. Next: specify the output/continuity join with its owner and verify source lineage before admitting generated output.
- **`media.dev.tracked-region-reversible-edits`** — Blocker: no canonical project revision CAS, trusted tracking/frame source, or durable output/undo readback. Next: bind the exact source/version and edit operation to the project owner, then test real tracking and revision-specific undo.
- **`media.dev.dubbing-and-translation`** — Blocker: translation policy, lawful voice/profile/consent, source timing, and actual audio output are absent. Next: obtain licensed voice and translation semantics, then qualify timing/lip metadata and lost-ACK behavior.
- **`media.dev.foley-stems-mix-master`** — Blocker: lawful production stems, authoritative rights, and measured true-peak/perceptual standards are absent. Next: use rights-cleared stems and owner-defined mastering limits, then verify playable master and delivery.
- **`media.dev.multitrack-composition-render`** — Blocker: canonical track/scene mappings, qualified codecs, and a durable composite output receipt are missing. Next: bind the selected timeline versions and render dependencies, then decode and verify the assembled artifact.
- **`media.dev.quality-comparison-and-optimization`** — Blocker: independent quality references, meaningful metrics/thresholds, and host measurements are absent. Next: define source-bound metrics and bounded reversible changes against qualified references.
- **`media.dev.versioned-review-and-approval`** — Blocker: owner-issued case/reviewer authority and an atomic CAS shared with canonical project revision are absent; human approval is NOT_ADMITTED. Next: bind review to the project owner and gather authentic reviewer evidence; keep local ACCEPT as a review statement only.
- **`media.dev.delivery-export-destination-ack`** — Blocker: exact owner request/result fingerprint, destination identity, durable currentness fence, and authentic destination ACK are absent. Next: obtain the owner receipt schema and prove same-key replay/readback; timeout stays UNKNOWN.
- **`media.dev.offline-reconnect`** — Blocker: production key custody/rights authority and canonical project-edit endpoint/readback are absent. Next: bind fresh rights and project version to the offline edit; keep local encrypted-store behavior separate from production effects.
- **`media.dev.spatial-and-interactive-export`** — Blocker: target spatial profile, coordinate/loss policy, qualified encoder, and viewer fidelity evidence are missing. Next: owner defines the profile and conversion-loss output, then verify actual export and playback.
- **`media.dev.interactive-demo-player`** — Blocker: admitted encoded artifact, source/time metadata, and hosted viewer fidelity/transport are absent. Next: connect only after a qualified export profile and exact artifact identity exist.
- **`media.dev.production-studio-host`** — Blocker: authenticated host identity and admitted project/render/review routes are incomplete. Next: consume owner-approved public operations and verify real host-to-runtime finality without enabling NOT_ADMITTED effects.

### Verification and retention

- **`media.dev.cross-surface-integration-harness`** — Blocker: current selectors cover bounded fixtures, not all 30 end-to-end client/host outcomes or admitted positive effects/restart. Next: close each supported workflow selector and add real positives only when its provider/rights/host gate is satisfied.
- **`media.dev.historical-artifact-retirement`** — Blocker: no immutable off-main archive, independent readback/restore, or reference migration. Next: verify all 42 pinned artifacts externally before any deletion; deletion remains held.

### Journey outcomes

- **`media.dev.outcome-first-use-project` (J-01)** — Blocker: Shared identity/workspace membership plus canonical project authority. Next: obtain #242's public contract, then test duplicate, wrong-tenant, and revision readback.
- **`media.dev.outcome-resumable-artifact-intake` (J-02)** — Blocker: complete client/host durable upload flow with source-free storage readback and crash/resume evidence. Next: verify real isolated-store bytes and restart on the admitted upload route.
- **`media.dev.outcome-transcript-to-reviewed-captions` (J-03)** — Blocker: lawful source audio, qualified STT, authenticated session/consent, durable transcript/caption revisions and reviewer authority. Next: bind exact audio/version and test revoke/UNKNOWN/restart.
- **`media.dev.outcome-authorized-voice-synthesis` (J-04)** — Blocker: real lawful voice/profile/consent and decoded TTS output. Next: qualify a pinned voice, prove denied locale/profile and revocation, then decode returned bytes.
- **`media.dev.outcome-vision-detection-and-tracking` (J-05)** — Blocker: detector rights/gold, trusted frame/PTS resolver and real tracking. Next: qualify exact image/video inputs and independent bbox/mAP references.
- **`media.dev.outcome-grounded-cross-modal-result` (J-06)** — Blocker: admitted STT/Vision/DI children, exact source/clock provenance, and durable parent identity. Next: execute source-free installed consumers and deny wrong-clock/right cases.
- **`media.dev.outcome-audio-restoration` (J-07)** — Blocker: lawful audio/reference and measured restoration A/B. Next: run on pinned source-preserving fixtures with owner-approved metrics and verify no source overwrite.
- **`media.dev.outcome-video-enhancement` (J-08)** — Blocker: qualified decoder/codec, trusted frame mapping and independent visual comparison. Next: prove playable output and measured A/B on lawful video.
- **`media.dev.outcome-brief-to-reviewed-media` (J-09)** — Blocker: canonical project/scene binding, actual rendered output and owner-issued human reviewer. Next: join storyboard to the project and test version-stale review without fabricating approval.
- **`media.dev.outcome-reference-continuity` (J-10)** — Blocker: lawful conditioned generation plus the missing `MDC30-C-10` output-to-continuity join. Next: define exact output provenance/continuity receipt with its owner before positive generation.
- **`media.dev.outcome-reversible-tracked-edit` (J-11)** — Blocker: authentic tracking/render effect and canonical project CAS/restart. Next: bind masks and undo to exact source revision and verify the real rendered result.
- **`media.dev.outcome-two-dimensional-animation` (J-12)** — Blocker: local deterministic curves pass, but source-bound seed, canonical job/project finality, durable restart/UNKNOWN, client readback and production codec qualification remain. Next: bind the owner scenario and run the actual terminal journey.
- **`media.dev.outcome-three-dimensional-animation` (J-13)** — Blocker: target profile and hosted project/job/readback/restart/viewer qualification. Next: obtain coordinate/profile mappings and verify a delivered GLB in the supported viewer.
- **`media.dev.outcome-scientific-simulation` (J-14)** — Blocker: exact source-bound seed, hosted source/rights/job, durable restart, and genuine measured instrument references. Next: obtain the seed and independent measurements; deterministic simulation alone is not measurement.
- **`media.dev.outcome-validated-simulation-pass` (J-15)** — Blocker: exact seeded J-15 refs, hosted source/tenant/rights/job binding, durable readback/restart, and independent measurements. Next: bind those inputs and verify a real constrained pass; local simulation remains `DETERMINISTIC_SIMULATION_ONLY`.
- **`media.dev.outcome-translated-dubbed-video` (J-16)** — Blocker: legal translation/voice inputs and source-bound timing/lip metadata. Next: qualify voice and translation rights, then verify playable, source-aligned dubbed output.
- **`media.dev.outcome-music-effects-master` (J-17)** — Blocker: lawful playable stems, production master, and measured peak/perceptual constraints. Next: obtain source rights and validate decoded final master and destination receipt.
- **`media.dev.outcome-multitrack-finished-master` (J-18)** — Blocker: qualified video/audio/caption/graphics pipeline and durable checksummed artifact. Next: bind all track revisions, render/decode, and prove restart-safe readback.
- **`media.dev.outcome-bounded-quality-improvement` (J-19)** — Blocker: real quality metric/reference and safe reversible improvement bound. Next: define independent metric and demonstrate a bounded, reversible comparison.
- **`media.dev.outcome-durable-job-recovery` (J-20)** — Blocker: local PostgreSQL/LocalStack crash/replay fixtures pass, but no real provider terminal receipt/success or owner-bound channel acceptance. Next: use an admitted provider receipt and verify the same job/result after process restart.
- **`media.dev.outcome-version-specific-review` (J-21)** — Blocker: source-free stale-version tests pass, but owner-issued reviewer authority, shared project/review CAS, runtime admission and authentic human approval are missing. Next: integrate the canonical project revision fence and obtain real reviewer evidence.
- **`media.dev.outcome-acknowledged-delivery` (J-22)** — Blocker: destination/request fingerprint, authenticated destination authority, durable acknowledgment and lost-ACK reconcile are missing. Next: implement owner-bound receipt/readback and test exact same-key recovery.
- **`media.dev.outcome-offline-conflict-reconnect` (J-23)** — Blocker: local encrypted-store tests pass, but production key custody/rights and canonical project effect/readback are absent. Next: bind host-held key, fresh authorization and exact project version to the real endpoint.
- **`media.dev.outcome-structured-command-batch` (J-24)** — Blocker: production CLI has no admitted batch operation or route. Next: define the public batch contract, then prove per-item auth, typed failures and true finality.
- **`media.dev.outcome-authorized-agent-outcome` (J-25)** — Blocker: no per-tool canonical operation/right/receipt mapping; all four effectful handlers remain NOT_ADMITTED. Next: establish actor mapping and durable exact output receipt, then test one dispatch per claim.
- **`media.dev.outcome-retention-and-erasure` (J-26)** — Blocker: schema and fixture guards exist, but current observations/readback/restore evidence for primary, replica, derived, cache, export, backup and external copies plus request binding are absent. Next: inventory every copy and prove post-erasure no-disclosure before any purge.
- **`media.dev.outcome-provider-outage-safe-path` (J-27)** — Blocker: fixture unavailable/UNKNOWN paths do not qualify real provider catalog, host readiness, or production outage reconciliation. Next: qualify real provider observations and restart-safe fail-closed behavior.
- **`media.dev.outcome-spatial-interactive-delivery` (J-28)** — Blocker: target spatial profile, production export, hosted player and viewer fidelity are missing. Next: qualify profile/encoder and verify actual delivery/playback with truthful loss metadata.
- **`media.dev.outcome-live-session-recovery` (J-29)** — Blocker: authenticated identity/consent, canonical source cursor/clock and measured client recovery are unresolved. Next: bind host lifecycle to durable session authority, then test loss/reconnect/revoke at qualified load.
- **`media.dev.outcome-eligible-provider-catalog` (J-30)** — Blocker: unavailable selectors pass but current qualified model/voice/host rights and readiness evidence do not exist. Next: consume owner-qualified profiles and verify currentness, expiry, revocation, and zero-effect unavailability.

## Stop condition and handoff

The remaining engineering queue is not complete. Work is stopping at the owner's request after this snapshot and the requested push. The next engineer should take the first source-defined local task above that does not depend on an external gate, keep task state OPEN until its full acceptance is met, and resume provider/rights/host work only when the named owner artifacts arrive. The canonical register remains the source of truth.
