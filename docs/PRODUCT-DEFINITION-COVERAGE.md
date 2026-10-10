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
| PDP-0 Product Truth | pdp-0-product-truth/ truth, goals, actors, requirements, policies, quality, channels, and journeys | Active sequential development-completion work; channel applicability is owner-defined at the exact-leaf level, while phase exit remains pending |
| PDP-1 Canonical Domain and Data Model | pdp-1-domain-data/ plus PDP-0 source references | Proposed object, value, relationship, operation, state, event, evidence, provenance, privacy, versioning, offline, interoperability, authority, and decision registries; semantic review pending |
| PDP-2 Design Language and Interface System | pdp-2-design-interface-system/ | Authored Shared bindings, GUI primitive/pattern/layout/template/composition registries, token/state/accessibility/localization, responsive, and CLI/API/event/SDK/tool conventions; owner conformance pending |
| PDP-3 Complete Product Experience | pdp-3-product-experience/ | 47 canonical screen IDs (48 contract files including a job-family specialization), 30 journeys including J-29/J-30, action/state/channel proposals, 27 HTTP operations and 43 gRPC RPCs observed in the current contract inventory; 11 fixture/plan CLI commands versus 12 broader CLI proposal records; SDK, event, tool, and service registries remain proposal-level; owner acceptance pending |
| Experience Explorer projection | explorer/, apps/media-experience-explorer/, and libs/media-experience-simulation/ | Deterministic local projection and verification client; not a fifth semantic phase |

The complete intended surface denominator and per-surface ownership/contract
references are in [surface-registry.yaml](../.product-experience/surface-registry.yaml).
The read-only generated Tool-model candidates are stored under each owning
phase's `generated/` directory. The PDP-0 ProductDefinition now contains a
schema-valid, public-validator-valid partial projection of source-backed
actors, outcomes, all 462 capabilities, 38 functional requirements, and 14
NFRs. Its field mapping review explicitly retains omitted or unresolved
business intent, multi-actor intent/journey, policy, domain-rule, trust,
success-measure, ownership, and timestamp decisions. Structural conformance
does not accept Product Truth or close PDP-0. The PDP-2 and PDP-3 candidates
remain blocked by their sibling schemas/public validators; none of these
generated projections is an accepted authority.

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
denominator, 38 requirement groups, 462 capability leaves, and 14 NFRs plus
three open specialist decisions. The historical operation-evidence audit still
contains 383 unresolved rows; that count is retained as evidence history and is
not the current PDP-0 applicability denominator. The machine-readable ledger is
the exact checkable form of this table.

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

## Capability review matrix

These are mandatory review dimensions, not claims that every listed behavior
is implemented. The table points to the Media-owned source that must carry the
requirement or exclusion; the corresponding owner decision remains open unless
the canonical record says otherwise. Technology choices live in
[`reuse-decisions.yaml`](../.product-experience/pdp-0-product-truth/reuse-decisions.yaml).
`SELECTED` or `CONDITIONAL` there records the architectural choice only; it does
not activate a dependency or qualify its release artifact.

