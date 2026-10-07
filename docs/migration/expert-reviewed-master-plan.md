# Ghatana Media — Expert-Reviewed Master Plan
## Ecosystem-first product graduation and complete Phase 0–3 source of truth

**Document ID:** MEDIA-MASTER-PLAN  
**Review date:** October 4, 2026  
**Status:** Migration/execution reference; its proposed product semantics are non-authoritative and remain subject to extraction and review in the owning PDP records
**Product:** Ghatana Media (`media`)  
**Target repository:** `samujjwal/ghatana-media`  
**Existing source:** `samujjwal/ghatana`, `services/media/`  
**Creation subsystem:** MediaSynth  
**Product CLI:** `ghatana-media`  
**Authority phases:** PDP-0, PDP-1, PDP-2, PDP-3 only; the Experience Explorer is outside the PDP phases

> Reuse the appropriate Ghatana owner first. Define Media meaning once. Keep every channel consistent. Make protection and quality native, and complexity optional. Verify the resulting behavior rather than inferring it from source presence.

## How to use this document

This document is retained as a migration/execution sequence and historical provenance for the supplied consolidated Media plan. The canonical product meaning is owned by the applicable PDP authority and its explicitly accepted decisions. Material in this plan that has not been extracted into those authorities remains a proposal, not a parallel semantic authority; extraction and review are tracked in `GAP-MEDIA-MIGRATION-SEMANTICS`. Task order, migration procedure, phase deliverables, verification strategy, and downstream handoff guidance remain useful execution references.

The product scope includes existing media processing and streaming, speech recognition and synthesis, image/video/audio/music generation, enhancement and restoration, editing, animation, simulation, synchronization, composition, professional color and mastering, quality assessment, delivery, and spatial-media extension points. None of these disappears because an initial provider is missing.

**Execution modes are separate permissions.** `PLAN_ONLY` produces/reviews this plan. `DEFINE_PRODUCT` authors Phase 0–2 artifacts and builds the Phase 3 Explorer, fixtures, adapters, and verification. `EXECUTE_MIGRATION` moves existing source and its ownership after its prerequisites. `IMPLEMENT_RUNTIME` builds production capabilities from accepted authority. A request for a plan or Explorer does not authorize production deployment, database mutation, model downloads, paid inference, publication, deletion, or repository cutover.

Migration is a cross-repository workstream, not a numbered product-definition phase. Production implementation and qualification are downstream workstreams, not a fifth PDP phase. Existing service contracts remain with their legitimate owners until an explicit transfer. This document does not authorize source transfer, runtime mutation, publication, qualification, or release.

**Reading order:** Sections 1–5 establish decisions and boundaries. Sections 6–17 define the product and runtime contracts. Sections 18–22 specify the four phases and their handoff. Sections 23–25 provide executable task cards, sequencing, and verification. The appendices preserve source coverage, evidence provenance, and unresolved prerequisites.

## Semantic extraction and disposition status (2026-10-07)

This table records the current classification of the plan's content. It does
not accept proposals. `GAP-MEDIA-MIGRATION-SEMANTICS` remains open because
unique semantic material has not yet been exhaustively reconciled, assigned to
an owning PDP record, and reviewed by the relevant owner.

| Classification | Current disposition and evidence |
| --- | --- |
| `EXTRACTED_TO_PDP` | Product identity and the bounded migration boundary are recorded in `.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md`, `constitution.yaml`, and accepted decision records. Mission/outcome, requirements, capability inventory, surface proposals, and policy material have PDP-0 counterparts, but their content remains proposal unless explicitly accepted. This classification means a corresponding PDP record exists, not that every plan statement has been reconciled. |
| `EXECUTION_ONLY` | Ordered migration/cutover procedure, wave/task order, source inventory, validation steps, verification recipes, and completion gates remain execution references in this document and `docs/migration/`. They do not create product semantics. |
| `IMPLEMENTATION_GUIDANCE` | Suggested source layout, phased migration tactics, typed-port direction, and implementation sequencing remain guidance for downstream work. They do not establish an admitted implementation or override accepted PDP contracts. |
| `EVIDENCE_REFERENCE` | Repository paths, inventories, upstream owners, external references, and dated observations are provenance. Their presence is not currentness, availability, or acceptance proof. |
| `OBSOLETE` | No additional plan section is marked obsolete by this update; existing stale observations are retained as dated evidence until reconciled in their owning record. |
| `UNRESOLVED` | Any unique semantic proposal not demonstrably extracted and reconciled above remains unresolved. In particular, capability-leaf meaning/bounds, PDP-1 object/state/operation decisions, PDP-2 visual/interface semantics, PDP-3 screen/journey behavior, and owner-specific channel/contract decisions stay open under their canonical gaps. |

The classification is intentionally conservative: no section-level match is
used to claim exhaustive statement-by-statement extraction. Complete inventory,
record-level reconciliation, and owner review are still required to close the
gap.

## Document navigation

