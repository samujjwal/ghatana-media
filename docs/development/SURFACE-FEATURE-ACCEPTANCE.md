# Per-surface Media feature acceptance

This is the **per-surface acceptance annex**, not a second task queue. Use it with [Usable Surface Delivery](USABLE-SURFACE-DELIVERY.md) and the canonical [task register](remaining-work.json). For each registered surface it states a usable feature, remaining code, and a falsifiable acceptance oracle. The [versioned machine config](../../config/development/media-feature-surface-acceptance.v1.json) binds these statements to stable source IDs, actual ownership paths and four PDP source roots, ready for later configuration review without executing gtool.

**Source reviewed:** `main@4c344251`, November 13, 2026. **Inventory:** 56 registered canonical surfaces = 28 physical + 21 logical + 7 compositions, 30 journeys, 469 authored capability leaves. Eleven newer modules are attached to existing owners as implementation components; not automatically eleven new formal surfaces. Three extra `docs/surfaces` notes describe those components.

## Definition of feature development complete

Every applicable feature must have a real public/client-callable implementation or source-authorized explicit inapplicability; correct byte- or state-level output; exact tenant/actor/purpose/source-version/rights/clock; bounds and typed error/UNKNOWN; idempotency, concurrency, cancellation and restart where effects exist; selected real reference/codec/provider qualification where needed; and a permanent owning README plus focused tests. A local candidate preview is usable but is not the same as a fully integrated feature. No lifecycle closure or release claim is made.

### Physical source owners (28)

