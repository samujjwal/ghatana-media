# Media Product Truth

**Historical definition state:** PDP-0 Product Truth was `DEV_COMPLETE` at its recorded development source cut, with zero remaining PDP authoring tasks. That historical status does not establish current-source completion. Current PDP-0 `DEV_COMPLETE` is determined only by the native source-bound [`pdp-0-phase-dev-status.json`](../../docs/implementation/pdp-0-phase-dev-status.json) for its exact source cut; this page does not assert or replace that record's current result. Independent P0-010 acceptance and qualified specialist reviews remain separate from definition development. PXD-026 is a bounded product-policy decision, not an independent acceptance or runtime qualification.
**Product:** Media (`media`)  
**Target repository:** `samujjwal/ghatana-media`  
**Media product-meaning authority:** `.product-experience` is the single editable authority. `samujjwal/ghatana:services/media` remains a migration/implementation observation and compatibility source until an approved cutover executes; it is not a competing Product Truth authority.

This page is the readable guide to the structured PDP-0 records. The YAML
records own detailed meaning. This summary does not claim implementation,
license admission, technical qualification, runtime availability, migration
cutover, or production readiness.

## Mission and intended outcomes

Media helps people understand, create, restore, enhance, edit, animate,
simulate, synchronize, compose, assess, and deliver governed audio, video,
image, speech, spatial, and time-based work. Users can move from intent to
reviewable output while retaining source material, seeing material changes,
and understanding what is measured, estimated, reconstructed, generated, or
unknown. Media does not claim the domain authority of a scientific,
pedagogical, clinical, rights, or publication owner.

The authored goals record defines these outcome families:

- Finish a useful asset that meets declared intent and constraints.
- Preserve source bytes and accepted revisions through improvement or
  transformation.
- Understand media through observations with applicable time, region,
  uncertainty, and provenance.
- Explain or demonstrate ideas without presenting visual plausibility as
  validated domain truth.
- Improve media with reconstruction and quality tradeoffs disclosed.
- Review an exact version with relevant quality, rights, provenance, and
  approval evidence.
- Deliver an approved output through a currently authorized effect boundary.
- Integrate through stable public contracts and reconcile work truthfully.
- Resolve blocked or degraded work without unsafe replay or hidden policy
  downgrade.

Canonical outcomes, jobs-to-be-done, intents, actors, requirements, and
acceptance consequences are in [`goals-jtbd.yaml`](goals-jtbd.yaml),
[`actors-responsibilities.yaml`](actors-responsibilities.yaml), and
[`requirements.yaml`](requirements.yaml).

## Product boundary

The P0-001 decision establishes Media as an independently versioned Ghatana
product. Until source cutover, the Ghatana monorepo remains canonical. Once an
approved cutover manifest has been admitted and executed, the target repository
becomes the sole editable Media implementation and semantic authority; the
former source paths retain only approved consumer bindings or external-owner
references.

Media owns media-specific artifact, upload, job, stream, speech, vision,
scene-text, consent, privacy, quality, fidelity, and lifecycle meaning. It may
consume admitted platform contracts and call supported platform APIs. Platform
owners keep their generic mechanics and domain authority. Core platform code
must not import Media implementation source or product packages.

Generic OCR and document intelligence are outside Media. The reusable
Document Intelligence service is owned by `ghatana/services/document-intelligence`,
and neutral document/extraction contracts remain Shared-owned. Media may use a
public Document Intelligence contract for media-specific temporal or scene-text
semantics, such as associating recognized regions with frames over time. MIME
type alone does not turn media into a document or a document into a Media
capability. See [MDI-001](../../docs/migration/decisions/MDI-001-document-intelligence-ownership.md).

## Principles and scope

The structured constitution contains the proposed invariant set. Its themes
include preserving source and revision history; explicit units, clocks, and
fidelity; truthful cancellation, retry, and remote finality; current authority
at effect boundaries; bounded resource and cost use; least-data telemetry;
rights-aware and tenant-isolated processing; accessible, intent-first use; and
separate evidence for definition, implementation, licensing, qualification,
and runtime support.

Stable identifiers follow the naming policy in [`glossary.yaml`](glossary.yaml):
new capability, view, action, command, and scenario names express their Media
operation or user intent. Existing public package names and plan-assigned
requirement and journey identifiers remain compatibility or crosswalk
references.

The full finite operation catalog is in [`capabilities.yaml`](capabilities.yaml)
and its [`capability-preservation-crosswalk.yaml`](capability-preservation-crosswalk.yaml).
All listed operations define product scope, not shipped support. Each operation
keeps implementation state, license admission, qualification, and current
availability as separate dispositions. Candidate engines, models, and
interchange adapters remain blocked until the owning decision and evidence are
recorded.

