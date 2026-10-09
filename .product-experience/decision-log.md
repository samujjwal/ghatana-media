# Product-experience decision log

This log records product-authority decisions and governance choices. Proposed
semantics remain proposals; migration preparation and file presence do not
constitute runtime or phase acceptance.

## Accepted decisions

### PXD-001 — Accept the migration boundary slice

- **Status:** accepted, limited to P0-001.
- **Authority:** the user's explicit approval to include the minimal boundary
  slice during migration preparation.
- **Scope:** product identity, ownership, named consumers and compatibility,
  and authority-transfer conditions recorded in
  [`pdp-0-product-truth/PRODUCT-TRUTH.md`](./pdp-0-product-truth/PRODUCT-TRUTH.md)
  and [`BOUNDARY.md`](../BOUNDARY.md).
- **Excludes:** full Product Truth acceptance, source cutover, runtime/data
  handover, production deployment, capability qualification, and readiness.
- **Evidence:** [`acceptance.yaml`](./acceptance.yaml), the migration boundary
  record, and the target boundary document.

### PXD-002 — Keep generic Document Intelligence outside Media

- **Status:** accepted ownership overlay.
- **Authority:** the user's supplemental Document Intelligence instruction,
  recorded in [MDI-001](../docs/migration/decisions/MDI-001-document-intelligence-ownership.md).
- **Decision:** Shared owns `@ghatana/documents` and
  `@ghatana/document-extraction`; Ghatana owns the reusable
  `services/document-intelligence` runtime; Media owns media-specific temporal
  and scene-text semantics and may consume the public service API through a
  narrow adapter.
- **Scope note:** This does not add providers, formats, a new OCR API, or
  runtime activation.

### PXD-003 — Approve the canonical four-phase authority model, with comments

- **Status:** approved for the authority model only; not a PDP phase acceptance.
- **Authority:** the user's explicit 2026-10-06 instruction delegated Media
  product-owner review and approval/comment disposition for the supplied
  hardening plan.
- **Approved:** PDP-0 owns Product Truth; PDP-1 owns canonical domain/data
  meaning; PDP-2 owns design and interface systems; PDP-3 owns complete
  product experiences; the Experience Explorer is a projection outside those
  phases. The migration boundary and Document Intelligence ownership remain
  limited to PXD-001/PXD-002.
- **Comments returned:**
  1. PDP-0 scope is not ready for full acceptance: the current local check
     reports 385 unresolved leaf-level journey references, 445 leaves without
     owner-approved operation-specific bounds, and 123 proposal actions still
     needing capability-reachability review. Resolve only from source/owner
     evidence; do not infer numeric bounds or product commitments. The
     malformed `families` sequence in `capabilities.yaml` and corresponding
     requirement indentation are repaired, and the affected files parse with
     local PyYAML. The repository regression remains text-level because the
     pinned Node parser dependency cannot currently be resolved: pnpm receives
     an unauthenticated registry 404 for private `@ghatana/tokens`. Keep the
     parser-backed CI check open until a supported registry/lockfile path is
     available; local parser success is not portable CI evidence.
  2. PDP-1 operation, state, event, evidence, privacy, versioning, and
     interoperability registries must define Media meaning and explicit
     projection status; observed OpenAPI/protobuf/SDK/runtime shapes are not
     semantic acceptance. The initial PDP1-002 preflight reported 133 of 146
     proposal actions without operation references. At the 2026-10-07 owner-
     decision snapshot, PXD-007's 2026-10-06 exact
     partition was 11 single proposed links, one ambiguous link, and 134
     unresolved actions; its nine logical families did not establish
     complete per-operation contracts. PDP3-002 confirms 27 HTTP operation IDs match the OpenAPI and
     runtime route inventories, while all 15 experience route/action mappings
     remain unresolved and no per-operation HTTP contract records exist. Its
     43 gRPC registry entries match the four active proto files, but all 43
     experience bindings remain pending, no per-operation gRPC contracts
     exist, and proposed MultimodalService names conflict with declared RPC
     names. The registry's stale “26 active” count label has since been
     corrected to match the 43-RPC source census, with a regression preserving
     all 43 pending owner bindings; this arithmetic cleanup does not resolve
     wire authority or semantic mappings. The plan's 11
     fixture CLI commands remain distinct from the 12-entry broader proposal
     registry, which adds an unbound job-retry command. SDK inventory counts
     (an earlier 22-ID scan versus 27 current registry entries, including
     apparent parser false positives) remain unreconciled. Four Agent Tool
     handlers and 15 event names lack complete canonical bindings. Keep each
     identity and count source-scoped; resolve mappings with relevant owners
     rather than inferring parity.
  3. PDP-2 GUI and interface registries are proposals. At the time of this
     decision, `libs/audio-video-ui` declared `@ghatana/tokens`,
     `@ghatana/theme`, and `@ghatana/design-system` at `0.1.2`, while the
     inspected Shared source used `0.1.0-SNAPSHOT`; public-registry requests
     for the then-declared version returned 404. Media's active declarations
     have since been normalized to `0.1.0-SNAPSHOT`. The former version drift
     is historical, not the current blocker: lockfile resolution and isolated
     Media consumer verification remain open for the private development
     artifacts. Explorer consumes none of the named Shared packages. Do not
     copy Shared tokens or create a local substitute.
  4. PDP-3's 47 screen proposals (plus one separately indexed job-family
     specialization) and observed machine interfaces are not complete
     contracts merely because they are indexed. PDP3-001 found all 47 have
     surface/template/layout/pattern proposals and state labels, but only
     41/47 have component refs; none has explicit token, domain-object,
     operation, entry/exit, action-consequence, or screen-verification
     contracts. Only one has fixture refs; responsive refs are unresolved
     placeholders, and state labels are not canonical state refs. Resolve
     actions, operations, states, scenarios, surface bindings, journey steps,
     and verification against the plan, preserving the fixed denominator
     unless authoritative reconciliation changes it.
  5. Superseded for artifact identity and display classification only by
     PXD-024: the authored identity registry preserves committed IDs and pins
     added IDs across relocation. This metadata is not semantic authority.
  6. Keep Tools-native schema binding, Lifecycle-owned currentness and receipts, owner acceptance,
     independent P0-010 review, specialist appointments, publication, and
     qualification explicitly pending. Do not generate local substitutes.
  7. PDP2-002/003 are not complete because registries exist. The GUI pattern
     catalog has 13 entries but lacks dedicated rendering, activity/attention,
     and destructive-lifecycle patterns; review/approval, general recovery,
     and unavailable-capability coverage is only partial. Explorer styles.css
     contains 645 hex-color and 1,713 px occurrences without material
     screen-to-token/component/layout/template provenance, and MediaTaskFlow
     still uses local utility color roles and a local state-tone mapping.
     Preserve the Explorer as a projection, document justified exceptions,
     and defer MediaTaskFlow state changes until PDP1-003 mappings and Shared
     package binding are settled.
  8. The first PDP1-001 proposal review returned bounded provenance comments:
     add a source-family crosswalk for the seven observed-only candidates;
     cite a source or explicit proposal basis for each relationship
     cardinality; label the sample-position context constraint as unaccepted
     proposal; and record a reproducible local parse/reference check. These
     items were addressed and narrowly approved by PXD-005 as proposal
     structure/provenance only; this does not constitute PDP-1 semantic
     acceptance.
  9. Rechecking the revised source references found five nonexistent composite
     fragment IDs in proposed relationship records (`MediaProjectVersion`,
     `MediaProject-and-MediaAsset`, `MediaAsset-and-MediaArtifact`,
     `SceneGraph-and-SimulationWorld`, and `AnimationGraph-and-SceneGraph`).
     Those five references were replaced with exact PDP-0 IDs, and the
     documented local reference check now verifies PDP-0 YAML fragments
     against actual keys and record IDs. The independent rerun passed. PXD-005
     records the bounded disposition; proposal cardinalities were not changed
     to fit storage shapes.
  10. PDP3-004 registries are inventories/proposals, not complete product
      experiences: 11 fixture commands are disconnected from production; the
      12-entry broader CLI proposal overlaps but differs; 15 event names lack
      semantic/delivery contracts; four tool handlers lack the required
      per-tool authority/input/result/finality contracts; and 25 service
      implementation entries lack product-to-product consumer contracts.
      Keep production CLI, event transport guarantees, Agent Tool runtime
      authority, consumer acceptance, and service qualification open.
  11. PDP3-005 has 30 journey files and 130 declared steps, but the 14-item
      per-journey contract is not complete. Eight steps lack a view reference;
      no uniform step-level object/state/operation/authority/decision/transition,
      degraded/recovery, requirement, and verification bindings exist. J-29 and
      J-30 remain four string-named steps each with unresolved owner decisions
      and no fixtures. Preserve the 30-journey and 130-step denominators and do
      not infer behavioral proof from local structural checks or Explorer
      proposals.
  12. At the 2026-10-07 owner-decision snapshot, PDP1-002's 2026-10-06
      decision inventory partitioned 146 actions into 11 single
      proposed mappings, one ambiguous mapping, and 134 unresolved actions;
      it then inventoried 27 HTTP IDs, 43 gRPC identities (24 proposed family links,
      19 unresolved), 11 fixture CLI commands, 12 distinct broader CLI
      proposals, 27 SDK registry IDs, four tool handlers, and 15 event names.
      The HTTP, SDK, tool, and event operation bindings remain unresolved; the
      operation-family proposals do not imply accepted semantics or complete
      per-operation mapping.
- **Excludes:** acceptance of PDP-0 through PDP-3 as complete; any Tools or
  Shared owner decision; runtime qualification; source cutover; release or
  production readiness; and IMP-05 Web/CLI implementation.
- **Evidence:** the supplied hardening plan, the current phase overview pages,
  `acceptance.yaml`, `surface-registry.yaml`, `mandatory-surface-closure-matrix.yaml`,
  and the repeatable local product-definition checker.

### PXD-004 — Approve PDP0-004 scope-status normalization, with comments

- **Status:** approved for scope classification only; not full PDP-0 acceptance.
- **Authority:** the user's explicit 2026-10-06 delegation to review and
  disposition the supplied hardening plan as Media product owner.
- **Approved:** use the plan's seven-value `scopeStatus` vocabulary as the
  product-scope axis, separate from implementation, qualification, runtime
  availability, and license admission. The 38 requirements, 38 capability
  families, 462 capability leaves, and 30 journeys are `TARGET` because they
  are included in the supplied target product scope. Compatibility wording in
  an operation does not by itself make it `COMPATIBILITY_ONLY`; seven such
  keyword-derived assignments were corrected using the plan's §6.2 and §6.9
  scope statements.
- **Comments returned:** source YAML parses locally and all 568 record-level
  labels match the approved vocabulary. The repository still lacks portable
  Node parser-backed CI coverage: pnpm cannot resolve private `@ghatana/tokens`
  from the configured unauthenticated registry. Local PyYAML success is not CI
  proof. The 445 unresolved capability bounds, 385 leaf-level journey
  references, 123 action reachability reviews, and one component-family gap
  remain open; this decision does not settle their semantics.
- **Excludes:** full PDP-0 acceptance or P0-010 independent review; PDP-1
  semantic acceptance; implementation, licensing, qualification, availability,
  publication, external owner decisions, source cutover, or release readiness.
- **Evidence:** `acceptance.yaml` entry
  `ACCEPT-INPUT-HARDENING-PDP0-004`, the supplied hardening plan, local parsed
  registry counts, and `GAP-MEDIA-NODE-YAML-PARSER`.

### PXD-005 — Approve PDP1-001 proposal structure and provenance, with comments

- **Status:** approved for source-reconciled proposal structure only; no
  domain semantics or PDP-1 phase acceptance.
- **Authority:** the user's explicit 2026-10-06 delegation to review and
  disposition the supplied hardening plan as Media product owner.
- **Approved:** the PDP1-001 inventory envelope of 37 proposed/observed-only
  domain-object records, 13 value-object records, and 11 proposed
  relationships; the source-family crosswalk for seven observed-only
  candidates; the per-relationship source/proposal basis and explicit
  non-storage-cardinality caveats; the unaccepted/proposed status of the
  sample-position context; and the exact PDP-0 YAML fragment references
  validated by the documented local structural check. The five invalid
  composite fragments found in owner review were corrected to exact source
  IDs. This accepts only the source-reconciliation and proposal-labeling
  structure, not the named objects, values, cardinalities, or domain rules.
- **Comments returned:** runtime Java, TypeScript, OpenAPI, protobuf, and
  persistence remain observations rather than canonical winners. “Not
  applicable” in a source-family crosswalk is not proof of product-level
  absence. Artifact-version identity, transcript ancestry, time/unit/coordinate
  semantics, event/operation mappings, storage guarantees, and all proposed
  object/relationship semantics remain unresolved pending the relevant Media,
  platform, and consumer owners. PyYAML 6.0.3 verification is workstation-local
  structural evidence, not portable CI parsing or semantic acceptance.
- **Excludes:** semantic acceptance of PDP-1 or PDP-0; state, operation, event,
  privacy, versioning, offline, or interoperability decisions; specialist or
  independent P0-010 review; Tools/Shared or external consumer decisions;
  native receipts/currentness, publication, qualification, cutover, or release
  readiness.
- **Evidence:** `ACCEPT-INPUT-HARDENING-PDP1-001`; `DOMAIN-MODEL.md`,
  `domain-objects.yaml`, `value-objects.yaml`, and `relationships.yaml`; the
  documented PyYAML structural/reference check; `pnpm
  test:product-definition-authority` (7/7); `pnpm
  check:product-definition-authority`; `pnpm check:product-experience-local`;
  and `git diff --check`.

### PXD-006 — Normalize acceptance inputs to canonical PDP phases

- **Status:** approved for acceptance-ledger structure only; no phase decision
  or product-semantic acceptance.
- **Authority:** the user's explicit 2026-10-06 delegation to act as Media
  product owner and disposition the supplied four-phase hardening plan.
- **Approved:** phase acceptance inputs must name PDP-0 Product Truth, PDP-1
  Canonical Domain and Data Model, PDP-2 Design Language and Interface System,
  and PDP-3 Complete Product Experience in that order. Preserve the existing
  P0 work-item identifiers; migrate the former P1 design-language record to
  PDP-2 and former P2 experience record to PDP-3 while retaining their old IDs
  only as `legacyId` crosswalk metadata. Add a pending aggregate PDP-1 gate
  whose prerequisite is independent PDP-0/P0-010 acceptance. Move the former
  P3 Explorer record to a separate projection-acceptance collection; Explorer
  is not a PDP phase. Update the acceptance-input schema version and prerequisite
  labels as needed, without changing any human decision status or evidence
  class.
- **Comments returned:** this is a structural migration of the Media-owned
  input ledger only. It does not make any phase accepted, satisfy P0-010, appoint
  specialists, authorize Tools/Shared decisions, generate Lifecycle-owned currentness/receipts,
  publish packages, qualify runtime behavior, or change implementation gates.
  The Tools-owned schema/validator binding remains pending; compatibility is
  preserved locally through explicit legacy-ID metadata and a regression test.
- **Excludes:** all product semantics and phase acceptance; Lifecycle-owned
  admission/currentness/receipts; publication, qualification, source cutover,
  release readiness, and production IMP-05.
- **Evidence:** the plan's canonical phase definitions and Explorer boundary
  (sections 1 and 18); its ordered waves and explicit cleanup invariant to
  eliminate the old phase model from active Product Definition tooling;
  `ACCEPT-INPUT-PDP-1` through `ACCEPT-INPUT-PDP-3`,
  `projectionAcceptanceInputs`, and the focused ledger regression.

### PXD-007 — Approve PDP1-002 operation registry structure, with comments

- **Status:** approved for proposal schema and source-denominator inventory
  only; no operation semantics or PDP-1 phase acceptance.
- **Authority:** the user's explicit 2026-10-06 delegation to act as Media
  product owner and review the supplied hardening plan.
- **Approved:** at the 2026-10-06 decision snapshot, `operations.yaml` contained
  nine distinct logical-operation proposals, each with the plan's 22 required
  contract fields. Source inventory
  and proposal mappings are explicitly separated. The current source
  decision-date denominators are recorded without collapsing scopes: 146 UI actions split
  into 11 single proposed links, one ambiguous link, and 134 unresolved; 27
  HTTP operation IDs; 43 service-qualified gRPC RPCs with 24 proposed family
  links and 19 unresolved identities; 11 synthetic fixture CLI commands plus
  a distinct 12-command broader proposal registry; 27 SDK registry IDs; four
  Agent Tool handlers; and 15 observed event names. Duplicate-key-safe local
  YAML and source-set checks passed. This approves the inventory/proposal
  structure, not any operation boundary, field meaning, or mapping.
- **Decision-date comments returned:** 134 UI action links remained unresolved and
  `media.action.request-transcription` remains ambiguous. All 27 HTTP operation
  identities are inventoried but their logical-operation links remain
  unresolved. The 24 gRPC family links are proposals only; 19 RPC identities
  remain unresolved, and none has owner-approved wire semantics. All SDK
  registry IDs remain unbound; `for`, `if`, and `clearTimeout` remain
  unadjudicated inventory candidates, and the legacy client methods are a
  separate surface. The 11 fixture commands are not a production CLI; the
  broader 12-entry registry's extra retry command is still a proposal. Tool
  handler and event identities do not establish admitted contracts, event
  triggers, delivery/order/replay guarantees, or runtime behavior. Operation
  granularity, actors, authority, contexts, preconditions, effects, affected
  objects, transitions, finality, failure/recovery, idempotency, and evidence
  require domain/consumer/platform owner decisions.
- **Excludes:** semantic acceptance of any operation or projection; full
  mapping of all actions/interfaces; PDP-1 phase acceptance; state/event/privacy
  decisions; external API, protobuf, Shared, Tool, event, storage, or consumer
  owner acceptance; runtime qualification, native receipts/currentness,
  publication, cutover, or release readiness.
