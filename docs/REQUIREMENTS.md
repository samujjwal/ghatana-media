# Media requirements and current-state ledger

The editable Media-specific requirements are maintained under
[`.product-experience/pdp-0-product-truth/requirements.yaml`](../.product-experience/pdp-0-product-truth/requirements.yaml).
This document explains the current implementation and verification boundary;
it is not a replacement requirements registry.

## Current required capabilities

The source tree now has one canonical Product Definition root and source
registries for the applicable GUI, CLI, API, SDK, agent/tool, event, and service
surfaces. These records are proposals unless an acceptance record says
otherwise. The repository currently contains:

- 38 functional requirement groups and 462 PDP-0 capability leaves. Their
  presence and structural links do not establish complete owner-approved
  semantics.
- 28 PDP-2 semantic component contracts with design, action, state,
  accessibility, localization, and prohibited-use fields.
- 47 PDP-3 canonical screen IDs in 48 screen-contract files (including the
  job-family specialization), 30 registered journeys, and 30 journey-contract
  files (28 baseline contracts plus J-29/J-30 extensions).
- A deterministic synthetic simulation/CLI and a local Explorer with Product,
  Explore, Specification, Verify, Tools Review, Overview, and semantic views.
- A generated source manifest and Explorer index. Artifact IDs are explicitly
  pinned in `artifact-identities.yaml`; opaque legacy values that resemble path
  digests are retained unchanged. The manifest generator records explicit
  repository-relative source-path mentions as provenance-only dependency edges;
  these are not resolved semantic dependencies. Lifecycle-generated semantic
  fingerprints/currentness are not bound or present.
- Read-only candidate projections for Product Definition, Experience Language,
  and Experience Specification under their phase directories. The generator
  runs the available Tools JSON Schema contracts and public validators against
  partial candidates and records their blockers. These are not canonical
  phase models, owner-resolved semantics, acceptance, or currentness.
- A local checker for structural completeness and selected cross-phase
  references. It does not evaluate semantic acceptance or production behavior.

The repeatable local proof command is:

```sh
pnpm check:product-experience-local
```

A pass is limited to that checker. It does not prove operation-specific semantics,
expanded PDP-3 screen contracts, stable semantic identity, full machine-interface
coverage, accepted visual composition, or native acceptance.

## Governing four-phase minimum and ordered tasks

The user's **Ghatana Media — Four-Phase Product Definition Hardening Plan** is
the ordered execution and completion checklist. Product meaning is authoritative
only in its owning PDP records and accepted decisions; the migration plan is a
reference, not a competing semantic source. Preserve existing work and reconcile authority
before adding missing semantics or deriving implementation. The target is one
`.product-experience` root with PDP-0 Product Truth, PDP-1 Canonical Domain & Data
Model, PDP-2 Design Language & Interface System, PDP-3 Complete Product
Experience, and Explorer outside phase numbering. The target phase taxonomy is
approved as an authority model; that does not accept the phase content. Any
remaining legacy crosswalk records are unresolved migration inputs, not a
competing taxonomy or acceptance of product semantics.

The complete ordered ledger below retains every prescribed task. These entries
are execution references, not a second semantic registry and not completion
claims. Migrate one semantic family at a time while keeping the
repository valid; do not copy active authorities and retain both generations.

| Wave | Ordered tasks | Required disposition |
| --- | --- | --- |
| 0 — Authority | CROSS-001, CROSS-002, CROSS-003, CROSS-004 | Atomically normalize phases/references; complete manifest metadata and governed artifact identities; register every surface; demote migration plans to provenance/execution reference after extracting unique meaning |
| 1 — Product Truth | PDP0-001, PDP0-002, PDP0-003, PDP0-004 | Self-contained requirements; finish all 462 capability leaves; reconcile OCR with accepted DI boundary; normalize scope/maturity independently of implementation, qualification, availability, and licensing |
| 2 — Canonical semantics | PDP1-001, PDP1-002, PDP1-003, PDP1-004, PDP1-005 | Own objects/value objects/relationships; consequential operations; state machines/transitions; events/evidence/provenance; privacy/version/history/offline/interoperability/authority/decisions |
| 3 — Representation | PDP2-001, PDP2-002, PDP2-003, PDP2-004, PDP2-005 | Verify Shared versions/consumption; register GUI primitives/patterns/layouts/templates/composition; remove unexplained local visual authority; define API and CLI/SDK/event/agent interface languages |
| 4 — Experience | PDP3-001, PDP3-002, PDP3-003, PDP3-004, PDP3-005 | Expand all 47 screens; contract every HTTP/gRPC operation; settle SDK architecture; complete CLI/SDK/event/agent/system-service registries; contract or explicitly disposition every journey, including J-29/J-30 |
| 5 — Explorer | EXP-001, EXP-002, EXP-003, EXP-004, EXP-005, EXP-006, EXP-007 | Bind published Tools contracts; use manifest phase/IDs; implement all semantic modes; render accepted composition for 47 screens; simulate canonical operations; inspect every machine interface; consume lifecycle-generated currentness/fingerprints when the owner binding exists |
| 6 — Reconciliation | VER-001, VER-002, VER-003, VER-004 | Validate four-phase authority/reference/reachability; design provenance; canonical operation/wire/client/agent parity; full visual/accessibility matrix with independent review |
| 7 — Derived implementation | IMP-01, IMP-02, IMP-03, IMP-04, IMP-05 | After owning definitions are accepted: correct OCR adapters, consolidate SDK, align runtime states, prove isolated builds, implement admitted production Web/CLI |