The intended product includes web, HTTP/gRPC API, SDK, CLI, and embedded product
integration surfaces only at the status recorded in
[`applications-channels.yaml`](applications-channels.yaml). Their presence in
the source tree does not imply a supported release channel. Outcomes and
critical non-happy paths are mapped in [`journey-catalog.yaml`](journey-catalog.yaml);
cross-owner calls and unresolved contracts are recorded in
[`handoff-contracts.yaml`](handoff-contracts.yaml).

## Domain, states, authority, and quality

PDP-0 owns product purpose, outcomes, requirements, policy boundaries, and
high-level domain responsibility. It may state product requirements for
temporal/fidelity preservation and lifecycle/finality. PDP-1 owns canonical
domain objects, values and units, relationships, time bases and conversions,
operations, and detailed state/transition/effect semantics. The PDP-0
[`domain-model.yaml`](domain-model.yaml),
[`state-models.yaml`](state-models.yaml), and
[`time-units-fidelity.yaml`](time-units-fidelity.yaml) remain proposed source
material and observed-contract evidence during that handoff; they are not
accepted canonical domain/data records. The phase authority boundary is settled
for task routing by the delegated owner decisions; record-level source
crosswalks, extraction, exact mappings, specialist review, and PDP-1 owner
acceptance remain open. Existing PDP-1 projections still refer to these PDP-0
sources. No unique semantics are silently discarded or claimed relocated by
this wave.

[`policy-authority-model.yaml`](policy-authority-model.yaml) records product
authority and enforcement boundaries. [`dependency-contracts.yaml`](dependency-contracts.yaml)
and [`reuse-decisions.yaml`](reuse-decisions.yaml) bind those semantics to
upstream owners, contracts, availability, fallback, and evidence gaps.
[`profile-semantics.yaml`](profile-semantics.yaml) and
[`quality-policy.yaml`](quality-policy.yaml) define proposed orthogonal
profiles, preservation constraints, measures, abstention, and bounded
optimization. [`content-intent.yaml`](content-intent.yaml) defines synthetic
fixture policy, rights evidence, and unapproved content defaults;
[`qualification-policy.yaml`](qualification-policy.yaml) keeps definition,
implementation, license admission, qualification, and runtime availability
separate.

Non-functional needs and proposed budgets are in
[`nonfunctional-requirements.yaml`](nonfunctional-requirements.yaml). Proposed
targets are not measurements or production SLOs. Environment choices, locale
admission, owner approvals, benchmark calibration, recovery/erasure evidence,
and public artifact publication remain open where marked.

## Normative record completeness and scope

Every normative requirement must state or reference the plan-required fields:
what, why, who, context, preconditions, required behavior, outcome, important
consequences, failure/degraded behavior, authority, acceptance criteria, and
scope status. A statement or source citation alone does not establish the
other fields. Where source material does not identify an owner decision or
criterion, the record must preserve that gap for review instead of inferring a
commitment.

The deterministic scope vocabulary is `CURRENT`, `TARGET`, `DEFERRED`,
`RESEARCH`, `COMPATIBILITY_ONLY`, `NOT_APPLICABLE`, and `OBSOLETE`. Exactly one
scope value describes intended product scope; it is independent of
implementation, qualification, runtime availability, and license admission.
None of these scope values is a synonym for `IMPLEMENTED`, `QUALIFIED`,
`AVAILABLE`, or `LICENSED`. Requirements and capabilities retain their own
canonical records and identifiers; this page does not substitute for their
record-level values.

The current local source check validates the required scope shape on all 38
requirement records and 462 capability leaves; all 30 journey records also
carry their own scope status. These source checks establish structural shape,
not accepted scope semantics or implementation/availability.

## Phase acceptance

Only the P0-001 migration boundary slice is accepted as a PDP-0 input. PXD-026
also records 11 bounded owner-policy dispositions; it does not accept leaf,
requirement, intent, journey, or state mappings. PXD-035 approves six exact
bounded PDP-1 policy projections into PDP-0; it does not accept canonical
records, runtime behavior, or independent P0-010 review. The ProductDefinition
candidate has been regenerated after PXD-035. `requirements`, `userIntents`,
and those six domain-rule projections map exact source references, leaving zero
semantic field projection blockers. Five explicit product non-goals and
four owner-selected business intents map from `goals-jtbd.yaml`; their source-authored
`measuredBy` descriptions now map to four definition-only contracts specifying
metric, unit, denominator, applicability, acceptance criterion, and evidence
method. PXD-048 accepts their exact outcome/capability/profile-axis source trace,
frozen-population rules and percentage calculation definition. Baselines remain
`NOT_EVALUATED` and targets `NOT_SET`; measured populations, calibration and
qualification are not inferred. The broader P0-06 quality/capability crosswalk
and specialist review remain open. The candidate contains
all 19 source intents and
30 journeys with representative initiators selected by PXD-030; all source actor
lists remain intact as collaborators. These owner choices do not grant runtime
permission or execution authority. Final candidate regeneration, installed-package
verification, and P0-010 independent review remain open.