- **Evidence:** `ACCEPT-INPUT-HARDENING-PDP1-002`; `operations.yaml`; the
  duplicate-key-safe PyYAML 6.0.3 check of all 22 fields and exact source ID
  sets; `test:product-definition-authority` regression; authority/local checks;
  and `git diff --check`.
- **2026-10-08 source-status update:** `operations.yaml` now contains 14 proposal
  records: nine logical-operation families and five source-specific records.
  Fourteen of 146 UI actions have exact proposed operation refs; zero are
  ambiguous and 132 remain unresolved. The 43-RPC inventory has 17 proposed
  family refs and 26 unresolved identities. This refresh changes inventory
  only; it accepts no operation semantics, mapping, runtime reachability, or
  wire behavior.

### PXD-008 — Approve PDP1-003 state/transition extraction structure, with comments

- **Status:** approved for source-exact proposal inventory only; no state
  meanings, guards, mappings, or PDP-1 phase acceptance.
- **Authority:** the user's explicit 2026-10-06 delegation to act as Media
  product owner and review the supplied hardening plan.
- **Approved:** `states.yaml` preserves all 11 PDP-0 source machine IDs and
  status dimensions, with 75 exact source state spellings; `transitions.yaml`
  preserves 49 ordered transition relations by source machine/index. The
  rights/consent machine remains empty because the cited source enumerates no
  states or transitions. Runtime/API/UI/TypeScript/protobuf spellings are
  inventoried only as observed projections. Proposal-only authority labels,
  unresolved operation/event/permission/effect bindings, and source guards
  not promoted are retained.
- **Comments returned:** `RETRY_PENDING`/`RETRYING` and
  `CANCEL_REQUESTED`/`CANCELLING` remain distinct unresolved source spellings;
  the observed lossy mapping from `CANCELLING` to `RUNNING` is not accepted.
  `OUTCOME_UNKNOWN`, `RECONCILING`, and `PARTIALLY_SUCCEEDED` remain scoped to
  their source machine/projection until the Media and interface owners decide
  otherwise. No React component, TypeScript type, OpenAPI schema, protobuf,
  Java enum, or runtime adapter gains canonical state authority from this
  inventory. Duplicate-key-safe source reconciliation passed locally; that is
  not portable YAML CI, semantic acceptance, or runtime parity evidence.
- **Excludes:** state meanings, legal transitions, guards, terminality, safe
  actions, presentation mappings, operation/event/permission/effect bindings,
  full PDP-1 or PDP-0 acceptance, specialist/P0-010 review, external owner
  decisions, native receipts/currentness, publication, qualification, or
  release readiness.
- **Evidence:** `ACCEPT-INPUT-HARDENING-PDP1-003`; `states.yaml`,
  `transitions.yaml`, and `DOMAIN-MODEL.md`; duplicate-key-safe source
  comparison of 11 machines, 75 ordered state spellings, and 49 transition
  relations; focused authority/local checks and `git diff --check`.

### PXD-009 — Approve active phase-taxonomy normalization, with comments

- **Status:** approved for active phase-meaning and metadata-label alignment
  only; no PDP semantic acceptance or phase acceptance.
- **Authority:** the user's explicit 2026-10-06 delegation to act as Media
  product owner and disposition the supplied four-phase hardening plan.
- **Approved:** active Product Definition labels and owned metadata fields use
  the canonical map: former P0 Product Truth becomes PDP-0; former P1 Design
  Language becomes PDP-2; former P2 Product Experience becomes PDP-3; and
  former P3 Explorer is identified as a projection outside the PDP phases.
  In-repository field references were migrated with focused regressions.
  Stable ART-* artifact IDs, task/work-item IDs, GAP-* IDs, and the
  `phase0-critical-exception` requirement identity remain unchanged. The
  generated manifest was rebuilt from source and the browser audit passed on
  the normalized local projection.
- **Comments returned:** this is terminology/metadata normalization, not a
  decision that any phase's definitions are semantically correct or accepted.
  The browser audit proves local projection/rendering and route assertions
  only; it is not pixel-reference conformance, independent human visual or
  accessibility review, Lifecycle-owned currentness/receipts, or publication. Shared
  package resolution and external owner gates remain pending.
- **Excludes:** changing task/artifact/gap/requirement identities; accepting
  PDP-0 through PDP-3 or Explorer; owner decisions, runtime qualification,
  Lifecycle-owned evidence/currentness, package publication, cutover, or release
  readiness.
- **Evidence:** `ACCEPT-INPUT-HARDENING-PHASE-TAXONOMY-009`; canonical phase
  ledger v2; focused active-label regression; 202 generated manifest records
  and 203 Explorer projection records at the original decision review;
  `pnpm test:experience-browser` (2026-10-07: 29 scenarios, 296 indexed
  artifacts, 47 routes × six viewports, no failed checks); authority/local
  checks; and `git diff --check`.

### PXD-010 — Approve PDP1-004 source inventory structure, with comments

- **Status:** approved for source-reconciled event, evidence, and provenance
  inventory structure only; PDP-1 semantics and phase acceptance remain
  pending.
- **Authority:** the user's explicit 2026-10-06 delegation to act as Media
  product owner and disposition the supplied four-phase hardening plan.
- **Approved:** `events.yaml` distinguishes seven MediaRuntime lifecycle
  publisher call sites and nine source-observed concrete event types from 15
  local TypeScript listener notifications; records source locations, observed
  triggers, aggregate identity/version fields, envelope/wire observations,
  and event/evidence/provenance unknowns without asserting a canonical
  taxonomy or delivery guarantee. Proto examples and test payload strings are
  correctly excluded as lifecycle publication evidence.
- **Comments returned:** the dynamic `media.job.<status>` publisher is
  bounded here to the current `COMPLETED` and `FAILED` assignments. An
  `Idempotency-Key` header, structural metadata sanitizer, HTTP success
  response, or log line does not prove durable deduplication, ordering,
  replay, semantic redaction, evidence receipt, or recovery. Event-specific
  evidence/provenance bindings and compatibility policy remain unresolved;
  F16 therefore stays open. Focused checks pass locally but are not portable
  YAML CI, Event Plane owner approval, runtime parity, or native Tools
  evidence.
- **Excludes:** canonical event names/meanings, producer authority, causal or
  ordering guarantees, retry/replay/retention/deduplication semantics,
  privacy/disclosure policy, event-specific evidence bindings, full PDP-1 or
  PDP-0 acceptance, Event Plane owner decisions, Lifecycle-owned receipts/currentness,
  publication, qualification, or release readiness.
- **Evidence:** `ACCEPT-INPUT-HARDENING-PDP1-004`; `events.yaml`,
  `evidence.yaml`, and `provenance.yaml`; runtime and client source census;
  `pnpm test:product-definition-authority` (14/14),
  `pnpm check:product-definition-authority`,
  `pnpm check:product-experience-local`, and `git diff --check`.

### PXD-011 — Approve PDP1-005 registry structure and source boundaries, with comments

- **Status:** approved for the six-registry source/observation/proposal structure
  only; Media policy semantics and PDP-1 phase acceptance remain pending.
- **Authority:** the user's explicit 2026-10-06 delegation to act as Media
  product owner and disposition the supplied four-phase hardening plan.
- **Approved:** `privacy.yaml`, `versioning.yaml`, `offline-sync.yaml`,
  `interoperability.yaml`, `authority.yaml`, and `decisions.yaml` cover the
  plan's required privacy, consent/revocation, version/history, disconnected
  operation/reconciliation, and cross-product reference dimensions while
  separating source observations from proposals and unknowns. The domain
  model now labels specification/plan/run/artifact-version separation as an
  unaccepted PDP-0 proposal.
- **Comments returned:** job version and lease fencing do not prove durable
  attempt history; startup marks recoverable jobs `FAILED` with
  `RESTART_RECONCILIATION_REQUIRED` and unknown provider outcome, which is not
  provider-outcome reconciliation. A checksum does not establish immutable
  source bytes or canonical version identity, and `sourceArtifactIds` does
  not establish versioned ancestry. PostgreSQL/S3 purge mechanisms do not
  establish all-store, backup, cache, or external-provider erasure. Offline
  queue durability, safe replay, conflict authority, consent-race resolution,
  and cross-product consumer parity remain unresolved. These registries do
  not accept those policies or guarantee runtime behavior.
- **Excludes:** semantic acceptance of privacy, identity, retention, erasure,
  version keys, immutability, attempt history, cancellation finality,
  offline/replay/reconciliation rules, compatibility, or cross-product
  consumers; specialist or independent P0-010 acceptance; external owner
  decisions; Lifecycle-owned currentness/receipts, publication, qualification, or
  release readiness.
- **Evidence:** `ACCEPT-INPUT-HARDENING-PDP1-005`; the six PDP1-005 registries
  and `DOMAIN-MODEL.md`; duplicate-key-safe parsing; source audit of runtime,
  consent, privacy, client, OpenAPI, persistence, and lifecycle records; and
  focused local authority/local checks plus `git diff --check`.

### PXD-012 — Approve per-event evidence/provenance proposal mappings, with comments

- **Status:** approved for source-observation candidate mappings across the
  seven publisher call sites and nine concrete runtime event types only.
- **Authority:** the user's explicit 2026-10-06 delegation to act as Media
  product owner and disposition the supplied four-phase hardening plan.
- **Approved:** `events.yaml`, `evidence.yaml`, and `provenance.yaml` map each
  source-observed lifecycle event to its exact MediaRuntime source location,
  candidate aggregate identity/version, source-domain record, and observed
  provenance candidates. The mappings preserve literal upload/artifact
  version values as non-record versions and retain the local TypeScript
  notifications as a separate population.
- **Comments returned:** these are proposal links to source observations, not
  committed event records, authoritative finality, delivery acknowledgements,
  durable receipts, replay/deduplication evidence, or canonical domain/version
  bindings. `media.job.cancel_requested` is explicitly not cancellation
  finality; terminal event records are not independent quality evidence.
  Event meaning, producer authority, privacy, compatibility, delivery, and
  Event Plane consumer policy remain unresolved. The source-inventory portion
  of F16 is implemented; the broader architecture/event-contract gap remains.
- **Excludes:** event semantic or policy acceptance; Event Plane/runtime
  delivery guarantees; canonical artifact version or ancestry; publication,
  qualification, Lifecycle-owned evidence/currentness, or PDP-1 phase acceptance.
- **Evidence:** `ACCEPT-INPUT-HARDENING-PDP1-004-F16`; the nine event mappings
  in all three registries; focused exact-source regression in
  `tests/product-definition-authority.test.mjs`; duplicate-key-safe parsing;
  and `git diff --check`.

### PXD-013 — Approve PDP2-001 Shared package source inventory, with comments

- **Status:** approved for source inventory and provenance structure only;
  Shared package binding remains blocked.
- **Authority:** the user's explicit 2026-10-06 delegation to act as Media
  product owner and disposition the supplied four-phase hardening plan.
- **Approved:** `media-token-aliases.yaml` records the clean inspected Shared
  revision `495663b2d6b61c270367048cec54db8a06f22d69`, the exact source
  manifest paths and `0.1.0-SNAPSHOT` versions for the ten packages named by
  PDP2-001, and Media's declared `0.1.2` dependencies on tokens, theme, and
  design-system. It distinguishes sibling source availability from immutable
  publication and verified consumer use, and does not copy Shared tokens.
- **Comments returned:** this is not evidence that `0.1.2` is published,
  compatible, installed, or consumed. The inspected snapshot must not replace
  Media's declared dependency. Binding requires authorized immutable package
  publication followed by consumer verification; no compatibility claim is
  accepted here.
- **Excludes:** Shared owner acceptance, publication, package installation,
  consumer compatibility/binding, full PDP-2 acceptance, Lifecycle-owned
  receipts/currentness, qualification, or release readiness.
- **Evidence:** `ACCEPT-INPUT-PDP2-001`; the exact source inventory in
  `media-token-aliases.yaml`; inspected clean Shared HEAD and package
  manifests; and the Media dependency declarations in
  `libs/audio-video-ui/package.json`.
- **Subsequent observation (2026-10-07):** Media's active dependencies now
  match the Shared `0.1.0-SNAPSHOT` packages. `pnpm test:shared-media-consumer`
  passed against locally packed Shared artifacts; normal workspace lockfile
  resolution, immutable release binding, design review, and Shared owner
  acceptance remain open. This does not expand PXD-013's source-inventory-only
  approval.

### PXD-014 — Approve PDP2-002 GUI registry coverage structure, with comments

- **Status:** approved for registry and proposal coverage structure only; GUI
  semantics and PDP-2 remain unaccepted.
- **Authority:** the user's explicit 2026-10-06 delegation to act as Media
  product owner and disposition the supplied four-phase hardening plan.
- **Approved:** the GUI pattern catalog represents every PDP2-002 required
  category, including dedicated review/approval, rendering, activity/attention,
  and destructive-lifecycle proposals. The new standalone proposals are
  catalogued and included in templates; the review-outputs, prepare-render,
  and review-activity screens reference their corresponding patterns and
  resolvable `media.gui.template` IDs. Shared remains owner of generic
  primitives; Media records product-specific composition only.
- **Comments returned:** state labels, actions, and operation references remain
  proposals, not canonical bindings or implementation. The source contracts
  leave review authority, state transitions, delivery/finality, destructive
  effects, and channel behavior unresolved. No artifact-delete action or
  operation is established; `media.action.revoke-authorized-consent` is only a
  proposed reference pending capability-owner approval, and scene removal is
  not artifact deletion. Shared package binding, keyboard/focus, responsive,
  accessibility, localization, and visual verification remain open. Catalog
  wording now avoids asserting job durability, source/caption immutability, or
  immutable-byte guarantees that are not accepted.
- **Excludes:** full PDP-2 acceptance; PDP2-003 visual-authority migration;
  canonical PDP-1 semantics; Shared owner acceptance or package binding;
  accessibility or visual qualification; Lifecycle-owned currentness/receipts,
  publication, production readiness, or release readiness.
- **Evidence:** `ACCEPT-INPUT-PDP2-002`; all 13 required category IDs in
  `gui/patterns/catalog.yaml`; four standalone pattern proposals; template and
  screen references; the focused pattern/template regression; `pnpm test:product-definition-authority`;
  and `pnpm check:product-definition-authority`.

### PXD-015 — Approve PDP2-004 API convention structure, with comments

- **Status:** approved for the prescribed convention-file structure only; no
  API semantics, wire contract, runtime behavior, or PDP-2 phase acceptance.
- **Authority:** the user's explicit 2026-10-06 delegation to act as Media
  product owner and disposition the supplied four-phase hardening plan.
- **Approved:** the fourteen plan-prescribed API files define proposal-level
  conventions for errors, authentication, identifiers, pagination,
  filtering/sorting, idempotency, concurrency, asynchronous operations,
  cancellation, retry/timeouts/unknown outcomes, correlation, compatibility,
  and versioning. Internal convention references are reconciled. `OpenAPI` is
  explicitly a projection of approved rules and operation bindings, not an
  independent source of product semantics.
- **Comments returned:** all rules remain proposals pending API, identity,
  platform, runtime, and relevant domain-owner review. No operation-specific
  wire/domain binding, OpenAPI parity, persistence, idempotency, retry,
  cancellation, authorization, or versioning guarantee is established.
- **Excludes:** API semantic or runtime acceptance; OpenAPI conformance; API,
  identity, or platform owner decisions; full PDP-2 acceptance; Lifecycle-owned
  receipts/currentness, qualification, publication, or release readiness.
- **Evidence:** `ACCEPT-INPUT-PDP2-004`; all fourteen files under `api/`;
  duplicate-key-safe parsing and internal-reference audit; independent
  read-only review; and `pnpm test:product-definition-authority`.

### PXD-016 — Approve PDP2-005 interface convention structure, with comments

- **Status:** approved for proposal structure and source-observation
  inventories only; no production interface or PDP-2 phase acceptance.
- **Authority:** the user's explicit 2026-10-06 delegation to act as Media
  product owner and disposition the supplied four-phase hardening plan.
- **Approved:** the CLI, SDK, Events, and Agent Tool convention files cover
  the four plan-named languages. Each of the four observed Agent Tool handler
  records declares all ten required contract fields without claiming admission
  or complete schemas. Event inventory separates nine observed runtime
  lifecycle event types from fifteen client-local notifications. CLI fixture
  commands remain distinct from an installed production CLI. The SDK/API
  terminal-state mismatch remains explicit and unresolved.
- **Comments returned:** handler identifiers are source observations, not
  canonical admission. Post-dispatch timeout or cancellation races must return
  unknown, not assert non-execution. Production CLI/SDK consumers, event
  taxonomy/owner/transport/delivery/finality, SDK status mapping, Agent Tool
  schemas/capabilities/runtime, and adversarial verification require their
  accountable owners and evidence.
- **Excludes:** production CLI/SDK or Agent Tool admission; canonical event
  semantics or delivery guarantees; runtime qualification; API/CLI/SDK/Event/
  Shared owner decisions; full PDP-2 acceptance; Lifecycle-owned
  receipts/currentness, publication, or release readiness.
- **Evidence:** `ACCEPT-INPUT-PDP2-005`; all four convention files; the
  observed event and handler source inventories; the focused regression;
  duplicate-key-safe parsing/source-reference checks; independent review;
  and `pnpm test:product-definition-authority`.

### PXD-017 — Approve PDP3-001 screen-contract v2 structure, with comments

