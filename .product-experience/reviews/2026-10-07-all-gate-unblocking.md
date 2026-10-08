# Media PDP-0—PDP-3: remaining-gate owner decisions and executable resolution contract

**Decision:** MEDIA-OWNER-GATES-2026-10-07 (PXD-027 proposal for bounded policy approval)  
**Observed baseline:** `main@996181731a5017caaf6156b797953104682dd414`, October 7, 2026.  
**Authority:** Media product owner by explicit user delegation; does **not** substitute for Ghatana Tools, Shared, Lifecycle, security/legal, independent accessibility, or domain-scientific owners.  
**Rule:** No permanent PENDING by policy ambiguity; no false acceptance by moving an unresolved finding out of a denominator.

## A. Decisive acceptance boundary

PDP-0 defines full product truth and scope; PDP-1 defines canonical domain objects, operations and state; PDP-2 defines reusable design and API/CLI/SDK/event interface grammar; PDP-3 defines all applicable user and machine experiences. These are **definition artifacts**; production deployment, trained weights, binary codec activation, serving capacity and an actual product host are independent downstream claims, not blanket preconditions for accepting definitions. Phase acceptance does require that each applicable authored obligation is complete, consistent, falsifiable and independently reviewed where applicable.

Each record must carry `normative status`, `implementation status`, `license admission`, `technical qualification`, `runtime availability`, `specialist review` and `evidence/currentness` as distinct dimensions. `PENDING` is not an approvable synonym for `NOT_APPLICABLE`. A source-justified `NOT_SELECTED_FOR_CURRENT_PROFILE` may exclude *implementation* but cannot erase a normative contract selected for product scope. Historical plan blocks remain in the ledger until each claim is owned or explicitly historical.

## B. Remaining ProductDefinition field decisions — original 12

Two fields now have a direct owner-selected source in `goals-jtbd.yaml` and generator mappings: **nonGoals**, **businessIntents**. Their meanings are now independently reviewable, but the generated artifact must be refreshed and checked.

| Field | Owner disposition and exact completion rule |
| --- | --- |
| nonGoals | **SELECTED**: explicit product exclusions with `id/description/reason`. Do not reinterpret ownership exclusions as removal of integrated Media functionality. |
| businessIntents | **SELECTED**: reuse, trustworthy versions, bounded providers, recoverable jobs with traceable intended measurement. No invented baseline/target values. |
| userIntents | Bind every intent to one accountable *initiating* actor and an explicit `must/should/could/wont` priority, preserving all participating actors. Do not arbitrarily select the first actor. For intrinsically co-equal collaboration, add an explicit orchestration actor or request a Tools multi-actor schema extension; do not misrepresent a partner as the sole actor. |
| requirements | Restore `traceToIntentIds` only after every target intent, actor and priority resolves; reject orphan and duplicate identity. Source `requirements.yaml` remains normative. |
| domainRules | Project domain-safety principles from accepted PDP-0 requirements and accepted PDP-1 rule references only; PDP-1 retains detailed canonical behavior ownership. Do not independently author a second PDP-1 engine in ProductDefinition. |
| invariants | Require `statement` and concrete `violation` meaning per rule. At minimum unauthorized effect = deny/audit; stale fence = reject commit; uncertain remote finality = reconcile; corrupt source = quarantine; consent/rights mismatch = prevent new effects. Preserve exact source IDs. |
| journeys | Record primary initiating actor per 30 journeys with explicit co-actors, stable step identities and resolved desired outcomes. Avoid flattening multiactor workflows by inference. |
| trustContexts | Select Tools enum `public`, `authenticated`, `privileged`, `admin` by data/effect sensitivity, not by `human` vs `machine` principal kind. `auditRequired` must be explicit, with sovereignty/restricted-media constraints where applicable. Trust classification never grants runtime permissions. |
| successMeasures | Bind to declared goals/quality profiles and observable evidence. Require numeric bounds only when defined in an admitted profile; otherwise record normative qualitative or binary pass criteria with explicit target owner, never fabricated latency, accuracy or coverage. |
| ownershipRules | Bind each concern to exactly one Ghatana Shared, Tools, Lifecycle, platform, Document Intelligence, TutorPutor or Media *contract owner*, retaining separate implementation and review/accountability roles. No sibling private-source imports. |
| createdAt / updatedAt | Explicitly distinguish projection-build timestamps from authored semantic timestamps. Tools creation/update fields may be sourced from the deterministic projection generation event; only a separate authored source observation may claim semantic record inception or update. Do not call a generated timestamp owner acceptance or currentness. |

