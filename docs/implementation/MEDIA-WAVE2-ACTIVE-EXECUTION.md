# Ghatana Media — ACTIVE Wave 2 implementation and blocker-elimination execution

**Owner engineering direction:** October 28, 2026. This is the **single current executable work queue** for five backend modality/observability surfaces; earlier R7–R10 plans are preserved as historical decisions and source/evidence references, not separate concurrent work plans. The original [58-task acceptance authority](MEDIA-BACKEND-MODALITY-WAVE2-EXECUTION.md) and the [exact original 36-row acceptance criteria](MEDIA-WAVE2-R8-FULL-ACCEPTANCE-MATRIX.json) remain unchanged. [R10 machine-readable 12-gate/36-task map](MEDIA-WAVE2-R10-OWNER-BLOCKER-RESOLUTION.json) is a selection input, not a second phase/provider contract.

**Starting reported status:** **58 tasks = 22 LOCALLY_VERIFIED + 30 PARTIAL + 6 OWNER_EXTERNAL**. No row is promoted by this document or the source commits linked below. All six external IDs remain STT-12, TTS-07, TTS-12, VIS-02, VIS-12, MM-12. The product still has 99 source capability memberships, 43 RPC identities and 12 declared end-to-end scenarios. This queue authorizes engineering execution without PDP/gtool closure, build/release/cutover or external-rights approval.

**Current reviewed Media implementation baseline:** `4196698a7fae2d82df13dce17e2a6a7ca9ef0de0` on remote main, containing the actual host OCI supervisor. Later implementation commits in this turn add OCI adversarial/real-codec tests; their JDK27/Docker results are **NOT RUN** here. Shared and Ghatana authorities must be pinned afresh from their latest remote main before a native current-cut claim. No cross-write to dirty Shared source; never force-push or reset others' work.

## 1. Final owner decisions, dispositions and no-reapproval policy

- **APPROVED NOW: implementation and tests.** Implement Media runtime/source-rights wiring, provider adapters, reusable native OCI worker, PCM/ONNX/decoder improvements, existing PostgreSQL/outbox integration, source-owned FLEURS extraction, bounded evaluation and source-free HTTP consumers; change source/Gradle/docs in owning repositories as required. No further blanket owner design meeting is needed.
- **APPROVED: one native isolation architecture.** The current [HostOciVisionWorkerSupervisor](../../modules/vision/vision-service/src/main/java/com/ghatana/audio/video/vision/video/HostOciVisionWorkerSupervisor.java) is the Linux ARM64 **trusted-host** execution route. The old [LinuxVisionWorkerSandbox](../../modules/vision/vision-service/src/main/java/com/ghatana/audio/video/vision/video/LinuxVisionWorkerSandbox.java) is an alternative only on hosts **actually offering delegated writable cgroup v2**; Docker Desktop's missing nested delegation is **not** a reason to stop. Never pass Docker socket, registry credentials, host environment or a privileged host mount into the codec worker; only the trusted host supervisor may contact Docker.
- **APPROVED: first-party, nonbiometric source fixtures for engineering development.** Original generated audio/video and a source-owner-signed recording/provenance record can support nonproduction rights/path/finality tests. It must have an independently checked **actual source/version/owner/purpose** at dispatch. It is not third-party training/voice/biometric consent, not a fabricated reviewer receipt, and not licensed quality-corpus evidence.
- **APPROVED: previously selected reference asset evaluation, not production promotion.** Whisper official multilingual tiny + independently compatible ONNX/tokenizer; Piper LJSpeech medium + real eSpeak or qualified phonemizer; YOLOX Nano distinct tensor model; FLEURS bounded en-US/hi-IN/ne-NP corpus; original generated sync fixtures. See [R9 source pins](../../config/qualification/wave2-reference-candidates.v1.json). These remain REVIEW_ONLY until exact rights, ground truth, model outputs, performance and qualified reviewers exist. **Do not invent human speaker/face consent or license changes.**
- **APPROVED: conditional positive admission, never a Boolean bypass.** Media's existing `MediaSpeechToTextAdmission` has an ADMITTED disposition but `MediaRuntime.admitSpeechToTextOrThrow` still always rejects, and `PostgresqlMediaTranscriptStore` refuses production writes and hardcodes CANDIDATE. The next implementation must replace these *specific* hard stops with actual, independently verified source/right/consent/model/store **proofs**. Missing authority continues to fail closed. Avoid new shadow transcript/job stores and environment-variable or caller-attested license/consent promotion.
- **APPROVED: explicit narrower reference performance profile.** On the cited 4CPU/8GiB Linux reference, Whisper c16/c64 is saturated (reported RTF ~2.14/2.06; p95 ~30/33sec). Keep safe typed admission rejection and honest per-profile concurrency ceiling. Run same-source ORT opt-in thread A/B with 0(default),1,2,4; only change default after equivalent full-gold outputs plus measured gain. This does **not** redefine original whole-task c16/c64 load acceptance or production SLO.
- **APPROVED: owner-public integrations, no cross-imports.** Ghatana's Document Intelligence [issue #252](https://github.com/samujjwal/ghatana/issues/252) owns source/frame/ROI/rights OCR; Data Cloud [issue #254](https://github.com/samujjwal/ghatana/issues/254) owns Java21-compatible governed read-model projection. Build Media consumer adapters **after the real public owner APIs exist**, not against imaginary routes.
- **EXTERNAL AUTHORITY REMAINS HONESTLY REQUIRED.** A third party's weight/voice/dataset license, human voice/face/biometric consent, non-first-party recording right, valid independent reviewer signature, or actual benchmark/host measurement cannot be bestowed by an engineering owner. These are **precisely scoped external evidence inputs**, not reasons to stop unrelated engineering. If unavailable, continue first-party nonhuman and other independent work, keep the gated sub-operation NOT_ADMITTED and record the exact evidence that is missing.