| Source identity | Usable result | Finish in code | Acceptance oracle |
| --- | --- | --- | --- |
| [`media.physical.adapters-agent-tools-media`](../../docs/surfaces/adapters-agent-tools-media/README.md) | Four governed STT/TTS/Vision/Multimodal actions | Bind verified agent identity, exact operation/source rights, durable receipt | No duplicate effect or cross-tenant/revoked replay; timeouts UNKNOWN |
| [`media.physical.adapters-data-cloud-media`](../../docs/surfaces/adapters-data-cloud-media/README.md) | Optional metadata read model, no Media state ownership | Keep legacy MediaProcessorPort unavailable; publication only via approved public consumer | Data Cloud outage changes no Media artifact/job finality |
| [`media.physical.adapters-ledger`](../../docs/surfaces/adapters-ledger/README.md) | Optional ordered durable projection | Keep pre-dispatch UNKNOWN and real downstream readback CAS | Crash/lost ACK and concurrency never duplicate or fake terminal |
| [`media.physical.apps-media-experience-explorer`](../../docs/surfaces/apps-media-experience-explorer/README.md) | 47-screen deterministic Explorer | Match PDP3 scenario, captions and simulation labels | CSP, keyboard, deterministic replay and zero live effects |
| [`media.physical.audio-video-observability`](../../docs/surfaces/audio-video-observability/README.md) | True workflow and provider health | Wire real readiness/quality metrics, alerts and capacity probes | UNKNOWN/NaN for missing data, real fire-clear, bounded labels |
| [`media.physical.integration-tests`](../../docs/surfaces/integration-tests/README.md) | Source-free launcher and host journey tests | Run actual SDK through Postgres/S3, restart and failures | Real output bytes/finality and actor isolation, no fixture promotion |
| [`media.physical.launcher`](../../docs/surfaces/launcher/README.md) | One authenticated canonical Media runtime | Compose upload/jobs/stream/cancel/project and trusted rights | Wrong principal denies, restart stable, no second writer |
| [`media.physical.libs-audio-video-client`](../../docs/surfaces/libs-audio-video-client/README.md) | Working ESM/CJS SDK, CLI and recorder | Real admitted commands, finished recorded output/readback | Installed consumer, captured bytes and no fictional retry |
| [`media.physical.libs-audio-video-types`](../../docs/surfaces/libs-audio-video-types/README.md) | Strict, compatible typed Media wire DTOs | Preserve legacy distinction, keep current RPC/HTTP source parity | Safe-int/time/sha/typed errors and ABI tests |
| [`media.physical.libs-audio-video-ui`](../../docs/surfaces/libs-audio-video-ui/README.md) | Accessible actual product web controls | Bind remaining screens to live SDK jobs/Studio/player | Browser a11y, CSP, real result and explicit denied/UNKNOWN |
| [`media.physical.libs-common`](../../docs/surfaces/libs-common/README.md) | Common transport compatibility package | Keep only reused gRPC security/deadline helpers | TLS/JWT/timeout/ABI parity, no duplicate Shared auth |
| [`media.physical.libs-java-common`](../../docs/surfaces/libs-java-common/README.md) | Reusable JVM modality/codec engines | Reuse Whisper/Piper/Vision/native bindings and resource lifecycle | No leak, correct clock/PCM, model-absence refusal |
| [`media.physical.libs-media-experience-simulation`](../../docs/surfaces/libs-media-experience-simulation/README.md) | Curated synthetic experience content | Maintain deterministic authored data distinct from engine output | Same seed/screen result, never claimed as live operation |
| [`media.physical.modules-audio-streaming`](../../docs/surfaces/modules-audio-streaming/README.md) | Ordered authorized audio frames and lease | Bind consent/source clock, cursor/ACK and reconnect | Duplicate/gap/revoke/backpressure/restart and load negatives |
| [`media.physical.modules-infrastructure-cache`](../../docs/surfaces/modules-infrastructure-cache/README.md) | Rights-scoped immutable cache | Key tenant/version/revocation epoch, invalidate on policy change | No stale rights or cross-tenant disclosure, bounded cache |
| [`media.physical.modules-infrastructure-messaging`](../../docs/surfaces/modules-infrastructure-messaging/README.md) | Transactional lifecycle outbox | Bind event identity and eventual consumer ACK to canonical writer | No job success from HTTP 201, dedupe and restart |
| [`media.physical.modules-infrastructure-persistence`](../../docs/surfaces/modules-infrastructure-persistence/README.md) | Persistence helpers without second writer | Verify transaction/migration/rollback against authoritative store | Atomic CAS/restart, no independent JPA finality |
| [`media.physical.modules-infrastructure-security`](../../docs/surfaces/modules-infrastructure-security/README.md) | Trusted security boundary distinct from metadata | Bind current verified principal, purpose and source rights | Forged role/consent fails before effect, no secret leakage |
| [`media.physical.modules-integration-tests`](../../docs/surfaces/modules-integration-tests/README.md) | Wire protocol and composition regression | Verify all real HTTP/RPC methods and source extra disposition | 30 HTTP, 45 gRPC, 27/43 named intent split, auth/status tests |
| [`media.physical.modules-intelligence-ai-voice-libs-ai-voice-ui-react`](../../docs/surfaces/modules-intelligence-ai-voice-libs-ai-voice-ui-react/README.md) | Lawful voice/phrase controls | Use qualified TTS rights, actual output and safe unavailable actions | Real playable audio, keyboard, revoke/unsupported clone refusal |
| [`media.physical.modules-intelligence-multimodal-service`](../../docs/surfaces/modules-intelligence-multimodal-service/README.md) | Grounded cross-modal parent result | Bind matched child versions/clocks/rights and durable parent state | No false complete from missing/wrong-clock child; restart |
| [`media.physical.modules-intelligence-speech-libs-speech-audio-rust`](../../docs/surfaces/modules-intelligence-speech-libs-speech-audio-rust/README.md) | Correct bounded native DSP | Reuse resampler/decode/repair with exact sample clocks | Alias/golden audio, native lifecycle, cancel and leak |
| [`media.physical.modules-speech-stt-service`](../../docs/surfaces/modules-speech-stt-service/README.md) | Lawful source-bound speech transcript | Qualify English/Nepali model/export/gold, store revisions | Actual WER/CER/timing, revoke, UNKNOWN and restart |
| [`media.physical.modules-speech-tts-service`](../../docs/surfaces/modules-speech-tts-service/README.md) | Lawful playable voice output | Qualify selected voice/phoneme and consent, persist audio | Decoded PCM/duration, revoked voice, unsupported control |
| [`media.physical.modules-video-streaming`](../../docs/surfaces/modules-video-streaming/README.md) | Video frame lease, source epoch and PTS | Trusted decoder/cursor/timebase and ROI binding | VFR/reorder/revoke/restart and correct frame digest |
| [`media.physical.modules-vision-vision-service`](../../docs/surfaces/modules-vision-vision-service/README.md) | Real Vision and DI scene text | Qualify detector, versioned frame resolver and DI-only OCR | Real boxes, wrong ROI/digest/tenant fail, OCI faults |
| [`media.physical.providers-aws-postgresql`](../../docs/surfaces/providers-aws-postgresql/README.md) | Authoritative durable Media store | Wire signed scanner release, project/job/stream/caption/review records | Postgres/S3 crash, CAS, quarantine, no second writer |
| [`media.physical.runtime-contracts`](../../docs/surfaces/runtime-contracts/README.md) | Single Java version/rights/operation contract | Bind exact source/frame/time/status across channels | Cross-language DTO/overflow/finality and role rejection |