- [1. Review result and material corrections](#1-review-result-and-material-corrections)
- [2. Product identity, naming and scope](#2-product-identity-naming-and-scope)
- [3. Ecosystem-first ownership and reuse](#3-ecosystem-first-ownership-and-reuse)
- [4. Product constitution and ambient guarantees](#4-product-constitution-and-ambient-guarantees)
- [5. Canonical authority, files and change propagation](#5-canonical-authority-files-and-change-propagation)
- [6. Complete capability scope and admission model](#6-complete-capability-scope-and-admission-model)
- [7. Domain architecture and replaceable execution](#7-domain-architecture-and-replaceable-execution)
- [8. Time, geometry, animation and simulation contracts](#8-time-geometry-animation-and-simulation-contracts)
- [9. MediaSynth, automatic quality and intelligent assistance](#9-mediasynth-automatic-quality-and-intelligent-assistance)
- [10. Public API, SDK and CLI contracts](#10-public-api-sdk-and-cli-contracts)
- [11. Security, privacy, rights and safe native execution](#11-security-privacy-rights-and-safe-native-execution)
- [12. Durable operations, observability and deployment](#12-durable-operations-observability-and-deployment)
- [13. Behavior-preserving product graduation and cutover](#13-behavior-preserving-product-graduation-and-cutover)
- [14. Low-cognitive-load product experience](#14-low-cognitive-load-product-experience)
- [15. Ecosystem-first dependency and OSS policy](#15-ecosystem-first-dependency-and-oss-policy)
- [16. Target source layout and module ownership](#16-target-source-layout-and-module-ownership)
- [17. Cross-product recipes and dependency handoffs](#17-cross-product-recipes-and-dependency-handoffs)
- [18. Phase 0 — Product Truth](#18-phase-0--product-truth)
- [19. Phase 1 — Design Language](#19-phase-1--design-language)
- [20. Phase 2 — Complete Product Experience Specification](#20-phase-2--complete-product-experience-specification)
- [21. Phase 3 — Deterministic, pixel-perfect Experience Explorer](#21-phase-3--deterministic-pixel-perfect-experience-explorer)
- [22. Derived implementation handoff and runtime sequence](#22-derived-implementation-handoff-and-runtime-sequence)
- [23. Prescriptive work packages and task dependency graph](#23-prescriptive-work-packages-and-task-dependency-graph)
- [24. Verification, experiments and completion measurement](#24-verification-experiments-and-completion-measurement)
- [25. Execution order, unresolved prerequisites and final acceptance](#25-execution-order-unresolved-prerequisites-and-final-acceptance)
- [Appendix A. Preservation and reconciliation crosswalk](#appendix-a-preservation-and-reconciliation-crosswalk)
- [Appendix B. External candidate inventory — only after the Ghatana reuse gate](#appendix-b-external-candidate-inventory--only-after-the-ghatana-reuse-gate)
- [Appendix C. Source evidence and reference register](#appendix-c-source-evidence-and-reference-register)
- [Appendix D. Minimal record templates and execution instructions](#appendix-d-minimal-record-templates-and-execution-instructions)
- [Appendix E. Document consistency checks](#appendix-e-document-consistency-checks)


---

# 1. Review result and material corrections

## 1.1 Assessment

The supplied plan has broad capability coverage and a sound intention: one Media product, four source-of-truth phases, strong privacy, simple UX, and replaceable implementations. It is not safe to execute unchanged. Several instructions conflate source relocation with product redesign, presume reusable components without checking their boundaries, leave safety-critical contracts underspecified, or describe desired quality as if it were guaranteed.

This review examined the plan from product-management, ecosystem architecture, migration/release engineering, distributed systems, media signal processing, graphics/animation, scientific simulation, AI/ML, privacy/security, licensing, UX/accessibility, CLI/API, and verification perspectives. These are analytical review lenses, not claims of independent human sign-off.

The following decisions are incorporated into the rest of this document. `R` references are inspected repository sources; `W` references are primary public documentation; `U` references are supplied source documents. References and scope limitations are recorded in Appendix C.

| Finding | Source/problem | Required resolution |
|---|---|---|
| REV-01 — Ghatana reuse was weaker than OSS preference | U1 §15 prioritizes external candidates without an executable internal-reuse gate | Ghatana public library/service/product capability → owner extension or extraction of reusable mechanics → approved external OSS → justified new implementation. Record evidence for each choice. |
| REV-02 — Migration preceded boundary acceptance | U1 §6 and §28 permit cutover before Product Truth resolves ownership | Accept the Phase-0 boundary, consumer compatibility, and transfer record before cutover. Complete behavior-preserving relocation independently of new-feature implementation. |
| REV-03 — API redesign mixed into extraction | U1 §22.8 proposes `/v1/*`; current Media and its operation client use different `/api/v1/*` shapes [R13, R19] | Preserve supported wire contracts during relocation. Reconcile canonical operations through explicit adapters and compatibility tests before admitting new contracts. |
| REV-04 — Existing integrations were at risk | U1 §6.6 could be read as deleting Data Cloud Media views | Data Cloud can retain governed generic read models and existing integration behavior. Move product-semantic ownership, not legitimate consumer experiences by assertion. |
| REV-05 — Generated contracts could become duplicate authority | Media `service-contract.yaml` is generated from authored sources/overlays [R12] | Migrate owning source records and generator bindings; regenerate projections. Never edit generated files as the primary change. |
| REV-06 — Whole-tree extraction omitted a distinct worker boundary | `document-intelligence-worker` consumes frozen Shared document-extraction contracts and has its own cancellation/admission behavior [R15] | Inventory and preserve this worker, Office/PDF/OCR paths, and its consumers; do not accidentally orphan it while moving “audio/video.” |
| REV-07 — Actual cross-product reuse was missing | TutorPutor already contains simulation, animation, renderers, export and accessibility work [R04] | Evaluate those concrete paths first. Preserve TutorPutor learning/model meaning; extract or consume only deliberately public, product-neutral mechanics. |
| REV-08 — A library name was mistaken for portable reuse | `@tutorputor/simulation` depends on TutorPutor contracts/core as well as render libraries [R05] | Do not import its broad barrel into Media. Perform dependency-closure analysis, isolated packaging tests, and owner-approved extraction or public integration. |
| REV-09 — Generic workflow/outbox work could be reinvented | Shared already exposes workflow and claim-aware outbox contracts [R06, R07] | Reuse those mechanics behind Media adapters. Media still owns media state, scheduling policy and persistence; Tools development workflows are not production media execution. |
| REV-10 — “Local ML” could bypass governance | U1 §14.1 is broader than AI Inference’s consumer boundary [R03] | New model/provider selection and generic inference stay AI Inference-owned, including local deployment. Existing bounded worker exceptions require explicit owner-bound contracts, not a general bypass. |
| REV-11 — Universal provider SPI was too broad | One interface attempts batch, streaming, simulation, inference and transport | Use a common descriptor plus typed batch, streaming, simulation and inference ports. Capability absence must be explicit, not fake implementations of irrelevant methods. |
| REV-12 — “Deterministic” was undefined | A seed/version is insufficient for cross-platform identical GPU/model/physics output [W03] | Declare exact, tolerance, statistical or non-replayable classes with hardware/runtime/solver bounds. Separate Explorer determinism from production reproducibility. |
| REV-13 — Three distinct time domains were conflated | Animation, simulation, audio and video clocks need different semantics | Define rational media time, sample/frame mapping, simulation time, story time, and wall-clock deadlines. Specify unit/frame conversions. |
| REV-14 — Graph definition and execution state were mixed | U1 §9 puts parameters, policies and execution state in one graph | Separate immutable specification, resolved execution plan, and run/checkpoint state; reuse cannot ignore current authorization or policy. |
| REV-15 — Quality claims were overbroad | Automatic physics/identity assessment and selective repair are not universally reliable | Qualification per metric/domain/provider; abstention and limits; bounded repair loops; no promise of arbitrary frame-level repair or scientific truth. |
| REV-16 — Privacy labels were ambiguous | “Private/Organization/Public” combines sharing with processing/location/classification | Keep access, classification, processing location, consent/rights and retention as independent axes, with simple summaries. |
| REV-17 — Erasure, retention and provenance could conflict | Blanket cascading deletion/immutable provenance rules are incomplete | Define derived-artifact policy, holds, references, backups, caches, pending external erasure, and anti-resurrection tombstones. Immutable content is not indefinite retention. |
| REV-18 — Audit and telemetry failure semantics were absent | “Ambient” does not specify delivery guarantees | Best-effort bounded diagnostics must not change business outcome. Required audit intent/durability may gate consequential actions; remote sink lag is separate. |
| REV-19 — Native engines widened the attack surface | Out-of-process is not automatically a sandbox | Isolate decoders, scripts, simulations and model artifacts; bound resources, filesystem, network, subprocess trees and output registration. |
| REV-20 — License and feature assumptions were loose | FFmpeg build choices affect licensing; OpenVDB’s official license page identifies MPL-2.0 [W01, W02] | Evaluate exact release, build options, transitive code, weights, assets and patents. Process isolation does not remove license obligations. |
| REV-21 — Low cognitive load conflicted with navigation | U1 §22.3 exposes many primary destinations | Use a small stable shell with intent launchers and contextual tools. No technical-provider navigation in the ordinary path. |
| REV-22 — CLI names and automation behavior were inconsistent | `create`, `synth`, `enhance`, `audio` and aliases overlap | One command registry over canonical action IDs; finite aliases, no duplicated logic; stable JSON/JSONL, exit codes and interruption semantics. |
| REV-23 — Scope breadth lacked a qualification model | A complete feature list was easily confused with launch availability | Preserve full intended scope; track definition, implementation, technical qualification, licensing and runtime availability separately. |
| REV-24 — Phase/task detail was insufficient | Many tasks only say “implement” or “define” | Every task has exact target, owner role, prerequisites, procedure, expected result, acceptance, verification and affected downstream material. |
| REV-25 — Interoperability was underdefined | A neutral scene graph cannot magically round-trip every engine | Declare supported semantic subsets and conversion-loss reports. Use interchange adapters, not claims of universal losslessness. |
| REV-26 — Core dependency direction needed an explicit migration protocol | Ghatana must not import product implementation; existing Media callers still need a boundary | Replace imports with neutral capability contracts/generated wire clients and approved integration providers. Test from both repositories without source coupling. |

## 1.2 What was and was not verified

The supplied Markdown was read in full. Selected live repository documents, package metadata and API-client source were inspected. They substantiate ownership, existing reusable surfaces, current contract drift and important limitations. They do **not** establish that every module builds, every declared package is published, or every test currently passes.

No repository was modified, no migration/cutover executed, no production service or paid model called, and no GPU, browser, database or engine qualification performed by preparing this document. There is no claim that all latent defects have been disproved. Remaining execution prerequisites have explicit gap IDs and stop conditions rather than silent assumptions.

---

# 2. Product identity, naming and scope

## 2.1 Stable naming

| Concept | Canonical name/rule |
|---|---|
| Product | **Ghatana Media** |
| Product ID / target repository | `media` / `samujjwal/ghatana-media` |
| Generative orchestration subsystem | **MediaSynth**; not a second product, separate generic platform, or mandatory independently deployed service |
| CLI | `ghatana-media` |
| Existing Java namespaces | Preserve `com.ghatana.media.*` and supported `com.ghatana.audio.video.*` during relocation; change only with a separately approved compatibility map |
| Existing packages | Preserve supported `@audio-video/types`, `@audio-video/client`, `@audio-video/ui` and other discovered public coordinates during relocation |
| New public packages | Select names from the product registry’s allowed export policy; do not create duplicate “new-name” and “old-name” implementations |
| Product capability ID | Stable `media.<family>.<operation>`; lowercase kebab-case segments; no vendor/model names |
| Requirements / tasks | Stable `MEDIA-*` requirements; task prefixes `GOV`, `MIG`, `P0`, `P1`, `P2`, `P3`, `HAND`, `IMP`, `OPS` |
| Structured records | Version schemas and public contracts as needed. No parallel “V2 product” or indefinite compatibility code fork. |

## 2.1A Standalone repository identity and boundary

`ghatana-media` is an independently versioned **Ghatana product repository**. It is not a runtime-platform repository and it is not a child workspace of `ghatana-products`.

It SHALL follow the same dependency direction used by other extracted products:

```text
ghatana-shared ─┐
ghatana-tools  ─┼─→ ghatana-media
ghatana-kernel ─┤
ghatana runtime ┘     (runtime services consumed through public network contracts)
```

The new repository must create and enforce:

```text
BOUNDARY.md
config/repo-boundary.json
.ghatana/repository.json              # when required by current ecosystem repository identity schema
config/canonical-product-registry.json or equivalent standalone product manifest
```

The boundary must declare that `ghatana-media`:

- owns Media product semantics, APIs, CLI, runtime composition, artifact/job/stream domain state, MediaSynth, animation, simulation, quality, editing, composition and delivery;
- may consume published `ghatana-shared`, `ghatana-tools` and `ghatana-kernel` artifacts;
- calls `ghatana` runtime services over stable REST/gRPC/public delivery contracts;
- must not source-import `ghatana/services/**`, `ghatana-kernel` internals, another product's internal packages, or Tools implementation internals;
- must not implement a second AI Inference router, Agent Runtime, Action Plane, Event Plane, Data Cloud, generic audit framework, generic observability framework or generic product-development framework;
- may expose product-owned packages such as `com.ghatana.media:*` and the approved Media TypeScript package coordinates.

`ghatana-products` remains the ecosystem product portfolio/registry owner and records Media's extraction/standalone-product identity, but it is **not** a runtime or source dependency of `ghatana-media`.

Brand labels are not state machines. `RenderJob` is a typed view of a `ProcessingJob` with render intent, not a separate job lifecycle. `DerivedArtifact` is an artifact plus derivation provenance, not a competing storage authority. `MediaAsset` is a project’s usage/binding of an artifact, not another byte store. `GenerationStrategy` describes a workflow shape, not model routing.

Subsystems are `ScenePlanner`, `MediaSynth`, `MediaQualityEngine`, `ContinuityEngine`, `AVSyncEngine` and `RenderComposer`. Animation/simulation are peer creation mechanisms; rendering, synchronization, quality and provenance are shared by generated, captured, edited, animated and simulated media. MediaSynth orchestrates those capabilities and does not own duplicate copies of them.

## 2.2 Product mission

Ghatana Media enables people and authorized systems to understand, create, restore, enhance, edit, animate, simulate, synchronize, compose, master, evaluate and deliver governed media. It combines deterministic DSP/computer vision, procedural graphics, simulation and specialized AI/ML while preserving user intent, rights, privacy and predictable costs.

Primary outcomes are useful finished assets and explainable recoverable work, not access to a list of model endpoints. Educational, marketing, archival, creator, developer and operator journeys are first-class examples. Scientific validity, pedagogical truth, clinical decisions and campaign claims stay with their domain owners.

## 2.3 Scope admission without capability loss

All capabilities in Section 6 are in the intended product-definition scope. Implementation order is not an excuse to delete requirements. Each leaf declares: intended behavior; supported inputs/outputs; channel applicability; trust/reconstruction policy; measurement/acceptance; implementation owner; and dependency disposition.

Track five separate dimensions: `definitionState`, `implementationState`, `qualificationState`, `licenseAdmissionState`, `runtimeAvailability`. A package can be present while a capability is not licensed, unavailable on the current device, or not qualified for a language/resolution/physics regime. `UNKNOWN` is not `AVAILABLE` and `NOT_EVALUATED` is not proof of failure.

Advanced fluids, long-form generation, scientific models and spatial workflows remain specified. They are not shown as working capabilities until the appropriate qualified execution target exists. A renderer that illustrates a scientific phenomenon must not be advertised as a validated simulator.

---

# 3. Ecosystem-first ownership and reuse

## 3.1 Mandatory dependency-selection order

For **every** required mechanism, complete a Reuse Decision before adding a dependency or implementing a replacement:

1. Inspect current Ghatana-owned contracts, public libraries, runtime capabilities and product capabilities. Prefer a suitable existing implementation through its intended boundary.
2. If partially suitable, propose a bounded extension to the owning Ghatana surface, or an owner-approved extraction of reusable mechanics. Compare the effort with an adapter; do not force unrelated product semantics into Shared.
3. Evaluate an already-used external engine through its existing Ghatana adapter before adopting a different engine.
4. Only after documenting the unresolved gap, select an appropriately licensed external library/tool behind a replaceable adapter.
5. Write new domain-specific or generic code only when neither reuse nor a bounded integration satisfies the required behavior. Generic new mechanics require the correct ecosystem owner, not Media-local duplication.

Suitability includes API stability, published packaging, security, tests, performance, license, operational burden, portability and maintainership—not just a matching name. This order is not a requirement to use an unsuitable or unmaintained internal library. A rejected candidate must have a concrete reason and a replacement decision.

## 3.2 Canonical owner matrix

| Owner | Owns | Media must do / must not do |
|---|---|---|
| `ghatana-media` | Media meaning, projects/assets, processing specifications, media-job policy/state, timeline, animation/simulation presentation, media quality, rights and delivery intent | Own its domain, stores and adapters; remain a Ghatana product consumer, not a generic platform |
| `ghatana-shared` | Reusable security, identity, audit, observability, workflow, messaging, schema, config, HTTP, async/lifecycle, testing and UI primitives | Consume published contracts. Request owner improvements rather than copying implementations |
| `ghatana-tools` | Product-development/experience contract mechanics, work planning, validation, engineering verification/currentness and closure tooling | Use public tooling during development. Never run the development closure engine as the end-user media-job runtime |
| `ghatana-kernel` | Kernel-specific lifecycle, composition, UI/page/resource/action contracts, and extension runtime | Consume where deliberately adopted; do not recreate Kernel schemas or claim Kernel-native materialization from a dependency alone |
| `ghatana/services/ai-inference` | Generic inference contracts, model/provider eligibility, routing, credentials, policy, quota, health and failover | Call public boundary; request long-running media inference extensions at that owner, not a Media model router |
| `ghatana/services/agents` | Bounded agent execution and dynamic tool/reasoning coordination | Consume only for genuinely agentic work; ordinary media recipes are not agent graphs |
| `ghatana/services/action-plane` | Privileged external effects, delegated approval/effect execution, effect idempotency/reconciliation | Route consequential publication and external effects through it; do not duplicate approval engines |
| `ghatana/services/event-plane` | Durable cross-service event transport/replay truth | Publish through approved contracts. Media-owned outbox intent is not a new Event Plane |
| `ghatana/services/data-cloud` | Governed enterprise context/data and read-model integration | Use it for governed metadata/context when needed; never mutate its DB or transfer Media byte/job authority accidentally |
| TutorPutor | Learning intent, pedagogy, model fidelity, domain packs, learner evidence and learning outcomes | Reuse appropriate simulation/render mechanics through explicit boundaries; do not copy education authority |
| Digital Marketing | Campaign/brand/claim/offer rules and campaign publication workflows | Exchange approved creative briefs, brand/claim references and deliverables; avoid a second marketing authority |
| PHR / Gharbatai | Clinical/organizational intake and review meaning | Preserve their document-extraction integration; do not infer or change clinical/KYC decisions in Media |
| YAPPC | App-building product experience | Integrate only where a published app-authoring capability is needed; do not embed its product internals as Media’s editor framework |

The repository portfolio boundary explicitly separates these authorities [R01]. Choosing `STANDALONE_CLOSURE` for Media is a proposed initial packaging decision, subject to the actual owner schema. It means Tools supplies development mechanics, not that Media is outside the ecosystem or must ignore Kernel contracts.

## 3.3 Concrete first-pass reuse inventory

| Need | Inspected Ghatana candidate | Adoption instruction and limit |
|---|---|---|
| Identity/security | `ghatana-shared/platform/java/security`; auth-gateway/public identity contracts | Resolve public exports and qualified config. Trusted identity comes from the gateway/boundary, not tenant fields in requests. Exact versions remain a binding prerequisite. |
| Audit | `platform/java/audit`: `AuditEvent`, `AuditEnvelope`, `AuditSinkPort`, `DurableAuditStoreFactory` [R09] | Reuse bounded values and public durable composition. Product keeps event vocabulary and retention. Hash-chain integrity is tamper-evidence, not unconditional non-repudiation. |
| Metrics/traces | `platform/java/observability`: `MetricsCollector`, `CorrelationContext`, health and safe diagnostics [R08] | Use safe public APIs and explicit async context scopes. Exporter adapters remain at composition boundary; no raw identity or media in metrics. |
| Durable state transitions | `platform/java/workflow`: `WorkflowDefinition`, `WorkflowCommandProcessor`, repository/action/guard ports [R06] | Reuse command reservation, CAS, transitions and ambiguity handling. Media supplies state definitions, durable repository, scheduler and media actions. |
| Outbox delivery | `platform/java/messaging`: `OutboxPublicationSource`, `ClaimedOutboxPublisher`, `EventBusPort` [R07] | Reuse claims, ordered publishing and acknowledgements. Host owns cadence/resources; no built-in assumption of a restart-safe scheduler. |
| UI | Shared `@ghatana/design-system`, tokens, theme, headless behavior, accessibility and product shell [R10] | Product-specific timeline/mask/scene components compose Shared primitives; do not copy generic controls or token authorities. |
| Product experience definitions | Tools `@ghatana/experience-specification` [R11] | Reuse schema and validator for Web/API/CLI/embedded targets, state/actions and references. It does not execute transitions or render Explorer. |
| Development facade | Tools `gtool` [R14] | Use documented work/development/verification routes. Inspect its catalog before inventing command flags or claiming a provider is available. |
| Animation/simulation | TutorPutor `libs/tutorputor-simulation`, documented exports `./renderer`, `./physics`, `./animator`, `./sdk`, `./aef` [R04, R05] | Inspect each export’s transitive closure. `@tutorputor/contracts`/`core` coupling means this is not automatically a product-neutral drop-in. |
| Scene/model semantics | TutorPutor AEF Experience IR, Model IR, Scene IR [R04] | Reuse or map neutral representation/time/unit conventions where possible. Media must not create a conflicting universal educational Model IR. |
| Brand/claims | Digital Marketing canonical marketing operating model [R16] | Reuse public brand/claim references or request a contract; source presence does not prove a callable API. |
| Document processing | Existing `document-intelligence-worker` and `@ghatana/document-extraction` [R15] | Preserve bounded worker/adapters, cancellation-generation token and per-language qualification; do not blanket-promote all formats. |
| Existing media implementation | Media launcher/runtime-contracts/providers/audio-video libraries [R02] | Relocate and wrap first. Source presence does not establish production durability or quality. |

## 3.4 Reuse decision record

The authoritative register is `.product-experience/phase-0-product-truth/reuse-decisions.yaml`. Each record must include:

```yaml
id: MEDIA-REUSE-ANIMATION-001
capabilityRef: media.animation.keyframe
owner: media-architecture
status: evaluation-required
candidates:
  - ownerRepo: samujjwal/ghatana-media
    sourcePath: products/tutorputor/libs/tutorputor-simulation
    publicBoundary: '@tutorputor/simulation/animator'
    observation: source-and-export-present
    unresolved: [transitive-domain-coupling, artifact-only-consumption, behavioral-qualification]
selection: null
requiredExperiments:
  - import-public-artifact-without-sibling-source
  - preserve-time-units-curves-and-accessibility-on-golden-scenes
  - compare-maintenance-and-performance-cost-with-bounded-owner-extraction
externalAdoptionAllowed: false
```

This is a record design, not a claim that an existing Tools schema accepts this exact YAML. Publish or map it through the owner-approved schema before using it as a gate. A decision that selects an external engine must name the rejected/insufficient Ghatana candidates and the measured gap. Never set a blank selection to “approved” to unblock a build.

---

# 4. Product constitution and ambient guarantees

The following stable constitutional IDs preserve the original principles and add explicit enforcement. Phase 0 owns them. A readable `PRODUCT-CONSTITUTION.md` is generated from, or unambiguously references, the single structured requirement register; it is not another editable set of rules.

| ID | Binding requirement |
|---|---|
| MEDIA-CONST-001 | Collect and retain minimum necessary media, metadata and derived information. |
| MEDIA-CONST-002 | Authenticate trusted boundaries, authorize each consequential action and preserve tenant/principal isolation. |
| MEDIA-CONST-003 | Normal users operate on intent/outcome rather than models, queues, engines or infrastructure. |
| MEDIA-CONST-004 | Simple, Guided and Expert expose one semantic model with progressively deeper controls. |
| MEDIA-CONST-005 | Use AI/ML where measured benefit justifies it; it is neither mandatory nor a separate isolated “AI area.” |
| MEDIA-CONST-006 | Prefer adequate deterministic DSP/CV/procedural execution before more expensive or less predictable mechanisms. |
| MEDIA-CONST-007 | Validate media structure and measure applicable quality; provider success is not quality acceptance. |
| MEDIA-CONST-008 | Never silently weaken privacy, rights, safety, scientific fidelity, requested quality or effect finality. |
| MEDIA-CONST-009 | Every meaningful operation has bounded, privacy-safe diagnostics and trace correlation. |
| MEDIA-CONST-010 | Consequential operations have durable audit intent and truthful outcome/finality records. |
| MEDIA-CONST-011 | Derived artifacts retain authorized lineage and processing provenance throughout their permitted lifecycle. |
| MEDIA-CONST-012 | Accessible operation, review and suitable output alternatives are intrinsic, not optional paid add-ons. |
| MEDIA-CONST-013 | Failures preserve eligible completed work and expose safe recovery; unknown outcome is explicit. |
| MEDIA-CONST-014 | Evaluate Ghatana reuse first, then approved permissive OSS, before implementing replacement mechanics. |
| MEDIA-CONST-015 | Animation is a native creation mode, not an incidental AI-video feature. |
| MEDIA-CONST-016 | Simulation is a native creation/control mode with explicit fidelity and reproducibility. |
| MEDIA-CONST-017 | Offer local/private execution only when the entire selected plan can satisfy that policy. |
| MEDIA-CONST-018 | Web, CLI, API, SDK, embedded integrations and Explorer refer to one domain/action/state authority. |
| MEDIA-CONST-019 | Preserve ecosystem ownership and forbid product-internal imports from core Ghatana runtime. |
| MEDIA-CONST-020 | Exact text, branding, logos, captions, figures and required disclosures use deterministic composition. |
| MEDIA-CONST-021 | Disclose generative reconstruction; restoration cannot certify recovery of unknowable original detail. |
| MEDIA-CONST-022 | Reveal model/provider/engine identity when needed for trust, rights, cost, reproducibility or expert diagnosis. |
| MEDIA-CONST-023 | Long-running remote work is independent of browser/CLI attachment; stopping observation is not cancellation. |
| MEDIA-CONST-024 | Each ordinary state has a clear next action and actionable explanation of material blockers. |
| MEDIA-CONST-025 | Original bytes and accepted project revisions are not destructively overwritten by enhancement. |
| MEDIA-CONST-026 | No training, telemetry-content collection or cross-tenant learning from customer assets without separate authorization. |
| MEDIA-CONST-027 | Automatic repair is bounded by admissible changes, cost, time, attempts and measured improvement. |
| MEDIA-CONST-028 | Capability/profile/license/runtime status remains explicit; absence of evidence never becomes availability. |
| MEDIA-CONST-029 | Deletion, consent revocation, cache reuse and publication re-check current policy at the effect boundary. |
| MEDIA-CONST-030 | UI simulation, model qualification, runtime correctness and external certification remain separate claims. |
| MEDIA-CONST-031 | Untrusted inputs, scripts, native tools and models execute only through admitted, bounded isolation boundaries. |
| MEDIA-CONST-032 | No hidden duplicate authority, implementation, registry, state machine or platform framework is created for convenience. |

---

# 5. Canonical authority, files and change propagation

## 5.1 Four phases and one owner per concept

| Layer | Owns | Must not own |
|---|---|---|
| Phase 0 — Product Truth | Meaning, actors, outcomes, requirements, capabilities, domain/time/units, authority, states, failure/finality, dependencies and NFRs | CSS, component-specific styling, provider brands as semantic truth |
| Phase 1 — Design Language | Reusable visual/interaction/content/accessibility/responsive and terminal grammar | New capabilities or changed action consequences |
| Phase 2 — Complete Product Experience | Exact screens/views, CLI/API experience mappings, content, interactions, journeys, scenarios and product simulation semantics | Independent business state machines or duplicate external schemas |
| Phase 3 — Experience Explorer | Executable, deterministic visual/interaction projection of accepted definitions | New product meaning, fake backend proof, production availability claims |
| External owner contracts | Their authoritative API/schema/lifecycle semantics | Copying those semantics into Media as a parallel owner |
| Production implementation | Real runtime execution and measured results | Weakening intended requirements merely to match incomplete code |

A missing upstream rule found in Explorer must be fixed at its owning phase first. Regenerate affected projections and rerun affected checks only. An implementation-discovered product change requires the same upstream reconciliation.

## 5.2 Target authority root

```text
.product-experience/
  README.md
  source-manifest.yaml
  authority-map.yaml
  currentness.yaml                 # generated observation, not manual readiness
  traceability.yaml               # authored relations or generated graph; choose one mode explicitly
  decision-log.md
  gaps.yaml                       # one canonical cross-phase gap register
  acceptance.yaml                 # structured acceptance inputs; results are generated
  PRODUCT-CONSTITUTION.md          # derived readable Phase-0 constitution
  phase-0-product-truth/
  phase-1-design-language/
  phase-2-product-experience/
  phase-3-experience-explorer/
```

Existing equivalent authorities are reconciled and registered instead of duplicated. Phase-local gap/coverage/acceptance files are generated filtered views of the root records when useful, never competing editable ledgers. Top-level product `capabilities.yaml` and `dependencies.yaml` are projections of the corresponding accepted Phase-0 records when the portfolio registry requires them.

The authoritative reuse decision register is the Phase-0 `reuse-decisions.yaml`. `config/reuse-decisions.yaml`, when useful to runtime packaging, is a **generated admitted-decision projection**, never a second editable decision register. `config/dependency-bindings.yaml` records deployment-specific resolved/public artifact bindings under the runtime owner, constrained by Phase-0 dependency semantics. `config/oss-components.yaml` is the exact technical supply-chain inventory and admission evidence; it does not redefine the product’s license policy. Register these roles separately.

The source manifest records artifact ID, title, owner, authority class, owning phase, exact path/reference, authored/generated role, semantic fingerprint, dependencies, dependents, validation contract and acceptance state. External service schemas stay with the service owner; include public contract fingerprints and owner resolution, not copied semantics.

## 5.3 Reproducible change and version handling

Use semantic/material fingerprints over declared inputs, not commit SHA alone. Record repository revisions only as source-observation provenance. Changes to runtime/engine/model/color config/assets can invalidate outputs even when source requirements do not change. Changes to policy may invalidate reuse without changing bytes. Unknown impact broadens verification and reports why.

Preserve accepted unaffected work. Do not rerun an expensive model benchmark because only explanatory prose changed. Do rerun the affected measurements when their model, preprocessing, temporal mapping, quality metric, engine, benchmark corpus or acceptance policy changes. Registry/schema version changes use explicit compatibility migrations; “fix forward” does not mean breaking supported contracts without a migration.
# 6. Complete capability scope and admission model

## 6.1 Capability records, not a list of library names

The following families are **required product-definition scope**. They are not assertions that implementations or qualified models already exist. Phase 0 expands every named operation into a stable leaf record or an explicit alias of another leaf. An operation cannot vanish by being relabeled “future.” Record its intended channel, priority, implementation lane and availability separately.

Each leaf records: ID; outcome and actor; input/output artifact types; preconditions; supported parameters with units/ranges; constraints; action and state references; required authority; rights/privacy implications; quality/fidelity contract; cancellation/retry/reconciliation; execution/resource requirements; accessibility representation; provenance; Ghatana reuse decision; external dependencies; acceptance cases; qualification dimensions; supported channels; and explicit unsupported cases.

Use the canonical namespaces below. Names describe semantics, not vendors. Technical substeps can be implementation details of an operation; expose an independent capability only when independently useful or required for composition. A leaf shared by two workflows has one definition and multiple callers.

## 6.2 Core and existing capabilities

| Family | Complete intended scope | Required outputs and acceptance focus |
|---|---|---|
| `media.project.*` | Create, inspect, update, search, organize, archive, version, duplicate/branch, collaborate/review and restore projects; source/derived assets, composition and project settings | Versioned project state; optimistic concurrency; explicit membership and recovery; no silent lost updates |
| `media.artifact.*` | Ingest, upload, resume, import, inspect, search/list, download, derive, register outputs, share/revoke, delete, retain, export provenance and resolve source references | Verified immutable bytes plus mutable governed lifecycle; checksum/size/MIME agreement; ownership and access preserved |
| `media.job.*` | Submit, inspect, list, watch, cancel, retry, reconcile, inspect outputs and bounded execution history | One semantic job identity with separate attempts; truthful progress, terminal and uncertain states |
| `media.stream.*` | Audio/video/multimodal session open/connect/frame/ack/close, reconnect, ordering, leases, bounded buffers and backpressure; recording and live-processing integration | Existing stream protocol preserved; admission and consent rechecked; no duplicate/skipped frames disguised as successful contiguous delivery |
| `media.profile.*`, `media.capability.*`, `media.health.*` | Profile discovery/validation, capability/provider diagnostics, execution compatibility and readiness | Declared, qualified and currently available are different states; no fabricated availability |
| `media.rights.*`, `media.provenance.*` | Consent references, permitted uses, rights attestations, source lineage, execution lineage, origin disclosure and retention/erasure effects | Enforced eligibility; inspectable provenance with sensitive data minimized |
| Existing document-intelligence boundary | PDF/Office/image parsing, OCR, schema-guided extraction, applicable embeddings and region/fallback behavior already hosted under Media | Preserve frozen Shared `@ghatana/document-extraction` contracts, operation-generation cancellation, dimensional qualification and non-activation state [R15]. It is a distinct admitted capability bundle, not a generic multimodal rewrite |

Live delivery extensions such as WebRTC, adaptive HTTP streaming, HLS/DASH and live captioning are defined as capability/profile requirements, not assumed properties of the current HTTP frame API. Reuse existing Ghatana streaming modules before selecting a new stack. Record codec, transport, recording, reconnect and latency support per profile.

## 6.3 Understanding, speech and structural analysis

| Family | Operations retained in scope |
|---|---|
| `media.speech.transcription.*` | File and streaming STT; language detection; voice-activity detection; speaker diarization, segmentation and separation; authorized speaker identification; word and phoneme timestamps; forced alignment; punctuation/capitalization; alternatives and confidence; speech translation; subtitle generation |
| `media.vision.*` | Detection, classification, image/video segmentation, object and point tracking, optical flow, depth, surface normals, human/hand pose, face landmarks, expression and gaze analysis, foreground/background matting, motion segmentation, saliency, scene classification, shot-boundary detection and camera-motion estimation |
| `media.multimodal.*` | Cross-modal analysis, description, summarization, structured extraction, speaker-to-face association, scene/audio relationships and source-grounded media observations |
| `media.audio.analysis.*` | Speech/music/non-speech segmentation; loudness, peaks, clipping, noise, spectral/phase/channel analysis; beat/onset and silence detection; source-separation diagnostics; timing and intelligibility assessments |

Identity, biometrics, emotions and gaze require explicit applicability, permission and limitation records. An estimator’s label is an inference, not an established fact about a person. Speaker diarization does not require identifying the speaker. Prefer anonymous track IDs when identification is unnecessary.

## 6.4 Generation and voice

| Family | Operations retained in scope |
|---|---|
| `media.generate.image.*` | Text-to-image (T2I), image-to-image (I2I), reference and multi-reference generation, sketch/layout-to-image, pose/depth/edge/segmentation-conditioned creation, palettes and style/reference controls |
| `media.generate.video.*` | Text-to-video (T2V), image-to-video (I2V), video-to-video (V2V), T2I→I2V, start/end/intermediate-keyframe generation, reference-video generation, audio/speech-driven video and animation |
| `media.generate.audio.*` | Text-to-audio, sound effects, music, video-to-audio/Foley/ambience, audio-to-audio transformation, music continuation/variation and stem generation |
| `media.speech.synthesis.*` | TTS, streaming/multilingual/cross-lingual/expressive TTS; prosody, rate, pitch, emotion/style intent, pronunciation and phoneme controls; speaker conditioning; authorized cloning; voice conversion; speech-to-speech; translation and dubbing |
| `media.generate.spatial.*` | Text/image-to-3D, multiview reconstruction, depth/camera reconstruction, novel views, 3D assets, 3D-aware relighting/composition, NeRF-like and Gaussian-splatting-like representations through declared adapters, 360-degree media and spatial audio |

Model selection, credentials, quota and generic model execution remain with AI Inference. Model-specific strings such as `flux_dev`, `sdxl_turbo` and `ltx_i2v` from the original intention are **candidate bindings only**, not product defaults or evidence of license eligibility. Image/video generations can start from text without an existing binary input artifact; the contract must not require a dummy source file just because the current processing API accepts one artifact.

## 6.5 Animation

`media.animation.*` covers 2D, vector and 3D animation; keyframes; interpolation/easing curves; procedural animation; paths; skeletal animation; inverse kinematics; constraints; morph targets; camera, material and light animation; particles; physics/audio/pose-driven animation; facial expression, gaze, lip animation; motion-capture extraction; motion retargeting; and character animation.

Required editing primitives include selection, keyframe insertion/removal, curve editing, temporal snapping, playback/scrubbing, track muting/soloing, layered animation, explicit blending rules, and undo/redo through versioned changes. Imported rigs require skeleton mapping and limits, not automatic claims of universally correct retargeting. Human/likeness operations retain their rights and biometric controls.

Outputs include interactive scenes, vector/raster frames, composited video, reusable animation clips and appropriate exchange packages. The timeline and semantic control representation must be accessible without requiring a pointer or interpreting only a canvas.

## 6.6 Simulation

`media.simulation.*` covers rigid/soft bodies; cloth/rope; particles; fluids, smoke and fire; collisions/constraints; vehicles; crowds/agents; human motion; procedural worlds; camera and lighting experiments; educational/scientific demonstrations; robotics/kinematics; and synthetic-data generation.

These are separate qualified capability families. A rigid-body engine is not a fluid solver; a volume representation is not a simulation implementation. No one engine is presumed to implement the entire list. Media owns execution and media representation; domain equations, educational claims, clinical meaning and empirical calibration retain their qualified domain owner.

Simulation outputs can include RGB, depth, normals, segmentation, optical flow, motion vectors, object IDs, contacts/physical events, measurements and timestamped state. Declare which outputs are genuinely produced versus estimated later. A predicted depth map must not be labeled ground-truth geometry.

Templates include physics/math explainers, infographics, product demonstrations, scientific visualization, interactive lessons, training scenarios, architectural scenes, character/gesture animation and synthetic datasets. A template is a versioned `MediaRecipe` plus content/schema bindings, not another hard-coded application.

## 6.7 Restoration and enhancement

| Family | Operations retained in scope |
|---|---|
| `media.enhance.image.*` | Denoise; deblur; dehaze; deblock/deband/dering; compression/JPEG repair; super-resolution; face/detail/texture restoration; scratches/damage restoration; color recovery; white balance/exposure; lens distortion; chromatic aberration/vignette correction; HDR recovery, tone/gamut conversion and sharpening |
| `media.enhance.video.*` | Video/space-time super-resolution; interpolation; temporal denoise/deblur; compression repair; deflicker; temporal-consistency correction; stabilization; rolling-shutter correction; frame repair; frame-rate conversion; motion-blur synthesis; grain management; deinterlacing; inverse telecine/cadence repair |
| `media.enhance.audio.*` | Noise suppression/speech enhancement; dereverberation/de-echo/acoustic echo cancellation; dehum/declick/decrackle/declip; wind/plosive reduction/de-essing; source/speaker/music-vocal/stem separation; background removal; speech separation; audio super-resolution/bandwidth extension; sample-rate conversion; phase/channel repair |

A default pipeline does not apply every enhancer. Analysis selects only eligible operations whose measured improvement outweighs artifact risk. Preserve the source and compare the result. Face restoration and generative super-resolution can alter identity/detail and must obey the preservation policy; “looks sharper” is insufficient acceptance.

## 6.8 Editing, synchronization, composition and mastering

| Family | Operations retained in scope |
|---|---|
| `media.edit.*` | Image/video inpainting/outpainting; object removal/replacement; background removal/replacement; matting; relighting/recoloring/colorization/style transfer; retiming/slow motion/speed ramps; smart crop/auto reframe; shot/color matching; region/face/hand correction; keyframe/mask/effect propagation |
| `media.sync.*` | Sample-accurate A/V mapping; lip synchronization; phoneme/viseme alignment; dubbing/subtitle/voiceover timing; scene/beat/music-edit alignment; speaker-face association; drift detection/correction |
| `media.compose.*` | Multitrack timelines; scene/storyboard assembly; video/audio/caption/overlay tracks; transitions; titles/credits/lower thirds; exact typography/logos/brand assets; safe areas; reusable compositions and render manifests |
| `media.color.*` | White balance/exposure/contrast/curves; temperature/tint/selective color; skin-tone preservation; shot matching; LUTs; color-space/gamut conversion; HDR grading; SDR/HDR conversion; tone mapping and highlight/shadow recovery |
| `media.master.audio.*` | EQ; dynamic/multiband compression; limiting; true-peak/loudness control; stereo width; phase/noise-floor analysis; fades/crossfades; ducking/sidechain; room matching |

Exact logos, captions, legal copy, mathematics, UI screenshots, diagrams and product labels are deterministic overlays or approved source assets. A generative model is not the authority for exact text. Dubbing may assist translation, but the user/domain owner retains meaning approval; duration fit does not justify mistranslation.

## 6.9 Quality and delivery

`media.quality.*` includes inspect, compare, diagnose, rank, recommend, repair-plan and bounded optimize. Image assessment covers noise/blur/compression/exposure/color, structural fidelity/reference similarity, identity consistency and perceptual quality. Video adds temporal consistency, flicker, frame artifacts, motion, identity/object/geometry/camera continuity, qualified physical plausibility, lip/A/V sync and encoding quality. Audio includes noise/clipping/distortion/intelligibility, separation leakage, spectral/phase quality, loudness/true peak, naturalness and speaker similarity where authorized.

`media.deliver.*` includes encoding/transcoding, mastering, packaging, streaming, downloading, exporting and governed publishing; multiple aspect ratios/resolutions; adaptive-bitrate renditions; web/social/broadcast/cinematic profiles; subtitles/transcripts; thumbnails/posters; interactive scene bundles and provenance manifests. Define codec/container/player compatibility and fallback per profile. Rendering success, package validity, successful transport, and public publication are separate outcomes.

---

# 7. Domain architecture and replaceable execution

## 7.1 Product-neutral mechanics, Media-owned meaning

Use a modular product control plane with ports/adapters and immutable domain values. Keep existing Java control-plane and TypeScript UI/client investment unless an evidence-backed decision requires a change. Native/Python/Rust/WASM engines run in qualified workers; adding an engine does not require moving the API to its language. Split deployment for resource isolation, not one microservice per capability.

```text
Web / CLI / SDK / product integrations
                    |
        Media application boundary
      authenticated action + intent
                    |
       Media-owned domain services
 projects | artifacts | jobs | recipes | rights
                    |
       Media graph compiler / coordinator
                    |
 Shared workflow mechanics + Media durable adapters
                    |
  typed capability ports / bounded execution workers
       |              |                 |
 deterministic    animation /       AI Inference
 media engines    simulation        public boundary
       |              |                 |
       +-------- governed artifacts ----+
                    |
     quality / synchronization / composition
                    |
     registered master + delivery operation
```

The Media graph is a domain processing specification. It is not a replacement generic agent graph, Tools development lifecycle, or Kernel lifecycle engine. Ordinary non-agent recipes do not require Agent Runtime. A privileged external publication or agent-triggered consequential effect uses Action Plane’s authority, while Media retains media-object state.

## 7.2 Canonical records

| Record | Required meaning |
|---|---|
| `MediaProject` | Tenant/workspace membership, title, immutable revision reference, assets, scenes/timelines, settings and access policy |
| `MediaArtifact` / `ArtifactVersion` | Immutable content identity, digest/size/type, technical descriptors, origin and owner references; separate lifecycle/access/retention state |
| `MediaAsset` | Project-specific use of an artifact/version, purpose, crop/trim and presentation bindings; does not duplicate bytes |
| `MediaRecipe` | Versioned parameterized processing/animation/simulation intent with bounds, required ports and safe variants |
| `ProcessingJob` | Durable requested operation, immutable request/plan references, owner, state, attempts and outputs; `RenderJob` is its render-specific view |
| `JobAttempt` / `JobLease` | Attempt identity, worker claim/fencing token, deadlines, side-effect boundary, provider execution reference and reconciliation |
| `MediaProcessingGraph` | Immutable typed nodes/edges, artifact references, required semantics and parameter schema |
| `ResolvedMediaPlan` | Admitted concrete graph, chosen capability bindings, environment, bounds, policy-decision references, cost reservation and fingerprint |
| `MediaRun` / `Checkpoint` | Mutable execution progression and immutable observations; not a mutation of the source graph |
| `ScenePlan` / `SceneBrief` | Narrative/visual intent, shot/scene purpose, timing, references, controls, narration and transitions |
| `SceneGraph` | Versioned scene entities/assets/transforms/materials/cameras/lights and typed bindings; supported interchange subset |
| `AnimationGraph` | Tracks/keyframes/curves/constraints/events/rig mappings and bindings to scene properties |
| `SimulationWorld` | Initial state, physical/model quantities, units, solver/engine requirements, boundary conditions, constraints and sampled output contract |
| `Timeline` / `CompositionConfig` | Rational-time tracks/clips/transitions, audio mix, captions, graphics, color and delivery intent |
| `GenerationControlBundle` | Typed references, masks, depth/normals, pose, edges, segmentation, layout, palette, camera/subject trajectories and static/motion regions |
| `ContinuityState` | Scene-to-scene identity/appearance/geometry/style references and qualified comparisons; observations are not identity proof |
| `QualityAssessment` | Metric versions, applicability, input/output references, scores/units, thresholds, uncertainty, failure regions and reviewer disposition |
| `RenderOutcome` / `DeliveryOutcome` | Registered outputs, exact technical descriptors, validation, degradation, provenance and publication certainty |
| `ConsentReference`, `RightsDecision`, `ProvenanceManifest` | Separate authority references for permission, lawful/contractual permitted use and observed creation history |

Use IDs and references across boundaries, not in-memory framework objects. Public schema changes require compatibility classification. Product-specific payloads are discriminated and validated; arbitrary `Map<string, unknown>` is not an adequate contract for core operation semantics.

## 7.3 Graph validation and compilation

The processing graph is acyclic per admitted execution plan. Quality optimization creates bounded successor plans/attempts, not an unbounded cycle hidden in the scheduler. Stateful streams and simulations expose explicit loop/time-step contracts inside typed nodes with finite resources and cancellation; they are not arbitrary graph recursion.

Validate node IDs, edge references, input/output type compatibility, required artifact existence, per-node parameter bounds, expansion size, legal capability ownership, rights/policy compatibility, temporal/color/unit compatibility, output destinations and cycle absence before admission. A missing engine produces an explicit capability gap, never a silent substitution.

Compilation resolves reusable subgraphs and independently schedulable stages, but cannot reorder operations whose semantics depend on order. Denoise, sharpen, color transforms, alpha premultiplication and temporal filters cannot be freely commuted. Serialize external effects when required by their contract; parallelize independent immutable artifact operations within tenant/resource budgets.

## 7.4 Typed ports, common descriptors

A common `MediaCapabilityDescriptor` declares stable provider/adapter identity, public contract version, operation IDs, format/domain bounds, execution locations, resource needs, provenance, cancellation/reconciliation support, reproducibility class, license-admission reference and health/qualification observations.

Use separate interfaces for:

- `BatchMediaOperationPort`: prepare/estimate, submit, observe, cancel and reconcile a bounded operation.
- `MediaStreamPort`: open/connect, frame or chunk exchange, ordered acknowledgement, flow control and close.
- `AnimationRenderPort`: supported scene/animation subset, preview, evaluate time and bounded render/export.
- `SimulationPort`: validate initial state, step/run to time, checkpoint/restore and export measurements/passes.
- `InferenceCapabilityPort`: a product-side adapter to AI Inference’s public contract, not a second model registry.
- `ArtifactAccessPort`, `QualityAssessmentPort` and `DeliveryPort`: bounded domain-specific outcomes with explicit access/finality.

Capabilities can implement multiple ports but must not return invented success for unsupported methods. External SDK classes, tensor/device handles, scene-engine objects, filesystem paths, database entities and credentials never enter the Media public domain model.

## 7.5 Layered context and authority

Do not serialize one giant unrestricted execution context everywhere. Use three projections:

1. **Trusted execution context:** authenticated tenant/principal/delegation, purpose/classification, rights/consent decision references, residency/egress, deadline/cancellation, budget and permitted effects. Only verified services may construct or widen authority.
2. **Media intent context:** desired outcome, source assets, quality/preservation/latency preferences, locale/accessibility needs, scene and project references. User supplied values are intent, not permission.
3. **Diagnostic context:** bounded opaque correlation/trace/job/attempt references and safe outcome codes. No credentials, raw media, prompts, voiceprints, signed URLs or unrestricted tenant/user IDs.

Project context into each hop according to need. Revalidate expiring/revoked policy at dispatch and artifact access; cached plan admission does not authorize all future execution. OTel baggage is diagnostic context, not a trusted authorization channel [W05].

---

# 8. Time, geometry, animation and simulation contracts

## 8.1 Time is an explicit type

Use integer samples/frames or rational time `{value, timescale}` and rational rates `{numerator, denominator}`. Define intervals as `[start, end)` and specify rounding at each conversion. Avoid accumulating floating-point milliseconds across a long timeline.

Maintain separate clocks: media presentation time; source decode/presentation timestamps for variable-frame-rate inputs; audio sample time; `t_sim` simulation time; `t_story` explanation/animation time; and wall-clock deadlines. Scrubbing or pausing story time must not unintentionally advance a scientific model. A recording’s timestamp is not its duration, and `(frameCount - 1) / fps` versus `frameCount / fps` must be interpreted against the model/container contract rather than guessed.

Specify frame indexing, drop-frame timecode when supported, frame-rate conversion, encoder priming/padding, sample-rate conversion, discontinuities and drift correction. A 24000/1001 source must not silently become 24 fps with accumulated drift. Variable-frame-rate imports carry a mapping or are explicitly normalized into a new artifact.

## 8.2 Image/color/audio descriptors

Every image/video artifact records width/height, pixel aspect ratio, orientation, clean aperture when used, frame-rate/time mapping, bit depth, chroma subsampling, range, primaries, transfer function, matrix coefficients, alpha mode and relevant HDR metadata. Color configuration/LUT versions are fingerprinted. Distinguish display-referred/scene-referred processing; make premultiply/unpremultiply explicit and preserve alpha where required.

Audio descriptors include codec/container, sample format/rate, channels and layout, duration/sample count, loudness/true-peak measurements where available and encoder delay. Do not use the STT 16 kHz mono default as the universal mastering format. Preserve original and intermediate precision; choose output-specific targets through an admitted mastering/delivery profile.

Resolution must satisfy both model-native grid/latent constraints and encoder pixel-format alignment. `720×405` is not a universal safe default; do not assume an odd height works with the chosen 4:2:0 encoding. Requested display aspect ratio, model generation dimensions and final crop/pad/scale are distinct and disclosed in the resolved plan.

## 8.3 Scene and physical units

Use an explicit scene-coordinate convention, units and handedness in the contract; the initial Media-native convention is right-handed, +Y up, meters, seconds, kilograms and radians unless a domain model declares converted units. The initial native convention uses camera forward −Z, quaternions `[x, y, z, w]`, column vectors, local transform `T × R × S`, world transform `parentWorld × local`, and column-major serialized matrices. Pivot operations are explicit transforms, not hidden engine defaults. Image-space controls use a top-left origin and pixel-center coordinates; normalized coordinates declare their mapping. Phase 0 must validate these proposed conventions against the admitted existing Ghatana scene/model contracts and record any necessary conversion rather than imposing a conflicting universal schema. Import adapters perform tested conversions; silent axis flips or degree/radian mixing fail validation.

Simulation models specify equations/constraints or an authoritative model reference, initial/boundary conditions, solver type, fixed/adaptive step, tolerances, integration policy, collision representation, mass/inertia and material parameters. Scene meshes need not equal collision meshes. Physics controls cannot be inferred from a pretty render.

## 8.4 Animation/simulation engine independence

Evaluate TutorPutor’s existing animation, renderer, physics and AEF work first [R04, R05]. Media must not duplicate its learning Experience IR, scientific Model IR or assessment semantics. Establish a typed conversion between a domain-owned model/scene projection and Media’s rendering/animation contract. Shared mechanics may be extracted only after both owners accept the boundary and isolated consumer tests.

Use ECS internally where appropriate, but an engine-specific ECS is not the public schema. SceneGraph owns visual entities and bindings; SimulationWorld owns physical/model state; AnimationGraph owns time-varying presentation/control. An explicit bridge determines whether animation drives kinematic objects or simulation drives rendered transforms. Contradictory dual ownership of the same property is rejected.

Interchange adapters target declared subsets. Evaluate glTF/GLB for delivery and OpenTimelineIO for editorial exchange before inventing equivalent formats; neither is a universal physics/authoring/runtime [W07, W08]. OpenUSD/MaterialX/volume formats are optional qualified adapters. Every export/import declares unsupported features, conversion losses and material changes. A lossy conversion requires an explicit user/policy disposition, not silent flattening.

## 8.5 Reproducibility and fidelity

| Class | Required claim and test |
|---|---|
| `EXACT_ENVIRONMENT` | Same declared engine/model/runtime/hardware/configuration/assets/seed produce identical declared output representation; demonstrate in the supported envelope |
| `TOLERANCE_BOUND` | Numeric, geometric, perceptual or timing deviations satisfy named metrics and tolerances; record measurement scope |
| `STATISTICAL` | Repeated outputs satisfy a specified distribution/quality protocol; seed is provenance, not an identical-output promise |
| `REPLAY_UNAVAILABLE` | Capture source/output and execution provenance; do not offer unsupported reproduction |

GPU/model behavior is not guaranteed identical across platforms/releases [W03]. Solver determinism, render determinism and encoded-byte determinism are separate. Decoder/library versions and encoder threading may matter. Preserve adequate checkpoints and input event order, and test failure/recovery under the admitted class.

Scientific/domain fidelity is separate from visual quality. Adopt the domain owner’s declared fidelity tiers through mapping—TutorPutor uses illustrative through empirically calibrated tiers [R04]—rather than relabeling a photorealistic render “scientifically validated.” Visual level of detail may adapt without lowering model fidelity; changing model fidelity needs explicit acceptance.

---

# 9. MediaSynth, automatic quality and intelligent assistance

## 9.1 One creation coordinator, reusable specialists

MediaSynth coordinates planning, references/keyframes, image/video/audio generation, continuity and composition. `ScenePlanner`, `ReferenceImageGenerator` and `VideoGenerator` are Media-specific facades over typed capabilities. `AVSyncEngine`, `RenderComposer`, `ContinuityEngine` and `MediaQualityEngine` are shared Media modules used by generated and imported-media workflows, not private duplicates inside MediaSynth.

The generation strategy is selected from admitted strategies: `DIRECT_T2V`, `T2I_THEN_I2V`, `MULTI_KEYFRAME_I2V`, `REFERENCE_VIDEO_V2V`, `STORYBOARD_TO_VIDEO`, `POSE_CONTROLLED`, `DEPTH_CONTROLLED`, `TRAJECTORY_CONTROLLED`, `SIMULATION_GUIDED`, and `PROCEDURAL_PLUS_GENERATIVE`. Selection considers references, required continuity, motion complexity, rights, latency, cost, hardware and qualified capabilities. No universal claim that T2I→I2V always outperforms direct T2V.

## 9.2 End-to-end controlled pipeline

```text
Intent + source/reference artifacts
  → preflight / rights / constraints / bounded estimate
  → scene plan and editable storyboard
  → character/environment/style continuity references
  → required reference/keyframe generation or procedural scene
  → structural/reference checks
  → optional geometry/pose/segmentation/simulation conditioning
  → admitted image/video/audio generation candidates
  → qualified comparison and defect localization
  → bounded selective repair or whole-shot regeneration
  → eligible temporal/spatial/audio refinements
  → A/V alignment, exact graphics, captions, color and mix
  → master render
  → structural + intent + quality + policy validation
  → registered master and delivery renditions
```

A user can start at any supported stage with existing assets. Expensive work begins only after admitted inputs, rights and budget. Scene planning may use an LLM, a template, user-authored scenes, or deterministic rules; absence of an optional planner must not prevent manual storyboarding.

`SceneBrief` records scene ID/purpose/narrative beat, visual prompt or procedural specification, negative constraints, shot/camera/motion, duration, references, narration segment, transitions and safety limits. The control bundle includes subject/camera paths, start/end/intermediate frames, reference identities, masks and geometry. Provider acceptance returns actual dimensions/frame count/fps/duration, seed behavior, execution reference and limitations—not merely the requested values.

## 9.3 Quality without false guarantees

Evaluate **structural validity, perceptual quality, intent fidelity, domain/scientific constraints, rights/safety and delivery compatibility separately**. They are not one interchangeable score. A metric records applicability, version, dataset/calibration limits, uncertainty and an abstention state. Reference-based metrics require an appropriate aligned reference. Learned quality models need domain/language/style qualification; a high aesthetic score cannot override identity, speech meaning, physics, rights or preservation requirements.

ContinuityEngine compares references for face/character/body/clothing/props/environment, geometry, lighting/palette, camera and object presence/location. Prefer authorized embeddings, tracking, geometric and color signals where applicable. Report uncertainty and false-positive/false-negative limitations. Do not promise automatic validation of every hand, identity, physics event or narrative claim.

Use deterministic measurements when sufficient. Specialized ML can identify candidates for repair; generative models may repair only within authorized preservation/cost bounds. An LLM critique is supplementary, not sole approval for technical or scientific correctness.

## 9.4 Bounded quality improvement

`QualityOptimizationPolicy` declares maximum candidate count, repair attempts, wall time, compute/cost, acceptable degradation, minimum improvement, preserved properties and stop conditions. Each attempt records the exact predecessor, affected region/temporal interval, context halo, changed bindings, measurements and selected result.

Selective frame/region repair is offered only if the provider and temporal compositor support it. Motion/flow or long-context generation may require a surrounding temporal window or full-shot regeneration. Recompute dependent masks/tracks/captions/provenance only when their inputs changed. Preserve synchronization and seam continuity. No arbitrary promise that a 0.7-second defect can always be fixed independently.

Stop on success, exhausted budget, no significant improvement, unavailable eligible repair, policy rejection or unresolved result. Return the best **eligible** version with its quality disposition, or explicit failure/review required. Never turn repeated attempts into unbounded spending or silently replace a human-selected version.

## 9.5 Profiles are orthogonal

| Axis | Initial vocabulary | Rule |
|---|---|---|
| Quality intent | `preview`, `balanced`, `high-quality`, `master` | Product target; `cinematic` is a presentation/template alias of a declared quality+delivery combination, not another independent policy |
| Resource profile | `standard`, `low-resource` | `low_vram`/`low-vram` are migration aliases where required; resource savings do not inherently authorize lower fidelity |
| Execution location | `local`, `remote`, `hybrid` | Policy and admitted deployment decide availability; no cloud fallback for local-only work |
| Preservation | `preserve`, `enhance`, `creative` | Preserve forbids invented semantic detail; enhance permits bounded perceptual reconstruction; creative permits admitted generative edits |
| Delivery | Web, social, podcast, broadcast, cinematic, archival, interactive or explicit named profile | Exact codec/container/color/audio/caption constraints, targets and compatibility |
| Reproducibility | The classes in §8.5 | `deterministic-test` belongs to fixtures/test bindings, never a fake production provider |

Fallback is a structured permission: preserve aspect ratio; allowed resolution reduction; allowed frame/duration change; allowed model/engine substitution; required quality floors; budget; and whether confirmation is required. Record requested/effective profiles and reasons. OOM is not permission to turn a strict master into preview. Keep model-native generation settings such as steps, guidance, offload and quantization in qualified binding profiles, not ordinary user requirements.

## 9.6 Native intelligence, not gratuitous automation

Use deterministic DSP/CV when sufficient; specialized ML when it improves a measured task; generative models for authorized reconstruction/creation; LLM/agents for genuinely open-ended intent/planning. This is a selection preference, not a claim that the simplest method is always best.

Automatic proposals include noise cleaning, captions, shot selection, smart crop, color matching, continuity repair, delivery variants and semantic search. Show why a material change is proposed in product language. Low-risk reversible processing can run under a previously accepted policy; egress, identity alteration, fidelity reduction, substantial cost increase or publication requires the appropriate authority and visible decision.

No training, feedback export, private-corpus indexing or cross-tenant personalization is inferred from using the product. Qualification/promotion of a model is a governed change; “AI everywhere” never means uncontrolled self-updating production behavior.

---
# 10. Public API, SDK and CLI contracts

## 10.1 Preserve the current wire boundary during relocation

The current Media runtime and the operation-oriented TypeScript client do not expose identical upload paths/shapes [R13, R19]. This is an observed reconciliation requirement, not permission to choose an unrelated new API during the move.

Retain the documented `/api/v1/artifacts/uploads`, `/api/v1/jobs` and `/api/v1/streams` lifecycle as the relocation baseline and verify actual transport parity [R19]. Inventory every actual route, client operation, proto field and external consumer. Register any `/api/v1/media/*` facade as an adapter with documented semantics and tests, or classify it as an unimplemented intended contract. Do not silently call it implemented. The source-of-truth matrix identifies the owner and implementation for every method/path/action.

New operations use the canonical Media OpenAPI boundary under `contracts/openapi/media.yaml`, extended additively where possible. Do not add parallel `/v1/render/jobs` or `/v1/*` lifecycles solely because examples used those paths. Preserve existing response shapes for supported consumers until explicit version negotiation/migration. Wire names can differ from canonical domain names only through a tested adapter.

## 10.2 Required operation model

A typed operation request contains a stable operation ID/version, input artifact/version references or typed text/scene inputs, parameter object, project/context references, requested profiles, permitted fallback, bounded deadline/budget and a client idempotency key. Tenant/principal authority is established from verified credentials; body or header hints must match, never widen it.

Batch requests use a bounded execution group with a stable group ID and per-item semantic keys, budgets and job/output references. Define fail-fast versus continue-on-item-failure explicitly; a partial group reports each item’s outcome and cannot masquerade as complete. Retrying a group must reuse completed eligible items and must not resubmit ambiguous ones. This is Media batch semantics over the existing job mechanism, not a new generic workflow engine.

The accepted response identifies the job, canonical status, operation, request fingerprint, observation location, and whether the response is a replay. Admission persists the job/command identity before returning acceptance. Acknowledgement is not render completion. Errors distinguish validation, authentication, authorization, policy, rights/license, unavailable capability, capacity/quota, conflict, timeout, cancellation, provider ambiguity and internal failure. Include safe remediation, retry eligibility and correlation—not provider bodies or secrets.

The API contract must specify:

| Operation group | Required behavior |
|---|---|
| Upload | Begin, observe/resume, append bounded ordered parts, complete after full size/hash verification, abort/expire and clean temporary state; define index base and idempotent part replay |
| Artifact | Read metadata, authorized bytes/download reference, list/search/filter/cursor, derive, share/revoke and governed delete; Range/download resumability where supported |
| Job | Submit, status/list, progress stream or polling, cancel, explicit retry, reconcile, output lookup; no implicit retry of an uncertain effect |
| Project/scene/timeline | Versioned CRUD and patch operations, validation, immutable snapshots and optimistic concurrency |
| Profiles/capabilities | Safe contract and currently eligible capability discovery, limits, unsupported combinations and qualification status |
| Delivery | Render/master/encode/export/publish as typed jobs/effects; output finality and destination acknowledgement distinct |
| Health | Liveness, readiness and authenticated detailed diagnostics with independent semantics |

Long-running observation supports bounded polling and, when implemented, a resumable event stream with monotonic IDs/continuation. Event-stream disconnect does not lose job state. Missing progress measurements are `unknown`, not made-up percentages. Endpoints and status codes are authored in the contract, generated into SDKs/fixtures and tested against the actual transport.

## 10.3 Idempotency and content limits

Canonical identity includes tenant, authority scope/principal where relevant, operation/version, client key and canonical request fingerprint. Same key and same request return the same accepted job/outcome; same key with different semantic content returns conflict. State the retention window and behavior after expiry. Retry after a network timeout first observes the existing request/operation; it never blindly creates another expensive job.

Validate finite text lengths, nested object depth, array counts, source sizes, duration, pixels/frame counts, sample rates, channels, graph nodes/edges, timeline clips, generated candidates and output bytes. Unknown parameters fail closed unless the contract explicitly declares a namespaced extension. Provider parameters cannot overwrite reserved authority, budget or routing policy.

Binary data moves through governed artifact access, not arbitrary public URLs, server file paths, raw S3 references or huge JSON/base64 bodies. External import requires a separate bounded fetch/admission operation with source/rights and SSRF controls. Signed references are short-lived capabilities, not durable identifiers. Pure text generation uses typed text input; it may persist a protected request document under policy but must not invent a fake media artifact.

## 10.4 SDK parity

Preserve `@audio-video/client` and `@audio-video/types` on relocation. Reconcile their exported legacy facade and operation API deliberately; do not create another independent state/operation taxonomy. Generate types and transport mappings from the accepted contract where the ecosystem supports it, and preserve runtime response validation.

Cancellation of a local SDK wait/poll is different from cancelling a server job. Provide explicit methods for each. Error objects expose structured reason codes, output references for partial results, and uncertainty. Avoid a generic thrown string that loses these distinctions. Published-package tests run without sibling repository source, provider credentials or runtime implementation imports.

## 10.5 One product command registry

`ghatana-media` is the binary. Every canonical CLI command maps to the same action/operation ID as Web/API. Simple aliases compile into the same request/plan; they do not implement separate business logic.

| Command family | Canonical intended commands |
|---|---|
| Help/setup | `help`, `version`, `doctor`, `config show`, `config validate`, `auth login`, `auth status`, `auth logout` through supported Ghatana identity flows |
| Plan/run | `plan --request FILE`, `run --plan FILE`, `run --request FILE`; plan inspection is not execution or paid inference by default |
| Simple entry points | `create`, `improve`, `edit`, `animate`, `simulate`, `understand`, `deliver`; accept files or artifact references plus meaningful intent options |
| Artifact | `artifact upload FILE`, `artifact list`, `artifact get ID`, `artifact download ID`, `artifact delete ID`, `artifact provenance ID` |
| Project | `project create`, `project list`, `project get ID`, `project export ID`; version/branch actions as admitted |
| Jobs | `job submit`, `job list`, `job status ID`, `job watch ID`, `job cancel ID`, `job retry ID`, `job reconcile ID`, `job outputs ID` |
| Synthesis | `synth plan`, `synth image`, `synth video`, `synth audio`, `synth music`, `synth compose`, `synth render`, `synth run`; finite aliases over creation/composition operations |
| Speech/voice | `speech transcribe`, `speech synthesize`, `voice train`, `voice convert`, `dub`, `captions generate`, `captions align` |
| Analysis | `inspect FILE_OR_ID`, `vision analyze`, `vision segment`, `vision track`, `vision depth`, `vision pose` |
| Enhancement/editing | `enhance denoise|deblur|upscale|interpolate|stabilize|deflicker`, `edit inpaint|remove-object|background|relight|reframe|retime` |
| Audio | `audio denoise`, `audio separate`, `audio super-resolve`, `audio master` |
| Synchronization/quality | `sync av`, `quality inspect`, `quality compare`, `quality optimize --plan-only` and explicit application of the accepted plan |
| Diagnostics | `profile list`, `profile show ID`, `profile validate FILE`, `provider list`, `provider health`, `provider capabilities` |

A parameterized command family expands to an explicit finite registry. Completion/help comes from that registry. External-engine/model names are expert diagnostics, not required positional arguments. Do not invent unsupported API routes just to make a command appear to work.

Example **target contract**, not a claim that this command is implemented:

```sh
ghatana-media improve interview.mp4 --preservation preserve --plan-only
ghatana-media run --plan interview.media-plan.json --wait --json

ghatana-media synth run \
  --prompt-file lesson.txt --profile balanced --duration 8s \
  --aspect-ratio 16:9 --voiceover voice.wav --output lesson.mp4 --wait
```

Local paths belong to the CLI, which uploads/registers authorized assets. They never become unrestricted server-side path reads. `--output` is a client download destination; protect against overwrite, traversal and symlink surprises. A filename can contain spaces/unicode; never interpolate it into a shell command.

## 10.6 Machine-output and control behavior

`--json` emits one versioned result/error object to stdout; no banners, ANSI escapes or progress text. `--jsonl` is the distinct streaming observation mode. Diagnostics use stderr and are redacted. Honor non-TTY output, `NO_COLOR`, `--quiet`, terminal width and accessible plain text. Graphical terminal presentation must not change exit semantics.

Default remote submission returns after durable acceptance; exit 0 means the requested submission succeeded, not that the media is ready. `--wait` returns the final requested result or an explicit non-success. `--no-wait` is mutually exclusive with `--wait`. `--timeout` bounds the client wait unless the command explicitly defines a server deadline option. Ctrl-C stops local observation and exits 130; cancelling remote work requires `job cancel` or a separately explicit `--cancel-on-interrupt` policy.

| Exit | Meaning |
|---|---|
| 0 | Requested action succeeded; for submission-only, durable acceptance is the action |
| 2 | Invalid arguments or input validation |
| 3 | Authentication failure |
| 4 | Authorization, privacy, rights or policy rejection |
| 5 | Required capability unavailable/unqualified |
| 6 | Capacity, quota or dependency admission rejection |
| 7 | Job failed |
| 8 | Remote job confirmed cancelled |
| 9 | Client wait timeout; remote job may still run |
| 10 | Outcome unknown/reconciliation required |
| 11 | Version or idempotency conflict |
| 12 | Local configuration error |
| 13 | Partial completion not accepted as success by the command contract |
| 130 | Local interruption |

Keep global flag applicability explicit; do not pretend every read command needs an idempotency key. Mutation retry/replay uses persisted keys. Non-interactive consequential commands must receive explicit approval/policy input and fail rather than block for a prompt. Do not store bearer credentials in project files, command history or exported plans. Use existing Ghatana authentication methods and protected credential storage; any missing device/PKCE flow is an owner dependency, not an invented endpoint.

Configuration precedence is explicit flag → environment → selected project/profile file → user config → product defaults, **all constrained by non-overridable policy**. Reject conflicting/unknown profile fields. `config show` reports effective values and safe provenance, never secrets. Configuration files are declarative data, not executable scripts.

---

# 11. Security, privacy, rights and safe native execution

## 11.1 Independent governance axes

A concise UI can summarize policy, but the domain must keep these axes separate: access/sharing; sensitivity/classification; tenant/workspace ownership; processing locality; residency; egress; retention; provider retention; training/secondary use; consent; asset/model license; and likeness/voice rights. “Private” does not prove local processing, and “local” does not prove authorized use.

Default to minimum necessary data, tenant isolation, no public sharing, no secondary training and denied unapproved egress. Source classification establishes a floor for derived data unless an authorized de-identification process explicitly permits a change. Rights attestation is a user assertion; verified consent and license eligibility are separately evaluated. A model-generated assertion cannot authorize itself.

Use Shared identity/security/governance contracts and existing authentication services through their public boundaries. No Media-local parallel IAM, crypto implementation, JWT parser or generic consent framework. Media supplies media-specific purpose, access, rights and retention policy.

## 11.2 Enforcement points, not one startup check

Enforce at upload/import admission; metadata persistence; planning; dispatch; artifact fetch; worker invocation; external inference; output registration; sharing/export/publication; and cache reuse. Check revocation/expiry at appropriate boundaries during long-running/streaming work. Policy changes stop further unauthorized dispatch/frames and restrict outputs; cancellation ability and external provider retention remain truthful.

Sign or authenticate service context through the existing ecosystem identity mechanisms. Bind delegation, audience, permitted operations, resources, budget, expiry and parent execution. Client-provided tenant IDs, trace IDs and “safety approved” fields are not independent authority. Deny conflicting authorities before any paid or externally visible work.

## 11.3 Treat all input and generated programs as untrusted

Defend uploads, downloads/imports, archives, codecs/containers, fonts, SVG, scene files, shaders, scripts, models, project bundles and metadata. Validate declared and detected formats; bound decompression, dimensions, frame duration/count, poly/texture counts and parser complexity. Normalize filenames and constrain extraction roots; reject escaping paths/symlinks. Decode in an isolated worker before promotion to trusted usable content.

Network import/provider adapters enforce destination allowlists, DNS/IP/redirect policy, scheme limits, response-size and timeout limits; block unauthorized private/link-local/metadata endpoints. A URL supplied by a user or model cannot cause arbitrary service credentials to be forwarded. Signed object URLs are excluded from ordinary logs and expire without changing artifact identity.

Scene engines and tools can execute scripts. Disable script execution by default for imported scenes; admitted automation uses a restricted, reviewed mechanism. A request to “generate a Manim animation” must not directly run arbitrary model-produced Python with host/network access. Compile safe structured intent to approved templates, or use a separately sandboxed, permissioned code-execution capability with explicit bounds.

## 11.4 Isolation and resource controls

An external process is not automatically sandboxed. Define OS/container/WASM controls, unprivileged identity, read-only approved inputs, isolated scratch space, narrowly writable outputs, network egress rules, syscall/capability restrictions where applicable and child-process-tree ownership. No shell interpolation. Engine/plugin/model installations are admitted by digest/version/license and never automatically trusted from a submitted project.

Bound CPU, RAM, VRAM, scratch storage, process count, open files, decoded pixels, frames, audio samples, shader complexity, particles/bodies/solver substeps, retries and total job time. Recover/clean scratch on crash and termination. GPU cancellation may not preempt an arbitrary kernel; expose cancellation requested until worker/provider termination or confirmation establishes finality.

Maintain tenant-aware resource admission, fair scheduling, per-job budgets and circuit breaking through appropriate Ghatana mechanisms. An expensive render/simulation cannot starve status, cancellation, rights checks or upload control APIs.

## 11.5 Deletion and lifecycle truth

Lifecycle policy covers originals, derivatives, thumbnails, proxies, captions/transcripts, masks/geometry, embeddings/voice models, source requests, temporary files, cached intermediates, exports, remote provider copies, backups and retained audit/provenance. References, legal holds and retention constraints require explicit decisions; do not blindly delete shared physical bytes still referenced by an authorized retained artifact.

Use states such as `ERASURE_REQUESTED`, `ACCESS_REVOKED`, `PHYSICAL_ERASURE_PENDING`, `ERASURE_CONFIRMED`, `BLOCKED_BY_HOLD` and `EXTERNAL_ERASURE_UNCONFIRMED`. State names are product proposals to materialize in Phase 0. Do not mark physical erasure complete when only metadata was hidden. Restore procedures replay erasure tombstones before data becomes accessible so backups do not resurrect deleted content.

A downloaded or published copy may be beyond Media’s control; revoking access cannot honestly promise remote recall. Explain scope. Preserve only allowed minimal provenance/audit under retention policy; “immutable” does not require retaining personal content forever. Encryption, key deletion and provider deletion claims need the deployment-specific proof they assert.

## 11.6 Audit, safety and integrity

Reuse Shared audit [R09]. Consequential operations first persist required audit/effect intent in a failure-safe arrangement with job/state changes; delivery to a central sink may be asynchronous through an admitted durable path. If the required durable intent cannot be recorded, do not cross the external effect. If the effect might have happened and final persistence fails, report uncertainty—never replay to repair the log.

Telemetry can degrade without changing business outcome; required audit durability is different. Audit records contain necessary protected identity and product facts, not raw operational logs. Hash chains are tamper-evident only under their stated trust assumptions, not proof against an administrator rewriting all state [R09].

Origin labels distinguish source, edited, generatively enhanced, AI-generated and simulation-generated output. Optional C2PA integration conveys signed provenance under its trust model, not truth, copyright clearance or scientific accuracy [W06]. Missing/stripped provenance is “unavailable,” not evidence that media is authentic or malicious.

Threat-model prompt injection through transcripts/OCR/media metadata and agent requests. Untrusted content cannot modify system policy, select privileged tools or exfiltrate other assets. Likeness/voice abuse prevention, reporting/recourse, unauthorized biometric processing and prohibited-content checks have product rules, appeal/review and failure behavior. An opaque quality score cannot override safety or rights.

---

# 12. Durable operations, observability and deployment

## 12.1 State model and publication invariants

Separate overall job status, stage progress, cancellation outcome, remote outcome certainty, quality disposition and delivery status. Avoid one enormous enum that mixes these independent facts. Proposed job states include `QUEUED`, `RUNNING`, `RETRY_PENDING`, `OUTCOME_UNKNOWN`, `RECONCILING`, `COMPLETED`, `PARTIALLY_SUCCEEDED`, `FAILED`, and `CANCELLED`. Attempt claim/lease states remain technical execution records. Cancellation is orthogonal until confirmed; stage labels such as “planning” or “rendering” do not create another job authority.

An accepted job persists before exposure. A worker claims with a fencing token, renews within bounded time and records stage attempts. Stale workers cannot commit progress, register canonical output or publish finality. A provider completion is not sufficient: output bytes must be verified, registered with policy/provenance and meet the accepted result contract before `COMPLETED`.

Shared Workflow supplies state/command/idempotency mechanics; Media supplies definitions, repository, guards and handlers [R06]. Shared messaging supplies claim-aware publication primitives; Media supplies its durable outbox and cadence [R07]. Neither is assumed to be a complete GPU job scheduler. Do not add RabbitMQ, Redis Streams, Temporal or another workflow engine before a concrete reuse/capacity-gap decision.

## 12.2 Attempts and external uncertainty

Persist dispatch intent and attempt identity before crossing the provider boundary. Record that the external effect started. Timeout, connection loss, process crash or lease expiry after dispatch does not prove no work/cost occurred. Reconcile through provider execution IDs/idempotency receipts when supported; otherwise retain `OUTCOME_UNKNOWN` and require a safe decision.

Parent deadlines, cancellation and remaining budgets propagate to child stages and delegated agents; a retry/child run cannot reset them. Cancelling a parent stops new claims/dispatch and requests cancellation of active children, but retains truthful uncertainty until their effect outcomes are confirmed. Completed child assets are retained or erased according to the accepted lifecycle policy.

Retries are bounded, classified and use the owner-defined idempotency key. Backoff is jittered and respects total deadlines, but the plan compiler’s deterministic meaning does not require identical wall-clock retry timing. A retry creates a new attempt, not a second logical request. Profile/model fallback must pass policy/rights/cost/quality eligibility again. Do not multiply retries independently in CLI, SDK, API, worker and provider.

Terminal outputs are immutable versions; corrections append an authorized reconciliation/revision record. They do not rewrite old execution evidence. Idempotent state/effect handling can provide one canonical result publication; do not advertise “exactly once” remote inference without a provider contract proving it.

## 12.3 Artifact and incremental-work reuse

Cache identity includes source artifact digests and relevant versions, operation/schema version, parameters, engine/model/runtime/hardware constraints, seed/reproducibility class, temporal/color/audio/layout/font configuration and quality/delivery profiles. Reuse is tenant/ownership compatible and rechecks current rights, consent, retention, license and policy even if bytes are identical.

Never share private embeddings, voice models, prompts, sensitive deduplication existence or generated candidates across tenants by default. Cache content identity and authorization are separate. Changed input invalidates downstream dependent nodes, not every project. A temporal repair invalidates its declared context window and dependencies; unchanged scenes and audio can be reused only when their timing and policy remain compatible.

## 12.4 Native observability with bounded overhead

Consume Shared observability [R08]. Propagate context explicitly through executors/promises/RPC/worker callbacks; capture, install, restore and clear scopes. Do not assume thread-local context crosses asynchronous execution. Instrument API admission, upload/finalization, queue/claim, stage dispatch, inference, render, validation, storage, erasure, outbox and delivery.

Measure bounded, low-cardinality counters/histograms for latency, queue wait, success/failure categories, retries/cancellation/unknown outcomes, profile degradation, quality assessment applicability, render/generation duration, A/V drift, bytes, worker occupancy, cache reuse, budget estimates/settlement and publication/erasure lag. Do not label metrics with unbounded job IDs, prompts or raw tenant/user IDs. Keep high-cardinality forensic details in access-controlled stores rather than metric labels.

Logs are structured safe diagnostics; traces correlate operations; audit captures accountable actions; provenance captures media derivation. They have distinct schemas, retention, access and failure semantics. Redaction failure drops/quarantines unsafe telemetry and signals safe diagnostic degradation, never falls back to raw logging. Exporters have bounded queues, backoff, sampling and drain/close budgets.

User-facing activity summarizes “Queued,” “Working,” “Improving,” “Recovering,” “Ready” or “Needs attention,” mapped from technical state. A user may inspect details; ordinary progress never exposes sensitive implementation diagnostics.

## 12.5 Deployment profiles and offline behavior

Readiness is capability-scoped: the control plane requires its declared identity and durable stores, whereas streaming/model/render dependencies gate the capabilities that use them. An unavailable optional AI planner must not make deterministic editing unavailable. The existing launcher’s broader readiness prerequisites are preserved during relocation and changed only in the accepted downstream refactor, not hidden inside the move.

Define `local-development`, `private-local`, `connected-production` and `hybrid-production` as explicit deployment contracts, not configuration shortcuts. In-memory/local diagnostic providers are never production evidence. Each deployment declares durable stores, identity policy, artifact encryption, backup/restore, quota/budget, optional integrations, capabilities and stop conditions.

Local/private operation can use deterministic engines and an admitted local inference deployment while preserving AI Inference ownership. Do not introduce a direct-model exception simply because an ONNX file fits on a laptop. Preserve existing owner-approved bounded worker paths, such as document intelligence, within their published restrictions [R15]; expanding their model/provider function needs an owner decision.

Offline operation has an explicit entitlement/policy validity window. It cannot claim fresh remote revocation checks while disconnected. No auto-download of models or cloud fallback without approval. Browser-to-local-worker communication requires authenticated pairing, origin restrictions, CSRF/rebinding defenses and least-privilege file grants; binding to loopback alone is insufficient.

## 12.6 Performance targets are proposed acceptance budgets

The following are **initial proposed budgets**, not observed performance or universal promises. Phase 0 records them; qualification freezes hardware, load, corpus, network conditions and measurement method. A material change requires explicit target revision, not a denominator shortcut.

| Surface | Proposed budget / acceptance method |
|---|---|
| Small status/metadata request | p95 ≤ 300 ms at 50 requests/s on the named reference environment, excluding external model execution; no sensitive response leak |
| Bounded job admission | p95 ≤ 500 ms when stores/policy are healthy, source references already registered and capacity available; includes durable acceptance |
| Web control feedback | Visible acknowledgement of local interaction within 100 ms under the defined reference project; expensive work asynchronous |
| Editor responsiveness | Scrub/selection/undo p95 ≤ 100 ms for the admitted preview-size fixture; render fps and large-project limits separately profiled |
| CLI help/version | p95 ≤ 500 ms on named machine without network/GPU initialization; no model loading for metadata-only commands |
| Cancellation UX | Acknowledge request within 1 s on healthy control plane; actual provider termination measured and reported separately |
| Resource safety | Every job has finite bounds; no increase beyond configured process/memory/disk/VRAM/graph ceilings under adversarial fixtures |
| A/V timing | Timestamp mapping and synthetic impulse/frame fixtures within declared sample/frame tolerances; no universal perceptual lip-sync threshold assumed |
| Availability/recovery | Deployment-specific SLO/RPO/RTO require owner-approved numbers and restore/soak tests before production activation; unavailable evidence is a gate, not a fabricated target |

Generation, scientific simulation, rendering and quality optimization receive per-profile benchmark budgets; do not set a single arbitrary latency across all engines and hardware. Cold start, warm inference, preprocessing, queueing, encoding and download are measured separately.

---

# 13. Behavior-preserving product graduation and cutover

The destination is the standalone repository `samujjwal/ghatana-media`. `ghatana-products` participates only as the ecosystem portfolio/extraction registry owner; it does not host the Media source tree after this decision. The extraction follows the ecosystem's `ghatana-<product>` naming convention, so no repository-name exception is required.


## 13.1 Migration scope and authority order

Migration transfers the whole Media bounded context, including document intelligence and all admitted clients/tests/configuration, except items individually classified for a legitimate different owner. It is not an excuse to discard capabilities or copy platform machinery into Products. Target product ownership is the intended decision; live source remains canonical until the explicit cutover.

First accept a **Phase-0 boundary slice**: product identity, what moves/remains, ecosystem contracts, named consumers, compatibility commitments, and the migration authority. This does not require completing all future product features. Full Phase 0–3 definition can proceed against that boundary while behavior-preserving migration is prepared. Do not make full definition depend on cutover and cutover depend on full definition.

Before source cutover, the target may author prospective product requirements and migration records under the registered transfer intent, but current runtime contracts are **referenced from their existing owner**, not copied into a second editable authority. Approving intended future behavior does not claim that the current runtime implements it. A change to an existing owned concept is made through that owner until the cutover manifest transfers it; afterward, rebind the references and remove the former editable authority.

The extraction policy has a product-default location and a single-authority invariant, but its completed-extraction language also addresses outbound extracted repositories [R17]. Validate support for **inbound service-to-product graduation** against the actual schema/guard before adopting the record. Extend it at the policy owner when needed; do not weaken validation or assume the original sample already conforms.

## 13.2 Whole-tree and reverse-dependency inventory

Produce `migration/source-inventory.yaml`, `consumer-inventory.yaml`, `path-map.yaml`, `contract-compatibility.yaml` and `cutover-plan.yaml` in `ghatana-media`. Every source file has one disposition: preserve/move; move approved neutral mechanics to their owner; replace source coupling with a public contract; regenerate; retain external reference; or remove proven obsolete material.

Inventory code, generated sources, schemas, service-contract base records/overlays, Java/TS/Python/Rust packaging, native libraries, lockfiles, build scripts, tests/fixtures/golden data, model references, benchmark scripts, deployment charts/images, monitoring, secrets references, CI/local scripts, documentation manifests and integration consumers. Include root-level Media-specific tooling outside `services/media/` and references in other repositories.

Search reverse consumers across `ghatana`, `ghatana-products`, the prepared `ghatana-media` target, `ghatana-kernel`, `ghatana-shared`, `ghatana-tools`, `ghatana-yappc` and applicable `gharbatai`. Absence in a limited search is not proof of no consumer. Record evidence coverage and unresolved branches/environments. The exact benchmark scripts `run_t2v_bench.py` and `run_best_path.sh` were not established as available in this review; acquire their source before assigning extraction work based on them.

## 13.3 Initial path transfer

Preserve internal paths on the first move to reduce simultaneous changes:

| Source in `ghatana` | Target in `ghatana-media` | Instruction |
|---|---|---|
| `services/media/runtime-contracts/` | `runtime-contracts/` | Preserve types/semantics; identify public contract packaging for external consumers |
| `services/media/launcher/` | `launcher/` | Preserve startup/wire behavior; change owner/build wiring only |
| `services/media/modules/` | `modules/` | Move all classified modules, including speech/vision/streaming/voice/document worker; do not silently omit unused-looking directories |
| `services/media/providers/` | `providers/` | Preserve store/provider behavior and migration checksums; no premature DB replatforming |
| `services/media/libs/audio-video-*` | `libs/audio-video-*` | Preserve package names/export paths initially; update repository metadata and published bindings |
| `services/media/contracts/` | `contracts/` | Preserve supported OpenAPI/proto identities and wire field numbers |
| Media tests/fixtures/benchmarks/config/deploy/monitoring | Corresponding repository-root paths in `ghatana-media` | Rebind paths, preserve semantic tests, update packaging/qualification scope |
| Root Media-only validators/producer definitions | Product scripts/conformance or a neutral Tools owner | Move domain-specific validation; reuse generic tooling; leave only bounded consumer checks in `ghatana` |
| Generated service contract and registries | Generated from newly registered owner sources | Move base Media source records/overlays and generator ownership, then regenerate |

Later refactoring may introduce modules for generation, animation, simulation, quality and synchronization, but only through accepted contracts and focused changes. Do not reorganize all namespaces, APIs, databases and engines in the migration commit.

## 13.4 Registry and packaging updates

Products-side affected authorities include `config/canonical-product-registry.json`, `config/product-shape.json`, `config/product-extraction-records/media.yaml`, `config/repo-boundary.json`, ecosystem/development-subject and package registries, Gradle/pnpm generated includes, product verification bindings and deployment manifests. Confirm each file’s authored/generated status before editing. Add backend, web, CLI, SDK and Explorer surfaces with truthful status.

Ghatana-side affected sources include `config/runtime-service-registry.json`, `config/repo-boundary.json`, Media records in `config/service-contract-source.json`, `services/media/service-contract-supplements/`, runtime/product-definition/source manifests, module/package/owned-surface catalogs, service docs and deployment/monitoring composition. Regenerate `config/generated/*`, generated settings/workspaces and contract views through owning tools. Preserve other services’ records.

Remove Media from the **owned runtime service** inventory after transfer, but register required external capability integrations appropriately. Do not merely change hard-coded “seven” to “six” in tests: derive owned service membership from the canonical registry, and retain cross-service scenarios involving the external Media capability where still legitimate.

## 13.5 Core consumers and Data Cloud

Ghatana core must not import `ghatana-media` source or product implementation packages. Replace direct imports with existing neutral capability contracts, reviewed generated wire clients or product-integration providers at permitted boundaries. Neutral shared contracts must not import Media product internals in return. Product packages can be published without making every core runtime a product-package consumer.

Data Cloud retains authority for its generic governed metadata/read models and can keep valid Media-related consumer views. Media owns media creation/editing/artifact/job/stream semantics. Preserve existing navigation/deep links and integration behavior through a defined handoff or compatibility adapter until consumers migrate. A product extraction alone does not justify removing a customer workflow or making Data Cloud depend on Media’s database.

For document intelligence, preserve frozen Shared contracts, worker model admission, operation-generation token semantics, client cancellation and current qualification restrictions [R15]. Record consumers and their public binding; do not change their API or activation simply because the worker’s source moved.

## 13.6 Cross-repository source cutover protocol

1. Register approved transfer intent and authority scope. Source remains editable/canonical; target preparation is migration-only and cannot emit authoritative runtime state.
2. Capture source inventory, public contract snapshots and baseline tests. Record unresolved qualification separately.
3. Prepare target imports and published package artifacts with build/path changes only. Target shadow verification uses fixtures or authorized read-only material, never competing production writes.
4. Prepare consumer adapters and registry changes in both repositories. Validate artifact-only builds and old-client/new-owner compatibility.
5. Freeze the transfer slice for final reconciliation. Compare source material since the baseline; carry every legitimate change forward.
6. Admit a cutover manifest with target artifact identities, required consumer versions, external contract fingerprints, authority epoch, activation conditions and recovery instructions. Two Git commits are not an atomic transaction; the manifest coordinates compatibility.
7. Switch source ownership only when both repositories’ prepared states satisfy the manifest. Keep wire endpoints stable or route them through an approved gateway/provider binding.
8. Remove the old editable implementation and authored Media semantic sources; replace necessary discovery with an explicit external-owner reference, not a second runtime. Regenerate all affected views.
9. Rerun relocation/contract/import-isolation checks and record completion. A source move does not promote runtime readiness.

No production deployment or state change is implied by repository cutover. Runtime activation is separately authorized and requires its own qualification.

## 13.7 Runtime/data transfer, when separately authorized

Prefer retaining database schema names, migration histories/checksums, encryption/key references, object IDs/prefixes, job IDs and service DNS during source relocation. Moving a repository need not move bytes. A target deployment must not create an empty parallel store and present it as migrated data.

If runtime ownership changes, quiesce admission and drain/reconcile existing jobs and streams, or use an explicitly tested lease/fencing handover. Exactly one active writer/authority epoch is permitted. Verify artifact metadata/object consistency, pending outbox/audit, consent/holds/retention, backups and restoration. Do not replay uncertain remote model work. Test failure before/after every transfer barrier.

Operational rollback may route to a previously qualified binary only while data/API compatibility is proven; it must not reintroduce a second editable source authority or erase newer state. Source fixes are fix-forward. Do not attempt destructive schema rollback after non-backward-compatible writes; use a qualified forward-recovery procedure. This distinction preserves the user’s fix-forward development policy without pretending operational recovery never needs a prior compatible artifact.

---
# 14. Low-cognitive-load product experience

## 14.1 Small shell, broad capability

Default global navigation is **Home, Projects, Assets, Activity**. Settings and account/help remain utilities. Create, Improve, Edit, Animate, Simulate, Understand and Deliver are intent launchers, not seven permanently competing workspaces. Project context provides Storyboard, Editor, Audio, Captions, Versions and Outputs as needed. Profiles, provider diagnostics, rights detail, provenance and operations are contextual or role-scoped.

The full capability catalog remains available through search, recipes and expert inspection; the ordinary user is not required to select an engine, model, queue or codec. Every surface answers context, goal, current state, next action and material blocker. One dominant primary action does not mean hiding Cancel, Undo or a safety warning.

Use three disclosure levels over the same state/actions: **Simple** (intent and safe defaults), **Guided** (quality/style/duration/reference/output/privacy choices), and **Expert** (typed graph, curves, solver limits, generation/color/audio/encoding controls). Switching levels preserves edits and authority; it never creates a second workflow.

## 14.2 Safe assistance and decision burden

Analyze source properties automatically when permitted: format, orientation, frame rate, dimensions/color, language, speech segments, defects and compatibility. Keep inferential values labeled as estimated. Defaults must be policy-compatible, explainable and reversible where possible.

Automatically apply only transformations admitted by the project’s preservation, quality and budget policy. Surface material changes to fidelity, identity, narration meaning, egress, spending, rights or publication. Repeated safe technical steps do not need repeated dialogs. A first-run “Create” experience cannot bypass necessary authentication, permissions or missing local capabilities; explain the minimum missing prerequisite without forcing unrelated setup.

Contextual suggestions appear near relevant work: “Speech detected—add captions,” “These clips have inconsistent color,” or “This scene needs review.” Conversational intent is optional, never the only route. All conversation output compiles into inspectable canonical actions/plans.

## 14.3 Editing, review and collaboration

Edits are versioned and non-destructive. Autosave uses explicit revision acknowledgements and indicates pending/offline/conflict state. Undo/redo has a documented scope: local edit history is not reversal of an already published external effect. Branching/duplicate projects preserve source references and access. Review comments bind to artifact version and time/region, not a moving “latest” frame.

Use optimistic concurrency first; evaluate existing Ghatana/TutorPutor collaboration components before adding a new CRDT/service. Concurrent same-field edits require defined merge/conflict behavior. A visual timeline, graph and textual/accessible editor are projections of the same revision. A stale selection cannot submit a render against a different unnoticed revision.

Approvals bind exact output/version, review purpose, approver authority and expiry. Regeneration invalidates only approvals whose approved material changed. Shared review links have explicit scope, expiry and revocation; unauthenticated access is never implied by a URL.

## 14.4 Errors, attention and recovery

Preserve completed work. Explain what happened, which output is safe, whether anything may still be running, and the next permitted action. Provider ambiguity is not an ordinary retryable failure. A user may stop watching without cancelling. A missing high-quality capability offers an explicit compatible fallback only if policy permits it.

Notify for action required, material degradation, approval, completion of long work, delivery outcome or critical security/rights problems. Do not toast every internal stage. Batch notifications and respect user preferences except necessary security notices. Technical details remain available through a protected inspector/correlation reference.

## 14.5 Accessibility and localization

Target WCAG 2.2 AA for supported Web processes and assess media-authoring/output accessibility separately [W04]. Accessibility is not proven by importing Shared components. Provide semantic DOM/structured views for canvas, timeline, waveform, graph and simulation controls; keyboard selection/trim/reorder and non-drag alternatives; predictable focus; programmatic errors/status; captions/transcripts; visible audio controls; reduced motion; forced colors; zoom/text spacing/reflow and appropriate touch targets.

Avoid assuming machine captions, descriptions or translations are correct. Mark generated drafts and support review/correction. Distinguish prerecorded/live captions and audio-description requirements by output use. Flashing/motion risks require checks and safe playback behavior. Do not auto-play disruptive audio.

Use Shared localization and formatting. UI locale, speech language, subtitle language, voice locale and metadata/time formatting are independent. Define RTL/bidi, font fallback/licensing, shaping, long labels and translated-caption wrapping. Choose supported locale sets in Phase 0; unqualified languages remain visible as unavailable rather than silently falling back to English. Test at least a Latin and a Devanagari fixture plus RTL/pseudo-localization where claimed; this is a resilience test, not a launch-language certification.

---

# 15. Ecosystem-first dependency and OSS policy

## 15.1 Admission before procurement or implementation

No new runtime engine/library/model enters the critical path without a `reuse-decision` record. First inspect the corresponding Ghatana owner and public artifact. A package declaration is not evidence of publication, API stability, consumer isolation, license clearance or functional completeness. Validate the exact public exports, compatible versions, transitive closure and representative consumer tests.

A Ghatana dependency gap is handled in one of four explicit ways: extend its owning public contract; extract genuinely reusable mechanics with owner approval; use a bounded public integration; or select an external component after recording why the internal candidate is inadequate. Do not fork/copypaste Shared/Tools/Kernel into Media merely to move faster. Conversely, do not block a defined Media capability indefinitely on an unrelated ecosystem-wide hardening campaign: record the exact dependency scope and a permitted alternative, or isolate the blocked feature.

## 15.2 License and supply-chain admission

Prefer permissive code licenses such as MIT, Apache-2.0, BSD, ISC or Zlib when technically suitable. Separately review weak-copyleft components, strong-copyleft/network-copyleft components, proprietary services, noncommercial/research-only weights and unclear terms. These are selection categories, not legal conclusions that a whole bundle is safe.

For each selected release record source/version/digest, license expression and files, notices, modification/distribution mode, transitive/native dependencies, compiler/build flags, codecs, plugins, model weights, datasets, fonts/textures/audio assets, patent/trademark concerns, security advisories, supported platforms and replacement path. Produce SBOM, attribution and redistribution/source-offer material where required. A permissive Python wrapper does not make its downloaded model or codec permissive.

**Specific correction:** OpenVDB’s official license page identifies MPL-2.0; it must not be admitted as Apache-2.0 on the strength of the earlier plan [W02]. FFmpeg’s license obligations depend on its configured components; record the exact binary/build and enabled external codecs [W01]. Out-of-process use is an architectural boundary, not a universal license exemption. Obtain appropriate legal review before distribution where obligations or patents are uncertain.

## 15.3 Candidate register and implementation restraint

Appendix B retains all previously discussed engines/libraries as candidates, with role and admission conditions. It does not mandate integrating them all. Initial execution should reuse one qualified implementation per needed capability family; add a second only for a demonstrated quality, locality, hardware, interoperability or resilience need.

Prefer current Ghatana integrations for image/media handling, Shared primitives and TutorPutor render/animation work. Do not simultaneously build Godot, Bevy, Filament, Jolt, PhysX, MuJoCo and Taichi adapters before a first end-to-end experience. Choose the smallest qualified stack for the next admitted recipe. Build replaceable ports now, not dozens of unused abstractions and adapters.

Use available portfolio/build tooling for lockfiles, SBOM, license checks, security scanning and artifact publication; owner gaps become Tools/Shared work, not a new Media tooling framework. Pin runtimes/dependencies and validate updates before promotion. “State of the art” means a reviewable capability improvement against the product benchmark, not automatic installation of the newest model.

---

# 16. Target source layout and module ownership

The **first relocation** preserves the existing structure. The following is a target registration map, not an instruction to create empty folders or competing implementations. New modules are added only when their accepted capability needs them.

```text
ghatana-media/
  BOUNDARY.md
  README.md
  build.gradle.kts / settings.gradle.kts       # when Java/Gradle modules are present
  package.json / pnpm-workspace.yaml            # when TS/Node packages are present
  config/
    repo-boundary.json
    product-manifest.yaml or current ecosystem-equivalent
    canonical-product-registry.json or current standalone-equivalent

  capabilities.yaml                       # product projection of Phase 0
  dependencies.yaml                       # ecosystem dependency projection of Phase 0
  .product-experience/
    source-manifest.yaml
    authority-map.yaml
    currentness.yaml
    traceability.yaml
    decision-log.md
    gaps.yaml
    acceptance.yaml
    PRODUCT-CONSTITUTION.md
    phase-0-product-truth/
    phase-1-design-language/
    phase-2-product-experience/
    phase-3-experience-explorer/
  migration/
    source-inventory.yaml
    consumer-inventory.yaml
    path-map.yaml
    contract-compatibility.yaml
    cutover-plan.yaml
  runtime-contracts/                       # existing service-owned contracts
  launcher/                                # one Media control-plane composition root
  modules/
    audio-processing/
    video-processing/
    audio-streaming/
    video-streaming/
    speech/
    vision/
    intelligence/
      ai-voice/
      multimodal-service/
      document-intelligence-worker/
    media-synth/                           # creation planning/coordinator
    animation/
    simulation/
    enhancement/
    editing/
    synchronization/
    composition/
    quality/
    delivery/
  providers/                               # qualified native/storage/transport adapters
  integrations/                            # bounded public service/product clients
  libs/
    audio-video-types/
    audio-video-client/
    audio-video-ui/
  apps/web/
  cli/
  contracts/openapi/
  config/
    reuse-decisions.yaml
    dependency-bindings.yaml
    oss-components.yaml
    profiles/
    worker-pools/
  docs/                                    # runtime/design guidance, registered by role
  scripts/                                 # thin local entrypoints to owner tooling/tests
  conformance/
  integration-tests/
  test-fixtures/
  benchmarks/
  deploy/
  monitoring/
```

Map existing `libs/common`, `libs/java/common`, infrastructure/support modules and build files explicitly in migration inventory even when not individually expanded above. Do not merge unrelated modules or delete a directory because a conceptual target tree omitted it. One module may implement several related capabilities; capability registries, not folder count, define coverage.

Each production module separates domain/application logic from adapter wiring. Model-specific execution belongs in the AI Inference owner or a specifically admitted existing bounded-worker contract, not arbitrary new `providers/flux` or `providers/ltx` directories in Media. New generic reusable mechanics belong in Shared only after an actual cross-consumer boundary is accepted; media semantics stay in Media.

---

# 17. Cross-product recipes and dependency handoffs

| Consumer/owner | Contract to establish | Boundary and acceptance |
|---|---|---|
| TutorPutor | Domain-owned model/experience → Media scene/animation/render; media output → lesson/experience artifact | Preserve pedagogy, scientific meaning, measurement units/fidelity and accessibility with TutorPutor. Reuse mechanics only through accepted public/extracted interfaces. Demonstrate no domain-core import leak or semantic loss |
| Digital Marketing | Approved brand kit/claim/copy/asset references → composition; reviewed outputs → publication request | Marketing owns brand/claim approval and campaign use [R16]. Media produces exact authorized graphics and outputs; Action Plane governs external publication. Do not recreate a campaign/brand policy engine |
| PHR / Gharbatai and document consumers | Frozen document-extraction and media processing contracts → existing worker | Consumer discovery is mandatory; preserve qualification, identity, cancellation and retention. No implicit clinical/financial interpretation or feature activation from migration |
| YAPPC | Public product/capability contract and optional authoring integration | Reuse public app/metadata authoring facilities where they fit; no import of YAPPC internals into Media or generic Tools |
| Data Cloud | Governed artifact metadata/context projection and scoped search/reference access | Media remains execution/byte-lifecycle owner; Data Cloud stays context/read-model owner; preserve consumer visibility and access |
| Agent Runtime | Bounded creative intent/recipe request and result references | Agents plan dynamically only when needed; use Media public actions and Action Plane for privileged effects. No recursive budget reset or self-authorizing tool call |
| Kernel | Published lifecycle/shell/provider contracts for explicitly adopted surfaces | Default product-native runtime with Tools development mechanics. Do not force Kernel-native materialization merely to appear ecosystem-integrated [R18] |

Every handoff records source/destination owner, operation/version, auth/delegation, data classification/purpose, expected context, timeout/cancellation, finality, retry/reconciliation, error mapping, return/continuation path and accepted artifact references. Calls over a service boundary do not authorize mutation of another owner’s database.

Pilot recipes preserve breadth while limiting initial implementation cost: uploaded interview cleanup/captions; prompt-to-narrated explainer; deterministic 2D animation; physics/model demonstration with domain-owned fidelity; product-brand composition; existing-video dubbing; and safe batch rendering via CLI. The full catalog remains definition scope, not silently reduced to these pilots.

---

# 18. Phase 0 — Product Truth

## 18.1 Goal and entry

Define everything the product means, including the migration boundary, all capability families, actors/outcomes, authority, states, contracts, fidelity and non-functional behavior. Entry requires available source inventory and this reviewed baseline. Unresolved runtime providers do not block authoring their intended contracts; unresolved product meaning blocks acceptance of affected requirements.

The early boundary slice enables migration preparation. Full Phase-0 acceptance is independent from runtime migration/feature completion. Do not mislabel the source inventory or a migration receipt as Product Truth acceptance.

## 18.2 Required authored artifacts

All paths below are under `.product-experience/phase-0-product-truth/`; use an existing equivalent if already canonical and register the mapping.

| Artifact | Exact responsibility |
|---|---|
| `PRODUCT-TRUTH.md` | Mission, outcomes, product boundary, principles, scope and human-readable explanation of the structured records |
| `constitution.yaml` | Canonical constitutional requirements and exceptions/approval rules |
| `glossary.yaml` | Product and technical terminology, aliases, units, distinctions and forbidden conflations |
| `actors-responsibilities.yaml` | Creator, editor, reviewer, developer/integrator, automation agent, operator, administrator, privacy/rights reviewer, worker and external-provider responsibilities; roles separate from personas |
| `goals-jtbd.yaml` | Outcomes, jobs-to-be-done, intents, success/failure consequences and responsibility context |
| `requirements.yaml` | Stable normative requirement records and explicit applicability; full capability and invariant coverage |
| `capabilities.yaml` | Finite leaf catalog covering §6, aliases and qualified support dimensions; definitions not inferred from code exports |
| `domain-model.yaml` | Records, identity, relationships, versioning, immutable/mutable boundaries and object ownership |
| `time-units-fidelity.yaml` | Rational clocks, coordinate/unit conventions, physical/scientific fidelity and reproducibility contracts |
| `state-models.yaml` | Job/attempt/artifact/stream/rights/erasure/review state models; guards, effects, safe next actions and finality |
| `policy-authority-model.yaml` | Verified identity, delegation, privacy/rights, AI/agent/effect boundaries and no-bypass rules |
| `information-architecture.yaml`, `applications-channels.yaml` | Small shell, intent/channel ownership, supported devices and cross-application context |
| `journey-catalog.yaml`, `handoff-contracts.yaml` | Outcome-complete journeys and external/product handoff semantics |
| `dependency-contracts.yaml`, `reuse-decisions.yaml` | Ghatana-first selection evidence, public contracts, owners, availability limits and upstream change requests |
| `nonfunctional-requirements.yaml` | Security/privacy/audit/telemetry, accessibility/localization, simplicity, performance/cost, recovery, deployment and quality acceptance |
| `profile-semantics.yaml`, `quality-policy.yaml` | Orthogonal profile axes, preservation, qualified measurements and bounded refinement/fallback |
| `content-intent.yaml`, `qualification-policy.yaml` | Realistic fixture/content needs and separate definition/implementation/licensing/qualification/runtime dispositions |

Reuse the Tools-owned schema/model shapes. Media extensions specify media semantics; no local copy of a generic ProductSpec, experience or lifecycle schema. Source-manifest classifies authored inputs, generated views, external references, runtime references and evidence distinctly.

## 18.3 Requirement record and acceptance

Every requirement includes ID, normative statement, rationale/source, owning capability/actor, preconditions, expected behavior, important states, consequences, failure/degradation/recovery, NFRs, acceptance cases, related external contract and downstream mappings. Every capability in §6 receives disposition; every consequential action receives authority and finality. Undefined support is a gap, not a default.

Phase 0 passes when identity and ownership are unambiguous; all admitted requirements/capabilities/actors/outcomes reconcile; state transitions and dependencies are defined; full scope has channel/journey disposition; trust/fidelity and failure/recovery are explicit; there are no competing product-semantic authorities or unexplained orphan records. Tests validate reference closure and semantic invariants, not just file existence.

---

# 19. Phase 1 — Design Language

## 19.1 Goal and dependencies

Represent accepted Phase-0 meaning consistently across Web, CLI and embedded/interactive delivery. Consume Shared design-system/tokens/theme/headless/accessibility/localization public contracts [R10]. Media owns domain-specific patterns, not a second primitive design system. A new capability or changed finality discovered here returns to Phase 0.

## 19.2 Required artifacts

Under `phase-1-design-language/`, author `DESIGN-LANGUAGE.md`, `media-token-aliases.yaml`, `typography-layout.yaml`, `component-contracts.yaml`, `semantic-state-grammar.yaml`, `action-finality-grammar.yaml`, `trust-provenance-grammar.yaml`, `media-editing-grammar.yaml`, `animation-simulation-grammar.yaml`, `responsive-adaptive.yaml`, `accessibility.yaml`, `localization-content.yaml`, `motion.yaml` and `cli-language.yaml`.

Use canonical spacing/type/color/density rules; Media aliases reference Shared tokens. Specify typography, grid, breakpoints, borders/radii/elevation/iconography, semantic states, focus/motion, actions/confirmations, validation/errors, notification priority and handoffs. Never hide quality, egress, rights, scientific fidelity or uncertain-finality consequences behind a generic green badge.

Each component defines purpose/semantic role, exact anatomy/slots, hierarchy, allowed variants, states, actions, keyboard/focus, responsive transformations, accessibility/localization and prohibited misuse. Required families include project/asset browser, upload, player, waveform/spectrogram, storyboard, timeline/keyframes/curves, mixer, mask/tracking editor, scene inspector, simulation instruments, before/after/candidate comparison, quality inspector, profile choice, rights/review/provenance, activity/recovery and CLI output.

## 19.3 Canonical responsive and terminal variants

Initial proposed verification viewports are 1536×960, 1280×800, 1024×768, 768×1024, 390×844 and 320×640 CSS pixels, plus 200% text and relevant zoom/reflow. These are product test fixtures to accept in Phase 1, not universal device claims. Define whether each workflow is fully editable, limited-edit or review/monitoring on each form factor. Mobile does not silently drop recovery or critical information.

Use focused editor composition on tablet, contextual drawers rather than compressed desktop panes, and a review/monitoring-first mobile experience unless Phase 0 requires more. All keyboard-only operations have visible focus; dragging has alternatives. Screen-reader content exposes selected clip/keyframe/model measurement and permitted actions.

Terminal verification covers 80/120/160 columns and narrow plain-text wrapping, TTY/non-TTY, unicode-safe names, color-disabled mode, errors, progress and machine output. Human translated copy is separate from stable JSON field names/reason codes.

Phase 1 passes when every represented Phase-0 state/action/trust concept has a reusable rule, media-specific components have complete contracts, all supported adaptive/accessibility/localization states are defined, and equivalent situations use consistent patterns. Visual approval remains a recorded human review, not a guessed score.

---

# 20. Phase 2 — Complete Product Experience Specification

## 20.1 Goal and authority

Specify the entire intended human/machine-facing experience independently of Explorer code. Consume accepted Phase0 meaning and Phase1 representation. Use `@ghatana/experience-specification` for neutral definitions/validation, not as if it implements runtime guards or simulations [R11].

Required artifacts: `COMPLETE-PRODUCT-EXPERIENCE.md`, `application-channel-registry.yaml`, `navigation-contracts.yaml`, `screen-registry.yaml`, `screen-contracts/`, `journey-registry.yaml`, `journey-contracts/`, `action-registry.yaml`, `interaction-registry.yaml`, `state-transition-bindings.yaml`, `cli-command-registry.yaml`, `api-experience-mapping.yaml`, `content-copy-catalog.yaml`, `data-view-contracts.yaml`, `scenario-fixture-registry.yaml`, `simulation-semantics.yaml`, `recovery-finality-contracts.yaml`, `handoff-bindings.yaml` and `responsive-variants.yaml`. Coverage and filtered gaps are generated from root authority.

## 20.2 Initial screen/view inventory

This inventory defines required experience families, not a fixed “green” count. Split/merge views only with traceable semantic justification. Routes are **proposed product Web routes**, not deployed API claims. Dialogs/drawers are separately named views when their action/finality requires independent specification.

| View ID | Proposed route/context | Required purpose |
|---|---|---|
| M-HOME | `/` | Resume work; launch intent; meaningful first-use/empty state |
| M-PROJECTS | `/projects` | Search/filter/create/open projects |
| M-PROJECT | `/projects/:id` | Project context, source/output versions and next action |
| M-ASSETS | `/assets` | Governed library, import/upload/search/filter |
| M-ASSET | `/assets/:id` | Playback/technical metadata, versions, rights and actions |
| M-UPLOAD | Contextual upload/import view | Progress/resume/integrity/quarantine/permission recovery |
| M-CREATE | `/create` | Intent/recipe and safe outcome settings |
| M-PLAN | Project plan view | Proposed graph, estimates, material decisions and validation |
| M-STORYBOARD | Project storyboard | Scenes, timing, references, versions and transitions |
| M-IMAGE | Project image workspace | Generation/conditioning/candidate selection |
| M-VIDEO | Project video workspace | Generation strategy, controls, progress and alternatives |
| M-AUDIO | Project audio workspace | Sources/stems/cleanup/mix/mastering |
| M-SPEECH | Project speech workspace | Transcription/TTS/pronunciation/language/voice choices |
| M-VOICE | Project authorized voice workflow | Training/conversion permissions and model references |
| M-CAPTIONS | Project caption editor | Timings, language, accessibility and review |
| M-DUB | Project dubbing workflow | Translation, voice, timing, meaning review and sync |
| M-ENHANCE | Project enhancement view | Preserve/enhance/creative choice, measured defects, safe plan |
| M-COMPARE | Artifact/version comparison | Before/after, candidate ranking and applicable measurements |
| M-EDIT | Project edit workspace | Region/track operations, exact constraints and undo |
| M-MASK | Edit mask/tracking view | Region selection, propagation uncertainty and correction |
| M-ANIMATION | Project animation workspace | Timeline/keyframes/curves/rig/path/control actions |
| M-SCENE | Project scene workspace | Scene entities/material/camera/light and model bindings |
| M-SIMULATION | Project simulation workspace | Initial conditions, domain fidelity, time control and instruments |
| M-COMPOSER | Project composition workspace | Timeline/graphics/brand/audio/captions/transition assembly |
| M-COLOR | Composition color view | Input/output color interpretation and shot matching |
| M-QUALITY | Project quality view | Applicable dimensions, abstentions, defects and repair plan |
| M-RENDER | Project render setup | Snapshot/profile, validation, cost and submission |
| M-ACTIVITY | `/activity` | Jobs/notifications requiring attention; not infrastructure dashboard |
| M-JOB | `/jobs/:id` | Progress, outputs, cancel, retry/reconcile and uncertainty |
| M-OUTPUTS | Project outputs | Master/renditions/version/approval status |
| M-OUTPUT | `/outputs/:id` | Playback/download/review/provenance and delivery action |
| M-DELIVERY | Project delivery view | Destination/format/rights/approval and publication finality |
| M-REVIEW | `/reviews/:id` | Scoped exact-version review/comment/approve/reject |
| M-RIGHTS | Contextual rights view | Consent/license/likeness/processing restrictions and remediation |
| M-PROVENANCE | Artifact provenance view | Source/edit/model/simulation lineage and disclosure limits |
| M-PROFILES | Advanced project/admin context | Effective profiles, qualification and allowed overrides |
| M-PROVIDERS | Operator-only capability context | Declared/qualified/live limits; no ordinary model-selection burden |
| M-OPERATIONS | Operator console | Safe diagnostics, capacity/recovery/erasure and audit access |
| M-SETTINGS | `/settings` | User/workspace policies, accessibility and integration scope |
| M-AUTH | Authentication/tenant handoff | Ghatana identity, context selection, expiry/re-auth and denial |
| M-HELP | Contextual help/command guide | Product-specific assistance and safe diagnostic sharing |

Legacy/source views not represented above must be inventoried, mapped and preserved or explicitly retired with consumer impact. Existing document-intelligence experiences may be embedded in consumer products; define those handoffs rather than automatically inventing a full Office editor inside Media.

## 20.3 Mandatory screen/action contracts

Every meaningful view records ID/channel/route, actors/intents, purpose; **Context, Goal, Now, Next**; exact anatomy/information hierarchy/components; copy/data formatting; primary/secondary/dangerous actions; entry/exit; loading/empty/partial/stale/offline/permission/policy/conflict/unknown-finality/degraded states; validation; success/failure/recovery; responsive/a11y/localization; requirements/journeys/dependencies and fixtures.

Every consequential action records actor/context/authority, preconditions, confirmation, effect and affected objects, reversibility, commit/finality, downstream effects, success/partial/failure/unknown outcomes, retry/cancel/recovery, provenance and next safe action. UI and CLI may not reinterpret a non-retryable unknown result as “Try again.”

Exact copy is part of Phase2 where it affects decisions. For example: “Your completed scenes are safe. The last scene’s remote outcome is not confirmed. Check its status before starting another generation.” Do not use generic “Details,” fake example content or technical trace messages as the normal experience.

## 20.4 Required end-to-end journeys

Each journey has ordered view/state/action references, pre/postconditions, automation/human decisions, success/failure/degraded/recovery, preserved context, return path, responsive support and channel equivalents.

| Journey ID | Complete outcome and critical exceptional path |
|---|---|
| J-01 | First use/authenticate → choose context → create project; missing capability or denied context explained |
| J-02 | Upload/import → inspect → usable artifact; interrupted parts, checksum mismatch and quarantine recovery |
| J-03 | Audio/video → transcription → corrected transcript/captions; uncertain language/speaker and missing alignment |
| J-04 | Text → authorized TTS → approved audio; pronunciation/rights/unsupported voice failure |
| J-05 | Image/video → analysis/geometry/tracks; uncertainty and unsupported output dimensions |
| J-06 | Multimodal/document consumer request → grounded typed result; privacy/fallback qualification/cancellation boundary |
| J-07 | Noisy/clipped interview → preserve-policy enhancement → before/after → output; no misleading generative restoration |
| J-08 | Low-quality video → eligible stabilization/SR/temporal repair → quality comparison; insufficient detail/failed metric |
| J-09 | Prompt → plan/storyboard → references → video/audio → composition → render → review → delivery; partial scene/rights/budget/unknown outcome |
| J-10 | References/keyframes/pose/depth → controlled generation → continuity review; identity/geometry drift |
| J-11 | Image/video region → mask/track → edit/inpaint/relight → comparison; propagation uncertainty and undo |
| J-12 | 2D/vector/procedural animation → accessible preview → render/export; unsupported interchange feature |
| J-13 | 3D/character/rig/path animation → retarget/control → render; skeleton mapping or rights failure |
| J-14 | Domain model/initial conditions → simulation → measurements/passes → animation/render; invalid units, fidelity or unstable solver |
| J-15 | Simulation/procedural passes → generative refinement → protected semantic validation; no scientific claim from appearance |
| J-16 | Existing video → translation/dubbing → voice/timing/lip review → mastered version; meaning/duration conflict |
| J-17 | Music/SFX/Foley/stems → mix/duck/master → output; rights, clipping or separation leakage |
| J-18 | Compose clips/captions/exact graphics → color/audio master → output; stale asset/version and unsupported font/codec |
| J-19 | Inspect quality → accept repair plan → bounded optimize → compare/accept; abstention, no improvement or exhausted budget |
| J-20 | Long job → disconnect → observe → cancel/retry/reconcile; confirm cancellation versus local watch interruption |
| J-21 | Review/comment/approve exact version → changed version → re-review; concurrency and expired delegation |
| J-22 | Export/download/publish → destination acknowledgement; partial package or uncertain external publication |
| J-23 | Local/private workflow → disconnected operation → reconnect; entitlement expiry and no unauthorized remote fallback |
| J-24 | CLI batch/JSON plan → submit/watch → verified outputs; SIGINT, duplicate keys, per-item partial failure |
| J-25 | Agent/product integration → delegated Media action → result/return; bounded recursion/cost and Action Plane authority |
| J-26 | Delete/revoke/retention/hold → visible lifecycle; cache/backup/external copy and partial erasure |
| J-27 | Provider/license/capacity outage → permissible fallback or explicit block → recovery; no silent downgrade |
| J-28 | Spatial/360/interactive/synthetic-data export → supported consumer; coordinate/time/format loss disclosure |

These journeys are not the final denominator: every additional admitted capability and material workflow gets complete downstream disposition. A single generic page is acceptable only if its typed contract actually covers the distinct operation and states.

## 20.5 Cross-channel traceability and exit

The graph is bidirectional: outcome → requirement → actor/intent → capability → journey/step → Web view or CLI/API operation → component/action → state/effect → design contract → scenario/fixture → Explorer realization → verification → downstream implementation mapping.

Phase2 passes when every admitted journey reaches an actual defined experience and completion; every action/navigation/control has semantics; no active requirement disappears; content/state/context remain coherent across channels; recovery/a11y/localization/adaptive behavior is specified; and zero undefined experience paths remain. It must be implementable without reading Explorer code.

---

# 21. Phase 3 — Deterministic, pixel-perfect Experience Explorer

## 21.1 Product package, not a new generic Explorer

First locate the current Tools-owned Experience Explorer contracts/runtime, design-system generation and verification capabilities through its public catalog. Use `@ghatana/experience-specification` for definition shape only [R11]. It does not execute Media simulations, and its presence is not proof that every Explorer feature exists. Missing generic behavior becomes an owner-scoped Tools requirement; product-specific adaptation remains with Media.

The Media package contains manifest/authority references, views and component composition, deterministic content/assets, scenarios, product-defined reducers/action effects, mock transport and verification bindings. It must not depend on production credentials, GPUs, external providers, arbitrary internet assets or a live service to demonstrate the specification.

## 21.2 Four distinct modes

**Product** renders only the intended product edge-to-edge: no scenario/viewport selectors, requirement IDs, verification panels or Explorer navigation. Intended product rights/provenance are allowed; Explorer diagnostics are not.

**Explore** selects actor, intent, channel, journey, state/scenario, viewport, locale, accessibility and connectivity/degradation without modifying product semantics.

**Specification** inspects the requirement/component/action/state/design/CLI/API/authority graph in both directions.

**Verify** shows current structural, interaction, geometry, visual, accessibility and traceability observations with their input fingerprints. It cannot promote simulated success into runtime qualification.

The CLI channel uses deterministic command parsing and formatted output over the **same product simulation state/actions** as the Web projection. The API channel displays accepted schema/examples and scenario responses. A terminal printing prewritten unrelated “success” logs is not a functional simulation.

## 21.3 Deterministic simulation and fixture protocol

Use a seeded fixture catalog, deterministic IDs/clock and pure state transitions with explicit simulated asynchronous events. Actions validate preconditions/authority, apply product-defined effects, update every related projection and expose success/partial/failure/finality consistently. Reset/replay restores known state. Test concurrent edits and stale reads through explicit scenarios rather than random timing.

Required realistic fixture families include educational explainer, product demonstration, narrated slideshow, podcast/interview, caption/dub correction, deterministic animation, scientific-model simulation, synthetic-data export, damaged image/video/audio, rights denial, quality degradation, provider ambiguity, partial completion, migration/consumer handoff and erasure. All fixture/media/font licenses and intended language/technical descriptors are recorded. Synthetic fixture content is labeled as such in the review context, never disguised as production proof.

Defect fixtures cover low resolution, camera shake, motion blur, heavy compression, flicker, exposure mismatch, noise/reverb/clipping/bandwidth limits, A/V drift, identity drift and broken lip timing. Simulated quality scores demonstrate defined behavior; they are not claims that a real quality model detects every defect.

## 21.4 Interaction, loading and packaging correctness

Every visible element is classified as `WORKING`, `INTENTIONALLY_DISABLED_WITH_REASON`, `EXTERNAL_BOUNDARY_WITH_DEFINED_HANDOFF`, or `NOT_INTERACTIVE`. Buttons, tabs, links, menus, search/filter/sort/pagination, row actions, breadcrumbs, dialogs, retry/cancel/recovery and notification actions all have dispositions. Disabled controls explain the missing precondition; no fake clickable cards.

Bundle fonts, styles, fixtures, projection manifests and dynamic imports through the real build pipeline. Define supported local serving mode; do not promise `file://` works with module loading unless tested. Test base paths, deep-link reloads, MIME types, missing chunks, cache invalidation, CSP script/connect/worker/media/font rules and offline fixture loading. Permit only necessary same-origin resources; do not solve CSP failures with an unrestricted policy.

Explorer service workers and cached projections must not mix authority versions. An upstream material change marks stale output explicitly. Errors should show a usable recovery boundary rather than a blank page or infinite spinner.

## 21.5 Visual and accessibility acceptance

Verify semantic DOM and token references, computed styles, geometry, clipping/overflow, responsive recomposition, keyboard/focus, zoom/text spacing, reduced motion, forced colors, localized content, actual controls and screenshots. Pin browser/font/renderer configuration for visual comparisons; define justified tolerances and exclude volatile data deliberately, not by masking substantive defects.

Human review inspects purpose, hierarchy, density, alignment, readability, action clarity, trust disclosure, media previews, timeline/scene/simulation controls, responsive/localized behavior and overall coherence. Automated pixel diff alone cannot pass this gate. Record reviewer, version, surface/scenario/viewport and findings. Without that observation, visual acceptance is `REVIEW_REQUIRED`.

Phase3 passes only when every canonical Phase2 view/state/journey/CLI disposition is realizable, no dead paths/unclassified controls exist, product/explorer chrome remain separate, simulations are coherent, required variants/a11y/geometry pass, current visual evidence exists and human review passes. Production remains a separately measured consumer.

---

# 22. Derived implementation handoff and runtime sequence

After accepted definitions, generate `implementation-contract.yaml`, `implementation-traceability.yaml` and `IMPLEMENTATION-HANDOFF.md` under the product’s registered handoff area. These identify what to build, owner requirement, exact experience/action/state, external contract, reuse binding, failure/recovery, adaptive/a11y behavior, Explorer scenario and required tests. They are **derived projections**, not another authority phase.

Implement vertical slices in dependency order: public contract/admission/artifact foundation; durable jobs/outbox/audit; SDK/CLI; deterministic processing/composition; existing Ghatana animation/simulation reuse; AI Inference capability additions; generation/continuity; bounded quality; Web parity; advanced families and delivery; then profile/deployment qualification. Security, audit, observability and privacy are part of each slice, not an end-of-project hardening sprint.

Keep definition complete across full intended scope while runtime implementation/qualification advances by admitted lane. A lane’s incompleteness cannot remove its requirement, but unqualified work must not be advertised as usable. Tests and native checks run directly through their underlying tooling; Tools closure/evidence can consume the same operations without becoming a prerequisite for ordinary development.

---
# 23. Prescriptive work packages and task dependency graph

## 23.1 Task conventions

The cards below are execution instructions, not completion claims. `P0` in **priority** means prerequisite/correctness-critical; it is different from **Phase 0**. `P1` means required product/feature-completeness work; it is not optional. Dependency order governs execution within and across priorities. Task identities are qualified by `MEDIA-MASTER-PLAN/<task-id>`; earlier draft task IDs are mapped in Appendix A and are not silently reused as the same completed work. All tasks start `NOT_STARTED` for this plan unless a current owner observation is explicitly adopted. The owner entries are accountable roles to assign, not invented people or approvals.

Paths without a repository prefix are relative to the root of `samujjwal/ghatana-media`. Phase artifact filenames are relative to the named `.product-experience/phase-*` folder; root acceptance/gap/currentness paths are defined in §5. Test files and `check:definition`, `test:explorer` wrappers below are **proposed deliverables**, not commands claimed to exist today. Register wrappers in the product package and delegate to actual public tooling/native tests; do not implement another generic validation/closure engine.

Each task inherits §4 constitutional requirements. **Completion effect:** Phase tasks can accept only their definition/reference scope; migration tasks transfer ownership only; runtime tasks establish only the exact tested capability/environment. None automatically issues a release, certification or platform receipt. **Evidence impact:** preserve unaffected observations; refresh only the downstream material named by the task and its dependency graph. Missing required evidence remains `BLOCKED` or `REVIEW_REQUIRED`, not “not applicable.”

Base prerequisites apply to every instance. Where a card lists **scope prerequisites**, expand them into concrete prerequisite edges for the explicitly selected capability/view/deployment lane before execution. For example, core Web work can start after the real SDK exists without waiting for a fluid solver, but a simulation view cannot be accepted before its own execution dependency is ready. A lane manifest lists included and excluded capability IDs with reasons; exclusion from activation never removes the full product requirement or turns incomplete full-scope work into pass. Validate the expanded instance DAG and require all applicable prerequisites.

A task may be split into tracked subtasks without changing its acceptance or hiding work. Per-capability implementation/qualification tasks must instantiate a finite leaf work list from §6; an aggregate task cannot be marked done while its admitted child obligations are incomplete.

## 23.2 Task index

| Task | Workstream | Dependencies |
|---|---|---|
| GOV-001 | Cross-phase governance | None |
| GOV-002 | Cross-phase governance | GOV-001 |
| GOV-003 | Cross-phase governance | GOV-001 |
| P0-001 | Phase 0 | GOV-002, GOV-003 |
| P0-002 | Phase 0 | P0-001 |
| P0-003 | Phase 0 | P0-002 |
| P0-004 | Phase 0 | P0-003 |
| P0-005 | Phase 0 | P0-004 |
| P0-006 | Phase 0 | P0-002, P0-004, P0-005 |
| P0-007 | Phase 0 | P0-003, P0-004, P0-006 |
| P0-008 | Phase 0 | GOV-002, P0-006, MIG-002 |
| P0-009 | Phase 0 | P0-002, P0-003, P0-007 |
| P0-010 | Phase 0 | P0-001, P0-002, P0-003, P0-004, P0-005, P0-006, P0-007, P0-008, P0-009 |
| MIG-001 | Migration; not a phase | P0-001 |
| MIG-002 | Migration; not a phase | GOV-001 |
| MIG-003 | Migration; not a phase | MIG-001, MIG-002, GOV-002 |
| MIG-004 | Migration; not a phase | MIG-003 |
| MIG-005 | Migration; not a phase | MIG-004 |
| MIG-006 | Migration; not a phase | MIG-005 |
| MIG-007 | Migration; not a phase | MIG-006 |
| MIG-008 | Migration; not a phase | MIG-007, IMP-015 |
| P1-001 | Phase 1 | P0-010, GOV-002 |
| P1-002 | Phase 1 | P1-001 |
| P1-003 | Phase 1 | P1-001 |
| P1-004 | Phase 1 | P1-002, P1-003 |
| P1-005 | Phase 1 | P1-003 |
| P1-006 | Phase 1 | P1-001, P1-002, P1-003, P1-004, P1-005 |
| P2-001 | Phase 2 | P1-006 |
| P2-002 | Phase 2 | P2-001 |
| P2-003 | Phase 2 | P2-001, P0-007 |
| P2-004 | Phase 2 | P2-001, P0-004, P0-008 |
| P2-005 | Phase 2 | P2-001 |
| P2-006 | Phase 2 | P2-002, P2-003, P2-004, P2-005 |
| P2-007 | Phase 2 | P2-002, P2-003, P2-004, P2-005, P2-006 |
| P2-008 | Phase 2 | P2-001, P2-002, P2-003, P2-004, P2-005, P2-006, P2-007 |
| P3-001 | Phase 3 | P2-008, GOV-002 |
| P3-002 | Phase 3 | P3-001 |
| P3-003 | Phase 3 | P3-002 |
| P3-004 | Phase 3 | P3-002, P2-006 |
| P3-005 | Phase 3 | P3-003, P3-004 |
| P3-006 | Phase 3 | P3-005, P1-004 |
| P3-007 | Phase 3 | P3-006 |
| HAND-001 | Derived handoff; not a phase | P3-007 |
| HAND-002 | Cross-phase reconciliation | HAND-001 |
| IMP-001 | Downstream runtime; not a phase | HAND-001, MIG-007 |
| IMP-002 | Downstream runtime; not a phase | IMP-001 |
| IMP-003 | Downstream runtime; not a phase | IMP-002 |
| IMP-004 | Downstream runtime; not a phase | IMP-002, P2-006 |
| IMP-005 | Downstream runtime; not a phase | IMP-003 |
| IMP-006 | Downstream runtime; not a phase | IMP-003, P0-008 |
| IMP-007 | Downstream runtime; not a phase | HAND-001, GOV-002, P0-008, MIG-007 |
| IMP-008 | Downstream runtime; not a phase | IMP-003, IMP-005, IMP-007 |
| IMP-009 | Downstream runtime; not a phase | IMP-003, IMP-005, IMP-007 |
| IMP-010 | Downstream runtime; not a phase | IMP-003, IMP-005, IMP-007 |
| IMP-011 | Downstream runtime; not a phase | IMP-004 |
| IMP-012 | Downstream runtime; not a phase | IMP-002, IMP-003 |
| IMP-013 | Downstream runtime; not a phase | IMP-001, MIG-007 |
| IMP-014 | Downstream runtime; not a phase | GOV-002, HAND-001, MIG-007 |
| IMP-015 | Downstream runtime; not a phase | IMP-001, IMP-002, IMP-003, IMP-004, IMP-014 |
| OPS-001 | Authorized activation; not a phase | MIG-008, IMP-015, HAND-002 |

## 23.3 Task cards

### GOV-001 — Cross-phase governance

**Priority:** P0. **Owner:** Media lead + repository owners. **Dependencies:** None.

**Target:** `migration/source-inventory.yaml; review/source-observations.yaml; .product-experience/source-manifest.yaml`.

**Problem / basis:** The baseline mixes intended behavior, source observations and readiness claims. Evidence: U1/U2; R01, R02, R12.

**Procedure:** Read the supplied framework/plan and current owner entrypoints; record repository refs, exact paths, blob/material fingerprints, read scope and evidence class. Classify each existing doc/schema/test/generated file. Preserve the complete §6 capability scope and existing IDs.

**Acceptance:** Every consulted authority has an owner and role; inaccessible or uninspected material is explicit; no runtime proof inferred from source.

**Verification:** Proposed conformance/source-observations.spec.ts validates IDs, reference resolution and authored/generated classification; review against Appendix C.

**Downstream and evidence effect:** All phase and migration tasks; no existing runtime proof is invalidated solely by recording observations.

### GOV-002 — Cross-phase governance

**Priority:** P0. **Owner:** Ecosystem architect + Shared/Tools/Kernel/product owners. **Dependencies:** GOV-001.

**Target:** `.product-experience/phase-0-product-truth/reuse-decisions.yaml; generated config/reuse-decisions.yaml; config/dependency-bindings.yaml; root gaps`.

**Problem / basis:** External OSS was selected before concrete ecosystem reuse and publication checks. Evidence: R04–R11, R14, R18; §§3,15,17.

**Procedure:** Inspect public catalogs/manifests and actual exports for §3 candidates; trace dependencies including TutorPutor core/contracts. Execute or request isolated public-package consumer tests. Record reuse, owner extension/extraction, rejected fit, or external candidate with rationale and source. Do not implement an external adapter before its decision.

**Acceptance:** Every foundational need and each proposed adapter has a Ghatana-first disposition with owner, contract version, publication availability and replacement path.

**Verification:** Proposed conformance/reuse-admission.spec.ts rejects missing internal evaluation, private-source imports and claims of qualification based only on package presence.

**Downstream and evidence effect:** Dependency contracts, migration clients, module choices and OSS admission; invalidate only consumers affected by actual binding changes.

### GOV-003 — Cross-phase governance

**Priority:** P0. **Owner:** Product-definition tooling owner. **Dependencies:** GOV-001.

**Target:** `.product-experience/ root; product package scripts; conformance/definition/`.

**Problem / basis:** The plan could create duplicate schema, gap and acceptance authorities. Evidence: U2; R11,R14; §5.

**Procedure:** Bind the four phases to current Tools-owned public schemas and lifecycle inputs. Register one gap ledger and source manifest; make coverage/currentness/filtered views derived. Add thin local definition checks invoking public validators plus Media-specific semantic assertions.

**Acceptance:** No copied generic schema or locally invented acceptance engine; authored/generated roles and phase prerequisites are explicit.

**Verification:** Use documented Tools catalog/work validation where installed; proposed check:definition runs schema/reference/authority checks directly without requiring closure.

**Downstream and evidence effect:** All phase registries and generated handoff; regenerate stale projections only.

### P0-001 — Phase 0

**Priority:** P0. **Owner:** Media PM + ecosystem architect. **Dependencies:** GOV-002, GOV-003.

**Target:** `phase-0-product-truth/PRODUCT-TRUTH.md; policy-authority-model.yaml; dependency-contracts.yaml; migration/contract-compatibility.yaml`.

**Problem / basis:** Cutover cannot precede accepted product ownership and consumer obligations. Evidence: REV-02,04,06,10,26; R01–R03,R15.

**Procedure:** Accept the boundary slice: Media versus platform owners; existing service and document-worker scope; target product identity; compatibility/version policy; no reverse implementation dependency; external handoff rules. Keep detailed future capability authoring independent from runtime cutover.

**Acceptance:** One signed-off boundary decision covers every transferred concept and permitted dependency; no circular requirement for full product implementation before definition.

**Verification:** Boundary review and proposed conformance/boundary-slice.spec.ts; compare current consumer constraints with R01/R02/R03/R15.

**Downstream and evidence effect:** Enables migration registration/preparation and remaining Phase0; does not authorize live cutover.

### P0-002 — Phase 0

**Priority:** P1. **Owner:** Product manager + UX architect. **Dependencies:** P0-001.

**Target:** `phase-0-product-truth/constitution.yaml; actors-responsibilities.yaml; goals-jtbd.yaml; glossary.yaml`.

**Problem / basis:** Ambient requirements and user outcomes were scattered among feature lists. Evidence: U1 §§3–5,13–14,18; §§2–4,14.

**Procedure:** Materialize §4 constitution; define actors separately from RBAC, outcomes/intents, first use, simple/guided/expert behavior, scope/non-goals and term aliases. Name accountable approvers for privacy/fidelity/publication; produce the readable constitution as a projection.

**Acceptance:** Every constitutional invariant has a requirement/acceptance owner; every actor has an outcome and authority; MediaSynth and product/runtime/Explorer simulation meanings are distinct.

**Verification:** Proposed conformance/phase-0-semantics.spec.ts plus PM/security/UX review; unresolved meaning is an explicit gap.

**Downstream and evidence effect:** Capability requirements, design grammar and all experiences; materially changed intent reopens affected descendants.

### P0-003 — Phase 0

**Priority:** P1. **Owner:** Media domain lead + capability specialists. **Dependencies:** P0-002.

**Target:** `phase-0-product-truth/capabilities.yaml; requirements.yaml; qualification-policy.yaml`.

**Problem / basis:** A broad catalog lacked per-leaf completeness and honest availability. Evidence: U1 §10; R15; §6.

**Procedure:** Expand §6 into finite semantic leaf operations; map aliases rather than duplicate definitions. Include original streaming/document worker and all animation/simulation/spatial/enhancement families. Bind every leaf to inputs/outputs, actors, requirements, states, acceptance and implementation/qualification/license/runtime dimensions.

**Acceptance:** Every named source capability has a retained record or justified equivalent; no unsupported model is advertised; no leaf omitted because it is not yet implemented.

**Verification:** Capability preservation crosswalk, duplicate-ID/alias-cycle tests and requirement disposition/reference checks.

**Downstream and evidence effect:** Journey/screen/CLI denominators, adapter selection and runtime qualification; new leaves legitimately expand the denominator.

### P0-004 — Phase 0

**Priority:** P1. **Owner:** Media architect + graphics/audio/simulation specialists. **Dependencies:** P0-003.

**Target:** `phase-0-product-truth/domain-model.yaml; time-units-fidelity.yaml`.

**Problem / basis:** Graph state, time, units and reproducibility were underspecified. Evidence: REV-11–14,25; R04,R05; W03,W07,W08; §§7–8.

**Procedure:** Define the records in §7; separate specification/plan/run and physical/model versus visual state. Specify rational clocks, interval/rounding rules, frame/sample mapping, color/alpha/audio descriptors, coordinate/quaternion conventions, solver/fidelity and conversion-loss/replay classes. Map existing Ghatana IRs before extending.

**Acceptance:** No ambiguously unitless core parameter; no exact GPU/solver replay claim without envelope; compatible schemas do not leak external framework types.

**Verification:** Golden temporal/coordinate/color roundtrip examples, negative dimensional inputs and IR compatibility fixtures in conformance/domain-contracts/.

**Downstream and evidence effect:** All media engines, plans, animation/simulation, imports/exports and quality; changes invalidate related measurements and fixtures.

### P0-005 — Phase 0

**Priority:** P0. **Owner:** Distributed-systems lead. **Dependencies:** P0-004.

**Target:** `phase-0-product-truth/state-models.yaml; policy-authority-model.yaml; recovery-finality definitions`.

**Problem / basis:** Job stage, cancellation and remote outcome were conflated. Evidence: R02,R06,R07; §§10–12.

**Procedure:** Define orthogonal lifecycle machines in §12, command/attempt identity, lease fences, side-effect marker, durable registration, retry/reconciliation, correction records, stream ordering and erasure/review lifecycle. Bind Shared workflow/outbox responsibilities without delegating product state ownership.

**Acceptance:** Every reachable state has legal transitions and safe next action; unknown external outcomes cannot be replayed by default; stale workers cannot finalize.

**Verification:** Model-based transition/forbidden-action fixtures, duplicate command races and failure-at-every-commit-boundary cases.

**Downstream and evidence effect:** API/SDK/UI/CLI status semantics, scheduler and audit; regenerate all affected state projections.

### P0-006 — Phase 0

**Priority:** P0. **Owner:** Security/privacy engineer + rights owner. **Dependencies:** P0-002, P0-004, P0-005.

**Target:** `phase-0-product-truth/policy-authority-model.yaml; nonfunctional-requirements.yaml; content-intent.yaml`.

**Problem / basis:** Privacy labels, rights, erasure and native-worker safety were incomplete. Evidence: REV-16–20; R03,R08,R09,R15; W05,W06; §11.

**Procedure:** Author §11 threat/authority model including tenant boundaries, egress, trust-versus-intent, biometrics, training prohibition, supply chain, scripts/decoders, limits, erasure/holds/backups and audit obligations. Define consent expiry and cancellation limits. Route generic primitives to Shared and consequential effects to Action Plane.

**Acceptance:** Every data class/artifact stage and effect has a policy decision and fail behavior; local/private/sharing axes separate; no unsafe telemetry fallback.

**Verification:** Adversarial fixture specification for cross-tenant reuse, SSRF, archive/script/model attacks, revoked consent, restore resurrection and audit failure.

**Downstream and evidence effect:** Every capability/worker/external adapter and user consent/rights flow; security changes can invalidate reuse even without byte changes.

### P0-007 — Phase 0

**Priority:** P1. **Owner:** Media-quality lead + AI/ML lead. **Dependencies:** P0-003, P0-004, P0-006.

**Target:** `phase-0-product-truth/profile-semantics.yaml; quality-policy.yaml; qualification-policy.yaml`.

**Problem / basis:** Profiles and quality loops could silently alter meaning or spend indefinitely. Evidence: REV-12,15,23; §§8–9,15.

**Procedure:** Define §9 profile axes, preservation/fallback, quality dimensions/abstention, continuity and bounded optimization. Assign per-metric calibration/benchmark needs and protected semantic properties. Declare candidate engines/models unqualified until evidence exists.

**Acceptance:** No single score overrides fidelity/rights; every automatic operation has budget/stop conditions; requested/effective quality and dimensions are recorded.

**Verification:** Negative fixtures for OOM downgrade, misleading upscaling, unsupported frame repair, incorrect metric domain, no improvement and exhausted budget.

**Downstream and evidence effect:** MediaSynth, enhancement, comparisons, provider selection and performance/quality tests.

### P0-008 — Phase 0

**Priority:** P0. **Owner:** Ecosystem architect + capability owners. **Dependencies:** GOV-002, P0-006, MIG-002.

**Target:** `phase-0-product-truth/dependency-contracts.yaml; reuse-decisions.yaml; .product-experience/gaps.yaml`.

**Problem / basis:** Product cross-calls and local AI exemptions could create cycles/parallel owners. Evidence: R01,R03–R07,R15,R16,R18; §§3,17.

**Procedure:** Finish ownership/dependency edges for each capability, including TutorPutor/Marketing/document consumers. Specify public contract and availability/health/fallback/expiry per dependency. Preserve existing bounded model-worker exceptions only at their declared scope; request AI-owned local/new-generation interfaces where absent.

**Acceptance:** Every external edge has one owner, public binding, error/finality mapping and test; no product-source import from core; unsupported interface is blocked, not fabricated.

**Verification:** Dependency DAG/import checks; isolated consumer fixtures; owner review of public extension requests.

**Downstream and evidence effect:** Migration compatibility, all adapter tasks and handoffs; no unrelated owner proof needs rerun.

### P0-009 — Phase 0

**Priority:** P1. **Owner:** UX/accessibility lead + SRE. **Dependencies:** P0-002, P0-003, P0-007.

**Target:** `phase-0-product-truth/information-architecture.yaml; applications-channels.yaml; journey-catalog.yaml; handoff-contracts.yaml; nonfunctional-requirements.yaml`.

**Problem / basis:** Simplicity and operational budgets were aspirations rather than acceptance requirements. Evidence: §§12,14,17; W04.

**Procedure:** Admit channel/device/locale support; small shell and intent-first flow; first-use/empty/offline/AI-unavailable behaviors; exact proposed workload budgets and formative usability protocol. Define deployment SLO/RPO/RTO decisions required before activation rather than inventing measured values.

**Acceptance:** Every outcome has a journey/channel, critical nonhappy path and accessibility disposition; proposed versus measured targets unambiguous.

**Verification:** Outcome-to-journey check, responsiveness workload manifest and usability/a11y acceptance review.

**Downstream and evidence effect:** Phase1/2 view contracts, performance fixtures and supported release lanes.

### P0-010 — Phase 0

**Priority:** P0. **Owner:** Independent product-definition reviewer. **Dependencies:** P0-001, P0-002, P0-003, P0-004, P0-005, P0-006, P0-007, P0-008, P0-009.

**Target:** `root acceptance inputs; generated Phase0 coverage/currentness`.

**Problem / basis:** Checklist/file presence does not prove Product Truth completeness. Evidence: U2 Phase0 gate; §18.

**Procedure:** Validate all Phase0 schemas, IDs, aliases, refs and source roles; walk every outcome/capability/state/authority/failure path; resolve competing docs at the owning layer. Record accepted material fingerprints and explicit remaining runtime gaps.

**Acceptance:** §18 exit conditions satisfied; no unresolved material semantic gap; planned runtime availability is not presented as current.

**Verification:** Run direct check:definition --phase 0 once implemented; independent semantic review and generated coverage report.

**Downstream and evidence effect:** Accepts definition only; unlocks Phase1. Does not claim migration, model or production qualification.

### MIG-001 — Migration; not a phase

**Priority:** P0. **Owner:** Both repository owners. **Dependencies:** P0-001.

**Target:** `ghatana-products/config/product-extraction-records/media.yaml`; standalone target `samujjwal/ghatana-media`; owning extraction policy/schema/guard remains in `ghatana-products`.

**Problem / basis:** The existing policy addresses outbound extraction as well as a default Products location. Evidence: R17; §13.1.

**Procedure:** Validate and, only at its owner, extend inbound graduation semantics. Register `source = samujjwal/ghatana:services/media` and `target = samujjwal/ghatana-media`, using the existing `ghatana-<product>` extracted-product naming convention. Register before/after owners, reasons, status, scope, consumer commitments and remove-after-cutover disposition. Keep `ghatana/services/media` canonical while `ghatana-media` is migration-only.

**Acceptance:** The actual policy/schema accepts the record; no two editable semantic owners; record does not claim completion.

**Verification:** Portfolio extraction guard plus negative duplicate-authority/incompatible-state examples.

**Downstream and evidence effect:** Target registry/cutover; generated portfolio views regenerated only through owning generator.

### MIG-002 — Migration; not a phase

**Priority:** P0. **Owner:** Migration engineer + consumer owners. **Dependencies:** GOV-001.

**Target:** `migration/source-inventory.yaml; consumer-inventory.yaml; path-map.yaml`.

**Problem / basis:** Whole-tree ownership includes hidden consumers, root tooling and the document worker. Evidence: R02,R12,R13,R15; §13.2.

**Procedure:** Enumerate every file and reverse import/API/deploy/evidence/model/asset dependency across the named repositories. Record exact move/remain/regenerate/remove decisions, source fingerprints and compatibility owners. Locate benchmark scripts or record unavailable source as a blocker to their reuse.

**Acceptance:** Every source category in §13.2 has disposition; uninspected consumers and ambiguous shared utilities are visible gaps; no guessed deletion.

**Verification:** Filesystem/import/build/registry reconciliation and consumer-owner review; scans must not silently ignore inaccessible scopes.

**Downstream and evidence effect:** Contracts, bindings, move map and qualification scope; path changes alone do not justify rewriting old evidence.

### MIG-003 — Migration; not a phase

**Priority:** P0. **Owner:** Platform integration + product owners. **Dependencies:** MIG-001, MIG-002, GOV-002.

**Target:** `migration/contract-compatibility.yaml; public clients/contracts at their owner; dependency-bindings.yaml`.

**Problem / basis:** Core source consumers cannot simply import relocated product implementation. Evidence: R01,R02,R05,R13,R15; §13.5.

**Procedure:** Replace source-level coupling with admitted neutral contracts/generated clients and bounded integration providers. Preserve Data Cloud read-model/handoff workflows. Prove old supported client calls map to new-owner behavior. Extract neutral mechanics only with owner-approved package boundaries.

**Acceptance:** No core→Media implementation import or product↔platform cycle; supported endpoints/DTOs/proto numbers and frozen document contracts unchanged.

**Verification:** Old-client/new-owner golden contract cases; isolated package classpath/build and type-boundary checks.

**Downstream and evidence effect:** Move wiring and consumer deployments; public-contract material changes require targeted compatibility evidence.

### MIG-004 — Migration; not a phase

**Priority:** P0. **Owner:** Build/release engineer. **Dependencies:** MIG-003.

**Target:** `ghatana-media` transferred tree; standalone product boundary/registry metadata; service-contract source records/overlays/generator bindings.

**Problem / basis:** Copying generated contracts or renaming everything would introduce drift. Evidence: R12,R13,R17; §§13,16.

**Procedure:** Apply §13.3 path map preserving namespaces, package exports, schemas, DB migration checksums and wire paths. Move authored Media contract slices/overlays to the target registered authority; create `ghatana-media` repository boundary metadata, standalone Gradle/pnpm/build roots, publication metadata and CI entrypoints; update cross-repository generators/registries without creating source-workspace coupling. Target stays non-authoritative until cutover.

**Acceptance:** Target builds/validates with approved public dependencies and matching contracts; generated outputs trace to target sources; no copied generic tool engine.

**Verification:** Packaging/build/contract-diff checks and generated-file reproducibility in a source-isolated consumer environment.

**Downstream and evidence effect:** Target runtime tests and both registry projections; packaging evidence requires refresh for relocated build inputs.

### MIG-005 — Migration; not a phase

**Priority:** P0. **Owner:** QA + media/consumer maintainers. **Dependencies:** MIG-004.

**Target:** `migration/parity-report.json; conformance/migration/; existing unit/integration suites`.

**Problem / basis:** An apparently successful source move can lose functions or activate unqualified workers. Evidence: R02,R12,R15; §13.6.

**Procedure:** Run baseline and target tests for artifact/job/stream/consent/privacy/SDK/doc-worker and qualified existing providers. Use controlled fixtures/read-only shadows. Compare actual old/new outputs and failure semantics; preserve all qualification restrictions and explicitly note unavailable environments.

**Acceptance:** No supported-baseline regression; all required relocation checks pass; runtime qualification remains unchanged or explicitly blocked, never silently promoted.

**Verification:** Golden wire/state/output comparisons, migration-history checks, cancellation-generation tests and cross-repo black-box consumers.

**Downstream and evidence effect:** Cutover eligibility only; genuine source/material changes invalidate affected native proofs.

### MIG-006 — Migration; not a phase

**Priority:** P0. **Owner:** Both repository maintainers + release owner. **Dependencies:** MIG-005.

**Target:** `migration/cutover-plan.yaml; prepared registry/source changes in both repos`.

**Problem / basis:** Two repository commits do not form an atomic ownership transfer. Evidence: §13.6; REV-02,05,26.

**Procedure:** Freeze/reconcile the transfer slice; declare target artifacts, public fingerprints, required consumer versions, authority epoch, start/stop conditions and recovery. Verify both prepared states, no dual runtime writes, and exact generated-view changes. Obtain source-cutover authorization.

**Acceptance:** Every barrier has an observable condition and responsible owner; unresolved required consumer or parity failure blocks switch.

**Verification:** Dry-run cutover/recovery using fixtures and registry projections; simulate one repository unavailable or stale source.

**Downstream and evidence effect:** Enables source authority switch; does not authorize production data/deployment mutation.

### MIG-007 — Migration; not a phase

**Priority:** P0. **Owner:** Authorized repository owners. **Dependencies:** MIG-006.

**Target:** `both repos: Media owner sources, registries, generated includes, old source tree, external owner references`.

**Problem / basis:** Leaving the old implementation creates competing authority and build coupling. Evidence: §13.6; R01,R12,R17.

**Procedure:** Execute the admitted source switch; remove old editable Media code/semantic sources; retain only permitted external-owner discovery/consumer integrations. Regenerate affected catalogs/settings/contract views, rerun focused parity/import tests and set transfer status complete only after reconciliation.

**Acceptance:** One canonical Media source in Products; no orphan consumer, duplicate schema owner or shadow runtime; target registered with truthful status.

**Verification:** Cross-repository no-duplicate/import-isolation/path-map/contract checks and clean generated diff; report exact changed files.

**Downstream and evidence effect:** Closes source-transfer work, not runtime readiness; preserve evidence history with explicit relocation mappings.

### MIG-008 — Migration; not a phase

**Priority:** P0. **Owner:** Authorized operations + data/privacy owners. **Dependencies:** MIG-007, IMP-015.

**Target:** `migration/runtime-handover.yaml; deployment identity/lease/store configuration; restore verification`.

**Problem / basis:** Repository relocation must not silently create a second live writer or empty data store. Evidence: §13.7.

**Procedure:** Only under runtime authorization, reuse stores or perform the tested state transfer. Quiesce admission/drain or fence handover; reconcile active effects, streams, uploads, outbox, consent and erasure. Verify backups/tombstones and one authority epoch. Use only qualified compatible recovery binaries.

**Acceptance:** No concurrent authoritative writer, lost state or unauthorized data copy; access/retention/erasure preserved; pending uncertainty remains explicit.

**Verification:** Failure-before/after-barrier rehearsal and data/lease/object consistency checks; restoration and anti-resurrection cases.

**Downstream and evidence effect:** Runtime ownership handover only; final activation additionally requires OPS-001 approval.

### P1-001 — Phase 1

**Priority:** P1. **Owner:** Design-system consumer lead. **Dependencies:** P0-010, GOV-002.

**Target:** `phase-1-design-language/media-token-aliases.yaml; typography-layout.yaml; Shared public component bindings`.

**Problem / basis:** Media risks a private primitive design system and ad hoc styling. Evidence: R10; §19.

**Procedure:** Map semantic representations to Shared tokens/theme/headless/components. Record real gaps upstream; author only Media aliases/compositions. Specify exact layout/type/density/spacing/state hierarchy rather than arbitrary screen CSS.

**Acceptance:** Every primitive has a canonical Shared source or approved gap; aliases resolve; no copied token authority.

**Verification:** Computed-token/export checks in proposed conformance/design-language/ plus design review.

**Downstream and evidence effect:** All view geometry; changes selectively invalidate visual snapshots and derived styles.

### P1-002 — Phase 1

**Priority:** P1. **Owner:** Media interaction + animation/simulation designers. **Dependencies:** P1-001.

**Target:** `phase-1-design-language/component-contracts.yaml; media-editing-grammar.yaml; animation-simulation-grammar.yaml`.

**Problem / basis:** Timeline, masks, waveform, physics instruments and animation need exact reusable interaction contracts. Evidence: R04,R05; §§8,14,19.

**Procedure:** Specify anatomy/slots/variants/actions/keyboard/focus/responsive/a11y/localization for every §19 component. Define scene/model/measurement vs visual controls and before/after/candidate comparison. Reuse TutorPutor mechanics only through the accepted boundary.

**Acceptance:** No component-local invented semantics; canvas operations have accessible alternatives; same action treatment across workspaces.

**Verification:** Component contract completeness tests and keyboard/control walkthroughs using fixed representative fixtures.

**Downstream and evidence effect:** Phase2 compositions and Phase3 components; impacted visual and interaction evidence refreshed.

### P1-003 — Phase 1

**Priority:** P1. **Owner:** UX + trust/operations designers. **Dependencies:** P1-001.

**Target:** `semantic-state-grammar.yaml; action-finality-grammar.yaml; trust-provenance-grammar.yaml`.

**Problem / basis:** Invisible automation may hide material privacy, quality or uncertainty changes. Evidence: §§9–12,14.

**Procedure:** Define simple user-state mapping, one primary action, safe fallback/confirmation, progress unknown, contextual AI proposals, required audit versus diagnostics, errors/recovery and operator drilldown. Keep sharing/locality/fidelity independent.

**Acceptance:** Every Phase0 trust/finality/degraded state has consistent representation; no false green success or silent compromise.

**Verification:** Table-driven semantic-state coverage and product-specific copy review.

**Downstream and evidence effect:** All channels and recovery fixtures; changed risk copy/state mapping triggers relevant review.

### P1-004 — Phase 1

**Priority:** P1. **Owner:** Accessibility/localization specialist. **Dependencies:** P1-002, P1-003.

**Target:** `responsive-adaptive.yaml; accessibility.yaml; localization-content.yaml; motion.yaml`.

**Problem / basis:** Responsive/a11y was broad but not tied to exact media interactions. Evidence: W04; §§14,19.

**Procedure:** Accept viewport/channel matrix; define reflow/mobile recomposition, focus/drag alternatives, semantic canvas shadows, caption/transcript/player behavior, reduced motion/forced colors, font/localization/RTL and content expansion. Declare unsupported device workflows transparently.

**Acceptance:** Critical context/action/recovery survives every supported variant; no a11y rule invented only in Explorer.

**Verification:** §19 viewport and keyboard/localization fixtures; WCAG target mapping plus human a11y review, without claiming conformance from schema tests.

**Downstream and evidence effect:** Screen contracts, fixture assets, screenshots and usability validation.

### P1-005 — Phase 1

**Priority:** P1. **Owner:** CLI/SDK designer + technical writer. **Dependencies:** P1-003.

**Target:** `phase-1-design-language/cli-language.yaml; content-voice rules`.

**Problem / basis:** Terminal output, aliases and interruption semantics were inconsistent. Evidence: R14; §10.5–10.6.

**Procedure:** Apply §10 command grammar, TTY/plain/JSON/JSONL, reason codes/exits, timeouts/SIGINT, flags, config provenance and confirmations. Use Ghatana UI/logging utilities where appropriate without embedding engineering gtool into the product runtime.

**Acceptance:** Machine output independent of human diagnostics; stable errors; no hidden prompting in automation or secret exposure.

**Verification:** Golden terminal widths/output/exit cases and CLI accessibility/content review.

**Downstream and evidence effect:** Phase2 command registry, Explorer CLI simulation and implementation tests.

### P1-006 — Phase 1

**Priority:** P1. **Owner:** Design authority reviewer. **Dependencies:** P1-001, P1-002, P1-003, P1-004, P1-005.

**Target:** `Phase1 acceptance input; generated design coverage`.

**Problem / basis:** File presence cannot establish a coherent representation language. Evidence: U2; §19.

**Procedure:** Walk every Phase0 concept requiring representation against the Phase1 pattern owner. Resolve contradictions, eliminate arbitrary duplication and accept versioned visual/interaction rules.

**Acceptance:** §19 exit gate passes with no missing material grammar; human design decisions recorded.

**Verification:** Direct definition/design checks and human review; no production visual parity claim.

**Downstream and evidence effect:** Unlocks Phase2; future material design changes invalidate only dependent views/evidence.

### P2-001 — Phase 2

**Priority:** P1. **Owner:** UX information architect. **Dependencies:** P1-006.

**Target:** `application-channel-registry.yaml; navigation-contracts.yaml; screen-registry.yaml`.

**Problem / basis:** The full feature set can overwhelm the default shell or create dead navigation. Evidence: §§14,20.2.

**Procedure:** Materialize §14 small shell and §20 view inventory. Register route/deep-link identities, contextual tools, permissions and mobile support. Reconcile old screens/consumer handoffs and duplicate output/profile destinations.

**Acceptance:** All outcomes/capabilities have view/channel disposition; every route has entry/exit/denial/stale behavior; no mandatory provider selection.

**Verification:** Navigation reachability/back-link/deep-link tests against authored fixtures.

**Downstream and evidence effect:** All screen contracts and Explorer route adapters.

### P2-002 — Phase 2

**Priority:** P1. **Owner:** Product UX + distributed-systems analyst. **Dependencies:** P2-001.

**Target:** `screen-contracts/core/; journey-contracts/J-01,J-02,J-20,J-21,J-22,J-26,J-27; action-registry.yaml`.

**Problem / basis:** Core projects/assets/jobs/review/erasure require precise nonhappy behavior. Evidence: §§10–14,20.

**Procedure:** Author exact core view/action/copy contracts using §20.3. Include optimistic versions, upload integrity, waiting versus cancellation, partial/unknown outputs, review versions, rights/deletion and safe delivery finality. Bind API and CLI actions.

**Acceptance:** Every core state/visible control resolves to an effect and safe next action; no completed work lost by default recovery.

**Verification:** Contract/schema traceability and state-path fixtures, including stale edits and ambiguous dispatch.

**Downstream and evidence effect:** Core Explorer and foundation runtime tests.

### P2-003 — Phase 2

**Priority:** P1. **Owner:** Generation/editing/quality experience lead. **Dependencies:** P2-001, P0-007.

**Target:** `screen-contracts/create-edit-quality/; journey-contracts/J-07–J-11,J-18,J-19; content-copy-catalog.yaml`.

**Problem / basis:** Generation and repair experiences lacked concrete limits and compare/approval effects. Evidence: §§6.4,6.7–6.9,9,20.

**Procedure:** Define storyboard/reference/control, generation candidates, preserve/enhance/creative before-after, masks, temporal repair, color/graphics, render and quality screens. Specify unsupported controls, estimates, bounded optimization and materially changed approvals.

**Acceptance:** Each generation/edit/quality capability has a complete intentional workflow and failure/recovery, not an illustrative card.

**Verification:** Candidate-selection/repair-budget/profile-fallback fixture scenarios and requirement coverage.

**Downstream and evidence effect:** MediaSynth and quality Explorer, runtime adapter/metric qualification.

### P2-004 — Phase 2

**Priority:** P1. **Owner:** Animation/simulation/domain integration architect. **Dependencies:** P2-001, P0-004, P0-008.

**Target:** `screen-contracts/animation-simulation/; journey-contracts/J-12–J-15,J-28; handoff-bindings.yaml`.

**Problem / basis:** Media could confuse visual appearance with a validated domain simulation. Evidence: R04,R05; §§8,17,20.

**Procedure:** Define initial-state/units/fidelity, scene/animation controls, model/story clocks, rigs, solver limits, measurements, pass export and interactive delivery. Preserve domain-owned truth and disclose conversion loss. Specify exact TutorPutor handoff and return context.

**Acceptance:** All animation/simulation families have defined support/qualification disposition, accessible control and safe failure; no learned visual score certifies science.

**Verification:** Unit/clock/rig/coordinate/conversion-loss fixtures, fidelity-downgrade rejection and accessible parameter walkthrough.

**Downstream and evidence effect:** Animation/simulation Explorer, reusable-engine extraction and render/export tests.

### P2-005 — Phase 2

**Priority:** P1. **Owner:** Audio/speech/streaming experience lead. **Dependencies:** P2-001.

**Target:** `screen-contracts/audio-speech-stream/; journey-contracts/J-03–J-06,J-16,J-17; existing document handoffs`.

**Problem / basis:** Audio/speech streaming and document consumers must not be omitted by the creation focus. Evidence: R02,R15; §§6,10–12,20.

**Procedure:** Define speech/voice consent, languages/pronunciation, timestamps, transcript/caption correction, stems/mastering, dubbing meaning/sync, stream reconnection/close and document-worker integration restrictions. Bind outputs and provenance to exact versions.

**Acceptance:** File/streaming cases and all declared languages/fallback dispositions explicit; no fake transcript, voice or extraction success.

**Verification:** Synthetic speech/timing/error fixtures, missing consent, silence, overlapping speakers and cancellation/unsupported-language cases.

**Downstream and evidence effect:** Audio/stream/doc Explorer and native contract/quality tests.

### P2-006 — Phase 2

**Priority:** P1. **Owner:** API/SDK/CLI contract owner. **Dependencies:** P2-002, P2-003, P2-004, P2-005.

**Target:** `cli-command-registry.yaml; api-experience-mapping.yaml; contracts/openapi/media.yaml owner bindings`.

**Problem / basis:** Web, SDK, CLI and current transport shapes can diverge. Evidence: R13; §§10,20.

**Procedure:** Expand §10 finite command/action registry; define schemas/parameters/aliases/exits/input limits/idempotency/window/timeouts. Preserve supported transport and map facades explicitly. Establish actual request/result examples including zero-binary text generation, multiple sources and partial outputs.

**Acceptance:** Every command has action/contract authority and all flags/exit behavior; no new endpoint claimed implemented; alias produces same request fingerprint.

**Verification:** Golden request/response/CLI JSON fixtures and compatibility matrix; strict schema validation.

**Downstream and evidence effect:** CLI/API Explorer, SDK generation and runtime parity.

### P2-007 — Phase 2

**Priority:** P1. **Owner:** Experience simulation + content lead. **Dependencies:** P2-002, P2-003, P2-004, P2-005, P2-006.

**Target:** `scenario-fixture-registry.yaml; simulation-semantics.yaml; data-view-contracts.yaml; content-copy-catalog.yaml`.

**Problem / basis:** Fake terminal/video demos could imply real state while diverging across screens. Evidence: U2; §§20–21.

**Procedure:** Author deterministic scenario states, clocks, actions/reducers and asynchronous event semantics before Explorer code. Use coherent licensed media fixtures with declared defects and version links. Define role/locale/connectivity variants and all listed failure paths.

**Acceptance:** Every material action/state has a fixture and coherent cross-view effect; simulated scores/results explicitly non-production.

**Verification:** Pure transition/replay tests; fixture referential integrity and content/rights checks.

**Downstream and evidence effect:** Phase3 implementation and later implementation-parity fixtures.

### P2-008 — Phase 2

**Priority:** P1. **Owner:** Independent experience reviewer. **Dependencies:** P2-001, P2-002, P2-003, P2-004, P2-005, P2-006, P2-007.

**Target:** `root traceability/acceptance; generated coverage; COMPLETE-PRODUCT-EXPERIENCE.md`.

**Problem / basis:** Experience completeness cannot be repaired by invention in Explorer. Evidence: U2; §20.5.

**Procedure:** Walk the full outcome-to-experience graph both ways. Check every leaf/control/route/state/journey/handoff and responsive/a11y/localized copy; resolve source gaps upstream and regenerate. Produce a readable implementation-ready reference independent of code.

**Acceptance:** §20 exit gate passes; no undefined material experience path or unclassified operation remains.

**Verification:** Direct check:definition --phase 2 plus full journey/action/navigation audit and schema validation.

**Downstream and evidence effect:** Unlocks Phase3; accept definition, not implementation readiness.

### P3-001 — Phase 3

**Priority:** P1. **Owner:** Explorer adapter engineer + Tools owner. **Dependencies:** P2-008, GOV-002.

**Target:** `phase-3-experience-explorer/manifest.yaml; product-package/; public Tools Explorer binding`.

**Problem / basis:** Neutral spec types are not an implemented Explorer runtime. Evidence: R11,R14; §21.

**Procedure:** Discover/reuse the current public Explorer contracts/runtime; record missing generic capabilities as Tools owner gaps. Build Media package adapters referencing Phase0–2 fingerprints, render targets and fixtures. Keep product rules out of generic core.

**Acceptance:** Package loads through public boundaries without private source copies or live production dependencies.

**Verification:** Isolated package load/manifest/schema tests; explicit missing-generic-feature rejection.

**Downstream and evidence effect:** All Explorer modes and build assets.

### P3-002 — Phase 3

**Priority:** P1. **Owner:** Product simulation engineer. **Dependencies:** P3-001.

**Target:** `phase-3-experience-explorer/simulations/; fixtures/; mock transport adapters`.

**Problem / basis:** Cross-screen actions must change one coherent simulated product. Evidence: §21.3.

**Procedure:** Implement accepted reducers/events with deterministic clocks/IDs, resets and replay. Validate authority/preconditions and update project/job/artifact/review projections together. Use negative scenarios for concurrency, unknown outcomes and policy changes.

**Acceptance:** Same action sequence yields same declared state; no UI-only business semantics; every simulated result carries its fixture context.

**Verification:** Model-based replay/action tests and cross-view consistency assertions.

**Downstream and evidence effect:** Web/CLI/API simulation projections; not runtime scientific or provider proof.

### P3-003 — Phase 3

**Priority:** P1. **Owner:** Media UI engineers. **Dependencies:** P3-002.

**Target:** `phase-3-experience-explorer/product-package/views/; components/; Shared design bindings`.

**Problem / basis:** Every intended workspace needs faithful composition, not generic placeholders. Evidence: §§19–21.

**Procedure:** Realize all accepted views/components/states, including editing, quality, animation/simulation, audio and operator/rights paths. Use exact copy/tokens/fixtures. All visible controls follow their disposition and actual navigation/effect.

**Acceptance:** Every registered view renders and important journey runs; Product mode has no Explorer chrome; disabled and external boundaries are explicit.

**Verification:** View/state coverage, semantic DOM/geometry checks, full declared control/nav traversal.

**Downstream and evidence effect:** Visual/interaction/a11y evidence and downstream UI reference.

### P3-004 — Phase 3

**Priority:** P1. **Owner:** CLI/API experience engineer. **Dependencies:** P3-002, P2-006.

**Target:** `phase-3-experience-explorer/product-package/channels/cli/ and api/; Explore/Specification/Verify mode bindings`.

**Problem / basis:** CLI demos and diagnostic panels must not invent independent behavior. Evidence: §§10,21.2.

**Procedure:** Implement terminal command parsing/formatting and API sample projections over the same simulation actions. Add Explore selectors, Specification trace navigation and Verify result presentation through generic contracts. Preserve error/exit/finality semantics.

**Acceptance:** Equivalent Web/CLI/API commands cause the same state changes; diagnostics separated from Product mode and production evidence.

**Verification:** Golden terminal/JSON/JSONL/error/exit tests; cross-channel request/effect parity.

**Downstream and evidence effect:** Channel completeness and developer handoff examples.

### P3-005 — Phase 3

**Priority:** P1. **Owner:** Frontend packaging/security engineer. **Dependencies:** P3-003, P3-004.

**Target:** `Explorer package/build/serve configuration; CSP/assets/cache manifests`.

**Problem / basis:** Broken dynamic imports/CSP/deep links can make a nominally complete Explorer unusable. Evidence: §21.4.

**Procedure:** Bundle required fonts/media/data; test supported serving origin/base path, dynamic imports, MIME, workers, deep-link reload, cache/currentness and offline fixture mode. Fail usefully on stale/missing projections. Use narrow CSP; never unrestricted network as a fix.

**Acceptance:** Clean build loads without page/resource/CSP errors; no stale authority mixing; no production credentials/network required.

**Verification:** Browser loading and offline/reload/missing-chunk/stale-cache tests against built output.

**Downstream and evidence effect:** All browser/visual evidence; asset/build changes invalidate affected rendered references.

### P3-006 — Phase 3

**Priority:** P1. **Owner:** QA/accessibility/visual engineer. **Dependencies:** P3-005, P1-004.

**Target:** `phase-3-experience-explorer/verification/; screenshots/; conformance/browser/`.

**Problem / basis:** Screenshot diff alone misses behavior/accessibility and can hide unsupported states. Evidence: U2; §21.5.

**Procedure:** Run semantic/token/geometry/interaction/nav/state checks, keyboard/focus/zoom/text spacing/forced colors/reduced motion/locales, responsive and terminal variants. Pin environment and justify masks/tolerances. Include every material negative scenario.

**Acceptance:** Automated required cases pass with reconciled discovery/execution/results; skipped/unavailable cases are not counted as success.

**Verification:** Direct test:explorer command once implemented; current reports reference exact phase/package/browser/font/fixture fingerprints.

**Downstream and evidence effect:** Automated Explorer acceptance only; human visual review still required.

### P3-007 — Phase 3

**Priority:** P1. **Owner:** Human product/design/accessibility reviewers. **Dependencies:** P3-006.

**Target:** `root acceptance records; Phase3 visual/usability review observations`.

**Problem / basis:** Automated green status cannot establish pixel-perfect clarity or usability. Evidence: U2; §§14,21.

**Procedure:** Inspect representative and risk-critical surfaces/variants, including technical editing and ordinary first-use. Perform the admitted formative usability protocol, resolve upstream defects at their owning phase, rerun impacted checks and record reviewer/version/results.

**Acceptance:** §21.5 complete with human visual and accessibility review; unresolved material issues keep REVIEW_REQUIRED/FAIL rather than fabricated approval.

**Verification:** Signed/attributed review records, current screenshot/geometry bindings and no unresolved critical navigation/meaning defects.

**Downstream and evidence effect:** Accepts Phase3 reference; no production or certification claim.

### HAND-001 — Derived handoff; not a phase

**Priority:** P1. **Owner:** Product engineering lead. **Dependencies:** P3-007.

**Target:** `handoff/implementation-contract.yaml; implementation-traceability.yaml; IMPLEMENTATION-HANDOFF.md`.

**Problem / basis:** Engineering needs one exact downstream construction/test view. Evidence: U2 development handoff; §22.

**Procedure:** Generate slices from accepted requirements/views/actions/ports/reuse decisions. Include exact target paths, acceptance tests, dependency blockers and qualification lanes. Keep production code work explicitly outside definition mode and source cutover as a runtime prerequisite.

**Acceptance:** Every admitted requirement maps to implementation work/test or explicit owner-dependent disposition; no duplicated semantic prose becomes authority.

**Verification:** Handoff reference/schema completeness and reverse trace from implementation task to Explorer/requirement.

**Downstream and evidence effect:** Downstream IMP work; regeneration tracks only changed authority inputs.

### HAND-002 — Cross-phase reconciliation

**Priority:** P1. **Owner:** Documentation/authority owner. **Dependencies:** HAND-001.

**Target:** `source-manifest.yaml; README entrypoints; superseded-doc removal map; final definition report`.

**Problem / basis:** Old plans and generated views can remain competing authorities. Evidence: U1/U2; §§5,22,25.

**Procedure:** Reconcile document roles and stale duplicate instructions, including obsolete Phase4 terminology, API relocation rewrites and OSS-first precedence. Preserve source provenance and required history; make current canonical entries obvious. Report phase/migration/runtime status separately.

**Acceptance:** One source answer per material concept, no broken links or silent TBDs, no phase beyond 0–3.

**Verification:** Authority/link/ID/source-coverage checks and generated final report.

**Downstream and evidence effect:** Closes definition consolidation only; migration/runtime work retains independent status.

### IMP-001 — Downstream runtime; not a phase

**Priority:** P0. **Owner:** Backend + security/observability owners. **Dependencies:** HAND-001, MIG-007.

**Target:** `launcher/; runtime-contracts/; artifact/store/identity/audit adapters; libs/`.

**Problem / basis:** New capability work needs reliable governed input/output foundations. Evidence: R02,R08,R09; §§7,10–12,16.

**Procedure:** Implement accepted artifact/project/request boundaries using existing stores and Shared identity/security/audit/observability. Register verified outputs non-destructively, bounded uploads/imports, lifecycle/access/retention and role/context. Preserve the moved baseline and direct tests.

**Acceptance:** Accepted core artifact/project/security contracts function on real declared stores; no false production fallback to memory.

**Verification:** Unit/schema/HTTP/auth/upload/storage/erasure tests plus isolated public consumer checks.

**Downstream and evidence effect:** All runtime slices; actual material changes refresh affected native evidence.

### IMP-002 — Downstream runtime; not a phase

**Priority:** P0. **Owner:** Distributed-systems engineer. **Dependencies:** IMP-001.

**Target:** `job coordinator/repository adapters; Shared workflow/messaging bindings; worker lease/outbox tables`.

**Problem / basis:** Current in-process execution is not a durable worker service. Evidence: R02,R06,R07; §12.

**Procedure:** Apply §12 state/attempt/reservation semantics through Shared workflow; implement Media-owned persisted claims, delayed scheduling, fences, bounded retries, outbox delivery, recovery and cancellation. Avoid duplicate retry authorities and dispatch uncertain work only after reconciliation.

**Acceptance:** Crash/restart/race/unknown outcomes preserve one logical job/result; stale workers and duplicate effects cannot finalize.

**Verification:** Database concurrency, process-crash and every-side-effect-boundary injection; real outbox consumer acknowledgements.

**Downstream and evidence effect:** Graph execution and all long-running operations.

### IMP-003 — Downstream runtime; not a phase

**Priority:** P0. **Owner:** Graph/runtime engineer. **Dependencies:** IMP-002.

**Target:** `modules/ graph compiler/coordinator; typed ports; worker admission/sandbox adapters`.

**Problem / basis:** Flexible graphs need bounded execution without a new generic platform. Evidence: §§7–12.

**Procedure:** Compile immutable specs into admitted plans; implement typed batch/stream/sim/render adapters, graph/resource bounds, caching and incremental invalidation. Reuse Shared primitives and approved native process mechanisms; isolate all external engines and verify output registration.

**Acceptance:** Invalid graph/format/unit/policy is rejected before work; independent nodes parallelize within bounds; no provider type leaks into domain.

**Verification:** Graph/type/cycle/limit/property tests, fair scheduling/cancellation and sandbox escape attempts in controlled fixtures.

**Downstream and evidence effect:** All Media engines and recipes; compiler/binding changes invalidate affected plans.

### IMP-004 — Downstream runtime; not a phase

**Priority:** P1. **Owner:** SDK/CLI engineer. **Dependencies:** IMP-002, P2-006.

**Target:** `libs/audio-video-client; libs/audio-video-types; cli/; public package exports`.

**Problem / basis:** The product needs script-safe real execution matching the specified channel. Evidence: R13; §10.

**Procedure:** Implement generated/validated API mappings and every admitted command via one SDK/action layer. Add resumable local file upload/download, auth/config, JSON/JSONL, exits, safe overwrite, watch/SIGINT/reconciliation, retries and finite aliases.

**Acceptance:** §10 contract passes against the real API; no secret/progress pollution or accidental remote cancellation; unsupported capability explicit.

**Verification:** Pack/install consumer tests, CLI golden/output/exit/signal/path tests and real API parity.

**Downstream and evidence effect:** Batch users, product integrations and Web shared operation client.

### IMP-005 — Downstream runtime; not a phase

**Priority:** P1. **Owner:** Video/color/composition engineer. **Dependencies:** IMP-003.

**Target:** `modules/audio-processing; video-processing; composition; delivery; admitted codec/color adapters`.

**Problem / basis:** High-quality output requires deterministic media work before more generative engines. Evidence: §§6,8–12,15; W01.

**Procedure:** Reuse existing Media/Ghatana transcoding and rendering; implement accepted timeline, exact graphics, color/alpha/time mappings, mux/encode/master/packaging and structural validation. Qualify exact tools/builds and formats through the OSS gate.

**Acceptance:** Known-fixture outputs satisfy declared technical/visual contracts; exact text/graphics preserved; no unreviewed codec build.

**Verification:** FFprobe/equivalent structural validation, color/alpha/sample/frame goldens, codec/player interoperability and licensing/build manifest checks.

**Downstream and evidence effect:** All generated/imported media output and delivery.

### IMP-006 — Downstream runtime; not a phase

**Priority:** P1. **Owner:** Animation/simulation engineer + TutorPutor/Shared owners. **Dependencies:** IMP-003, P0-008.

**Target:** `modules/animation; modules/simulation; admitted reused/extracted packages; model/scene conversion adapters`.

**Problem / basis:** Building external engines first would duplicate existing ecosystem capabilities. Evidence: R04,R05; §§3,8,17.

**Procedure:** Implement the approved reuse/extraction decision, then the smallest qualified animation/sim/render stack for the pilot. Enforce typed clock/units/fidelity/replay, scene bindings, checkpoints, accessible instruments and pass/export mapping. Add external engines only for documented unmet requirements.

**Acceptance:** TutorPutor domain semantics remain outside Media mechanics; isolated consumer builds; model versus visual fidelity preserved; bounded reproducibility proven per engine.

**Verification:** Old-fixture compatibility, unit/coordinate/time/replay tests, unsupported-feature loss reports and accessible interactive rendering.

**Downstream and evidence effect:** Animation/simulation/hybrid recipes; extracted-mechanic changes require both consumer tests.

### IMP-007 — Downstream runtime; not a phase

**Priority:** P0. **Owner:** AI Inference owner + Media integration engineer. **Dependencies:** HAND-001, GOV-002, P0-008, MIG-007.

**Target:** `ghatana/services/ai-inference public contract/owned adapters; Media integrations/ai-inference`.

**Problem / basis:** Image/video/audio execution and local deployment are not established by names in the plan. Evidence: R03; §§3,7,9,12.5.

**Procedure:** Implement required typed generation/modality capabilities at AI Inference owner, with artifact access, quotas, cancellation/reconciliation, model/weight/asset admission and supported local/remote profiles. Publish versioned contracts; Media translates semantic intent only.

**Acceptance:** No Media generic provider/model routing or credential store; exact capability limits and binary-output registration are enforced; absent capability remains blocked.

**Verification:** Owner contract/provider/negative governance tests and Media black-box consumer tests; no qualification from SDK presence alone.

**Downstream and evidence effect:** All new generic AI generation/analysis; owner releases may be independent but compatibility bound.

### IMP-008 — Downstream runtime; not a phase

**Priority:** P1. **Owner:** MediaSynth + continuity engineer. **Dependencies:** IMP-003, IMP-005, IMP-007.

**Target:** `modules/media-synth; scene/reference/video facades; continuity integration`.

**Problem / basis:** Benchmark-only generation cannot serve durable multi-scene production. Evidence: §9; benchmark-source gap.

**Procedure:** Implement accepted planning/storyboarding and strategy selection over qualified AI capabilities; preserve references/controls/actual generation metadata and continuity observations. Acquire benchmark source before reusing its code, isolate pure helpers and keep benchmark reporting outside product authority.

**Acceptance:** Prompt/reference-to-registered-output works within rights/budget/profile; partial scenes and uncertain remote work recover safely; no fixed Flux/LTX assumption.

**Verification:** Deterministic adapter tests, capability-specific controlled model tests and full MediaSynth failure/recovery recipes.

**Downstream and evidence effect:** Generation channels and profile qualification; source helper reuse requires actual source review.

### IMP-009 — Downstream runtime; not a phase

**Priority:** P1. **Owner:** Quality/restoration/ML engineer. **Dependencies:** IMP-003, IMP-005, IMP-007.

**Target:** `modules/enhancement; editing; quality; quality metric registry and benchmark fixtures`.

**Problem / basis:** Automatic improvements can regress fidelity or endlessly optimize a proxy score. Evidence: §§6.7–6.9,9,12.3.

**Procedure:** Implement each admitted restoration/edit/metric leaf with qualified applicability, preservation rules, before/after and abstention. Add bounded candidate ranking/repair with temporal context, stop/no-improvement conditions and user-version protection; reuse only current authorized cache.

**Acceptance:** Every enabled operation proves its contract and known limitations; no silent generative reconstruction in preserve mode; no unbounded loop/cost.

**Verification:** Corruption/repair/metric-domain negative cases, perceptual/domain review, budget/attempt and temporal seam tests.

**Downstream and evidence effect:** Improve/edit/quality recipes and generated media qualification.

### IMP-010 — Downstream runtime; not a phase

**Priority:** P1. **Owner:** Audio/speech synchronization engineer. **Dependencies:** IMP-003, IMP-005, IMP-007.

**Target:** `modules/speech; intelligence/ai-voice; synchronization; composition audio/captions`.

**Problem / basis:** Audio quality/dubbing cannot be reduced to appending an MP3. Evidence: §§6,8–12.

**Procedure:** Reuse existing STT/TTS/voice capabilities and accepted AI boundary. Implement alignment, captions, prosody/pronunciation controls, separation/cleanup, mix/master and dubbing review. Keep sample/frame timing and actual codec delays explicit.

**Acceptance:** Every enabled language/voice/sync mode has qualified output and rights; silence/overlap/length conflicts and drift are safely handled.

**Verification:** Synthetic impulse/speech/timing goldens, multilingual meaning/voice review, clipping/loudness and failure tests.

**Downstream and evidence effect:** Audio generation, captions, dubbing and final masters.

### IMP-011 — Downstream runtime; not a phase

**Priority:** P1. **Owner:** Web application + accessibility engineers. **Dependencies:** IMP-004.

**Scope prerequisites:** IMP-005 when composition/delivery views enabled; IMP-006 when animation/simulation views enabled; IMP-008 when MediaSynth views enabled; IMP-009 when enhancement/quality views enabled; IMP-010 when audio/dubbing views enabled; IMP-012 when live streaming views enabled.

**Target:** `apps/web; libs/audio-video-ui; real transport/review/version adapters`.

**Problem / basis:** An Explorer is not a production application and fake controls must not ship. Evidence: §§10,14,19–21.

**Procedure:** Implement accepted views over real operation client and supported providers; preserve simple/guided/expert projections, versioning/autosave/review/conflicts, local pairing and accessibility. Reuse existing collaboration mechanisms where admitted. Disabled unavailable features retain reason/recovery.

**Acceptance:** Production supported journeys match accepted Explorer contracts without mock success; auth/finality and exact-version effects consistent.

**Verification:** Web↔API↔CLI parity, real-browser journey/error/accessibility/visual tests and representative usability review.

**Downstream and evidence effect:** Actual end-user experience; runtime availability cannot be inferred from Explorer evidence.

### IMP-012 — Downstream runtime; not a phase

**Priority:** P1. **Owner:** Streaming/media transport engineer. **Dependencies:** IMP-002, IMP-003.

**Target:** `modules/audio-streaming; video-streaming; admitted transport/recording/delivery adapters`.

**Problem / basis:** Live processing and distribution can be lost in an offline-generation focus. Evidence: R02; §§6.2,10–12.

**Procedure:** Preserve and harden existing stream session/token/lease/frame/order/ack/backpressure/consent contracts. Add only admitted recording/live caption/ABR/WebRTC/HTTP delivery profiles through qualified adapters, keeping format and latency limits explicit.

**Acceptance:** No dropped/reordered/unacknowledged frame called accepted; reconnect and revoked consent safe; output/close finality accurate.

**Verification:** Network loss/reconnect/timeout/sequence/buffer/consent tests and profile-specific live load measurements.

**Downstream and evidence effect:** Live channels and delivery qualification.

### IMP-013 — Downstream runtime; not a phase

**Priority:** P0. **Owner:** Document worker + consumer owners. **Dependencies:** IMP-001, MIG-007.

**Target:** `modules/intelligence/document-intelligence-worker; client adapters; frozen Shared contract bindings`.

**Problem / basis:** The worker has distinct scope/qualification and cancellation semantics. Evidence: R15.

**Procedure:** Preserve current profile/admission and operation-generation token behavior after relocation; fix only demonstrated compatibility gaps. Rebind existing consumers and prove no expanded model/provider ownership or activation. Additional document features require separate accepted requirements.

**Acceptance:** Existing qualified dimensions preserved; NOT_ACTIVATED/NOT_QUALIFIED/NOT_EVALUATED restrictions not silently changed.

**Verification:** Frozen API golden/cancel-before-submit/stale-generation tests and relevant consumer/worker qualification checks.

**Downstream and evidence effect:** Document consumers only; do not rerun unrelated generative-media tests.

### IMP-014 — Downstream runtime; not a phase

**Priority:** P1. **Owner:** Capability qualification + supply-chain owners. **Dependencies:** GOV-002, HAND-001, MIG-007.

**Scope prerequisites:** IMP-005 when deterministic composition/delivery leaves selected; IMP-006 when animation/simulation leaves selected; IMP-008 when generation leaves selected; IMP-009 when enhancement/edit/quality leaves selected; IMP-010 when speech/audio/synchronization leaves selected; IMP-012 when streaming leaves selected; IMP-013 when document worker leaves selected.

**Target:** `benchmarks; config/profiles; oss-components.yaml; qualification reports`.

**Problem / basis:** Full definition coverage does not establish engine/model/format readiness. Evidence: §§6,8,9,15,24.

**Procedure:** For every leaf admitted to the runtime lane, freeze input corpus/licenses, hardware/runtime/build/model, profile, metric version, thresholds, repetitions and failure cases; execute technical/perceptual/domain tests and record limits. Expand remaining spatial/advanced physics/editing families only through their documented dependency decision and tests.

**Acceptance:** Every enabled leaf has current dimensional qualification and distribution admission; unsupported full-scope leaves remain explicit—not counted as pass or deleted.

**Verification:** Cold/warm/resource/cost/failure/quality matrix, engine conversion/replay tests and SBOM/license review; preserve negative results.

**Downstream and evidence effect:** Profile bindings and capability availability; qualification refresh is material-input selective.

### IMP-015 — Downstream runtime; not a phase

**Priority:** P0. **Owner:** SRE/security/QA lead. **Dependencies:** IMP-001, IMP-002, IMP-003, IMP-004, IMP-014.

**Scope prerequisites:** IMP-011 when Web channel selected for activation.

**Target:** `deployment-profile manifests; restore/soak/security/operations tests; readiness report`.

**Problem / basis:** Production cannot be activated from local tests or spec completeness. Evidence: R12; §§11–13,24–25.

**Procedure:** Qualify the explicitly selected runtime lane: actual durable stores, identity/audit/outbox, fair resource control, secrets/egress, crash/failure/recovery/erasure, load/soak, backups/restore, model/license policies, observability limits and customer workflows. Freeze deployment SLO/RPO/RTO before testing.

**Acceptance:** All required cases for the selected activation profile pass with no disguised skip; activation gap/uncertainty remains explicit. Other unsupported lanes stay disabled.

**Verification:** Real black-box/infrastructure/adversarial/performance/restore/operational rehearsal; matched planned/discovered/executed result counts.

**Downstream and evidence effect:** Runtime handover/activation eligibility only; not automatic release or external certification.

### OPS-001 — Authorized activation; not a phase

**Priority:** P0. **Owner:** Release/operations owner. **Dependencies:** MIG-008, IMP-015, HAND-002.

**Target:** `deployment activation record; capability registry/bindings; runbooks and user-facing availability`.

**Problem / basis:** Qualified work still requires an intentional deployment/publication decision. Evidence: §§12–13,25.

**Procedure:** Activate only the reviewed profile under explicit authority; bind exact artifacts/policy/contracts and monitoring/rollback/forward-recovery instructions. Keep unrelated unqualified capabilities disabled and clearly explained. Record current runtime observations, not static flags as availability.

**Acceptance:** No accidental production enablement or provider/model download; one active authority; operator recovery and support path verified.

**Verification:** Authorized canary/smoke/capability checks and stop-condition monitoring in the approved environment.

**Downstream and evidence effect:** Actual enabled service/capability availability; does not change accepted product definition.
# 24. Verification, experiments and completion measurement

## 24.1 Three independent acceptance gates

| Gate | What it proves | What it cannot prove |
|---|---|---|
| `MIGRATION_PARITY` | Source/contract ownership transferred, supported baseline behavior preserved, consumers compatible, no duplicate owner or source coupling | New feature completeness, new provider quality, production activation or a full product redesign |
| `PRODUCT_DEFINITION` | Phases0–3 define the complete intended product and a faithful deterministic reference with current visual/accessibility review | Durable production behavior, real engine/model performance, scientific validation or real deployment readiness |
| `RUNTIME_QUALIFICATION` | Exact selected capabilities, artifact builds, models, datasets, environment and deployment profile satisfy their measured contracts | Universal device/model support, unrelated capabilities or automatic release/certification |

Do not merge these into a single percentage. A migration can pass while new MediaSynth work is absent. Product definition can pass while an advanced solver remains unqualified. A runtime lane cannot claim “all Media complete” while catalog leaves remain unimplemented.

## 24.2 Direct tests and reusable evidence

Use ordinary unit/contract/component/integration/browser/native tests through the repository’s actual Gradle/pnpm/Python/Cargo runners. Tools may plan and adopt results from the same operations; no second test implementation or changed semantics for closure execution. Framework schema tests verify schemas, not real provider behavior. A mocked successful render is not a native render proof.

For every operation record discovered cases, selected cases, executed terminal observations, failures/skips/blockers and exact environment. No process exit 0 without reconciled assertions. Infrastructure-required cases fail or report blocked under their explicit qualification profile; normal offline unit runs do not masquerade as infrastructure qualification.

Use current semantic inputs for reuse: requirements/contracts, implementation, dependency/provider fingerprints, fixtures, toolchain/configuration and environment relevant to the claim. Preserve unaffected proofs; change in a private filename alone is different from changed public behavior, but packaging relocation still requires isolated consumer validation. A stale or missing observation is not pass.

## 24.3 Required verification families

| Verification ID | Cases and acceptance |
|---|---|
| V-AUTHORITY | Unique stable IDs; all references resolve; one owner per concept; no generated upstream truth; constitution traceability; no undefined active capability disposition |
| V-REUSE | Ghatana-first decision exists for every dependency; exports/version/publication and isolated use validated; no private-source or product-domain leak; external fallback properly justified |
| V-MOVE | Source inventory/path map reconcile; generated contract inputs moved correctly; old owner removed after cutover; consumer compatibility and baseline parity; no unapproved API/namespace/schema rewrite |
| V-POLICY | Forged tenant/principal/delegation, stale policy, revoked consent, disallowed region/egress, rights/license failure and privilege escalation all rejected before forbidden work |
| V-INGEST | Empty/oversized/malformed/truncated media, deceptive MIME, duplicate/out-of-order parts, hash mismatch, interrupted finalization, archive traversal/bombs, scene/font/script parsing and private URL fetch |
| V-ARTIFACT | Immutability of bytes/version; identity/metadata integrity; authorized Range/resume; dedupe isolation; shared-byte references; partial output not promoted |
| V-JOB | Duplicate commands, same-key conflict, claim races, expired/stale leases, multi-instance scheduling, cancellation before/during/after dispatch, timeout and restart |
| V-UNCERTAIN | Provider accepted but response lost; result committed but acknowledgement lost; CAS/audit/output-registration failure after effect; no blind resubmission; explicit reconciliation |
| V-OUTBOX-AUDIT | Durable intent and single acknowledgement authority; duplicate/conflicting events; sink unavailable; bounded backlog/drain; required audit versus optional telemetry failure |
| V-GRAPH | Cycles, type mismatch, missing inputs, incompatible color/time/units, unbounded expansion, unsupported adapters, unauthorized plan reuse and partial recomputation dependencies |
| V-SANDBOX | Decoder/engine/model/plugin attempts to access host files/network, spawn processes, exceed memory/disk/VRAM/time, or inject command arguments; safe child cleanup |
| V-CACHE | Same bytes different tenant/rights, changed model/config/seed/color/time/fonts, revoked license/consent, retention expiry, deletion tombstones and stale policy invalidate eligibility |
| V-TIME | Fractional rates, VFR input, trim boundaries, long duration, sample/frame conversion, encoder delay, silence/padding, drift, time stretching and story/simulation clock independence |
| V-COLOR | Primaries/transfer/matrix/range/bit-depth/alpha; LUT/config fingerprint; SDR/HDR handling; aspect/pixel ratio; round-trip/conversion accuracy under admitted tolerance |
| V-ANIMATION | Keyframes/curves/blends/constraints; rig maps/IK/morph/path/camera; seek/replay/export; unsupported engine feature; semantic keyboard control and versioned undo |
| V-SIMULATION | Unit/coordinate transformations, stability and solver bounds, checkpoint/restore, ordering, fidelity preservation, declared replay class, physical measurement and visual binding |
| V-INTERCHANGE | Supported glTF/editorial/scene/volume/asset subset; import/export losses identified; absent extension rejected or explicitly converted; metadata/rights preserved |
| V-SPEECH-AUDIO | No speech/overlap/noise/reverb/clipping/bandwidth limits; language/voice/phoneme support; consent; intelligibility/meaning; stems leakage; loudness/true peak/phase and alignment |
| V-GENERATION | Text-only and multireference input, conditioning limits, real output descriptors, continuity constraints, model-grid/encoder-size mismatch, profile/license/budget admission and provider ambiguity |
| V-RESTORATION | Detail hallucination, identity drift, over-sharpen/denoise, temporal artifacts, preservation policy and before/after comparison; no automatic application of every filter |
| V-QUALITY | Metric applicability/abstention/version, known false positives/negatives, reference alignment, candidate ranking, repair halos/seams, no improvement, bounded attempts/cost and no domain-truth claim |
| V-COMPOSE | Exact fonts/text/logos/graphics, clip alignment, captions, transitions, audio mix, color, track layout, failed source segment and final master validation |
| V-DELIVERY | Container/codec tracks, duration/integrity/bytes, captions/HDR metadata/renditions, player compatibility, expired signed access, partial transfer and uncertain public publication |
| V-STREAM | Token/tenant/consent, reconnect, contiguous sequence and matching ack, bounded backpressure, slow consumer, timeout, recording and close/termination |
| V-DOCUMENT | Frozen public worker DTOs, operation-generation matching, stale/pre-submit cancellation, admitted formats/languages/fallbacks, unchanged non-activation restrictions |
| V-CHANNEL | Web/CLI/SDK/API equivalent action/state; config precedence; idempotent submission; wait versus job cancel; JSON/JSONL/exits; SIGINT; TTY/no-color/unicode paths |
| V-EXPLORER | Product/Explore/Specification/Verify separation, deterministic fixtures/reducers, all registered views/actions/states, coherent mutations, no dead links/placeholders and no production calls |
| V-LOAD | Built asset/import/CSP/base-path/deep-link/offline/reload/cache behavior; unknown/stale projection is recoverable; no blanket CSP weakening |
| V-ACCESS | Supported keyboard/drag alternatives, semantic canvas/timeline/instruments, focus, labels/errors/status, captions/transcripts, zoom/reflow/forced colors/reduced motion/localization |
| V-VISUAL | Tokens/computed geometry/screenshots plus human review across admitted viewports/themes/locales/states; no masking critical content to pass |
| V-UX | Intent comprehension, first-use path, meaningful defaults, safe recovery, low decision burden and expert discoverability; actual user observations distinguished from design assumptions |
| V-LIFECYCLE | Deletion/holds/derivatives/cache/backups/provider copies, retention, key/access revocation, restoration anti-resurrection and truthful partial erasure |
| V-OPS | Cold/warm performance, queue fairness/control-plane isolation, bounded telemetry/cardinality, quota/settlement, overload, graceful shutdown, recovery, load/soak and restore under the selected deployment |

The IDs name reusable test families; instantiate concrete cases against every applicable capability/contract. They are not a fixed test count or a substitute for full coverage.

## 24.4 Prescriptive experiments before selecting defaults

**EXP-REUSE — prove ecosystem reuse.** Package a candidate Ghatana renderer/animator/physics or Shared workflow surface; build a minimal consumer with no sibling source or broad product barrel. Run one representative happy, invalid-input and failure/recovery case. Compare effort/limitations with an external candidate only after this experiment. Outcome is reusable as-is, owner extension/extraction required, or rejected fit with evidence.

**EXP-MOVE — behavior-preserving transfer.** Replay the same contract fixtures against the source and target builds. Compare schemas, status/errors, artifacts and privacy/cancellation/finality. Include frozen document worker and existing consumer calls. Preserve negative/unavailable outcomes; do not “fix” baseline semantics unnoticed during the move.

**EXP-QUALITY — qualified processing improvement.** Freeze source corpus, rights, artifact digests, conditions and metrics before tuning. Compare untreated baseline, deterministic enhancement, specialized ML and admitted generative alternatives. Measure fidelity and perceptual quality separately. Record failures, resource/cost and confidence/uncertainty. Choose defaults using the target use case, not cherry-picked attractive outputs.

**EXP-GENERATION — strategy/profile selection.** Compare direct T2V, reference/keyframe I2V and simulation/procedural-guided strategies on the same declared constraints. Vary resolution/fps/duration/resource/precision/offload within model-native support. Separate loading, inference, preprocessing, refinement, render and encode costs. Qualify the exact model/weight/runtime/build. A successful small clip does not qualify long scenes or different GPUs/languages.

**EXP-SIMULATION — model versus appearance.** Compare domain-approved expected measurements and declared numerical tolerance independently from rendered visuals. Test `t_sim`/`t_story`, unit mapping, fixed-step replay and checkpoints. Allow visual LOD differences only when protected model results/fidelity remain within contract. Generative refinement must not overwrite measurement truth.

**EXP-UX — ordinary and expert workflows.** Initial formative protocol: eight representative users spanning creator/editor, integrator and review needs, including relevant accessibility interaction; tasks include upload→improve→compare, create→render, animate/simulate a supplied template, and recover interrupted work. Proposed initial bar: at least seven of eight complete each applicable ordinary task without operator intervention, with no critical misunderstanding of privacy/quality/finality. Record sample limitations; this is formative evidence, not a population-level statistical guarantee. Reduce avoidable choices, not required safety decisions.

**EXP-RESILIENCE — kill at every consequential boundary.** Interrupt before/after durable admission, dispatch marker, worker lease renewal, provider acceptance, output upload, artifact registration, audit/outbox and response acknowledgement. Verify single-authority state, no unsafe replay, bounded orphan cleanup and truthful recovery.

**EXP-LOCAL — private/local usable without cloud.** Disconnect external network, enforce read-only input grants and local budget/entitlement. Verify deterministic operations and qualified local capabilities, predictable expiry/unavailability and no hidden remote calls. Authentication/update/revocation limits must be explained rather than concealed.

## 24.5 Completion measurement

Maintain separate generated counts by definition, migration, runtime implementation, qualification, licensing and live availability. Report the denominator, completed/current count, failed/blocked/stale/not-evaluated count and reason IDs. Do not include simulated evidence in real-provider totals. Do not count leaf capability aliases twice.

“Distance to definition complete” is the set of unsatisfied accepted requirements, missing mappings/contracts, unresolved semantic gaps and failed required reference checks. “Distance to runtime qualification” is specific to a named lane and environment. Overall completion cannot average away a critical privacy, finality or consumer-compatibility failure.

Material changes invalidate only dependent records/observations; an updated scientific model may invalidate simulation results even if UI geometry is unchanged. A changed font can invalidate renders and screenshots without invalidating job-store concurrency tests. A changed rights policy can block artifact reuse without requiring a new image-quality benchmark.

---

# 25. Execution order, unresolved prerequisites and final acceptance

## 25.1 Dependency-ordered execution

1. **Observe and bind:** GOV-001–003 establish source inventory, Ghatana reuse and Tools schema ownership. No new external stack is selected first.
2. **Accept the boundary:** P0-001 and MIG-001–003 establish product ownership, inbound-graduation policy and consumer contracts. P0 remaining requirements proceed in parallel with migration preparation.
3. **Relocate without redesign:** MIG-004–007 prepare/test/switch source ownership using the admitted manifest. Runtime/data movement remains separately authorized.
4. **Complete product meaning:** P0-002–010 fully define all capabilities and invariants, regardless of runtime implementation coverage.
5. **Define representation:** P1-001–006 establish Media language over Shared design contracts.
6. **Specify exact experiences:** P2-001–008 define Web/CLI/API/embedded behavior, actions, state, content, fixtures and traceability.
7. **Realize and inspect:** P3-001–007 build the generic-Explorer Media package, verify it and obtain human visual/accessibility review.
8. **Generate the handoff:** HAND-001–002 reconcile authority and project construction/test work from accepted definition.
9. **Implement qualified slices:** IMP tasks follow their dependency graph. Shared reuse, security and tests accompany each slice. Do not implement every candidate engine in parallel.
10. **Qualify and activate deliberately:** IMP-014–015 establish the selected lane’s evidence; MIG-008 handles any authorized runtime transfer; OPS-001 is a separate activation decision.

This narrative is not a stricter serial order than §23 dependencies. Independent capability documentation and engine investigations may run concurrently under the same accepted boundary. Do not accept downstream material that has unresolved upstream semantic dependencies.

## 25.2 Initial execution gap register

These gaps identify missing execution inputs/observations, not missing planning instructions. Create records with owner, affected artifacts, required decision/evidence, impact and exact blocking scope. New findings extend the register without changing the meaning of old accepted results.

| Gap ID | Missing or unresolved prerequisite | Owning work / stop condition |
|---|---|---|
| GAP-01 | Full reverse-consumer/source inventory across all relevant repositories/environments | MIG-002; blocks source cutover for unassessed required consumers, not Phase0 authoring |
| GAP-02 | Verified public versions/publication/isolated consumption for every selected Ghatana dependency | GOV-002/P0-008; blocks that runtime binding; no guessed package coordinates/version |
| GAP-03 | Owner-approved neutral reuse/extraction of TutorPutor mechanics without core/contracts coupling | GOV-002/IMP-006; blocks unreviewed direct reuse, not specification or a justified alternative |
| GAP-04 | Inbound service-to-product graduation support in actual portfolio policy/schema/guard | MIG-001; blocks recording a false completed transfer |
| GAP-05 | Exact current route/DTO/proto consumer parity, including operation client differences | MIG-003/P2-006; blocks breaking relocation or SDK publication |
| GAP-06 | Complete generated contract-source/overlay and registry ownership transfer | MIG-004; blocks duplicate/manual generated authority |
| GAP-07 | Actual source of `run_t2v_bench.py` and `run_best_path.sh` | MIG-002/IMP-008; blocks code reuse claims based on those scripts; independent pipeline design proceeds |
| GAP-08 | AI Inference public generation/local execution contracts and selected qualified bindings | IMP-007; blocks unsupported generic model execution, not manual/deterministic work |
| GAP-09 | Exact external code/build/weight/font/asset license and security admission | GOV-002/IMP-014; blocks distribution/execution of the affected unapproved component |
| GAP-10 | Real engine/GPU/model/quality benchmark observations for selected profiles | IMP-014; blocks quality/reproducibility/performance claims, not intended capability definition |
| GAP-11 | Actual Tools Explorer support for Media targets and required generic behavior | P3-001; owner extension required if missing; never pretend schema package is the runtime |
| GAP-12 | Current built Explorer/browser/visual/accessibility and human usability reviews | P3-006–007; blocks Phase3 acceptance; document preparation is not that evidence |
| GAP-13 | Real storage/audit/outbox/worker crash/restore/erasure/soak observations and explicit deployment SLO/RPO/RTO | IMP-015; blocks production qualification/activation |
| GAP-14 | Document worker consumer relocation parity and preservation of current qualification/activation state | MIG-003/IMP-013; blocks affected consumer handover |
| GAP-15 | Named owners and authorizations for cross-repository source cutover, runtime transfer and public activation | MIG-006–008/OPS-001; a planning request grants none of these |

At plan delivery: migration is **not executed**; Phase0–3 artifacts/Explorer are **not accepted by this review**; runtime qualification/production activation is **not established**. Existing source may already implement capabilities, but its status is adopted only through a current owner observation with matching scope. The reviewed current Media service contract describes internal preview and prohibits production promotion without required proof [R12].

## 25.3 Final definition of complete

**Ownership:** Products contains the sole Media product source/semantic owner after admitted transfer; Ghatana retains only approved consumer integrations and its generic runtime authorities. No product implementation source is imported into core. Existing supported consumers and frozen worker behavior remain intact.

**Product Truth:** Engineers do not need to invent the meaning of a capability, actor, state, right, quality/fidelity limit, time/unit, dependency, profile, failure or recovery. Every full-scope leaf has disposition.

**Design Language:** Engineers do not need to invent component anatomy, semantic state, trust/finality grammar, timeline/simulation interaction, adaptive layout, accessibility or CLI conventions.

**Complete Experience:** Every intended workflow can be constructed from exact view/action/state/command/content and handoff contracts without reading Explorer implementation for missing rules.

**Explorer:** The intended product can be exercised coherently and deterministically across its required channels/variants, with current structural/behavioral/visual/a11y observations and human review. Simulated runtime results remain simulations.

**Runtime:** Each enabled capability has current public-contract, implementation, safety/privacy, quality, resource, license, deployment and recovery qualification for the claimed profile. A complete catalog or a runnable local demo is insufficient.

**Simplicity:** Ordinary users act on media intent and meaningful outcomes; they do not operate provider/router/queue/physics/codec machinery. Material changes to trust, quality, cost, rights, privacy and finality are visible. Advanced controls are inspectable without creating different semantics.

**Ecosystem-first:** Media reuses the appropriate Ghatana owner before external alternatives. Shared primitives, Tools product-development mechanics, Kernel mechanics, AI Inference, Agents, Action Plane, Event Plane and Data Cloud retain their ownership. Reuse decisions are evidence-backed rather than slogan-driven.

---

# Appendix A. Preservation and reconciliation crosswalk

This table documents where the supplied plan’s sections are retained. It is not a claim that all future implementation is complete. Source assertions corrected by this review are explicitly identified in §1 and the destination sections; they are not silently copied as fact.

| Supplied U1 section | Retained/reconciled destination |
|---|---|
| 1 Purpose | Front matter; §§1,5,18–22 |
| 2 Final product decision | §2 product naming/scope; §13 admitted graduation |
| 3 Ecosystem | §3 ownership/reuse; §17 handoffs |
| 4 Constitution | §4 stable constitution; §§11–12,14 |
| 5 Naming | §2; §10 CLI/operation naming; no gratuitous package/API renames |
| 6 MIG-001–010 | §13 procedure, §23 MIG cards; preserve supported consumers, generated-source owners and document worker |
| 7 Source root | §5; §§18–22 artifact responsibilities |
| 8 Architecture pattern | §7 typed ports, context projections, graph compiler; §15 dependency decision |
| 9 Canonical IRs | §§7–8; existing Ghatana IR mapping and explicit replay/conversion limits |
| 10 All capability families | §6 exhaustive semantic catalog; §20 experiences; §24 verification |
| 11 MediaSynth | §9 strategy/control/continuity/quality pipeline; IMP-007–010 |
| 12 Preservation | §§9.3–9.5,11,20 comparison/review |
| 13 Invisible foundations | §§4,11–12,14; protection is default, not an optional graph node |
| 14 Native AI/ML | §§3,7,9,12.5; local-execution bypass corrected |
| 15 OSS | §15; Appendix B; Ghatana-first precedence and release/build/license separation |
| 16 Hybrid creation | §§6,8–9,17; simulation/procedural plus generation recipes |
| 17 Animation/simulation | §§6.5–6.6,8,17,20–21; TutorPutor reuse and scientific fidelity |
| 18 Simple UX | §14; §§19–21 shell/components/exact experience |
| 19 CLI | §10 command/output/config/exit/signal contract; P2-006/P3-004/IMP-004 |
| 20 Phase0 | §18; P0-001–010 |
| 21 Phase1 | §19; P1-001–006 |
| 22 Phase2 | §20; P2-001–008 |
| 23 Phase3 | §21; P3-001–007 |
| 24 Implementation handoff | §22; HAND-001–002; not an authority phase |
| 25 I-001–018 production sequence | §22 and IMP-001–015/OPS-001; protections included from first slice |
| 26 Testing | §24 cases/experiments; direct/native and Tools evidence parity |
| 27 Target structure | §16; behavior-preserving initial path map in §13 |
| 28 Order | §§23,25; boundary acceptance before cutover, no circular full-product prerequisite |
| 29 Progress | §§2.3,24.5; separate dimensions and immutable material-bound evidence |
| 30 Complete | §25.3 independent ownership/definition/Explorer/runtime meanings |
| 31 Ultimate target | Governing principle, §§4,25.3 |

## A.1 Draft task-reference migration

Existing accepted product requirement IDs are preserved. The original document’s task labels were draft planning records; revised task IDs are qualified by `MEDIA-MASTER-PLAN/`. Do not attach an old task’s completion receipt to a different revised task merely because its short ID matches. Use the mappings below, verify semantic/material equivalence, and retain unaffected proof only within its original claim scope.

| Old draft task reference in U1 | Revised task(s) |
|---|---|
| MIG-001 | MIG-001 |
| MIG-002 | MIG-002, GOV-001 |
| MIG-003, MIG-004 | MIG-004 |
| MIG-005 | MIG-003, MIG-004, P0-008 |
| MIG-006 | MIG-003; preserve legitimate Data Cloud consumer experiences while transferring Media semantics |
| MIG-007 | MIG-005 |
| MIG-008 | MIG-006, MIG-007; runtime transfer separately MIG-008 |
| MIG-009, MIG-010 | MIG-007, HAND-002 |
| P0-001, P0-002, P0-003 | P0-001, P0-002 |
| P0-004, P0-005 | P0-003, P0-005 |
| P0-006 | P0-004 |
| P0-007, P0-008 | P0-004, P0-005 |
| P0-009 | P0-009 |
| P0-010 | P0-007 |
| P0-011 | P0-008, IMP-007 |
| P0-012 | P0-006 |
| P0-013 | GOV-002, P0-008, IMP-014 |
| P0-014 | P0-004, P0-008 |
| P0-015 | P0-006, P0-009 |
| P0-016 | P0-004, P0-005, P0-006 |
| P0-017 | P0-009, P1-003, P2-001 |
| P0-018 | GOV-003, P0-010, P2-008 |
| I-001, I-016 | IMP-001, IMP-002; protections accompany every other slice |
| I-002 | IMP-002 |
| I-003 | IMP-003, IMP-007 |
| I-004 | IMP-003 |
| I-005 | IMP-009 |
| I-006, I-007 | IMP-008, IMP-009 |
| I-008, I-009 | IMP-006 |
| I-010 | IMP-010 |
| I-011, I-012 | IMP-005, IMP-010, IMP-014 |
| I-013 | IMP-004 |
| I-014 | IMP-011 |
| I-015 | IMP-014 |
| I-017, I-018 | IMP-003, IMP-015 |

The original generic four-phase framework [U2] is retained through one authority owner per concept, manifest/currentness/traceability, exact screen/journey/action contracts, independent Phase2, four Explorer modes, realistic content, interaction disposition, deterministic simulation, responsive/a11y/localization, combined visual verification and human review, derived handoff, selective invalidation and honest phase statuses. No fifth source-of-truth phase is introduced.

---

# Appendix B. External candidate inventory — only after the Ghatana reuse gate

**Status of this entire inventory: candidate evaluation, not procurement, license approval or runtime qualification.** The earlier discussion named these components; retain them as options without integrating all of them or asserting their latest release terms. Select exact upstream release/digest and inspect its actual license/transitives/build before admission. Primary-source corrections are identified where checked in this review.

| Candidate(s) | Intended role | Required evaluation/constraint |
|---|---|---|
| OpenCV | CV, geometry, filtering and supported tracking/flow primitives | Reuse existing Media/Ghatana adapters first; qualify exact algorithms, build flags, native distribution and hardware path |
| OpenImageIO | Professional image I/O/processing | Evaluate current format support and transitive codec/format libraries; not a full compositor |
| OpenEXR | HDR/intermediate image representation | Verify chosen release, channels/precision/compression and interoperability; not color-management policy |
| OpenColorIO | Color transforms/configuration | Prefer existing owner integration; qualify exact configuration/LUTs and rendering pipeline rather than an unversioned default |
| MaterialX | Material/look interchange | Supported subset and renderer translation losses; not automatic look identity across engines |
| OpenVDB | Sparse volumetric representation/tools | Official license page identifies MPL-2.0 [W02]; not Apache-2.0 by assumption and not a complete fluid/fire solver |
| Draco | Geometry compression | Validate glTF/asset feature support, quality/error bounds and decode compatibility |
| Assimp | Asset import/conversion | Sandbox imports and report format losses; actual model/texture asset licenses remain independent |
| Three.js, React Three Fiber/Drei, PixiJS, D3, Konva/React Konva | Web scene/2D/data visualization/authoring | Already declared in TutorPutor package [R05]; evaluate reusable Ghatana mechanics first rather than duplicating adapters |
| Rive runtime | Interactive vector animation | Runtime, editor/service terms, asset licenses and supported export features are distinct; no assumption the full authoring tool is open/permissive |
| Lottie-web | Vector animation playback | Renderer feature subset, text/fonts and expressions/interactivity limits; not a universal authoring format |
| Manim | Procedural mathematical/explanatory animation | Prefer existing Ghatana/TutorPutor authoring mechanisms; template or sandbox execution, no unrestricted generated Python |
| Godot | Rich authored 2D/3D animation/interactive rendering | Evaluate one justified engine target; imported scripts/plugins and third-party modules require separate admission |
| Bevy | Rust ECS-oriented rendering/animation | ECS is implementation detail; do not duplicate a product/world schema or mandate a parallel runtime without need |
| Filament | Physically based rendering target | Qualify materials/color/render determinism and compare against existing rendering reuse |
| Box2D, Matter.js | 2D physics | Choose by actual needed numeric behavior, supported platforms, deterministic envelope and existing adapters, not both by default |
| Jolt Physics, PhysX | 3D physics alternatives | Qualified solver/contact/constraint behavior, platform footprint and replay; one chosen adapter per initial need |
| MuJoCo | Articulated/robotics/scientific model execution | Domain model/calibration authority stays external; qualify units, dynamics, integration and supported outputs |
| Taichi | GPU/procedural computation/simulation kernels | Does not supply every validated scientific model; control kernel code execution and numerical/hardware envelope |
| ONNX Runtime, PyTorch | Specialized model execution runtimes | AI-owned public execution or admitted bounded worker; exact runtime/backend/model/weights/licenses and replay limits [W03] |
| Hugging Face Diffusers | Image/video diffusion pipeline implementation | Belongs inside admitted model-execution owner; pipeline-code license does not govern every checkpoint |
| SAM 2 and future segmentation/tracking model candidates | Reference/mask/track inference | Qualify code/checkpoints separately, mask/temporal accuracy, local/remote governance and media-domain failure cases; not guaranteed to segment every object |
| miniaudio | Low-level audio I/O/mixing primitives | Reuse existing audio device/processing bridges; qualify exact platform and realtime constraints |
| libsamplerate | Audio sample-rate conversion | Verify exact bundle license and precision/delay behavior; account for resampling in timing/provenance |
| Opus reference codec | Speech/audio encoding | Exact implementation/codec patent and distribution review; output compatibility separate from code license |
| SVT-AV1 and other admitted AV1 implementations | Video encoding | Exact build, patent/license obligations, profile/hardware/player qualification and performance |
| FFmpeg | Decode/filter/mux/transcode/encode adapter | Controlled exact build; LGPL/GPL/nonfree/external codec choices reviewed [W01]; shell-free invocation and parser sandbox |
| GStreamer | Streaming/media pipeline alternative | Examine existing Ghatana streaming first; plugin licenses differ and the pipeline is not a replacement Media domain authority |
| Blender | Optional external 3D/animation/simulation/render tool | Review GPL/distribution/plugin obligations for exact integration; optional adapter, not a required core API or unrestricted scripting host |
| glTF/GLB | Runtime scene/asset delivery | Format specification and implementations have separate licenses; supported extensions and loss reports required [W07] |
| OpenTimelineIO | Editorial timeline exchange | References media/time/cuts/tracks; does not render or embed media payloads [W08] |
| OpenUSD | Rich scene interchange/composition | Review the exact release/license rather than assuming plain Apache-2.0; native plugins, subset compatibility and deployment footprint |

A permitted component does not certify an algorithm, a whole application or downstream media rights. Fonts, music, voices, textures, model weights, datasets and user assets require their own admission records. Prefer the existing Ghatana supply-chain tooling to generate notices/SBOMs; create owner-targeted gaps when that tooling lacks required fields.

---

# Appendix C. Source evidence and reference register

## C.1 Evidence classes

`U` means supplied source material. `R` means a repository document/source read through the connected GitHub tool during this review; it proves only the observed text/code. `W` means primary public documentation used to verify a narrow technical/standards/license point. Proposed requirements, target structures and task instructions are the review’s design decisions, not claims that these sources already implement them.

Read date is October 4, 2026. Git blob hashes below identify inspected file content, not product truth/currentness. Default branches may change after this observation; execution must resolve current public material and verify relevant compatibility. A generated guide or README is not independent runtime qualification.

## C.2 Supplied materials

- **[U1]** `Ghatana_Media_Consolidated_Phase_0_3_Plan.md`, supplied in the conversation; 3,795 lines. SHA-256 `a55f070fa9dc7ac7352e59c282d4d19c26bcdae96108ff91722f75626a51d87f`. Full document reviewed. Appendix A maps its sections to the revised plan.
- **[U2]** `Pasted text.txt`, Generic Four-Phase Product Source-of-Truth Review & Hardening Prompt; 1,630 lines. SHA-256 `2b41f1e069dd46fdb979b0fbf328d2f1387914ba5984c64cff30f0842cfb1906`. Establishes Phases0–3, source ownership, PLAN_ONLY task detail, Explorer and derived handoff constraints.

## C.3 Inspected repository sources

| Ref | Repository and exact path | Inspected blob / scope | Supported observation |
|---|---|---|---|
| R01 | `samujjwal/ghatana-products:BOUNDARY.md` | `246e00c3815e7f954e04e6071abd6eb83db96ce6`; document | Product portfolio consumes Shared/Tools/Kernel/runtime services; public/network boundaries and no parallel generic authorities |
| R02 | `samujjwal/ghatana:services/media/docs/ARCHITECTURE.md` | `d3bb090de089f92eb5e199e4937f9d1de02de798`; lines1–185 | Current artifact/job/stream/privacy ownership; public API reference; local in-process jobs and synchronous publisher limitations |
| R03 | `samujjwal/ghatana:services/ai-inference/ARCHITECTURE.md` | `07a2667a79f9a124dfd403413722faf157bce510`; document | Generic model execution/routing/quota/governance owner and consumer restrictions |
| R04 | `samujjwal/ghatana-products:products/tutorputor/docs/architecture/specs/SIMULATION_ENGINE.md` | `354a49c1cf8041a20e55f79ea9b422afa4a86043`; lines1–170 | Existing simulation/animation/rendering work; AEF versus legacy USP; fidelity, clocks and reuse constraints |
| R05 | `samujjwal/ghatana-products:products/tutorputor/libs/tutorputor-simulation/package.json` | `398fcfaa6ff26d691559bb8cad31223257ec8777`; package metadata | Public subpaths, dependencies on TutorPutor core/contracts and rendering/collaboration libraries; does not prove publication/portability |
| R06 | `samujjwal/ghatana-shared:platform/java/workflow/README.md` | `2c0229d21678c0c3bab1a0e0938b95f78a740248`; lines1–140 | Neutral command/state workflow mechanics, consumer persistence/effects, reservations/ambiguity; not a delayed worker scheduler |
| R07 | `samujjwal/ghatana-shared:platform/java/messaging/README.md` | `3179c9d86b64a073b26f10975cca7329db6ae593`; document | Canonical envelopes, claim-aware outbox publisher, explicit host cadence/resources and acknowledgement behavior |
| R08 | `samujjwal/ghatana-shared:platform/java/observability/README.md` | `05143be1c3291b9c636ed8fc72f984e13f10627e`; lines1–92 | Bounded diagnostics/cardinality, identity redaction, explicit asynchronous context scope and public telemetry/health interfaces |
| R09 | `samujjwal/ghatana-shared:platform/java/audit/README.md` | `67f837b723908c63cea966663ffb7b7bc0e4ce38`; lines1–73 | Audit event/sink/query/durable-store boundary, pending versus delivered, product policy and integrity limitations |
| R10 | `samujjwal/ghatana-shared:config/design-system-governance.json` | `22ea79f982865a61cbedae9c0ceecd38a00bd203`; lines1–55 | Canonical Shared design capability source, tokens/theme/headless ownership and planned/stable distinction |
| R11 | `samujjwal/ghatana-tools:libs/product-development/experience-specification/README.md` | `664ef0bcb59a5756c889d01d1674d364f4cdda03`; document | Neutral experience shape, public schema/validator and explicit absence of runtime execution/Explorer implementation |
| R12 | `samujjwal/ghatana:services/media/service-contract.yaml` | `6e5a06f7f13ede612b6dc11af6247a1088002e86`; lines1–70 | Generated source/overlay ownership, internal-preview status and qualification/production prohibition language |
| R13 | `samujjwal/ghatana:services/media/libs/audio-video-client/src/operations.ts` | `00e825035902cfee773da7d5783ff98ed2e6c8cb`; lines251–295 | Operation client upload path, idempotency header and part-number validation; needs runtime/facade reconciliation |
| R14 | `samujjwal/ghatana-tools:tools/gtool/README.md` | `9a25c099c1ff23655554c08e00693bd3aea1b798`; lines1–150 | Public catalog/work/development/verification facade and output rules; owning tools retain acceptance/evidence authority |
| R15 | `samujjwal/ghatana:services/media/modules/intelligence/document-intelligence-worker/README.md` | `bf23b66aa35dbbc33d89481435f5e9b9787c730d`; lines1–110 | Frozen Shared extraction boundary, bounded local worker, generation-token cancellation and explicit non-activation/qualification restrictions |
| R16 | `samujjwal/ghatana-products:products/digital-marketing/docs/canonical/12-MARKETING_OPERATING_MODEL.md` | Search excerpt at repository ref `98e1f46c121800138d0775a4fb3290a9991198ec`, J14 | Brand/claim/disclosure/approval product semantics; not proof of a reusable published brand API |
| R17 | `samujjwal/ghatana-products:config/product-extraction-policy.json` | `e6ad691511661d290f6d0ffda4f9c11a54ac9271`; file | Single-authority extraction policy and default product location; inbound graduation guard compatibility still requires verification |
| R18 | `samujjwal/ghatana-kernel:platform-kernel/kernel-lifecycle/CONSUMER_GUIDE.md` | `006512d6d6a8f22d57c662b1edb3478692a8e39c`; lines1–70 | Public lifecycle coordinate/consumer boundary; explicitly generated explanatory guide, not runtime qualification |
| R19 | `samujjwal/ghatana:services/media/README.md` | `acd3f35df459ff92d7abc8041d3571d16fd7760a`; lines1–145 | Documented current `/api/v1` upload/job/stream routes, internal-preview/local limits and capability/readiness composition |

Repository paths are supplied for direct source inspection through the connected repository tools or an authorized checkout. No expiring private download tokens are included.

## C.4 Primary public references

- **[W01] FFmpeg legal/license documentation:** `https://ffmpeg.org/legal.html`. Supports the narrow correction that LGPL/GPL and optional build components matter; not a legal opinion that every planned distribution complies.
- **[W02] OpenVDB license and project role:** `https://www.openvdb.org/license/` and `https://www.openvdb.org/about/`. Official license page identifies MPL-2.0; sparse-volume tooling must not be confused with a complete solver.
- **[W03] PyTorch reproducibility notes:** `https://docs.pytorch.org/docs/stable/notes/randomness.html`. Supports limiting identical-replay claims to specified environments rather than promising cross-release/platform equality. Exact runtime version must be pinned when qualifying.
- **[W04] W3C WCAG 2.2 Recommendation:** `https://www.w3.org/TR/WCAG22/`. Basis for the proposed AA target and complete-process accessibility assessment; importing a UI library does not establish conformance.
- **[W05] OpenTelemetry baggage documentation:** `https://opentelemetry.io/docs/concepts/signals/baggage/`. Baggage propagation and missing built-in integrity justify separating diagnostic context from authorization.
- **[W06] C2PA 2.2 Explainer:** `https://spec.c2pa.org/specifications/specifications/2.2/explainer/Explainer.html`. Selected specification reference for provenance limitations; not a claim that 2.2 is the latest version or that signed provenance establishes content truth.
- **[W07] Khronos glTF:** `https://www.khronos.org/gltf/`. Candidate scene/asset-delivery interchange; not a universal simulation or authoring schema.
- **[W08] OpenTimelineIO documentation:** `https://opentimelineio.readthedocs.io/en/latest/`. Candidate editorial/timeline exchange referencing media; not an encoder/renderer. Pin a released version before selection.

No prior conversational research citation is adopted as blanket proof of “state of the art.” New engine/model claims require primary-source identity and actual capability qualification. References explain the review’s corrections; requirements and measurable outcomes determine implementation acceptance.

---

# Appendix D. Minimal record templates and execution instructions

## D.1 Requirement template

The fields below describe required content. Materialize them through the **actual Tools-owned schema and supported Media extension points**; this illustrative YAML is not asserted to validate against an installed schema unchanged.

```yaml
id: MEDIA-REQ-JOB-UNCERTAINTY
owner: media
owningPhase: 0
statement: A possibly dispatched external operation must not be blindly replayed.
capabilityRef: media.job.reconcile
actorRefs: [media.operator, media.automation-client]
preconditions: [accepted-job, external-dispatch-may-have-occurred]
expectedBehavior: Persist uncertainty and resolve through the provider execution identity.
failureBehavior: Keep outcome unknown when no authoritative answer is available.
forbiddenBehavior: Treating lease expiry or client timeout as proof of non-execution.
acceptanceCaseRefs: [V-UNCERTAIN]
dependencyRefs: [ai-inference-public-contract, shared-workflow]
sourceRefs: [R03, R06]
```

The real `acceptanceCaseRefs` must resolve to concrete instantiated test cases, not just the family label shown here. External owner references require explicit resolution; never fetch or fabricate product facts inside a generic schema validator.

## D.2 Resolved plan receipt content

An admitted execution receipt records specification/version/fingerprint; resolved adapter capabilities and public fingerprints; source artifact versions/digests; typed parameters; runtime/hardware/model/solver/color/font identities relevant to reproducibility; requested/effective profiles; policy/rights/consent decision references with validity; remaining budget/deadline; output contract; authorized effect boundaries; and attempt/reconciliation identities.

Do not include secrets or short-lived signed URLs in durable/public plan exports. A plan receipt authorizes only its declared scope and validity. Re-execution rechecks current policy and capability admission even when the receipt’s semantic inputs remain unchanged.

## D.3 Dependency/owner-gap packet

Every upstream request contains: owner repository/surface; missing public capability; exact consumer use case; current inspected contract; why existing exports fail; proposed smallest contract extension; compatibility impact; expected input/output/error/finality; test fixtures; resource/security/license consequences; and independent tasks Media can continue. Avoid “please improve Shared” or “add simulation support” without a bounded requirement.

For TutorPutor extraction, attach a dependency graph proving which renderer/animator/physics functions depend on learning core and which can be isolated. For AI Inference, attach binary artifact and cancellation/reconciliation cases, not just “add video generation.” For Tools, distinguish declarative experience schemas from executable Explorer loading/rendering and verification.

## D.4 Operator/developer instruction block

Execute only the authorized workstream. Read canonical owner contracts before changing code. Use public Ghatana artifacts/clients and verify their versions. Keep one editable authority. Follow §23 prerequisites; record blockers in the root gap register. Do not change generated projections by hand, widen privacy, invent fake providers, silently downgrade quality, or manufacture test/evidence success. Run focused native tests and reconcile planned/discovered/executed observations. Update owning Phase0–2 when implementation exposes a semantic gap, then regenerate Phase3/handoff. Remove proven obsolete duplication only after consumer/reference reconciliation. Report exact modifications, checks, failures and remaining dependencies separately from release/certification.

**Ultimate target:** one Ghatana-native Media product whose Web, CLI, API and embedded experiences share complete Phase0–3 authority; whose media creation, animation, simulation, understanding, improvement and delivery reuse the appropriate ecosystem capabilities; and whose real execution is governed, bounded, observable, recoverable and honestly qualified.

---

# Appendix E. Document consistency checks

This master document was mechanically checked for balanced Markdown code fences; one task card per registered task; unique task IDs; resolving and acyclic task prerequisites; resolving source-reference IDs; the 32 constitutional IDs; the 26 review findings; and the 15 explicit execution-gap records. The source-section crosswalk preserves all 31 sections of the supplied consolidated plan. No authority-phase heading beyond Phase 0–3 is present.

These are **document consistency checks only**. They do not execute repository code, prove feature implementation, qualify a model/engine, establish a production deployment, replace a human visual/accessibility review or eliminate the possibility of additional findings during execution.
