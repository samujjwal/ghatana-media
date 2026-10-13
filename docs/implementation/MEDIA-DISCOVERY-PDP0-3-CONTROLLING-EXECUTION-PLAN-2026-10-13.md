# Ghatana Media — controlling PDP-0–3 Discovery DEV_COMPLETE execution plan

**Campaign:** samujjwal/ghatana-media, whole-repo Media Discovery. **Source baseline:** `14643ce933d0fe23cf68937e9d3bf88e887db894`, current PDP-0 material `sha256:3373ed962440640a0437d454877b34e06ae72bc9fa764d469413835a29529a3a`.  
**Current macro stage / exact phase:** **DISCOVERY / PDP-0**. PDP-1–3 details are a *future gated worklist*, not retrospective or prospective phase acceptance.  
**Denominator:** 26 physical manifest candidates (12 physical, 12 support-only, 2 subsumed), six semantic compositions, one root, 17 non-physical consumer bindings: 50 review identities × four PDP phases = **200 phase-review cells**. Four archived source locations remain separately referenced; archived desktop consumer is among the 17 and is not physically closable.  
**Authoritative owner decision:** [2026-10-13 delegated decision](../../.product-experience/reviews/2026-10-13-discovery-delegated-owner-decision-and-authorizations.md). **Canonical worklist:** [17-task ledger](media-discovery-reconciliation-worklist-2026-10-13.json). **Per-cell implementation detail:** [200-cell matrix](media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json). **Grounding:** [P0 capture](observations/media-discovery-pdp0-currentness-2026-10-13.json) and [owner evidence](observations/media-discovery-delegated-owner-evidence-2026-10-13.json).

## Current decision and goal

**Owner APPROVED WITH COMMENTS.** PDP-0–3 were already `DEV_COMPLETE` with zero open authored-meaning tasks at their historic source cuts; this plan does not reopen them wholesale. There is no remaining known PDP meaning-authoring backlog. Their *currentness* and complete phase-by-surface applicability must still be verified sequentially: PDP-0 technical currentness was observed PASS (50/50) and a **bounded delegated owner acceptance is now recorded at its exact fingerprint**, while its phase-exit record is not yet published. PDP-1/2/3 fresh source-currentness have not yet been validated. Therefore Discovery barrier remains **FAIL**; Build NOT_ENTERED; native PDP closure NOT_ENTERED; Delivery BLOCKED.

**Critical rule:** The owner decisions and implementation prescriptions here are **already selected**. The implementer must execute them without reopening the decision queue for unchanged material. Never claim test runs, Browser Explorer quality, independent human attestations, Lifecycle receipts, runtime or deployment until performed/approved by the real owner. Each actual current-cut phase exit is a distinct source-bound record. Never rewrite historical `mainSha`, source hashes, skipped tests or acceptance facts.

## Precise unfinished task inventory (11 tasks)

| Unit | Historical authoring status | Remaining Discovery work IDs | Phase source-current / owner |
| --- | --- | --- | --- |
| PDP-0 Product Truth | `DEV_COMPLETE`, 0 open meaning IDs | `MDC-06` | 50 current observed; **Media owner approved for exact fingerprint**; rerun actual checks and publish exit |
| PDP-1 Canonical Domain & Data | `DEV_COMPLETE`, 0 open meaning IDs | `MDC-10`, `MDC-11`, `MDC-12` | Not revalidated; after P0 exit |
| PDP-2 Design & Interface | `DEV_COMPLETE`, 0 open meaning IDs | `MDC-20`, `MDC-21` | Not revalidated; after P1 exit |
| PDP-3 Complete Experience | `DEV_COMPLETE`, 0 open meaning IDs | `MDC-30`, `MDC-31`, `MDC-32` | Not revalidated; after P2 exit |
| Discovery exit/handoff | — | `MDC-40`, `MDC-41` | Both gated behind actual current phase exits |

`MDC-00` through `MDC-05` are **complete** at the previous source capture with focused evidence; do not rerun as a speculative rewrite. If the documentation commit changes root repository membership, recapture currentness and affected tests under `MDC-06`; never let stale zero-work eligibility substitute for the new capture. **No new human internal approval is needed** for the scoped Media owner choices; only materially changed inputs or true nondelegable external authority require specific follow-up.

## Owner-selected architecture and specialist review rules

