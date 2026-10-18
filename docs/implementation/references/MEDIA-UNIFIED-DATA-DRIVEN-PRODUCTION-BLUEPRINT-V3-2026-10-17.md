# Ghatana Media — Unified Data-Driven Voice, Video, Recorder, and Studio Blueprint (v3 — Recorder, Declarative Animation, Simulation and TutorPutor)

**Review date:** 2026-10-17 (third-pass consolidated edition)  
**Status:** Comprehensive proposed SOTA source-bound architecture and implementation plan; NOT a PDP phase acceptance, Build admission, runtime cutover, provider qualification, or release authorization.  
**Repositories:** `samujjwal/ghatana-media` (product truth and intended owner); `samujjwal/ghatana:services/media` (canonical executable runtime until MIG-04); `samujjwal/gharbatai` (initial Recorder/Studio dogfooding consumer).  
**Inputs:** October 17 Media Recorder/Studio PDP0–3 source and successor reviews, October 15 Build Plan candidate, prior VoiceStudio 0.5.x analysis, Voicebox upstream, and October 17 video-tool assessment. Public ChatGPT share link title was accessible but its full body was not; former voice conclusions were cross-checked against VoiceStudio/Voicebox GitHub sources and prior discussion context.  
**Third-pass controlling update:** 73 scoped additions extend the original 428 audit-local features to **501**; Recorder/Studio (PR #10 already merged), animation, scientifically model-backed simulation, and TutorPutor AEF integration are now first-class parts of this exact blueprint; see §§18–26 and the extended machine audit. The v2 428 audit candidates are preserved without deletion or silent renumbering.

**Second-pass scope and verification:** This edition preserves the first reviewed blueprint, expands it into an atomic feature inventory and source-pinned OSS adoption plan, and adds stronger quality/competitive acceptance. The companion JSON contains 428 audit-local features in 22 domains. This is **NOT** a claim of exact PDP0 capability mapping or code/runtime feature completion. See §§12–17 for controlling amendments and license corrections.  

**Important:** All capability and package designs below are *proposals* unless their exact stable ID or file is already identified as source-owned. Do not silently invent API routes, package ownership, canonical requirements, or implementation readiness.

## 1. Product outcome and invariant architecture

Make **Ghatana Media** one local-first, config-and-data-driven, secure and observable media production environment covering professional recording; software demo capture; voice I/O, TTS, STT, dubbing and cloning with rights; timeline-based manual editing; script-directed automation; image/video generation; 2D/3D, interactive media, and trustworthy delivery. User input may be YAML/JSON, CLI/API/SDK, project UI, or an authenticated agent. All produce one versioned **MediaProject** revision, one operation/revision log, one derivation graph, and consistent exports. AI offers advice/proposals or performs specifically approved bounded operations: it is never a second project owner or authorization bypass.

### Immutable decisions

1. Reuse Media's media-project, asset/artifact, job/attempt, provenance, consent/rights, policy, streaming, timeline, screen, and delivery semantics. **No independent Voicebox/VoiceStudio/OpenReel project database** and no duplicate TTS/STT or recorder subsystem.
2. `.product-experience/` in `ghatana-media` remains authoritative for PDP0–3. The production runtime/writer remains `ghatana/services/media` until an explicitly admitted reversible MIG-04 cutover. `ghatana-media`'s copied Java runtime is not currently an independent live server.
3. Keep four Recorder/Studio logical surfaces already defined: `media.surface.recorder-orchestrator` (parent `media.surface.cli`), `media.surface.capture-adapters` (parent `media.surface.integrations`), `media.surface.production-studio` (parent `media.surface.web`), and `media.surface.interactive-demo-player` (parent `media.surface.embedded`). New subworkspaces/modules below must project under their existing hierarchy, not create duplicate physical runtimes. Root, 7 compositions, 26 physical candidates, and 17 historical consumers remain the prior scope; four logical consumers make 216 **proposed** PDP cells, not 216 accepted cells.
4. Existing historical PDP denominators are observations rather than execution claims: 462 capability leaves; 84 Recorder/Studio acceptance clauses across 16 feature profiles; 15 Recorder/Studio proposed PDP1 operations; 52 manual edit kinds with typed parameters; 13 proposed Studio pages; 47 historical screens/30 journeys/130 steps. Reconcile exact source IDs/changed counts on the current cut. Do not copy old DEV_COMPLETE receipts to successor cells.
5. Prefer **MIT / Apache-2.0 / BSD / ISC** source and independently admitted binaries/models/voices/fonts/codecs. Other license classes are feature references, or separately reviewed opt-in external adapters only; no default bundling to circumvent license terms.
6. Media owns domain-specific semantics; Shared owns neutral primitives/design/audit; Tools owns generic experience and orchestration contracts; Lifecycle owns verification/closure; AI Inference owns generic execution/model governance; Data Cloud owns generic metadata and analytics; Document Intelligence owns general OCR/parsing. Consumers own domain journeys, accounts, credentials, seed fixtures, authorizations, and business-finality readback.
7. Native AI/ML, source trust, local privacy, multitenancy, security, traceability/OTel, resilience, deterministic revisions, keyboard/headless parity, cost/resource budgets, rights, and user review are designed into *every* path, not retrofitted.

## 2. Capability completeness ledger (target features, not claims of implementation)

Each row is an intent cluster. Map every item to existing `media.*` PDP0 capability and affected canonical requirements/cases before inventing a new normative identity. For each item capture: canonical capability ID, owning surface, typed P1 operation/result, P2 GUI/keyboard/API/SDK/CLI grammar, P3 journey/step/negative example, reuse source, build target, automated tests, provider/license/hardware state, and provenance.

| Cluster | Full target feature set | Delivery strategy | Owner |
|---|---|---|---|
| A — Source ingest | Browser tab/window/desktop/mobile/camera/microphone/audio-interface/screen/stream/file; terminal, API/gRPC/CLI-only journeys; drag/drop, batch, reference/media import; capture signal capability probe; multiple angles and source clocks | Retain qualified Gharbatai recorder plan and adapter vocabulary; browser/OS APIs first; optional native adapters | Capture adapters |
| B — Software demo and presentation capture | Metadata-driven scripts, storyboards, personas/audiences, screen action plans, test fixtures, account seeding/ownership lease, deterministic wait/readback, cursor/key/mouse visualization, scroll/zoom, click spotlight, callouts, screenshots, presenter camera, multi-angle, source/action receipts, recovery, scene-only recapture | One compiled Recording Execution Plan; source event receipts; no invented product effects; 16:9, 9:16, 1:1 profiles | Recorder orchestrator |
| C — Media projects / ingest | Immutable sources, file/hash integrity, codec validation, multi-project library, scenes, sequences, nested timelines, presets, reusable brand kits, local imports, media/search metadata, tags, source clipping, thumbnails/proxies, versioning, derivatives, provenance | Existing MediaProject/artifacts/read-models; only add versioned projections | Core / Studio |
| D — Professional editing | **All 52 existing** trim/roll/ripple/slip/slide/split/insert/move/reorder/snap/marker/nested/keyframe/easing/mask/redact/cursor/transform/zoom/pan/reframe/color/overlay/titles/credits/branding/transitions/captions/timing/dub/narration/gain/duck/mix/fades/multicam/PiP/hotspots/branches/undo/redo/group/crop/click/background/frame/annotation/mute/solo/speed-ramp/denoise; timeline snapping, linked tracks, selection, track lock, source timecode, clip bins, adjustment and preview | Canonical PDP1 discriminated operations and shared timeline; OpenReel MIT code selectively after dependency audit; all GUI, keyboard/text and machine channels same commit function | Production Studio |
| E — Voice input / ASR | Recording/dictation, offline/streaming STT, VAD, language detection, punctuation, timestamps, word alignment, speaker diarization/identification, multi-speaker corrections, confidence, immutable transcript revisions, search, transcript-based editing and filler/removal suggestions | Existing STT + Whisper.cpp / sherpa-onnx permitted adapters, qualified models; platform NLP for transforms | Speech / Studio |
| F — Voice output / synthesis | Preset voices, voice profiles, narration, multilingual TTS, chunked streaming, prosody/style/emotion/pronunciation controls, SSML-like text annotations, pause/breath control, per-sentence takes, A/B audios, long-form audiobook/podcast/dialogue, reusable recipes, batch generation, explicit effective-voice and model attestation | Existing governed TTS/Piper and AI Voice UI; add selected Voicebox MIT patterns; model/license admission | Speech / Studio |
| G — Voice cloning and design | Consented reference enrollment, sample QA, zero-shot/fine-tuned clone where supported, synthetic voice design, model download/verification, encrypted embeddings, speaker rights, bounded adaptation, profile deletion/revocation, generated voice disclosure, watermark/provenance, anti-impersonation review | New rights-aware provider adapter; real clone capability only after qualified supported model; never expose Piper placeholder as cloning | Speech / Rights |
| H — Dubbing/localization | Translate transcripts, voice/speaker map, source separation, timed multilingual revoice, subtitle translation, timing constraint and segment reconciliation, accent/pronunciation review, music ducking, optional lip-sync, segment re-render and locale variants, RTL and multilingual transcript QA | Shared alignment/caption tracks and voice engine; platform translator via approved public API; lip-sync gated by rights | Speech / Studio |
| I — Audio engineering | Multitrack waveform/phrases/stems, gain/pan/EQ/noise suppression/de-esser/expander/compressor/limiter/reverb/delay/chorus, fades, crossfades, sample rate conversion, loudness/true peak, ducking, silence detection, stem separation, beat sync, music library, licensing, audio cleanup, mixdown, export | WaveSurfer BSD UI; WebAudio, RNNoise BSD code (weights separately), Rubato MIT/Apache, libebur128 permissive; reimplement GPL Pedalboard behaviors | Studio audio |
| J — Autonomous director/editor | Themes/audiences/constraints, scripts, shot list, visual/audio plan, asset search with license, narration generation, source/scene ranking, b-roll, first cut, cuts/silences/filler cleanup, retakes, highlights, pacing/beat sync, style Skills/recipes, caption styling, continuity, suggested improvements, exact scene rerun | Original typed director/plan compiler modeled on FireRed Apache ideas and OpenReel agent patterns; no unsandboxed shell | Orchestrator / Studio |
| K — Visual generation | Image creation/edit/upscale/background removal, text→video, image→video, keyframe conditioning, video→video, start/end frame transitions, b-roll, stylization, inpainting/outpainting, motion reference, storyboards, thumbnail/title-card generation, seed/control/version and cost reporting | Diffusers Apache; admitted model weights; optional externally managed ComfyUI; unavailable GPU truth | Generation worker |
| L — Vision and smart video | Scene/shot detection, crop/subject tracking, object/face/landmark regions, OCR via platform DI, source text preservation, speech/video alignment, automatic protected reframing, scene quality/continuity checks, grounded visual analysis, timebase/frame correspondence | Existing Media vision/multimodal and public DI; PySceneDetect BSD; supported ONNX models | Media vision / QA |
| M — Motion, 2D/3D and simulation | Image/graphic layers, vector shapes, motion graphics, easing, 2D keyframes, character/rig/pose, camera path, 3D scene/glTF transforms, spatial export, measurement/simulation lineage, postprocessing and render; loss reporting for unsupported 3D fidelity | Three.js MIT, glTF Transform MIT, OpenColorIO BSD, existing Media spatial domain; native code for semantic transforms | Studio spatial |
| N — Interactive stories/player | Scene graph, keyboard-accessible hotspots, branches, chapter transcript, menus, quizzes/forms only if governed, offline playback bundles, embeddable player, analytics with consent, sandbox/CSP, unprivileged action hints | Existing embedded logical player; strict no delegated business mutations | Interactive demo player |
| O — Review/quality/compliance | Source-vs-output frame/audio QA, A/V sync, loudness, caption accuracy, clipping/silence/black tail, protected crop, accessibility, unsupported codecs, source text and logos, voice consent, license provenance, audience/legal hold, risk/uncertainty, review notes, manual locks, approvals/abstentions | Existing quality and rights semantics; media-version QA reports and bounded profiles | QA / Rights |
| P — Render, publish, distribute | Timebase-aware previews, proxies, 1080p/4K qualified profiles, portrait/square/widescreen, audio and caption sidecars, MP4/WebM when encoder licensed/available, WAV/Opus/FLAC, thumbnails, OTIO export, interactive bundle, adaptive packaging where admitted, manual exports, delivery destinations, exact remote receipt/reconciliation, resumable exports | Native/Browser codecs with permissive mux where supported; approved renderer SPI; governed delivery | Renderer / Delivery |
| Q — Operations / API / agents | Headless YAML/JSON plan compiler, typed CLI/SDK/HTTP/gRPC/events, MCP bounded tools, scheduling, watch folders, batch production, templates, distributed local workers, GPU and model budgeting, task graph, rollback, dry-run/preview, permissions, telemetry, retention, quotas, cleanup, retries and outbox finality | Reuse Ghatana runtime/shared/tools/lifecycle; not new queue, model router, store or security boundary | Orchestrator / Platform |

All clusters belong to the unified product; sequencing must not equate to dropping higher-cost features. Distinguish **feature present in source definitions**, **code exists in prepared mirror**, **canonical-runtime functionality qualified**, and **release admitted**.

## 3. Permissive OSS/reimplementation adoption ledger

**Allowed by default** means *candidate subject to pinned version, exact file SPDX, SBOM, transitive dependency, model/asset license, security and technical qualification*. The root repository license alone is never enough to approve a bundled app.

| Technology / project | Source license evidence | Intended reuse | Exact disposition |
|---|---|---|---|
| Ghatana owned Media/Shared/Tools | Internal approved ownership | Existing projects, ops, rights, Jobs, OTel, Experience | **REUSE FIRST**; never fork owners |
| Voicebox (`jamiepine/voicebox`) | MIT application | Voice profile editor, TTS workflow, take selection, Stories UI, model management concepts and isolated MIT code | **SELECTIVE COPY/ADAPT**; remove GPL Pedalboard and independently audit model rights |
| VoiceStudio (`debpalash/VoiceStudio`) | AGPL-3.0 | Dubbing, audiobook, speaker/voice features and UX behavior | **REIMPLEMENT FROM REQUIREMENTS**; no AGPL source copying |
| OpenReel (`Augani/openreel-video`) | MIT application, but package imports FFmpeg wasm and MPL-2.0 MediaBunny | Timeline UI/operations, agent dry-run/diff, editor interactions | **SELECTIVE COPY/ADAPT** MIT subsets only; do not import entire dependency graph |
| FireRed-OpenStoryline | Apache-2.0 | Script-to-rough-cut, editor skills, prompts/media matching, agent planning | **SELECTIVE COPY/ADAPT** code with notice/attribution; avoid unmanaged media scraping and non-permissive downstream binaries |
| Open-Generative-AI | MIT application code | Generator catalog, job UX, optional provider interface | **SELECTIVE COPY/ADAPT**; no assumption that cloud endpoints or WanGP are permissive |
| OpenCut | MIT app; roadmap includes unimplemented APIs | UX/architecture research or isolated copy once verified | **QUALIFY FIRST** |
| OpenChatCut | AGPL-3.0 | AI editor and transcript timeline behavior | **SPECIFICATION/BEHAVIOR ONLY** |
| `whisper.cpp` | MIT | CPU/offline and native ASR, streaming, timestamps | **CANDIDATE**; checkpoint and runtime QA |
| `sherpa-onnx` | Apache-2.0 | ASR/TTS/VAD/diarization/identification and low-resource runtime | **CANDIDATE**; model/phonemizer audit |
| Legacy `rhasspy/piper` | MIT code; model license varies | Existing Piper voice path; bundled voices only if admitted | **RETAIN/QUALIFY**; independent phonemization deps |
| `resemble-ai/chatterbox` | MIT code; model card MIT for identified checkpoint | Expressive multilingual/clone option | **CANDIDATE AFTER CONSENT/MODEL QA** |
| Qwen3-TTS | Apache-2.0 code | Optional voice design, clone and delivery style | **CANDIDATE AFTER MODEL/ASSET LICENSE AND HARDWARE QA** |
| `Diffusers` | Apache-2.0 | Local conditional image/video generation API | **CANDIDATE**, per-checkpoint terms mandatory |
| Wan-family upstream | Apache-2.0 for relevant code/checkpoints where published | Local text/image video model option | **PER-CHECKPOINT REVIEW**; large VRAM and memory budgets |
| `PySceneDetect` | BSD-3-Clause | Scene/shot detection | **CANDIDATE** |
| `OpenTimelineIO` | Apache-2.0 | Project interchange (not canonical DB/timeline) | **CANDIDATE** |
| `WaveSurfer.js` | BSD-3-Clause | Waveform/editing UI | **CANDIDATE** |
| `OpenColorIO` | BSD-3-Clause | Color conversion/interchange | **CANDIDATE** |
| Three.js / glTF Transform | MIT | 2D/3D preview and glTF asset transforms | **CANDIDATE** |
| `gpac/mp4box.js` | BSD-3-Clause | MP4 container parsing/muxing where licensed video encoding exists | **CANDIDATE**; muxing is not encoding |
| `rubato` | MIT OR Apache-2.0 | High-quality audio resampling | **CANDIDATE** |
| `libebur128` | Permissive code; exact pin to verify | Loudness measurements | **CANDIDATE** |
| `rnnoise` | BSD-3-Clause code; published pretrained weight terms need confirmation | Denoise DSP | **CODE CANDIDATE, WEIGHTS NOT YET ADMITTED** |
| `spotify/pedalboard` | GPL-3.0 (JUCE/VST3) | Audio effects feature behavior only | **REIMPLEMENT / APPROVED EXTERNAL ONLY** |
| FFmpeg / FFmpeg.wasm | LGPL/GPL depending exact build/plugins/codecs, **not strictly permissive** | Compatibility/reference, optional user-managed external tool | **NOT DEFAULT PERMISSIVE RENDERER**; independently approved fallback only |
| `mediabunny` | MPL-2.0 | Browser media I/O ideas | **NOT PERMISSIVE DEFAULT**; prefer WebCodecs + BSD mux where feasible |
| MLT | LGPL core; certain utilities and modules GPL | Timeline renderer ideas | **NOT PERMISSIVE DEFAULT** |
| Remotion | Conditional commercial licensing | Motion/video render behavior | **NOT DEFAULT; SEPARATE LICENSE APPROVAL** |
| ComfyUI | GPL-3.0 | Optional locally managed workflow provider, only with legal review | **NO BUNDLING**; protocol boundary if approved |
| WanGP/Wan2GP | Restricted community terms | Low-VRAM execution concepts only | **DO NOT EMBED/WHITE-LABEL BY DEFAULT** |
| Voice and speech presets/models | Per-model/per-voice | Cloning/presets/speech features | **DENY UNVERIFIED RIGHTS/MODEL HASH** |

Transitive caveats: OpenReel's root `package.json` declares `@ffmpeg/core`, `@ffmpeg/core-mt` and `mediabunny` alongside its MIT license. Voicebox's `backend/requirements.txt` includes GPL-3.0 Pedalboard. Kokoro can include eSpeak-ng GPL-related dependency paths; decide implementation and packaging from the actual pinned chain, not top-level model-card tags. RNNoise has an open inquiry regarding pretrained-weight licensing. Model use, generated outputs, training input, reference voices, identity rights and bundled codec patent policy are separate validations.

## 4. One canonical data model; no voice/video islands

**Source meaning** should extend existing `MediaProject` and versioned artifacts with projections/contracts (not new competing stores):

- `MediaProductionSpec`: authored YAML/JSON/GUI intent, content objectives, audiences, allowed destinations, requirements, scene and rights constraints.
- `MediaProductionPlan`: immutable compiled, validated plan fingerprint; exact source versions/scenario/storyboard, chosen admitted providers, model/asset hashes, execution graph, stage budgets and approvals. This is a *typed plan artifact* within the existing project/run model, not a second job authority.
- `SceneSpecification`: source anchors, speaker/narration segments, camera/visual/audio plan, exact event action receipts and output constraints.
- `SourceTrack`/`MediaClip`/`TimeMap`: source clocks and rational half-open time intervals; every transform maps source PTS to destination PTS with uncertainty. Never infer sequence time from wall clock alone.
- `MediaEditOperation`: existing 52 discriminants and typed arguments; actor, source, expected revision (CAS), request key, provenance, manual lock, derivation impacts. A successful edit creates exactly one successor immutable revision.
- `VoiceProfile` **projection**: profile ID, source-sample immutable refs, consent/purpose/speaker ownership, encrypted embedding ref (if admitted), model/provider version, language/voice controls, expiry/revocation, deletion/retention state. Not a separate voice account/store.
- `InferenceAttempt` and `GeneratedAsset`: content digest, model checkpoint, runtime precision, parameters/seed, qualified machine tier, uncertainty/quality, rights snapshot, output artifact, attempt/finality. Never mistake returned provider request ID for completed media.
- `RenderedArtifact` and `QualityReport`: exact input accepted revision, render profile/encoder provenance, QA observations, approval references, generated caption/audio/interactivity assets, immutable output digest.
- `PublicationOutcome`: request accepted / provider unknown / completed remote ACK / denied and verified finality kept distinct.

**Pipeline:** authored configuration or GUI/agent input → schema and purpose admission → deterministic plan compile and source fingerprint → qualified capture/import/generation → speech/visual analysis → suggested edit graph → manual/approved AI edit commit → preview/render → source-grounded QA + review → governed publish → immutable receipts. A denial or `UNKNOWN` stops side effects until bounded reconciliation. Scene-only recapture invalidates precisely dependent artifacts and **preserves manual locks**; all source operations remain auditable.

**Typed editor kernel:** `plan | inspect | propose | simulate | commit(expectedRevisionId, idempotencyKey) | reconcile | undo | redo | render | publish`. An LLM/MCP agent can only invoke the advertised operation with authenticated actor scopes; no shell/filesystem/network authority derives from natural-language commands. Every invocation returns typed `APPLIED/CONFLICT/DENIED/UNAVAILABLE/UNKNOWN` semantics as appropriate and an exact recovery strategy. Never accept model-generated arbitrary executable code as an edit operation.

## 5. Illustrative media recipe (not an existing approved wire schema)

```yaml
schemaVersion: media.production.recipe.proposal.v1
project:
  tenantRef: tenant-from-auth-context   # logical authority; never trust an arbitrary tenant header
  projectRef: media-project-id
  expectedRevisionRef: rev-0003
  intent: product-demo
  audienceRef: investor
  templateRef: media.recipe.template.product-demonstration
sources:
  primary:
    kind: browser
    adapterProfileRef: qualified-playwright-screencast
    scenarioRef: gharbatai/scenario-v2/qualified-s01
    storyboardRef: gharbatai/storyboard-v1/s01
    authorizationRef: runtime-purpose-grant
  supplemental:
    - kind: imported-media
      assetRef: media.asset.demo-intro.v2
      role: title-card
production:
  planCompiler: deterministic
  scenes:
    - sceneRef: s01-scene-01
      captureAnchorRef: s01-step-01
      narration:
        scriptRef: media.script.en.scene-01.v2
        voiceProfileRef: media.voice.approved-default
        locale: en-US
        sourcePolicy: require-real-qualified-synthesis
      editRecipeRef: media.edit.product-demo.calm-v1
  director:
    agentMode: suggest-or-authorized-typed-operations
    preserveManualLocks: true
    abstainWhenUnsupported: true
  localeVariants: [en-US]
  formats:
    - profileRef: video-1080p-landscape-qualified
    - profileRef: video-1080p-portrait-qualified
  qualityProfileRef: media.qa.professional-demo.v1
policies:
  inference: local-first
  remoteEgress: deny-by-default
  rightsSnapshotRef: media.rights.approved-source-v4
  onUnqualifiedCodec: UNAVAILABLE
  onUnknownExternalOutcome: RECONCILE_BEFORE_RETRY
  maxComputeBudgetRef: media.budget.standard
review:
  acceptance: required-where-source-policy-demands
  sourceReadback: required-for-business-effects
  publicationRef: governed-destination-on-approval
```

Compiler output must be versioned and validate exact storyboard/scene/voice/capture/provider bindings. It should record 16 narration occurrences when the chosen Gharbatai S01 plan declares 16—not assume a generated audio track proves each occurrence. Compare **configured voice, resolved/effective voice, and worker-produced voice identity**. Store audio alignment/durations from measured events and decoded output; verify the final encoded film, not just intermediate traces. Never store raw secrets or voice embeddings in YAML or project logs.

## 6. Exact existing Studio workspace mapping (13 planned pages)

Do not mint another top-level Studio UI or independent audio editor. Extend the existing proposed PDP2 workspace keys and PDP3 screen bindings through current design tokens/components/recipes:

| Existing page key | Major voice/video/media additions | Headless/keyboard counterpart |
|---|---|---|
| `project-library` | projects, reusable voice/style/asset kits, rights/license badges, offline projects | project/catalog queries |
| `production-planner` | inputs, audience, config compilation, style Skills, model and resource selection | validate plan + diff/decision output |
| `scene-storyboard` | scenes, script, per-scene voice, generative prompts, visual/shot plan | scene plan + typed inspect/replace |
| `source-review` | ingest, waveform/frames, scene detection, sample/enrollment consent, source readback | source integrity/probe/rights query |
| `multitrack-timeline` | all 52 edit kinds, linked audio/video/caption tracks, keys, trim and locks | exact edit commands and undo/redo |
| `captions-transcript` | ASR review, word alignment, translations, diarization, filler cleanup | transcript/caption revision edits |
| `narration-mixer` | voice profiles, TTS controls, multi-takes, cloning enrollment, stems, EQ/duck and loudness | synthesize/dub/mix/take-version intents |
| `camera-multiview` | simultaneous browser/camera/screens, pip, shot switch, synchronization | switch/render/source time mapping |
| `effects-inspector` | video/voice effects, motion, geometry, protected crop, color and image generation | typed effect/transform parameter edits |
| `interactive-authoring` | hotspots, choices, transcripts, branching, trusted interactions | signed branch graph edits |
| `quality-review` | source/QA comparisons, access, model/effect/voice truth, human approvals | typed checks, denials, attestations |
| `render-preview` | chosen codec/provider, resource estimates, sample renders, full output analysis | render candidates and report |
| `delivery` | version lock, captions/variants/interactive bundle, destination receipt, erasure state | governed publish/reconcile |

Reuse existing UI components and Shared tokens; add a component only when a required semantic interaction is absent. Accessible mouse/keyboard/text/CLI/API/SDK equivalents and truthful denied/unavailable/UNKNOWN states are required. Experience Explorer reads the same PDP0–3 source IDs and remains read-only `CONTRACT_PREVIEW`/`LOCAL_SIMULATION` until actual deployed evidence is available.

## 7. Runtime packaging and resource policy

- **Default permissive/offline path:** native OS/browser capture; WebAudio and WebCodecs on supported hosts; project editing/rendering in Ghatana semantics; WebM/Opus or other verified permissible codepaths; appropriate native OS encoder adapters where legal/available; mp4box.js as *mux only*; Whisper.cpp or sherpa-onnx STT; existing governed Piper/sherpa TTS and vetted voices; WaveSurfer and permissive DSP.
- **Voice acceleration tier:** optional 8–12 GB GPU class for admitted heavier speech models, with 16–24 GB preferred for complex multi-speaker dubbing. CPU light-model path remains functional; model registration and measured thresholds supersede hardware guesses.
- **Video generation tier:** optional GPUs, with 24 GB-class often necessary for fuller Wan2.2 pipelines; quantized and offloaded smaller profiles may run with less at higher latency and quality variability. Always expose CPU-only unavailability for heavy models without disabling capture/editor/export.
- **Isolation:** inference workers per engine/container/process, resource quotas, download hashes, offline inference policy; Media owns plan/attempt/finality, generic AI Inference owns reusable model-provider governance. Only approved external workers may receive bounded content with purpose, retention and egress policy.
- **Source/working set optimization:** store immutable original once, content-address derivatives scoped by tenant/policy, bounded preview proxies and waveform/thumbnail indexes, streaming or chunked rendering, per-scene selective invalidation, GC only after legal hold and active reference checks. Avoid storing duplicate encoded films as 'evidence'.
- **Export reality:** a permissive codebase cannot guarantee universal MP4/H.264 or codec parity. Perform codec/platform qualification; offer truthful export capability matrix and consented optional externally installed codec tools. Do not claim FFmpeg itself is strictly permissive.

## 8. Implementation plan — no fake Build entry or duplicate surfaces

The following tasks are *planning identifiers*; they are not new normative `media.*` requirement IDs or approvals. Integrate into the existing phase plans, source-based dependency graph, and `PBI-00…15` Build packages.

| Order | Package / where | Exact work | Falsifiable completion |
|---|---|---|---|
| M-00 | Current PDP0+source impact; `.product-experience` | Freeze exact new Voice/Video functional inventory; map all A–Q clusters to 462 existing capabilities and 84 Recorder clauses; classify true new meaning vs already covered; demand source-owning changes only where missing | 100% feature-to-capability and scope mapping; zero double authorities; source/phase-impact record |
| M-01 | PDP1 and contract registry | Extend voice profile rights, timed dubbing, generated asset provenance, audio DSP, infer selection and handback, media project edit and renderer profiles; reuse existing MediaProject, typed operations and 52 edits | Every newly required action has exact request/result/guard/denied/UNKNOWN/compare-and-swap; no imaginary public route |
| M-02 | PDP2/PDP3 + Explorer | Bind voice/gen/directing interactions to 13 planned workspaces and existing design chain; materialize source-dependent screens/actions, CLI/API/SDK-only no-GUI examples and exact scenarios | Every UI and non-UI intended flow traceable to one canonical action; source sync and a11y tested |
| M-03 | Source-current Discovery validation | Native YAML/parser and negative tests, topology; regenerate manifests from stable registry; validate four new artifact identities, 216 proposed cells and proper affected-phase currentness; source-bound owner review | Actual tests green with exact cut; Discovery PASS independently proven before Build entry; no reclassification by assertion |
| M-04 | Build host + typed APIs; `ghatana/services/media` while canonical | Implement minimal authenticated project/asset/job/operation vertical; parity between runtime and public clients | Real host readback, wrong-tenant denial, idempotency and unknown recovery demonstrated |
| M-05 | Capture adapters and Gharbatai integration | Existing scenario-v2/storyboard-v1 → sole compiled recording plan; rewire both entrypoints; qualify browser/CDP/desktop/API modes; preserve leases and seed ownership | One reproducible fully recorded demo with actual product readback and decoded final-video QA |
| M-06 | Voice / STT/TTS and AI Voice UI | Connect Whisper.cpp or sherpa, Piper and admitted complementary models; speech profile/consent, voice selection, narration segments, real streaming/takes, correct transcript timestamps, QC | No synthetic/degraded voice accepted as production; effective/worker voice identity and audible quality verified |
| M-07 | Media editing / Studio | Adapt permissive editor UI pieces to existing 52 typed ops and one immutable MediaProject; add waveform, manual lock, undo/redo and scene recapture | AI proposed edit → manual edit → save → reopen → render preserves semantics and exact committed revision |
| M-08 | Composition / renderer | Implement tested cross-platform render SPI; caption/audio, overlays, protected crop, audio DSP, color, effects, deterministic profile identity and container/codec qualification | Render accuracy and A/V sync; 16:9/9:16; truthful unsupported codec; no phantom FFmpeg admission |
| M-09 | Autonomous director | Script, rough cut, media classification/ranking, QA suggestions and reusable style Skills, typed agent tools, dry-run, diff, approvals | Agent uses same edit kernel and cannot bypass rights/version/manual lock or silently overwrite humans |
| M-10 | Generation and localization | Admitted text/image/video workers, model/version/seed provenance, speech translation/timed dub and optional authorized lip-sync | Local approved model or explicit unavailable; versioned outputs, per-scene regeneration, voice rights fail closed |
| M-11 | Interactive and publish | Bounded signed interactive graph, sandbox, offline capabilities, governed output/destination receipt | Player cannot execute privileged product command; publication UNKNOWN stays reconcilable |
| M-12 | Quality / observability / privacy | Real film, audio, codec, source, translation/caption, rights/PII and a11y QA with redacted traces and resource limits | Positive, malicious, stale, cancelled, exceeded budget, unavailable, UNKNOWN and replay tests pass |
| M-13 | Canonical source migration; MIG-04 | Verify runtime mirror differences, binary/API/DB/event compatibility, shadow admission and rollback; explicit owner approval | Only admitted cutover changes writer; source ownership not inferred from repo copy |
| M-14 | Incremental Build verification & dogfood | Qualify S01, then S02, then conditional F03; test production profiles on CPU/Apple/NVIDIA/Windows/Linux where relevant | Actually decoded film artifacts, exact source/voice/rights/QA receipts; independent film signoff distinct |
| M-15 | Delivery and closure independent stages | Finish applicable capability/operation/screen/consumer implementations and tests, native proofs after real runtime work | Build DEV_COMPLETE ≠ PDP native closure ≠ release; each requires independently supported result |

**Dependencies:** M-00→M-01→M-02→M-03 (Discovery); M-04/M-05 baseline, then speech M-06; M-07+M-08 yield a fully editable real recorded film; M-09/M-10 add high-value intelligence; M-11/M-12 and controlled M-13/M-14 verify; M-15 separately admits delivery. Blocks from one unavailable model must not mark unrelated workflows available or stall already-qualified CPU-first editing.

## 9. Experiment and quality protocols

1. **License provenance spike:** pin code commit/manifest lock; recursive SBOM; SPDX per copied file; redistribution requirements; enumerate binary/codec/voice/model/font/asset licenses; negative test GPL/AGPL/MPL/conditional/restricted intake to strict runtime. Zero silent dependencies. Include OpenReel FFmpeg and MediaBunny and Voicebox Pedalboard negative fixtures.
2. **Recorder proof:** compile Gharbatai scenario-v2 + storyboard-v1; capture S01 via actual admitted browser adapter; guarantee all declared narration occurrences; business-result readback; confirm final video decodes, timestamps, no unexplained black/silent tails, correct visible product state. Lease-correct cleanup of failed seed. No capture-stage bypass.
3. **Voice proof:** offline model discovery; synthesizer code and voice asset licenses; tested multiple languages on CPU and optional GPU; different voices across dialogue; diarization/transcription word alignment; re-synthesize only changed phrase while preserving manual take. Contrast configured/effective/worker voice identity.
4. **Editing proof:** import at least one 30–60 minute real capture, introduce all 52 kind discriminants across focused synthetic/real fixtures, keyboard/CLI/GUI parity, render/reopen semantic checksum, random edit/undo/redo sequences, stale version conflict, manual lock recapture proof. Compare video/audio output with source-timed acceptance thresholds.
5. **Codec and rendering proof:** report per OS/browser/encoder codec caps before export; large media, VFR and discontinuities, rational PTS, protected crop, high-DPI typography, captions locale/RTL, frame accurate transition/audio sync, deterministic profile fingerprint. Candidate thresholds must be selected per artifact profile and measured, not invented as passing facts.
6. **Generation proof:** verify model/license/weights hashes, no local missing GPU fallback to unapproved cloud, deterministic metadata/seed when supported, protected source content, deadlines and cancellation finality, stage checkpoints, scene DAG invalidation and resource quotas. Generated scenes must not pass as actual product-action evidence.
7. **Agent-security proof:** prompt injection through transcripts, downloaded clips, MCP arguments, YAML, captions, and rendered HTML cannot execute shell, mutate outside actor scope, access unrelated tenant data, publish without authorization, or bypass manual locks.
8. **Storage/reliability:** crash between render output and metadata commit, lease fencing, late provider results, UNKNOWN publish/erasure, duplicate idempotency and replay, worker restart, disk-full, outbox at-least-once and downstream ACK. Measure peak RSS/VRAM, p50/p95 times, output bitrates/storage amplification, tenant quotas and cost per minute by declared tier.
9. **Accessibility and product UX:** desktop/mobile/keyboard/screen reader/high zoom/reduced motion, text timecode/effects alternatives, not-fake-GUI contract for CLI/API-only content, 13 workspaces and embedded branching. Explorer must not masquerade as live product.

Use source-bound tests locally; do not require GitHub Actions for canonical authority. Qualified profiles include methodology, immutable environment/hardware/model/runtime digests, statistical uncertainty and observed outcomes. If a test is not executed, report `NOT_RUN` rather than an inferred PASS.

## 10. Key blockers / conflicts resolved by design

- **Contradictory phase status:** historical PDP0–3 DEV_COMPLETE on older source and October 17 successor definitions marked pending revalidation can both be true. Only the exact successor source-cut evaluation can promote new cells.
- **Runtime duplication:** code under `ghatana-media/modules` and `libs` is prepared mirror while `ghatana/services/media` is canonical. Do not publish competing services during planning or Build experiments.
- **Placeholder speech:** existing `TtsEngineFactory` can explicitly enable synthetic local/test fallback, emitting silence. `GovernedTtsEngine` refuses cloning for existing Piper composition. Placeholder `cloneVoice` in `PiperOnnxEngine` does not mean production cloning exists. Preserve truthful denial and implement real engines independently.
- **False license simplicity:** MIT application repository ≠ MIT runtime dependency graph. OpenReel uses MPL MediaBunny and FFmpeg WASM; Voicebox uses GPL Pedalboard. FFmpeg, MLT, Remotion and WanGP cannot automatically be declared permissive.
- **Export completeness under strict licenses:** baseline codecs vary by machine and OS. Specify the target export profile plus capability negotiation, no promise of universal MP4/H.264 without admitted encoder.
- **AI versus deterministic truth:** generative assets can be beautiful but are not evidence of business behavior. Preserve the exact verified recorder source/action receipt mapping.
- **Manual versus auto:** both share semantic operations; preserve manual locks against regeneration; zero destructive edits to immutable source.
- **Duplicate UI:** keep the 13 existing proposed pages and reuse the existing `@ghatana/ai-voice-ui-react` components; don't create an unrelated Voicebox UI/database.

## 11. Sources and review anchors

- [Ghatana Media repository](https://github.com/samujjwal/ghatana-media), [README](https://github.com/samujjwal/ghatana-media/blob/main/README.md), [BOUNDARY](https://github.com/samujjwal/ghatana-media/blob/main/BOUNDARY.md)
- [Recorder PDP0–2 coverage](https://github.com/samujjwal/ghatana-media/blob/main/docs/implementation/MEDIA-RECORDER-STUDIO-PDP0-2-SOURCE-COVERAGE-REVIEW-2026-10-17.md), [PDP3 successor](https://github.com/samujjwal/ghatana-media/blob/main/docs/implementation/MEDIA-RECORDER-STUDIO-PDP3-SUCCESSOR-EXECUTION-2026-10-17.md), [Build plan candidate](https://github.com/samujjwal/ghatana-media/blob/main/docs/implementation/MEDIA-BUILD-COMPLETE-PRODUCT-PLAN-2026-10-15.md)
- [VoiceStudio](https://github.com/debpalash/VoiceStudio), [Voicebox](https://github.com/jamiepine/voicebox), [OpenReel](https://github.com/Augani/openreel-video), [FireRed](https://github.com/FireRedTeam/FireRed-OpenStoryline), [Open-Generative-AI](https://github.com/anil-matcha/open-generative-ai), [OpenCut](https://github.com/OpenCut-app/OpenCut), [OpenChatCut](https://github.com/0xsline/OpenChatCut)
- [Sherpa-ONNX](https://github.com/k2-fsa/sherpa-onnx), [Whisper.cpp](https://github.com/ggml-org/whisper.cpp), [Chatterbox](https://github.com/resemble-ai/chatterbox), [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS), [Diffusers](https://github.com/huggingface/diffusers)
- [WaveSurfer](https://github.com/katspaugh/wavesurfer.js), [PySceneDetect](https://github.com/Breakthrough/PySceneDetect), [OpenTimelineIO](https://github.com/AcademySoftwareFoundation/OpenTimelineIO), [OpenColorIO](https://github.com/AcademySoftwareFoundation/OpenColorIO), [mp4box.js](https://github.com/gpac/mp4box.js), [Rubato](https://github.com/HEnquist/rubato), [RNNoise](https://github.com/xiph/rnnoise), [Pedalboard GPL notice](https://github.com/spotify/pedalboard)

**Final disposition:** `UNIFIED_ARCHITECTURE_PROPOSED_REQUIRES_SOURCE_CURRENT_DISCOVERY_AND_PROVIDER_ADMISSION`. This blueprint specifies full feature intent and a bounded execution path; it neither modifies repository source nor asserts native validation, film qualification, model admission, code migration, or release success.

---

## 12. Controlling second-pass audit (October 17, 2026)

**This section supersedes narrower prioritization and license assumptions above when there is a conflict.** Earlier chapters are retained rather than dropping feature decisions. The accompanying machine-readable inventory has **audit-local IDs only**; no `media.*` canonical PDP IDs, actual public routes, installed dependencies, runtime implementation claims, or approvals were manufactured.

**Audit denominator:** **428 atomic proposed feature checks across 22 domains**, with 102 newly explicit features, 80 needing finer contract/acceptance treatment, and 246 previously described at least at cluster level. These counts describe the *review inventory*, **not** accepted PDP obligations, implementation or end-to-end tests. Actual mapping to Media's source-owned capabilities and 52 typed edit operations remains mandatory.

**Repository observation:** `samujjwal/ghatana-media/main@fd7992d890e904f5276a68114be989ea2fcb11b5`; existing four logical Recorder/Studio surfaces, 84 successor acceptance clauses, 52 typed manual edit kinds, 13 proposed pages, 47 legacy screens, and planned 216 successor PDP cells. Preserve `ghatana/services/media` as sole production runtime until admitted MIG-04. Existing React AI Voice package is host-dependent only; existing Piper/Whisper factories have truthful synthetic fallbacks and `GovernedTtsEngine` denies cloning. These are source readbacks, not executed runtime qualification.

### 12.1 SOTA capability deltas that were insufficiently explicit

| Scope | Newly explicit capabilities | Reference sources | Canonical integration rule |
|---|---|---|---|
| A. Generation as filmmaking | Joint synchronized video+audio, lip-synced dialogue, video extension, multi-reference image selection/ordering, start+end conditioning, cinematographic lens/motion controls, character identity continuity, region-local revision, performance-driven motion. | Kandinsky 6.0 MIT; Open-Generative-AI; Wan2.2; Runway; MuseTalk; LTX capability reference. | Prefer checkpoint-qualified Kandinsky/Wan engines, record exact audio/video clock and source/voice/rights, no real-product evidence substitution. |
| B. Visual intelligence | SAM2 video segmentation, temporal tracking, face-safe captions, motion-aware overlay free-space placement, pose/depth and object masks, video stabilization, temporal flicker and optical flow. | OpenChatCut; SAM2; DaVinci Resolve. | Typed region/time model, per-frame protected crop tests, review/uncertainty paths. |
| C. Voice beyond ordinary TTS | Multiengine expressive emotion tags, prompt-directed voice design, local voice personalities (compose/rewrite/respond), full-duplex agent voice, cloned speaker continuity, pronunciation lexicon, overlap diarization, OS-wide dictation. | Voicebox; VoiceStudio; CosyVoice; Qwen3-TTS. | Speech-provider capability discriminants, exact voice identity/readback and consent, no blind fallback. |
| D. Lip sync and video dubbing | Real permissive engine candidates MuseTalk and LatentSync, portrait-to-video animation, video-to-video lip sync, speech-to-speech style-preserving translation, locale text-length retiming. | MuseTalk; LatentSync; VoiceStudio; Open-Generative-AI. | Independent model/dependency + likeness permission audit; A/V sync, jitter and face identity QA. |
| E. Professional finishing | Scopes, ACES/HDR/10-bit color, optical flow, 5.1/immersive audio, ADR/Foley, sound design, full project interchange, review comments and timecode navigation. | DaVinci Resolve; OpenReel; OTIO; Descript. | Qualified hardware/codec/color modes; editable common MediaProject; output decode/QC. |
| F. Sound and music | Text-to-music, SFX/Foley generation, adaptive score, beat grid, rights-aware library, stem remixing, lyric re-painting, singing, watermark/similarity checks. | ACE-Step MIT; HeartMuLa Apache; Open-Generative-AI; OpenChatCut; AudioCraft noncommercial weights for reference. | Admit pinned ACE-Step/HeartMuLa candidates after model/weights/license/rights QA; no noncommercial model embedded. |
| G. Studio UX and agent parity | Full headless typed editing vocabulary (OpenReel 228-tool reference, no copied-count target), custom motion shaders sandbox, edit diff approval, visual workflow editor, agent story skills, platform-ready variants and review links. | OpenReel; OpenChatCut; FireRed; Screen Studio; Descript. | Same typed operations for human, agent, CLI/API/SDK; UI projects from canonical revision; isolate non-permissive dependencies. |
| H. Trust and authenticity | C2PA signed manifests, source action-vs-illustration distinction, immutable generation/checkpoint/voice lineage, watermark detection, legal hold, deepfake voice/likeness rights. | C2PA SDK; Media policy; Chatterbox; VoiceStudio. | Signed decoded output lineage, consent/purpose gates, fail-closed public release and reviewable UNKNOWN. |
| I. Reliability / hardware | On-device model inventory/cleanup, GPU discovery, per-feature execution budgets, CPU fallback without synthetic semantics, editor proxy generation and incremental recompute, constrained streaming. | Voicebox; VoiceStudio; OpenReel; Media. | Actual CPU/Apple Silicon/CUDA/Windows/Linux matrix and model/codec profile; storage amplification budgets. |

### 12.2 The feature parity acceptance claim

Do not declare “all state-of-the-art features supported” based on prose or repository stars. A realistic versioned coverage claim is **COMPLETE_FOR_SELECTED_REFERENCE_BASELINES** only when all surveyed source features map to (a) one canonical media capability/operation, (b) a capability-specific denied/unavailable case, or (c) a narrowly accepted inapplicability reason. Every mapped feature then has a supported GUI/headless path and real-runtime evidence if advertised. A future source/model update is a bounded material-change analysis, not reason to reopen unaffected closed surfaces.

### 12.3 The full 22-domain atomic feature audit

The companion JSON carries stable **audit-local** keys, owning surface proposals, upstream influence, reuse strategy, mapping-needed status and minimum acceptance family per feature. Summary:

| Audit domain | Audit features | New explicit | Expand explicitness | Existing broad coverage | Proposed logical owner |
|---|---:|---:|---:|---:|---|
| `SPEC` — Declarative specification and creative orchestration | 20 | 3 | 9 | 8 | `media.surface.recorder-orchestrator` |
| `CAP` — Capture, software demonstrations and live sources | 28 | 6 | 7 | 15 | `media.surface.capture-adapters` |
| `ASSET` — Assets, library and project organization | 19 | 3 | 7 | 9 | `media.surface.production-studio` |
| `EDIT` — Professional multitrack timeline and manual editing | 28 | 6 | 2 | 20 | `media.surface.production-studio` |
| `COLOR` — Color management and professional picture finishing | 17 | 9 | 5 | 3 | `media.surface.production-studio` |
| `ASR` — Speech recognition, dictation and understanding | 20 | 4 | 2 | 14 | `media.surface.production-studio` |
| `TTS` — Speech synthesis and expressive voice production | 24 | 4 | 4 | 16 | `media.surface.production-studio` |
| `CLONE` — Rights-governed voice identity, cloning and watermark | 17 | 1 | 5 | 11 | `media.surface.production-studio` |
| `DUB` — Multilingual localization and speaker-consistent dubbing | 17 | 3 | 3 | 11 | `media.surface.production-studio` |
| `DSP` — Audio editing, DSP, cleanup and spatial sound | 20 | 7 | 0 | 13 | `media.surface.production-studio` |
| `MUSIC` — Music and sound-effect creation/selection | 15 | 9 | 1 | 5 | `media.surface.production-studio` |
| `GEN` — Image/video multimodal generative studio | 28 | 9 | 6 | 13 | `media.surface.production-studio` |
| `VISION` — Video intelligence, spatial analysis and auto-composition | 18 | 6 | 3 | 9 | `media.surface.production-studio` |
| `MOTION` — Motion graphics, graphics, 3D and interactive animation | 16 | 7 | 1 | 8 | `media.surface.production-studio` |
| `DIRECT` — Agent-driven creative direction and automated editing | 21 | 3 | 4 | 14 | `media.surface.recorder-orchestrator` |
| `SOCIAL` — Marketing, creator distribution and derivative formats | 14 | 7 | 2 | 5 | `media.surface.production-studio` |
| `INTER` — Interactive video, education and access | 11 | 0 | 3 | 8 | `media.surface.interactive-demo-player` |
| `COLLAB` — Collaborative editing, approval and organizational workflows | 13 | 4 | 5 | 4 | `media.surface.production-studio` |
| `DELIV` — Rendering, encoding, packaging, and media interoperability | 24 | 6 | 3 | 15 | `media.surface.production-studio` |
| `QA` — Professional media quality evaluation and acceptance | 17 | 3 | 2 | 12 | `media.surface.production-studio` |
| `TRUST` — Rights, provenance, identity, privacy and responsible media | 19 | 1 | 3 | 15 | `media.surface.recorder-orchestrator` |
| `OPS` — Local-first model/resource management and runtime operations | 22 | 1 | 3 | 18 | `media.surface.recorder-orchestrator` |

The original 52 **manual edit kinds are preserved**. A new feature need not create a 53rd kind: model execution, source ingestion, renderer qualification, lip sync, music synthesis and collaboration may be existing typed Media operations/asset projections, not editor mutations. Add a PDP-1 kind only if behavior cannot be expressed safely as an existing semantic operation with new validated parameters.

### 12.4 Source-preserving atomic feature index (all candidates)

Each feature here is an audit target, **not** a second PDP requirement. `B` means covered at least at cluster level in the first blueprint, `E` means the existing concept needs an exact typed contract/acceptance case, and `N` means newly explicit in this review. None of these codes means implemented, tested or approved. For owner proposals and admission fields consult the JSON audit; bind to actual source-owned Media identifiers before treating it as a product obligation.

#### `SPEC` — Declarative specification and creative orchestration

| Audit-local ID | Feature | Prior review status |
|---|---|---|
| `AUD-SPEC-001` | Versioned YAML and JSON production specifications | `B` |
| `AUD-SPEC-002` | Production-specific schema validation and migrations | `E` |
| `AUD-SPEC-003` | Typed semantic compilation into existing MediaProject plan | `B` |
| `AUD-SPEC-004` | One source and scene dependency DAG | `B` |
| `AUD-SPEC-005` | Asset/model/provider pin and rights snapshot | `B` |
| `AUD-SPEC-006` | Versioned visual recipe and brand kit | `B` |
| `AUD-SPEC-007` | Versioned voice and pronunciation style recipe | `E` |
| `AUD-SPEC-008` | Preflight preview with predicted cost and render time | `E` |
| `AUD-SPEC-009` | Compile-time deterministic vs generative step typing | `E` |
| `AUD-SPEC-010` | Visual node-based workflow authoring mapped to same DAG | `N` |
| `AUD-SPEC-011` | Reusable agent/director skills with reviewable dependencies | `E` |
| `AUD-SPEC-012` | Audience/campaign intent to scene graph templates | `E` |
| `AUD-SPEC-013` | Automatic output variants by audience, locale and device | `E` |
| `AUD-SPEC-014` | Multi-reference production briefs with ranked constraints | `N` |
| `AUD-SPEC-015` | Scene-level version/patch application and merge | `E` |
| `AUD-SPEC-016` | Controlled fallback/abstention policy in recipe | `B` |
| `AUD-SPEC-017` | Fully headless API/CLI product with no fabricated GUI | `B` |
| `AUD-SPEC-018` | Structured input-to-output provenance manifest | `B` |
| `AUD-SPEC-019` | Budget-aware low/high quality pipeline selection | `E` |
| `AUD-SPEC-020` | Reusable user-configurable action/quality rules | `N` |

#### `CAP` — Capture, software demonstrations and live sources

| Audit-local ID | Feature | Prior review status |
|---|---|---|
| `AUD-CAP-001` | Browser tab and web page capture | `B` |
| `AUD-CAP-002` | Desktop window and full-screen capture | `B` |
| `AUD-CAP-003` | Multimonitor source selection and region capture | `E` |
| `AUD-CAP-004` | Webcam/presenter camera and microphone input | `B` |
| `AUD-CAP-005` | System audio and external audio interface recording | `E` |
| `AUD-CAP-006` | Mobile emulator and physical device capture | `B` |
| `AUD-CAP-007` | Presenter teleprompter synchronized with scene/narration cue | `N` |
| `AUD-CAP-008` | Camera and screen picture-in-picture recording | `B` |
| `AUD-CAP-009` | Terminal command/CLI-only scenario recording | `B` |
| `AUD-CAP-010` | API/gRPC/event-only experience documentation | `B` |
| `AUD-CAP-011` | Remote contributor and WebRTC capture paths | `N` |
| `AUD-CAP-012` | Live stream capture and live caption ingest | `N` |
| `AUD-CAP-013` | Multicamera clock sync and clapper marker | `E` |
| `AUD-CAP-014` | Active-speaker-aware automatic multicam cut proposals | `N` |
| `AUD-CAP-015` | Source capability probe and codec consent gating | `B` |
| `AUD-CAP-016` | Pointer trajectories with deterministic interpolation | `E` |
| `AUD-CAP-017` | Auto zoom/focus on verified click/typed action | `B` |
| `AUD-CAP-018` | Smooth cursor movement, scale and idle hiding | `N` |
| `AUD-CAP-019` | Post-capture cursor editing and loopable cursor return | `N` |
| `AUD-CAP-020` | Mouse/keyboard overlay and keystroke privacy masking | `E` |
| `AUD-CAP-021` | Protected product text/logo UI reframe rules | `B` |
| `AUD-CAP-022` | Aspect-safe automatic framing for portrait/landscape | `B` |
| `AUD-CAP-023` | Scene-only recapture/retry preserving previous asset | `B` |
| `AUD-CAP-024` | Seed owner/lease fencing and cleanup | `B` |
| `AUD-CAP-025` | Action effect readback versus mere click success | `B` |
| `AUD-CAP-026` | Black-frame/silent-tail and VFR discontinuity detection | `E` |
| `AUD-CAP-027` | Audio/video clock drift correction with uncertainty | `E` |
| `AUD-CAP-028` | Capture failure safe resume and scene ownership receipts | `B` |

#### `ASSET` — Assets, library and project organization

| Audit-local ID | Feature | Prior review status |
|---|---|---|
| `AUD-ASSET-001` | Drag/drop and batch ingest with MIME sniffs | `B` |
| `AUD-ASSET-002` | Immutable source asset hashes and versions | `B` |
| `AUD-ASSET-003` | Media library bins and nested source folders | `B` |
| `AUD-ASSET-004` | Tag/search by timeline, person, scene, speaker | `E` |
| `AUD-ASSET-005` | AI search on authorized semantic transcripts | `E` |
| `AUD-ASSET-006` | Smart bins by actor, scene, camera and subject | `N` |
| `AUD-ASSET-007` | Auto-generated thumbnail/contact sheet | `B` |
| `AUD-ASSET-008` | Low-resolution proxy and original linkage | `B` |
| `AUD-ASSET-009` | Metadata and license-filtered online asset search | `B` |
| `AUD-ASSET-010` | Source rights, geographic and audience scope | `B` |
| `AUD-ASSET-011` | Media technical metadata, tracks and color info | `E` |
| `AUD-ASSET-012` | Sidecar and embedded caption import/export | `B` |
| `AUD-ASSET-013` | Production-grade SMPTE drop-frame/non-drop-frame timecode handling | `N` |
| `AUD-ASSET-014` | Linked external/source file relink and integrity check | `E` |
| `AUD-ASSET-015` | Audio take/reference-voice source catalog | `E` |
| `AUD-ASSET-016` | Content-addressed bounded derivative cache | `B` |
| `AUD-ASSET-017` | Project snapshot and full backup/portable bundle | `E` |
| `AUD-ASSET-018` | Semantic duplicates and near-duplicate detection | `N` |
| `AUD-ASSET-019` | Per-asset QC and quarantined suspicious input | `E` |

#### `EDIT` — Professional multitrack timeline and manual editing

| Audit-local ID | Feature | Prior review status |
|---|---|---|
| `AUD-EDIT-001` | All 52 existing PDP-1 edit-kind discriminants | `B` |
| `AUD-EDIT-002` | Multitrack video/audio/caption/overlay layers | `B` |
| `AUD-EDIT-003` | Trim roll slip slide ripple and split editing | `B` |
| `AUD-EDIT-004` | Nested sequences and linked clips | `B` |
| `AUD-EDIT-005` | Snap, markers, track grouping and frame-level navigation | `B` |
| `AUD-EDIT-006` | Keyframe animation, easing and curve graph editing | `B` |
| `AUD-EDIT-007` | Clip/track mute solo lock and effects bypass | `B` |
| `AUD-EDIT-008` | Nondestructive source originals, per-operation undo/redo | `B` |
| `AUD-EDIT-009` | Precision timecode entry and media source in/out range | `B` |
| `AUD-EDIT-010` | Audio waveform, thumbnails and source monitor | `B` |
| `AUD-EDIT-011` | Live playback JKL transport, shuttle and shortcuts | `N` |
| `AUD-EDIT-012` | Track height/visibility/workspace layout personalization | `N` |
| `AUD-EDIT-013` | Freeze frame and reverse playback | `N` |
| `AUD-EDIT-014` | Optical-flow and motion-compensated slow motion | `N` |
| `AUD-EDIT-015` | Automatic subject-safe smart reframe | `B` |
| `AUD-EDIT-016` | Masking and matte compositing | `B` |
| `AUD-EDIT-017` | Picture-in-picture and synchronized multicamera | `B` |
| `AUD-EDIT-018` | Adjustment layers and reusable effect stacks | `N` |
| `AUD-EDIT-019` | Editable titles, captions and motion templates | `B` |
| `AUD-EDIT-020` | Deterministic manual lock preservation on regeneration | `B` |
| `AUD-EDIT-021` | Agent-made changes remain editable project commands | `B` |
| `AUD-EDIT-022` | Diff, dry-run, approval and rollback of agent edits | `B` |
| `AUD-EDIT-023` | Semantic three-way merge of conflicting revisions | `B` |
| `AUD-EDIT-024` | Keyboard/text equivalents for graphical controls | `B` |
| `AUD-EDIT-025` | Batch edits and parameter-copy/paste presets | `N` |
| `AUD-EDIT-026` | Reusable project sequence templates and styles | `B` |
| `AUD-EDIT-027` | Timeline auto-backup and crash recovery | `E` |
| `AUD-EDIT-028` | Proxy/full-quality preview switch at exact positions | `E` |

#### `COLOR` — Color management and professional picture finishing

| Audit-local ID | Feature | Prior review status |
|---|---|---|
| `AUD-COLOR-001` | Exposure, contrast, white balance and saturation | `B` |
| `AUD-COLOR-002` | Lift gamma gain/color wheels and curves | `E` |
| `AUD-COLOR-003` | HSL secondary corrections and LUT preview | `E` |
| `AUD-COLOR-004` | Shot-to-shot automatic color matching | `B` |
| `AUD-COLOR-005` | OpenColorIO color-managed scene/display transforms | `B` |
| `AUD-COLOR-006` | Scopes: waveform, vectorscope, histogram | `N` |
| `AUD-COLOR-007` | ACES-compatible config and export transforms | `N` |
| `AUD-COLOR-008` | 10/12-bit internal data path when supported | `N` |
| `AUD-COLOR-009` | HDR/PQ/HLG explicit profile/capability negotiation | `N` |
| `AUD-COLOR-010` | Color-safe subtitle and skin tone reference | `N` |
| `AUD-COLOR-011` | Chroma key spill suppression and edge cleanup | `E` |
| `AUD-COLOR-012` | Virtual background/green-screen replacement with explicit subject mask | `E` |
| `AUD-COLOR-013` | Lens distortion, rolling-shutter and vignette correction | `N` |
| `AUD-COLOR-014` | Flicker and temporal noise reduction | `N` |
| `AUD-COLOR-015` | Stabilization and auto horizon correction | `N` |
| `AUD-COLOR-016` | AI super-resolution/sharpen with model truth | `N` |
| `AUD-COLOR-017` | Human-readable visual comparison view | `E` |

#### `ASR` — Speech recognition, dictation and understanding

| Audit-local ID | Feature | Prior review status |
|---|---|---|
| `AUD-ASR-001` | Offline ASR transcription and local model routing | `B` |
| `AUD-ASR-002` | Streaming ASR with partial/final update semantics | `B` |
| `AUD-ASR-003` | Voice activity detection and silence segmentation | `B` |
| `AUD-ASR-004` | Language recognition and mixed-language segments | `B` |
| `AUD-ASR-005` | Word-level alignment and correction | `B` |
| `AUD-ASR-006` | Speaker diarization and overlapped speech detection | `B` |
| `AUD-ASR-007` | Speaker labeling and assignment revision | `B` |
| `AUD-ASR-008` | Dictation push-to-talk and persistent toggled mode | `B` |
| `AUD-ASR-009` | OS-wide dictation insertion with accessibility safeguards | `N` |
| `AUD-ASR-010` | ASR-assisted filler word and retake detection | `B` |
| `AUD-ASR-011` | Transcript-based ripple edit and pause shortening | `B` |
| `AUD-ASR-012` | Custom glossary and correction dictionary | `E` |
| `AUD-ASR-013` | Per-word confidence and review queues | `B` |
| `AUD-ASR-014` | Retiming transcripts when video edits change | `B` |
| `AUD-ASR-015` | Semantic search through recorded material | `B` |
| `AUD-ASR-016` | Speech-to-text API, MCP and real-time events | `B` |
| `AUD-ASR-017` | Source microphone recording + transcript paired archive | `N` |
| `AUD-ASR-018` | Low-latency streaming interpretation with partial translated captions | `N` |
| `AUD-ASR-019` | Punctuation, capitalization and local LLM cleanup | `E` |
| `AUD-ASR-020` | Non-speech sound segmentation and event detection | `N` |

#### `TTS` — Speech synthesis and expressive voice production

| Audit-local ID | Feature | Prior review status |
|---|---|---|
| `AUD-TTS-001` | Preset voice library and search | `B` |
| `AUD-TTS-002` | Multiple approved TTS engines and per-job selection | `B` |
| `AUD-TTS-003` | Voice profile versions and language support | `B` |
| `AUD-TTS-004` | Voice design via descriptive style instructions | `B` |
| `AUD-TTS-005` | Prosody, speaking rate, pitch, emphasis and pauses | `B` |
| `AUD-TTS-006` | Expressive styles and paralinguistic tags per model | `B` |
| `AUD-TTS-007` | Pronunciation lexicon/IPA and name override | `B` |
| `AUD-TTS-008` | SSML-like structured text authoring | `B` |
| `AUD-TTS-009` | Per-sentence and paragraph takes with A/B playback | `B` |
| `AUD-TTS-010` | Long-form sentence chunking and crossfade alignment | `B` |
| `AUD-TTS-011` | Audiobook chapter, paragraph and M4B metadata | `B` |
| `AUD-TTS-012` | Multi-speaker Stories and podcast production | `B` |
| `AUD-TTS-013` | Context continuity between segments | `E` |
| `AUD-TTS-014` | Narrator casting by locale, intended style and rights | `E` |
| `AUD-TTS-015` | Streaming TTS with bounded audio chunk backpressure | `B` |
| `AUD-TTS-016` | Source text with inline pronunciation and mood markers | `E` |
| `AUD-TTS-017` | Per-voice personality compose/rewrite/respond (local LLM) | `N` |
| `AUD-TTS-018` | Voice-driven agent response / full duplex voice loop | `N` |
| `AUD-TTS-019` | Realtime consented voice conversion with effective-voice verification | `N` |
| `AUD-TTS-020` | Side-by-side voice quality/cost/latency comparisons | `N` |
| `AUD-TTS-021` | Per-voice audio effects chain and reusable presets | `B` |
| `AUD-TTS-022` | Remote worker with pinned model and asset provenance | `B` |
| `AUD-TTS-023` | Incremental regeneration of affected phrase only | `B` |
| `AUD-TTS-024` | Prompt/voice controls do not silently change effective model | `E` |

#### `CLONE` — Rights-governed voice identity, cloning and watermark

| Audit-local ID | Feature | Prior review status |
|---|---|---|
| `AUD-CLONE-001` | Consent-backed speaker voice enrollment | `B` |
| `AUD-CLONE-002` | Reference sample audio quality and rights QC | `B` |
| `AUD-CLONE-003` | Zero-shot voice clone using admitted weights | `B` |
| `AUD-CLONE-004` | Optional tuned/fine-tuned voice model | `B` |
| `AUD-CLONE-005` | Speaker profile encrypted embedding reference | `B` |
| `AUD-CLONE-006` | Synthetic voice design without human reference | `B` |
| `AUD-CLONE-007` | Speaker similarity and identity-consistency checks | `B` |
| `AUD-CLONE-008` | Cloned voice usage purpose and expiration constraints | `B` |
| `AUD-CLONE-009` | Profile deletion and provider erasure request tracking | `B` |
| `AUD-CLONE-010` | Voice cloning impersonation/age protections | `B` |
| `AUD-CLONE-011` | Embedded synthetic speech watermark when qualified | `B` |
| `AUD-CLONE-012` | Watermark recognition, stripping analysis and robustness test | `E` |
| `AUD-CLONE-013` | Output disclosure and provenance / content credentials | `E` |
| `AUD-CLONE-014` | Consent revocation propagates to derived assets policy | `E` |
| `AUD-CLONE-015` | Prevent user-supplied model from silently changing identity | `E` |
| `AUD-CLONE-016` | Protected public figure and consent-sensitive requests review | `E` |
| `AUD-CLONE-017` | Consent-backed talking-avatar persona and likeness enrollment | `N` |

#### `DUB` — Multilingual localization and speaker-consistent dubbing

| Audit-local ID | Feature | Prior review status |
|---|---|---|
| `AUD-DUB-001` | Multilingual transcript translation with reviewed terminology | `B` |
| `AUD-DUB-002` | Translation memory, brand glossary and do-not-translate | `E` |
| `AUD-DUB-003` | Speaker-to-voice correspondence across languages | `B` |
| `AUD-DUB-004` | Timed speech synthesis and segment gap handling | `B` |
| `AUD-DUB-005` | Forced alignment and time-stretch with constraint reporting | `B` |
| `AUD-DUB-006` | Speech-to-speech voice style transfer where licensed | `N` |
| `AUD-DUB-007` | Room tone/music/noise preservation and speech isolation | `B` |
| `AUD-DUB-008` | Lip synchronization of permitted existing video | `B` |
| `AUD-DUB-009` | Portrait-to-speaking-video from authorized source | `N` |
| `AUD-DUB-010` | Audio/video translation variant QA by locale | `B` |
| `AUD-DUB-011` | Subtitle/closed caption multilingual rendering | `B` |
| `AUD-DUB-012` | RTL, Devanagari and CJK typography correctness | `B` |
| `AUD-DUB-013` | Voice consistency despite localized text-length changes | `E` |
| `AUD-DUB-014` | Per-scene retake/resynthesis and A/B locale comparisons | `B` |
| `AUD-DUB-015` | Simultaneous translated speech-to-speech conversation when admitted | `N` |
| `AUD-DUB-016` | Burned and sidecar language variant outputs | `B` |
| `AUD-DUB-017` | Foreign media voice replacement origin disclosure | `E` |

#### `DSP` — Audio editing, DSP, cleanup and spatial sound

| Audit-local ID | Feature | Prior review status |
|---|---|---|
| `AUD-DSP-001` | Waveform and phrase-based audio editor | `B` |
| `AUD-DSP-002` | Multitrack mix bus, send and per-track controls | `B` |
| `AUD-DSP-003` | Gain, panning, fade and automation curves | `B` |
| `AUD-DSP-004` | Parametric EQ and high/low pass filtering | `B` |
| `AUD-DSP-005` | Dynamic compression, expansion and limiting | `B` |
| `AUD-DSP-006` | De-esser and dialogue frequency cleanup | `B` |
| `AUD-DSP-007` | Delay, chorus, flanger and reverb effects | `B` |
| `AUD-DSP-008` | Noise reduction with model and residual QA | `B` |
| `AUD-DSP-009` | De-reverberation and hum removal | `N` |
| `AUD-DSP-010` | Acoustic echo cancellation for microphone recording | `N` |
| `AUD-DSP-011` | Vocal/music/stem separation and re-mix | `B` |
| `AUD-DSP-012` | Per-track auto-ducking of music under speech | `B` |
| `AUD-DSP-013` | Resample, stretch, pitch shift with artifact checks | `B` |
| `AUD-DSP-014` | Sample-accurate speech edit and crossfade | `N` |
| `AUD-DSP-015` | EBU R128 / LUFS integrated loudness and true peak | `B` |
| `AUD-DSP-016` | Stereo and 5.1 surround when admitted | `N` |
| `AUD-DSP-017` | Immersive/ambisonic audio when admitted | `N` |
| `AUD-DSP-018` | ADR, Foley and room tone recording/editing | `N` |
| `AUD-DSP-019` | Preset and user-defined effect chains | `B` |
| `AUD-DSP-020` | External VST/LV2 plugin host only if permissible and sandboxed | `N` |

#### `MUSIC` — Music and sound-effect creation/selection

| Audit-local ID | Feature | Prior review status |
|---|---|---|
| `AUD-MUSIC-001` | Licensed music catalog import with attribution | `B` |
| `AUD-MUSIC-002` | Royalty/territory/provenance audit per track | `E` |
| `AUD-MUSIC-003` | Beat grid, downbeat and tempo detection | `B` |
| `AUD-MUSIC-004` | Sync cut points and transitions to music | `B` |
| `AUD-MUSIC-005` | AI text-to-music creation where weights permit | `N` |
| `AUD-MUSIC-006` | Text-to-sound-effect and Foley generation where permitted | `N` |
| `AUD-MUSIC-007` | Music remix and style variants | `N` |
| `AUD-MUSIC-008` | Localized lyrics repainting and music-inpainting from exact source region | `N` |
| `AUD-MUSIC-009` | Loopable soundtracks with intro/outro edits | `N` |
| `AUD-MUSIC-010` | Music stem separation and replacement | `B` |
| `AUD-MUSIC-011` | Singing voice synthesis and melody-conditioned vocal generation when admitted | `N` |
| `AUD-MUSIC-012` | Reference-audio conditioned music cover generation with rights/reuse checks | `N` |
| `AUD-MUSIC-013` | Adaptive soundtrack duration/energy from scene structure | `N` |
| `AUD-MUSIC-014` | Copyright fingerprint / potentially infringing similarity review | `N` |
| `AUD-MUSIC-015` | Background music speech ducking | `B` |

#### `GEN` — Image/video multimodal generative studio

| Audit-local ID | Feature | Prior review status |
|---|---|---|
| `AUD-GEN-001` | Text-to-image and image-to-image generation | `B` |
| `AUD-GEN-002` | Image edit, inpaint, outpaint and generative fill | `B` |
| `AUD-GEN-003` | Background removal, replacement and subject isolate | `B` |
| `AUD-GEN-004` | Image super-resolution and restoration | `B` |
| `AUD-GEN-005` | Text-to-video generation from approved model | `B` |
| `AUD-GEN-006` | Image-to-video animation from frame reference | `B` |
| `AUD-GEN-007` | Video-to-video stylization and transformation | `B` |
| `AUD-GEN-008` | Multi-image reference conditioning with order/weight | `N` |
| `AUD-GEN-009` | First/last-frame video interpolation and editing | `B` |
| `AUD-GEN-010` | Video extension and scene continuation | `N` |
| `AUD-GEN-011` | Video masked-object replacement and targeted retake | `E` |
| `AUD-GEN-012` | Temporal/character/brand consistency constraints | `E` |
| `AUD-GEN-013` | Camera/lens/focal length/motion direction controls | `N` |
| `AUD-GEN-014` | Synchronized audio-video joint generation where licensed | `N` |
| `AUD-GEN-015` | Native dialogue and sound effects generation aligned to lip motion | `N` |
| `AUD-GEN-016` | Audio-driven video/character animation | `E` |
| `AUD-GEN-017` | Performance/motion reference conditioning | `E` |
| `AUD-GEN-018` | Multiple candidate generations and ranking | `E` |
| `AUD-GEN-019` | Seed, sampler, aspect/resolution and model parameters | `B` |
| `AUD-GEN-020` | Text-to-motion and reference style recreation | `N` |
| `AUD-GEN-021` | Photorealistic and stylized render presets | `B` |
| `AUD-GEN-022` | Cost-aware provider capability routing and fallback | `B` |
| `AUD-GEN-023` | Model-local offline generation and GPU memory warnings | `B` |
| `AUD-GEN-024` | Permissive and hosted provider separation | `B` |
| `AUD-GEN-025` | Generation history and reusable parameter settings | `N` |
| `AUD-GEN-026` | Persona/appearance recast only with subject authorization | `N` |
| `AUD-GEN-027` | Prompts/masks per shot and timeline keyframe anchors | `E` |
| `AUD-GEN-028` | Motion brush and region-trajectory conditioning for video motion | `N` |

#### `VISION` — Video intelligence, spatial analysis and auto-composition

| Audit-local ID | Feature | Prior review status |
|---|---|---|
| `AUD-VISION-001` | Shot/scene and transition detection | `B` |
| `AUD-VISION-002` | Object/person/face and region detection | `B` |
| `AUD-VISION-003` | Multiframe subject tracking and re-identification | `B` |
| `AUD-VISION-004` | Video segmentation with SAM2-like mask persistence | `N` |
| `AUD-VISION-005` | Face-safe caption region planning and safe zones | `N` |
| `AUD-VISION-006` | Automatic free-space overlay placement | `N` |
| `AUD-VISION-007` | Smart portrait/landscape reframe with temporal tracking | `B` |
| `AUD-VISION-008` | Text/logo/UI protected crop and placement | `B` |
| `AUD-VISION-009` | Camera stabilization and motion analysis | `N` |
| `AUD-VISION-010` | Human pose/hand/keypoint and depth control maps | `N` |
| `AUD-VISION-011` | OCR source text via admitted Document Intelligence | `B` |
| `AUD-VISION-012` | Source-aware matching of soundtrack to visible action | `E` |
| `AUD-VISION-013` | Visual content search by embedding and metadata | `E` |
| `AUD-VISION-014` | Video continuity/scene consistency check | `B` |
| `AUD-VISION-015` | Quality degradation/blur/black-tail detection | `B` |
| `AUD-VISION-016` | Copyright/identity/PII-sensitive face detection guard | `E` |
| `AUD-VISION-017` | Auto highlight and memorable clip scoring | `B` |
| `AUD-VISION-018` | Eye-contact/gaze correction as disclosed non-source-grounded visual effect | `N` |

#### `MOTION` — Motion graphics, graphics, 3D and interactive animation

| Audit-local ID | Feature | Prior review status |
|---|---|---|
| `AUD-MOTION-001` | 2D vector shapes, masks, gradients and filters | `B` |
| `AUD-MOTION-002` | Animated titles, lower thirds and end credits | `B` |
| `AUD-MOTION-003` | Keyframes with cubic easing, motion paths | `B` |
| `AUD-MOTION-004` | 3D scene graph/camera/lighting and glTF asset | `B` |
| `AUD-MOTION-005` | Scene rigs, characters, pose and animation tracks | `B` |
| `AUD-MOTION-006` | 2D/3D transition library and user presets | `B` |
| `AUD-MOTION-007` | Editable branded motion graphic templates | `B` |
| `AUD-MOTION-008` | Custom WebGL/WebGPU shader effects in sandbox | `N` |
| `AUD-MOTION-009` | Node-based compositing and transform graph | `N` |
| `AUD-MOTION-010` | Real-time 3D animation preview and render | `B` |
| `AUD-MOTION-011` | Frame-to-frame generative transition inserts | `E` |
| `AUD-MOTION-012` | Charts and animated data visualization from exact data | `N` |
| `AUD-MOTION-013` | Infographics/slides to video with source references | `N` |
| `AUD-MOTION-014` | Text animation synced to speech/beat timing | `N` |
| `AUD-MOTION-015` | Procedural background animation and particles | `N` |
| `AUD-MOTION-016` | AR/360/stereoscopic views when hardware/profile admitted | `N` |

#### `DIRECT` — Agent-driven creative direction and automated editing

| Audit-local ID | Feature | Prior review status |
|---|---|---|
| `AUD-DIRECT-001` | Intent/purpose/audience to scene-by-scene storyboard | `B` |
| `AUD-DIRECT-002` | Script and narration generation from source facts | `B` |
| `AUD-DIRECT-003` | Shot selection and B-roll recommendation | `B` |
| `AUD-DIRECT-004` | Automatic rough cut and repeat/filler silence cleanup | `B` |
| `AUD-DIRECT-005` | Highlights/clips extraction from long videos | `B` |
| `AUD-DIRECT-006` | Automatic transitions and pacing recommendations | `B` |
| `AUD-DIRECT-007` | Style Skills and creative recipes applied across projects | `B` |
| `AUD-DIRECT-008` | Conversational re-edit of existing project not one-shot output | `B` |
| `AUD-DIRECT-009` | Full typed editing tool coverage for internal/MCP agents | `B` |
| `AUD-DIRECT-010` | Dry-run, semantic diff, scope guard and undo support | `B` |
| `AUD-DIRECT-011` | Multi-turn planning with long-running outcome watches | `E` |
| `AUD-DIRECT-012` | Targeted agent correction to selected timeline region | `E` |
| `AUD-DIRECT-013` | Source-grounded verified citations for narration claims | `E` |
| `AUD-DIRECT-014` | Agent distinguishes illustration vs actual product activity | `B` |
| `AUD-DIRECT-015` | Natural language -> explicit structured edit proposal | `B` |
| `AUD-DIRECT-016` | Agent-generated motion graphics with editable source | `N` |
| `AUD-DIRECT-017` | Creative variant generation ranked by audience/channel | `N` |
| `AUD-DIRECT-018` | Cost, latency, asset provenance displayed before execution | `E` |
| `AUD-DIRECT-019` | Auto-quality critique, proposed repairs and human approval | `B` |
| `AUD-DIRECT-020` | Automatic acceptance test/coverage list from production spec | `N` |
| `AUD-DIRECT-021` | Policy enforcement prevents untrusted media prompt injection | `B` |

#### `SOCIAL` — Marketing, creator distribution and derivative formats

| Audit-local ID | Feature | Prior review status |
|---|---|---|
| `AUD-SOCIAL-001` | Brand kit/logo typography templates | `B` |
| `AUD-SOCIAL-002` | Storyboard-backed product explainer ads | `B` |
| `AUD-SOCIAL-003` | One-to-many portrait square landscape edits | `B` |
| `AUD-SOCIAL-004` | Social hooks, intros and end cards | `N` |
| `AUD-SOCIAL-005` | Automatic captions and stylized karaoke/text animations | `E` |
| `AUD-SOCIAL-006` | Auto highlight short-form clip selection | `B` |
| `AUD-SOCIAL-007` | Marketing campaign variant experiments from same source | `N` |
| `AUD-SOCIAL-008` | Creator thumbnail/poster generation | `B` |
| `AUD-SOCIAL-009` | Video title, chapters, description generation | `N` |
| `AUD-SOCIAL-010` | Platform safe-area and crop profile definitions | `E` |
| `AUD-SOCIAL-011` | Animated charts/metrics with source values | `N` |
| `AUD-SOCIAL-012` | Brand-safe generative talking presenter with verified synthetic disclosure | `N` |
| `AUD-SOCIAL-013` | A/B variant performance metadata and approved feedback loop | `N` |
| `AUD-SOCIAL-014` | Bulk personalization without identity/claim invention | `N` |

#### `INTER` — Interactive video, education and access

| Audit-local ID | Feature | Prior review status |
|---|---|---|
| `AUD-INTER-001` | Interactive hotspot and branch navigation | `B` |
| `AUD-INTER-002` | Chapter/scene overview and transcript search | `B` |
| `AUD-INTER-003` | Keyboard and screen-reader navigation | `B` |
| `AUD-INTER-004` | Offline signed bundled player | `B` |
| `AUD-INTER-005` | Safe embedded iframe sandbox / CSP | `B` |
| `AUD-INTER-006` | Quiz and learning reflection without privileged mutations | `E` |
| `AUD-INTER-007` | Variable-language captions and audio track selection | `B` |
| `AUD-INTER-008` | Accessible nonvideo transcripts and scene summaries | `B` |
| `AUD-INTER-009` | Interactive product annotations linked to source readback | `E` |
| `AUD-INTER-010` | Viewer analytics only with consent and redaction | `B` |
| `AUD-INTER-011` | A/B optional branching without identity scope leakage | `E` |

#### `COLLAB` — Collaborative editing, approval and organizational workflows

| Audit-local ID | Feature | Prior review status |
|---|---|---|
| `AUD-COLLAB-001` | Timeline/region/timecode anchored comments | `N` |
| `AUD-COLLAB-002` | Review checklist and quality signoff workflow | `B` |
| `AUD-COLLAB-003` | Frame comparison and annotated markup | `E` |
| `AUD-COLLAB-004` | Version diff and before-after alternative preview | `E` |
| `AUD-COLLAB-005` | Per-actor project role and audit trail | `B` |
| `AUD-COLLAB-006` | Reviewer-only read views and nonprivileged shares | `E` |
| `AUD-COLLAB-007` | Share review links or packages with token expiry | `N` |
| `AUD-COLLAB-008` | Project change request, proposal and approval | `B` |
| `AUD-COLLAB-009` | Concurrent editing revision conflict and merge UI | `B` |
| `AUD-COLLAB-010` | Track/scene locks and temporary editing claims | `E` |
| `AUD-COLLAB-011` | Reusable team brand/voice/style libraries | `E` |
| `AUD-COLLAB-012` | Variant review and winner decision provenance | `N` |
| `AUD-COLLAB-013` | Export review summary linked to output hash | `N` |

#### `DELIV` — Rendering, encoding, packaging, and media interoperability

| Audit-local ID | Feature | Prior review status |
|---|---|---|
| `AUD-DELIV-001` | Source-time rational-frame render graph | `B` |
| `AUD-DELIV-002` | Fast proxy preview and final quality render | `B` |
| `AUD-DELIV-003` | Local CPU-only composition pathway | `B` |
| `AUD-DELIV-004` | GPU accelerated available codecs with fallback | `B` |
| `AUD-DELIV-005` | Browser WebCodecs capability negotiation | `B` |
| `AUD-DELIV-006` | Native software VP9/AV1 + Opus/WebM where admitted | `N` |
| `AUD-DELIV-007` | OS H264/HEVC hardware encoding with legal review | `B` |
| `AUD-DELIV-008` | MP4/WebM codecs and muxer compliance | `B` |
| `AUD-DELIV-009` | WAV/FLAC/Opus and multichannel audio variants | `B` |
| `AUD-DELIV-010` | 4K export and portrait/landscape/square presets | `B` |
| `AUD-DELIV-011` | 8/10-bit HDR and color tagged formats as capability | `N` |
| `AUD-DELIV-012` | Alpha channel and ProRes/DNx-style intermediates when admitted | `E` |
| `AUD-DELIV-013` | Subtitle SRT/VTT/TTML and burned captions | `E` |
| `AUD-DELIV-014` | IMSC1/CEA broadcast caption packaging when qualified | `N` |
| `AUD-DELIV-015` | Audio/video sync and sample/timecode verification | `B` |
| `AUD-DELIV-016` | OpenTimelineIO import/export for project interchange | `B` |
| `AUD-DELIV-017` | FCPXML/EDL/AAF via separately admitted adapters | `N` |
| `AUD-DELIV-018` | HLS/DASH adaptive packaging when admitted | `B` |
| `AUD-DELIV-019` | Live streaming output WebRTC/RTMP optional providers | `N` |
| `AUD-DELIV-020` | Resumable export with accurate job attempt receipts | `B` |
| `AUD-DELIV-021` | Content credentials C2PA packaging and preservation | `N` |
| `AUD-DELIV-022` | Watermark and accessible caption delivery sidecars | `B` |
| `AUD-DELIV-023` | Portable project manifest and editable layered export | `E` |
| `AUD-DELIV-024` | Export destination plugin with remote ACK reconciliation | `B` |

#### `QA` — Professional media quality evaluation and acceptance

| Audit-local ID | Feature | Prior review status |
|---|---|---|
| `AUD-QA-001` | Decode and media integrity pass on final output | `B` |
| `AUD-QA-002` | Source/action business-state readback in product demos | `B` |
| `AUD-QA-003` | Frame black/silent tail and clipped audio detection | `B` |
| `AUD-QA-004` | A/V clock and word-to-frame sync offsets | `B` |
| `AUD-QA-005` | Transcript WER/CER and word alignment quality | `B` |
| `AUD-QA-006` | Speaker diarization DER and voice-match review | `B` |
| `AUD-QA-007` | Voice loudness/true peak and intelligibility scores | `B` |
| `AUD-QA-008` | Voice cloning consent and speaker identity evidence | `B` |
| `AUD-QA-009` | Lip sync accuracy and face/identity temporal coherence | `N` |
| `AUD-QA-010` | Image/video motion flicker/subject consistency checks | `N` |
| `AUD-QA-011` | Caption contrast/readability and face-safe placement | `E` |
| `AUD-QA-012` | Protected OCR text/logo/brand legality validation | `B` |
| `AUD-QA-013` | HDR/color tag pixel fidelity and scopes | `N` |
| `AUD-QA-014` | Per-scene quality threshold and independent review | `B` |
| `AUD-QA-015` | Comparison visual/audio AB and model-version rank | `E` |
| `AUD-QA-016` | Correct unresolved outcomes as denied/UNKNOWN/not run | `B` |
| `AUD-QA-017` | Quality variation across OS codec/browser hardware | `B` |

#### `TRUST` — Rights, provenance, identity, privacy and responsible media

| Audit-local ID | Feature | Prior review status |
|---|---|---|
| `AUD-TRUST-001` | Tenant identity/role and project source authorization | `B` |
| `AUD-TRUST-002` | Purpose-limited consent for capture and voice enrollment | `B` |
| `AUD-TRUST-003` | No unapproved external model/file egress by default | `B` |
| `AUD-TRUST-004` | Per-asset, voice, model and font license provenance | `B` |
| `AUD-TRUST-005` | Revocation/retention/legal hold/erasure state machine | `B` |
| `AUD-TRUST-006` | C2PA signatures and verified content credentials | `N` |
| `AUD-TRUST-007` | Synthetic-source disclosure and invisible watermark review | `B` |
| `AUD-TRUST-008` | No fabricated product feature/outcome in demonstration | `B` |
| `AUD-TRUST-009` | Separate actual capture, simulation, generated illustration | `B` |
| `AUD-TRUST-010` | Secure model provenance, signed cache and hash verification | `B` |
| `AUD-TRUST-011` | Prompt injection defense from captions/assets/sources | `B` |
| `AUD-TRUST-012` | Malicious archive/media/path traversal and SSRF rejection | `B` |
| `AUD-TRUST-013` | Sandboxed shader/plugin/editor action permissions | `E` |
| `AUD-TRUST-014` | Consent-aware faces, likeness and appearance recast | `E` |
| `AUD-TRUST-015` | Cross-tenant derivative/cache isolation | `B` |
| `AUD-TRUST-016` | Redacted logs and trace IDs with no raw secrets | `B` |
| `AUD-TRUST-017` | Publication request ACK versus destination completion | `B` |
| `AUD-TRUST-018` | Deletion confirmation distinct from access restriction | `B` |
| `AUD-TRUST-019` | Media impersonation and unauthorized synthesis review | `E` |

#### `OPS` — Local-first model/resource management and runtime operations

| Audit-local ID | Feature | Prior review status |
|---|---|---|
| `AUD-OPS-001` | One model/provider capability registry and effective-choice receipt | `B` |
| `AUD-OPS-002` | Per-engine model/license/weight/tokenizer pinning | `B` |
| `AUD-OPS-003` | CPU, CUDA, Metal/MPS, ROCm, Intel resource detection | `B` |
| `AUD-OPS-004` | GPU VRAM/RAM scheduling and admission limits | `B` |
| `AUD-OPS-005` | Local model download with SHA, resume and review | `B` |
| `AUD-OPS-006` | External/remote worker enrollment and isolation | `B` |
| `AUD-OPS-007` | Offline execution and explicit local-first routing | `B` |
| `AUD-OPS-008` | Provider cost, time, throughput and quality scoring | `B` |
| `AUD-OPS-009` | Multi-model candidate benchmarking under same fixtures | `E` |
| `AUD-OPS-010` | Transactional durable job attempts with bounded retry | `B` |
| `AUD-OPS-011` | Cancellation vs completed effect and late provider receipts | `B` |
| `AUD-OPS-012` | Crash-resilient outbox and consumer deduplication | `B` |
| `AUD-OPS-013` | Watch folders and recurring/batch media jobs | `B` |
| `AUD-OPS-014` | Versioned API, CLI, SDK, agent MCP and event parity | `B` |
| `AUD-OPS-015` | Streaming generation progress and event updates | `E` |
| `AUD-OPS-016` | Resource quotas and interruption/storage recovery | `B` |
| `AUD-OPS-017` | Content-addressed output cache scoped to rights/tenant | `B` |
| `AUD-OPS-018` | OpenTelemetry metrics traces and redacted logs | `B` |
| `AUD-OPS-019` | Export/capture compatibility capability matrix per OS | `B` |
| `AUD-OPS-020` | Deterministic source/test/fixture build snapshots | `B` |
| `AUD-OPS-021` | Safe install/upgrade/migration and model removal | `E` |
| `AUD-OPS-022` | On-device performance profile explanations to user | `N` |

## 13. Mandatory adoption discipline: embedded permissive, original equivalent, licensed optional

### 13.1 Reuse selection criteria

1. **REUSE_EXISTING_MEDIA:** Prefer the current governed STT/TTS/vision jobs, project, revisions, policy, model selection via AI Inference, assets, owner semantics, outbox, UI and CLI/SDK over any competing OSS service/application.
2. **COPY/ADAPT PERMISSIVE SUBSET:** Inspect exact source file SPDX, tree pin, transitive dependencies, bundled model/weight/tokenizer/font/codec licenses, attribution/NOTICE and security; copy only bounded components into Media-owned packages and keep a provenance ledger. Preserve authorship notices and modified-file markers. Full-app imports require an independently audited compliant dependency graph.
3. **IMPLEMENT OWN FEATURES FROM BEHAVIORAL REQUIREMENTS:** For AGPL/GPL/MPL/custom-commercial or otherwise incompatible code, use feature requirements and independently designed algorithms; never transplant code snippets or derivative UI source. Isolate authors/reviews as appropriate to avoid accidental copying.
4. **OPTIONAL EXTERNAL ADAPTER ONLY IF APPROVED:** A process boundary does not erase legal duties. User-installed tools and community-license models need explicit distribution/service/use clearance and must never be essential to CPU-only core editing or the product-truth experience.
5. **DISTINCT MODEL ADMISSION:** Code license, checkpoint license, dataset/reference speaker consent, tokenizer, fonts, codec, outputs and jurisdiction all evaluated separately. Signed model pin, weights digest, precision, language/VRAM claim and allowed-use purpose are independently recorded.

### 13.2 Higher-value OSS candidates and currently known restrictions

| Component | Identified license posture | Useful behavior | Proposed disposition |
|---|---|---|---|
| `jamiepine/voicebox` | MIT app | Selective application/code patterns: voice profiles, Stories, expression/UI, local LLM personality, narration chunking | COPY_CANDIDATE; strip/reimplement GPL Pedalboard and independently audit pretrained voice/model graph |
| `Augani/openreel-video` | MIT app | Timeline operations/agent typed calls, keyframes, editing UI, color, resource-aware export interfaces | COPY_CANDIDATE; do not transplant MediaBunny MPL or FFmpeg/FFmpeg.wasm LGPL/GPL transitively |
| `FireRedTeam/FireRed-OpenStoryline` | Apache-2.0 | Scene/shot planning, speech rough-cut logic, reusable Style Skills, generated transitions | COPY_CANDIDATE; generated transition may require paid service and rights review |
| `Anil-matcha/Open-Generative-AI` | MIT app | Generation UI/model catalog, cinema controls, marketing variants, multi-image inputs, workflow canvas | COPY_CANDIDATE; hosted Muapi models not free/local by default; reject unsafe no-guardrail claims |
| `OpenCut-app/OpenCut` | MIT app | Navigation, editing UX, future plugin/API abstractions | QUALIFY_IMPLEMENTATION (many planned capabilities are roadmap) |
| `debpalash/VoiceStudio` | AGPL-3.0 | Dubbing, voice design/clone, model catalog, 646-language engine registry, AudioSeal, batch, remote workers | REIMPLEMENT_BEHAVIOR_NOT_SOURCE; 646 catalog languages do not imply identical engine quality |
| `0xsline/OpenChatCut` | AGPL-3.0 | Speech-based editing, face-safe captions, shader/motion effects, render/agent parity | REIMPLEMENT_BEHAVIOR_NOT_SOURCE; commercial Remotion/FFmpeg separately gated |
| `ggml-org/whisper.cpp` | MIT | Offline ASR / speech alignment and CPU/GPU variants | PERMISSIVE_CANDIDATE; exact model checkpoint pin |
| `k2-fsa/sherpa-onnx` | Apache-2.0 | ASR, TTS, VAD, on-device speech/low resource | PERMISSIVE_CANDIDATE; voice models and linguistic deps separately reviewed |
| `QwenLM/Qwen3-TTS` | Apache-2.0 project | Prompt-guided voice design, cloned/preset multilingual speech | PERMISSIVE_CODE_CANDIDATE; pin exact weight and tokenizer use rights |
| `QwenAudio/CosyVoice` | Apache-2.0 project | Expressive/ref voice TTS, multilingual dubbing | PERMISSIVE_CODE_CANDIDATE; audit model checkpoints and derivatives |
| `resemble-ai/chatterbox` | MIT project | Expressive paralinguistic speech, approved speaker cloning, watermark | PERMISSIVE_CANDIDATE; verify watermark dependencies and weight rights |
| `Rikorose/DeepFilterNet` | MIT OR Apache-2.0 | Denoise and speech cleanup Rust/Python components | PERMISSIVE_CODE_CANDIDATE; actual weights/deps must be pinned |
| `facebookresearch/sam2` | Apache-2.0 code/checkpoints | Video scene masks, spatial tracking, safe overlay and smart reframe | PERMISSIVE_CANDIDATE; demo fonts optional licenses |
| `TMElyralab/MuseTalk` | MIT project code; commercial use stated for its model | Video dubbing and optional permitted portrait lip sync | PERMISSIVE_CANDIDATE; model dependencies, identity retention and jitter benchmark required |
| `bytedance/LatentSync` | Apache-2.0 code | Lip-sync alternative candidate | PERMISSIVE_CODE_CANDIDATE; underlying diffusion model/weights dependencies to audit |
| `Wan-Video/Wan2.2` | Apache-2.0 upstream models | Local T2V/I2V and scenic control | CHECKPOINT_LEVEL_CANDIDATE; VRAM/quality qualification |
| `genmoai/mochi` | Apache-2.0 upstream | Alternative text-to-video model for comparison | CANDIDATE; costly GPU/decoder and distribution graph review |
| `kandinskylab/kandinsky-6` | MIT repository and MIT-labeled published model card | Native synchronized 5-second video+audio generation, lip-synced speech, video super-resolution | HIGH_PRIORITY_CANDIDATE; exact checkpoint and CUDA/dependency license and VRAM test |
| `ace-step/ACE-Step-1.5` | MIT source and model card | Music, lyrics, vocal generation, repainting, melody and cover conditioning | HIGH_PRIORITY_CANDIDATE; chosen checkpoint/license and rights/originality tests |
| `HeartMuLa/heartlib` | Apache-2.0 source and stated model-family weights | Multilingual music/lyrics, audio codec, music remix and provenance | HIGH_PRIORITY_CANDIDATE; exact weights/mix and memory benchmark |
| `huggingface/diffusers` | Apache-2.0 | General local image/video inference API | CANDIDATE; not a model license |
| `AcademySoftwareFoundation/OpenColorIO` | BSD-3-Clause | Managed SDR/ACES/HDR color transforms | CANDIDATE with config/license and color QA |
| `AcademySoftwareFoundation/OpenTimelineIO` | Apache-2.0 | Project interchange only, optional approved format adapters | CANDIDATE; OTIO is not a canonical asset/video renderer |
| `contentauth/c2pa-rs` | MIT OR Apache-2.0 | Signed content provenance, verify/edit/export content credentials | CANDIDATE; dependencies, signing identity and container modes checked |
| `xiph/rav1e`, `webmproject/libvpx` | BSD family with codec patent notices | Native AV1/VPx source encoding in qualified containers | CANDIDATE; muxer, OS/browser and codec patent/legal validation |
| `facebookresearch/audiocraft` | MIT code; **CC-BY-NC weights** | Audio/music generation algorithms reference | CODE_ONLY / RESEARCH; no default noncommercial weights |
| `Lightricks/LTX-2`, `Tencent-Hunyuan/HunyuanVideo` | Community/custom terms | Joint A/V or model capability research | RESEARCH_OR_SEPARATELY_LICENSED; NOT permissive default |
| `ffmpeg`, `MediaBunny`, `MLT`, `Remotion`, `WanGP`, `Pedalboard` | LGPL/GPL, MPL, commercial, community respectively | Video/audio processing or rendering concepts | NOT_DEFAULT_BUNDLED; separately approved protocol/process adapter only if compliant |
| `Wav2Lip` original | Noncommercial/research restrictions | Lip-sync feature reference | DO_NOT_COPY_OR_BUNDLE; MuseTalk or admitted LatentSync preferred |

**Critical correction:** “MIT application” is not a warranty that its transitive dependencies, models, tokenizers, binary redistributions, or bundled fonts are MIT. Likewise an independently launched copyleft or restricted binary is **not automatically** exempt from obligations. Legal review must evaluate exact mode of use and integration.

## 14. Differentiation: capabilities we should own rather than copy

| Defensible advantage | Technical design | Product edge | Falsifiable proof |
|---|---|---|---|
| Source-grounded demo truth | Capture pixels and action events together with authoritative business readback; classify REAL_OBSERVED, SIMULATED, GENERATED_ASSET, or UNKNOWN per scene. | Produces demos that can be audited rather than believable-but-unverified AI videos. | Reject false evidence on synthetic/edit-derived frames; trace to exact product receipt. |
| Media as code and spec compiler | Exact versioned YAML/JSON spec → P1 typed scene/effect graph → reusable execution DAG; identical semantics from Studio/CLI/SDK/MCP. | Replicable headless content production across teams and products. | Same input+policy+model pins yields equivalent canonical graph/fingerprint. |
| Manual/agent isomorphism | Agent and human edit the same revisioned multitrack project using same discriminated edit commands; no opaque generated-only video. | Moves beyond one-shot creation and chat demos; professional polish remains possible. | 52-kind cross-channel tests, stale CAS, conflict/undo, edit-source round-trip. |
| Minimal scene recomputation | Dependency hashes and source-time maps invalidate only downstream affected shots/phrases/languages/formats while preserving locked manual edits. | Less GPU cost, faster retakes, no wasted editing effort. | Unchanged node checksum + edit-lock persistence under changed single scene. |
| Model/codec/license admission-aware routing | Route by allowed use, rights, privacy, resolution, language, hardware, cost and quality; never false fallback to cloud/synthetic. | Safer commercial distribution and predictable local-first experience. | Fail closed with exact denial/unavailable, no unreviewed model weights or provider egress. |
| One project, many outputs | Audiobook, podcast, presentation, screen demo, ad, vertical clip, dub, caption package, interactive demo from one MediaProject revision and asset graph. | Cross-surface reuse and consistency instead of separate applications. | Versions/time maps/consent match across 16:9, 9:16 and 2 locales. |
| Provenance and content credentials | Signed output manifest, model/ref voice asset hashes, derivation chain, capture truth class, rights/consent and watermark/metadata presence. | Trustworthy verified and clearly illustrative media in one platform. | Validate C2PA chain and independent receipt on final exported asset. |
| Semantic, not visual-only creator integrations | CLI-only/API-only product runs render evidence-linked diagrams/transcripts/status, never fake application screens. | Genuinely automates demonstrations of non-GUI products. | Headless product scenario has typed experience and no phantom GUI pixels. |
| Product-design source reuse | Source-linked branding/tokens/components and actual screens; asset/logo/legal text must match accepted source. | Reduced drift and maintenance of corporate demos at scale. | Golden asset/logo/text manifest matches exact source versions or blocks release. |
| Cost/latency/storage-aware planner | Distinguish cheap deterministic passes from expensive creative generation; cache within tenant/rights scope, stream large media and use proxies. | Repeatable production economics and scalable local workloads. | Measure per-stage p50/p95, peak VRAM/RSS, recompute ratio, storage amplification. |

## 15. Prioritized full-product implementation integration

**This is a change set to the current Build candidate PBI-00…PBI-15 and Recorder successor PDP material, not a parallel project plan.** “P0/P1/P2/P3” below refers to normative Product Discovery phases and must not be confused with implementation waves. No actual Build entry is claimed.

| Review package | Stage | Where / how | Expected action | Exit test |
|---|---|---|---|---|
| INV-01 | PDP-0 source reconciliation | `.product-experience/pdp-0-product-truth/{requirements.yaml,capabilities.yaml,recorder-studio-extension.yaml}` | Join 100% audit IDs to exact existing PDP0 capability and acceptance cases. Decide source change vs accepted applicability; do not duplicate capability truth. | Zero review features unclassified; any new meaning gets phase-impact/owner decision, not status inflation. |
| INV-02 | PDP-1 operation effects | `.product-experience/pdp-1-domain-data/` + typed public op authority | Map speech clone/profile, soundtrack generation, lip sync, visual tracking, C2PA, review, model install, social variants to existing operations or minimum new typed ones. Preserve 52 edit kinds, CAS, timebases and outcome semantics. | Requests/results/errors/actor/rights/UNKNOWN and negative fixtures for every required effect; no fabricated public route. |
| INV-03 | PDP-2 design parity | `.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml` | Bind newly explicit controls to existing 13 proposed Studio pages, Shared design tokens/Media components and CLI/SDK/MCP parity; no fake screen counts. | One semantic action ID across GUI, keyboard/text, API/SDK and Explorer; a11y, mobile and denials. |
| INV-04 | PDP-3 experience coverage | `.product-experience/pdp-3-product-experience/` + Explorer projection | Add exact end-to-end voice dubbing, AI director, generative B-roll, face-safe captions, HDR, music, live/collab/interactive/locale scenario cases where applicable. | All affected journey steps have truthful receipt/denial/unavailable/UNKNOWN, source pins, approved source-linked screens. |
| INV-05 | Source-currentness gate | `scripts/check-media-recorder-studio-*`, PDP source manifest/explorer generators, phase gates | Run source-wide regressions and affected surface currentness; reconcile 216 successor cells and new artifact IDs without repinning history. | Native PASS on frozen source; formal Discovery exit before Build entry. |
| INV-06 | Runtime speech/auth vertical | Canonical `ghatana/services/media` until MIG-04; `modules/speech` and existing Java TTS/STT contracts | Replace placeholder assumptions with real admitted Whisper/Piper+voice engine candidates; exact model/effective voice/rights. | Audible speech+real transcripts, no synthetic production pass, consent refusal, CPU baseline. |
| INV-07 | Professional NLE | `libs/audio-video-ui`, existing Media timeline and `@ghatana/ai-voice-ui-react` | Audit-copy OpenReel/Voicebox MIT fragments at exact file pin; implement complete 52 operations, waveforms, precise timing, keyboard, undo/diff and safe effects. | Roundtrip human->agent->human edit, revision parity across every channel, real 30–60min project. |
| INV-08 | Creative audio and language | Speech provider adapters, caption/timebase, approved inference boundary | Expressive TTS, local-LLM personality, diarization, sentence retakes, source separation, timed dubbing, language/glossary and per-voice effects; separate music generator rights. | Voice identity/time-sync/lang mix+consent+license acceptance on real audio. |
| INV-09 | Video AI and compositing | Vision+generation adapters, `production-studio` existing pages | Integrate Diffusers+Wan/Mochi, SAM2, OpenColorIO, optional MuseTalk; own face-safe tracking/motion graphics shader sandbox, studio workflows. | Temporal/subject safe-zone, reference conditioning, no model fallback, synthetic label, GPU memory and final video QA. |
| INV-10 | Render/interchange | Media composition renderer SPI, asset/quality/report/publish contracts | Permissive codecs and muxers first; WebCodecs/OS capabilities; OTIO/OpenColorIO; C2PA; optional separately admitted encoder for MP4/ProRes when needed. | Qualified actual output on OS×codec×resolution; supported/unsupported matrix and independent decoded QA. |
| INV-11 | Director and scale | Existing job/outbox/AI Inference public model registry; agent typed Media op interface | Versioned production compiler, agent Skills, cost/generation planning, watch jobs, scene-local invalidate, manual locks, evaluation/approval and abort/recovery. | Recompile deterministically, only affected scene changes, semantic diffs/rollback; no unauthorized publish/effects. |
| INV-12 | Dogfood and qualification | Gharbatai source fixtures/qualified scenario; Media real host | Deliver complete real S01 demo and reusable voice/video workflow before broad model experiments; then multi-locale and variant verticals. | Real film decoded and signed, product-effect readback, manual edit preserved, approval distinct. |

### 15.1 No false parallel authority

The 22 audit domains are **feature taxonomies**, **not** new repository modules, deployed services, screens, or first-class PDP surfaces. They must map into the four existing logical Recorder/Studio surfaces, pre-existing Media capability hierarchy and one Media runtime. A source-level gap is first judged against `capabilities.yaml`, `requirements.yaml`, existing 52 edit parameter contracts, 13 page design compositions and each exact P3 journey/screen. Only real normative new meaning triggers a carefully scoped successor PDP change.

### 15.2 Studio workspace map (all 13, no new pages assumed)

| Existing planned page | New coverage without new semantic owner |
|---|---|
| `project-library` | Asset index, proxy/cache, smart bins, team projects, consent-scoped source imports. |
| `production-planner` | Declarative production compiler, model/hardware/licensing choice, workflow canvas, variation budgets, creative agent plans. |
| `scene-storyboard` | Shot script, source readback anchors, multi-image conditioning, transitions, camera intent and automatic story structure. |
| `source-review` | Raw media, speaker enrollment reference, content rights, media QA, collaboration comments and original-vs-generated classification. |
| `multitrack-timeline` | 52 typed manual edit kinds, waveforms, dialogue/music/motion tracks, keyframe graph, multicam, undo/revision/conflicts. |
| `captions-transcript` | STT/word spans/diarization, transcript ripple edit, translated captions, face-safe geometry and accessible text controls. |
| `narration-mixer` | Voice clone/design/expressive TTS, profile/takes/voice personalities, speech FX, dubbing, ADR, mixing, generated music/SFX. |
| `camera-multiview` | Multiple devices/source clocks, subject following, picture-in-picture, virtual camera, cinematic framing and source visibility. |
| `effects-inspector` | Color scopes/LUT/HDR, text effects, shader sandbox, tracking/segmentation, retiming, stabilization, 2D/3D graphics. |
| `interactive-authoring` | Hotspots, branches, chapters, offline content and no-privilege player policy. |
| `quality-review` | Source-grounded QA, voice/audio sync and identity, face-safe captions, legal/license review and frame-accurate annotations. |
| `render-preview` | CPU/GPU codec preview, 16:9/9:16/HDR/proxy qualification, A/B variants and decoded output checks. |
| `delivery` | C2PA signature, audio/caption sidecar, OTIO/interchange, locale/social bundles, approval, provider ACK/UNKNOWN. |

## 16. Required edge/corner-case tests and competitive acceptance

| Test | Scenario and proof |
|---|---|
| **C-01 Replay as truth** | A real product action is captured and independently confirmed in owner readback; AI-generated lookalike is tagged illustration, never observed product truth. |
| **C-02 0-GUI experience** | Take an API-only or CLI-only product scenario to storyboard, narration, timeline and accessible rendered video without fake browser UI. |
| **C-03 One-to-many** | Same immutable source project outputs desktop 16:9, social 9:16, dubbed language and interactive bundle with common lineage. |
| **C-04 Voice identity** | Declared speaker, selected provider, effective voice and output verification exactly agree; wrong voice triggers denial or review. |
| **C-05 Voice consent** | Revoked voice reference before a queued job denies synthesis; external provider unknown consent-erasure remains reconcilable. |
| **C-06 Long speech** | A chapter-long multivoice book/podcast job survives chunk splitting, crossfade, speaker changes, retries and preserves sample-clock alignment. |
| **C-07 Live dictation** | Device mic speech streams with actual VAD/ASR partial/final events and does not paste or log sensitive text without authorized focus. |
| **C-08 Exact dub** | Dub at least two identified speakers in two languages; align words and silence, preserve soundtrack, verify speaker mapping and sync. |
| **C-09 Lip sync** | Authorized speaker portrait/video + generated audio returns actual synchronized frames without uncontrolled face change; consent, jitter and A/V offsets QA. |
| **C-10 Music licensing** | MusicGen-type noncommercial weights are rejected for commercial distribution; compare qualified ACE-Step MIT and HeartMuLa Apache weights with attribution/copyright/similarity/source-rights audit. |
| **C-11 Agent edit** | Agent proposes film edit, dry-runs semantic diff; actor approves; human changes same revision; stale automated commit fails and manual locks survive. |
| **C-12 All 52 edits** | Property/model tests across 52 manual discriminants, complete parameter schema, keyboard/CLI/API parity and save/reopen/render stable semantics. |
| **C-13 Face-safe caption** | Person segmentation over moving face keeps captions in safe/contrast zones across selected frames; exception triggers manual review. |
| **C-14 Segment recapture** | Change one source step and one narration line; recompute only dependent descendants; unrelated scene hashes and human-edited mask remain identical. |
| **C-15 Generation provenance** | Text-to-video and image-to-video demonstrate reference ordering, condition controls, seed/precision/model identity, unavailable GPU and remote egress denial; Kandinsky joint A/V additionally verifies actual dialogue-sound sync. |
| **C-16 Professional color** | LUT/ACES/SDR/HDR 10-bit requests preserve declared color primaries, transfer, pixel formats or fail unsupported rather than silently convert. |
| **C-17 Media sync** | VFR screen capture with clock drops, waveform, word spans and 60-minute source exports stays synchronized under measured preapproved tolerances. |
| **C-18 Encoder independence** | Run on CPU Linux/macOS/Windows browser qualification; AV1/VP9 WebM when available, licensed MP4 optional; no implicit FFmpeg/ProRes claim. |
| **C-19 Workflows as data** | Visual workflow editor and YAML/SDK generator serialize to the identical typed DAG and budget/policy plan fingerprint. |
| **C-20 Creative variants** | Produce multiple social/locale brand variants with crop/logo/legal protected zones and single source revision lineage. |
| **C-21 Signed proof** | C2PA manifest verifies the shipped asset hard-binding on supported containers; source/model claims are linked to signed assertions, with distinct pre-sign and post-sign asset fingerprints. |
| **C-22 External failure** | Timeout, cancellation, retries, late provider callback, job ownership lease, publish UNKNOWN, disk full and legal hold never result in fabricated completed status. |
| **C-23 Content attacks** | Hostile subtitle/media/agent prompt/shader cannot run arbitrary code, cross tenant, publish, fetch URLs, log secrets or send protected file to provider. |
| **C-24 Accessibility** | 13 proposed Studio pages + player and headless paths support keyboard, focus, textual timecode, RTL/CJK/Devanagari, reduced motion, screen reader. |
| **C-25 Production economics** | Measure local vs remote, CPU/Metal/CUDA, energy/VRAM, p50/p95, re-render share, storage amplification and quality; only observed capability is advertised. |
| **C-26 Full edit interchange** | Export and re-import qualified OTIO project and approved FCPXML/AAF adapter; exact clip timebases and unmappable effects are reported, never silently discarded. |
| **C-27 Cross-platform collaboration** | Share frame-anchored comment on immutable revision, apply edit, rebase/resolve comment and ensure viewer lacks author/editor privileges. |
| **C-28 Model removal** | Delete unused model/cache without removing in-use content or breaking legal holds; content and rights lineage remain readable. |

## 17. Review, evidence and source references

**Frozen source references from GitHub public repository APIs (October 17, 2026):**

| Repository | Reviewed branch commit |
|---|---|
| [samujjwal/ghatana-media](https://github.com/samujjwal/ghatana-media) | `fd7992d890e904f5276a68114be989ea2fcb11b5` |
| [debpalash/VoiceStudio](https://github.com/debpalash/VoiceStudio) | `d819ff54d93017bf4a5b34b605833162163c9e3c` |
| [jamiepine/voicebox](https://github.com/jamiepine/voicebox) | `8af7efe62fab8d33e2a5dfbedabaa45f68a5184f` |
| [Augani/openreel-video](https://github.com/Augani/openreel-video) | `367d7e90b61b5181f9861b852bb8b9d7a7d2954a` |
| [FireRedTeam/FireRed-OpenStoryline](https://github.com/FireRedTeam/FireRed-OpenStoryline) | `c9e945215586f45c12a61c1951ee9a8e9c43a027` |
| [Anil-matcha/Open-Generative-AI](https://github.com/Anil-matcha/Open-Generative-AI) | `0668c210ebfe893f16c5149405a08d00b9ae90df` |
| [0xsline/OpenChatCut](https://github.com/0xsline/OpenChatCut) | `72ddb3300cda4ed31cbd0bccbfc94fb29b8cffca` |
| [OpenCut-app/OpenCut](https://github.com/OpenCut-app/OpenCut) | `e668010778568641babef2cc40be4703ae6916d6` |
| [QwenLM/Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) | `022e286b98fbec7e1e916cb940cdf532cd9f488e` |
| [kandinskylab/kandinsky-6](https://github.com/kandinskylab/kandinsky-6) | `119d58ee5c5de0157644f09ef20bc9b2ab68a064` |
| [ace-step/ACE-Step-1.5](https://github.com/ace-step/ACE-Step-1.5) | `ca1e85fe9430179831e6bc6be790c332190a3866` |
| [HeartMuLa/heartlib](https://github.com/HeartMuLa/heartlib) | `5858ca8f1ffe58d62be7c007ea55f1033c5ca456` |

**First-party sources used for new details:**
- [VoiceStudio feature catalog](https://github.com/debpalash/VoiceStudio/blob/main/docs/feature-catalog.md)
- [Voicebox reference features](https://github.com/jamiepine/voicebox/blob/main/README.md)
- [OpenReel Agent Guide](https://github.com/Augani/openreel-video/blob/main/docs/AGENT-GUIDE.md)
- [Open-Generative-AI workflow/studios](https://github.com/anil-matcha/open-generative-ai)
- [FireRed-OpenStoryline editing/Style Skills](https://github.com/FireRedTeam/FireRed-OpenStoryline)
- [OpenChatCut motion/face-safe captions](https://github.com/0xsline/OpenChatCut)
- [MuseTalk official source/license](https://github.com/TMElyralab/MuseTalk)
- [LatentSync source/license](https://github.com/bytedance/LatentSync)
- [SAM2 official model and license](https://github.com/facebookresearch/sam2)
- [Qwen3-TTS official source](https://github.com/QwenLM/Qwen3-TTS)
- [CosyVoice official source](https://github.com/QwenAudio/CosyVoice)
- [DeepFilterNet official source](https://github.com/Rikorose/DeepFilterNet)
- [Wan2.2 official source](https://github.com/Wan-Video/Wan2.2)
- [Mochi official source](https://github.com/genmoai/mochi)
- [Kandinsky 6.0 synchronized A/V model MIT](https://github.com/kandinskylab/kandinsky-6)
- [ACE-Step 1.5 MIT music generator](https://github.com/ace-step/ACE-Step-1.5)
- [HeartMuLa Apache model family](https://github.com/HeartMuLa/heartlib)
- [Kandinsky published MIT video-audio weights](https://huggingface.co/kandinskylab/Kandinsky-6.0-Pro-distill-5s-Diffusers)
- [ACE-Step official MIT weights](https://huggingface.co/ACE-Step/Ace-Step1.5)
- [AudioCraft code-versus-weights license](https://github.com/facebookresearch/audiocraft)
- [LTX community license](https://github.com/Lightricks/LTX-2/blob/main/LICENSE)
- [HunyuanVideo community license](https://github.com/Tencent-Hunyuan/HunyuanVideo/blob/main/LICENSE.txt)
- [OpenTimelineIO formats/adapters](https://github.com/AcademySoftwareFoundation/OpenTimelineIO)
- [OpenColorIO](https://github.com/AcademySoftwareFoundation/OpenColorIO)
- [C2PA Rust SDK](https://github.com/contentauth/c2pa-rs)
- [Screen Studio product demo polish](https://screen.studio/)
- [Descript product editing workflows](https://www.descript.com/)
- [DaVinci Resolve finishing](https://www.blackmagicdesign.com/products/davinciresolve)
- [Runway generative iteration](https://help.runwayml.com/hc/en-us/articles/37327109429011-Creating-with-Gen-4-Video)

**Review limitations:** ChatGPT share-link conversation body was not readable by the public page reader; previous voice-plan essentials were preserved from earlier review and code/source context. Not all transitive license graphs, executable workflows, model weights or hardware metrics were independently installed and tested in this audit. No `ghatana-media` repository source files, PDP currentness results, CI receipts, or publication statuses were modified by this review. The machine-readable inventory is a comprehensive **selected-reference feature target**, not a timeless claim that all future video/voice innovations have been enumerated.

**Controlling disposition:** `SOTA_SECOND_PASS_FEATURE_SCOPE_RECONCILED_FOR_PLANNING; SOURCE_BINDINGS_PENDING; LICENSE_COMPONENT_ADMISSION_PENDING; BUILD_NOT_ENTERED_BY_THIS_REVIEW`. Acceptance requires the existing lifecycle process and exact source/real-runtime proof, not an assertion in this document.

---

# Third-pass controlling extension: Recorder/Studio + Declarative Animation + Declarative Simulation + TutorPutor

**Date:** 2026-10-17. **Disposition:** `SOURCE-RECONCILIATION_AND_BUILD-PLAN_PROPOSAL`; not PDP acceptance, a live model/solver qualification, software implementation, film approval, scientific validation or runtime source transfer. **Base:** `samujjwal/ghatana-media@fd7992d890e904f5276a68114be989ea2fcb11b5`; `ghatana-media` controls PDP0–3; the canonical executable writer remains `samujjwal/ghatana:services/media` pending MIG-04. **TutorPutor source:** `samujjwal/ghatana-products/products/tutorputor/` and its Adaptive Experience Fabric (AEF). The upstream Media PR #10 has **merged** (`107b3324beca07644433ae0ca6fbbbc9cf82115c`); its historically described *draft* status must not be repeated as current.

The v2 sections 1–17 are retained in full in the consolidated blueprint. This extension is *controlling when it is more specific* about Recorder, animation, scientific simulation, TutorPutor and acceptance. The third-pass audit adds individually scoped and falsifiable requirements candidates **without manufacturing canonical `media.*` requirement IDs**. The first 428 audit-local features remain exactly intact in the companion combined JSON.

## 18. One coherent system: explicit inclusion and competitive target

**Desired product outcome:** a user describes what media should accomplish in a declarative, versioned specification and obtains an editable, inspectable result. Supported production modes must include: (a) *real observed demonstration recording* with product-state readback; (b) *pure declarative animation* driven by semantic scene specifications; (c) *actual model-backed declarative simulation*, governed by versioned math/units/fidelity and a solver; (d) mixed productions in which a real demo embeds a model-backed animation, narrated graph, simulation, or generated clip. All support headless production, interactive preview where applicable, editable timeline semantics, and output variations without starting separate products.

**Critical distinctions (never collapse):**

| Meaning | Who decides truth | Execution source | Evidence that is allowed | Never infer |
|---|---|---|---|---|
| `REAL_CAPTURE` | Gharbatai or the relevant consuming product | Authorized product + qualified browser/device/API capture | Source frame/trace plus authoritative business-effect readback | Successful click, API response or CGI mock proves business effect |
| `DECLARATIVE_ANIMATION` | Media scene specification author | Scene graph + animation evaluator | Semantic scene nodes, keyframes, exact rendered frames | Visual resemblance demonstrates scientific accuracy |
| `MODEL_SIMULATION` | Qualified model/domain authority (TutorPutor for learning content) | Pinned model, solver, parameters, state transitions | Unit-bearing observables, numerical validation, run trace and checkpoints | Solver submit/pretty visualization proves correct measurements |
| `GENERATIVE_MEDIA` | Media provider + rights/purpose policy | Qualified generative AI model | Model/version/seed/parameters/candidate media + provenance | Generated clips are footage of real product operations or validated physical results |
| `EXPERIENCE_FIXTURE_SIMULATION` | Developer/definition fixtures | `libs/media-experience-simulation` | Clearly labeled PDP/Explorer simulation states only | Product runtime qualification or scientific simulator correctness |

The final playable video or interactive package is a **derivative representation** of one or more of these sources. It must carry source classification and a *separate* proof object for authoritative product behavior, scientific claims, and media quality. No single success badge is allowed to collapse those three proof types.

### 18.1 Preserve existing Media structures

The existing four **logical consumer surfaces** remain the only additional Recorder/Studio logical nodes:

| Logical surface | Existing parent | Expanded responsibility | No duplication rule |
|---|---|---|---|
| `media.surface.recorder-orchestrator` | `media.surface.cli` | Unified declarative ProductionSpec compilation; scene plans; unattended recordings; animation/simulation job DAG; partial regeneration; previews/outputs; batch profile orchestration | Do not create a second job/attempt/state/recipe store |
| `media.surface.capture-adapters` | `media.surface.integrations` | Source probes and qualified browser/desktop/mobile/terminal/API/camera/file recording; event/timestamp/source trust; production input adapters | No fake pixels from headless product traces; no unapproved privileged effects |
| `media.surface.production-studio` | `media.surface.web` | Scene authoring, editable animation, simulation instruments/inspection, storyboard/timeline, voice/audio, typed effects, versioned manual and AI edit operations | Do not create a separate animation/physics Studio project DB or editor authority |
| `media.surface.interactive-demo-player` | `media.surface.embedded` | Sandboxed playback of recorded, animated, generated and model-backed scenes; state/measurement controls, branches and offline bundles | Viewer has no product mutation, scientific model-approval, or learner mastery authority |

Do **not** mint physical surface nodes for speculative packages. Existing physical topology reports 26 candidates; the four logical surfaces inherit those parents until real manifest/ownership/deployability and applicability evidence justify a physical registration. The historical 200 PDP cells and proposed 216 successor cells remain distinct until exact source-current admission. The 13 proposed Studio workspace pages and existing 52 typed manual edit discriminants remain authoritative for source-level design.

### 18.2 The two consumers give us proof of platform reuse

**Gharbatai** is first Recorder/Studio dogfooding: product-neutral reusable capture moves only after a source/file inventory, dependency cut and accepted handoff; Gharbatai stays owner of journeys, KYC/client/portfolio business effects, credentials, fixtures, seed data and post-action readback. One clean `@ghatana/experience-recorder` producer/consumer adapter may bridge during migration; do not copy both into competing engines.

**TutorPutor** is the flagship animation/simulation consumer: it is already **simulation-first** and already owns an AEF (Experience IR / Model IR / Scene IR, plus runtime packages), renderer/physics/animation/authoring/export code, learning evidence, model-family/domain meaning and scientific fidelity. Media should **adopt only generic media presentation, capture/animation/rendering, unit-safe time mapping, production composition, optional qualified general solver adapters, and machine/GUI edit operations**. TutorPutor continues to own learning intent, model/domain validity and solvers if their scientific semantics are product-specific, lesson metadata, learner privacy, mastery/assessment, curriculum, content release/rollback and its public authoring/product API. Do not import `@tutorputor/*` private internals from Media, nor move its current product writer without a separately agreed dependency-free public contract.

## 19. Canonical declarative contract family: compiler, not arbitrary scripts

The following are **proposed shape names**, not new registered public API identities: `ProductionSpec`, `CaptureSceneSpec`, `AnimationSpec`, `SimulationSpec`, `ExperienceBinding`, `RenderProfile`, `SourceEvidenceRef`, `CompiledProductionPlan` and `ProductionReceipt`. Map them to existing `media.domain.recipe`, `media.domain.processing-graph`, `media.domain.resolved-plan`, `media.domain.project-revision`, `media.domain.scene-graph`, `media.domain.simulation-world`, `media.domain.checkpoint`, and existing operation registries; add *new meaning* only if no compatible semantic owner exists.

### 19.1 Typed compilation pipeline

```text
Creator YAML/JSON, UI form, SDK/CLI/API or LLM proposal
  -> explicit schema/version and typed AST validation
  -> source resolution + rights + consent + actor + model/codec/license qualification
  -> semantic validation of scene graph, units, clocks, solver/model, valid ranges
  -> immutable MediaProject source revision + typed operations + derived processing DAG
  -> actor-approved/allowed media Job + leased Attempt + bounded provider/solver/recorder adapters
  -> immutable captured/model/animation/voice assets + semantic and metric readbacks
  -> manual Studio or agent's same typed commit API with CAS and manual locks
  -> deterministic/tolerance-qualified render + output QA + governed delivery/receipt
```

Inputs must be constrained by JSON Schema/Zod-like discriminators with explicit versions. An LLM can propose **data**, not eval-able TypeScript, arbitrary Python, shell commands, or user-provided shader programs. A separately admitted plugin may execute trusted code in a resource-isolated runtime using signed, pinned artifacts and an independently declared execution authority; this is *not* the default declarative specification language.

### 19.2 Data schema obligations

Each spec records identity and purpose, exact author/actor/tenant, immutable source/project revisions, scene order, semantic object refs, original assets, rights/license/data-residency profiles, output/a11y/locale/render variants, qualified adapter capabilities, versioned model and solver, a deterministic seed/PRNG version where applicable, quality profile, allowed manual locks, and typed failure/recovery outcomes. Every child asset uses semantic dependency fingerprinting, not a foreign commit SHA as runtime truth.

Each scene is a discriminated union of `capture`, `animation`, `simulation`, `generated`, `imported` and `composition`; a composition can contain any other kind with explicit clock and coordinate mapping. A `capture` may include deterministic cursor/highlight overlays; it does not turn into `MODEL_SIMULATION`. An `animation` may visualize simulation outputs; that does not promote its solver from F2 to F3.

**Clock separation:** `t_source`/source PTS, `t_media` output/editor rational time, `t_audio` stream sample index, `t_story` explanation time, `t_sim` model execution time, and `t_wall` operational time are separate typed domains. A conversion requires explicit source/destination clock identity, origin, rate or mapping (including VFR), rounding/loss policy and *permission for coupling*. Pause/scrub in story or Media timeline must not accidentally mutate simulation state. Fixed-step export uses a declared mapping from simulated time into rendered frames; wall-clock scheduling cannot be its implicit clock.

**Rendering is not modeling:** select visual Level of Detail independently from simulation fidelity F0–F4. Reducible GPU quality must not silently substitute a different scientific model, solver, timestep, units, or validated result. Where native hardware is insufficient, choose a qualified server/headless mode, a semantically valid lower-visual-complexity renderer, or `UNAVAILABLE` with a recovery suggestion—not a fabricated successful simulation.

### 19.3 Example A — unattended, source-grounded recorded demonstration (illustrative only)

```yaml
apiVersion: ghatana.media/v1-proposal
kind: Production
metadata: {projectRef: gharbatai-onboarding-demo, purpose: verified-product-demonstration}
sourceRefs:
  scenario: gharbatai:scenario/onboarding@v2
  storyboard: gharbatai:storyboard/onboarding@v1
scenes:
  - id: real-onboarding
    kind: capture
    capture:
      adapter: browser-qualified
      sourceProfile: web-desktop
      productActionPlanRef: gharbatai:journey/qualified-onboarding
      requireAuthoritativeEffectReadback: true
      cleanup: fenced-owned-fixtures-only
      eventTracks: [mouse, keyboard, scroll, cursor, source-time]
    overlays:
      - kind: cursor-highlight
        fromEvent: target-click
      - kind: declarative-animation
        animationRef: media:recipes/feature-callout@v1
    narration:
      scriptRef: gharbatai:script/onboarding-en@v1
      voiceProfileRef: consented-narrator@v1
    whenUnavailable: reject-scene-with-reason
production:
  recapture: changed-scenes-only
  keepManualEdits: true
  policy: no-unapproved-egress
outputs: [landscape-1080p, vertical-captioned, interactive-sandboxed]
verify:
  - source-action-owner-readback
  - decode-and-timestamp-check
  - signed-provenance-and-rights
  - exact-source-revision-at-publish
```

The schema labels above are **examples**; no live route or TTS engine is claimed. Product readback must name a real API/DB owner observation, not a synthetic HTTP-success check. Interactive viewer controls cannot replay privileged onboarding or infer KYC success.

## 20. Declarative animation: source-data-first, renderer-neutral and editable

### 20.1 Model and required capabilities

`AnimationSpec` is a signed/versioned asset specification, not a video clip as source of truth. It binds a semantic scene graph (objects, groups, typed properties, anchors, units/coordinate space), property tracks and timed transitions, easing curves, optional procedural rules, narration and audio cues, camera/lights, visual styles, accessibility semantic shadow and output profiles. A compiled animation can be previewed live or rendered with the same semantic plan.

**Required primitive families:** SVG/Canvas/DOM shapes, text/math/LaTeX or accessible math, charts/graphs/tables, units/probes/vector arrows, algorithm tracing, typed keyframes/easing/spring dynamics, morph/path animation, transforms, masks/constraints, camera pan/zoom/3D tracks, rigging/skeletal animation, layout reflow and safe-area variants, particle/procedural graphics, data-binding overlays, subtitle/song/speech-beat synchrony, material/lighting/shader adapter only if admitted, interactive triggers/hit regions, reusable templates/brand styles, side-by-side comparison, storyboard-to-timeline, and still/video/vector/glTF/Lottie-type exports with explicit loss reports.

**Meaning preservation:** an arrow that represents acceleration binds to `model.observables.acceleration` and a vector unit; rotating the arrow for visual emphasis cannot quietly change the measurement. For educational content, the semantic accessibility output can describe the quantity independently from what a shader does.

**Studio edits:** preserve existing 52 manual operation kinds, exposing keyframe and graph editors, object inspector, scene/asset browser, consistent undo/redo, keyboard numeric property entry, locked animation regions, render-preview parity and headless typed equivalents. A new operation discriminator is added only after PDP-1 owner review proves the existing kinds cannot express the semantic effect.

**Responsive/accessibility requirements:** ratio/crop transitions cannot hide required variables, captions, equations, brand/legal overlays or learner answer choices. Every important animated change has a semantic state/timed narration alternative; reduced-motion may freeze transitions while retaining information and pedagogical meaning.

### 20.2 Candidate permissive OSS adoption

| Technology | License posture | Adopt selectively for | Important boundary |
|---|---|---|---|
| [Motion Canvas](https://github.com/motion-canvas/motion-canvas) | MIT repository | Timed procedural educational vector rendering, narration-linked animations | Native authoring is TypeScript/generators, *not* a safe untrusted declarative AST. Build a bounded compiler/adapter; no arbitrary generated TypeScript execution. |
| [Manim Community](https://github.com/ManimCommunity/manim) | MIT source code | Off-line mathematical/explanatory render worker, math scenes | Python/dependent TeX/FFmpeg/binaries/assets need separate admission; do not expose raw user Python. |
| [Theatre.js core](https://github.com/theatre-js/theatre) | Apache-2.0 core | Property sequence/runtime interpolation | `@theatre/studio` is **AGPL-3.0**; do not embed Studio into strict permissive bundle. Implement our own Media inspector/editor. |
| [Three.js](https://github.com/mrdoob/three.js), [PixiJS](https://github.com/pixijs/pixijs) | MIT project sources | 3D/2D renderer backends | Their scene/raster APIs are adapters only, never canonical Model IR. |
| [OpenTimelineIO](https://github.com/AcademySoftwareFoundation/OpenTimelineIO) | Apache-2.0 | Import/export timeline interchange | Export loss metadata and versioned mappings; never overwrite canonical MediaProject. |

Any third-party code *copied or embedded* requires pinned revision, per-file SPDX/license/NOTICE provenance, recursively audited dependency graph, browser/native codec review, model/asset license audit, security review, conformance tests and independent supported platforms. Strict permissive distribution does not automatically permit prebuilt FFmpeg/TeX/AGPL components.

## 21. Declarative simulation: executable model truth, not animated storytelling

### 21.1 Model-first contract and solver controls

`SimulationSpec` references exact versioned **Model IR** and separate visual **Scene IR**. Model IR owns domain/phenomenon, state variables and update equations or transition rules, units, initial/boundary conditions, admissible parameter ranges, constraints/invariants, events, observables, a qualified solver/version/config, model limitations and scientific/source review. Media's current P1 `simulation-world`, `resolved-plan`, `media-run`, `checkpoint` and J-14 operations are candidate identity/operation authorities; the spec cannot create an unrelated simulation ID space. For TutorPutor, the domain Model IR and scientific/pedagogical endorsement remain TutorPutor-owned via public versioned contracts.

**Execution modes:** exact symbolic/discrete and state-machine traces; discrete-event queues; numerical ODE/dynamical systems; 2D/3D rigid-body/collision; approved specialized soft-body/rope/cloth/particle/fluid; stochastic and agent-based models; graphs/algorithms, economics, biology, chemistry or medicine only with domain-appropriate scientifically qualified model packs; approved remote/HPC/native solvers if local bound exceeded. Do not promise validated quantitative behavior for any specialized family lacking its validator and solver admission. Rendering at interactive framerate and simulation stepping may have different rates.

**Formal run semantics:** `DRAFT -> VALIDATED -> ADMISSION_CHECKED -> QUEUED -> RUNNING -> (PARTIAL | FAILED | TERMINATED | COMPLETED | OUTCOME_UNKNOWN)` is an **illustrative lifecycle**, *not a replacement for existing Media job state machine*. Bind every proposed state to existing Media job/result outcomes and refuse fictional state transitions. A request ACK ≠ solver run completion; run completion ≠ scientifically valid result; render completion ≠ delivery authorization. Retry from `UNKNOWN` only after owner reconciliation. Numeric overflow, divergence, invalid units, violated constraints, unbounded runtime and absent solver are typed outcomes, not zero-valued measurements.

**Determinism:** carry `EXACT`, `TOLERANCE_BOUND`, `DISTRIBUTION_BOUND`, or `NON_REPLAYABLE_EXTERNAL`; model+solver builds, timestep control, floating-point/backend, PRNG algorithm/seed, initial/boundary data and event ordering are pinned in the run receipt. Preserve event log + bounded checkpoints and regenerable derivative visual frames instead of persisting redundant every-frame simulation truth. For stochastic models, record statistical intervals and sample counts, not a fictitious deterministic guarantee.

**Validation:** exact analytical solutions where available; invariant/unit checks; timestep convergence and numerical error envelopes; empirical calibration freshness for F4; differential comparison to reference solvers; physical constraints (e.g. collision and conservation laws as applicable); subject-matter review for higher-fidelity claims. A model can be correct as an educational approximation (F2) yet not scientific certification (F3). F0 illustrations must not emit quantitative truth claims.

### 21.2 Simulation interactivity and output

Expose play/pause/step/reset/seek/counterfactual branch only when the execution adapter actually supports them. Controls are typed by Model IR with units, min/max and authority. Offer probe/ruler/vector/graph/spectrum/tables and accessible readings bound to exact observables and run versions. A changed model parameter creates an auditable branch or new run, never retroactively alters an accepted run. Allow batching and parameter sweeps with resource budgets and scientific-comparison reports. Animations may combine model snapshots with explanatory freezes/highlights (`t_story`) while leaving `t_sim` unchanged.

**Delivery variants:** semantic JSON trace; time-series CSV/Parquet where permitted; accessible text/table; interactive Web/React Native experience with declared offline capabilities; video/audio exports and illustrations; **no** exposed raw evaluator code or untrusted scripts in reader bundles. All derived export labels identify source type and fidelity tier.

### 21.3 Permissive solver/render candidates

| Technology | Verified general licensing direction | Candidate scope | Guard |
|---|---|---|---|
| [Rapier](https://github.com/dimforge/rapier) | Apache-2.0 | WASM/native rigid-body physics backend | JavaScript bindings now live under main Rapier repository; verify packaged binary version and numerical behavior. |
| [Box2D](https://github.com/erincatto/box2d) | MIT/Zlib-style upstream licensing by version (verify exact lock) | 2D rigid-body dynamics and joints | Choose one canonical physics adapter for an admitted profile; don't silently mix engine outcomes. |
| [SimPy](https://simpy.readthedocs.io/en/stable/about/license.html) | MIT | Discrete-event/queue/process simulation workers | Trusted Python worker only, sandbox and resource caps; does not replace domain model truth. |
| [SciPy](https://github.com/scipy/scipy) | BSD-3-Clause | Numerical reference solutions and scientific ODE/integration worker | Pin BLAS/backend and floating-point tolerance; validate each qualified model family. |
| [Three.js](https://github.com/mrdoob/three.js) / [PixiJS](https://github.com/pixijs/pixijs) | MIT | Visual representation of model state | Never substitute renderer physics or presentation state for scientific authority. |

Platform and model-support data flow through existing public AI Inference, Shared and Data Cloud boundaries. Solvers are chosen through a versioned capability profile; they do not get generic rights to learner records, external data exfiltration or publication. Native/inference dependencies and model weights are independently reviewed. New physics/solver packages are *not* created automatically until actual build/deployment boundary and closure applicability are established.

### 21.4 Example B — TutorPutor educational model-backed scene (illustrative only)

```yaml
apiVersion: ghatana.media/v1-proposal
kind: Production
metadata:
  projectRef: tutorputor/force-motion-lesson
  purpose: interactive-educational-experience
consumer:
  product: tutorputor
  experienceRef: tutorputor:aef/force-and-motion@2
  contractProfile: tutorputor-aef-public-v1-proposal
scenes:
  - id: explain-newtons-second-law
    kind: simulation
    simulation:
      modelRef: tutorputor:model/constant-force-1d@1
      fidelity: F2  # educational quantitative; not scientific certification
      solver:
        profileRef: exact-analytic-1d-v1
        step: {numerator: 1, denominator: 120, unit: s}
      parameters:
        mass: {value: 2, unit: kg}
        force: {value: 6, unit: N}
        startVelocity: {value: 0, unit: m/s}
        duration: {value: 2, unit: s}
      observables: [acceleration, velocity, displacement]
      runMode: deterministic-fixed-step
      allowControls: [force, mass, step, reset, compare]
      modelClockId: lesson-force-sim
    scene:
      sceneRef: tutorputor:scene/force-vector@1
      bindings:
        - {object: cart.position, observable: displacement, displayUnit: m}
        - {object: forceArrow.magnitude, observable: force, displayUnit: N}
        - {object: meter.acceleration, observable: acceleration, displayUnit: m/s^2}
      story:
        - {at: {numerator: 0, denominator: 1}, action: predict-first}
        - {at: {numerator: 1, denominator: 1}, action: reveal-model-measurements}
      accessibility: {semanticState: required, reducedMotionAlternative: required}
    validation:
      reference:
        acceleration: {value: 3, unit: m/s^2}
        velocityAt2s: {value: 6, unit: m/s}
        displacementAt2s: {value: 6, unit: m}
      assessmentOwner: tutorputor
outputs: [interactive-semantic-bundle, accessible-explanation-video]
policies:
  externalModelEgress: deny
  classification: model-simulation
  learnerEvidenceOwner: tutorputor
```

**Mathematical check for this example:** constant F=6 N and m=2 kg gives a=F/m=3 m/s², v(2)=a·2=6 m/s, displacement from rest x(2)=½a·(2)²=6 m. A solver adapter must reproduce those observables under its declared error class. The instructional *prediction* and learner's recorded explanation remain owned/assessed by TutorPutor; Media only returns the qualified model trace and presentation derivative. The `step` field is a solver declaration, not license to advance the model while the video/story is paused.

## 22. TutorPutor AEF interoperability: cross-repo SRP contract

### 22.1 Actual upstream assets and where to map them

| TutorPutor existing authority/code | Media integration | Keep TutorPutor ownership |
|---|---|---|
| `contracts/v1/experience/` — AEF Experience IR, Model IR, Scene IR, fidelity, runtime | Versioned **public adapter** mapping, avoiding private imports | Learning goals, pedagogical flow, evidence, scientific model and assessment obligations |
| `libs/tutorputor-simulation/src/aef/` — renderer/solver-neutral AEF adapters, animation compiler, scene runtime, recipes | Compare algorithms/components for possible isolated generic extraction to Media after compatibility and boundary review | Current operational package stays until supported migration; no duplicate fork maintained |
| `contracts/v1/artifact-manifests/animation-manifest.ts`, `contracts/v1/simulation` legacy USP | Explicit legacy read/convert path with stable semantic loss/disposition | Historical TutorPutor content replay, manifest interpretation and content release |
| `services/tutorputor-platform/` | Media consumes authorized public processing request, returns typed result/artifact refs | Learner state, institutional/tenant policy, attempt/evidence/mastery and final product authorization |
| `services/tutorputor-content-generation/` | Requests draft Media clips/scenes from public model; receives bounded suggestions | Content authoring, review/autonomy policy, approval, rollout and rollback |
| Web/mobile learner/player | Published, signed Media semantic/interactive assets and adapters, offline variants | Interaction semantics, learner analytics/evidence and app-store/mobile compatibility |

**Crosswalk types:** `TutorPutor Model IR -> version-pinned SimulationSpec model reference`; `TutorPutor Scene IR -> Media semantic Scene/Animation graph` with explicit unit/time/coordinate transforms; `TutorPutor Experience IR -> Media production recipe/presentation binding only` (pedagogy retained); `TutorPutor interaction -> Media local typed simulation command and back to TutorPutor learner evidence only through its public API`; `Media output -> immutable TutorPutor content package reference` after TutorPutor's own publication gates.

**No fork and no circular imports:** Media depends only on public, independent source artifacts or separately published generic protocol packages, never `products/tutorputor` implementation packages. TutorPutor may consume `@ghatana/media` published APIs/SDK or signed runtime assets. While that public boundary is unavailable, use bounded test-only adapters; do not reclassify them as `PRODUCTION_READY`.

**Runtime/data disclosure:** learner profile/history must be minimized or normalized into an audience preset and must not be part of a distributable Media asset. Learner evidence, assessment, mastery and credential changes are *never* Media product mutations. Events from an embedded simulation are candidate evidence and require authoritative TutorPutor validation. Video watchers cannot invoke TutorPutor privileged actions from a generic hotspot.

### 22.2 Fidelity and rendering examples beyond physics

At least six independent samples must exercise the AEF bridge: (1) 1D F2 force/motion with analytical oracle; (2) graph traversal/state machine with EXACT replay and no fictitious physics; (3) discrete-event queue with time unit and event-order proof; (4) chart/data storytelling with no model simulation (pure animation); (5) qualitatively illustrative chemistry/biology scene F0–F1 with no unqualified numerical claim; (6) mobile keyboard/screen-reader reduced-motion interactive experiment with TutorPutor-owned predict/measure/explain evidence. Add one negative model with invalid units, a solver divergence, stale model revision and offline-unavailable capability. A single nice physics animation is insufficient to claim a reusable engine.

## 23. Cross-source PDP0–3 authoring plan (do not bypass current gates)

The current repo already has Media's capability grammar and `J-13` animate 3D / `J-14` domain simulation journeys. Reconcile all new feature intents against **existing** source IDs first. The v2 428-feature inventory remains a proposal; this extension adds a scoped inventory (see companion JSON). **No newly minted canonical Media requirement ID is authorized by this review.**

| Phase | Exact owner/source files to inspect/change when semantically necessary | Concrete update | Qualification before leaving phase |
|---|---|---|---|
| **PDP-0** | `pdp-0-product-truth/{requirements.yaml,capabilities.yaml,time-units-fidelity.yaml,quality-policy.yaml,recorder-studio-extension.yaml}` | Map demo/animation/simulation goals, modes, fidelity tiers, source-vs-model evidence, actor duties, trust and availability into existing capability leaves; ensure simulation and animation cases do not incorrectly inherit Recorder-only cases | Exact impacted leaf/currentness, safe negative tests, canonical requirements, new meanings admitted only through accepted source change |
| **PDP-1** | `pdp-1-domain-data/{domain-objects.yaml,value-objects.yaml,operations.yaml,states.yaml,recorder-studio-contracts.yaml}` | Bind `ProductionSpec/AnimationSpec/SimulationSpec` to existing recipe/graph/project/run/simulation-world/checkpoint, typed plan/submit/inspect outcomes, model/solver/units/fidelity/clock mappings; preserve CAS/fencing/idempotency/UNKNOWN | No duplicate store/operations, exact operation results and validation; local fixture simulation explicitly separate from scientific run |
| **PDP-2** | `pdp-2-design-interface-system/{animation-simulation-grammar.yaml,recorder-studio-interface.yaml,component-contracts.yaml}` and existing Media design system | Studio animation inspectors and simulation instruments with keyboard/CLI/SDK parity, semantic state/units/time, reduced motion and protected crop; reuse 13 pages; no fake GUI for headless tools | GUI/machine semantics and accessibility match P1; exact no-physics-from-render rule, no hidden script execution |
| **PDP-3** | `pdp-3-product-experience/{journey-contracts/animate-3d-scenes-and-characters.yaml,journey-contracts/explore-domain-simulation-and-review-measurements.yaml,recorder-studio-experience.yaml,screen-contracts/explore-simulation.yaml}` plus existing action/screen/journey/fixture/Explorer registry | Complete real scenario walk-throughs, model/animation authoring and preview, scientific validation/failure/recovery, render export and embedded interaction, appropriate 13 Studio page bindings and CLI/API outcomes | Source-correct step/action/typed-result/denial/UNKNOWN/fixture & readback, exact current 216-cell applicability or authoritative successor and Explorer parity |

Run native checkers and actual source-gen/readmission on a complete checkout before claiming any successor phase `DEV_COMPLETE`. Snapshot counts (462 leaves, 84 Recorder acceptance cases, 52 editing discriminants, 216 proposed cells) are **historical/source-denominator observations**, not assertions that a new domain-specific simulation acceptance case already exists. Keep 26 physical candidates until real executable manifest evidence exists. Freeze the accepted PDP handoff before Build Plan Implementation is entered; historical artifacts and previously completed unaffected phases remain preserved.

## 24. Concrete Build plan: one vertical at a time

Map to existing **PBI-00…PBI-15** (and the prior v2 M-00…M-15 plan) instead of creating another competing orchestration/verification scheduler. Within Build, run narrowly scoped independent qualification lanes while upholding stage admission.

| Package / task | Where; implementation | Proof / stop condition |
|---|---|---|
| **DAS-01 Definition-to-Build bridge** (PBI-00/02) | `.product-experience`, `docs/implementation`, generator scripts and contract clients: assign every Recorder/animation/simulation capability to its exact PDP source, PBI owner and scenario | Missing exact source ID or changed scope causes actionable `BLOCKED`, not green generated manifest |
| **DAS-02 Compiler and typed IR** (PBI-02/10) | Existing Media project/recipe/resolved-plan owners + types/SDK: schema AST validator; pipeline DAG; typed `capture/animation/simulation` discriminants | Round-trip/unknown-schema, unsafe-expression, missing version/source, partial invalidation and CAS tests |
| **DAS-03 Real Recorder vertical** (PBI-03/04/05/06/10/11) | Existing Media recorder adapters + Gharbatai consumer-qualified source capture; product readback and scene re-capture | One real, decoded, narrated, capturable film from actual scenario with non-simulated product receipt; authorized lease cleanup |
| **DAS-04 Declarative 2D animation** (PBI-10/11) | Existing Studio scene graph + approved SVG/Canvas/Three adapters; textual math/graph scene + keyframes | A declarative animated lesson and branding/title scene render identically within profiled tolerances across headless/editor; accessible semantic output |
| **DAS-05 Voice and animated narration** (PBI-07/08/10) | Existing governed Piper/Whisper adapters and qualified voices; timed text/speech and motion mapping | Only changed phrase rerenders; captions/motion preserve audio sample mapping and locked manual edits |
| **DAS-06 Model IR bridge and first solver** (PBI-09/10/12) | Public TutorPutor AEF compatibility adapter -> existing Media simulation-world/run/checkpoint; trusted exact/JS/WASM solver | F2 analytic unit-reference case plus EXACT graph/state-machine trace; unsupported solver typed unavailable |
| **DAS-07 Interactive scientific scene** (PBI-10/11/13) | Existing `explore-simulation` screen and interactive player: control/measurement/branch/state semantic shadow | Force/mass changes correct model observable, A/B state isolation, keyboard/mobile/screen-reader, no unapproved mastery mutation |
| **DAS-08 Advanced solver matrix** (PBI-10/14) | Conditionally qualified Rapier, SimPy, SciPy, and other domain/solver-specific workers, no premature duplicate packages | Per family F0–F4/invariants/uncertainty, numerical drift, resource limits and reproducibility receipts |
| **DAS-09 Studio full edits/interchange** (PBI-10/11/12) | Existing 52 edit operations, same CAS path for manual/agent; render profile/interchange adapters | Edit/undo/redo/lock/reopen, GUI/CLI/API parity, no double project/version authority |
| **DAS-10 Fan-out and selective regeneration** (PBI-05/10/14) | One source DAG outputs 16:9/9:16, narrated dubbed variants, videos plus interactive bundles | Input or model change rerenders only descendants; unaffected semantic hashes retained; no stale published manifest |
| **DAS-11 Governance / QA** (PBI-13/14/15) | Rights, consent, model/solver/codec license policy, security, output fidelity and observability | Real renderer/profile and model-run QA, OTel traces redacted, license manifest admission, denied/unknown/retry tests |
| **DAS-12 Controlled dogfood and migration** (PBI-14/15) | Gharbatai Recorder film, TutorPutor AEF/public package consumer, reversible canonical runtime cutover | Both consumers pass independently; Gharbatai business receipt, TutorPutor scientific/learner contract, no unauthorized writer switch |

A missing GPU or unqualified F3 model must **not** block a working CPU-first screencast/2D animation/F0 educational illustration. But that fallback must remain visibly unavailable for the higher-fidelity claim; never reduce required behavior to a fake success and declare the whole product Build-complete.

## 25. Falsifiable end-to-end acceptance and hazards

### 25.1 Minimum product demos and scientific oracles

| ID | Test | Required result |
|---|---|---|
| `DAS-A01` | Gharbatai seeded recording with 2 authorized business actions, product readbacks and exact ownership cleanup | Captured film reproduces observed state; run and film are not accepted without independent product and codec QA |
| `DAS-A02` | Real browser capture vs API-only journey | Browser has qualified pixels/cursor tracks; API-only has generated explanatory visual *clearly marked*, never fake captured UI |
| `DAS-A03` | Declarative text/graph/mathematics animation at 16:9 and 9:16 | Bounds/units/semantic shadow and equation content preserved, no protected-crop loss |
| `DAS-A04` | Replay animation at arbitrary t_story and after undo/redo | Same canonical revision renders same semantic state, no wall-time dependence or hidden side effect |
| `DAS-A05` | F2 constant force model (m=2 kg, F=6 N, t=2 s) | a=3 m/s²; v=6 m/s; displacement=6 m, within exact declared tolerance |
| `DAS-A06` | F2 with mismatched unit, negative invalid mass, huge input, missing solver | Typed reject/UNAVAILABLE, no zero default or forged measurement |
| `DAS-A07` | Learner pauses explanation while simulation was at t_sim=0.75s | t_sim remains unchanged; story annotation updates without model mutation |
| `DAS-A08` | Exact state-machine model replays and forks after checkpoint | Same events and seed give same result; branch independent with preserved initial run and source identity |
| `DAS-A09` | Stochastic agent-based model with two seeds | Only statistical/tolerance claims according to declared reproducibility class; not falsely bit-identical |
| `DAS-A10` | Science validator reports non-convergence/limit breach after visually smooth scene | Output remains non-qualified or blocked; visual quality cannot override scientific outcome |
| `DAS-A11` | AI edits a product demo containing protected frame and educational model scene | Same typed Media edit-operation/CAS/actor policy used; no protected manual edit lost |
| `DAS-A12` | Partial voice/animation recompile from changed narration phrase | Unaffected DAG child hashes and manually locked regions preserved; aligned caption/animation time revalidated |
| `DAS-A13` | TutorPutor product receives edited interactive media package | Learner/assessment/credential authority remains TutorPutor; Media only owns derived media, code/mobile/offline profile admitted |
| `DAS-A14` | Accessibility: reduce motion, keyboard control, 400% zoom, high contrast and screen reader | Semantic quantities, focus, step/probe equivalents visible/announced; no canvas-only required state |
| `DAS-A15` | Privacy/security/licensing negative matrix | No unauthorized file/network/model egress; no GPL/AGPL/conditional model dependency in strict permissive bundle |
| `DAS-A16` | Job failure, stale attempt, user cancel, publish timeout, worker restart | Current job identity and fencing; UNKNOWN not replayed blindly; no false terminal result |
| `DAS-A17` | CPU/no-WebGPU, supported GPU, mobile/offline, large scene | Per-profile capability and performance truth, semantically correct fallback/UNAVAILABLE; bounded memory and power |
| `DAS-A18` | Render export/import/reopen with audio narration, animation, simulation and captions | Fidelity/codec/clock conversions reported, source time preserved, typed project remains editable |

### 25.2 Additional scientific/semantic cross-cutting controls

- **Model validity:** test reference analytical cases, numerical stability vs timestep, unit dimensional analysis, chaotic/unreplayable classifications, validity domain, sensor-to-observable binding, parameter restrictions, and reviewer-authorized model versions. An F2 teaching approximation cannot claim F3/F4 publication or clinical/engineering-grade validation.
- **Source truth:** distinguish exact source captured from a live system, generated illustration, simulated model, and mock Explorer state with persistent provenance labels. Neither a provider's `200 OK` nor a synthetically generated frame is evidence that a business workflow finished.
- **Privacy and safety:** ensure rights to cloned voices, copyrighted lesson content, model weights, generated backgrounds, faces and biometric/reference voice samples. Recorder cameras/microphones require consent; prompts/AST/imported assets must be treated as hostile. Learner PII cannot be copied into public Media artifacts; model inference egress requires per-purpose admission.
- **Efficiency/scalability:** event/checkpoint storage over redundant high-frequency frames; content-addressed cache by exact source + model + policy; proxy previews; output-only materialization; worker isolation; CPU/GPU/VRAM priority queues, cancellation and cache evictions; known time/VRAM/power budgets; bounded replay and resumable derivation.
- **No hidden duplicate authority:** Studio, Recorder, interactive player and TutorPutor AEF cannot each publish their own project/editor/job/solver truth. The official product/API/Domain owner remains identified per semantic write. Cross-repo code relocation requires source-compatibility and migration tests, not filename copy alone.

### 25.3 Stage gates and acceptance ownership

**Discovery:** author/validate impacted PDP0→PDP1→PDP2→PDP3 source in order; exact accepted status/source currentness for all affected surface cells; unimpacted leaves remain closed; regenerate dependency projections once; verify Explorer sync. **Build Plan Implementation:** produce unique package/owner/test mapping and dependency/source locks; only enter with real Discovery exit. **Build implementation:** run real Recorder + animation + simulator verticals, native build/tests/benchmarks; enable engines only after exact license/rights/hardware qualification. **Independent product acceptance:** separate scientific validator signoff, Gharbatai film acceptance, TutorPutor pedagogy/evidence acceptance and Media media-quality acceptance. **Delivery and runtime migration:** remain independent, reversible and explicitly authorized under MIG-04; a merged planning PR is not a source writer transfer.

## 26. Decisions and exact source anchors

**Binding source anchors inspected:**

- `samujjwal/ghatana-media/.product-experience/pdp-0-product-truth/recorder-studio-extension.yaml`, `capability-preservation-crosswalk.yaml`, `time-units-fidelity.yaml`.
- `samujjwal/ghatana-media/.product-experience/pdp-1-domain-data/domain-objects.yaml`, `recorder-studio-contracts.yaml`; authoritative P1 `operations.yaml`, `value-objects.yaml` to be checked at authoring time.
- `samujjwal/ghatana-media/.product-experience/pdp-2-design-interface-system/animation-simulation-grammar.yaml`, `recorder-studio-interface.yaml`.
- `samujjwal/ghatana-media/.product-experience/pdp-3-product-experience/screen-contracts/explore-simulation.yaml`, `journey-contracts/explore-domain-simulation-and-review-measurements.yaml`, `simulation-semantics.yaml`.
- `samujjwal/ghatana-media/docs/implementation/MEDIA-RECORDER-STUDIO-PDP3-SUCCESSOR-EXECUTION-2026-10-17.md`, `MEDIA-BUILD-COMPLETE-PRODUCT-PLAN-2026-10-15.md`.
- `samujjwal/ghatana-products/products/tutorputor/docs/architecture/experience-fabric/{REQUIREMENTS,CONTRACTS_AND_IR,IMPLEMENTATION_PLAN}.md` and `docs/architecture/specs/SIMULATION_ENGINE.md`; code under `contracts/v1/experience/` and `libs/tutorputor-simulation/src/aef/`.

**Upstream reuse candidates:** [Motion Canvas MIT](https://github.com/motion-canvas/motion-canvas), [Manim MIT](https://github.com/ManimCommunity/manim), [Theatre.js Apache core + AGPL Studio](https://github.com/theatre-js/theatre), [Rapier Apache](https://github.com/dimforge/rapier), [SimPy MIT](https://simpy.readthedocs.io/en/stable/about/license.html), [Three.js MIT](https://github.com/mrdoob/three.js), [PixiJS MIT](https://github.com/pixijs/pixijs). Existing Voicebox/OpenReel/FireRed and model licenses from earlier sections remain applicable.

**Final review disposition:** `MEDIA-DECLARATIVE-PRODUCTION-PLANNED_SOURCE_RECONCILIATION_REQUIRED`. The intended product scope is now explicit for autonomous real demo recording, general-purpose editable declarative animations, genuinely model-backed declarative simulations, TutorPutor learning integration and their composition. This is a **planning correction** that neither creates unseen PDP IDs nor establishes runtime, scientific, or delivery admission.