- **Status:** approved for the required screen-contract structure and source-grounded proposal references only; no PDP-3 screen semantics or behavior are accepted.
- **Authority:** the user's explicit 2026-10-06 delegation to act as Media product owner and disposition the supplied four-phase hardening plan.
- **Approved:** all 47 canonical screens reference `media.screen-contract.v2` and the proposal schema; required surface/template/layout/component/pattern/token/domain/operation/state/entry/exit/action/responsive/fixture/verification fields are present. Existing component/pattern refs and the three exact catalogued templates are candidates, not accepted bindings. Action consequences have null operation/effect refs and explicit unresolved status.
- **Comments returned:** `surfaceId: media.surface.web` remains a candidate because the channel-to-surface mapping is not accepted. No canonical layout IDs are registered; 44 template IDs remain null; token/package, domain, operation, state/transition, entry/exit, fixture, behavior, responsive, visual, keyboard, and accessibility proof remain open. Existing inline anatomy/template/layout fields remain proposal provenance and have not been centralized; the no-screen-local-design-rule target is not fully achieved.
- **Excludes:** full screen or PDP-3 acceptance; PDP-1/PDP-2 semantics; Shared package binding; Web availability; behavior, visual/accessibility, or localization acceptance; Lifecycle-owned receipts/currentness, qualification, publication, or release readiness.
- **Evidence:** `ACCEPT-INPUT-PDP3-001`; the 47 canonical v2 screen contracts; `.product-experience/pdp-3-product-experience/screen-contract-schema.yaml`; the 47-screen regression in `tests/product-definition-authority.test.mjs`; exact template-catalog match count; structural test pass.
- **2026-10-08 source-status update:** a separate bounded Media owner review
  approves 41 exact top-level template/layout links and withholds six
  mismatches with reasons. Nested contract links, per-screen recipe binding,
  screen composition admission, behavior, Shared binding, and phase acceptance
  remain open.

### PXD-018 — Approve PDP3-002 machine-interface source registries, with comments

- **Status:** approved for exact interface inventories and proposal-level protocol records only; no wire or operation semantics are accepted.
- **Approved:** all 27 OpenAPI operationIds match the observed runtime route manifest; all 43 active gRPC RPCs across the four governed proto services have records with directly available message and streaming metadata. OpenAPI and protobuf remain projection/implementation observations. PDP-1 is the intended semantic authority only after its acceptance.
- **Decision-date comments returned:** all 27 HTTP logical-operation bindings and 19 gRPC logical-operation bindings remained unresolved; 24 gRPC source-explicit crosswalks were proposals. Route/proto membership proves neither semantic parity nor auth, state/effect, finality, privacy, idempotency, retry, cancellation, or event guarantees. Owner review found and corrected four unquoted JSON Pointer scalars in `api-registry.yaml`; `#` begins a YAML comment unless the value is quoted.
- **Excludes:** canonical wire-authority selection, PDP-1/PDP-3 semantic acceptance, API/provider owner acceptance, production support, or release readiness.
- **Evidence:** `ACCEPT-INPUT-PDP3-002`; 27 HTTP and 43 gRPC per-operation records; route-manifest identity parity; duplicate-key-safe YAML checks; `node scripts/check-media-contract-parity.mjs`.
- **2026-10-08 source-status update:** the PDP-1 gRPC proposal inventory now
  records 17 family associations and 26 unresolved RPC identities after
  removing seven health/status/metrics associations. This does not change the
  43-RPC protocol inventory, select wire authority, or accept any mapping.

### PXD-019 — Approve PDP3-003 SDK architecture direction, with comments

- **Status:** approved as the owner-selected target architecture proposal and compatibility classification only.
- **Approved:** PDP-1 logical operation → PDP-3 protocol contract → generated or implementation OpenAPI/protobuf wire projections → one generated or thin typed SDK façade. Both existing TypeScript clients and their nonconforming HTTP route families are `LEGACY_COMPATIBILITY`; preserve routes, exports, and behavior pending gates. Active protobuf sources remain observed protocols, not legacy material.
- **Comments returned:** no current client is canonical, route/request/response parity is unverified, and no SDK generator exists. Current clients include routes absent from OpenAPI/runtime registration, including operation retry/result paths. TypeScript/Vitest checks were unavailable because workspace dependencies are not installed; no install was attempted.
- **Excludes:** semantic/wire changes, generated code, consumer migration, API removal, PDP-1/PDP-3 acceptance, or production qualification.
- **Evidence:** `ACCEPT-INPUT-PDP3-003`; `sdk/client-architecture.yaml`; source-level compatibility tags; inspected types, OpenAPI, route manifest, protos, client sources and repository consumer references.

### PXD-020 — Approve PDP3-004 interface registry structure, with comments

- **Status:** approved for registry structure and source-observation inventories only; no production surface is admitted.
- **Approved:** 11 fixture CLI commands remain simulation-only; 27 SDK method records remain observations; nine runtime event types are distinct from 15 local client notifications; four Agent Tool handler records declare the required fields; 25 services are implementation observations.
- **Comments returned:** Agent Tool schema/authority/idempotency/timeout/cancellation/unknown-outcome/evidence details remain null or pending where unavailable. Event taxonomy, delivery, ordering, replay and finality are not established. Production CLI/SDK/Agent Tool consumers and cross-product service owners remain pending.
- **Excludes:** production CLI/SDK/Agent Tool admission, event guarantees, runtime/service qualification, full PDP-3 acceptance, or release readiness.
- **Evidence:** `ACCEPT-INPUT-PDP3-004`; five interface registries; duplicate-key-safe parsing and denominator/field assertions; `pnpm check:product-experience-local`.

### PXD-021 — Approve candidate channel-to-surface crosswalk for reference normalization

- **Status:** approved for candidate identifier normalization only; no channel admission or runtime support is established.
- **Authority:** the user's explicit 2026-10-06 delegation to act as Media product owner and disposition the supplied four-phase hardening plan.
- **Approved:** `surface-registry.yaml#channelSurfaceProposals` maps the nine channel IDs in PDP-0 to candidate surface IDs or, for protocol-neutral `media.channel.api`, an explicit no-direct-surface disposition. The mapping normalizes references only.
- **Comments returned:** concrete transport, product/channel admission, per-operation support, service-level gRPC mapping, integration owner acceptance, publication, deployment, qualification, and runtime availability remain pending. The legacy desktop mapping is historical-only and not active.
- **Excludes:** semantic acceptance of PDP-0/PDP-3, surface support/admission, production behavior, qualification, or release readiness.
- **Evidence:** `ACCEPT-INPUT-PDP3-005-CHANNEL-SURFACE-CROSSWALK`; PDP-0 `applications-channels.yaml`; surface registry; 148 per-step references normalized to candidate surface IDs.

### PXD-022 — Approve PDP3-005 per-step journey structure, with comments

- **Status:** approved for source-grounded per-step contract structure and proposal-reference normalization only; no journey behavior or PDP-3 acceptance.
- **Approved:** all 30 journey contracts and 130 ordered steps are structured with the plan-required surface/object/state/operation/authority/decision/transition/handoff/success/failure/degraded/recovery/postcondition/requirement/verification fields and explicit binding status. J-29 and J-30 preserve their four ordered source step IDs each. Seven exact PDP-1 logical-operation crosswalks are proposals only. A focused regression preserves all denominators and rejects bare string steps and HTTP/gRPC route promotion to canonical operation IDs.
- **Comments returned:** at least 123 canonical operation bindings remain unresolved; object/state/authority/decision/transition/handoff/requirement refs are largely empty; surface refs are candidates, not channel admission; outcomes/recovery/context are often journey-level proposals not allocated per step; degraded behavior/postconditions are incomplete; every verification remains not-run with no evidence.
- **Excludes:** semantic acceptance of PDP-1/PDP-3, full journey behavior, capabilities, wire/runtime parity, accessibility/localization, scenario execution, production channel admission, or release readiness.
- **Evidence:** `ACCEPT-INPUT-PDP3-005`; all 30 journey contracts; 130-step structural regression; duplicate-key-safe YAML validation; 148 candidate surface-reference normalizations.

### PXD-023 — Approve source-specific service contracts and preserve observed Agent Tool IDs, with comments

- **Status:** approved for repository contract disposition and identity preservation only; no external Tools acceptance or production Agent Tool admission.
- **Authority:** the user's explicit 2026-10-06 instruction to review the hardening plan as owner and approve or comment on its proposed changes.
- **Approved:** CLEAN-2 selects source-specific contract authorities rather than restoring an aggregate `service-contract.yaml`: OpenAPI, protobuf, and provider-manifest records remain distinct contract surfaces, while PDP-1 owns product semantics. Historical migration references remain historical. Preserve the four observed `av.*` handler IDs as-is; do not silently rename them to `media.*` or claim they are final canonical Tool IDs.
- **Comments returned:** the Tools Explorer's standalone proof is no longer an open Tools-side gap: `pnpm check:product-dev-explorer-standalone` passed in `ghatana-tools` on 2026-10-06 with the declared flag matching the live proof. A later local packed Media consumer passed Tools validators, package loading, render, inspect, dispatch, and proposal-only trace projection. The Vite client now exposes a dedicated Tools Review route for that bridge, but the route does not establish generic Tools hosting of Product/Explore workflows, registry publication, normal Media workspace lockfile installation, or full browser-host admission. Canonical Agent Tool naming remains subject to the accountable Tools/tool-registry owner.
- **Excludes:** semantic acceptance of PDP-1/PDP-3; aggregate contract generation; Agent Tool renaming or production admission; Media consumer/package publication; Lifecycle-owned Media currentness and receipts, publication, qualification, or release readiness.
- **Evidence:** the supplied plan's CLEAN-2, Agent Tool, and EXP-001 sections; `docs/README.md`, `docs/ARCHITECTURE.md`, `docs/DESIGN.md`, `docs/TESTING.md`, `config/provider-manifest.json`; `.product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml`; `.product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml`; and the read-only `ghatana-tools` standalone check.

### PXD-024 — Approve pinned artifact identity and display-class metadata, with comments

- **Status:** approved for stable identity and classification metadata only; no product semantics, phase acceptance, or native evidence is accepted.
- **Authority:** the user's explicit 2026-10-06 instruction to review the hardening plan as owner and approve or comment on its proposed changes.
- **Approved:** `.product-experience/artifact-identities.yaml` is the authored source for artifact IDs and the six allowed display-authority classes. The 206 IDs already committed at the reviewed base are preserved exactly; the 72 added identities are pinned literals. Relocation changes path metadata only. The generator validates class membership, rejects malformed/duplicate/unknown registry fields, checks projected-ID collision, and emits deterministic manifest/index projections.
- **Comments returned:** 60 preserved legacy IDs have the historical path-digest shape; they are retained as compatibility literals, are never recomputed, and their shape is not proof of path-independent origin. The 72 added values are explicit pinned IDs, not semantic authority. The local checker confirms inventory and structural consistency only.
- **Excludes:** semantic identity of product concepts; PDP acceptance; native currentness, receipts, owner acceptance outside this bounded metadata decision, qualification, or publication.
- **Evidence:** `tests/media-explorer-manifest-authority.test.mjs` (8 focused tests); `pnpm check:product-definition-authority`; `pnpm check:product-experience-local`; two byte-identical generator runs; and exact preservation of all 206 pre-existing IDs.

### PXD-025 — Approve minimum touch hit areas for synthetic Explorer seek controls, with comments

- **Status:** approved for local Explorer accessibility affordance only; no PDP-2 acceptance or production UI design authority.
- **Authority:** the user's explicit 2026-10-06 instruction to review the hardening plan as owner and approve or comment on its proposed changes.
- **Approved:** the synthetic Explorer source-position range and timestamp seek buttons may receive a minimum 24 CSS-pixel hit area while preserving their existing action semantics and visible track/label content.
- **Comments returned:** the approval is limited to the local Explorer projection and is grounded in the post-normalization browser audit's measured 280×10px enabled range and two approximately 25×9px enabled seek buttons. It does not establish conformance with Shared tokens, accepted PDP-2 composition, or production Media surfaces; those gates remain open.
- **Excludes:** changing the action contract or reducer semantics; product Web/CLI implementation; Shared package substitution; semantic PDP-2/PDP-3 acceptance; human visual/accessibility approval; Lifecycle-owned currentness or receipts.
- **Evidence:** the 2026-10-07 `pnpm test:experience-browser` report, which exercised 296 indexed artifacts and 282 route/viewport observations and isolated the three undersized controls after excluding hidden checkbox implementation inputs and resetting focus to a clean viewport.

### PXD-026 — Accept bounded Media owner semantic policies and execution criteria

- **Status:** delegated product-owner approval for the bounded policy decisions in MEDIA-OWNER-2026-10-07. Not full PDP phase acceptance.
- **Authority:** the user's explicit October 7, 2026 request to review, comment, approve, and resolve owner-selectable decisions.
- **Approved:** canonical four-phase source-of-truth authority (not a production deployment gate); source- and channel-aware capability disposition; migration normative-content decomposition; the distinct job/attempt/delivery state identity; non-equivalence of ACCEPTED/QUEUED, RETRYING/RETRY_PENDING and legacy CANCELLING/canonical cancellation; explicit output, partial-success and cancellation finality; preserved unknown-outcome; typed operation/transport classifications; the public MediaProductRenderer parity target; candidate-only third-party admission; and the Lifecycle input-ready transition policy.
- **Comments returned:** the prior 50 parity findings require identity-level reconciliation; 19/17/19 candidate schema-field mapping blockers remain semantic or validator gaps; the seven design authority/review gates are not waived; 47 candidate routes do not become production screens; missing installed-artifact, provider, review, licensing, proof, observer, oracle and owner-domain crosswalks remain real work.
- **Critical scoping:** one delegated product-owner decision can authorize a rule and its own semantic meaning, but does not create retroactive per-record mapping acceptance, independent P0-010 or specialist findings, license admission, vendor/Shared/Tools/Lifecycle owner consent, or evidence/currentness/closure.
- **Implementation direction:** use requirement-scoped obligations and admitted independent proof; make the Lifecycle preflight transition-capable rather than hardcoding permanent BLOCKED; validate machine and browser representation through actual public exports and typed ports.
- **Evidence:** [2026-10-07 owner decision and resolution](./reviews/2026-10-07-owner-decision-and-resolution.md); [state adjudication](./pdp-1-domain-data/state-adjudication.yaml); `ACCEPT-INPUT-MEDIA-OWNER-20261007`; `scripts/lib/media-closure-preflight.mjs`.
- **Excludes:** PDP phase CLOSED/CURRENT/READY statuses, production deployments, release certification, model or codec activation, independent accessibility or visual review.
- **Normalized dispositions:** the bounded policy scopes above are recorded individually as `ACCEPTED` under [`acceptance.yaml#ACCEPT-INPUT-MEDIA-OWNER-20261007.normalizedPolicyDispositions`](./acceptance.yaml). These dispositions do not accept leaf-level mappings, independent findings, external package consent, or phase status.
- **Separate bounded decision:** PXD-027 has its own owner-policy input, `ACCEPT-INPUT-MEDIA-OWNER-GATES-20261007`. It adds source selections and mapping criteria without accepting per-record mappings, independent reviews, external package consent, or any PDP phase.

### PXD-027 — Approve bounded semantic-source decisions for remaining PDP gates, with explicit independent-proof conditions

- **Status:** delegated Media product-owner policy approval **only**; all four PDP phase-acceptance states remain open.
- **Authority:** the user's October 7, 2026 request to resolve remaining owner decisions rather than seeking repeated approvals.
- **Approved PDP-0:** explicit Media non-goals, business intents and ownership boundaries in `pdp-0-product-truth/goals-jtbd.yaml`; exact leaf applicability types, independent actor/priority mapping criteria, source-preserving migration block decomposition and no invented numeric quality targets.
- **Approved PDP-1:** the exhaustive TypeScript source-role catalog with explicit non-admission for unqualified specialized operations, and the rule that all canonical operation *identities* require a verified exact PDP-1 semantic binding, not merely classification as a family.
- **Approved PDP-2:** simple→minimal, guided→standard, expert→rich Tools density enum selections; three presentation profiles; explicit safe progressive disclosure; **WCAG 2.2 AA as the normative target** (not certification); six recovery patterns distinguishing observer-only automatic follow-up from manually authorized effects; eight Media-defined GUI composition recipe identities bound to exact templates/patterns (not Shared publication/implementation admission).
- **Approved PDP-3 search/inspection semantics:** Media owns three permission-scoped project/artifact/job search queries and five specification/authority/evidence/trace/simulation inspector identities in `pdp-3-product-experience/search-inspection-contracts.yaml`, distinct from Tools' generic Explorer host. Their schema projections can be derived; none implies a production endpoint or accessible GUI implementation.
- **Approved PDP-3 policy:** applicable 47 GUI contracts, 30 journeys, CLI/API/SDK/event/Agent experiences must be complete and independently falsifiable; no real production Web host is required to accept definition-only semantics, while publication/release/adoption remains independently qualified. Do not accept bare proposal routes as implemented screens.
- **Approved Lifecycle strategy:** all 318 source-anchored obligations must receive actual admitted proof-case memberships, owner-qualified observers, executable oracles, current source dependencies and evidence-producer bindings. Use the physical Lifecycle Evidence Generator owner, preserving its observed legacy `ghatana-tools.evidence-generator` provider identity until owner-qualified registry migration. Empty binding or `UNLICENSED` package is not a release qualifier.
- **Comments and uncompleted checks:** The reported 383 remaining capability leaves, 349 unresolved migration blocks (133 SINGLE_SEMANTIC_CLASS, 124 MIXED_REQUIRES_DECOMPOSITION, 92 NO_NORMATIVE_CONTENT; 0 owner-reviewed), remaining PDP-0/3 field crosswalks, Agent Tool contract parity, PDP-2 Shared/adjudication and independent visual/assistive review, and Lifecycle provider licensing/receipts are still genuine work items. Approvals here cannot be fabricated into runtime evidence or currentness.
- **2026-10-08 continuation:** all three generated phase candidates were refreshed and strict checks passed; the current residual report and candidate metadata agree on semantic field blockers 4/0/10. This completes only the source-generation follow-up. Semantic blockers, independent/external approvals, Lifecycle proof, currentness, receipts, and phase acceptance remain open.
- **Evidence/decision:** [All-gate owner decision and exact exit criteria](./reviews/2026-10-07-all-gate-unblocking.md), `.product-experience/pdp-2-design-interface-system/gui/recipes/catalog.yaml`, `.product-experience/interface-parity/typed-contract-bindings.json`, `ACCEPT-INPUT-MEDIA-OWNER-GATES-20261007`.
- **Excludes:** per-leaf blanket acceptances, independent domain/legal/accessibility certifications, broad external API owner approval, production media codec/model admission, phase acceptance and Lifecycle issuance of receipts.