### Logical channels (21)

| Source identity | User-visible behavior | Remaining work | Acceptance oracle |
| --- | --- | --- | --- |
| [`media.surface.web`](../../docs/surfaces/surface-web/README.md) | Real accessible Media browser app | Wire all applicable screens to backed projects/jobs/Studio | 47-screen navigation, browser auth/a11y and saved result |
| [`media.surface.embedded`](../../docs/surfaces/surface-embedded/README.md) | Origin-bound safe playback/embed | Versioned media, captions, explicit simulation and host permissions | No cross-origin privilege, deterministic seek/replay |
| [`media.surface.public-http`](../../docs/surfaces/surface-public-http/README.md) | Correct canonical Media HTTP | Bind 30 observed routes to admitted handlers and wire shapes | Wrong actor/body/timeout/idempotency and exact readback |
| [`media.surface.service-grpc`](../../docs/surfaces/surface-service-grpc/README.md) | Four authenticated modality RPC services | Track 45 proto methods, two unbound Vision extras vs named 43 | Generated descriptor parity, auth/deadline and no stub SUCCESS |
| [`media.surface.grpc.stt`](../../docs/surfaces/surface-grpc-stt/README.md) | STT transcribe/stream/correction RPCs | Complete 12 methods with lawful engine or typed unavailable | Language/profile, cancellation/word PTS, source readback |
| [`media.surface.grpc.tts`](../../docs/surfaces/surface-grpc-tts/README.md) | TTS synthesis/profile/voice RPCs | Complete 11 methods with qualified voice or typed refusal | True PCM stream, revoke and no unadmitted cloning |
| [`media.surface.grpc.vision`](../../docs/surfaces/surface-grpc-vision/README.md) | Vision detection/video/frame/scene-text RPCs | Complete 12 methods incl two unbound source observations | VFR/ROI/source rights, DI-only, no fake OCR result |
| [`media.surface.grpc.multimodal`](../../docs/surfaces/surface-grpc-multimodal/README.md) | 10 multimodal analysis/model RPCs | Bind child/parent versioned operations and unsupported cases | Temporal mismatch, partial child, restart UNKNOWN |
| [`media.surface.sdk`](../../docs/surfaces/surface-sdk/README.md) | Installed consumer-facing canonical SDK | Preserve ABI, no invented endpoint, strict source DTO mapping | Source-free ESM/CJS, retry/finality/error tests |
| [`media.surface.cli`](../../docs/surfaces/surface-cli/README.md) | Usable authenticated headless commands | Expand artifact inspect with only admitted job/capture/batch routes | Actual process JSON outputs, source rights and exit codes |
| [`media.surface.agent-tools`](../../docs/surfaces/surface-agent-tools/README.md) | Four delegated action interfaces | Bind verified Tools principal to exact Media operations | One claim/effect, no direct provider bypass, redaction |
| [`media.surface.events`](../../docs/surfaces/surface-events/README.md) | Versioned lifecycle event subscription | Outbox identity and consumer ACK separate from job result | 201 append vs consumed status, replay/order/tenant tests |
| [`media.surface.integrations`](../../docs/surfaces/surface-integrations/README.md) | Public DI/Shared/Tools; optional Data Cloud | Keep DI single OCR gateway and immutable client peer | No OCR fork, core survives Data Cloud or DI outage |
| [`media.surface.types-library`](../../docs/surfaces/surface-types-library/README.md) | One strict shared contract catalog | Map source Java/TS/OpenAPI/protobuf fields and errors | Source enum/ABI/overflow/protocol parity |
| [`media.surface.ui-library`](../../docs/surfaces/surface-ui-library/README.md) | Reusable accessible Media component families | Bind SDK real state and distinguish fixture previews | Keyboard/zoom/CSP, denied/UNKNOWN UI, no fake success |
| [`media.surface.explorer`](../../docs/surfaces/surface-explorer/README.md) | PDP3 curated product simulation | Keep narration/screen/caption and identity consistent | Stable seed, labeled simulated scenarios, no effects |
| [`media.surface.desktop-archive`](../../docs/surfaces/surface-desktop-archive/README.md) | Read-only desktop compatibility | No new active desktop/backend, preserve required public ABI | No duplicate writer or active desktop route |
| [`media.surface.recorder-orchestrator`](../../docs/surfaces/surface-recorder-orchestrator/README.md) | Finished unattended recording | Bind real sources/narration/mux and registered artifact version | Decoder-playable A/V+caption, PTS/digests, restart |
| [`media.surface.capture-adapters`](../../docs/surfaces/surface-capture-adapters/README.md) | Eight permissioned capture sources | Qualify GRPC_API/CAMERA; preserve other bounded adapters | No bytes after revoke, frame/cursor/clock validated |
| [`media.surface.production-studio`](../../docs/surfaces/surface-production-studio/README.md) | Professional revisioned editing and export | Connect project, effects, preview, review and delivery to host | Real edits/undo, playable export, source rights/a11y |
| [`media.surface.interactive-demo-player`](../../docs/surfaces/surface-interactive-demo-player/README.md) | Safe branching interactive demo playback | Bind authored/real media manifests, captions and viewer | Origin denial, deterministic seek/replay and keyboard access |