**PDP-0 462-leaf denominator:** 77 source-confirmed direct journey links, two MDI-001 platform leaves, 383 individually unresolved according to the latest implementation summary. The 383 must be routed per leaf to exact journey step, API/CLI/SDK/agent operation, supported read model, explicitly named platform contract, or reasoned owner-reviewed exclusion. Generic channel aliases do **not** count. Ensure capability identity, normative requirement and operation-specific conditions are independently traceable. Do not claim the 383 resolved by approving this routing taxonomy.

**Migration:** 349 unresolved semantic blocks and 123 mixed blocks require claim-level decomposition. Two partial mappings do not close their parent blocks. Source and revision provenance are retained; route accepted normative claims to exactly one phase, observed implementation to non-normative compatibility inventory, and historical migration instructions to historical records. Duplicate canonical meaning is a regression.

## C. ExperienceLanguage — six owner-source selections

The owner now selects `simple → minimal`, `guided → standard`, `expert → rich` explicitly rather than assuming public enum equivalence. `typography-layout.yaml` owns density, presentation profile and progressive disclosure contracts. `accessibility.yaml` now selects **WCAG 2.2 AA** as the graphical/Web target, without certifying conformance. `action-finality-grammar.yaml` distinguishes automatic *read-only observation* reattachment from explicit manual effect/retry recovery. `gui/recipes/catalog.yaml` owns eight Media GUI composition recipe identities referring to actual PDP-2 template and pattern IDs, distinct from Media processing recipes and unadmitted Shared executable exports.

The generator must project six fields directly: densityProfiles, presentationProfiles, progressiveDisclosureRules, accessibilityRules, recoveryPatterns and recipeBindings. Validate enum, unique ID, exact references and required booleans; reject empty fallback. These are **source semantic mappings**, not independent visual, security, Shared owner or screen-instance acceptance. Regenerate canonical candidates with the existing generator, then run its drift checker and public Tools validators. Never hand-edit generated candidates.

## D. ExperienceSpecification — 14 exact completion contracts

| Field | Required source-only resolution and negative oracle |
| --- | --- |
| componentContracts | Public PDP-2 component ID, required typed props, variants, states, a11y behavior, layout/token/port and version. Reject missing required props or nonexported implementation. |
| views | Each of the 47 canonical screens plus applicable machine views resolves component/template/layout, state, action, journey, exact data authority and host/channel applicability. Reject bare route preview as execution. |
| journeys | Every one of 30 journeys declares primary actor plus co-actors, 130 source-preserved steps, operation, authority, outcome, failure, degraded/recovery and postcondition refs. Reject inferred effect from navigation. |
| interactions | Allocate per-interaction preconditions, active principal/context, immutable version, policy checks, confirmation, effect and denied/unknown handling. |
| states | Bind all applicable states to one accepted PDP-1 machine ID, not similarly spelled legacy UI labels. Reject `RETRYING` or `CANCELLING` as canonical job status. |
| transitions | Require source/target, trigger, guard, actor/delegation, version/fence and effect finality. Reject stale fence, disallowed retry and illegal transition. |
| actions | Associate every typed user/machine action with canonical command/query or explicit client-only/navigation disposition, not merely a plausible operation family. |
| effects | Distinguish local draft, read, job accepted, external dispatch, durable write, delivery and irreversible action; associate exact scope and reversibility with authoritative operation. |
| finality | Define accepted, running, unknown, success, partial, failure, cancel-requested, cancel-confirmed and delivery-ack roles independently. Reject timeout-as-failure and request-as-cancelled. |
| recovery | Join exact failure/uncertainty classification to permitted observation, retry prerequisites and preserved state; never blind replay. |
| scenarios | Link each happy, denied, stale, conflicted, offline, partial, unknown, cancel-racing and corrupted-input scenario to a canonical starting context/state and expected oracle. |
| fixtures | Version synthetic inputs and outcomes by source fingerprint, rights/trust context and provider absence; map to scenarios without presenting simulation as live qualification. |
| search | Define product-owned searchable entity, authorization/filter/sort/pagination/error/staleness behavior in PDP-3; Tools Explorer only projects the accepted semantics. |
| inspections | Define product-owned inspectable request/result/state/provenance/approval contracts for API/CLI/SDK/Agent and GUI surfaces; Tools inspector is host mechanics, never canonical Media meaning. |