### PXD-028 — Approve bounded PDP-3 template/layout composition links

- **Status:** delegated Media owner decision for top-level composition links only; no screen or PDP-3 acceptance.
- **Authority:** the user's explicit delegation in the current thread to resolve appropriate Media owner-level decisions without repeated approval requests.
- **Approved:** a purpose-by-purpose review selects exact top-level `templateId` and `layoutIds` links for 41 of the 47 canonical PDP-3 screen contracts.
- **Withheld:** six mismatched template/layout pairs remain owner-review-pending, each with a source-linked reason; the 47-screen denominator is unchanged.
- **Reuse boundary:** approved Media templates and layouts provide consistent reusable composition links across screen proposals. This does not admit Shared components, screen implementations, renderer/runtime behavior, or a production UI.
- **Critical scope:** zero screen compositions are admitted. Nested `templateContract`/`layoutContract` links, per-screen recipe binding, action/effect/state semantics, Shared binding, accessibility/specialist review, and phase acceptance remain open.
- **Evidence:** `.product-experience/pdp-3-product-experience/screen-registry.yaml#compositionLinkOwnerReview`; PDP-2 GUI template and layout catalogs; `tests/pdp-2-recipe-layout-chains.test.mjs`.
- **Excludes:** per-screen recipe binding, Shared package/component approval, independent visual/accessibility review, Lifecycle currentness/receipts, and all PDP phase closure.

### PXD-029 — Approve six PDP-3 UI action to PDP-1 operation intent associations

- **Status:** owner-approved semantic intent/action associations only; no accepted cross-interface bindings.
- **Authority:** the user's explicit delegation in the current task to approve exactly six source-supported UI action → operation associations.
- **Approved:** `media.action.request-transcription` → `media.operation.transcription-submission`; `media.action.review-transcript` → `media.operation.transcript-version-read`; `media.action.correct-caption` and `media.action.align-caption-timing` → `media.operation.caption-draft-write`; `media.action.save-caption-version` → `media.operation.caption-version-write`; `media.action.compare-caption-versions` → `media.operation.caption-version-read`.
- **Scope:** semantic intent/action association only, grounded in the PDP-3 action registry and exact PDP-1 source-denominator proposal refs. The six decisions are recorded in a separate owner-intent overlay; all 14 exact refs remain proposals, the action denominator remains 146, and 132 actions without exact operation refs remain unresolved.
- **Excludes:** PDP-1 operation behavior acceptance or promotion of proposal status; transport, wire, schema, actor, authority, finality, runtime reachability, or operation behavior; accepted cross-interface bindings (count remains zero); full parity acceptance; P1-11; any PDP phase acceptance; Lifecycle currentness, receipts, or closure.
- **Evidence:** `.product-experience/pdp-3-product-experience/action-registry.yaml`, `.product-experience/pdp-1-domain-data/operations.yaml`, `.product-experience/interface-parity/operation-parity.yaml`, `ACCEPT-INPUT-MEDIA-OWNER-PDP3-ACTION-INTENT-ASSOCIATIONS-20261008`.

### PXD-030 — Resolve PDP-0 representative initiating actors

- **Status:** owner-selected actor projections only; independent PDP-0 semantic review remains pending.
- **Authority:** the user's explicit delegation in the current thread to resolve reversible Media owner-level decisions within the existing vision and requirements.
- **Approved:** the selected initiating actors recorded in `.product-experience/pdp-0-product-truth/intent-resolutions.yaml` and `journey-actor-resolutions.yaml`, including the previously ambiguous source-authored intents and journeys.
- **Scope:** choose one representative initiator from each exact source actor list so ProductDefinition can project a single `actorRef`; preserve every original collaborator `actorRef` in the source catalog and candidate model. This settles only the Media product's primary initiator convention for these combined intents/journeys.
- **Limits:** an initiating actor is not an authenticated principal, permission, accountable owner, reviewer, provider/operator binding, or runtime execution authority. The selections do not split source intents, change requirements or outcomes, establish feature/channel admission, qualify any operation, or prove implementation.
- **Evidence:** `.product-experience/pdp-0-product-truth/intent-resolutions.yaml`, `.product-experience/pdp-0-product-truth/journey-actor-resolutions.yaml`, `.product-experience/pdp-0-product-truth/goals-jtbd.yaml`, `.product-experience/pdp-0-product-truth/journey-catalog.yaml`, and `tests/media-product-definition-resolved-intents.test.mjs`.
- **Excludes:** P0-010 independent review; PDP-0 or any phase acceptance/closure; Lifecycle currentness, receipts, or closure.

### PXD-031 — Classify four legacy SDK methods as non-domain operations

- **Status:** owner-approved source-role classifications only; no client or route admission.
- **Authority:** the user's explicit delegation in the current thread to resolve appropriate Media owner-level decisions within the existing vision and requirements.
- **Approved:** `AudioVideoClient.getServiceStatus` and `getAllServicesStatus` are `TRANSPORT_ONLY` health observations over configured service `/health` endpoints; `addEventListener` and `removeEventListener` are `CLIENT_ONLY` in-process listener registration/removal.
- **Scope:** these four exact public method identities have source-backed non-operation dispositions in the SDK parity inventory. The remaining 14 SDK family associations are proposals and 10 public methods remain unresolved; all method identities and parser artifacts remain in the source denominator.
- **Limits:** classification does not establish successful health semantics, provider availability, Media API routes, logical operation bindings, delivery/finality, client conformance, or production SDK admission.
- **Evidence:** `libs/audio-video-client/src/index.ts#AudioVideoClient.getServiceStatus`, `#AudioVideoClient.getAllServicesStatus`, `#AudioVideoClient.addEventListener`, and `#AudioVideoClient.removeEventListener`; `.product-experience/interface-parity/operation-parity.yaml#typedInterfaceIdentityDispositions.sdk`; `.product-experience/pdp-1-domain-data/operations.yaml#sourceDenominators.sdkMethods`.
- **Excludes:** SDK/API owner acceptance, P1-11, wire or runtime qualification, any PDP phase acceptance, and Lifecycle currentness, receipts, or closure.

### PXD-032 — Preserve Lifecycle denominator coverage for the progress-indicator component proposal

- **Status:** bounded Media-owner denominator decision only; component proposal and PDP-2 acceptance remain open.
- **Authority:** the user's explicit delegation to resolve appropriate Media-owner decisions, as coordinated by the parent task.
- **Approved:** add `media.pdp-2.requirement.media.component.progress-indicator` as a REQUIRED PDP-2 closure obligation because `media.component.progress-indicator` is now an authored Media source contract included in the phase projections and reuse inventory.
- **Scope:** preserve one required closure obligation per authored/projected component-contract record. The denominator becomes 319 total obligations, including 74 PDP-2 obligations. The new obligation source-ref is exact and source-resolvable.
- **Limits:** this adds a source proposal to the required denominator only. It does not admit the component, assert its implementation or conformance, provide a case/provider/observer/oracle/receipt, or satisfy any proof route.
- **Evidence:** `.product-experience/pdp-2-design-interface-system/component-contracts.yaml#/components/media.component.progress-indicator`, `libs/audio-video-ui/src/components/MediaProgress.tsx#MediaProgressProps`, `config/closure/media-product-definition/obligations.json`, and `tests/media-obligation-denominator-audit.test.mjs`.
- **Excludes:** PDP-2 acceptance, Shared publication/licensing/owner approval, independent accessibility/design review, Lifecycle proof admission/currentness/receipts, and any PDP phase closure.


### PXD-033 — Classify exact migration structure and crosswalk blocks without semantic acceptance

- **Status:** bounded Media-owner classification only; P0-03 and all product-semantic acceptance remain open.
- **Authority:** the user's explicit delegation to resolve appropriate owner-level decisions within the established product vision, coordinated through the parent task.
- **Approved:** classify only the 86 exact migration-review item IDs recorded under `MEDIA-OWNER-2026-10-08-NONNORMATIVE-01`: 18 as `EXECUTION_ONLY` and 68 as `EVIDENCE_REFERENCE`. These cover table headers, horizontal separators, an explicitly non-implementation example cue, document/review provenance, navigation context, and Appendix A section/task-ID crosswalk rows.
- **Effect:** the migration ledger now distinguishes 86 bounded non-normative classifications from 263 unresolved semantic-content items. The existing 124 mixed blocks and 133 single-class proposals remain unresolved; six non-normative proposals are not covered. Semantic owner-reviewed/accepted count remains zero.
- **Limits:** crosswalk target meanings remain unresolved. Task IDs do not transfer receipts or establish task completion, semantic equivalence, implementation, acceptance, or Lifecycle evidence. MPSEM-0001 is covered only by its existing exact lines 4–5 metadata slice; its status and authority-phase assertions remain unresolved. The historical master-plan source pin stays stale and P0-03 remains open.
- **Evidence:** `.product-experience/pdp-0-product-truth/migration-semantics-review.yaml#MEDIA-OWNER-2026-10-08-NONNORMATIVE-01` and `tests/media-migration-semantics-ledger.test.mjs` exact-ID regression.

### PXD-034 — Select the internal validation reference profile

- **Status:** accepted bounded Media owner planning selection; R-05 remains partial.
- **Authority:** the user's 2026-10-08 delegation to implement the owner plan and review appropriate owner decisions.
- **Review:** version 1 explicitly disables commercial use, public distribution, external deployment and consumer cutover. Source/build/SBOM identities are unbound; all dependency admission classes are `NOT_ADMITTED`. The eight production gates require separate provenance, licensing, qualification, security, runtime, compatibility, owner and independent evidence.
- **Approved:** `config/release/internal-validation-only.json` as a noncommercial reference profile for local source validation, deterministic contract/fixture tests and isolated test doubles; the production admission checklist is an input for future review.
- **Evidence:** `docs/qualification/R-05-release-profile-admission.md` and `tests/media-release-profile.test.mjs` (2/2 pass in this execution).
- **Excludes:** any immutable release candidate, commercial release, external effects, deployment, cutover, license/model/codec/provider admission, independent certification, Lifecycle receipt or PDP phase closure.

### PXD-035 — Accept six exact PDP-1 rule projections and four measurement definitions

- **Status:** accepted bounded source mappings; full P0-05/P0-06 and independent acceptance remain open.
- **Authority:** the user's 2026-10-08 delegated Media owner review.
- **Reviewed and approved:** `MEDIA-DOMAIN-RULE-001` through `006` project only the existing PDP-1 `ownerAcceptedPolicyDecisions` keys `machineScopedStateIdentity`, `requestReceiptIsQueuedJob`, `unknownOutcomeRule`, `completedRule`, `cancelledRule` and `partialSuccessRule`. Each retains source authority, violation, trust scope, owner and fail-closed response. The proposed retry-eligibility rule was withheld because its cited source was not an accepted decision.
- **Measurement scope:** the four exact `successMeasureContracts` in `goals-jtbd.yaml` define metric, unit, population, criterion and evidence method for the existing four business intents. Baselines and qualification remain `NOT_EVALUATED`, targets remain `NOT_SET`; exact capability/profile applicability and independent calibration remain open.
- **Evidence:** `constitution.yaml#domainRules.records`, `goals-jtbd.yaml#successMeasureContracts`, `pdp-1-domain-data/state-adjudication.yaml#ownerAcceptedPolicyDecisions`, and source/projection regressions.
- **Excludes:** new operation/state equivalence, transition admission, qualified measurements, numeric performance promises, runtime/provider admission, independent review, phase closure and Lifecycle proof.

### PXD-036 — Select exact J-29/J-30 intent and view references

- **Status:** accepted exact definition links only; P3-03 remains partial.
- **Authority:** the user's 2026-10-08 delegated Media owner review.
- **Review:** J-29 loss detection and bounded return use `review-activity`; fencing and reconciliation use `job-status`, under the authored `recover-live-session` intent. J-30 scope and profile inspection use `check-processing-options`, unknown-dimension checks use `check-processing-readiness`, and the eligible-result step uses `choose-eligible-processing-option`, with their authored corresponding intents. All eight referenced screen contracts exist and their purposes cover these observation/recovery steps.
- **Approved:** the eight explicit step intent/view/screenContractRef selections, preserving all 130 ordered steps.
- **Excludes:** operation, action, authority, guard, transition, execution, recovery finality, scenario verification, screen admission or independent acceptance. An observation view does not implement fencing or authorize a fallback.
- **Evidence:** the J-29/J-30 journey contracts, screen contracts, journey registry and `tests/pdp-3-screen-journey-crosslinks.test.mjs`.

### PXD-037 — Resolve the six withheld screen composition links

- **Status:** accepted top-level definition links only; no screen composition admission.
- **Authority:** the user's 2026-10-08 delegated Media owner review.
- **Review:** the former choices confused diagnostics with task setup, composition editing with render preparation, record inspection with time-based editing/comparison, workspace settings with consent, and project navigation with a workbench. New central catalog grammar follows the authored region purpose and reading order rather than renaming those mismatches.
- **Approved:** `check-processing-readiness` → operational-readiness template/layout; `compose-media` → media-composition template and media-workbench layout; `inspect-media` and `inspect-provenance` → record-detail template/layout; `review-workspace-settings` → workspace-settings template/layout; `work-in-project` → project-overview template/layout. The five new templates and three new layouts are reusable source definitions, with referenced patterns and recipe chains subject to source validation.
- **Effect:** 47 current exact top-level composition links are selected; zero withheld. PXD-028's original 41 approvals retain their scope; only its six withheld mappings are superseded by this decision.
- **Evidence:** PDP-2 template/layout/pattern/recipe catalogs, PDP-3 screen registry and six screen contracts, `tests/pdp-2-recipe-layout-chains.test.mjs`.
- **Excludes:** screen-composition admission, Shared executable/component binding, production behavior, visual or assistive-technology acceptance, PDP-2/PDP-3 acceptance, Lifecycle currentness or phase closure.

### PXD-038 — Preserve every source-authored obligation in the dynamic census

- **Status:** accepted source inventory correction only; no proof admission.
- **Authority:** the user's 2026-10-08 delegated Media owner review and the plan's prohibition on silently dropping authored obligations.
- **Review:** `main@355d50e` already contained `media.domain.caption-version` and the five operations `caption-draft-write`, `caption-version-read`, `caption-version-write`, `transcript-version-read` and `transcription-submission`, but the 319-row obligation inventory omitted them. Nine new PXD-037 design records also require coverage: three layouts, one multitrack pattern and five templates.
- **Approved:** derive required obligation identities and phase membership from the actual canonical source collections; retain all previous IDs, add omitted/new source records and refresh source-only input fingerprints. The initial corrected population is 334 (38/136/83/77); further genuinely authored records must also be enumerated.
- **Evidence:** direct HEAD source comparison, `scripts/lib/media-obligation-denominator-audit.mjs`, `scripts/generate-media-lifecycle-source-inputs.mjs`, denominator and isolated generator negative tests.
- **Limits:** a refreshed source fingerprint records an input snapshot only. Changed candidate proof fingerprints invalidate prior results pending rerun and review. Case, provider, observer, oracle and receipt admission remain external and unchanged.
- **Excludes:** semantic acceptance of the added records, case fabrication, provider admission, independent review, Lifecycle currentness/receipts and phase closure.

### PXD-039 — Adjudicate three exact migration process rows

- **Status:** bounded classification only; P0-03 remains partial.
- **Authority:** the user's 2026-10-08 delegated Media owner review.
- **Reviewed and approved:** MPSEM-0044 (historical line 120, REV-24 implementation-task detail guidance), MPSEM-0064 (line 162, “The new repository must create and enforce:”) and MPSEM-0301 (line 692, “The API contract must specify:”) are `EXECUTION_ONLY` task guidance or structural lead-ins. These exact rows establish no product behavior or acceptance; all following concrete boundary/API claims require their own review.
- **Withheld:** MPSEM-0001's metadata slices retain their earlier scope while product/status/authority claims remain unresolved; MPSEM-0062's dependency direction and MPSEM-0066's boundary authority cannot be dismissed as non-normative metadata.
- **Effect:** PXD-033's exact 86 classifications are unchanged. Three additional exact classifications bring the cumulative non-normative population to 89 and leave 260 semantic items unresolved within the original 349 structural observations.
- **Evidence:** `migration-semantics-review.yaml#ownerDecisionOverlay.additionalBoundedClassificationDecisions`, exact item texts/source locations and migration regression tests.
- **Excludes:** adjacent normative assertions, dependency equivalence, boundary/API semantic acceptance, master-plan pin acceptance, task completion, independent review or phase closure.

### PXD-040 — Accept three exact principal-scoped read contracts

- **Status:** accepted bounded Media query semantics; no family-wide operation or phase approval.
- **Authority:** the user's October 8, 2026 delegation to implement and decide Media-owned semantics.
- **Reviewed:** `inspect-upload`, `inspect-artifact`, and `inspect-job` individually against their GET OpenAPI identity, `MediaHttpHandler` principal-scoped calls, and `MediaRuntime` direct tenant-store lookup followed by owning-principal filter; principal-less public runtime overloads fail closed. An inaccessible identity and an absent identity both return 404 within caller scope.
- **Approved:** version 1 QUERY contracts in `operations.yaml#individualOperationContracts.records` carry tenant, principal and resource identity; reads observe a stored projection without mutating domain state. Metadata grants no processing, byte-retrieval, rights or delivery permission. A missing job is never proof of no external effect, and a status observation is never an authoritative reconciliation/currentness receipt.
- **Alternatives rejected:** tenant-only public reads expose other principals' records; treating 404 as global nonexistence or a failed job invites unsafe replay. The trusted internal tenant-only store API remains distinct from the principal-scoped public runtime/transport contract.
- **Evidence:** `tests/media-canonical-read-contracts.test.mjs` executes source binding and adversarial missing-principal/renamed-route/false-finality/non-scoped-approval cases; `MediaRuntimeActiveTest` executes actual local runtime isolation. Tests are local evidence and remain subject to their recorded run outcomes.
- **Excludes:** production authentication/delegation qualification, unrestricted metadata access, Shared publisher approval, HTTP/SDK/gRPC equivalence, independent review, native Lifecycle admission/receipts, broader task completion or release.