### Compositions (7)

| Source identity | Real outcome | Integration needed | Acceptance oracle |
| --- | --- | --- | --- |
| [`media.composition.repository-root`](../../docs/surfaces/composition-repository-root/README.md) | Complete coherent Media product/libraries | Build from public packages and authoritative sources only | All applicable capabilities and customer journeys run |
| [`media.composition.ingestion-and-versioned-artifacts`](../../docs/surfaces/composition-ingestion-and-versioned-artifacts/README.md) | Upload to scanned immutable artifact | Join checksum, rights, quarantine and exact registration | Unsigned/UNKNOWN scanner blocks release; bytes survive restart |
| [`media.composition.governed-job-execution`](../../docs/surfaces/composition-governed-job-execution/README.md) | Authorized job to durable terminal result | Use claimed attempt/provider receipt/cancel/reconcile | Timeout UNKNOWN, no duplicate work or fabricated finality |
| [`media.composition.speech-and-caption-workflows`](../../docs/surfaces/composition-speech-and-caption-workflows/README.md) | Transcript, corrected captions and legal voice | Join STT/TTS, source clock and immutable revisions | J03/J04/J16 real decoded outputs with revoke/restart |
| [`media.composition.vision-and-multimodal-analysis`](../../docs/surfaces/composition-vision-and-multimodal-analysis/README.md) | Time-grounded detection, OCR and fusion | Join video frame PTS/ROI, DI worker and child sources | J05/J06 accurate source provenance, failure isolation |
| [`media.composition.creation-composition-and-delivery`](../../docs/surfaces/composition-creation-composition-and-delivery/README.md) | Project authored media through review/export | Link timeline/2D/3D/simulation/render/mix/review to one revision | Playable master, edit/review CAS, real destination receipt |
| [`media.composition.client-and-machine-interfaces`](../../docs/surfaces/composition-client-and-machine-interfaces/README.md) | Consistent public Media operations in all clients | Bind HTTP/gRPC/SDK/CLI/Tools/UI/Events to same source truth | Typed scope/UNKNOWN and no invented legacy route |