## 2. Executable critical-path tasks: what, where, how, exit

### V1 — finish kernel-enforced OCI adversarial + real codec (first acceptance candidate VIS-03)

**Owner:** Media Vision/native. **New source paths:**
- `modules/vision/vision-service/src/main/java/com/ghatana/audio/video/vision/video/{HostOciVisionWorkerSupervisor,VideoFrameExtractor}.java`.
- `modules/vision/vision-service/src/test/java/com/ghatana/audio/video/vision/video/{HostOciVisionWorkerDockerIntegrationTest,HostOciVisionRealCodecIntegrationTest}.java`.
- `modules/vision/vision-service/src/test/resources/vision-oci/ffmpeg`, `vision-oci-real/Dockerfile`; `scripts/qualification/{build-wave2-vision-real-oci-image,run-wave2-vision-oci-checks}.sh`.

**Actions:** Run stub OCI tests in their own JDK27 JVM against their **digest-pinned** stub image. They must now include real kernel `OOMKilled=true`, `pids.events max >0`, existing wall-time/container cleanup, mount/limits, zero-Docker-socket tests. Then provision the **existing fixed-digest** Linux ARM64 LGPL 8.1.2 FFmpeg archive and six SHA-pinned Ubuntu 24.04 native dependency packages, build the separate real FFmpeg OCI image without runtime downloads, and run the real-image JVM separately: original source Java-generated PNG -> actual FFmpeg -> exact decoded PNG; malformed bytes -> no successful frame; deliberately tiny output ceiling -> typed overrun. Add extra malformed codec/container tests against the original VIS-03 security corpus, including unsupported formats/symlinks and first-failure classification, and check max CPU, RSS, PIDs, scratch and process-tree cleanup at source-native boundary.

**Commands on trusted developer host (no untrusted Docker socket):**

```bash
# Uses its own locally built, content-ID-pinned stub image (4 OCI cases):
bash scripts/qualification/run-wave2-vision-oci-checks.sh stub

# Pin/obtain the LGPL archive plus exact six Ubuntu ARM64 runtime packages:
bash scripts/prepare-wave2-codecs.sh linux-arm64
export MEDIA_LINUX_CODECS_DIR=/tmp/ghatana-media-codecs/v8.1.2-27-aarch64-unknown-linux-gnu
# Verify this path against the exact provisioner's printed MEDIA_LINUX_CODECS_DIR.
# Runs the real codec image in a SEPARATE JVM (3 cases):
bash scripts/qualification/run-wave2-vision-oci-checks.sh real "$MEDIA_LINUX_CODECS_DIR"
```