| Review dimension | Canonical source | Review focus and current boundary |
| --- | --- | --- |
| Ingestion and source preservation | `pdp-0-product-truth/capabilities.yaml`; `pdp-1-domain-data/domain-objects.yaml`, `operations.yaml`; J-01/J-02 | Upload, resumable transfer, checksums, immutable versions, metadata, quarantine, parser limits, and malicious-media handling; storage/workflow policy stays with Shared. |
| Time and synchronization | `pdp-0-product-truth/time-units-fidelity.yaml`; `pdp-1-domain-data/value-objects.yaml`, `interoperability.yaml` | Rational time, sample/frame clocks, variable frame rate, drift, source/output mappings, and caption timing; OpenTimelineIO is interchange only and Media retains canonical time semantics. |
| Audio workflows | `pdp-0-product-truth/requirements.yaml`, `quality-policy.yaml`; `pdp-2-design-interface-system/component-contracts.yaml` | Waveforms, stems, edits, mixing/mastering, loudness, clipping, spatial audio, assessment, and export; WaveSurfer/libebur128 remain unqualified candidates. |
| Speech workflows | `pdp-0-product-truth/capabilities.yaml`, `policy-authority-model.yaml`; J-03/J-05/J-21/J-22 | ASR, streaming, diarization, alignment, translation, dubbing, voice consent/revocation, language constraints, and provenance; reuse existing STT/TTS modules before considering sherpa-onnx. |
| Video and image | `pdp-0-product-truth/requirements.yaml`, `quality-policy.yaml`; `pdp-1-domain-data/operations.yaml` | Inspection, regions, keyframes, enhancement, restoration, compositing, color, rendering, encoding, packaging, and review; selected libraries and codec profile require exact build, patent, security, and performance review. |
| Animation and spatial | `pdp-2-design-interface-system/animation-simulation-grammar.yaml`; `pdp-1-domain-data/interoperability.yaml`; J-09/J-10/J-28 | Scene hierarchy, units, transforms, timelines, physics, fidelity, versioning, preview, and interchange; TutorPutor extraction needs an isolated neutral contract, while Three.js/glTF Transform and Rapier retain their recorded roles. |
| Generative media | `pdp-0-product-truth/dependency-contracts.yaml`, `qualification-policy.yaml`; `pdp-1-domain-data/authority.yaml` | Intent, references, parameters, provider capability, cost, safety, provenance, comparison, and reproducibility; generic governance routes through AI Inference, while modality semantics remain Media-owned. |
| Quality and scientific truth | `pdp-0-product-truth/quality-policy.yaml`, `nonfunctional-requirements.yaml`; `pdp-1-domain-data/evidence.yaml` | Ground truth, metric domain, abstention, confidence, calibration, thresholds, reference/no-reference scoring, and provenance; a metric score is not universal truth. |
| Rights, safety, and audit | `pdp-0-product-truth/policy-authority-model.yaml`; `pdp-1-domain-data/privacy.yaml`, `provenance.yaml`; `pdp-2-design-interface-system/trust-provenance-grammar.yaml` | Consent, likeness, licensed assets/models, sharing, retention/erasure, export permission, provenance, and revocation; C2PA provenance does not establish rights or truth. |
| Review and collaboration | `pdp-1-domain-data/decisions.yaml`, `versioning.yaml`; J-16/J-18/J-22 | Exact-version review, comments, impact, decision authority, comparison, approval invalidation, handoff, and independently recorded outcomes. |
| Asynchronous jobs and streaming | `pdp-1-domain-data/states.yaml`, `transitions.yaml`, `operations.yaml`, `events.yaml`; J-20/J-23/J-27/J-29 | Job/attempt identity, progress, partial outcomes, cancellation versus stopping observation, reconciliation, idempotency, backpressure, resource bounds, and durability. |
| Offline and reconnect | `pdp-1-domain-data/offline-sync.yaml`, `versioning.yaml`; J-26 | Local drafts, stable identities, conflicts, preservation, stale-version warnings, reconnect, and explicit reconciliation; consequential edits must not silently use last-write-wins. |
| API, SDK, CLI, events, and tools | `pdp-1-domain-data/operations.yaml`, `events.yaml`; `pdp-3-product-experience/api/`, `grpc/`, `sdk/`, `cli/`, `agent-tools/` | Exact operation meaning, errors, versioning, pagination, timeouts, idempotency, cancellation, compatibility, finality, output formats, and events; current bindings remain proposals pending owner adjudication. |
| Accessibility and internationalization | `pdp-2-design-interface-system/accessibility.yaml`, `localization-content.yaml`, `responsive-adaptive.yaml`, `gui/semantic-component-bindings.yaml` | Keyboard, media controls, captions, reduced motion, forced colors, screen readers, large text, RTL, localization, and non-visual editing; human visual/a11y review and the Shared axe-core license boundary remain open. |
| Security and operations | `pdp-0-product-truth/qualification-policy.yaml`, `nonfunctional-requirements.yaml`; `pdp-1-domain-data/privacy.yaml` | Tenant isolation, SSRF, untrusted-parser containment, credentials, quotas/cost, telemetry redaction, artifact/model security, crash recovery, load/soak, and deployment compatibility. |

Each dimension must resolve to accepted capability requirements or a
product-owner-reviewed exclusion. External engine, model, codec, font, fixture,
and provider qualification remains separate from semantic coverage.

## Channel and consumer applicability

The current P0 applicability contract covers all 462 capability leaves against
the 11 channel identities (nine authored channels plus the owner-defined Agent
and Event channels). Each leaf has one definition-scope disposition per
channel. These decisions describe product applicability only: phase-0 channel
admission is pending, execution admission is `NOT_ADMITTED`, implementation is
unknown, and qualification is not evaluated.

Web has a narrower, exact consumer rule. The current owner overlay identifies
77 leaves whose own adjudication links to a journey that proposes Web and to
that journey's proposed views. The other 385 leaves have no owner-linked Web
journey and are explicitly Web-non-applicable in this P0 definition. An
inherited `supportedChannels: web` label, a family sibling, or a convenient
screen does not create a Web consumer. Exact screen/action bindings remain
PDP-3 work.

For API-labelled leaves, `api` means protocol-neutral definition scope. It does
not establish HTTP, gRPC, or SDK equivalence; those exact adapters remain
pending. A capability declared API/CLI-only can therefore remain outside Web
scope without losing its API or CLI definition. Event is modeled as an
observation/notification channel, not a command invocation surface. Archived
desktop is excluded from active scope. Agent scope requires an explicit
automation-agent or product-integration role, followed by an exact binding.
The focused channel and profile applicability tests validate the complete leaf
partition and these non-admission boundaries.

## Honest remaining coverage gaps

The ledger deliberately records unresolved reachability instead of inventing
relationships:

- The historical operation-evidence review retains 383 unresolved rows. This
  historical count does not gate the current exact-leaf channel decisions; the
  P0 channel overlay records Web consumer evidence or an explicit Web
  non-applicability reason for every capability leaf.
- The migration semantic review retains 349 unresolved blocks, including 123
  mixed blocks proposed for decomposition. These are not marked owner-reviewed,
  obsolete, or closed by a structural ProductDefinition projection.
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
