# Media Design Language

**Authority:** Media PDP-2 reusable design and interface meaning, consuming PDP-0 Product Truth and PDP-1 Domain/Data.
**Development status:** `DEV_COMPLETE` at the recorded source cut; no outstanding PDP-2 authoring tasks. Shared public package admission and independent accessibility/visual certification are separate Build/Delivery concerns.
**Definition population:** 31 component families (28 typed family contracts), 13 templates, 11 layouts, 13 recipes, 42 composition rules and 19 interaction patterns. Source definitions do not imply deployed presentation.
**Predecessor handoff:** PDP-1 canonical domain handoff consumed; this directory extends PDP-1 domain meaning into design and interface grammar without redefining canonical objects, operations, or authority. Shared public package binding and independent visual/accessibility certification remain pending.

This phase defines how Media meaning appears and behaves. It does not add capabilities, change authority, or redefine job, consent, artifact, time, or finality states. The Media-specific records in this directory are the only editable authorities for their stated design decisions. Shared retains the generic token, component primitive, theme, accessibility, and localization contracts.

## Naming and language

The interface starts from an outcome: establish a project, import and verify a media artifact, understand a recording, correct captions, or review a version. New view and action identifiers follow the canonical naming policy in PDP-0 `glossary.yaml`. Readable labels say what the person can do. Legacy `AudioVideo` names survive only in existing code and package boundaries.

## One semantic model across surfaces

Web, terminal, API examples, and embedded results refer to the same Media artifact, processing job, transcript, caption version, rights decision, and effect finality. Terminal output keeps `jobId` and `uploadId` distinct when a verification job refers to a transfer; `verificationStage` describes the current stage and does not establish artifact availability. State and finality remain separate. Responsive layouts and disclosure levels change presentation; they do not change an action's effect or make an unknown outcome safe to retry.

## Visual and interaction principles

- Keep source media, derived transcripts, and registered caption versions visibly distinct.
- Put the next useful action beside its preconditions and current state.
- Show whether timing is aligned, requires review, or is unavailable; never imply that a provider response alone is product acceptance.
- Keep confidence and uncertainty scoped to the observation that produced it.
- Preserve source time and the selected segment when moving between playback, transcript, and caption editing.
- Use Shared semantic tokens and components after the external bindings are verified. These proposals contain no local color values, generic tokens, or copied component implementation.

## Required records

| Record | Owns |
|---|---|
| `media-token-aliases.yaml` | Media semantic aliases map to source-verified Shared public semantic-role exports; released package and CSS consumer binding remain open |
| `typography-layout.yaml` | Reading hierarchy, density, breakpoints, and proposed review viewports |
| `component-contracts.yaml` | 28 Media component-family proposals mapping all 17 master-plan families, with anatomy, hierarchy, states, capability/action bindings, keyboard behavior, responsive behavior, accessibility, localization, and misuse limits |
| `semantic-state-grammar.yaml` | Presentation of PDP-0 state references without copying state machines |
| `action-finality-grammar.yaml` | Confirmation, progress, cancellation, unknown outcomes, and safe recovery language |
| `trust-provenance-grammar.yaml` | Labels for measured, recognized, inferred, generated, and unresolved information |
| `media-editing-grammar.yaml` | Playback, transcript selection, timing edits, and immutable caption revisions |
| `animation-simulation-grammar.yaml` | Timeline and fidelity presentation shared by future animation/simulation views |
| `responsive-adaptive.yaml` | Viewport transformations and information that must remain available |
| `accessibility.yaml` | Keyboard, assistive technology, zoom, reduced motion, and non-drag operation |
| `localization-content.yaml` | Locale-sensitive content, stable machine language, and unsupported-locale behavior |
| `motion.yaml` | Motion purpose, reduced-motion behavior, and animation limits |
| `cli-language.yaml` | Terminal phrasing, progress, errors, and machine-readable parity |

## Current decision state

