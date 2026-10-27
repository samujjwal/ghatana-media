# Media Wave 2 — owner implementation directive (R7)

**Engineering authority:** delegated product owner/architect, October 27, 2026.
**Primary authority:** [canonical Wave 2 plan](MEDIA-BACKEND-MODALITY-WAVE2-EXECUTION.md) owns the 58 exact task IDs, their original acceptance and current statuses. This directive approves *engineering choices and next implementation actions*, not third-party copyright/voice/biometric permissions, customer consent, production or release eligibility, a migration cutover, or Lifecycle/gtool/PDP closure. It does not replace a legal/source owner's proof.

**Reviewed source:** Media `9c2793604e0e2b3c92a11b77f487a9bf238b3382`, Shared `07e1e0d0f56000ecd15550d296b37695e56a9f9c`, Ghatana `387bfc3eede86265aa8b42340d6a32f6e19ffeee` before R7 edits. Fetch and pin current source before each new execution wave. No historical local `origin/main` SHA substitutes for a new fetch.

**Structured independent task selections:** [R7 36-task machine-readable execution schedule](MEDIA-WAVE2-R7-EXECUTION-SCHEDULE.json), validated as 22 preserved verified + 30 partial + six external tasks, with 16 prerequisite package IDs. This file is a work-selection handoff; the canonical plan remains the only status/acceptance authority.

**Current Wave 2 denominator:** 58 = **22 LOCALLY_VERIFIED + 30 PARTIAL + 6 OWNER_EXTERNAL**, 99 PDP capability memberships, 43 RPCs, 12 scenarios, five residual handoffs. Previously reported macOS and Linux ARM64 core tests and macOS integration passed on one local cut; 13 skips were classified (three native Vision, nine Compose, one Linux-specific former macOS TTS test). Those test totals establish executable boundaries, not real model effects or whole-task acceptance.

## Decisions authorized now (no additional discretionary engineering approval required)

1. **Single source owner:** Media-specific source changes belong only in `ghatana-media`; Shared policy/identity, Ghatana Data Cloud/AI Inference/Document Intelligence, Kernel, Tools and Lifecycle continue owning their canonical public contracts. No forked job store, OCR model, policy engine, media writer, or imported private legacy code.
2. **OS-neutral product:** macOS ARM64 and Linux ARM64-on-Mac are required functional tests. Linux AMD64 emulation is optional functional parity, never native throughput. Defer only Windows-specific packaging, DLL loading, Win32 ACL/process controls and qualification; do not defer OS-neutral path traversal, finality, privacy or ABI obligations.
3. **Native codec selection:** approve opt-in source-pinned LGPL-only FFmpeg v8.1.2-27 archive for isolated *testing*. `scripts/prepare-wave2-codecs.sh` verifies published archive digest, safely extracts and retains the archive. `VisionNativeBoundedIT` compares executing binaries to archive members; `test-media-wave2-platform-matrix.sh` supplies archive identity inside Linux Docker. Prior directly pinned GPL test binaries remain an alternative. Actual codec/encoder availability, rights and deployment licensing still require real verification.
4. **Native process isolation:** 8 GiB, 4 CPU, 512 PID Linux Docker resource caps are test-container outer caps; they are not per-FFmpeg-child caps. Production codec worker must enforce a bounded process sandbox or reject workloads on unsupported hosts; macOS sampled RSS is only diagnostic.
5. **Shared and Media security:** use Shared `PolicyEngine`, `PolicyEvaluationRequest`, `VerifiedPolicyContext` and authoritative versioned ALLOW plus Media's real `MediaConsentAuthority`, ownership, source/version, recording/voice/biometric rights, expiry/revocation, region and retention before provider dispatch and retries. Caller-provided consent, policy or tenant values do not authorize effects.
6. **Canonical durability:** extend the existing authenticated `MediaProcessingRuntimePort`/artifact store to supply bounded source-version-verified bytes. Reuse Media job, fenced attempts, transactional outbox, immutable source lineage, PostgreSQL transcript CAS and exact owner readback. Never mark `OUTCOME_UNKNOWN` successful or blindly retry uncertain effects.
7. **Reference engines:** choose official Whisper tiny + exact tokenizer and a small rights-reviewed FLEURS subset for STT reference evaluation, an exact rights-cleared Piper voice+phoneme sidecar for TTS, and a detector with independently cleared weights+verified export for Vision. Engineering selection permits evaluating a candidate, **not inventing a missing voice/weight/corpus right or production admission**. No automatic runtime downloads.
8. **Grounded MM:** child STT/Vision operations must really execute, each with independently fenced attempt/result/finality. Bind immutable source version, stream id, sample/PTS rational clock, origin/epoch/discontinuity and uncertainty. ROI is source-raster oriented pixel XYWH; timestamp comparability is not proven AV sync. Biometric speaker-to-face matching is separately gated.
9. **Cross-repository ABI:** resolve Ghatana Java21 ↔ Shared/Media Java27 through a Data Cloud-owned *versioned public HTTP/gRPC operation* and installed Java21/Java27 consumers. Do not bypass Gradle variants or import Data Cloud internal Java APIs into Media. Required public fields: verified principal/tenant, purpose, artifact/version, result digest, classification, rights/consent/policy decision ids, operation/idempotency, status/finality. Data Cloud handles projection; Media is the effect owner.
10. **Generic OCR:** Document Intelligence owns the public source-version/ROI/rights/retention OCR API; Media calls that API. No duplicate generic OCR engine in Media.
11. **Compose residual:** build pinned STT/TTS test images from existing Dockerfiles and exercise actual negative startup/readiness contracts; positive effect cases require genuinely admitted providers. Nine image-gated skips remain unverified until executed. They do not block Mac/Linux core coding. Checkstyle, migration, deployment and gtool closure remain distinct.
12. **Promotion rule:** original task-wide positive + negative + fault/recovery + quality/privacy criteria alone can promote a row. A green fixture or `NOT_ADMITTED` is truthful behavior but not a completed intended capability. After two pulses with no acceptance outcome, stop expanding work and fix the lowest unresolved dependency.