- **Audio/video domain and state**: source immutability, explicit temporal/fidelity units, durable job state/finality, retention/rights, provenance and cancellation/retry/unknown-outcome semantics are mandatory *definition constraints*, not proof of runtime. Map material contradictions to owning PDP leaf IDs.
- **Security/privacy/rights**: explicit actor, permission and consent, deny-before-effect, retention/erasure, redaction and auditable disposition. Treat specialist-designed test criteria as accepted internal engineering guidance, **not** independent regulatory certification.
- **Interface and accessibility**: Shared-public token/component references; GUI users get consistent responsive layout, focus, keyboard, contrast/forced-colors, reduced motion and localization; API/SDK/CLI/event consumers get equivalent typed error/status/retry/version/authorization/recovery grammar, never a fake screen.
- **Conformance/observability**: negative, adversarial, unknown, timeout, resumed, cancellation, version-conflict, fallback and provenance cases must be documented; labels for `CONTRACT_PREVIEW` / `LOCAL_SIMULATION` / `HOST_DEPENDENT` / `NOT_ADMITTED` must remain honest. Nonadmitted four Agent Tools do not block complete source definitions.
- **Surface graph**: material membership counts, exact stable source/owner refs, six direct composition meanings, deduplicated physical `CONTAINS`, separate `DEPENDS_ON`, 17 channel crosswalks, an honest archived consumer and justification for SUPPORT_ONLY/SUBSUMED/N/A. A green root never overrides a missing child/consumer phase cell.
- **Incremental verification**: use public `@ghatana/verification-planner` currentness mechanics, change-aware fingerprints and bounded selective tests; serialize status writes; do not duplicate Lifecycle's generic hashing engine, force full repository builds, or use Git SHA as semantic truth.
- **No Build before Discovery PASS**; after the barrier Build implementation/verification and genuine Lifecycle PDP acceptance/closure can proceed in parallel. No Delivery before applicable Build and closure/release gates.

## Prescriptive execution cards (what, where, how, predecessor, acceptance)

### MDC-06 — PDP-0 · Media Product Truth/status

**Decision/status:** READY FOR EXECUTION — scoped Media owner approval recorded, actual phase exit NOT published. **Predecessor:** MDC-05.

**What:** Publish real current-source PDP-0 DEV_COMPLETE phase exit now that the internal owner has made the exact-fingerprint decision.

**Where:** `docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-13.json`; `.product-experience/reviews/2026-10-13-discovery-delegated-owner-decision-and-authorizations.md`; `scripts/record-media-discovery-pdp0-currentness.mjs`; `docs/implementation/pdp-0-phase-dev-status.json (read-only)`.

**How:** Recapture source state after this review commit; compare exact 50 cells, 146 material paths, contract digest set, topology/owner/provider fingerprints and actual changed meaning IDs; rerun relevant P0 validators and tests; publish *new* immutable current-cut observation. Do not edit old technical observation to replace NOT_OBTAINED with fabricated retrospective value.

**Checks:** `pnpm check:physical-topology`; `pnpm test:physical-topology`; `pnpm check:product-definition-authority`; `pnpm check:product-experience-local`; `node --test tests/media-discovery-currentness.test.mjs tests/pdp-0-final.test.mjs tests/product-definition-authority.test.mjs`

**Acceptance:** A genuinely observed fresh 50-cell P0 PASS at unchanged accepted material or a newly reviewed material change; owner acceptance bound to same source fingerprint, zero new meaning IDs, real test outcomes. New P0 exit published. No skipped-as-run assertions.

### MDC-10 — PDP-1 · Media domain/interface owners

**Decision/status:** APPROVED DIRECTION — gated; not validated or authorized to claim phase exit. **Predecessor:** MDC-06.

**What:** Reconcile contract-parity checker/test drift and classify four Agent Tool exclusions versus canonical domain semantics.

**Where:** `scripts/check-media-contract-parity.mjs`; `tests/media-contract-parity.test.mjs`; `tests/media-contract-parity-definition-only-cli.test.mjs`; `.product-experience/pdp-3-product-experience/agent-tools/runtime-dispositions.json`.

**How:** Diff checker against pinned historical definition; run strict and definition-only modes; assign every discrepancy to logical PDP-1 meaning, transport admission/Build, external owner acceptance or projection. Preserve four NOT_ADMITTED tools and source-only contracts.