Local cleanup disposition: CLEAN-1 replaced the obsolete API guide with an
authority pointer; CLEAN-2 records the source-specific OpenAPI, route-manifest,
protobuf, and provider-manifest authorities; CLEAN-3 removed the obsolete
implementation summary. Canonical architecture and status are documented in
[README](README.md), [ARCHITECTURE](ARCHITECTURE.md), and the PDP-0
[product-truth overview](../.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md).
CLEAN-4 retired the misleading feature-completeness report; CLEAN-5 inventoried
stale container paths for gated follow-up.
CLEAN-6's ownership decision is recorded under PDP0-003 and the OCR
classification file. The runtime adapter correction and public Document
Intelligence binding remain pending under IMP-01.

Fixed reconciliation baselines are 462 capability leaves, 28 semantic component
contracts, 47 canonical screen contracts plus one job-family specialization file
(48 YAML files), 30 journeys with 28 baseline proposals plus J-29/J-30 extension
contracts, 27 HTTP operations, 43 gRPC RPCs (12/11/10/10), four `av.*` tool
handlers, and 11 planned CLI commands. Preserve these denominators until an
authoritative reconciliation justifies a change. The additional
artifact-verification job-family file does not create a 48th canonical screen;
the CLI fixture registry contains 11 commands, while the broader PDP-3 proposal
registry contains 12 records (including the unbound retry proposal). Keep these
denominators separate until their owner reconciles them.
No screen is proven complete against the expanded PDP-3 contract by the existing
checker. All material states, authority/guards, action consequences, design
composition, entry/exit/handoffs, fixtures, traceability, and verification must be
bound; machine operations need equivalent complete behavior contracts.

Product Definition completion requires one owner per concept, no active old
phase directories or duplicate authorities, no canonical workstation-local
paths, and complete semantic traceability. Lifecycle owns generated currentness
and evidence-backed closure outputs; Media records only their inputs and does
not claim a closure state. The canonical phase directories,
source manifest, surface registry, and primary domain/design/interface/experience
registries are now present locally. The Explorer uses manifest artifact IDs and
exposes Truth/Domain/Design/Experience/Interfaces and the other semantic views;
IDs are pinned in the identity registry, while manifest relations remain
provenance-only. The generated index does not provide lifecycle currentness.
Browser determinism alone does not satisfy pixel-reference or design-quality
acceptance.

## Vision and downstream coverage

The requirements registry contains 38 functional requirement groups, 462
capability leaves, and 13 non-functional/decision records. The local checker
now verifies that every P0 outcome is represented in the journey outcome
coverage ledger and that every functional requirement has a non-empty outcome
trace. The settings/policy outcome is intentionally represented by the
supporting M-SETTINGS view because the master plan does not define it as an
independent end-to-end journey.

The complete mapping is maintained in
[PRODUCT-DEFINITION-COVERAGE.md](PRODUCT-DEFINITION-COVERAGE.md). It records
the master-prompt phase crosswalk, outcome-to-requirement and
outcome-to-journey/view links, all applicable machine-facing surfaces, and
which remaining gaps require owner decisions rather than local inference.

## Current-state gaps

The canonical phase directories, source manifest generator, surface registry,
PDP-1/PDP-2 registries, machine-interface registries, semantic Explorer views,
and local structural validators are now present. They establish local structure
and proposals, not accepted semantics or implementation parity. Remaining
current-state gaps include:

- P0 definition depth and independent review across the 462 capability leaves;
  a record count or required-shape check does not establish owner-approved
  bounds and behavior.
- PDP-1 semantic review and reconciliation of proposed domain/state meaning with
  runtime and external owner contracts.
- PDP-2 verification of Shared package versions and consumption, plus full visual
  provenance and accessibility/localization conformance.
- PDP-3 complete behavioral contracts and parity across all registered machine
  operations and every screen/journey state. The existing structural checks do
  not accept those semantics.
- Stable semantic identity and lifecycle-generated fingerprints/currentness.
  Identity assignments are pinned; content hashes and source-path-mention
  dependency edges are provenance only. Dependency edges do not establish
  semantic relations, and Lifecycle-generated currentness remains absent.