**Mandatory exit:** Actual Docker/kernel OOM/PID limit, timed kill and cleanup, real FFmpeg decode/malformed/oversize output, source bytes and output mounts, no escaped processes/network/sockets/secrets. Reread original VIS-03 criteria and mark its entire row verified **only if every adversarial input/expansion/CPU/memory/time/oracle passes on the required host**. Do not claim VIS-03 from test image/config checks alone. If a test fails, fix its exact resource/fixture contract and rerun; no return to unavailable nested-cgroup configuration.

### S1 — remove STT's unconditional pre-job dead end *only with genuine authority*

**Owner:** Media runtime/security plus Shared public PolicyEngine consumer. **Files:**
- `launcher/src/main/java/com/ghatana/media/launcher/MediaRuntime.java` (around `admitSpeechToTextOrThrow` and `submit`);
- `runtime-contracts/src/main/java/com/ghatana/media/runtime/{MediaSpeechToTextAdmission,MediaRuntimeContracts,MediaProcessingRuntimePort}.java`;
- `modules/speech/stt-service/src/main/java/com/ghatana/stt/grpc/{ProductionSttGrpcService,SharedPolicySttRequestAuthorization}.java`;
- existing artifact/consent/rights stores and tests, never new shadow writers.

**Implement step-by-step:**
1. Inspect existing Media source provenance and consent authority, and Shared `PolicyEngine/VerifiedPolicyContext`. Reuse an existing verified source-rights port if available; if missing, add **one canonical Media source/version/purpose/rights resolution port** to the current runtime contracts (not a new global policy engine). Implement owner-created original-media receipts only from authenticated producer and immutable artifact metadata, not user-chosen `rightsVerified=true` flags.
2. Resolve **actual** artifact bytes/version/digest and verified principal/tenant/purpose/classification/retention from Media stores. Obtain current Shared ALLOW policy plus rights and MediaConsentAuthority decision; revalidate after provider selection and immediately before every provider effect/retry. For nonhuman original source, the rights authority can return a verified `NOT_APPLICABLE_HUMAN_CONSENT` disposition only with a real trusted provenance fact; any human voice, clone, speaker/face match or unowned recording still requires authentic subject/holder approval.
3. Check the real admitted STT profile's exact model+export+tokenizer+locale/quality and the actual durable transcript store capability. Invoke the already-authored conditional `MediaSpeechToTextAdmission.evaluate(..., transcriptVersionStoreReady)` with facts returned by trusted components. If denied, create **zero** jobs/outbox/provider calls. For authenticated successful admission, continue to the existing `submit` path, and ensure the generic production source-rights guard does not re-reject the same independently authorized STT request.
4. Replace `ProductionSttGrpcService.isProviderReady() = false` and its `LOCAL_ONNX NOT_ADMITTED` *only after* a real externally reviewed model/provider receipt is bound, not merely because an operator set environment variables. Test missing, stale, mismatched and revoked profiles. Do not downgrade production readiness to get a green test.

**Mandatory exit:** Positive from a genuinely source-authorized first-party/rights-cleared voice request; wrong tenant, stale version, wrong principal, missing model, expired/revoked rights, missing transcript store or source clock must reject with no side effect. The authorized request has a durable, identity-scoped job ID before inference, not a fabricated transaction ID.

### S2 — connect real provider to canonical PostgreSQL immutable revision and restart

**Owner:** Media STT + runtime/PostgreSQL. **Files:** existing `MediaProcessingRuntimePort`, `MediaRuntime`, `providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/PostgresqlMediaTranscriptStore.java`, migrations/tests, current STT provider adapters.