For the current development-only sequence, PDP-1 consumes a stable PDP-0
capability-intent handoff after PDP-0's definitions, references, variants,
negative cases, and development tests are complete. PDP-0 does not wait for
future PDP-1 operation implementations or independent P0-010 acceptance before
that handoff. PDP-2 follows PDP-1 development completion, and PDP-3 follows
PDP-2 development completion, as defined in
[`PDP-0-3-SEQUENTIAL-DEVELOPMENT-COMPLETION-PLAN.md`](../../docs/implementation/PDP-0-3-SEQUENTIAL-DEVELOPMENT-COMPLETION-PLAN.md).
Independent acceptance, Lifecycle receipts, convergence, production
qualification, and release readiness remain separate. Explorer is a projection
outside these phases. Later-phase artifacts and local implementation remain
provisional until their own development definitions are complete.

`generated/product-definition.candidate.json` is a deterministic partial,
read-only projection using `ghatana.product-definition.v1` and the
`@ghatana/product-definition` v1 schema (`0.1.0-SNAPSHOT` source package).
Its sibling-source schema/public-validator pass is structural evidence only;
remaining leaf/migration/quality semantics, installed-package verification, independent
P0-010 review, and Lifecycle currentness remain separate.

## Authority, dependencies, review, and proof

Use [`../authority-map.yaml`](../authority-map.yaml),
[`../acceptance.yaml`](../acceptance.yaml),
[`../traceability.yaml`](../traceability.yaml),
[`../gaps.yaml`](../gaps.yaml), and
[`../source-manifest.yaml`](../source-manifest.yaml) with
[`../artifact-identities.yaml`](../artifact-identities.yaml) to reconstruct
the complete source inventory and stable artifact IDs. The core PDP-0 records
are `capabilities.yaml`, `requirements.yaml`, `goals-jtbd.yaml`,
`journey-catalog.yaml`, `actors-responsibilities.yaml`,
`state-models.yaml`, `domain-model.yaml`, and `policy-authority-model.yaml`;
the other product-truth records cover quality, fidelity, NFRs, dependencies,
privacy, reuse, content, glossary, and qualification.

The active acceptance input is
[`../acceptance.yaml#ACCEPT-INPUT-P0-010`](../acceptance.yaml), which requires
an `independent-product-definition-reviewer`; P0-002 through P0-009 also name
their specialist and accountable owner roles there. P0-010 remains pending.
Current local proof inputs are the generated candidate, the residual reporter
(`../../scripts/report-media-definition-residuals.mjs`),
`pnpm check:product-definition-authority`,
`pnpm check:product-experience-local`, and
`tests/product-definition-authority.test.mjs`. These checks do not generate
Lifecycle receipts or establish independent acceptance.

## Recorder/Studio PDP successor extension (new affected surfaces)

The source-authored `recorder-studio-extension.yaml` records the new Recorder/Studio surface-specific semantics at this later proposed source cut. Historical `DEV_COMPLETE` remains attributable to its original source cut; the source-bound PDP-0 status record determines the affected definition state for each exact source cut. Runtime admission and affected PDP-3 readmission remain separate and are not implied by PDP-0 definition status. The extension reuses existing Media identities and may not create independent project, job, rights or publishing authorities. Its exact affected obligations require native phase validation before any PDP-0 development status claim.


## Declarative production successor (Recorder + Animation + Simulation + TutorPutor)

The original `DEV_COMPLETE` statement above is historical at its recorded source cut and **does not automatically transfer** to the new declarative-production source revision. `.product-experience/pdp-0-product-truth/requirements.yaml#declarativeProductionProfile` is the sole canonical owner of 61 additional specialized acceptance cases (17 Animation, 22 Simulation, 12 TutorPutor, 10 unified) across 39 existing capability leaves. The 12 Recorder coverage audit targets reuse its existing 84-case register, yielding **145 nonduplicated scoped acceptance cases**; all 38 family requirements and 462 capability leaves remain unchanged. These source-authored cases require native semantic/currentness verification and affected-surface source-cut readmission before a successor phase `DEV_COMPLETE` receipt can be issued. A visual demo, generated scene, or fixture replay cannot prove scientific validation or a real product effect. Scientific/model/learner authority remains with TutorPutor; Media owns generic production/presentation adapters.