### PXD-041 — Reject unsafe legacy SDK retry and classify the DI adapter

- **Status:** accepted bounded Media compatibility disposition.
- **Authority:** the user's October 8, 2026 delegated Media product/contract authority.
- **Reviewed:** no runtime or OpenAPI route serves the legacy SDK retry POST; attempt, current rights/policy, budget and unknown-effect reconciliation cannot be inferred from a request ID. The scene-text adapter maps Media source/version/frame/time around the Document Intelligence v1 provider port.
- **Approved:** legacy `retryOperation` and handle `retry` remain source-compatible methods that reject with `MediaOperationNotAdmittedError` before network dispatch. The adapter is `NOT_ADMITTED` to Media OpenAPI and does not create a Media OCR route. Its observed external client version `0.1.0` and extraction SNAPSHOT peer mismatch remain unqualified.
- **Alternative rejected:** sending a POST to a nonexistent route and interpreting retry as a new safe attempt would assert behavior the server does not own. A similarly named Media route cannot substitute for the DI protocol.
- **Evidence:** client retry tests assert zero fetch calls; exact SDK identity/parity negative tests retain DI provenance and no Media route admission.
- **Excludes:** an implemented canonical retry API, public DI package consumption/admission, external owner approval, model/runtime qualification, independent review or Lifecycle/phase/release acceptance.

### PXD-042 — Bind job request replay to the complete immutable payload

- **Status:** accepted exact Media submission idempotency invariant; full command/authority and runtime qualification remain open.
- **Authority:** the user's October 8, 2026 delegated Media owner review.
- **Reviewed and approved:** `(tenantId, requestId)` binds one logical job to a version-1 SHA-256 fingerprint of its request context, artifact, job type, governance, parameters and ordered structured provider identity/version/model descriptors. Matching replay returns the existing job without redispatch; a mismatched or absent legacy fingerprint fails closed. Job state/version transitions preserve that immutable fingerprint.
- **Concurrency:** local publication is atomic; persisted uniqueness scopes to tenant/request ID. Cancellation confirmation losing a compare-and-swap rereads canonical terminal state rather than overwriting completion. Storage failures are not cancellation conflicts.
- **Alternatives rejected:** comparing artifact/type alone silently reuses a job for changed parameters or governance. Guessing legacy payloads cannot prove replay safety. Provider-name delimiter concatenation and lossy Unicode encoding cannot establish distinct request identities.
- **Evidence:** exact fingerprint, concurrent local-store, runtime cancellation/replay, and PostgreSQL state/migration tests; their recorded verification outcomes control implementation evidence. V008 preserves old rows with nullable fingerprints, explicitly denying their replay.
- **Excludes:** accepted project/rights/budget policy, trusted transport identity, new retry attempts, provider/model licensing or qualification, production failure/soak evidence, independent review, native Lifecycle admission/receipts or release.

### PXD-043 — Enforce upload ownership at the mutation boundary

- **Authority:** explicit October 8, 2026 delegated Media owner authority.
- **Approved scope:** existing upload append and finalize commands require tenant, authenticated principal and upload identity at the runtime/store boundary. Local ownership checks occur under the upload lock; PostgreSQL checks the locked row before byte mutation or finalization claim. Deprecated principal-less entrypoints fail closed.
- **Alternatives rejected:** an HTTP-only preflight read cannot protect direct runtime callers or establish authority inside the storage mutation boundary; deriving the caller from the stored owner would fabricate authorization.
- **Evidence:** actual local and PostgreSQL wrong-principal/cross-tenant tests verify unchanged progress and owner success; HTTP passes its authenticated principal to the same APIs.
- **Excludes:** production identity, current policy/consent/budget authorization, full upload command acceptance, storage qualification, independent acceptance or Lifecycle receipts.

### PXD-044 — Bind the existing SDK artifact getter to the canonical read

- **Authority:** explicit October 8, 2026 delegated Media owner authority.
- **Approved:** existing `MediaOperationClient.getArtifact` uses `getMediaArtifact` GET `/api/v1/artifacts/{artifactId}` and the exact twelve-field runtime observation DTO, scoped to configured tenant/principal. Invalid shape, classification, size, digest, timestamp or scope fails closed. A scope-safe 404 retains its error/status/correlation and does not prove global absence.
- **Compatibility decision:** return `CanonicalMediaArtifactObservation`; document the source type migration instead of fabricating legacy domain kind/status/version/provenance aliases from absent wire fields. No new operation identity is introduced.
- **Evidence:** client 53-test suite, typecheck/build and wrong-scope/malformed/no-principal/404 tests. The previous unserved legacy artifact path is retained in the historical checker census as replaced, not active.
- **Excludes:** content retrieval, current rights or immutable domain-version qualification, production authentication, full interface parity, independent acceptance and Lifecycle receipts.

### PXD-045 — Replace three unserved SDK upload paths with actual runtime wire behavior

- **Authority:** explicit October 8, 2026 delegated Media owner authority.
- **Approved bounded compatibility migration:** existing create/upload-part/complete methods use the runtime upload paths and exact DTOs, configured tenant/principal, zero-based chunk sequence and bodyless completion. Legacy aliases are rejected; migration is documented. SDK sends the requested create idempotency header but does not infer replay support from that header; chunks are never automatically replayed after a lost acknowledgement.
- **Evidence:** client 69-test suite, typecheck/build, exact body/header/sequence/response and one-dispatch lost-ack tests. Three replaced routes remain in the historical 51-finding census; source convergence does not establish command acceptance.
- **Unresolved discrepancy:** OpenAPI declares create/completion payload-hash idempotency while the current runtime does not bind the create key or expose a completion request-key contract. Exact authority, replay, provider/storage qualification and complete upload command semantics remain unadmitted.
- **Excludes:** full operation/interface parity, production host identity, rights/budget authority, independent review, native Lifecycle receipts or release.

### PXD-046 — Define the existing upload commands with bounded replay and expiry semantics

- **Authority:** explicit October 8, 2026 delegated Media Product Semantic Owner authority.
- **Approved definition:** begin binds tenant, owning principal and caller key to the immutable full versioned request fingerprint. Equal replay returns the original session and its observed progress; unequal payload rejects with HTTP 400 before another upload is created. New chunks are contiguous; manual prior-index replay requires a persisted matching index/length/digest receipt and makes no second write. Conflicting chunks or upload state return HTTP 409. Lost acknowledgements remain unknown and never authorize automatic SDK mutation replay.
- **Completion:** an unexpired OPEN upload must have all expected bytes and the expected SHA-256 before finalization. Persist the original artifact identity before moving/claiming the effect; repeats return that identity. Completion has no body or caller request key. An artifact receipt does not grant rights, consent, publication or current availability. Begin/completion event attempts occur only on new store transitions; this is not an outbox or exactly-once delivery guarantee.
- **Evidence and limits:** actual Local and PostgreSQL scoped replay/concurrency tests support the bounded source behavior. Local v2 chunk manifests also verify stored segments and reject malformed, missing or inconsistent receipts; PostgreSQL duplicate acknowledgements compare its persisted receipt. Reopening/store recreation is distinct from process-kill, fsync, cross-process storage, load/soak and production durability qualification. Legacy or uncertain state fails closed.
- **Acceptance boundary:** these are Media-owned definitions for three existing commands, not complete operation or cross-interface admission. Trusted host identity, current policy/rights/consent, public artifact binding, provider/storage qualification, independent acceptance, native Lifecycle receipts and release remain open. `runtimeAdmission` stays `NOT_ADMITTED`; original 71-task Done criteria are unchanged.

### PXD-047 — Complete component definition source and reuse dispositions

- **Authority:** the user's October 8, 2026 delegated Media owner authority, with the corrected scope limited to PDP-0 through PDP-3 product definition.
- **Approved definition:** individually retain the 31 existing component contracts and bind each exact role, anatomy, keyboard and accessibility authority to its PDP-2 record. Three existing exported contracts (MediaProgress, MediaTaskFlow, VoiceProductionWorkflow) retain their exact public export and required-prop source observations. The other 28 remain explicit contract-only Media compositions; an observed screen fragment or a similarly named foreign widget does not establish a reusable component implementation.
- **Reuse decision:** generic primitives stay Shared-owned. Native measured progress preserves CSP and unknown-amount semantics; generic Shared progress/stepper behavior does not replace Media finality or host-gated navigation. Phrase and stem category labels remain textual; existing local palettes are not accepted categorical visualization authority.
- **Alternatives rejected:** marking every source fragment reusable would fabricate public props and compatibility; removing contract-only families would silently narrow the product; requiring production implementation before defining these components would conflate definition with activation.
- **Verification:** exact denominator, unique component IDs, contract references, public export/prop evidence, role and accessible interaction closure must pass the source validator; missing, duplicate, forged-admission and stale export/prop mutations must fail.
- **Excludes:** complete canonical action authority, implementation admission, Shared package-owner or distribution approval, independent visual/screen-reader conformance, native Lifecycle receipts, phase acceptance and production/release qualification. These gates retain their real owners.

### PXD-048 — Accept the four business measurement definitions and their direct projection

- **Authority:** delegated Media Product Semantic Owner authority; product definition scope only.
- **Approved definition:** the four original business measures retain exact IDs and business-intent descriptions. Each defines finite outcome/capability/profile-axis source traces, a frozen profile/cohort inventory, numerator, denominator, 100-times-ratio percentage, evidence method and acceptance criterion. Failed, blocked and untested selected units remain in the denominator; zero population is NOT_APPLICABLE and incomplete population is NOT_EVALUATED. Trace leaves do not alias logical operation identity or enumerate an admitted runtime population.
- **Baseline and target:** unknown baseline, unset profile-specific numeric target, and unqualified population remain explicit. Those are honest measurement-definition values, not omitted schema meanings. Calibration, qualified observations and profile-owner target selection govern subsequent measured claims.
- **Alternative rejected:** requiring a deployed host, production benchmark or admitted model to define this measurement grammar would confuse definition and activation. Treating generated records as a measured baseline or inventing a universal target would fabricate evidence.
- **Projection acceptance:** exact validated source contracts map to public SuccessMeasure fields; rich applicability and calculation text stays source-linked inside the schema-supported metric string. No new generic schema fields or capabilities are introduced. Negative tests reject missing/duplicate IDs, guessed capability/profile references, missing numerator, invalid percentage and forged measured qualification.
- **Excludes:** completeness of all capability/quality crosswalks, actual measured success, scientific calibration, qualified target/baseline, independent PDP-0 assessment, Lifecycle receipt or phase closure.

### PXD-049 — Accept the bounded J-02 upload and verification definition

- **Authority:** user-delegated Media product-definition authority; no implementation work is authorized by this decision.
- **Identity:** define upload identity as `(tenantId, uploadId)` with owning principal and a separate `(tenantId, principalId, idempotencyKey)` request identity. An artifact has `(tenantId, artifactId)` content identity; its immutable version and policy disposition remain distinct from upload progress, project attachment, storage location and access authority.
- **Legal edges:** RECEIVING reaches VERIFYING only after completion records exact expected bytes and full digest for the same source. Storage COMPLETED is not AVAILABLE. Verification promotion requires records for exact source/version, expected size/full integrity, admitted format/security checks and current purpose-scoped rights/consent/retention/policy decisions from their governing authorities. Missing or unknown checks cannot promote; a policy-directed quarantine is distinct from rejection, expiry and physical erasure. A verification-job observation alone cannot advance artifact state.
- **Recovery action:** the existing resume action is an ordered compound workflow: inspect the same upload, recheck current scope/authority/source/state, require explicit confirmation, append only remaining contiguous parts, and complete within the recorded scope. Inspection is a query and does not itself resume transfer. Unknown creation/finalization cannot authorize automatic mutation replay or a successor identity. FINALIZING, COMPLETED, ABORTED and EXPIRED do not authorize new parts. Explicit reconciliation of completion may use the same stable completion identity under PXD-046, never infer a new artifact or current rights.
- **Experience definition:** bind the five existing J-02 steps to exact source objects, actions, operation slices, guarded transition scope and step-specific failure/recovery oracles. Navigation and read observations have an explicit no-transition disposition rather than a fabricated state edge. A host that cannot supply a verification job or admitted policy result must disclose that limitation.
- **Alternatives rejected:** treating a receipt as a usable artifact would bypass required verification; matching operation names would obscure compound action effects; leaving a delegated Media definition undecided solely because a production host is absent would confuse definition and implementation.
- **Excludes:** actual verification issuers or rights clearance, trusted authentication, runtime/transport admission, production host, durability/security qualification, independent phase assessment, native Lifecycle evidence/receipts and release. PXD-026 through PXD-039 retain their original scopes.

## PXD-050 — Bounded J-02 capability definition bindings

**Decision:** Accept the exact source mapping for the existing `media.artifact.upload`, `media.artifact.upload.resume`, and `media.artifact.inspect` leaves to J02-2, J02-3 and J02-5 and their individual PDP-1 slices. Authority is the user's delegated Media product semantic ownership, limited to product definition. Same-upload resume is inspect, recheck current authority/source/state, explicit confirmation, remaining contiguous parts, then completion. Metadata inspection is read-only and does not perform verification.

**Sources:** `pdp-0-product-truth/capability-leaf-review.yaml#leaves[].ownerDefinitionSlice`; `pdp-1-domain-data/operations.yaml#individualOperationContracts`; `pdp-3-product-experience/journey-contracts/upload-import-and-verify-artifact.yaml`; `tests/media-j02-capability-leaf-definition.test.mjs`.

**Alternatives and exclusions:** Reject treating remote import as local upload or artifact inspection as verification-job observation. Exact immutable version identity remains required product meaning; the observed artifactId-only wire response does not prove versionId. Transfer preservation constraints remain applicable while transformation quality/delivery profiles are not selected. Resource, execution, reproducibility qualification and broader leaf applicability remain open. This accepts three scoped definition bindings, not full leaf coverage, runtime, independent review, phase closure or a denominator reduction.

## PXD-051 — Bounded upload/artifact interface definition grammar

**Decision:** Accept source-specific interaction definitions for five existing HTTP upload/artifact identities and their exact SDK methods, plus the existing artifact-inspect CLI read. Require exact tenant/principal/request binding, scoped result/error meaning, same-identity unknown-outcome reconciliation and separate transfer/verification/availability finality. Resume is a user-confirmed compound workflow, not another route. Authority is delegated Media definition ownership.

**Sources:** `pdp-2-design-interface-system/action-finality-grammar.yaml#boundedUploadArtifactSlice`; `pdp-3-product-experience/api/operations/{beginMediaUpload,getMediaUpload,appendMediaChunk,completeMediaUpload,getMediaArtifact}.yaml`; SDK and production CLI registries; current OpenAPI and SDK declarations. Exact interaction tests and adversarial parity checks remain required.

**Alternatives and exclusions:** Reject route-name-only equivalence and mapping the unrelated registered inference Agent Tools to upload or artifact reads. No current registered Agent Tool matches this slice; no upload CLI command, gRPC identity or event equivalence is invented. No artifact wire versionId or content-access/rights/AVAILABLE proof is inferred. Source-defined interface support does not admit runtime, host identity, durability, immutable package distribution, independent parity or full PDP acceptance.

## PXD-052 — Explicit effect, finality and manual recovery definitions

**Decision:** Accept typed definition semantics for the selected existing upload/artifact actions and the five existing recovery narratives. Project only directly authored effect kinds, unconditional boolean reversibility and confirmation/finality meaning. Retain conditional or unknown reversal guards without narrowing them to a public boolean. Manual correction, alignment, rights restoration, uncertain-job reconciliation and version-conflict resolution require explicit user/authority action and never automatically replay an external effect.

**Sources:** `pdp-3-product-experience/action-registry.yaml#actions[].actionDefinitionSemantics`; `recovery-finality-contracts.yaml#contracts[].definitionSemantics`; `experience-source-bindings.yaml`; exact public ExperienceSpecification effect/finality/recovery schema; `scripts/lib/media-experience-definition-mapping.mjs` and its adversarial tests.

**Alternatives and exclusions:** Reject claiming that a remote read, its disclosure or audit trail can be undone merely because the user can leave an observation view. Reject merging unknown upload recovery with unknown job recovery. Attachment defines an immutable new project reference/revision and has no accepted canonical operation binding in this slice. The public definition projection is not executable behavior, scenario qualification, rights approval, independent acceptance, Lifecycle admission or phase closure. The original action, recovery and journey populations are preserved.

## PXD-053 — Exact historical journey table-header classification

**Decision:** Classify only MPSEM-0558's complete header unit `| Journey ID | Complete outcome and critical exceptional path |` as structural evidence with no normative product assertion. The exact unit occurs at pinned historical line 1295 and current line 1309 of `docs/migration/expert-reviewed-master-plan.md`. It is already outside the original 349 structural observations and the 260 unresolved semantic items; this separate bounded review does not increment the original 89 classifications or reduce unresolved semantics.

**Sources:** `pdp-0-product-truth/migration-semantics-review.yaml#ownerDecisionOverlay`; `tests/media-migration-j02-source-claim.test.mjs`; historic master-plan commit `e62514f94c45a4ecbc438d26298bf82b6a6f3d69` and current source digest recorded in the register.

**Alternatives and exclusions:** Reject accepting neighboring journey requirements or all J-02 meaning from this table header. MPSEM-0557 and MPSEM-0560 remain independently unresolved; the latter retains remote-import and wire-version-identity gaps despite bounded upload/recovery definition sources. Historical source pins stay stale. No semantic equivalence, runtime behavior, independent review or phase acceptance is inferred.

## PXD-054 — Canonical J-01 project definition contracts