**Checks:** `pnpm check:contract-parity`; `node --test tests/media-pdp-p1-dev-status.test.mjs tests/media-contract-parity.test.mjs tests/media-contract-parity-definition-only-cli.test.mjs tests/pdp1-owner-action-wire-contracts.test.mjs tests/pdp1-transition-guard-definition-evaluator.test.mjs`

**Acceptance:** No unclassified logical/domain discrepancies; exact parity IDs, owner/source refs and test results; never admit tool execution without its actual host/typed authority.

### MDC-11 — PDP-1 · Media domain/surface owners

**Decision/status:** APPROVED DIRECTION — gated; not validated or authorized to claim phase exit. **Predecessor:** MDC-10.

**What:** Validate canonical PDP-1 domain/state/action/contracts across the full 50-record surface scope.

**Where:** `.product-experience/pdp-1-domain-data/`; `.product-experience/interface-parity/`; `.product-experience/surfaces/media-physical-topology.v1.json`; `docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json`.

**How:** Resolve per-cell exact ownership and material membership; check 448+14 canonical schemas/bindings, 79 wires, 55 guards, version/finality/idempotency/tenant/event/provenance/negative cases. Each support/N/A disposition is a grounded decision; no duplicate root/copied consumer meaning.

**Checks:** `pnpm check:contract-parity`; `node --test tests/media-pdp-p1-dev-status.test.mjs tests/media-contract-parity.test.mjs tests/media-contract-parity-definition-only-cli.test.mjs tests/pdp1-owner-action-wire-contracts.test.mjs tests/pdp1-transition-guard-definition-evaluator.test.mjs`

**Acceptance:** 50 phase-1 cell decisions and current source digests, zero real missing canonical meaning; transparent strict owner-admission/non-admission state.

### MDC-12 — PDP-1 · Media domain/status owner

**Decision/status:** APPROVED DIRECTION — gated; not validated or authorized to claim phase exit. **Predecessor:** MDC-11.

**What:** Publish new source-current PDP-1 DEV_COMPLETE phase-exit record without rewriting its historical cut.

**Where:** `docs/implementation/observations/ (new PDP-1 exit)`; `docs/implementation/pdp-1-phase-dev-status.json (read-only)`; `docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json`.

**How:** Capture fresh per-cell membership, source/status predecessor P0 digest, external public contracts and test reports. Verify actual complete applicability and the owner-approved design choices; explicitly record failed/unknown cells and stop if any.

**Checks:** `pnpm check:contract-parity`; `node --test tests/media-pdp-p1-dev-status.test.mjs tests/media-contract-parity.test.mjs tests/media-contract-parity-definition-only-cli.test.mjs tests/pdp1-owner-action-wire-contracts.test.mjs tests/pdp1-transition-guard-definition-evaluator.test.mjs`

**Acceptance:** All applicable PDP-1 cells CURRENT or reasoned N/A, zero outstanding meaning IDs, actual validation results and a new immutable PDP-1 owner status record.

### MDC-20 — PDP-2 · Media design/interface owner

**Decision/status:** APPROVED DIRECTION — gated; not validated or authorized to claim phase exit. **Predecessor:** MDC-12.

**What:** Classify design and executable-projection drift accurately; retain proper GUI/headless semantics.

**Where:** `.product-experience/pdp-2-design-interface-system/`; `apps/media-experience-explorer/specification-artifacts.json`; `libs/audio-video-ui/src/screens/TranscriptCaptionScreen.tsx`; `modules/intelligence/ai-voice/libs/ai-voice-ui-react/`.

**How:** Diff source against historical design pins. Map Shared token/component references, UI state and screen preview. Record React runtime implementation gaps as Build unless truly missing PDP design semantics. Host-dependent AI voice GUI is not a production host; API-only remains headless.

**Checks:** `pnpm check:product-experience-local`; `node --test tests/media-pdp-p2-dev-status.test.mjs tests/pdp-design-interface-parity.test.mjs tests/pdp-design-accessibility-text-spacing-target-size.test.mjs tests/pdp-design-responsive-rendered-references.test.mjs`

**Acceptance:** Every changed path classified with actual owner/impact IDs; no invented complete runtime UI or new design authoring backlog from code drift alone.

### MDC-21 — PDP-2 · Media design/status owner

**Decision/status:** APPROVED DIRECTION — gated; not validated or authorized to claim phase exit. **Predecessor:** MDC-20.

**What:** Validate 50 PDP-2 phase cells and publish current design/interface cut.

**Where:** `.product-experience/pdp-2-design-interface-system/`; `docs/implementation/observations/ (new PDP-2 exit)`; `docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json`.

