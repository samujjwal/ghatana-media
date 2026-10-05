# Media Design Language

**Authority:** Phase 1 proposal over Phase 0 Product Truth\
**Acceptance:** blocked on independent P0-010 acceptance; no design or accessibility review is recorded\
**Experience contracts prepared here:** all 17 master-plan component families are indexed by 28 family-level proposals; detailed interaction implementation remains selected-lane only

This phase defines how Media meaning appears and behaves. It does not add capabilities, change authority, or redefine job, consent, artifact, time, or finality states. The Media-specific records in this directory are the only editable authorities for their stated design decisions. Shared retains the generic token, component primitive, theme, accessibility, and localization contracts.

## Naming and language

The interface starts from an outcome: establish a project, import and verify a media artifact, understand a recording, correct captions, or review a version. New view and action identifiers follow the canonical naming policy in Phase 0 `glossary.yaml`. Readable labels say what the person can do. Legacy `AudioVideo` names survive only in existing code and package boundaries.

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
| `media-token-aliases.yaml` | Media semantic aliases to Shared token roles; exact token resolution remains open |
| `typography-layout.yaml` | Reading hierarchy, density, breakpoints, and proposed review viewports |
| `component-contracts.yaml` | 28 Media component-family proposals mapping all 17 master-plan families, with anatomy, hierarchy, states, capability/action bindings, keyboard behavior, responsive behavior, accessibility, localization, and misuse limits |
| `semantic-state-grammar.yaml` | Presentation of Phase 0 state references without copying state machines |
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

All records are proposals. The component inventory covers all required families, but several actions remain unbound and the component contracts do not establish runtime implementation. Phase 0 has unresolved semantic and external-owner reviews; the Shared design-system binding and Tools publication/validation binding are also unverified. No viewport, locale, token, WCAG conformance, or visual result is accepted by this document.