The SDK source still contains competing route families: `MediaOperationClient`
uses `/api/v1/media/*`, `AudioVideoClient` uses `/api/stt/*` and other modality
paths, while the current OpenAPI uses `/api/v1/artifacts`, `/api/v1/jobs`, and
`/api/v1/streams`. A canonical route projection now records the OpenAPI paths
and labels legacy paths as compatibility routes; consumer migration and runtime
parity remain open under PDP3-003. TypeScript types and UI include the canonical
`RETRY_PENDING`, `OUTCOME_UNKNOWN`, and `RECONCILING` states, with `CANCELLING`
and `RETRYING` retained at explicit compatibility boundaries. The STT Java
adapter maps unknown/reconciling states through the sibling status enum while
retaining the Media state in metadata; complete cross-runtime parity still needs
verification. Documentation does not choose an SDK transport model.

Media UI and AI Voice declare Shared packages at `0.1.0-SNAPSHOT`, matching the
inspected Shared package manifests. The Shared token, theme, and design-system
packages pass their packed public-consumer checks. Media's pnpm composite
workspace now resolves Shared source packages locally; frozen installation and
the Explorer dependency-closure build/typecheck pass. A Media UI package also
compiled and packed against nine local Shared SNAPSHOT artifacts, and an
isolated TypeScript/Vite consumer passed public-export checks. The former
`0.1.2` mismatch is corrected. Public registry resolution and immutable release
binding remain open.
For the separate Tools binding, the Media consumer test exercised public
`createExplorer`, Product Definition/Experience validators, and Development
Traceability projection using locally packed Tools artifacts and a
Media-owned ProductExperiencePackage adapter. Load, render, inspect, and dispatch
passed. A dedicated Tools Review route in the Vite client runs that same bridge
and displays its result. The Media frozen workspace install passes, while these
proofs do not verify registry publication or generic Tools hosting of the
existing Product/Explore workflows. GAP-11 remains open for those bindings and
Tools owner acceptance. Lifecycle currentness and receipt generation remain
separate unbound owner workflows.

## Hard blockers requiring human decision or owner evidence

These block their owning acceptance/implementation tasks; they do not prevent a
read-only audit of the now-explicit definition:

- P0-010 independent semantic review and owner appointment for affected domain
  capability and quality decisions.
- Owner-approved source-to-Tools mappings and external reference resolvers for
  Product Definition, Experience Language, and Experience Specification. The
  local candidate generator invokes available public validators and records
  structural blockers; it does not bind a complete phase validator or accept
  those projections. Generic Explorer host integration and separate Lifecycle
  evidence/currentness/receipt bindings also remain open.
- Released Shared design-token/component bindings and independent
  accessibility, localization, visual, and human review.
- Owner-approved API/SDK/event contracts, consumer parity, runtime
  qualification, privacy/erasure/SLO evidence, and supply-chain admission.
- Isolated JVM build proof currently reaches the `ghatana` repository's included
  `services/event-plane/contracts` project and fails on unresolved event-store
  symbols in that Ghatana-owned project: it imports `EventLogStore` and
  `EventStoreTenantScope`, which are absent from the current Shared messaging
  APIs. Media maps the included project to the sibling `ghatana` checkout.
  The Media pnpm composite
  frozen install and Explorer dependency-closure build/typecheck now pass with
  local Shared and Tools sources; public registry resolution and immutable
  release binding remain unverified. The local Tools Review route does not prove
  generic host integration of the Product/Explore workflows or owner acceptance.
  The 2026-10-07 browser audit passed against the regenerated index; it remains
  local evidence and does not replace human visual/accessibility review or
  owner acceptance.
- PDP0-003 / IMP-01: MDI-001 ownership and the local OCR classification are
  recorded. The DI public binding and runtime adapter correction remain pending;
  the `media.ocr` provider adapter still assigns generic models/confidence to
  Media and conflicts with that boundary.
- PDP2-005 / PDP3-004: decide whether the four `av.*` public tool identities are
  compatibility identities or canonicalize to `media.*`; preserve them until
  the owner records the decision and consumer compatibility proof.

The authoritative cross-phase list is
[`gaps.yaml`](../.product-experience/gaps.yaml). Unknown or unapproved work
remains blocked; this file does not convert it into a completion claim.

## Improvement backlog

The prescribed hardening, qualification prerequisites, and visual/accessibility
proof stay required even where they depend on owner evidence. IMP-05 production
Web/CLI work waits for admission of those surfaces. Additional product features
outside the finite governing plan and broader lifecycle/scale/release campaigns
are later backlog, subject to their own authorization and gates.

## Unsupported-by-design behavior

Fixture CLI/Explorer never supply live identity, byte transfer, model/provider
execution, production writes, or acceptance authority. Generic OCR execution and
domain truth belonging to another product must not be invented inside Media.
Archived desktop source is historical and is not an admitted active surface.