**How:** Recalculate 31 component families, 13 templates/11 layouts/13 recipes/42 composition rules/19 patterns; inspect GUI layouts/keyboard/zoom/forced-colors/reduced-motion and headless typed/auth/error/version/cancel/unknown/recovery grammar. Preserve N/A rationale and Shared contract references. Run targeted checks.

**Checks:** `pnpm check:product-experience-local`; `node --test tests/media-pdp-p2-dev-status.test.mjs tests/pdp-design-interface-parity.test.mjs tests/pdp-design-accessibility-text-spacing-target-size.test.mjs tests/pdp-design-responsive-rendered-references.test.mjs`

**Acceptance:** 50 explicit current/justified N/A records, exact source membership and phase owner disposition, zero missing definition IDs, new immutable PDP-2 exit; no false external a11y certification.

### MDC-30 — PDP-3 · Media product experience owner

**Decision/status:** APPROVED DIRECTION — gated; not validated or authorized to claim phase exit. **Predecessor:** MDC-21.

**What:** Reconcile complete consumer journeys, screens and headless machine experiences at PDP-3.

**Where:** `.product-experience/pdp-3-product-experience/`; `contracts/openapi/media.yaml`; `.product-experience/surface-registry.yaml`; `.product-experience/surfaces/media-physical-topology.v1.json`.

**How:** Check actual canonical population of 47 screen IDs, 30 journeys/130 steps, 147 action IDs, 31 scenarios, 105 bounded-recovery oracles and 4 seeded/26 bounded unseeded journeys. Trace success/denied/unknown/cancel/timeout/recovery/version, intent and states for every physical/composite/consumer. Treat Agent/CLI/SDK/HTTP/gRPC/event channels as real product experiences at source-definition level without inventing live hosts.

**Checks:** `node --test tests/media-pdp-p3-dev-status.test.mjs tests/pdp-3-overview-denominator.test.mjs tests/pdp-3-screen-source-bindings.test.mjs tests/pdp-3-definition-branch-coverage.test.mjs tests/pdp3-api-experience-source-bindings.test.mjs`

**Acceptance:** Every applicable PDP-3 cell has inspectable complete contract and meaningful negative/recovery paths; consumer mapping and runtime non-admission truthful.

### MDC-31 — PDP-3 · Media Explorer and interaction design owners

**Decision/status:** APPROVED DIRECTION — gated; not validated or authorized to claim phase exit. **Predecessor:** MDC-30.

**What:** Make Explorer a fully working read-only Discovery inspection and simulation tool, not a fictitious production product.

**Where:** `apps/media-experience-explorer/`; `libs/media-experience-simulation/`; `.product-experience/explorer/`; `docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json`.

**How:** Run browser locally at desktop and narrow/mobile widths. Navigate root→six compositions→physical→17 consumer identities and all four PDP links. Inspect exact design tokens/components/templates/recipes, screens, 30 journey steps, CLI/API/RPC/SDK/Agent/Event contracts. Check search canonical IDs, deeplinks, navigation/focus/keyboard, negative cases, source-currentness failure disclosure and fixture deterministic branch outcomes. Label preview/simulation/nonadmitted appropriately and never mutate product runtime.

**Checks:** `pnpm test:experience-browser`; `node --test tests/media-explorer-canonical-id-search.test.mjs tests/media-explorer-physical-topology.test.mjs tests/media-explorer-task-first-navigation.test.mjs tests/media-experience-explorer-accessibility.test.mjs tests/media-explorer-verification-interface-boundaries.test.mjs`

**Acceptance:** Recorded actual browser accessibility/navigation/screens/scenario tests pass with concrete routes and proof; unrun browser means UNVERIFIED rather than PASS, and implementation work must remain read-only tooling.

### MDC-32 — PDP-3 · Media experience/status owner

**Decision/status:** APPROVED DIRECTION — gated; not validated or authorized to claim phase exit. **Predecessor:** MDC-31.

**What:** Publish source-current PDP-3 definition-development exit after machine/user contracts and Explorer checks.

**Where:** `docs/implementation/observations/ (new PDP-3 exit)`; `docs/implementation/pdp-3-phase-dev-status.json (read-only)`; `docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json`.

**How:** Confirm all 50 phase-3 decisions, current source membership and source/result versions; run targeted P3 tests, browser audits and fixtures; bind owner source decision and preserve historical cut. Any missing authoritative meaning opens precise PDP owner defect, not a miscellaneous task list.

