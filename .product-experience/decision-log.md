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
     proposal actions without operation references. PXD-007's later exact
     partition is 11 single proposed links, one ambiguous link, and 134
     unresolved actions; its nine logical families still do not establish
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
  12. PDP1-002's current proposal partitions 146 actions into 11 single
      proposed mappings, one ambiguous mapping, and 134 unresolved actions;
      it inventories 27 HTTP IDs, 43 gRPC identities (24 proposed family links,
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
- **Approved:** `operations.yaml` contains nine distinct logical-operation
  proposals, each with the plan's 22 required contract fields. Source inventory
  and proposal mappings are explicitly separated. The current source
  denominators are recorded without collapsing scopes: 146 UI actions split
  into 11 single proposed links, one ambiguous link, and 134 unresolved; 27
  HTTP operation IDs; 43 service-qualified gRPC RPCs with 24 proposed family
  links and 19 unresolved identities; 11 synthetic fixture CLI commands plus
  a distinct 12-command broader proposal registry; 27 SDK registry IDs; four
  Agent Tool handlers; and 15 observed event names. Duplicate-key-safe local
  YAML and source-set checks passed. This approves the inventory/proposal
  structure, not any operation boundary, field meaning, or mapping.
- **Comments returned:** 134 UI action links remain unresolved and
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

### PXD-018 — Approve PDP3-002 machine-interface source registries, with comments

- **Status:** approved for exact interface inventories and proposal-level protocol records only; no wire or operation semantics are accepted.
- **Approved:** all 27 OpenAPI operationIds match the observed runtime route manifest; all 43 active gRPC RPCs across the four governed proto services have records with directly available message and streaming metadata. OpenAPI and protobuf remain projection/implementation observations. PDP-1 is the intended semantic authority only after its acceptance.
- **Comments returned:** all 27 HTTP logical-operation bindings and 19 gRPC logical-operation bindings remain unresolved; 24 gRPC source-explicit crosswalks are still proposals. Route/proto membership proves neither semantic parity nor auth, state/effect, finality, privacy, idempotency, retry, cancellation, or event guarantees. Owner review found and corrected four unquoted JSON Pointer scalars in `api-registry.yaml`; `#` begins a YAML comment unless the value is quoted.
- **Excludes:** canonical wire-authority selection, PDP-1/PDP-3 semantic acceptance, API/provider owner acceptance, production support, or release readiness.
- **Evidence:** `ACCEPT-INPUT-PDP3-002`; 27 HTTP and 43 gRPC per-operation records; route-manifest identity parity; duplicate-key-safe YAML checks; `node scripts/check-media-contract-parity.mjs`.

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
- **Comments and uncompleted checks:** The reported 383 remaining capability leaves, 349 unresolved and 123 mixed migration blocks, remaining PDP-0/3 field crosswalks, Agent Tool contract parity, PDP-2 Shared/adjudication and independent visual/assistive review, and Lifecycle provider licensing/receipts are still genuine work items. Proposed generator outputs must be refreshed and tested; approvals here cannot be fabricated into runtime evidence or currentness.
- **Evidence/decision:** [All-gate owner decision and exact exit criteria](./reviews/2026-10-07-all-gate-unblocking.md), `.product-experience/pdp-2-design-interface-system/gui/recipes/catalog.yaml`, `.product-experience/interface-parity/typed-contract-bindings.json`, `ACCEPT-INPUT-MEDIA-OWNER-GATES-20261007`.
- **Excludes:** per-leaf blanket acceptances, independent domain/legal/accessibility certifications, broad external API owner approval, production media codec/model admission, phase acceptance and Lifecycle issuance of receipts.

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
