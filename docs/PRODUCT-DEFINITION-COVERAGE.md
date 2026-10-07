# Product Definition coverage and alignment

This document is a human-readable audit projection of the canonical Media
Product Definition records. The YAML registries under
[.product-experience](../.product-experience/) remain the semantic
authorities; this document does not create a second requirements or phase
ledger.

## Canonical phase coverage

The pasted Generic Four-Phase Product Definition and Complete Experience
Explorer prompt is the completeness checklist. Product semantics are owned by
the applicable PDP records; the migration plan is an execution reference. The
canonical folders use these phase labels:

| Master-prompt authority | Media local source | Coverage status |
| --- | --- | --- |
| PDP-0 Product Truth | pdp-0-product-truth/ truth, goals, actors, requirements, policies, quality, channels, and journeys | Authored proposal; P0-001 boundary slice accepted, P0-010 pending |
| PDP-1 Canonical Domain and Data Model | pdp-1-domain-data/ plus PDP-0 source references | Proposed object, value, relationship, operation, state, event, evidence, provenance, privacy, versioning, offline, interoperability, authority, and decision registries; semantic review pending |
| PDP-2 Design Language and Interface System | pdp-2-design-interface-system/ | Authored Shared bindings, GUI primitive/pattern/layout/template/composition registries, token/state/accessibility/localization, responsive, and CLI/API/event/SDK/tool conventions; owner conformance pending |
| PDP-3 Complete Product Experience | pdp-3-product-experience/ | 47 canonical screen IDs (48 contract files including a job-family specialization), 30 journeys including J-29/J-30, action/state/channel proposals, 27 HTTP operations and 43 gRPC RPCs observed in the current contract inventory; 11 fixture/plan CLI commands versus 12 broader CLI proposal records; SDK, event, tool, and service registries remain proposal-level; owner acceptance pending |
| Experience Explorer projection | explorer/, apps/media-experience-explorer/, and libs/media-experience-simulation/ | Deterministic local projection and verification client; not a fifth semantic phase |

The complete intended surface denominator and per-surface ownership/contract
references are in [surface-registry.yaml](../.product-experience/surface-registry.yaml).
The read-only generated Tool-model candidates are stored under each owning
phase's `generated/` directory. They contain source observations and partial
candidate identities, and currently fail the sibling schemas/public validators;
they are not accepted Product Definition, Experience Language, or Experience
Specification authorities.

## Vision outcome coverage

All ten P0 outcomes are stable IDs in goals-jtbd.yaml. The coverage ledger
links each outcome to its requirement groups and to either a canonical journey
or an explicitly classified supporting view:

| Vision outcome | Requirement trace | Journey/view trace |
| --- | --- | --- |
| media.goal.finished-asset | Project, artifact, job, generation, speech, spatial, animation, edit, sync, composition, color, and audio-mastering groups | J-01, J-04, J-07–J-18, J-24, J-28 |
| media.goal.preserve-source | Project, artifact, job, provenance, enhancement, edit, sync, composition, color, mastering, and quality groups | J-02, J-07, J-08, J-11, J-18, J-26 |
| media.goal.understand-media | Artifact, job, stream, provenance, scene-text, speech, vision, multimodal, audio-analysis, and quality groups | J-02, J-03, J-05, J-06 |
| media.goal.explain-or-demonstrate | Job, simulation, simulation-output, and recipe-template groups | J-09, J-10, J-12–J-15, J-28 |
| media.goal.improve-with-disclosure | Artifact, job, provenance, enhancement, edit, color, mastering, and quality groups | J-07, J-08, J-11, J-15, J-19 |
| media.goal.review-trustworthy-output | Rights and provenance groups | J-03, J-05, J-09, J-16, J-18, J-21, J-22; supporting exact-version view |
| media.goal.deliver-approved-output | Artifact, job, rights, provenance, and delivery groups | J-09, J-16, J-17, J-18, J-22 |
| media.goal.integrate-repeatably | Profile, capability, and health groups | J-24, J-25, J-30; supporting guidance view |
| media.goal.resolve-safely | Project, artifact, job, stream, capability, health, and rights groups | J-01, J-02, J-20, J-23, J-26, J-27, J-29, J-30 |
| media.goal.apply-permitted-settings | Project/settings requirement group | Supporting M-SETTINGS / media.view.review-workspace-settings; no independent master-plan journey |

The same records also retain the 11 jobs-to-be-done, 19 intents, 30 journey
denominator, 38 requirement groups, 462 capability leaves, and 13
non-functional/decision records. The machine-readable ledger is the exact
checkable form of this table.

## Required downstream content

The four phases preserve the following content families from the prompt:

- Product Truth: mission, outcomes, principles, non-goals, actors,
  responsibilities, intents, JTBD, capabilities, requirements, policies,
  authority, security, privacy, safety, trust, governance, accessibility,
  localization, offline/interoperability concerns, journeys, and success
  definitions.
- Canonical domain/data: ontology, entities, value objects, identity, scope,
  lifecycle/state, transitions, operations, events, evidence, provenance,
  permissions, delegation, consent, privacy, retention, versioning, history,
  offline/sync, and interoperability mappings.
- Design/interface: tokens, primitives, components, patterns, layouts,
  typography, color, spacing, motion, interaction/state/action/error grammar,
  accessibility, localization, responsive behavior, CLI/API/event/SDK
  conventions, and provenance language.
- Complete experience: surfaces, navigation, screens, workflows, journeys,
  actions, states, variants, handoffs, API/CLI/SDK/event/service contracts,
  degraded scenarios, fixtures, simulations, and feature reachability.
- Cross-phase/Explorer: source manifest, ownership, stable IDs, currentness,
  traceability, gaps, dependencies, acceptance, verification, implementation
  comparison, source links, deterministic fixtures, and repeatable checks.

## Honest remaining coverage gaps

The ledger deliberately records unresolved reachability instead of inventing
relationships:

- 385 capability leaves have no explicit leaf-level journeyRefs; their family
  requirement and intent/outcome inheritance is recorded, but P0-010 must
  confirm the per-leaf fit.
- 123 proposal actions have no explicit capabilityRefs; their intent, view,
  and component references remain proposal-level until P2 action closure.
- One component family (identity-context-boundary) still lacks a capability
  reference and requires owner review.
- The 28 baseline journey proposals plus explicit J-29/J-30 contracts and all
  47 canonical screen contracts remain source-linked but are not complete
  runtime or owner acceptance evidence.
- Explorer implements local Product/Explore/Specification/Verify modes and
  additional Overview/Truth/Domain/Design System/Experience/Interfaces/
  Journeys/States-Data/Traceability/Dependencies projections. Its local
  package review loads Media source authorities and exercises public Explorer
  mechanics with a scoped deterministic fixture adapter; it does not resolve
  semantic models or establish phase verification. Independent accessibility
  review, lifecycle-owned rendering, and generated currentness remain open.

These are current-state coverage/acceptance gaps, not missing vision ideas.
They are tracked in the canonical gap register and must close through the
owning phase or external owner rather than through a downstream UI shortcut.