---

## Current unified-production successor source / 2026-10-18

The [living unified-production handoff](../../docs/implementation/MEDIA-UNIFIED-PRODUCTION-CURRENT-PLAN.md), [full preserved blueprint](../../docs/implementation/references/MEDIA-UNIFIED-DATA-DRIVEN-PRODUCTION-BLUEPRINT-V3-2026-10-17.md), and [501-row PDP-0 disposition crosswalk](../../docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json) supplement this page's historically `DEV_COMPLETE` source cut. The crosswalk records all 501 source IDs individually as `BOUND_EXISTING` (428 original and 73 focused), zero unresolved PDP-0 IDs, and completed coordinator source reconciliation. This is a definition mapping and disposition only: owner approval and independent acceptance remain `NOT_CLAIMED`, and no implementation, runtime availability, scientific qualification, or closure is implied. The 73 focused candidates comprise 12 existing Recorder clauses and 61 source-authored `requirements.yaml#declarativeProductionProfile` clauses (17 animation, 22 model simulation, 12 TutorPutor, 10 unified). They specialize the original 38 requirement families and 462 capability leaves; audit targets and logical Recorder scopes do not create new accepted requirements or deployable packages.

**Successor phase status:** source-authored; current-source PDP-0 `DEV_COMPLETE` is determined only by the native source-bound status record and its exact input fingerprints. This page does not assert or replace that record's result. Preserve the prior-cut status as history. Independent P0-010 review, owner acceptance, and closure remain separate statuses, not development-completion prerequisites. GharBatai's 32 DX tasks are product-owned or public-adapter consumer requirements, not duplicates of the Media requirement register; domain Model IR and learner evidence remain TutorPutor-owned.


## October 18 declarative production successor — source status authority

The new Recorder/Animation/Simulation/TutorPutor scope is defined and reconciled through [the unified current-source handoff](../../docs/implementation/MEDIA-UNIFIED-PDP0-3-CURRENT-SOURCE-RECONCILIATION-2026-10-18.md). Its canonical PDP-0 authority is `requirements.yaml#declarativeProductionProfile` (61 additional cases alongside the Recorder's 84); PDP-1 specializes existing typed owner operations in `declarative-production-contracts.yaml`, PDP-2 adds presentation/parity meaning to `animation-simulation-grammar.yaml`, and PDP-3 provides the corresponding `declarative-production-experience.yaml` source overlay. These extensions **do not inherit this page's historical DEV_COMPLETE receipt**. No new accepted phase cell, deployed simulator, native verification result, new physical surface, scientific-model qualification or production film is implied. Preserve the existing accepted earlier-source meaning and re-admit only affected PDP cells in phase order after exact-source checks.

### Source-audit identity and PDP-0 meaning disposition (2026-10-18)

The [exact input combined audit](../../docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json) is preserved unchanged, including 428 original source IDs and 73 additional original third-pass `AUD-REC3/ANIM3/SIM3/EDU3/CROSS3` IDs with their exact feature/acceptance descriptions. The [source-ID/candidate-case crosswalk](../../docs/implementation/observations/media-attached-third-pass-id-provenance-crosswalk-2026-10-18.json) keeps those original identifiers distinct from the 73 normalized `AUD-FOCUS-*` projections and 61 source-authored cases. In the PDP-0 disposition crosswalk, `AUD-SIM3-009` maps to existing simulation family requirements and the cloth, soft-body, rope, particle, and fluid leaves; `AUD-SIM3-010` maps to the existing agent capability and its reproducibility cases. Both are `BOUND_EXISTING`; neither adds a canonical requirement or admits a solver. Scientific qualification and any qualified domain-owner admission remain unclaimed at their owning downstream gates. The predecessor `DEV_COMPLETE` remains historical; the native source-bound PDP-0 status record governs current phase status for its exact inputs.

The unchanged uploaded blueprint also contributes [40 original planned tasks and 46 experiment definitions](../../docs/implementation/observations/media-unified-source-task-and-experiment-crosswalk-2026-10-18.json). Those **86 original source identifiers** are traceable and separately classified as PDP-0..3 source work or later Build/acceptance work; they do **not** create 86 canonical PDP-0 requirements. Any source-task implication missing real product meaning must be resolved at its owning current PDP phase, beginning with PDP-0, with no premature native `DEV_COMPLETE` promotion.
