# Media declarative production: Recorder/Studio, animation and simulation — integration plan

**Date:** 2026-10-17
**Status:** PLANNING_ONLY / SOURCE_RECONCILIATION_REQUIRED; not an authorized new PDP source identity, phase exit, Build admission, licensed provider, film approval, scientific validation, runtime migration or release.
**Repository baseline:** samujjwal/ghatana-media@fd7992d890e904f5276a68114be989ea2fcb11b5.
**Audience:** Media product, Recorder/Studio, animation/simulation, integrators for Gharbatai and TutorPutor.

## 1. Decision and scope

Media is one versioned, local-first, data/configuration-driven voice, video, recording, animation, simulation and interactive production system. It must support both unattended execution from YAML/JSON/CLI/API/SDK and full manual Studio editing on the same MediaProject revision and typed operation history. AI agents may only propose or apply admitted typed operations; they cannot own an alternate project, invoke untrusted executable scripts, bypass actor/rights/consent or override manual locks.

Three explicit first-class production workflows:

1. **Real Recorder / demo:** source-grounded recording of authorized real browser/desktop/mobile/camera/microphone or headless API/CLI journeys, with authoritative product outcome readback, source time, structured action receipts, narration, overlays, exact scene recapture, quality and permitted delivery. Gharbatai is the first qualified dogfooding consumer.
2. **Declarative animation:** renderer-neutral semantic scene graph, assets, geometry, 2D/3D and math/diagram/algorithm visuals, keyframes/easing, camera, rigs, overlays, audio sync, reusable style skills, animation templates, procedural/particle content, numerical property controls, accessibility semantic shadow, responsive and exported versions.
3. **Declarative simulation:** model-backed execution driven by immutable model/solver versions, typed equations/rules/parameters/units, initial/boundary conditions, independent t_sim clock, constrained observable bindings, F0–F4 validity, determinism class, replay/checkpoint/counterfactual, graph/probe/measurement instruments, reference validation, scientific error reports, and interactive or rendered outputs. TutorPutor is the reference educational consumer.

Media-generated clips, scientific model runs, real product screenshots, and Developer Experience Explorer fixture simulations carry **different provenance/validation classifications**. A visually plausible or photorealistic render does not establish product effect or scientific truth.

## 2. Reuse current source authorities; do not make fictitious packages

Media PR #10 is already **merged** (2026-10-17; merge SHA 107b3324beca07644433ae0ca6fbbbc9cf82115c). Preserve four logical consumer surfaces and parents:

| Logical surface | Parent | Intended responsibilities |
| --- | --- | --- |
| media.surface.recorder-orchestrator | media.surface.cli | Declarative compiler/recipe, unattended capture, animation/simulation job plan, selective scene recapture and batch variants |
| media.surface.capture-adapters | media.surface.integrations | Qualified source probes, device/browser/headless capture, source event provenance and time mapping |
| media.surface.production-studio | media.surface.web | Shared timeline/editor, voice/audio, 2D/3D scene authoring, simulation instruments/inspection and quality |
| media.surface.interactive-demo-player | media.surface.embedded | Safe playback/interaction, branches, model-controlled displays, accessible and offline variants, no privileged product mutation |

The current physical topology authority is .product-experience/surfaces/media-physical-topology.v1.json (26 manifest candidates). Four additions are *logical* consumers, not four physical build packages. Existing 7 compositions + 17 historical consumers + 26 physical = 50 historical identities, 200 PDP phase cells; four more logical consumers produce 54/216 **proposed**, not accepted cells. No physical package is added without real path/manifest/build coordinate/deployability, owner, consumer contract and PDP applicability.

Keep 52 PDP-1 discriminated manual edit kinds (same edit CAS, keyboard/text, CLI/SDK/API), 13 proposed Production Studio pages, 84 Recorder acceptance scenarios and existing Media project/job/revision/rights authorities. More feature targets may require finer acceptance, but never duplicate identities just to inflate counts.

## 3. Canonical domain and clock requirements

Map proposed ProductionSpec, CaptureSceneSpec, AnimationSpec and SimulationSpec as discriminated, typed *specification views* into existing Media recipe, scene graph, processing graph/resolved plan, MediaProject revision, simulation-world, run, checkpoint and job/attempt. No independent simulation job store, recorder job engine, physics project database or voice-side canonical project.

Required clock domains: source PTS/t_source, output rational t_media, audio sample clock, explanation t_story, physical/model t_sim, and operational t_wall. All cross-clock mappings specify identity, origin, rational rate or VFR map, rounding/loss policy, sample priming/padding, and explicit coupling. Pausing or seeking a video/animation must not automatically advance a domain simulation. Changing visual LOD cannot silently change simulation fidelity or solver accuracy.