The canonical seven-gate disposition is `.product-experience/pdp-2-design-interface-system/design-governance.json`. Media owner decisions resolve the style-semantics boundary, semantic alias intent, template catalog rules, and layout hierarchy, plus the 31 exact component definition/reuse dispositions under PXD-047. These decisions do not accept package consumption, Shared component bindings, rendered behavior, viewport conformance, accessibility, or specialist visualization. Shared package binding remains external; conformance and specialist review remain independent; component source classification is owner-defined: three exact observed public contracts and 28 retained contract-only compositions; implementation admission remains NOT_ADMITTED. The nine Media token aliases still use source-observed public Shared semantic-role refs; a released package version, Media CSS adapter, Shared primitive bindings, and Shared owner approval remain unverified. PDP-0 has unresolved semantic and external-owner reviews; the Tools publication/validation binding is also unverified.

The design-conformance checker validates all seven unique gate records and their source-status mirrors, then reports the two still-open external/independent gates without promoting local evidence into external or independent acceptance. It resolves all 47 indexed screen template and layout references to entries in the PDP-2 registries and reports zero unexplained product-source findings; the presentation architecture audit still proves zero admitted screen design chains. GAP-12 records local browser coverage, while independent visual review, screen-reader testing, canonical visual references, and accessibility acceptance remain unverified.

`generated/experience-language.candidate.json` is a schema-valid partial
ExperienceLanguage v1 (`ghatana.experience-language.v1`) candidate and passes
the sibling-source public validator (`@ghatana/experience-language`; installed
`dist` is unavailable). It
maps 3 density profiles, 3 presentation profiles, 18 interaction patterns,
6 recovery patterns, 3 disclosure rules, 4 responsive rules, 8 accessibility
target rules, 6 localization rules, 11 component bindings, 8 state
presentation mappings, and 13 owner-approved GUI recipe identities and
bindings. The catalogs define 13 reusable templates, 11 layouts, and their
exact primary-pattern chains. Five templates and three layouts were added for
multitrack composition, operational readiness, exact record inspection,
workspace settings, and project overview. These reusable source definitions
do not admit any of the 47 screen compositions.
Shared public package binding, implementation verification, all 47 screen-instance
admissions, independent visual/accessibility review, and design conformance
remain pending.

## Authority, dependencies, review, and proof

The canonical source inventory and stable IDs are indexed by
[`../source-manifest.yaml`](../source-manifest.yaml) and
[`../artifact-identities.yaml`](../artifact-identities.yaml). In addition to
the records above, the PDP-2 set includes `design-governance.json`,
`executable-ui-inventory.json`, `executable-ui-inventory.md`,
`gui/layout.yaml`, `gui/templates/catalog.yaml`,
`gui/recipes/catalog.yaml`, `gui/patterns/catalog.yaml`,
`gui/screen-composition-schema.yaml`, `gui/primitives.yaml`,
`gui/reuse-audit.yaml`, `gui/semantic-component-bindings.yaml`,
`gui/style-authority.yaml`, and the API, CLI, SDK, event, and agent-tool
convention records. The recipe-chain source audit is
[`gui/recipe-chain-review.yaml`](gui/recipe-chain-review.yaml).

The current decision and dependency inputs are
[`../acceptance.yaml`](../acceptance.yaml) (`ACCEPT-INPUT-PDP-2`),
[`../authority-map.yaml`](../authority-map.yaml),
[`../traceability.yaml`](../traceability.yaml),
[`../gaps.yaml`](../gaps.yaml),
[`design-governance.json`](design-governance.json), and the PDP-0/PDP-1
sources linked by the registries. Required roles are listed under
`ACCEPT-INPUT-PDP-2`: design-system consumer lead, Media interaction and
animation designers, UX and trust operations designers, accessibility and
localization specialist, CLI/SDK designer and technical writer, and design
authority reviewer. The public Tools schema/validator binding and Shared
package consumer check remain dependencies.

