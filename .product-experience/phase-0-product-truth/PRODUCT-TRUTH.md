# Media Product Truth

**Definition state:** P0-001 boundary slice accepted; the complete Phase 0 record is a proposal pending reference closure, specialist review, and independent P0-010 acceptance.  
**Product:** Media (`media`)  
**Target repository:** `samujjwal/ghatana-media`  
**Current implementation authority:** `samujjwal/ghatana:services/media` until an approved cutover executes.

This page is the readable guide to the structured Phase 0 records. The YAML
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

Media domain records and versioning boundaries are proposed in
[`domain-model.yaml`](domain-model.yaml). Rational clocks, coordinate and unit
conventions, conversion loss, and reproducibility limits are proposed in
[`time-units-fidelity.yaml`](time-units-fidelity.yaml). The orthogonal job,
attempt, artifact, stream, rights/consent, review, delivery, and quality states
and safe next actions are in [`state-models.yaml`](state-models.yaml).

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

## Phase acceptance

Only the P0-001 migration boundary slice is accepted. P0-002 through P0-009 are
authored or being integrated as proposals. P0-010 must still validate schemas,
IDs, aliases, references, source roles, and complete outcome/capability/state/
authority/failure paths through independent semantic review. Named owner
decisions and immutable public Tools package bindings are also outstanding.
Phase 1 depends on P0-010 acceptance; Phase 2 depends on Phase 1; Phase 3
depends on Phase 2. Later-phase artifacts and local implementation are
provisional work products; none is represented as accepted ahead of its
dependency gates.