**Implement:** Reuse Media processing job/attempt/fence/outbox, exact artifact digest and bounded source-byte reader. Real Whisper inference must receive a **licensed, independently transcribed** speech audio clip, with complete output checked against ground truth—not merely the word “weather.” Provider result includes exact model/input/output hashes, successful **fenced** attempt, provider receipt, idempotency fingerprint and source clock. In one PostgreSQL transaction, verify the durable successful attempt + owner/rights/consent/policy + current source version; append the immutable transcript revision via existing CAS and outbox. Replace the store's unconditional production-write rejection only once the source/rights/attempt proof is checked **in the same transaction**. Continue to use CANDIDATE for nonproduction evaluation, and do not promote it by changing a SQL literal alone. Independently exercise wrong digest/attempt/fence/tenant, revoke-before-effect, crash after provider receipt but before commit, duplicate request, ambiguous outcome and restart/re-read.

**Mandatory exit:** Source-owned real audio -> true model transcript -> fenced successful job -> immutable PostgreSQL transcript version -> owner-only **exact same bytes/version read after process restart**, with negative/recovery tests. Then reassess entire STT-03/STT-04/STT-08/STT-09 original acceptance rows individually. Local store-only 17/17 tests are **not** this outcome.

### M1 — independently qualify speech, voice, vision and corpus (parallel to V1/S1)

**Owners:** STT reference quality, TTS voice/rights, Vision detector, evaluation/QA.
- **STT:** `libs/java/common/.../WhisperOnnxEngine.java` and tests, source-pinned split ONNX decoder. Compare an **independently recorded full ground truth** against real model output on Mac/Linux; don't count substring-only checks. Do not finalize when EOT is missing/token cap hit. Run ONNX intra-op default/1/2/4 A/B with same weights/audio and 1/16/64 *requested* concurrency; accept typed saturation rather than false 64 successes. If tiny fails exact reference quality, qualify a prior legal base/small or another already selected backend without changing public contracts.
- **TTS:** `PiperOnnxEngine.java` phonemizer adapter and `ProductionTtsGrpcService`; independently verify voice checkpoint/sidecar/export and owner/likeness rights. Replace heuristic phoneme mode with actually qualified eSpeak-NG behavior or original validated compatible phonemizer. Verify phoneme IDs, sample clocks, **real audible PCM** and locale; cloned/human-identity voices remain denied absent real subject approval.
- **Vision:** `YoloXNanoAdapter/OutputParser`; use one **real nonhuman-object photograph** created/owned by the team with independent bounding-box/COCO label as the positive fixture. The old synthetic glyph's **zero detections** is a valid negative but **not** positive accuracy. Run actual YOLOX tensor geometry/NMS and a rights-cleared held-out mAP/PR set; require individually checked model/export lineage.
- **Evaluation:** `config/qualification/fleurs-asr-evaluation.v1.json` is currently **METADATA_ONLY_NOT_FROZEN**. Obtain bounded exact en/hi/ne per-clip audio, real ground truth, digest, attribution/source revision, training overlap and lawful speaker-use boundaries. Do not substitute output text for gold, infer consent from a dataset name or download hundreds of GB. Pre-register source-appropriate WER/CER/DER/mAP limits before final independent held-out runs. Reference-only preliminary thresholds already documented under R10 are not production SLOs.

### P1 — public Ghatana integrations (disjoint from Media core)