A 47-route × six-viewport clean console audit and Tools/Product same-renderer DOM parity are useful verified smoke evidence; neither is an independent full interaction/assistive review. Production-host parity moves to *actual product adoption readiness*: the public `MediaProductRenderer` interface and identical fixture behavior are sufficient definition-level requirements. An absent production host is **NOT_RUN/NOT_APPLICABLE_TO_DEFINITION_HOST**, not a fabricated pass.

## E. Parity: 47 findings, 44 dispositioned, three previously open

1. **TypeScript schema/type-to-domain role catalog:** implement exhaustive exact source-role mapping for 19 public types and 20 schemas at `interface-parity/typed-contract-bindings.json`; fail on missing, duplicate, stale or falsely accepted identity. This is *source role reconciliation*, not wire/provider parity. Code and focused negative tests have been added in the current branch; require execution before calling this particular finding resolved.
2. **Four Agent Tool handlers:** create precise per-tool input/output/error/version/authority/delegation/idempotency/timeout/cancel/unknown-outcome contracts with a typed canonical PDP-1 operation. Compare actual Java handler schema/adapters against the authored contract. Keep unqualified calls `NOT_ADMITTED` and separately verify runtime equivalence; do not pass on name similarity.
3. **PDP-1 operation semantic admission:** formally accept the nine families as organizing taxonomy, but bind individual commands/queries/state transitions/transport effects before accepting an operation. Preserve every wire/SDK/CLI/event identity and `NOT_ADMITTED` compatibility disposition; no generic `scopeStatus: accepted` shortcut to green.

TypeScript type-role reconciliation is only one dimension of the parity denominator; any runtime/service/client divergence remains its own explicit compatibility task. No parity finding is simply deleted.

## F. Seven PDP-2 design authority / independent-review gates

1. PDP-2 style policy: approve semantic role and canonical Shared source ownership; do not claim Shared component qualification.
2. Shared public package binding: require the exact exported tokens, headless parts, CSS and versioned immutable artifact consumer verification; development SNAPSHOT observations remain development evidence.
3. Visual/accessibility conformance: require independent actual visual and supported screen-reader reviews of task, waveform/caption, async job, rights and critical failure variants; automate keyboard, zoom, forced colors, reduced motion and localization separately.
4. Semantic token aliases: validate every token ID and light/dark Shared public role; owner accepts aliases independently of release artifact qualification.
5. Semantic component bindings: map actual public exports and prop/port contracts; reject candidate or missing exports even when their names resemble components.
6. Template catalog: accept Media-owned template grammar only with schema and referential checks; distinguish reusable template definition from 47 screen-instance acceptance.
7. Layout grammar: owner-select reading hierarchy/reflow/focus requirements; verify all 47 applicable layout instances and independent representative critical interactions.

The source scan reported zero unexplained product-source observations. That is useful but does not resolve the seven gates. Assign independent visual and accessibility reviewers by *review competence* and exact tested scenarios; the Media owner cannot impersonate their findings.

## G. Lifecycle: the 318-obligation truth and provider boundary

Read from the October 7 source obligations: **38 PDP-0**, **130 PDP-1**, **73 PDP-2**, **77 PDP-3**. PDP-0 has 38 nonempty case memberships, PDP-3 has 24; **256 still have no case membership**. **All 318 have empty observer and oracle memberships**. They are source anchors, not evidence.

