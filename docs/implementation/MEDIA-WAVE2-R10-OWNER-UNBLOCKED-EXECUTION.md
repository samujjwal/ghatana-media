# Ghatana Media Wave 2 — R10 outcome-first engineering recovery and owner dispositions

**Approved engineering directive:** 2026-10-28. **Target:** complete the ORIGINAL 58 Wave 2 rows; source status still 22 LOCALLY_VERIFIED / 30 PARTIAL / 6 OWNER_EXTERNAL. This plan changes implementation routes, **not** PDP0–3 requirements, licensing facts, original task IDs, provider manifest admission or Lifecycle/gtool closure. [Machine-readable 12-gate / 36-task action map](MEDIA-WAVE2-R10-OWNER-BLOCKER-RESOLUTION.json) and [original full-row exit matrix](MEDIA-WAVE2-R8-FULL-ACCEPTANCE-MATRIX.json) remain linked. All R9 candidate/source/history decisions are preserved.

**Observed Media source baseline:** `53f9b355e4e9979c2f259c499ccd7269fb6e653f`. At review, Shared `607989541754097814a7c91611dea18ececaa970` and Ghatana `a0df4bdf8282b27051bf625331651e92925fdc70` are newer remote cuts than those used in some of the earlier Mac/Linux tests. Re-fetch/pin clean source for every new executed claim. **Do not touch Shared's reported two dirty, unrelated files.** Subsequent R10 Media code commits require their own Mac/Linux JDK27/native/real-provider verification, and do not change 22/30/6.

## 1. Owner decisions — no more discretionary engineering approval round