## Additional implementation components (11; not new canonical identities)

| Existing module | Attached canonical owner | Required behavior / verification |
| --- | --- | --- |
| [`modules/production/timeline`](../../modules/production/timeline/README.md) | `media.composition.creation-composition-and-delivery` | Project/scene/timeline source CAS and persistent revisions. Verify Exact version reopen, concurrent writer and rollback. |
| [`modules/production/animation`](../../modules/production/animation/README.md) | `media.composition.creation-composition-and-delivery` | Real PNG/GIF bounded animation candidate. Verify Independent decode, keyframe, raster and rational clock. |
| [`modules/production/spatial`](../../modules/production/spatial/README.md) | `media.composition.creation-composition-and-delivery` | GLB rig and narrow coordinate profile. Verify glTF validation, float32 loss and actual viewer. |
| [`modules/production/simulation`](../../modules/production/simulation/README.md) | `media.composition.creation-composition-and-delivery` | Typed deterministic physical solver. Verify SI unit, convergence, reference model, abstain. |
| [`modules/production/rendering`](../../modules/production/rendering/README.md) | `media.composition.creation-composition-and-delivery` | Multitrack plan and RGB candidate codec pipeline. Verify Real mux/independent decode with source PTS. |
| [`modules/production/audio-mixing`](../../modules/production/audio-mixing/README.md) | `media.composition.creation-composition-and-delivery` | PCM repair/stems and playable WAV. Verify Independent WAV decode, immutable A/B, lawful source. |
| [`modules/production/dubbing`](../../modules/production/dubbing/README.md) | `media.composition.speech-and-caption-workflows` | Versioned translate/voice/align orchestration. Verify Real authorized translated output and sync. |
| [`modules/production/review`](../../modules/production/review/README.md) | `media.composition.creation-composition-and-delivery` | Case/revision-bound review statements. Verify Shared project CAS, owner approval authority, stale deny. |
| [`modules/production/delivery`](../../modules/production/delivery/README.md) | `media.composition.creation-composition-and-delivery` | Fenced destination effects and receipt. Verify Real destination readback, no double send. |
| [`providers/security-scanner`](../../providers/security-scanner/README.md) | `media.composition.ingestion-and-versioned-artifacts` | Signed scanner adapter, dev-only before actual ClamAV qualification. Verify Ed25519 authentic CLEAN, quarantine, real corpus. |
| [`services/document-intelligence`](../../services/document-intelligence/README.md) | `media.surface.integrations` | MDI-002 PROPOSED DI v1 relocation only, inactive writer. Verify Single active DI, public installed package, real OCR/rights. |

## Implementation sequence — real usable capability after each increment

**F0. Verify source and config correctness once, then reuse results.** Check registered source identities, supplemental modules, actual 30 HTTP/45 gRPC observations versus the separately named PDP-1 27/43 intents; keep two Vision extras as unbound source operations. The 469 leaf crosswalk is a conservative, family-task-gated classification, not proof that local code is absent. Never fake per-leaf completion.

**F1. Use existing finished local creative libraries before changing them.** The runnable `examples/media-creative-preview` already produces independently decoded PNG/GIF/WAV/GLB and numerical output; `examples/recorder-mux-preview` produces local decoder-tested MP4. Preserve existing passing tests. Next feature work is real caller-owned source/rights and registered output, not another engine implementation.