Adopt one requirement-scoped proof plan: `obligationId → exact source requirement/contract → proof-case IDs → proof method → verifier/observer identity → oracle/evaluation contract → producer/provider binding → source dependency fingerprint → actual Lifecycle result`. Use the fixed Tools Evidence Generator proof provider, not a Media clone. The real provider in current Lifecycle registry is `ghatana-tools.evidence-generator@1` with `proof-producer` capability; its provider reference must match current semantic identity and the admitted Tools registry. The published contract package is still `UNLICENSED`; do **not** relicense it unilaterally or claim that an isolated locally deployed artifact authorizes distribution. The tools-root/protocol-root import and registry digest must resolve entirely through supported public owner contracts rather than private sibling source paths.

The owner decisions to build proof cases, run affected tests, appoint appropriate qualified reviewers and connect existing evidence producers are approved. **Lifecycle INPUT_READY requires real admitted providers/cases/observers/oracles**; local source preflight, owner comment and empty array are not valid stand-ins. Lifecycle alone issues CURRENT/CLOSED and receipts.

## H. Dependencies and explicit exception handling

- **Shared:** the UI component/theme/token public binding must be qualified from a versioned artifact; license/SBOM graph includes test-only and shipped dependencies separately. Retain accessibility assurance rather than bypassing it for an MPL dependency.
- **Tools:** release the public ProductDefinition, ExperienceLanguage, ExperienceSpecification, product-dev-explorer, design-system-tooling and assurance consumer contracts; solve schema mismatches in the owner contract instead of inventing Media-only schema copies.
- **Lifecycle:** fix stale pre-split Evidence Generator ownership docs and post-split provider registry references at the *owning* repo. Register admissible proof classes/producer methods and exact consumer binding.
- **Document Intelligence:** MDI-001 stays authoritative; generic OCR client must be consumed through its own published client. No Media model/runtime duplication.
- **Media technical profiles:** unlicensed models, codec binaries, sample assets, fonts and hardware are `NOT_ADMITTED` for affected deployment profiles. Do not block unrelated definition-only work or claim runtime capabilities that are not available.
- **Domain review:** appoint qualified simulation/scientific, audio/visual quality, privacy/rights, security and accessibility reviewers for affected semantics only; no role-name-only approval.
- **Migration:** source cutover and legacy consumer inventory are operational launch gates, not alternate Product Truth authority.

## I. Ordered implementation and verifiable exits

| Order | Work | Exit |
| --- | --- | --- |
| 1 | Regenerate from new PDP-0 non-goal/business-intent and PDP-2 owner-selected source records | Public schemas pass, exact refreshed source digests, no stale candidate/projection drift, relevant field blockers clear |
| 2 | Resolve the remaining PDP-0 capability and migration claim populations with source-backed individual dispositions | Zero unexplained applicable leaf/migration normative gaps, complete actor/intent/requirement/outcome refs |
| 3 | Reconcile detailed PDP-1 operations, state, authority and all interface identities | Exact identity-level disposition and negative tests; no unchecked status shortcut; structural parity and semantic parity reported separately |
| 4 | Finish PDP-2 reused component/token/template/layout chains and 47 screen instance contracts | No unresolved direct source mappings, public Shared exports, design rules, independent review |
| 5 | Finish all 14 PDP-3 mapping groups and machine-channel inspections | Validated semantic view/step/action/state/effect/fixture/search/inspection graphs and realistic negative test matrix |
| 6 | Submit actual requirement-scoped cases/observers/oracles to owner-qualified Tools + Lifecycle providers | 318 applicable obligations each have admitted proof route; freshness dependencies recorded; Lifecycle native evidence computed |
| 7 | Lifecycle evaluates current phase acceptance and downstream activation as separate decisions | Four phase receipts generated by Lifecycle, with scoped implementation/release blockers maintained independently |

**Nonclaims for this review:** no 383-leaf bulk acceptance, no historical mixed-plan blanket acceptance, no independent visual/AT signoff, no model/codec/license certification, no invented producer, no release, no fake phase receipts.