**Decision:** Under delegated Media semantic ownership, accept three required slices for the existing J-01: create-project, list-projects and inspect-project. Creation atomically establishes one ACTIVE project, an empty immutable COMMITTED initial revision, and its matching head. Trusted tenant/principal, currently authorized workspace and current project policy govern the effect. Preserve the submitted nonblank title and bind the opaque request key to its exact workspace/title payload. Matching replay returns the original receipt; mismatching replay conflicts. Unknown outcomes retain the original key and require reconciliation, including when deduplication evidence is unavailable.

**Sources and acceptance:** `pdp-1-domain-data/operations.yaml#individualOperationContracts`, project/revision objects, initial state meanings and action contracts; `tests/media-j01-project-operation-definitions.test.mjs`; existing J-01 and project capabilities. These three individual obligations are necessary refinements of an existing journey, taking the enumerated population from 344 to 347 without adding a capability, journey or operation family. Their proof route is authored contract checks followed by independent PDP-1 review and native Lifecycle admission.

**Rejected alternatives and limits:** A current-head read cannot replace the original initial revision in a creation receipt. An empty scoped list or absent reconciliation result cannot prove no creation occurred. Queries neither grant authority nor admit artifact content. No archive/restore or draft-commit transition, transport endpoint, runtime implementation, policy provider, durability qualification or external acceptance is selected. Detailed title/resource limits remain unqualified and do not establish complete per-operation bounds.

## PXD-055 — Four-step J-01 experience definition

**Decision:** Accept exact operation, authority, object, state, failure and recovery bindings for the four ordered J-01 steps. Identity/context handoff precedes protected project reads; project creation ends the journey once its authoritative atomic receipt is established. The fifth registered screen, create-media, is an optional continuation after completion and adds no step. Create has an explicitly irreversible effect and receipt-bound confirmation; remote project reads retain unknown reversibility rather than an invented undo boolean.

**Sources and acceptance:** `pdp-3-product-experience/journey-contracts/first-use-and-project-creation.yaml`, its five screen contracts, action registry and `experience-source-bindings.yaml#j01StepBindings`; `tests/media-j01-definition-semantics.test.mjs`. Project only the exact create effect/finality definitions. Existing 30 journeys, 130 steps and 146 actions remain unchanged.

**Limits:** Initial aggregate creation is not a fabricated existing-state transition. Shared authentication and host identity remain qualified by their real owners. This accepts source definitions only, excluding rendered/assistive-technology behavior, runtime, independent experience assessment, Lifecycle receipts and phase closure.

## PXD-056 — J-01 interface interaction grammar

**Decision:** Accept the four step-to-operation relations and exact request, scoped result/error, duplicate/conflicting identity, authoritative finality and same-request unknown-outcome grammar. The three canonical operation slices define intent while current HTTP, SDK, CLI and Agent Tool implementations remain unbound. Shared identity/context handoff requires its own qualified contract.

**Sources and acceptance:** `pdp-2-design-interface-system/action-finality-grammar.yaml#boundedProjectSetupSlice`; `tests/media-j01-project-setup-grammar.test.mjs`, checked against PDP-1 slices and the four actual J-01 steps.

**Limits:** Matching names are not behavior parity. No endpoint, method, command, tool, event or host availability is invented. No independent interface acceptance, native Lifecycle receipt or phase closure is asserted.

## PXD-057 — Component source-definition case catalog

**Decision:** Accept 31 authored case identities for the existing 31 component obligations, each bound to its exact component source index and an executable parameterized source test. Positive binding checks and stale-role, missing keyboard source, forged implementation admission and missing-component negative assertions establish partial source-definition evidence only.

**Sources and acceptance:** `tests/media-component-definition-proof-cases.test.mjs`, existing component contracts and definition bindings, `config/closure/media-product-definition/l02-source-case-links.json` and obligations. Run all 31 actual test cases; preserve their exact assertion identity and source population. Candidate links are marked NOT_LIFECYCLE_ADMITTED.

**Limits:** Case IDs are authored identities, not proof receipts. These tests do not establish full component obligation satisfaction, rendered keyboard behavior, independent accessibility assessment, Shared package approval, registered observers/oracles/providers, native Lifecycle admission or phase closure. No component or obligation is added by this case catalog.

## PXD-058 — Immutable caption registration and exact read definitions

**Decision:** Accept the bounded definition semantics of the existing caption-version-write and caption-version-read operations and caption-version identity. No operation, family or obligation is added. Registration appends one immutable version and authoritative receipt with exact tenant/source/version, typed parent, source clock, ordered segment content, language disposition and current governing authority. A legacy transcription UUID or untyped fixture parent does not establish canonical transcript-version identity. Structural safe-integer ticks preserve declared source-clock units; they do not establish scientific alignment accuracy.

**Request and recovery:** Select an explicitly versioned fixed-tuple compact JSON/UTF-8 SHA-256 fingerprint recipe, retaining exact validated content, optional-field presence and ordered segment tuples before dispatch. The key remains tenant/principal/request scoped. Identical replay returns the original receipt; mismatching content conflicts. Unknown registration first reconciles the same request and full fingerprint. Absent, expired or unavailable evidence never proves no effect. Only an authoritative durable terminal no-effect receipt excluding in-flight/future commit may permit an explicit same-key retry after fresh policy. The existing read has exclusive EXACT_PAIR and REGISTRATION_REQUEST selectors; request reconciliation returns the original immutable version/receipt, not a later version. Pair mismatch discloses incompatibility without rescaling or choosing a winner.

**Sources and acceptance:** `pdp-1-domain-data/operations.yaml`, `domain-objects.yaml`, `action-contracts.yaml`; `scripts/lib/media-caption-version-definition-validation.mjs`; the two principal executable cases in `tests/media-caption-version-operation-definitions.test.mjs`. Their authored case identities provide partial source-definition evidence for two existing obligations only.

**Limits:** Registration is not review approval, provenance export, delivery, publication or rights clearance. Fixture flags, repeated simulation saves and legacy IDs are observations, not canonical idempotency/authority. Deployed identity, policy/storage providers, transport methods, security/scientific/independent review and native Lifecycle acceptance remain unqualified. No runtime implementation is authorized.

## PXD-059 — Caption registration and comparison interface grammar

**Decision:** Accept exact write fields/results/errors, trusted host fields, typed parent and source-clock guards, full request fingerprint and the two exclusive read selectors. Same-request unknown-outcome reconciliation precedes mutation replay. Pair reads do not approve content, merge versions or grant rights. Registration confirmation and its durable finality are distinct from transport acknowledgment.

**Sources and acceptance:** `pdp-2-design-interface-system/action-finality-grammar.yaml#boundedCaptionVersionSlice`, checked against PXD-058 contracts and J03-7/J03-8 under PXD-060; `tests/media-caption-version-interface-grammar.test.mjs`.

**Limits:** Web action dispatch and synthetic fixture CLI are observed source identities only. No current HTTP, SDK, gRPC, Agent Tool or event equivalence is invented. Scientific accuracy, current policy/provider qualification, independent interface review and native phase acceptance remain separate.

## PXD-060 — J-03 registration/comparison experience and capability correction

**Decision:** Accept the exact definitions for the existing J03-7 registration and J03-8 comparison steps. Preserve the first six steps, selected audio scope and all global populations. Registration is irreversible within this operation and confirmed only by its authoritative receipt; comparison retains unknown reversibility and is not projected as a public undo boolean. Runtime verification remains not run; actual source contract checks are recorded separately.

**Capability correction:** The save action claims output registration only. Its required internal provenance metadata is not provenance export. Propagate the central action crosswalk to each affected screen reference without accepting unrelated screen behavior. The provenance-export capability itself is not retired or accepted by this correction.

**Sources and acceptance:** J-03 journey, action registry, correct-captions/compare-caption-versions screens and the additional edit-captions crosslink, experience source bindings and the recomputed journey registry; `tests/media-caption-version-experience-definitions.test.mjs`. Public effect/finality projection is restricted to the exact write action, source PXD-058 and grammar PXD-059.

**Limits:** No new journey, step, action, operation, transition or runtime behavior is added. Caption creation/comparison is not an invented state transition; canonical scientific quality, full J-03 video scope, independent experience review and native Lifecycle acceptance remain open.

## PXD-061 — Bounded caption capability bindings and source-case evidence

**Decision:** Accept the two existing leaves' captionVersionDefinitionSlice mappings: output registration to J03-7 and caption inspection/comparison to J03-8. Preserve the earlier J-02 inspection definition separately. These mappings establish only the selected caption-domain definitions, not generic artifact wire version identity, content availability or complete leaf coverage.

**Sources and acceptance:** `pdp-0-product-truth/capability-leaf-review.yaml` selected caption slices; PXD-058 canonical records and PXD-060 selected steps. Retain two authored case IDs for the existing caption operation obligations, exact principal test identities, positive contract checks and negative scope/identity/admission checks. Source links remain NOT_LIFECYCLE_ADMITTED.

**Limits:** All 462 leaves, 383 unresolved applicability targets and 445 unbounded leaves remain in the original population. No new capability or Lifecycle obligation is added. Source/parent/receipt integrity and mismatch disclosure are definition criteria; scientific quality, execution location, resource and reproducibility qualification remain open. Internal provenance does not imply export, approval or publication. Generic artifact identity, runtime and independent/native acceptance remain unclaimed.

## Governance decisions for this authority root

### GOV-AUTH-001 — Use authored partial relations for traceability

- **Status:** selected governance representation; not a product-semantic
  acceptance.
- **Decision:** [`traceability.yaml`](./traceability.yaml) records authored
  task/artifact relations and selected cross-artifact links. Relationship
  truth remains in the owning Phase 0 records; the map does not copy those
  records or assert complete closure.
- **Limit:** P0-010 must independently inspect reference closure and semantic
  completeness after the remaining Phase 0 owner reviews.

### GOV-AUTH-002 — Store acceptance inputs, not computed phase results

- **Status:** selected governance representation; not an acceptance result.
- **Decision:** [`acceptance.yaml`](./acceptance.yaml) stores explicit human
  decision inputs, required owner review, and evidence needs. It contains no
  generated closure/currentness result.
- **Limit:** The Tools-owned schema/validator binding remains open under
  `GAP-MEDIA-TOOLS-SCHEMA-BINDING`; Lifecycle-owned generated observations
  remain open under `GAP-MEDIA-CURRENTNESS-COVERAGE-GENERATION`.

### GOV-AUTH-003 — Do not hand-maintain currentness

- **Status:** required by the master plan; generation path unresolved.
- **Decision:** No `currentness.yaml` is created until the owner-approved Lifecycle
  binding can generate a reproducible observation. This repository does not
  introduce a generic closure engine or manually assert that artifacts are
  current.

## Product proposals awaiting acceptance

P0-002 through P0-009 have authored material, but those records remain
proposals or work in progress until their listed human and external-owner
reviews are recorded. In particular, P0-007 profile, fallback, quality,
calibration, and optimization semantics do not qualify an engine, model,
provider, metric, or measured output. Their required specialist decisions are
listed in the owning files and in [`acceptance.yaml`](./acceptance.yaml).

P0-010 independent semantic acceptance remains pending. Phase 1, Phase 2, and
Phase 3 are not accepted and remain gated by the dependencies in the master
plan. No entry in this log changes the migration source-of-truth or gap
register; see [`source-manifest.yaml`](./source-manifest.yaml) and
[`gaps.yaml`](./gaps.yaml).

### PXD-062 — Canonical transcript-version identity and exact inspection

- Authority: Media product semantic owner under the user's delegated authority; definition only.
- Decision: Accept the necessary `media.domain.transcript-version` identity and the existing `media.operation.transcript-version-read` exact-version query. Trusted tenant/principal and current scoped read authority govern both the immutable version and linked source. Legacy transcription UUID, job ID, provider result artifact ID and text digest are not interchangeable selectors.
- Sources: PDP-0 `journey-catalog.yaml#J-03`, `capabilities.yaml` transcription uncertainty/source-version constraints; PDP-1 `domain-objects.yaml#media.domain.transcription`, the existing transcript read contract and caption registration's typed canonical-parent requirement; typed SDK/gRPC and persistence records remain source observations.
- Rationale/alternative: Retain the legacy record's actual identity while adding one required canonical version identity. Treating a legacy UUID or fixture parent as canonical would falsely satisfy caption lineage. This is a prerequisite of the existing journey and caption contract, not a new operation or optional feature. One necessary domain-object obligation is added; acceptance tests and source proof route accompany it.
- Boundaries: Immutable content/source identity, supplied evidence and original provider units remain intact. Missing timing permits inspection. Separately identified qualified source-clock mapping is read-context evidence, not mutation or scientific quality. Caption-parent use additionally requires authoritative clock, rate, duration and source match plus current registration authority. Visibility does not grant that authority. No producer, model, transport, security qualification, independent signoff or native Lifecycle receipt is admitted.

### PXD-063 — Transcript inspection interface grammar

- Decision: Accept only `boundedTranscriptReviewSlice` for the existing exact-version read, action and J03-4, sourced from PXD-062. Required/conditional fields retain explicit availability, source identity, uncertainty and clock mapping evidence. No omitted observation becomes zero, certainty or correctness.
- Sources: PDP-2 `action-finality-grammar.yaml#boundedTranscriptReviewSlice`, PDP-1 exact transcript read/object definition, existing UI and synthetic CLI observations.
- Boundaries: Query-only cancellation means stop waiting; later reads recheck authority. Scope-safe missing/inaccessible responses do not reveal global existence. No HTTP/SDK/gRPC/Agent/event equivalence, production CLI availability, public reversibility boolean, registration or approval is inferred.

### PXD-064 — Existing J03-4 transcript review experience

- Decision: Accept the bounded source definitions of the existing `review-transcript` step, screen and action, linked exactly to PXD-062/PXD-063. Bind actor, immutable object, current authority, success, failure, recovery and query transition applicability. Preserve the other seven ordered steps and all original journey/action populations.
- Sources: PDP-3 `journey-contracts/transcribe-and-correct-captions.yaml`, `screen-contracts/review-transcript.yaml`, `action-registry.yaml`, `experience-source-bindings.yaml` and the original J03 intent.
- Boundaries: Inspection exposes unverified supplied content and missing evidence; it cannot approve, correct, register or publish. No domain mutation transition is invented. Read reversibility remains UNKNOWN with no public effect/finality boolean. Actual runtime verification remains not-run with no actual evidence; source definition checks are recorded separately. Independent experience/accessibility and native acceptance remain open.

### PXD-065 — Transcript inspection capability and source proof scope

- Decision: Accept only the transcript inspection slice of existing `media.artifact.inspect`, preserving its J02 metadata and J03 caption comparison definitions. Author actual partial source cases for the necessary canonical object and existing read requirement. No new capability, journey, step, action or operation family is introduced.
- Sources: `capability-leaf-review.yaml#media.artifact.inspect.transcriptVersionDefinitionSlice`, PXD-062/PXD-064 and the exact source assertion declarations.
- Boundaries: Full leaf acceptance, scientific quality and current runtime availability remain unclaimed. The 462 leaves, 383 unresolved targets and 445 unbounded leaves retain their denominator/status. Case IDs/source links do not admit providers, observers, oracles or native phase receipts. PXD-026 through PXD-039 retain their original approved scopes.

### PXD-066 — Existing caption draft operation and local snapshot

- Authority: Media semantic owner under delegated user authority; definitions only.
- Decision: Accept the existing `media.operation.caption-draft-write` for its two existing text-correction and manual timing actions. Define a nested session-local draft value and host preparation recipe, not a new canonical persisted object or remote operation. Trusted active-session ownership, exact immutable source/typed parent and expected local revision govern each atomic edit.
- Sources: Existing J03 steps5/6, PDP-1 draft operation, canonical transcript/caption parent contracts, and source-observed simulation draft/reducer/CLI/provider correction shapes. Observations are not runtime equivalence.
- Required boundaries: Faithful supplied parent segments with stable identities or explicit user-authored preparation; otherwise block initialization. No implicit segmentation, joining, IDs, language, speaker, confidence, clock or provider-unit conversion. Text edits may preserve missing timing; manual tick edits require explicit user values and qualified exact-source clock/rate/duration. Complete validation/policy failure preserves the old snapshot.
- Revision/recovery: Edits and guarded undo advance monotonic safe-integer revisions. Exhaustion rejects atomically. Undo requires same session, identity, source/parent lineage, exact current revision and retained prior snapshot; never resets a revision or causes ABA. Rebase creates a distinct new draftId/revision0 under fresh policy; retain the stale draft until explicit discard. Discard/cancellation cannot delete immutable parents or reverse registration. Registration uses its separate contract and fresh authority; no durability, provider or native admission is claimed.

### PXD-067 — Caption draft interface grammar

- Decision: Accept only `boundedCaptionDraftSlice`, exactly linked to PXD-066 and the two existing actions. Preserve separate TEXT_CORRECTION and TIMING_ALIGNMENT field sets, full local snapshot/timing union, explicit initialization, CAS, exhaustion, guarded undo and new-identity rebase rules.
- Sources: PDP-2 action/finality grammar and exact PDP-1 draft definition; existing UI/fixture CLI/provider shapes remain separately observed.
- Boundaries: User tick edits are manual observations, not qualified forced alignment. Local conditional undo cannot become an unconditional public reversibility boolean or remote-effect reversal. No HTTP/SDK/gRPC/Agent/event equivalence, durable storage, scientific alignment, license or runtime availability is admitted.

### PXD-068 — Existing J03 correction and manual timing steps

- Decision: Accept bounded definitions for J03-5 and J03-6, existing correction/timing actions and their selected screen consequences, linked exactly to PXD-066/PXD-067. Both prepare/use a session-local draft; source and typed parent stay immutable. Bind actor, object, authority, success, failure, recovery, initialization and explicit local-only transition applicability.
- Sources: Existing journey, action registry, source bindings, `correct-captions` and `edit-captions` contracts. Preserve the other six steps, transcript inspection, caption registration/comparison and all original populations.
- Boundaries: LOCAL_DRAFT_UPDATE/CONDITIONAL undo cannot project unconditional public effect/finality booleans. No canonical domain state edge is invented for a local value. Actual runtime verification remains not-run and evidence empty; separate source checks do not establish runtime behavior or independent experience/accessibility acceptance.