**Checks:** `node --test tests/media-pdp-p3-dev-status.test.mjs tests/pdp-3-overview-denominator.test.mjs tests/pdp-3-screen-source-bindings.test.mjs tests/pdp-3-definition-branch-coverage.test.mjs tests/pdp3-api-experience-source-bindings.test.mjs`; `pnpm test:experience-browser`; `node --test tests/media-explorer-canonical-id-search.test.mjs tests/media-explorer-physical-topology.test.mjs tests/media-explorer-task-first-navigation.test.mjs tests/media-experience-explorer-accessibility.test.mjs tests/media-explorer-verification-interface-boundaries.test.mjs`

**Acceptance:** All applicable PDP-3 cells current or justified N/A, actual Explorer browser checks documented, zero outstanding definition IDs, current owner-approved PDP-3 exit.

### MDC-40 — DISCOVERY_EXIT · Media Product Truth/status authority

**Decision/status:** APPROVED DIRECTION — gated; not validated or authorized to claim phase exit. **Predecessor:** MDC-06, MDC-12, MDC-21, MDC-32.

**What:** Compute and publish truthful whole-Discovery barrier from 200 phase-review cells and real four exit records.

**Where:** `docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json`; `docs/implementation/observations/ (new Discovery barrier result)`; `AGENTS.md`.

**How:** Verify each phase 50-cell cut, exact source digests/membership and imported predecessor fingerprints; validate no stale child, no undecided applicability, no duplicate physical counts, zero meaning task IDs; differentiate Explorer tooling check and native Lifecycle acceptance. Aggregate only after leaf decisions; fail closed on UNKNOWN.

**Checks:** `node --test tests/media-discovery-phase-cell-plan.test.mjs`

**Acceptance:** Discovery PASS iff all four fresh phase exits and Browser Explorer definition inspectability are PASS on compatible material; status matrix has 200 accounted cells. This is DEV_COMPLETE, not closure/release certification.

### MDC-41 — DISCOVERY_EXIT · Media engineering owner

**Decision/status:** APPROVED DIRECTION — gated; not validated or authorized to claim phase exit. **Predecessor:** MDC-40.

**What:** Release immutable Discovery source-bound Build handoff only after MDC-40 succeeds.

**Where:** `docs/implementation/MEDIA-POST-PDP-BUILD-IMPLEMENT-TEST-DELIVER-2026-10-12.md`; `docs/implementation/post-pdp-task-dispositions-2026-10-12.md`.

**How:** Publish actual required runtime implementation/test tasks, frozen PDP import/output fingerprints, owners and accepted interface contracts. Start Build implementation and PDP formal Lifecycle acceptance/closure as *parallel independent* lanes only after Discovery barrier PASS. Delivery waits for true Build, closure and release gates.

**Checks:** Compare the signed-in local current-source graph and exit report; do not invent a test run.

**Acceptance:** Build handoff authorized with no PDP authoring tasks, no invented runtime admission, external signoff, Lifecycle receipt or release promise.

## Per-surface phase applicability and task routing

The complete machine-readable 200-cell matrix specifies **owner, manifest/boundary, exact files to inspect, applicability, rationale, predecessor, source currentness as observed, remaining task IDs, what/how, acceptance and next legal action** for every row. This table is a human quick index, not a second editable authority. Every PDP-0 row's remaining work is `MDC-06`; P1 uses `MDC-10/11/12`; P2 `MDC-20/21`; P3 `MDC-30/31/32`. Compositions/root are not duplicated physical leaves.

