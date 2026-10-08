# Media Product Truth

**Definition state:** Proposal pending source/reference reconciliation, specialist review, and independent P0-010 acceptance. PXD-026 records bounded cross-phase owner-policy decisions; it does not accept this Product Truth, individual records, or any complete PDP phase.
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
capability. See [MDI-001](../../migration/decisions/MDI-001-document-intelligence-ownership.md).

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
requirement, intent, journey, or state mappings. The ProductDefinition
candidate has been regenerated after PXD-030. `requirements` and `userIntents`
now map all exact source references, leaving two semantic field blockers:
`domainRules` and `successMeasures`. Five explicit product non-goals and four
owner-selected business intents map from `goals-jtbd.yaml`; their source-authored
`measuredBy` descriptions now map to deterministic description-only proposal
records and exact business-intent references. No metric, profile applicability,
qualitative acceptance criterion, target, baseline, or qualification is inferred,
so the `successMeasures` blocker and P0-06 remain open. The candidate contains
all 19 source intents and
30 journeys with representative initiators selected by PXD-030; all source actor
lists remain intact as collaborators. These owner choices do not grant runtime
permission or execution authority. Final candidate regeneration, installed-package
verification, and P0-010 independent review remain open.

PDP-1 depends on independent P0-010 acceptance; PDP-2 depends on accepted
PDP-1; PDP-3 depends on accepted PDP-2. Explorer is a projection outside these
phases. Later-phase artifacts and local implementation remain provisional.

`generated/product-definition.candidate.json` is a deterministic partial,
read-only projection using `ghatana.product-definition.v1` and the
`@ghatana/product-definition` v1 schema (`0.1.0-SNAPSHOT` source package).
Its sibling-source schema/public-validator pass is structural evidence only;
the two semantic blockers above, installed-package verification, independent
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