| Decision | APPROVED ENGINEERING implementation choice and owner | Conditional proof or external dependency not waived |
|---|---|---|
| R10-D01 | Media correctness: use genuine provider output, exact immutable input/weight/voice IDs, independent gold and bounded decode. New Whisper test rejects keyword-only incomplete text; token exhaustion without EOT is typed failure, not completed transcription. | A test transcript is not the legally verified recording right or a general WER guarantee. |
| R10-D02 | Media performance: ORT CPU intra-op thread setting is opt-in and host-bounded; compare unset/1/2/4 on identical Whisper bytes, CPU cap and 64 measured requests at each 1/16/64 level. Keep prior default until same-host A/B wins without accuracy regression. | No fabricated c16/c64 throughput; saturation rejection can be an honest supported capacity boundary. |
| R10-D03 | Media/Shared authority: first-party **nonhuman** generated media/test fixtures are development-test eligible under source-owned generation/identity records. Media must construct a trusted version-bound rights/consent resolver and use Shared PolicyEngine. | Third-party content/voice cloning/face ID requires its genuine rights holder and human's revocable consent. No boolean or self-signed reviewer is sufficient. |
| R10-D04 | Only Media job/attempt/fence, transactional outbox, artifact and immutable transcript stores can publish results. Implement the real STT adapter and exact restart/readback; no new job writer or transcript store. | Model output alone is not source-governed or durable business success. |
| R10-D05 | Piper LJSpeech is the first candidate; **heuristic phonemization is development-only**, not pronunciation qualification. Use exact eSpeak-NG phoneme behavior through an independently licensed provider or validate an original equivalent implementation. | The eSpeak-NG upstream native license and each voice model/speaker/sidecar remain independently reviewed; do not silently bundle GPL. |
| R10-D06 | YOLOX Nano is a distinct detector candidate. Use source-owned photographs of ordinary **nonhuman** objects with independent COCO-class boxes for a real positive; synthetic glyph expected zero detection is not an algorithm failure. | Actual model/export weight provenance and a separately licensed holdout are mandatory for VIS-02/06/12; preserve YOLOv8 parser identity. |
| R10-D07 | FLEURS metadata-only is **not** ASR quality evidence. Acquire bounded per-clip, hash+transcript+attribution data by genuine streaming/selected extraction; use a different lawful small corpus if full archive exceeds disk budget. | A small original nonhuman audio fixture is not a substitute for real multilingual WER/CER speaker-disjoint gold. Never invent sample metadata or audio SHA. |
| R10-D08 | **Native worker boundary change:** replace the currently unavailable nested cgroup delegation requirement with trusted **host-controlled one-request OCI worker** (Docker Desktop Linux VM on Mac; same Linux ARM64 worker on a Linux host). The **trusted supervisor**, not untrusted Media codec process, creates Docker containers and holds credentials. Reuse existing VideoFrameExtractor and canonical job authority. | Do not grant app/model/container Docker socket or privileged host access. Hard limits require real OOM/PID/CPU/wall/fd/tmpfs tests; a config flag is not sandbox proof. |
| R10-D09 | Ghatana owners implement Media source-version/ROI/rights OCR through current Document Intelligence [issue #252](https://github.com/samujjwal/ghatana/issues/252) and Data Cloud projection through [issue #254](https://github.com/samujjwal/ghatana/issues/254). | Endpoints are not yet published at the inspected source. Media implements only adapters, never a parallel OCR, Data Cloud engine or tenant-only authorization. |
| R10-D10 | Preserve existing 38 PDP0 technology decisions/501 feature audit references, Wave 2 58 task IDs, 99 capability memberships, 43 RPCs, 12 scenarios, existing P1 caption semantics, and separate Explorer/PDP3 simulation proof. | Code and execution evidence cannot close formal PDP/gtool, deployment, writer migration or release; none claimed here. |

**Qualification policy chosen now:** one reference profile is a *defined subset* of declared locale/model/format/hardware capability. A reference model failing measured quality is demoted to REVIEW_ONLY; the next previously selected permitted model (Whisper base/small, rights-cleared alternative TTS voice, licensed detector) goes through the **same** immutable provenance and tests. Do not change requirements or interpret unsupported features as successful. A documented, real saturation response at c16/c64 is acceptable as **capacity-boundary proof only**; no c64 success/latency SLA is inferred.

**Legal/human external gates:** independently authenticate copyright/weight author/voice rights holder, source recording owner, and any human subject/independent reviewer. Obtain source-valid signed, purpose/region/retention/version-limited records in the private authority. If unavailable, run controlled development paths and continue unaffected implementation. Neither this owner directive nor a model README creates consent, a license to redistribute restricted weights, or a benchmark result.

## 2. Blocker disposition by exact implementation surface

| Outcome | What / where / how (code-first) | Proof and explicit fallback |
|---|---|---|
| **G01 Whisper correct+fast** | `libs/java/common/.../WhisperOnnxEngine.java`, `WhisperReferenceModelIntegrationTest.java`, `WhisperOnnxThreadPolicy.java`, `WhisperPerformanceQualificationTest.java`. Compare official reference decoder against actual full original audio gold; verify cache branch, EOT, tokenizer and frontend. Run opt-in ORT A/B with one pinned profile. | Exact normalized **complete** transcript plus typed refusal of truncated decoding, output/input hashes, same-source Mac/Linux result semantics and full CPU/RTF/RSS/p50/95/99 profiles. Case-only difference is not semantic failure; missing words are. If tiny fails quality, qualify official base/small or existing alternative engine. |
| **G02 authoritative source rights** | `SharedPolicySttRequestAuthorization`, `MediaConsentAuthority`, `MediaRuntime`, `MediaSpeechToTextAdmission`. Implement a real owner-resolved immutable source/version/rights/consent composition; bind principal and policy to source, revalidate before dispatch/retries. | Verified first-party nonhuman test fixture is allowed ONLY with actual generated/source receipt. Wrong owner/tenant, revoked/expired, missing rights yields zero effects. Human identity/clone stays denied without real holder/subject. |
| **G03 durable STT** | Wire current local ONNX/approved gRPC provider -> existing Media processing SPI -> canonical job/attempt/fence/outbox -> PostgreSQL transcript CAS. Use exact source bytes/attempt receipt. | One rights-cleared speech audio yields true transcript then **identical source/result readback after kill/restart**. Timeout+UNKNOWN never blind retry. Do not count STT-04/08/09 solely from the underlying store's tests. |
| **G04 Piper** | `PiperOnnxEngine`, phoneme converter, `ProductionTtsGrpcService`. Bind canonical phonemizer that is actually used by production runtime; require exact sidecar, voice rights, real audio and locale. | Audible/decoded PCM, validated pronunciation and format, revocation and exact voice/phoneme attribution. If eSpeak license unavailable to distribute, isolate rights-reviewed provider or independently implement/verify equivalent; never label heuristic output qualified. |
| **G05 YOLOX** | `YoloXNanoAdapter` and parser; source-owned everyday-object photos and manually verified boxes. Confirm true model/export license, source letterbox inverse, class/crop/NMS. | At least one genuine positive real photograph and true negative, then frozen labeled holdout/mAP. If selected weight ownership remains uncertain, alternate already eligible model; no real image -> no VIS-06 promotion. |
| **G06 Vision worker** | `LinuxVisionWorkerSandbox`, `VideoFrameExtractor`, new **trusted host supervisor** and ProcessRunner/worker adapter **inside existing Media contract boundary**. One request/container, pinned image/tool hashes, read-only file-mounted validated source, tmpfs, network off, host-managed timeout and cancellation. | Hard kernel-enforced 1.5GiB worker memory+swap, 2 CPU, 32 PIDs, 128MiB scratch and wall budget on native Linux ARM64 VM on Mac; verify exact effective cgroups, deliberate OOM/fork bomb/time exceed and zero privileged leaks. If Podman/Kubernetes later used, preserve equivalent actual enforcement API. |
| **G07 real corpora** | `config/qualification/fleurs-asr-evaluation.v1.json` and `scripts/qualification/evaluate-fleurs-asr.mjs`; scope source revision, en/hi/ne, selected clips/labels, attribution, disjoint holdout. | First 24 clips/locale is a **pilot** only, not general qualification. Do not claim quality until actual independent holdout and pre-registered thresholds. If selected-clip streaming fails, obtain a lawful and bounded alternative; no bulk 100s-GB download. |
| **G08 observability+capacity** | Existing workflow metrics/exporter, Alertmanager, real STT/TTS/Vision/MM paths. Record model and source hashes, JDK27, real CPU/RSS, allocations, RTF, fps, p50/p95/p99 and actual observed reject rate at c1/c16/c64 on named Mac/Linux host. | A/B thread comparison wins only with same-output correctness and measured improvement. No model-driven alert on NOT_MEASURED or synthetic values. Real alert delivered to receiver and bounded labels. |
| **G09 Ghatana DI OCR** | Ghatana `services/document-intelligence` public Media version-bound frame ROI/rights endpoint, then Media Vision public client. | Owner-published source-free API; exact result/UNKNOWN, correct ROI/source/time; not available until executed. See #252. |
| **G10 Ghatana Data Cloud** | Ghatana `services/data-cloud` versioned observation projection and exact readback with Java21 server/Java27 Media client. Media is effect owner; Data Cloud read model only. | Authenticated source+purpose+digest/idempotency, 202 accepted != committed, exact replay/readback. See #254. |
| **G11 legal+subject** | Existing `docs/implementation/MEDIA-WAVE2-PRIVATE-CONSENT-RECORDING-TEMPLATE.md`, `config/qualification/wave2-trusted-reviewers.v1.json` and private rights authority. | Independently verified rightsholder/legal grants and real human revocable consent; self-approved paper or invented signature rejected. Development alternative is original nonhuman media, not unapproved source. |
| **G12 MM real child** | Existing MM per-operation fanout/attempt/store and rational source clocks; invoke real independently authorized STT and Vision jobs. | Real committed child receipts, source-provenant fusion with separate cancellation/UNKNOWN and readback; no dummy audio/video or falsely measured A/V sync. |

The [R10 machine map](MEDIA-WAVE2-R10-OWNER-BLOCKER-RESOLUTION.json) routes **all exact 36 remaining rows** to one or more of these gates, preserves original R8 dependencies and independent proof, and keeps all six OWNER_EXTERNAL IDs intact. It is a selection/checklist view; the original Wave 2 plan is the only whole-row acceptance authority.

## 3. Cross-platform native worker: executable host specification

Existing `LinuxVisionWorkerSandbox` requires writable delegated cgroup v2 and bubblewrap *within its process*. Docker Desktop successfully enforces **outer** container caps but does not expose the required inner cgroup delegation in the reported setup. **Stop retrying the same nested cgroup host.** The resolution is a trusted host-side OCI supervisor that creates **one container for one video processing job**. The untrusted worker is a child of the OCI runtime, not a Docker client.

Use Docker's documented hard boundaries in the *trusted supervisor's* spawn parameters (not an application-user controlled shell):

```bash
# Illustrative supervisor-owned effective flags; not a command to expose to
# an end user. image must be reviewed/immutable and source file already verified.
docker run --rm --init --platform linux/arm64 \
  --memory=1536m --memory-swap=1536m --cpus=2 --pids-limit=32 \
  --network=none --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges:true \
  --tmpfs /tmp:rw,nosuid,nodev,exec,size=128m \
  --mount type=bind,src="<trusted-source-file>",dst=/source/input,readonly \
  --user 10001:10001 --pull=never \
  "<reviewed-worker-image>@sha256:<digest>" \
  <only-allowlisted-FFmpeg-operation-and-output>
```

Do **not** expose the Docker socket inside an ordinary Media service/model container. A trusted supervisor runs on the Mac host or authorized Linux host/control-plane; Media's existing native process adapter calls its authenticated bounded execution operation, not arbitrary user-selected commands. Validate actual cgroup memory.max/cpu.max/pids.max and OOM events **inside a started job**. Use a restricted dedicated input mount, no network, one operation, a bounded diagnostic stream and no secrets. Keep already-authored nested cgroup+bwrap backend available only on genuine delegated Linux hosts, with no false success switch. The host supervisor implementation+in-process Media call boundary are **not yet present**; implement them, run a true adversarial suite, and only then reconsider VIS-03.

## 4. Exact code-first execution waves and exit checks

**Wave 0 — after current source fetch (one focused test iteration).**
- Verify Media/Shared/Ghatana source SHAs, preserve dirty files and remote status. Run the **new** `WhisperOnnxThreadPolicyTest` and `WhisperDecoderPolicyTest` with JDK27 on Mac and Linux ARM64. Verify `WhisperReferenceModelIntegrationTest` now requires `GHATANA_MEDIA_WHISPER_GOLD_TRANSCRIPT` when the pinned private profile and WAV are supplied. Run no fake gold. The strengthened gold and no-EOT safety patch is code in main, **not yet JDK27-qualified**.
- Do not re-run all 1,860 core cases until affected focused selectors pass.

**Wave 1 — in parallel on disjoint files:**
A. STT/rights lead: G01 first (real full-transcript quality). Run default CPU threads and then 1,2,4 under the same private pinned WAV and model, 1/16/64 workload, retaining each output hash/latency. Source-shape correctness first, throughput second; pick lower legal throughput tier if saturation is measured.
B. Native lead: implement host OCI supervisor and one-request per container G06, run deliberate OOM/PID/time attack on Docker Desktop Linux ARM64, verify effective limits. Check VIS-03 original whole-row obligations and promote **only if all actually pass**.
C. Media authority lead: implement G02 genuine first-party-source rights authority using Shared policy and existing Media source version + consent; cross-tenant, unknown, expire and revoke produce zero effects.
D. TTS/Vision owners: G04 canonical phonemizer and G05 real rights-cleared photograph, **without waiting** for STT quality work. Do not treat heuristic eSpeak imitation or blank YOLOX glyph as a positive.

**Wave 2 — gated by actual source/authority:**
E. Complete one G03 **true** STT job/receipt/transcript revision and restart readback, then audit original STT-03/04/08/09 *whole rows*. Store and source SPI tests by themselves remain insufficient.
F. Source corpus G07: freeze first real FLEURS/alternative small selected clips and *independent* gold and rights; measure pilot distribution and prepare larger holdout. If reference tiny is incomplete, evaluate legal base/small or previous selected candidates, not change a success assertion.
G. G09/G10 owning Ghatana teams implement public APIs in parallel with Media. Before they exist, keep VIS-09/MM-10 truthfully unavailable; do not create bridge code against imaginary endpoints.

**Wave 3 — real TTS/Vision/MM + quality:** qualify a real licensed voice and real YOLOX labeled images; wire canonical owner job/artifact/outbox, G12 MM independently fenced STT/Vision, source clock and actual positive fusion. Run G08 true model saturation/readiness/quality alerts, named host 1/16/64 and validate all 36 task IDs against exact original positive/negative/recovery/rights/quality acceptance. Existing selected CONDITIONAL capabilities remain their intended obligations until proven or properly scoped.

**Pulse discipline:** two 90-minute code/test implementation pulses without a new whole-row result triggers a **specific dependency switch** (rights acquisition / owner API implementation / alternate model / source-authority integration / OCI host worker), not another 58-row read-only review. At every four-hour checkpoint report exact new accepted IDs, true model bytes/output and one current first-failure test. Resume directly from recorded failed command and source cut; never rerun unchanged closed units.

## 5. Exact commands and nonfabrication checks

Run in the source-controlled Media checkout with **JDK27** on the developer Mac; clean snapshot for Linux Docker. No Windows gating. Opt-in source assets must remain outside Git.

```bash
git fetch origin
git status --porcelain
git rev-parse HEAD origin/main
pnpm check:candidate-decision-crosswalk
pnpm check:wave2-reference-sources

./gradlew -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE \
  -Pghatana.media.compositeScope=FOCUSED \
  -Pghatana.media.focusedModules=stt \
  :services:media:libs:java:common:test \
  --tests 'com.ghatana.media.stt.engine.onnx.WhisperOnnxThreadPolicyTest' \
  --tests 'com.ghatana.media.stt.engine.onnx.WhisperDecoderPolicyTest' \
  --no-daemon --no-parallel --max-workers=2 --console=plain

# Explicit private reference evidence. Do NOT invent the gold transcript.
export GHATANA_MEDIA_WHISPER_PROFILE="<rights-reviewed-private-profile>"
export GHATANA_MEDIA_WHISPER_AUDIO="<rights-cleared-pinned-wav>"
export GHATANA_MEDIA_WHISPER_GOLD_TRANSCRIPT="<actual-original-independent-transcript>"

# First correctness (the opt-in test requires all three real inputs).
./gradlew -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE \
  -Pghatana.media.compositeScope=FOCUSED \
  -Pghatana.media.focusedModules=stt \
  :services:media:libs:java:common:test \
  --tests 'com.ghatana.media.stt.engine.onnx.WhisperReferenceModelIntegrationTest' \
  --rerun-tasks --no-daemon --max-workers=2 --console=plain

# A/B: use the same exact model/source/input and limits for each setting.
# With no GHATANA_MEDIA_WHISPER_ORT_INTRA_OP_THREADS, ONNX uses its old default.
# Repeat the same focused opt-in perf test with setting 1, 2, and 4,
# only up to the host's availableProcessor count.
export WHISPER_PERF_QUALIFICATION=RUN
export GHATANA_MEDIA_WHISPER_ORT_INTRA_OP_THREADS=1
./gradlew -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE \
  -Pghatana.media.compositeScope=FOCUSED \
  -Pghatana.media.focusedModules=stt \
  :services:media:libs:java:common:test \
  --tests 'com.ghatana.media.stt.engine.onnx.WhisperPerformanceQualificationTest' \
  --rerun-tasks --no-daemon --max-workers=2 --console=plain

# After affected code proves correctness, run current-source OS suites:
./scripts/test-media-wave2-platform-matrix.sh mac-core
./scripts/test-media-wave2-platform-matrix.sh linux-arm64-core
./scripts/test-media-wave2-platform-matrix.sh mac-integration
```

**Actual host Docker check for G06:** run a dedicated host-controlled per-invocation OCI worker with flags above; measure process/host effective cgroups and deliberately test OOM, over-PID, wall exhaustion, filesystem isolation, zero network and no Docker-socket presence. Existing `linux-arm64-native` has proved codec functional tests, **not this hard isolation**. No user Mac native process can establish Linux cgroup compliance without a real Linux container.

## 6. Exit decisions and honest stop conditions

- **Success:** the first genuinely verified original row (prefer VIS-03), and next a truly authorized STT job/transcript readback. At finish, all 36 incomplete rows have whole-row evidence and the canonical ledger truthfully becomes 58/58.
- **Failed model quality:** retain model as REVIEW_ONLY; switch to next rights-cleared previous candidate, never lower expected transcript or silently rename unsupported language.
- **Unavailable human consent/weight rights:** exact source/subject/purpose remains production-ineligible. Original nonhuman development assets can unblock protocol/code tests, not third-party biometric/data-licensing claims.
- **No trusted host OCI worker:** native format processing remains fail closed where isolation is required. Docker Desktop's parent 8GiB test cap is not substitute for hard per-invocation bounds.
- **Owner APIs not published:** their Ghatana-owned operations remain integration-unavailable. Media still progresses on independent source, provider, native and persistence work.
- **Performance weak at 16/64:** enforce an admitted lower per-host concurrency ceiling and record typed load rejection. Benchmark numbers describe observed capacity, not a universal SLA.
- **Review and release:** Engineering decisions are approved now. Actual external copyrighted assets, face/voice consent, release/distribution/cutover/legal owner signoffs still cannot be fabricated by this plan. Do not mislabel a green fixture or a successful Git commit as an accepted Wave 2 row.

**Required reporting:** source SHAs (Media/Shared/Ghatana), what file/test actually ran, exact model/corpus/speaker/reference rights, full gold transcript match, actual provider/fenced job ID/output SHA/restart readback, native OOM/PID/CPU and metrics, each original task promoted and which unmet acceptance prevented every remaining row. No broad statement "all blocked by external owner" without a concrete field/receipt/target owner/fallback.