| Surface identity | Kind/disposition | PDP-0 / PDP-1 / PDP-2 / PDP-3 applicability |
| --- | --- | --- |
| `media.physical.adapters-ledger` | SUPPORT_ONLY | NOT_APPLICABLE_SUPPORT · REFERENCED_ONLY · NOT_APPLICABLE · TOOLING_OR_SUPPORT |
| `media.physical.apps-media-experience-explorer` | PHYSICAL | NO_IMPLEMENTATION_ADMITTED · REFERENCED_ONLY · NOT_APPLICABLE · TOOLING_OR_SUPPORT |
| `media.physical.audio-video-observability` | SUPPORT_ONLY | APPLICABLE · APPLICABLE · NOT_APPLICABLE · CONSUMER_CONTRACT |
| `media.physical.integration-tests` | SUPPORT_ONLY | NOT_APPLICABLE_SUPPORT · REFERENCED_ONLY · NOT_APPLICABLE · TOOLING_OR_SUPPORT |
| `media.physical.launcher` | PHYSICAL | APPLICABLE · APPLICABLE · HEADLESS_CONTRACT · CONSUMER_CONTRACT |
| `media.physical.libs-audio-video-client` | PHYSICAL | APPLICABLE · APPLICABLE · HEADLESS_CONTRACT · CONSUMER_CONTRACT |
| `media.physical.libs-audio-video-types` | PHYSICAL | APPLICABLE · APPLICABLE · HEADLESS_CONTRACT · CONSUMER_CONTRACT |
| `media.physical.libs-audio-video-ui` | PHYSICAL | APPLICABLE · APPLICABLE · GUI_LIBRARY · CONSUMER_CONTRACT |
| `media.physical.libs-common` | SUBSUMED | NOT_APPLICABLE_SUPPORT · REFERENCED_ONLY · NOT_APPLICABLE · TOOLING_OR_SUPPORT |
| `media.physical.libs-java-common` | SUBSUMED | NOT_APPLICABLE_SUPPORT · REFERENCED_ONLY · NOT_APPLICABLE · TOOLING_OR_SUPPORT |
| `media.physical.libs-media-experience-simulation` | SUPPORT_ONLY | NOT_APPLICABLE_SUPPORT · REFERENCED_ONLY · NOT_APPLICABLE · TOOLING_OR_SUPPORT |
| `media.physical.modules-audio-streaming` | SUPPORT_ONLY | NO_IMPLEMENTATION_ADMITTED · REFERENCED_ONLY · HEADLESS_CONTRACT · CONSUMER_CONTRACT |
| `media.physical.modules-infrastructure-cache` | SUPPORT_ONLY | NOT_APPLICABLE_SUPPORT · REFERENCED_ONLY · NOT_APPLICABLE · TOOLING_OR_SUPPORT |
| `media.physical.modules-infrastructure-messaging` | SUPPORT_ONLY | NOT_APPLICABLE_SUPPORT · REFERENCED_ONLY · NOT_APPLICABLE · TOOLING_OR_SUPPORT |
| `media.physical.modules-infrastructure-persistence` | SUPPORT_ONLY | APPLICABLE · APPLICABLE · NOT_APPLICABLE · CONSUMER_CONTRACT |
| `media.physical.modules-infrastructure-security` | SUPPORT_ONLY | APPLICABLE · APPLICABLE · NOT_APPLICABLE · CONSUMER_CONTRACT |
| `media.physical.modules-integration-tests` | SUPPORT_ONLY | NOT_APPLICABLE_SUPPORT · REFERENCED_ONLY · NOT_APPLICABLE · TOOLING_OR_SUPPORT |
| `media.physical.modules-intelligence-ai-voice-libs-ai-voice-ui-react` | PHYSICAL | APPLICABLE · APPLICABLE · GUI_LIBRARY_HOST_DEPENDENT · HOST_DEPENDENT_EXPERIENCE |
| `media.physical.modules-intelligence-multimodal-service` | PHYSICAL | APPLICABLE · APPLICABLE · HEADLESS_CONTRACT · CONSUMER_CONTRACT |
| `media.physical.modules-intelligence-speech-libs-speech-audio-rust` | SUPPORT_ONLY | APPLICABLE · APPLICABLE · NOT_APPLICABLE · CONSUMER_CONTRACT |
| `media.physical.modules-speech-stt-service` | PHYSICAL | APPLICABLE · APPLICABLE · HEADLESS_CONTRACT · CONSUMER_CONTRACT |
| `media.physical.modules-speech-tts-service` | PHYSICAL | APPLICABLE · APPLICABLE · HEADLESS_CONTRACT · CONSUMER_CONTRACT |
| `media.physical.modules-video-streaming` | SUPPORT_ONLY | NO_IMPLEMENTATION_ADMITTED · REFERENCED_ONLY · HEADLESS_CONTRACT · CONSUMER_CONTRACT |
| `media.physical.modules-vision-vision-service` | PHYSICAL | APPLICABLE · APPLICABLE · HEADLESS_CONTRACT · CONSUMER_CONTRACT |
| `media.physical.providers-aws-postgresql` | PHYSICAL | APPLICABLE · APPLICABLE · NOT_APPLICABLE · HOST_DEPENDENT_EXPERIENCE |
| `media.physical.runtime-contracts` | PHYSICAL | APPLICABLE · APPLICABLE · HEADLESS_CONTRACT · CONSUMER_CONTRACT |
| `media.composition.repository-root` | REPOSITORY_ROOT | ROOT_AUTHORITY_REFERENCE · ROOT_AUTHORITY_REFERENCE · ROOT_AUTHORITY_REFERENCE · ROOT_AUTHORITY_REFERENCE |
| `media.composition.ingestion-and-versioned-artifacts` | SEMANTIC_COMPOSITION | DIRECT_CROSS_CHILD_MEANING · DIRECT_INTEGRATION_CONTRACT · HEADLESS_AND_HOST_COMPOSITION · CROSS_CHILD_JOURNEY_DISCOVERY |
| `media.composition.governed-job-execution` | SEMANTIC_COMPOSITION | DIRECT_CROSS_CHILD_MEANING · DIRECT_INTEGRATION_CONTRACT · HEADLESS_AND_HOST_COMPOSITION · CROSS_CHILD_JOURNEY_DISCOVERY |
| `media.composition.speech-and-caption-workflows` | SEMANTIC_COMPOSITION | DIRECT_CROSS_CHILD_MEANING · DIRECT_INTEGRATION_CONTRACT · HEADLESS_AND_HOST_COMPOSITION · CROSS_CHILD_JOURNEY_DISCOVERY |
| `media.composition.vision-and-multimodal-analysis` | SEMANTIC_COMPOSITION | DIRECT_CROSS_CHILD_MEANING · DIRECT_INTEGRATION_CONTRACT · HEADLESS_AND_HOST_COMPOSITION · CROSS_CHILD_JOURNEY_DISCOVERY |
| `media.composition.creation-composition-and-delivery` | SEMANTIC_COMPOSITION | DIRECT_CROSS_CHILD_MEANING · DIRECT_INTEGRATION_CONTRACT · HEADLESS_AND_HOST_COMPOSITION · CROSS_CHILD_JOURNEY_DISCOVERY |
| `media.composition.client-and-machine-interfaces` | SEMANTIC_COMPOSITION | DIRECT_CROSS_CHILD_MEANING · DIRECT_INTEGRATION_CONTRACT · HEADLESS_AND_HOST_COMPOSITION · CROSS_CHILD_JOURNEY_DISCOVERY |
| `media.surface.web` | CONSUMER_BINDING | CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE |
| `media.surface.embedded` | CONSUMER_BINDING | CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE |
| `media.surface.public-http` | CONSUMER_BINDING | CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE |
| `media.surface.service-grpc` | CONSUMER_BINDING | CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE |
| `media.surface.grpc.stt` | CONSUMER_BINDING | CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE |
| `media.surface.grpc.tts` | CONSUMER_BINDING | CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE |
| `media.surface.grpc.vision` | CONSUMER_BINDING | CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE |
| `media.surface.grpc.multimodal` | CONSUMER_BINDING | CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE |
| `media.surface.sdk` | CONSUMER_BINDING | CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE |
| `media.surface.cli` | CONSUMER_BINDING | CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE |
| `media.surface.agent-tools` | CONSUMER_BINDING | CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE |
| `media.surface.events` | CONSUMER_BINDING | CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE |
| `media.surface.integrations` | CONSUMER_BINDING | CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE |
| `media.surface.types-library` | CONSUMER_BINDING | CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE |
| `media.surface.ui-library` | CONSUMER_BINDING | CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE |
| `media.surface.explorer` | CONSUMER_BINDING | CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE |
| `media.surface.desktop-archive` | CONSUMER_BINDING | NOT_APPLICABLE_ARCHIVED · NOT_APPLICABLE_ARCHIVED · NOT_APPLICABLE_ARCHIVED · NOT_APPLICABLE_ARCHIVED |