Simulation run identity must pin model/solver/schema version, valid units, limits, boundary conditions, state, seeded PRNG when applicable, adapter/hardware/numerical profile, fidelity tier F0/F1/F2/F3/F4 and determinism EXACT/TOLERANCE_BOUND/DISTRIBUTION_BOUND/NON_REPLAYABLE_EXTERNAL. Numerical reference/invariant tests and owner review govern scientific claims. Output media QA remains separate. Request ACK, run completion, scientific qualification and publication are separate finalities. For retries from UNKNOWN, reconcile the same logical request before starting another attempt.

## 4. Actual existing sources to extend (only after source-level proof)

| Phase | Existing source and scope | Required reconciliation |
| --- | --- | --- |
| PDP-0 | .product-experience/pdp-0-product-truth/{capabilities,requirements,time-units-fidelity,quality-policy,recorder-studio-extension}.yaml | Reuse media.animation/media.simulation families; add precise video/animation/scientific model capability requirements and negative cases only when truly absent. Distinguish real-capture vs AI vs model proof. |
| PDP-1 | .product-experience/pdp-1-domain-data/{domain-objects,value-objects,operations,states,recorder-studio-contracts}.yaml | Bind typed scene/model/solver/clock/observable/receipt results to existing project, Media Run and Job, CAS and rights/UNKNOWN. No new routes merely because planning source exists. |
| PDP-2 | .product-experience/pdp-2-design-interface-system/{animation-simulation-grammar,recorder-studio-interface,component-contracts}.yaml | Use existing 13 Studio pages, 52 edit operations, keyboard and machine parity, numerical inspector/units/accessibility; avoid fake GUI for API-only consumers. |
| PDP-3 | Existing Recorder successor plus journey-contracts/animate-3d-scenes-and-characters.yaml (J-13), journey-contracts/explore-domain-simulation-and-review-measurements.yaml (J-14), screen-contracts/explore-simulation.yaml and action/journey/fixture/Explorer projections | Complete real semantic step/action/result/denial/recovery, model/scene examples, interactive controls and negative tests. No virtual/disconnected screens. |

Existing libs/media-experience-simulation is **synthetic PDP fixture replay only**, not a scientific solver. Never reuse its "simulation" outcomes as physically validated examples, product action receipts or readiness evidence.

Before claiming Discovery DEV_COMPLETE for affected source cells, run native YAML/schema and semantic checks, exact topology, generator/manifest identity, step/operation parity, Explorer/channel/accessibility tests, phase source currentness and independent owner decision. The planning-only source cannot self-promote to acceptance. Start Build only after actual Discovery exit.

## 5. TutorPutor public integration and SRP boundaries

TutorPutor is a **simulation-first learning system** with existing Adaptive Experience Fabric (AEF) authorities:

- products/tutorputor/contracts/v1/experience/: Experience IR (learning intent/pedagogy/evidence), Model IR (domain science/rules/units/fidelity), Scene IR (presentation objects, controls, instruments, timeline).
- products/tutorputor/libs/tutorputor-simulation/src/aef/: existing animation compilation, model/scene/solver/renderer adapters; preserve instead of a flag-day rewrite or maintained fork.
- products/tutorputor/contracts/v1/simulation/: historical Universal Simulation Protocol compatibility.
- products/tutorputor/services/tutorputor-platform/: learner data, attempts, mastery, product authorization and published content authority.

These exist in samujjwal/ghatana-products, not in a new Media product hierarchy. Design a versioned public compatibility contract: TutorPutor Experience IR -> Media recipe/presentation intent only; TutorPutor Model IR -> pinned SimulationSpec model source (scientific validity stays TutorPutor); TutorPutor Scene IR -> Media semantic scene/animation graph with typed clock, unit and coordinate mapping; model/animation output -> immutable content asset + source/run/quality/provenance receipts. TutorPutor remains the only learner-evidence/mastery authority and governs content/release. Generic Media has no direct imports of product-private modules and no permission to store protected learner history in export bundles.

The supported bridge should run with local/headless, web and native mobile adapters, degraded accessibility alternatives, offline modes explicitly declared, and read-only published packages. Extract generic code from TutorPutor only with a source/version/consumer/ownership migration and isolated consumer tests; do not embed product-specific assessment logic inside Media.

Reference AEF docs: products/tutorputor/docs/architecture/experience-fabric/{REQUIREMENTS,CONTRACTS_AND_IR,IMPLEMENTATION_PLAN}.md and docs/architecture/specs/SIMULATION_ENGINE.md.

## 6. OSS embedding plan: strict-permissive by default