**F2. Make a usable headless Media API.** Use existing `launcher`/`providers/aws-postgresql`, source-free SDK and DEV_ONLY signed principal to upload/checksum/quarantine/register/read exact bytes, create/query/cancel/reconcile a job, and reopen after process restart. A DEV_ONLY scanner is not signed production scan approval. Do not add a second artifact writer.

**F3. Make project and recording workflows usable.** Finish canonical project/timeline ownership and host scene/clip/time mapping; wire actual browser actions. For recorder, authorize real source → capture → narration → VTT/TTML → pinned codec mux/ffprobe → versioned output. Synthetic preview cannot be presented as real product recording.

**F4. Qualify real STT/TTS.** Reuse existing Whisper/Piper, language qualification registry, transcript/caption stores. Admit per-locale lawful checkpoint and gold (English/Nepali), independently check WER/CER and host resources; produce real transcript revisions and decodable TTS with revoke and restart.

**F5. Complete Vision/frame/DI.** Media owns original video frame/PTS/ROI/digest authority; DI alone executes generic OCR. DI relocation under MDI-002 is still PROPOSED and Media's copied DI is not active writer. Qualify real models, immutable Shared package peers, hosted trust and labeled gold before positive claims.

**F6. Compose grounded multimodal.** Join only authenticated child source/version/clock/rights receipts and durable parent state; never report a heuristic match as calibrated. Exercise child loss/partial and UNKNOWN.

**F7. Ship the full Studio workflow.** Timeline/storyboard/edit → real render/mix → output decode/registration → version-specific real review → durable acknowledged delivery. Reuse all nine production components, require fresh source rights and host APIs, keep typed unsupported for any unavailable provider.

**F8. Expose all tools and consumer channels.** Complete public HTTP, current gRPC, SDK, CLI, Agent Tools, events and embedded player without private provider bypass. All four agent handlers need verified delegation, an exclusive invocation fence and real job readback; delivery needs authentic destination receipt.

**F9. Coverage sweep and dev-complete decision.** Reconcile each of 469 authored leaves to a real capability, source-defined supported scope or genuinely inapplicable declaration; all 47 screens and 30 journeys need actual positive and negative tests as applicable. Run each targeted source-free consumer and host-qualification check when its inputs change. No green-by-documentation.

## Efficient testing; no unnecessary replays

Use `node scripts/check-media-surface-delivery.mjs --affected=<base>` to select changed area tests. `scripts/local-test-pass-cache.mjs` supports deterministic Node TAP test reuse only when explicit source/fixture/config/toolchain/provider fingerprints match and prior real results passed; never cache or infer missing provider rights/volatile health. Rely on native Gradle incremental outputs for JVM and focused pnpm/Rust packages. The historical qualification runner intentionally forces fresh tasks and is not the default feature-development loop. Run real host/codec/model tests once per changed profile and final integrated milestone; avoid broad repeated suites after unrelated docs.

## Gtool-ready configuration without using gtool

The machine config carries canonical surface IDs, owning code paths, stable per-surface documentation, PDP-0..3 source roots, current mapped task IDs, result definition, remaining implementation and acceptance oracle. ARCHIVED/SUBSUMED/SUPPORT_ONLY semantics are preserved. Eleven additional implementation modules are explicitly attached to existing canonical owners, not silently registered as new lifecycle surfaces. Use the config for later source-specific phase applicability and test attachment; **do not execute gtool, mint closure receipts, or mark a phase ready**. A separate source-authorized topology decision is required before any supplemental module gets a new formal surface ID.

Validate only this static definition when source topology/contracts change: `pnpm check:media-feature-acceptance`, `pnpm check:surface-roster`, `pnpm check:surface-docs`, and `pnpm check:usable-surface-delivery`. These do not substitute for feature tests or formal lifecycle acceptance.