## Exit report schema and deterministic criteria

Produce **new immutable observations**, one per phase and one Discovery barrier, with `baselineSha` for provenance, `materialSourceSetFingerprint`, per-phase exact source and membership digests, `ownerGraphFingerprint`, `physicalCatalogFingerprint`, `providerRegistryFingerprint`, dependency/child inheritance, `surfaceId`, `phase`, `applicability` and `rationale`, `DEV_COMPLETE`, `sourceCurrentness`, actual `outstandingMeaningIds`, test paths/outcomes/counts/skips, reviewer/owner decision ID and precise blockers. Denominators are extracted from current source and compared with current topology; never blindly stamp 47/30/79 hard-coded expectations after material change.

- P0 exit: existing accepted fingerprint + fresh 50-cell currentness + actual checks.
- P1 exit: P0 actual pass plus complete current canonical domain/contract mappings, no applicable unknowns.
- P2 exit: P1 actual pass plus complete current GUI **and headless** interface grammar, honest N/A.
- P3 exit: P2 actual pass plus every complete human/machine experience and real browser Explorer inspectability tests.
- **Discovery PASS** only if all four current phase exits are congruent and 200 cells are accounted for, with zero real authoring meaning tasks, no stale required child, no missing required consumer, and Explorer actual inspection proof. The 17 consumer bindings are deduplicated non-physical cells.
- Build handoff: after true Discovery PASS, supply frozen source contracts and launch Build plus independent Lifecycle closure lanes. Do not call either lane finished from the same PDP development baseline.