Local proof inputs include
`tests/pdp-2-experience-language-projection.test.mjs`,
`tests/pdp-2-recipe-layout-chains.test.mjs`,
`tests/media-design-conformance.test.mjs`,
`tests/media-presentation-architecture.test.mjs`,
`pnpm check:design-conformance`,
`pnpm check:presentation-architecture`, and
`node ../../scripts/generate-media-phase-projections.mjs --check --strict`.
They establish source/structure results only; the required independent review
and external Shared acceptance have not been performed. Lifecycle
currentness/receipts remain a separate authority and are not generated by
these local checks.

## Recorder/Studio PDP successor extension (new affected surfaces)

The source-authored `recorder-studio-interface.yaml` records the new Recorder/Studio surface-specific semantics at this later proposed source cut. Historical `DEV_COMPLETE` remains attributable to its original source cut; this extension has **not** passed currentness/admission or PDP-3 readmission. The extension reuses existing Media identities and may not create independent project, job, rights or publishing authorities. Its exact affected obligations require native phase validation and successor acceptance before any completion claim.


## Declarative animation, simulation and TutorPutor experience successor

`.product-experience/pdp-2-design-interface-system/animation-simulation-grammar.yaml#declarativeProductionInterface` now binds 61 canonical PDP-0 specializations to the 61 exact PDP-1 case-operation projections and existing GUI, CLI/headless, and embedded surfaces. It reuses the 52 existing Recorder Studio manual-operation kinds, existing design tokens/components and existing animation/simulation screens; no parallel design system or fictitious API-only GUI is introduced. Numerical instruments, typed simulation clocks, scientific-fidelity labels, accessibility and no-privileged-interactive-player semantics are required. The historical PDP-2 development-complete snapshot is source-cut scoped; only native parse, exact cross-phase reference/negative tests, impacted source-current phase verification and qualified review can establish this **successor** as `DEV_COMPLETE`.

---

## Current unified-production successor source / 2026-10-18

Read the [current source-gated plan](../../docs/implementation/MEDIA-UNIFIED-PRODUCTION-CURRENT-PLAN.md), `animation-simulation-grammar.yaml#declarativeProductionInterface`, and `recorder-studio-interface.yaml`. The successor provides 61 exact P0/P1/P2 declarative projections on the **existing** 13 planned Studio workspace keys, 52 typed manual edits, shared tokens/components/layouts and truthful CLI/API-only/embedded modes. Mandatory presentation now explicitly spans voice/ASR/TTS/dubbing/audio mix/caption vs actor label, source-sufficiency/verified-result warnings, keyframes/2D/3D/math/data-bound animation, model/solver/units/tSim probes, uncertainty and separate scientific/visual quality. The GharBatai audience/script/comprehension/approval requirements are authored by its product, displayed/reviewed through admitted generic Media interface semantics only.

**Successor phase status:** design-interface source authored; **native/current-source PDP-2 DEV_COMPLETE not yet established**. Do not create new physical surfaces, claim 13 new routed screens, silently turn narration into product proof, invent a graphical application for a CLI-only system, or allow story scrub to mutate model execution. Run native design conformance, keyboard/numeric text/headless parity, a11y/reduced-motion/locale/mobile/denial tests, then reissue source-current handoff and owner review.


## October 18 declarative production successor — not yet current DEV_COMPLETE

The new Recorder/Animation/Simulation/TutorPutor scope is defined and reconciled through [the unified current-source handoff](../../docs/implementation/MEDIA-UNIFIED-PDP0-3-CURRENT-SOURCE-RECONCILIATION-2026-10-18.md). Its canonical PDP-0 authority is `requirements.yaml#declarativeProductionProfile` (61 additional cases alongside the Recorder's 84); PDP-1 specializes existing typed owner operations in `declarative-production-contracts.yaml`, PDP-2 adds presentation/parity meaning to `animation-simulation-grammar.yaml`, and PDP-3 provides the corresponding `declarative-production-experience.yaml` source overlay. These extensions **do not inherit this page's historical DEV_COMPLETE receipt**. No new accepted phase cell, deployed simulator, native verification result, new physical surface, scientific-model qualification or production film is implied. Preserve the existing accepted earlier-source meaning and re-admit only affected PDP cells in phase order after exact-source checks.