## Priorities, owners, exact task groups

| Wave | Exact tasks still open | Owning files/areas, implementation and exit |
| --- | --- | --- |
| A — portability and first possible acceptance | **VIS-03**; X02–X06 | `VisionNativeBoundedIT`, `VideoFrameExtractor`, Linux runner, TTS path test: provision both fixed tool archives; run mac-native and linux-arm64-native on same source. Verify supported encoder/image2/codec, frame/media limits, timeout/kill tree, cleanup and bounded hard worker resource budget. If the *original* VIS-03 CPU/RSS/time criterion is not met, do not promote it. |
| B — real source/rights | **STT-03, MM-02, VIS-10, TTS-05**; X07+X10 | `SttGrpcService`, `MediaRuntime`, `MediaProcessingRuntimePort`, Shared governance: server-derived principal, purpose, source and consent; versioned rights, immutable bounded source bytes; denied/revoked/stale produce zero provider/outbox effects. |
| C — first complete STT job | **STT-04, STT-08, STT-09**; X09+X11 | `ProductionSttGrpcService`, provider SPI, canonical job/outbox and `PostgresqlMediaTranscriptStore`: real approved model transcript → provider receipt/attempt → completed job → immutable revision/CAS → principal re-read after restart. No fixture-only promotion. |
| C2 — speech advanced behaviors | **STT-05, STT-06, STT-07** | STT streaming, VAD, monotonic chunk ACK/resume, provider-final transcript, source-clock words/phonemes, anonymous diarization and separately consented identity; real quality for claimed alignment/speaker behavior. |
| D — real TTS/Vision | **TTS-02, TTS-03, TTS-05, TTS-06, TTS-07, TTS-08, TTS-09; VIS-02, VIS-05, VIS-06, VIS-07, VIS-10** | Exact model/voice and license/rights manifests; PCM playable synthesis and matched phoneme sidecar, streaming finality, real detector tensors/NMS/mAP, EXIF ROI/PTS, canonical fenced persisted outputs. No synthetic or unsupported controls promoted. |
| E — MM and owned external APIs | **MM-02, MM-03, MM-05, MM-06, MM-08, MM-09, MM-10; VIS-09** | MM per-operation real STT/Vision fanout, source-bound clock/ROI provenance, abstaining fusion, separate attempt/UNKNOWN/retry, immutable typed output. Ghatana Data Cloud owner ships public Java21/Java27 transport; Document Intelligence owner ships OCR API. |
| F — qualification and observability | **STT-10, STT-12; TTS-10, TTS-12; VIS-12; MM-12; OBS-07, OBS-08** | Real en/hi/ne corpus and stated unsupported locales, speech WER/CER/DER, decoded TTS controls/languages, detector mAP/native stress, true fused output, provider freshness+quality → Prometheus → Alertmanager, real 1/16/64 named-host CPU/RSS/RTF/fps/p50/p95/p99. |

**The exact 36 rows remain:** STT-03/04/05/06/07/08/09/10/12; TTS-02/03/05/06/07/08/09/10/12; VIS-02/03/05/06/07/09/10/12; MM-02/03/05/06/08/09/10/12; OBS-07/08. No new Wave 2 IDs are introduced.

## Required commands (run on developer Mac, not claimed executed here)

```bash
git status -sb && git fetch origin && git rev-parse HEAD origin/main
bash scripts/prepare-wave2-codecs.sh mac-arm64
bash scripts/prepare-wave2-codecs.sh linux-arm64
# Export mac FFmpeg/FFprobe/archive paths printed by provisioner.
./scripts/test-media-wave2-platform-matrix.sh mac-native
# Set MEDIA_LINUX_CODECS_DIR to the printed Linux ARM64 directory and
# MEDIA_MATRIX_IMAGE to a reviewed immutable Linux ARM64 Temurin 27 digest.
./scripts/test-media-wave2-platform-matrix.sh linux-arm64-native
./scripts/test-media-wave2-platform-matrix.sh mac-core
./scripts/test-media-wave2-platform-matrix.sh linux-arm64-core
./scripts/test-media-wave2-platform-matrix.sh mac-integration
pnpm test:backend-modality-wave2-plan
```

**Execution economy:** use only affected test selectors per patch, then aggregate once per completed outcome. Run four disjoint owner lanes (platform/native; Shared+Media security; speech/TTS; Vision/MM); serialize edits to the same runtime/contract/launcher file. Every 90-minute pulse yields code plus an executable test or an exact first failure. Four-hour review records newly *whole-row* accepted IDs and any true provider output; a plan-only round is not an outcome.

**Evidence at each task promotion:** SHA of Media and affected Shared/Ghatana sources; exact test JVM/platform/Gradle/tool image; JUnit XML counts+skips; relevant source/model/voice/corpus signed record where needed; positive result bytes/version, denied/stale/revoked zero-effect test, restart/idempotency/UNKNOWN, and native/quality results appropriate to original requirement. Preserve all incomplete original criteria and no claims for third-party licenses, live data cutover, formal PDP/gtool closure, deployment or release.