Audit each pinned source file, binary, codec, shader, model checkpoint, weight, voice, font, asset, runtime dependency and redistribution condition. Candidates:
- **Animation:** Motion Canvas (MIT) for vector/narration animations, Manim Community (MIT source) for mathematical/offline scenes, Three.js/PixiJS (MIT) for scene render backends, OpenTimelineIO (Apache-2.0) for interchange.
- **Property animation:** Theatre.js @theatre/core (Apache-2.0) possible; @theatre/studio is AGPL-3.0 and is *excluded* from permissive bundled Studio.
- **Simulation:** Rapier (Apache-2.0; current JS bindings under main Rapier repo) for physics; SimPy (MIT) for discrete-event, SciPy (BSD) for numerical reference, version-qualified Box2D for 2D.
- **Existing voice/video:** selective Voicebox/OpenReel/FireRed MIT/Apache source; evaluate dependencies separately. VoiceStudio/OpenChatCut AGPL, GPL Pedalboard, MPL MediaBunny, LGPL/GPL FFmpeg builds and model community/noncommercial licenses cannot be implicitly described as unrestricted permissive embedded code.

No arbitrary user TypeScript, Python, expressions, eval, or model-generated executable shader code in default recipes. If trusted code plugins are enabled, they are signed, sandboxed, explicitly permitted and separately qualified. Never treat a repository license as evidence all dependencies or models are admissible.

## 7. Prescriptive work packages and acceptance

Reuse Media PBI-00…PBI-15 Build plan (not a competing scheduler):

1. **Definition admission PBI-00/02:** source-crosswalk Recorder, animation and simulation features to Media exact capability/operation/screen/host identities; revise only affected PDP0-3 cells, native checks and acceptances.
2. **Spec compiler PBI-02/10:** versioned typed AST, scene-kind union, safe expression grammar, DAG fingerprints and manual edit lock reconciliation; reject unsafe/unknown schema and cross-tenant assets.
3. **Gharbatai Recorder PBI-03..06/10/11:** qualify preexisting recorder, seed/lease and source readback; compile scenario to real browser capture, timed narrator, audio/video film and QA.
4. **2D/3D animation PBI-10/11:** semantic math/graph animation through permitted rendering adapter, temporal/keyframe and accessibility parity; same plan renders as edit-preview and headless export.
5. **Voice PBI-07/08:** qualified STT/TTS with narration alignment, phrase-only rerender, licensing and effective voice identity.
6. **Model/solver PBI-09/10/12:** AEF public adapter and a reference EXACT discrete model plus F2 analytical constant-force model; unit/time/fidelity admission, checkpoints and measurements.
7. **Interactive TutorPutor PBI-10/11/13:** predict/manipulate/measure/explain scene and probes, keyboard/mobile/offline, no Media ownership of mastery.
8. **Advanced simulation PBI-10/14:** bounded physics, discrete-event, stochastic and scientific profiles with per-model validators, reproducibility classes and performance.
9. **Full Studio PBI-10/11/12:** 52 manual operation kinds, reversible agent edits, screen/tab/CLI parity, actor/policy denials, copy-safe export/interchange.
10. **DAG/variants PBI-05/10:** selective recapture, source-only descendant invalidation, voice/format/localization variants and preserved manual locks.
11. **Cross-cutting PBI-13/14:** security/privacy/model+license rights, OTel, bounded resource budgets, scientific evidence vs picture quality, source classification.
12. **Independent dogfood/migration PBI-14/15:** validated Gharbatai real demo and TutorPutor AEF package integration; MIG-04 runtime/source cutover separately authorized.

Minimum experiments: actual film/source action readback; API-only no-fake-GUI; 2D animated math storyboard and 3D scene; model F2 test m=2 kg F=6 N for t=2 s giving a=3m/s² v=6m/s x=6m; t_story pause does not move t_sim; invalid units and solver divergence rejected; A/B checkpoints and reproducible EXACT graph model; generated media never scientific truth; 52 edit parity; rerender changed voice phrase without unlocked downstream edits; accessibility (screen reader/reduced motion/mobile); license+security negative tests; recovered UNKNOWN job without blind repeat.

## 8. Stage and review disposition

This document is one **non-normative implementation-planning bridge**. The sole source of Media product-definition meaning is .product-experience/PDP-0…3. TutorPutor keeps its separate PDP/AEF contracts, domain science, pedagogy and data. Gharbatai keeps product business effects. A proposal, a merged planning PR, a generated manifest or synthetic Explorer simulation is not Discovery PASS, real Build DEV_COMPLETE, signed scientific validation, film certification or permission to publish.

**Outcome sought:** complete data-driven, manually editable, AI-aware Recorder + animation + simulation as interoperable Media capabilities with two independently verified dogfooding consumers; no duplication of physical packages, project/job/data stores, domain/trust authorities or source of scientific truth.