### PXD-069 — Manual timing capability crosswalk and source case

- Decision: Accept only the bounded draft slice of existing `media.artifact.derive`; narrow the manual timing action, its existing step and affected screen consequences to that capability. Reject `media.speech.transcription.forced-align` as the meaning of manual user-entered tick edits. Its source requires an authorized audio/transcript operation and qualified profile producing timing observations with uncertainty.
- Sources: Exact `capabilities.yaml#media.speech.transcription.forced-align` and draft/J03 action definitions. Preserve forced alignment as original normative scope and preserve its historical broad J03 applicability trace explicitly as context only. Current exact action/operation bindings are empty/unresolved; no algorithm or optional operation is added.
- Counts/acceptance: The broad inventory classification remains 462 leaves/383 unresolved/77 journey traces/445 unbounded/full accepted0; journey traces are not exact accepted operation behavior. One actual partial source case links the existing draft operation obligation. No new capability, domain object, journey, action, operation family or proof obligation. No provider/observer/oracle admission or native receipt is fabricated; PXD-026 through PXD-039 retain their approved scope.

### PXD-070 — Existing audio transcription request acceptance

- Authority: Delegated Media semantic owner; definitions only.
- Decision: Define the existing transcription-submission operation for one exact immutable audio source, explicit language intent and selected profile identity/version/configuration, current scoped processing authority and declared purpose/retention/location. Atomic logical-request and receipt registration precedes any asynchronous provider dispatch. Acknowledgment identifies the original logical job and receipt; it does not assert QUEUED/RUNNING, completed recognition, transcript accuracy or review approval.
- Sources: Existing request-transcription action, J03-2, canonical source/version/policy contracts, file-transcription capability and observed HTTP/SDK/CLI/gRPC implementation shapes. The broader transcription, job-state/attempt, streaming and provider-correction families retain their separate unresolved scope.
- Recovery decision: Trusted host prepares and retains the complete immutable request snapshot/fingerprint before dispatch. Exact scoped request identity and canonical fingerprint govern replay/conflict; ambiguous, absent, expired or incomplete evidence stays UNKNOWN. Reconciliation is a receipt read with current scoped read authority, distinct from permission to process or replay. Revoked processing authority cannot authorize another dispatch and does not by itself deny a separately authorized receipt read. Conflict preserves the original request; refusal of a different payload does not prove the old key had no effect.
- Alternatives rejected: Inferring language/profile support from a fixture; treating a synchronous recognition RPC as acknowledgment parity; replaying a partial snapshot/new key after timeout; conflating submission acceptance with a job-state transition or calibrated scientific quality.
- Boundaries: No transport, production provider, license/security/scientific qualification, independent assessment or native Lifecycle admission is claimed. PXD-026 through PXD-039 retain their original scopes.

### PXD-071 — Transcription submission interface grammar

- Decision: Bind only the existing action and exact PXD-070 request-acceptance/read-reconciliation branches. Preserve immutable request/profile/language fields, current branch-specific authority, full fingerprint preparation, original receipt identity, typed rejection/conflict/unknown outcomes and deliberate recovery.
- Sources: The bounded transcription-submission grammar and exact PDP-1 operation; fixture channels and recognition RPCs remain observations.
- Boundaries: Canceling a wait/request is not reversal or confirmed provider stop. An acceptance receipt is not recognition completion. No Boolean effect/finality coercion, full cross-interface parity, scientific outcome or runtime admission is accepted.

### PXD-072 — Existing J03 transcription submission step

- Decision: Bind J03-2 and request-transcription to PXD-070/PXD-071 for the selected audio lane. Preserve exact source identity, explicit request/profile/language intent, current authority, retained pre-dispatch snapshot, stable job/receipt acknowledgment, failure distinctions and same-key receipt recovery. Receipt reconciliation and another processing attempt require their distinct current authority checks.
- Sources: Existing J03 contract/action/source bindings and transcription-progress screen consequence. J03-1 source selection and J03-3 job-state observation remain separate unresolved definitions; steps4–8 retain their approved bounded definitions.
- Boundaries: REQUEST_ACCEPTANCE with UNKNOWN reversibility cannot become an unconditional public effect/finality Boolean. Receipt registration is not an accepted canonical job-state edge. Actual runtime checks remain not-run with no evidence; source assertions do not establish independent complete-experience acceptance.

### PXD-073 — Existing capability acceptance slice and source case

- Decision: Bound only the request-acceptance slice of the existing job.submit and speech.transcription.file leaves to J03-2 and the existing submission operation. Preserve the full capability meanings and their unresolved recognition/execution, profile, license and quality qualification; acknowledgment alone cannot satisfy either whole leaf.
- Sources: Original capability identities, PXD-070/PXD-072 and actual source assertion declarations for the existing submission obligation.
- Population boundary: No new capability, operation, domain object, action, journey, step or proof obligation. Existing 462-leaf and 348-obligation denominators remain unchanged. Actual source cases are partial source checks, not registered observer/oracle/provider bindings, native receipts or phase closure.

### PXD-074 — Exact temporal/spatial definition conversion profiles

- Authority: Explicit user-delegated Media semantic ownership for PDP-0 through PDP-3, October 8, 2026; definition decision only.
- Decision: Select rational seconds-per-tick with signed-64-bit ticks and explicit identified media/simulation/story clock and stream; exact BigInt intermediates; caller-selected exact/floor/ceil/ties-even conversion; destination overflow rejection and signed rational loss. Select half-open audio sample boundaries with explicit rate/count; exact image-version pixel boundaries with top-left/right-down axes and rational normalized coordinates; exact SI decimal length/time scalar conversion with dimension checks.
- Sources: PDP-1 `value-objects.yaml#canonicalConversionDefinitions` and `interoperability.yaml#canonicalDefinitionConversionBinding`; existing PDP-0 `time-units-fidelity.yaml`; executable definition oracle `scripts/lib/media-temporal-spatial-definition-model.mjs` and `tests/media-temporal-spatial-definition-model.test.mjs`.
- Review: Eight executable definition tests cover exact signed-64-bit/unsigned rate/dimension boundaries, invalid unit names, rational 30000/1001 cadence, thousand-year exact round trip, signed rounding loss/ties, destination overflow, unknown/cross clocks, sample bounds, stale image version/dimensions, coordinate convention, exact SI ratios and dimension-denial. Existing unspecified wire units are unchanged. The selected profile denies implicit alignment, encoder priming/padding, float fps equivalence, crop/rotation/world frames and arbitrary unit conversion.
- Boundaries: This retires the typed conversion/loss-oracle portion of P1-09 for these explicit definition profiles. Full per-interface interchange parity, qualified scientific/domain expert review, decoder/provider timing accuracy, clock calibration, runtime implementation and native Lifecycle proof remain open. No legacy scalar field is silently assigned a unit or canonical identity. No original task status or phase receipt is changed.

### PXD-075 — Total action-role classification and source envelopes

- Authority: User-delegated Media definition owner; classification and definition-source fidelity only.
- Decision: Accept the 146-record typed action-role inventory for exact existing action identities. The actor, applicability guard, stated effect, original reversibility value, finality and failure/recovery fields must match the authored action source. Explicit canonical operation references must resolve; ordered workflows preserve their operation order. Local selection/session-draft roles are limited to the existing declared local effect. Read-only observation with an unresolved query binding stays unresolved. Consequential actions without an exact operation remain unbound and cannot authorize effects. Shared identity handoffs remain external owner contracts.
- Sources: PDP-3 `action-registry.yaml#actions[].actionDefinitionSemantics.typedDefinition`, PDP-1 `operations.yaml#actionOperationDispositionInventory`, and `tests/pdp-experience-action-inventory.test.mjs`.
- Review boundary: The finite 146-record coverage and exact field crosswalk are useful integrity criteria; copying source prose does not complete canonical object/operation, guard evaluation, full recovery behavior, journey allocation, component prop contracts or any original P3 Done clause. New precise canonical definitions remain separately reviewed at their owning PDP-1 sources.
- Projection rule: Reject missing/mismatched identity, unreviewed decision, unsupported role, stale envelope or unresolved operation reference. No conditional/unknown reversibility becomes a public boolean. Typed provenance is not runtime admission or independent acceptance; all records retain NOT_ADMITTED. Do not clear the action/effect/journey projection blocker solely because this inventory is total.
- Exclusions: Qualified behavior, semantic equivalence across channels, independent visual/accessibility/domain review, provider admission, original task completion, native receipts and phase closure.

### PXD-076 — Central design grammar and pinned Shared dependency evidence

- Authority: User-delegated Media product/design owner under the 38-task PDP mandate; requirements and bounded source evidence only.
- Decision: Accept the central interface identity/authority/error/unknown/retry/cancellation grammar in `pdp-2-design-interface-system/interface-grammar.yaml`, plus the explicit density, reading-order, responsive context preservation and accessibility requirements in their owning PDP-2 files. Preserve all 47 existing template/layout selections; legitimate central pattern compatibility must resolve each applicable composition. A selection does not admit a rendered instance.
- Review: The Shared public reduced-motion defect was corrected at its Shared source owner, without changing Media's CSP. Shared main `c6d182af472c8954438f219c08d0202d1faa63a3` is a clean pinned development snapshot; nine isolated packed public artifacts and nine light/dark semantic alias paths pass consumer checks. Four Shared control tests and a Chromium computed-style check establish zero decorative transition duration for the four affected controls under reduced motion. Exact evidence is in `docs/implementation/verification/pdp-38/shared-artifact-consumer.txt` and `shared-control-motion.json`.
- Boundary: Pinned development consumption is permitted by P2-02's direct criterion; release publication is a separate excluded objective. Package manifest license metadata is not legal approval. The unconsumed ui-styles recipe candidate remains excluded with its unresolved bridge recorded. No Shared publisher/owner acceptance, full composed forced-color/keyboard conformance, independent human visual/AT review, component-family equivalence, comprehension approval or Lifecycle receipt is established by these source checks. The two canonical design gates remain pending.

### PXD-078 — Bounded public effect and finality taxonomy mapping

- Authority: Explicit user-delegated Media semantic/design ownership under the 38-task PDP mandate; definition mapping only.
- Decision: Authorize the exact per-action taxonomy candidates for the 144 existing Media actions in `public-effect-finality-taxonomy.yaml`, excluding the two externally owned Shared identity handoffs and the newly authored reconnect action. Local selection/session-draft effects map to local state change with the committed-source preservation boundary retained. Canonically bound commands, queries and ordered workflows map to an external call boundary; this does not assert domain mutation, successful execution, or operation completion. Ordered workflows preserve their operation order.
- Review: Exact action identities, original effect/finality/reversibility declarations, canonical operation identities and COMMAND/QUERY kinds are crosschecked by `tests/pdp-experience-public-taxonomy.test.mjs`. The mapping describes the authored definition, including unresolved truth. Conditional and unknown reversibility, and unresolved confirmation, must be emitted as their enum dispositions without Boolean coercion. Three historical reviewed public records preserve their original IDs and review chains.
- Projection conditions: Require this decision's exact bounded review marker, matching source envelopes, exact canonical operation references/kinds and supported taxonomy dispositions. Deny stale source values, forged review/admission markers, unresolved Shared roles, unsupported roles, and attempts to treat a read-only query as state mutation. The new reconnect action needs its separate source-specific review before projection. Current Tools source supports the enum contract; an older installed snapshot does not establish that support or public package publication.
- Boundaries: This approves candidate taxonomy mapping only. It does not establish guard truth, full action/journey behavior, component prop reachability, recovery correctness, runtime admission, whole P3 task completion, qualified independent acceptance or a Lifecycle phase receipt. Tools package-owner review and Shared contract binding remain separately evidenced dependencies.

### PXD-079 — Explicit pixel-center control convention

- Authority: User-delegated Media semantic owner; exact definition conversion only.
- Decision: Preserve the distinct pixel-boundary profile from PXD-074 and add `media.value.image-pixel-center` in canonical PDP-1 value objects. A zero-based rational center index names the first center at zero and last at dimension minus one. Its normalized mapping is `(index+1/2)/dimension` for the exact image version and dimensions; a one-pixel axis maps to one half. Top-left origin and right/down axes are explicit.
- Review: The executable definition oracle tests first/last and subpixel center round trips, the one-pixel case, maximum supported dimensions, exact half-pixel offsets, out-of-extent/border rejection, stale version/dimensions, incorrect axes and mutual center/boundary convention rejection. Nine temporal/spatial definition tests now cover the five selected profiles.
- Boundary: This closes the center-coordinate declaration/mapping meaning of MPSEM-0261-C005/C006 at its canonical source. It does not assign a convention to legacy wire coordinates, introduce implicit image transforms, establish camera/world-frame calibration or qualify vision/runtime/scientific behavior. Independent domain acceptance remains pending.

### PXD-080 — Canonical descriptor, source-time and fidelity requirements

- Authority: User-delegated Media definition ownership; canonical meanings reside in PDP-1 `value-objects.yaml#ownerDescriptorDefinitions`. PDP-0 `time-units-fidelity.yaml#ownerDescriptorDefinitionHandoff` references that authority while preserving historical proposal and runtime observations.
- Decision: Define six named contracts for image/video metadata, audio metadata, exact source frame/sample mapping, resolved visual geometry, simulation/domain fidelity and replay provenance. Technical metadata declares every slot as typed KNOWN, UNKNOWN or explicitly non-applicable; unknown slots cannot satisfy a profile's required known metadata. Image/color/alpha and audio mastering requirements remain independent from provider defaults. Immutable version references and exact color/LUT fingerprints bind the corresponding definitions.
- Timing/geometry decision: VFR maps retain exact original stream/clock/version PTS, DTS and duration ticks, including declared discontinuities; neither last-frame PTS nor total recording duration is guessed from a rounded fps. Changed-rate/normalized output requires a new artifact and explicit loss/provenance. Preserve 24000/1001 source cadence, explicit priming/padding, sample-rate conversion and drift mapping; unsupported drop-frame adapters remain unsupported. Display aspect, model dimensions and final crop/pad/scale are distinct. Exact display-aspect checking includes pixel aspect and rejects guessed preservation or unknown change authority.
- Fidelity decision: Canonical model/solver inputs explicitly name model/equations, initial/boundary conditions, solver/step/tolerances/integration, collision/mass/inertia/material and sampling contracts. Scene meshes are independent from collision representations; pivots and coordinate/unit transforms remain explicit. Domain-owner tier mapping and scientific fidelity cannot be replaced by photorealistic rendering or lowered by visual LOD. Replay claims require their exact class, predicate, metrics/tolerances, scope and source/output/execution provenance; unqualified evidence cannot support a replay claim.
- Verification: Five descriptor definition tests compile every declared JSON schema and exercise mandatory-slot omission, untyped/overflow/unknown-value denial, profile completeness, exact VFR/discontinuity mapping, display/pixel aspect, unauthorized aspect changes and fidelity/provenance boundaries. Nine existing conversion tests continue passing. These are definition oracles and structural contract checks; supplied metadata/evidence truth is not inferred.
- Boundary: No decoder capture, alpha/color round trip, encoder timing, mastering compliance, solver validity, domain-owner tier acceptance, qualified scientific review, actual replay, runtime eligibility/admission, whole P1-09 completion or Lifecycle proof is asserted. Legacy unspecified wire fields retain their explicit adapter gaps. A declared authority reference still requires the real authority's current verification before an effect.

### PXD-077 — Explicit same-session reconnect request definition

- Authority: User-delegated Media product/experience semantic ownership; bounded definition and candidate mapping only.
- Decision: Accept the additive `media.action.request-live-session-reconnect` as an explicit user request for a fenced transport/lease handshake on the same tenant-scoped existing DEGRADED live session. Its exact operation is `media.operation.capability.media-stream-session-reconnect`. Trusted tenant/principal/delegation come from the host, and the request fingerprint is server-computed; neither is accepted as caller body authority. Exact input1/input2/requestId wire fields bind the canonical PDP-1 request schema.
- Guard definitions: Match session/tenant/owner, current purpose-scoped consent and lease/fence, authoritative prior-frame outcomes, and exact safe next sequence. Missing, invalid, unknown, conflicting or mismatched evidence holds. Acknowledged frames ahead of the supplied fence are contradictory; a rejected next frame does not advance acknowledgment. The same-session recovery budget has an exact policy identity, current/exhausted/expired/unknown disposition, safe positive remaining allowance and future deadline relative to its owner observation; missing, expired or exhausted budget holds. Supplied definition facts are not real authority observations or a fresh dispatch-time check.
- Finality/recovery: A current session-owner receipt binds request identity/fingerprint, session, lease version and resolved frame outcome references. Transport/request acknowledgment does not assert CONNECTED, restored session, transmitted frame, completed processing or recalled prior disclosure. UNKNOWN remains unresolved and reconciles the same request; no blind replay, replacement session, automatic frame drain or new-key retry. Reversibility stays UNKNOWN and explicit user confirmation REQUIRED.
- Verification: Primary review checked canonical request/receipt and authority references, corrected trusted-context separation, rejected contradictory frame evidence, and added the previously missing budget guard. The coordinator repeated seven taxonomy/mapping tests and all 45 simulation tests successfully. These assert bounded definition consistency and fail-closed branches, not an actual reconnect.
- Projection: Authorize an exact public external-call candidate with UNKNOWN reversibility/undoability and REQUIRED confirmation, source-bound to this decision and the authored action envelope. No Boolean coercion, arbitrary decision substitution or widening of PXD-078's 144 original action scope is permitted. The two Shared identity handoffs remain separately unmapped.
- Boundary: The definition oracle always returns dispatchAllowed false and does not consume a budget, acquire a lease, verify actual consent freshness, send a frame or contact a provider. No whole P3 task completion, qualified behavior/independent phase acceptance, runtime admission or native Lifecycle receipt is established.

### PXD-082 — Requested Media identity adapter boundary