**Owner Ghatana services/document-intelligence:** [#252](https://github.com/samujjwal/ghatana/issues/252) supplies authenticated source/frame SHA/version, oriented ROI, rights/retention and operation-finality public OCR endpoint. **Owner Ghatana services/data-cloud:** [#254](https://github.com/samujjwal/ghatana/issues/254) supplies Java21-compatible governed Media observation projection and exact readback. Both must ship source-controlled public schema, error/finality tests and a **source-free** Java27 Media consumer before declaring VIS-09/MM-10; do not create second internal services in Media.

### F1 — Multimodal and observability after real child results

**Owner:** existing `modules/intelligence/multimodal-service`, `audio-video-observability`. Compose **real** STT and Vision child attempts with independent source rights, fencing, failure/UNKNOWN and rational source clock. Emit grounded typed fusion, not dummy A/V sync or speaker/face identity. Run real provider liveness+quality through Prometheus to Alertmanager on a named receiver; execute requested concurrency 1/16/64 under a measured hardware/model profile. If 4CPU can't serve c64, preserve exact typed saturation/accepted count and qualify a lower supported profile; don't invent completed 64 requests or a production SLA.

## 3. Acceptance accounting and no-stall progress

| Engineering lane | Next required measurable outcome | Original candidate row | Stop/fallback |
|---|---|---|---|
| V1 OCI native | 4 stub cases incl real kernel OOM/PID + 3 actual FFmpeg cases + original adversarial parser corpus | **VIS-03** | Fix failed kernel probe/codec path, not more OOB reviews |
| S1 admission | Authorized source/version/purpose/policy verified, no-effect denials and accepted job | **STT-03** prerequisite | Add missing canonical source authority with independently authenticated record; no fake ALLOW |
| S2 durability | Actual model output and fenced CAS transcript, restart exact readback | **STT-04/08/09** | Reconcile attempt/rights/store; no new writer |
| M1 model quality | True exact Whisper full gold, Piper phonemizer/playable voice, real YOLOX object | **STT-10/12, TTS-07/12, VIS-02/06/12** | Switch to previously selected qualified model on genuine failure; no lowered gold |
| P1 public APIs | Owner-built DI OCR and Data Cloud source-free consumers | **VIS-09/MM-10** | Keep those specific operations unavailable, progress other lanes |
| F1 composed evidence | Actual STT/Vision/MM/alert and named-host capacity | **MM-05..12, OBS-07/08** | Honest partial/UNKNOWN/capacity limits, no fake physics or metrics |

**Task promotion requires the entire original row**, not these milestone labels. After each affected-source commit: run the exact focused test and both required host lanes; only then refresh the original Wave 2 ledger. One accepted row counts more than another whole-repository test rerun. Never rerun already closed unchanged surfaces or source-only validators in place of real provider, container or licensed-corpus evidence.

**Update cadence:** each 90-minute engineering pulse produces changed code, an actual executed test or the exact first failure+owner+fix. At four hours report newly accepted original IDs, real model/input/output hashes and one next fault. After two pulses without an original acceptance, **stop opening broad new planning tasks** and address the first active missing executable input or switch to an already selected legally eligible alternative. Parallel teams own distinct files; serialize edits to MediaRuntime, runtime-contracts and database migration authority.

**Expected engineering end state:** real usable backend features and full test coverage, then 58/58 original acceptance once each true source/rights/quality/integration/performance requirement has its genuine proof. A full 58/58 guarantee is **not credible until external rights holders and actual independent measurements provide their source inputs**; the execution queue is designed so those unavailable inputs block only the affected operation, never the entire product's development.

## 4. Source verification and change policy

```bash
git fetch origin
git status --short
git rev-parse HEAD origin/main
pnpm test:wave2-r10-owner-resolution
pnpm check:candidate-decision-crosswalk
pnpm check:wave2-reference-sources

# Fast first JNI/native test lane after syncing a clean checkout:
bash scripts/qualification/run-wave2-vision-oci-checks.sh stub

# True Linux codec qualification after the approved pinned R7 provision:
bash scripts/qualification/run-wave2-vision-oci-checks.sh real "$MEDIA_LINUX_CODECS_DIR"

# After changed-unit tests, run selected current JDK27 Mac/Linux matrices:
./scripts/test-media-wave2-platform-matrix.sh mac-core
./scripts/test-media-wave2-platform-matrix.sh linux-arm64-core
./scripts/test-media-wave2-platform-matrix.sh mac-integration
```

The stub/real OCI scripts deliberately use **separate Gradle selections and image environments** so the integration-image variable cannot hijack ordinary process stub tests. The real image uses a published LGPL FFmpeg archive plus independently hashed Ubuntu runtime packages; it is **not** a redistributable production image or licensing approval. All worker images and large media/corpora live in local, bounded cache; no binary/voice/consent raw data goes into Git. Delete only images/assets owned by this qualification run after verifying no other consumer uses them.

**Report:** exact Media/Shared/Ghatana git SHAs; changed source paths; test host/JDK/OCI image+codec hash; per-test pass/fail/skip and true kernel resource events; source/model/voice/data rights records actually available; immutable job/attempt/outbox/transcript IDs; any new whole-row acceptance; and specific still-required owner evidence. A Git commit, signed template, stub image, or source manifest alone is not a successful Media business outcome.