## Blockers and escalation dispositions

| Finding | Current classification | Owner/action | Discovery effect |
| --- | --- | --- | --- |
| PDP-0 owner selection | **RESOLVED** by [delegated decision](../../.product-experience/reviews/2026-10-13-discovery-delegated-owner-decision-and-authorizations.md) for exact fingerprint | Implementer recaptures and publishes MDC-06 with real checks | Prevents false manual-decision stall; NOT itself phase-exit evidence |
| PDP-1–3 owner design choices | **PREAUTHORIZED** at historical definition scope | Media delegated owner directions; implementer performs technical verification | Avoid repeated design discussion; not prospective currentness |
| Historical 4 Agent Tools without typed execution | Intent/source complete, **NOT_ADMITTED** | External/public owner and later Build | No phantom runtime or PDP definition reopening |
| API/public-owner strict parity | Owner transport/admission disposition required when changed | External contract owner/Build; create PDP meaning ID only if real schema gap | Not a generic PDP authoring blocker |
| Shared tokens/design publication | Source interface defined; external public distribution separate | Shared public contract owner/Build | No false external owner acceptance |
| Browser Explorer usability | **NOT YET VERIFIED ON CURRENT CUT** | MDC-31 owner, real browser/tests | PDP-3 tooling exit requires actual run |
| Missing independent legal/security/a11y attestation | **NOT ATTESTED**, never fabricated | Qualified independent owner in formal PDP closure/Delivery where required | Not a stand-in for Discovery authoring |
| Lifecycle receipts, convergence and deployment | **NOT ENTERED** | Lifecycle native closure and Build/Delivery owners | Not required to author PDP definitions; required later at real gates |
| Material source changes after this plan commit | **RECAPTURE REQUIRED** | MDC-06 and affected later phase owner; compare exact semantic digests | Never reuse stale `CURRENT` unexamined |

## Immediate implementer instructions

1. Read this plan, [owner decision](../../.product-experience/reviews/2026-10-13-discovery-delegated-owner-decision-and-authorizations.md), [evidence](observations/media-discovery-delegated-owner-evidence-2026-10-13.json) and [200-cell matrix](media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json). Treat their internal choices as decided, not a request for implementer to impersonate the owner.
2. Use a clean, current `main` and exact affected source digests; run `MDC-06` checks; publish new current P0 exit only on true PASS. Keep historical snapshots read-only and preserve actual skipped tests.
3. Continue **one phase at a time**: MDC-10/11/12 → MDC-20/21 → MDC-30/31/32 → MDC-40/41. Produce honest observations and targeted tests; no runtime feature implementation, source migration, native closure or production delivery under Discovery.
4. If a new material meaning contradiction emerges, state owning phase/physical ID, expected/actual bytes/semantic change, exact proposed disposition and affected dependents. Do not ask for reconsideration of any unchanged decision made above.
5. Final answer must include 200-cell phase matrix outcome, exact remaining IDs (zero authoring tasks on a completed phase), Discovery PASS/FAIL, Build status, native PDP closure status, Delivery gate and the permitted next phase.

**Verified in this owner's current review:** remote HEAD, source topology, 50 observed P0 cells, scope counts, prior worklist, 30 external recorded digest comparisons, and observation-only postcapture commit. **Not verified here:** local currentness recapture, Node/pnpm test runs, running Browser Explorer, independent reviewers, formal Lifecycle closure, runtime/release results. The latter must never be backfilled as completed evidence.