- Authority: User-delegated Media product definition ownership. Shared retains authentication, identity, membership, delegation and authorization authority.
- Decision: Approve Media's requested adapter-normalized context contract at `pdp-3-product-experience/handoff-bindings.yaml#handoffs.media.handoff.identity.mediaOwnerDefinition`. Anonymous first-use initiation and authenticated explicit workspace selection are separate. Only allowlisted continuation references, opaque user-selected workspace references and non-secret correlation data cross the Media request boundary; caller credentials, content and authority claims are rejected. The host establishes the interaction nonce and identity context out of band.
- Review: The coordinator repeated five identity definition tests after correcting initial anonymous access, all-outcome owner verification, exact immutable owner pin, nonce/route/workspace and principal/tenant binding, selection evidence, canonical UTC timestamps and freshness. Missing, malformed, contradictory, foreign, expired or unverified facts hold rather than establishing a context. Denial and revocation responses cannot bypass these checks. Invalid options and injected or inherited fields fail closed.
- Boundary: These are proposed Media adapter fields, not existing Shared wire names or signature verification. The pure evaluator accepts supplied definition facts only; its acceptable disposition does not establish authentication, authorization, actual fresh authority, live adapter behavior or runtime admission. The two public Shared action mappings remain withheld until the exact owner contract and consumable artifact are provided under Shared issue 242. No independent acceptance, whole task completion or Lifecycle phase receipt is issued.

### PXD-083 — Formal Media component prop definitions for candidate projection

- Authority: User-delegated Media definition ownership; applies to the 28 contract-only families in `pdp-2-design-interface-system/component-contracts.yaml`. Preserve the three existing public-source family dispositions.
- Decision: Permit candidate required-prop mapping from these exact formal definitions and `component-value-types.yaml`. Resolve every named value schema and canonical view, registered route, action and intent reference. Preserve closed shapes, exact tenant/version tuples, declared state/variant pairs and family-specific invariants. Temporal values use bounded decimal representations and the canonical PDP-1 conversion oracle; half-open intervals require exact same-clock ordering.
- Review: The coordinator corrected nonexistent route references, self-asserted identity readiness, unbounded time representations and invalid consent examples. Context-ready requires the separately supplied host-created request, immutable expected owner pin, current time and registered-route policy; supplied component metadata cannot create trusted authority. The coordinator repeated the component/composition suite: 13/13 passed, including adverse fields, same-process mutation isolation and a changed-source cache-freshness case.
- Reviewed cut: Component contracts SHA256 `5d5eb8711b84b2666b1a593a00e62c4ec935966d6f9e4f65f19385aade6ea290`; value types `2a9d0209151c6c1879906dbdfccd6cdf265ee06de4c7c700a773150cada417ef`; validator `7197f7b6cd0ebf6a4e774ca66466702fa6eaa2b3e2108702f3a82b27699b6d90`; component tests `dff0b9b84f349dd078a593a77e6d16a2267387a521b5f23b25ccbbca70aeee7e`. A later source change requires explicit impact review or retest.
- Boundary: Approval covers formal source prop/type projection only. It does not bind a Shared export for these families, implement or admit a renderer, verify supplied observation truth, establish assistive-technology/visual conformance, complete a whole PDP task, replace independent acceptance or issue Lifecycle evidence.

### PXD-084 — Record the bounded migration owner-source semantic review

- **Authority:** user-delegated Media semantic definition ownership; coordinator source review.
- **Approved scope:** exactly 81 claim-specific owner-source routes recorded in `docs/implementation/verification/pdp-38/migration-coordinator-review.json`. The record set preserves exact claim IDs, source text hashes, target references and reviewed value hashes. This review follows corrections to import authority, estimated versus ground-truth results, model acquisition and fallback, quantity conversions, route continuity, package compatibility and public dependency ownership.
- **Historical scope:** `MPSEM-0160-C001` is an execution-scope supersession under the current 38-task mandate. The historical Explorer requirement remains program truth; scope supersession does not establish semantic parity.
- **Excludes:** all unreviewed migration fragments, whole-task source completion, qualified independent acceptance, publisher or legal authority, runtime admission and Lifecycle phase receipts. Later source changes require a new bounded review of their material impact.
### PXD-081 — Exact capability applicability for the four original business measures

- **Authority:** user-delegated Media semantic definition ownership; coordinator source review.
- **Approved scope:** 1,848 normative exact leaf-by-measure dispositions for 462 capabilities, with 462 nonnormative projection bindings. Preserve the original four PXD-048 measurement definitions. Source candidate counts are 430 output producers, 394 execution-profile operations, 445 potentially asynchronous or uncertain persisted operations and 462 reuse trace leaves. Qualified and admitted measured populations remain unevaluated.
- **Review:** local processing and uncertain execution remain provider candidates; durable writes and all nine recipe commands remain recovery candidates. Recipe specification does not grant agent dispatch but may still have ambiguous persistence. Exclusions use exact operation roles and owner contracts; lack of a background worker, package presence or existing successful outputs cannot narrow the denominator. Bounded query pagination is distinct from a resumable execution identity.
- **Verification:** the coordinator repeated eight measure tests and directly validated all 1,848 live-source pairs. The review caught and corrected 135 discrepancies between normative records and projected reasons/source references before approval. The exact reviewed cut, candidate counts and output digest are in `docs/implementation/verification/pdp-38/measure-source-review.json`.
- **Excludes:** actual measurement, numeric target selection, calibration, provider admission, runtime implementation, whole-task completion, independent acceptance and Lifecycle receipts. Baselines and qualification remain NOT_EVALUATED; targets remain NOT_SET. Later source changes require bounded impact review.
### PXD-085 — Bounded dependency, constitution and qualification migration routes

- **Authority:** user-delegated Media semantic definition ownership; coordinator source review.
- **Approved scope:** exactly 46 additional claim-specific routes in `docs/implementation/verification/pdp-38/migration-policy-source-review.json`, preserving exact source text hashes, target references and reviewed owner values. This cohort is separate from the 81 PXD-084 routes.
- **Review corrections:** retain patent uncertainty in exact license scope; quality and delivery profile identities/versions in cache identity; applicable solver identity/configuration/numerical bounds in reproducibility; all Simple/Guided/Expert controls over the same state/actions; and existing authentication/security/governance reuse through exact reviewed public boundaries. Diagnostic delivery remains distinct from required audit intent; locale fixture requirements do not admit a locale.
- **Verification:** the coordinator repeated the dependency, constitution and qualification cohort suite: 14 tests passed, including missing material clauses, wrong references, stale digests, altered membership and forged acceptance. Reviewed values and the output digest are retained in the exact cohort artifact.
- **Unresolved:** `MPSEM-0166-C004` remains open because the historical OSS inventory file is absent. Public owner-contract adoption, package publication, legal decisions and actual qualification are dependencies, not inferred from the authored clauses.
- **Excludes:** every other migration claim, complete migration parity, whole-task completion, independent phase acceptance, runtime admission and Lifecycle receipts. Later target changes require explicit bounded impact review.

### PXD-086 — Exact profile and cross-product handoff migration meanings

- **Authority:** user-delegated Media definition ownership; coordinator original-claim and owner-source review.
- **Approved scope:** exactly 57 additional normative routes in `docs/implementation/verification/pdp-38/migration-profile-handoff-source-review.json`; none overlap PXD-084 or PXD-085. The single `MPSEM-0469-C001` row label is nonnormative metadata, supported by the original table's first cell; its contract and boundary cells remain separately normative.
- **Corrections:** complete typed artifact input/output requirements; cancellation, retry and reconciliation; local and generic inference ownership; codec/transport/recording/reconnect/latency profile bindings; strict preserve-mode meaning; structured requested/effective profiles; finite canonical command aliases; campaign workflow ownership; and distinct Media, Agent Runtime and Action Plane authority. Similar names, opaque references and generic destination-owner descriptions cannot substitute for these meanings.
- **Verification:** the coordinator repeated all five related suites: 22/22 passed. Earlier incorrect target expectations were replaced with an exact cohort partition, preserving material mutation tests. The artifact retains original claim hashes, exact reviewed target references/values and hashes, and the raw verification-output digest.
- **Excludes:** all remaining migration claims, external-owner contract adoption, legal or scientific authority, independent acceptance, whole-task completion, runtime admission and Lifecycle receipts. Later material target changes require bounded impact review.

### PXD-087 — Bounded state meanings and local request uncertainty

- **Authority:** user-delegated Media semantic definition ownership; coordinator review.
- **Approved scope:** exactly 22 additive machine/dimension state meanings and 18 LOCAL_UNKNOWN predicates in `docs/implementation/verification/pdp-38/state-uncertainty-source-review.json`. Historical state extraction remains intact. QUEUED means no executing attempt; a claimed lease before dispatch does not itself imply execution.
- **Uncertainty:** only an exact current command action/operation/request/fingerprint/local-observation tuple can derive transport uncertainty. FALSE requires NOT_SENT and NOT_WAITED together. A received response remains UNKNOWN until its exact operation result and scope/finality are validated. Query-only rows cannot infer command-effect uncertainty or remote state from query loss. No local transport observation authorizes replay.
- **Review correction:** twelve written predicates initially classified an unvalidated received response as FALSE while the evaluator returned UNKNOWN. Written meanings and evaluator now agree, with exact source-text regression checks.
- **Verification:** coordinator repeat passed all 14 state/observation tests. The artifact retains the reviewed values, source/test fingerprints and raw output digest.
- **Excludes:** other view predicates, actual state/consent/licensor observations, external authority acceptance, dispatch or retry permission, whole-task completion, qualified independent review and Lifecycle receipts.

### PXD-088 — Preserve review serialization and bound one additive policy impact

- **Authority:** user-delegated Media definition ownership; coordinator current-target impact review.
- **Serialization:** PXD-084 hashes UTF-8 `JSON.stringify(value)` for every target, including strings. PXD-085 and PXD-086 hash raw UTF-8 strings and JSON-stringified objects. The 68 apparent PXD-084 string discrepancies are encoding differences; their exact JSON hashes still match the immutable review. Do not rewrite those historical hashes or silently accept either encoding.
- **Approved impact:** only `MPSEM-0388-C003` acquired the additive `hardwareFootprintDoesNotWaiveAdmission` field. Removing that exact field reproduces the original PXD-084 object hash. The new field denies treating hardware fit or local package presence as model acquisition, license, privacy, security, profile or qualification permission; it preserves all prior deny-default acquisition/fallback behavior.
- **Verification:** coordinator repeated the material capability and glossary/domain suites: 16/16 passed. `migration-reviewed-source-impact.json` preserves previous/current hashes and the complete reviewed current value. This is an impact review of an already counted claim, with no additional completion count.
- **Excludes:** actual acquisition or fallback approval, other material source changes, legal or independent acceptance, runtime qualification and Lifecycle receipts.

### PXD-089 — Retire two direct PDP-0 definition criteria

- **Authority:** user-delegated Media product-definition ownership; coordinator full-population source/negative-fixture review.
- **P0-01:** approve the direct definition criterion for all 462 unchanged leaf identities, with exact owner dispositions, typed canonical operation or existing-operation bindings, profiles, bounds and channel applicability. Missing, substituted, duplicated and stale references fail coverage checks. Historical 383-unresolved coverage observations remain historical; task dependencies and phase acceptance are separate.
- **P0-02:** approve the direct definition criterion for 448 closed canonical request/result schemas, 14 exact existing-operation bindings and 170 material payload schemas. Every one of 14 NFRs has a distinct owned measurement definition with exact metric/unit/population/protocol/abstention/evidence and real source references. Six proposed performance surfaces have individual measurement boundaries, initiated-request/error/censored-outcome treatment and an exact percentile method; environments, observations and approvals remain unmet where stated.
- **Verification:** coordinator repeated eight full-population schema/leaf/NFR tests, including required-field omission, overposting/trusted-context injection, unknown/rejected result contradictions, wrong/missing reference and same-count NFR substitution. Existing PXD-081 separately covers the exact four-business-measure applicability population. The current review artifact retains source/test fingerprints and raw output digest; source changes require relevant currentness review.
- **Reporting:** `direct-definition-criteria-review.json` permits only these two current direct-definition predicates to be reported satisfied after their current verification passes. Original full ledger status, dependencies, independent or publisher acceptance and Lifecycle phase currentness remain separate and unpromoted.
- **Excludes:** P0-03 migration parity, other PDP task criteria, actual implementation/availability/qualification, SRE/AT/legal/scientific acceptance, independent phase review and Lifecycle receipts.

### PXD-091 — Approve bounded journey-claim owner routes

- **Authority:** User-delegated Media product-definition ownership; coordinator material-semantic review under the current PDP-0–PDP-3 mandate.
- **Approved scope:** Exactly 24 normative migration claims and one nonnormative REV-12 heading classification in `docs/implementation/verification/pdp-38/migration-coordinator-review-25.json`. The normative claims route to their exact current Media owner definitions; the metadata record proves the complete source row and preserves C002–C004 as separate normative claims. Prior target references and hashes remain in the immutable proposal record.
- **Verification:** The journey semantic suite and coordinator review each passed 4/4 checks. The review checks exact cohort membership, current `JSON.stringify` target pins, the full REV-12 row and its neighboring claim boundaries, and partial cancellation, security, finality and offline cases.
- **Excludes:** Any additional migration claim, migration/task completion, independent specialist or native acceptance, runtime admission, external-owner qualification, and Lifecycle receipt. Source-definition approval does not promote a journey or phase status.

### PXD-092 — Reopen capability criteria after material contract review

- **Authority:** user-delegated Media definition ownership; coordinator material review of published source.
- **Finding:** eleven simulation pass leaves share an output without a pass discriminator and with input-shaped fields; thirty-three simulation crosswalks confuse input SimulationWorld provenance with output; eighteen edit leaves share generic controls/results without exact operation restrictions.
- **Current disposition:** P0-01 and P0-02 require corrective implementation and material reassessment. Preserve PXD-089 and its actual passing tests as history; do not infer satisfaction from unchanged hashes or those tests. P0-04, P1-06 and P2-01 remain separately verified.
- **Required verification:** all affected leaf inputs/outputs reject cross-operation substitutions, absent output identity/provenance and unsafe preservation; source crosswalks name actual outputs. The new source cut must be reviewed before closing this correction.
- **Acceptance boundary:** no original full-task completion, independent phase acceptance, external owner qualification or native Lifecycle receipt is granted.

### PXD-090 — Bounded approval of 112 migration owner-source meanings

- **Authority:** User-delegated Media product-definition ownership; coordinator material-semantic review under the current PDP-0–PDP-3 mandate.
- **Approved scope:** Exactly 109 normative claim routes and 3 nonnormative metadata classifications from the 112-record proposal in `docs/implementation/verification/pdp-38/migration-coordinator-review-112.json`. The normative records preserve complete claim meaning at exact current owner selectors and hashes; the metadata records identify source row labels without product requirements. The immutable proposal artifacts and each claim's previous target references/hashes remain historical evidence.
- **Source impact:** Additive owner rules in goals, domain model and handoff sources are isolated by `migration-goals-owner-source-impact.json`, `migration-domain-model-owner-source-impact.json` and `migration-handoff-owner-source-impact.json`. Removing only each listed addition reproduces the prior reviewed parsed source tree. Existing goal success measures and earlier PXD-084/085/086 cohorts remain unchanged. This approval does not revive superseded execution sequencing from the former 71-task program; historical program truth is retained separately.
- **Verification:** `tests/pdp-migration-coordinator-112-approval.test.mjs`, the goal/domain/glossary/temporal owner-review suites, and the semantic-reconciliation and profile/handoff source-review suites verify exact membership, immutable proposals, source hashes, prior references, the 109/3 partition, current ledger states, source-impact deltas and rejection of unrelated target or acceptance changes. Local focused output was rerun after fixing the source-impact and target-hash encoding assertions.
- **Excludes:** Any other migration claim, task completion, independent specialist acceptance, publisher/legal approval, runtime admission, qualified behavior, or Lifecycle phase receipt. All prior review cohorts and their pins remain immutable; any later source-value changes require a new bounded impact review.

### PXD-093 — Approve the materially corrected capability source criteria

- **Authority:** user-delegated Media definition ownership; coordinator material review after PXD-092.
- **Scope:** current P0-01/P0-02 direct source criteria: 462 leaf identities, 448 effective schemas (419 base and 29 exact overlays), 11 distinct simulation outputs, 18 controlled edits and 33 actual-output crosswalk corrections. Selected profile identity/version, initial-state references, request pass contract, source artifact/version, preservation, MIME modality and provenance are bound exactly. Historical base interfaces are preserved.
- **Verification:** 21 wire/schema/NFR/quality/output tests and 14 leaf/measure tests passed on unchanged cuts; 9 additional current identity/output tests passed after the domain namespace correction. Immutable source and raw-log hashes are recorded in `docs/implementation/verification/pdp-38/corrective-criterion-review.json`. The earlier 15-test corrective observation is preserved separately and does not replace this final review.
- **Limits:** source criteria approval only. Original full-task statuses, dependencies, migration reconciliation, independent/publisher/specialist acceptance, runtime qualification and Lifecycle receipts remain separate. PXD-089 and PXD-092 remain historical; later material edits require review.

### PXD-094 — Approve seven typed observation definitions and their experience labels

- **Authority:** user-delegated Media definition ownership; coordinator material review.
- **Scope:** rights, quality evidence, profile qualification, provenance coverage, declared options, quality recommendation/bounded repair plan and language uncertainty. The five previously unresolved experience labels use exact source-owned query contracts and trusted correlation/subject/authority/read-version/freshness tuples. Nested plan scope, budget/preservation controls, requested kinds and language-specific evidence are validated; unknowns remain explicit. Complete query coverage with no assessments is an observed no-plan result, never readiness.
- **Verification:** 28 source-model tests passed on an unchanged before/after cut, including missing/stale/foreign scope, malformed ready plans, unpaired profiles and explicit negative/unknown observations. Hashes and raw logs are in `docs/implementation/verification/pdp-38/owner-query-current-cut-review.json`.
- **Limits:** no query endpoint, rights grant, provider qualification, action execution, complete 130-step/31-scenario acceptance, qualified independent review or Lifecycle receipt is claimed.
