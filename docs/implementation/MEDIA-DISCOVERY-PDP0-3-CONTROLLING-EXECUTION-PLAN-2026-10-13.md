# Ghatana Media — controlling PDP-0–3 Discovery DEV_COMPLETE execution plan

> **Current controlling review (October 13, 2026; baseline `f5ae346`):** [new delegated owner decision](../../.product-experience/reviews/2026-10-13-discovery-current-cut-delegated-owner-review.md), [exact machine-recorded residuals](observations/media-discovery-current-cut-owner-directions-2026-10-13-r2.json), and [current-cut remaining execution plan](MEDIA-DISCOVERY-REMAINING-CURRENT-CUT-EXECUTION-2026-10-13.md) supersede the stale “all PDP-0/1/2 currently PASS / all 47 MDC30 tasks pending” progress claims below. Predecessor exits passed at their historical source cuts but now each has **4 changed source pins** requiring targeted currentness recheck. MDC30 has **29/61 logically bound, 32 incomplete across 14 journeys, 13/14 consequential steps resolved**, integrations scope applied and **30/30 declared external contract bytes matched** at observation. The prior 35/35 focused tests passed but not the phase gate. No current PDP-3 exit or Build admission is claimed. Complete PDP-0 → PDP-1 → PDP-2 currentness, then resume PDP-3 MDC-30.


> **Controlling new delegated owner decision (October 13, 2026):** [PDP-3 MDC-30 decision](../../.product-experience/reviews/2026-10-13-pdp3-mdc30-delegated-owner-decisions.md) and [machine-readable source-backed action packet](observations/media-discovery-pdp3-owner-binding-directions-2026-10-13.json) settle Media's internal channel, consequential-state, and integrations-applicability choices for the exact reviewed source cut. These are **approved directions, not implemented bindings, tested outcomes, current PDP-3 exit, external owner approval, or independent specialist attestation**. Earlier references below to “owner decisions pending” are prior observations and do not supersede this decision. Preserve PDP-0 R2/PDP-1 R3/PDP-2 R2 current exits unless actual source material invalidates affected units. Continue `MDC-30` only.


**Campaign:** samujjwal/ghatana-media, whole-repo Media Discovery. **Source baseline:** HEAD `2aaa15f5a15ce9d05726cc133885b6415317efff`; observed PDP-3 source-set fingerprint `sha256:e48e639bfe200c2a715d55bde3aa33f064410e80e1e418d793421876d53ccac9` over the 337 paths pinned by the historical PDP-3 status.
**Current macro stage / exact phase:** **DISCOVERY / PDP-3 MDC-30**. PDP-0 R2, PDP-1 R3 and PDP-2 R2 have current source-bound phase exits. The internal owner has now decided channel scope, integrations PDP-3 applicability and consequential state/finality interpretation. PDP-3 nevertheless remains blocked until canonical source changes and true currentness/tests/exits are performed. MDC-31 and MDC-32 remain gated. The Discovery barrier remains **FAIL**.
**Denominator:** 26 physical manifest candidates (12 physical, 12 support-only, 2 subsumed), six semantic compositions, one root, 17 non-physical consumer bindings: 50 review identities × four PDP phases = **200 phase-review cells**. Four archived source locations remain separately referenced; archived desktop consumer is among the 17 and is not physically closable.  
**Authoritative owner decision:** [2026-10-13 delegated decision](../../.product-experience/reviews/2026-10-13-discovery-delegated-owner-decision-and-authorizations.md). **Canonical worklist:** [17-task ledger](media-discovery-reconciliation-worklist-2026-10-13.json). **Per-cell implementation detail:** [200-cell matrix](media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json). **Grounding:** historical [P0 capture](observations/media-discovery-pdp0-currentness-2026-10-13.json), [owner evidence](observations/media-discovery-delegated-owner-evidence-2026-10-13.json), and current [PDP-0 R2 phase exit](observations/media-discovery-pdp0-exit-2026-10-13-r2.json) at commit `2aaa15f`, material fingerprint `sha256:7a7a0f700890915863e9f93eafa30edc2f6d856adbf7944c17fecc0aadd8031b`.

## Current decision and goal

**Owner APPROVED WITH COMMENTS.** The prior PDP-0–3 `DEV_COMPLETE` claims remain historical source-cut statements. PDP-0 has a published R2 phase exit with exact-fingerprint delegated owner acceptance and required checks. PDP-1 R3 and PDP-2 R2 current exits each cover 50 cells and preserve separate owner-acceptance and independent-signoff status. Current-cut PDP-3 review found new definition/linkage gaps and reopened PDP-3 for MDC-30; this does not rewrite the historical status file. The Discovery barrier remains **FAIL**; Build NOT_ENTERED; native PDP closure NOT_ENTERED; Delivery BLOCKED. See [MDC-30 observation](observations/media-discovery-pdp3-mdc30-currentness-2026-10-13-r1.json).

**Critical rule:** The owner decisions and implementation prescriptions here are **already selected**. The implementer must execute them without reopening the decision queue for unchanged material. Never claim test runs, Browser Explorer quality, independent human attestations, Lifecycle receipts, runtime or deployment until performed/approved by the real owner. Each actual current-cut phase exit is a distinct source-bound record. Never rewrite historical `mainSha`, source hashes, skipped tests or acceptance facts.

## Newly approved, exhaustive MDC-30 subtask register

**Decision:** `MEDIA-PDP3-MDC30-OWNER-DIRECTIONS-2026-10-13` — exact reviewed main `58fb822179f782175b6025d37f63a631f4fe66a6`, 337-source-path PDP-3 fingerprint `sha256:e48e639bfe200c2a715d55bde3aa33f064410e80e1e418d793421876d53ccac9`. **5 remaining campaign tasks:** `MDC-30`, `MDC-31`, `MDC-32`, `MDC-40`, `MDC-41`. The 30+14+3 items below are subtasks *of MDC-30*, not a reopened backlog for PDP-0/1/2. The machine packet includes the exact source path, approved channels, action and operation identity, accepted behavior and acceptance test for each.

### MDC30-C-01 through C-30 — 30 complete per-channel journey definitions

**What:** make all 30 intended product journeys complete for their actual declared channels, including 24 proposal-only contracts, J-01/J-02 common binding states, J-03/J-20 missing canonical top-level channel declaration, and J-29/J-30 whose existing `channelRefs` are authoritative.

**Where:** `.product-experience/pdp-3-product-experience/journey-contracts/`, `journey-registry.yaml`, `application-channel-registry.yaml`, approved `journey-channel-contract-bindings.yaml`, P1 `operations.yaml`/`states.yaml`, P2 GUI/headless interface authority, API/grpc/SDK/CLI/service registries. **How:** author one source-linked mapping edge per intended journey×channel (**61 intended edges**); connect exact logical operations, state/owner observation, actor/auth, purpose and immutable version, typed request/result/error, finality, denied/timeout/unknown/retry/recovery, and appropriate a11y or machine grammar. Source-only transport is permitted with explicit non-admission, but cannot conceal missing logical definition. Do not invent endpoints, RPCs or production CLI from fixtures.

| Subtask | Journey | Owner-approved target channels | Canonical contract to inspect |
| --- | --- | --- | --- |
| `MDC30-C-01` | `J-01` | `media.channel.web` | `.product-experience/pdp-3-product-experience/journey-contracts/first-use-and-project-creation.yaml` |
| `MDC30-C-02` | `J-02` | `media.channel.web`, `media.channel.http-api`, `media.channel.sdk` | `.product-experience/pdp-3-product-experience/journey-contracts/upload-import-and-verify-artifact.yaml` |
| `MDC30-C-03` | `J-03` | `media.channel.web`, `media.channel.cli`, `media.channel.grpc-api`, `media.channel.sdk` | `.product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml` |
| `MDC30-C-04` | `J-04` | `media.channel.web`, `media.channel.grpc-api`, `media.channel.sdk` | `.product-experience/pdp-3-product-experience/journey-contracts/authorized-text-to-speech-to-approved-audio.yaml` |
| `MDC30-C-05` | `J-05` | `media.channel.web`, `media.channel.grpc-api`, `media.channel.sdk` | `.product-experience/pdp-3-product-experience/journey-contracts/analyze-image-video-geometry-and-tracks.yaml` |
| `MDC30-C-06` | `J-06` | `media.channel.http-api`, `media.channel.grpc-api`, `media.channel.product-integration` | `.product-experience/pdp-3-product-experience/journey-contracts/return-grounded-typed-consumer-results.yaml` |
| `MDC30-C-07` | `J-07` | `media.channel.web` | `.product-experience/pdp-3-product-experience/journey-contracts/clean-noisy-interview-audio.yaml` |
| `MDC30-C-08` | `J-08` | `media.channel.web` | `.product-experience/pdp-3-product-experience/journey-contracts/repair-video-with-measured-quality.yaml` |
| `MDC30-C-09` | `J-09` | `media.channel.web`, `media.channel.product-integration` | `.product-experience/pdp-3-product-experience/journey-contracts/create-review-and-deliver-from-a-brief.yaml` |
| `MDC30-C-10` | `J-10` | `media.channel.web` | `.product-experience/pdp-3-product-experience/journey-contracts/generate-from-references-and-review-continuity.yaml` |
| `MDC30-C-11` | `J-11` | `media.channel.web` | `.product-experience/pdp-3-product-experience/journey-contracts/edit-tracked-media-region-with-undo.yaml` |
| `MDC30-C-12` | `J-12` | `media.channel.web` | `.product-experience/pdp-3-product-experience/journey-contracts/animate-vector-or-procedural-scenes.yaml` |
| `MDC30-C-13` | `J-13` | `media.channel.web` | `.product-experience/pdp-3-product-experience/journey-contracts/animate-3d-scenes-and-characters.yaml` |
| `MDC30-C-14` | `J-14` | `media.channel.web`, `media.channel.product-integration` | `.product-experience/pdp-3-product-experience/journey-contracts/explore-domain-simulation-and-review-measurements.yaml` |
| `MDC30-C-15` | `J-15` | `media.channel.web`, `media.channel.product-integration` | `.product-experience/pdp-3-product-experience/journey-contracts/refine-simulation-passes-with-semantic-validation.yaml` |
| `MDC30-C-16` | `J-16` | `media.channel.web`, `media.channel.grpc-api` | `.product-experience/pdp-3-product-experience/journey-contracts/translate-and-dub-existing-video.yaml` |
| `MDC30-C-17` | `J-17` | `media.channel.web` | `.product-experience/pdp-3-product-experience/journey-contracts/mix-and-master-music-and-effects.yaml` |
| `MDC30-C-18` | `J-18` | `media.channel.web` | `.product-experience/pdp-3-product-experience/journey-contracts/compose-and-render-reviewed-media.yaml` |
| `MDC30-C-19` | `J-19` | `media.channel.web` | `.product-experience/pdp-3-product-experience/journey-contracts/inspect-quality-and-optimize-within-bounds.yaml` |
| `MDC30-C-20` | `J-20` | `media.channel.web`, `media.channel.cli` | `.product-experience/pdp-3-product-experience/journey-contracts/long-running-job-observation-and-recovery.yaml` |
| `MDC30-C-21` | `J-21` | `media.channel.web`, `media.channel.product-integration` | `.product-experience/pdp-3-product-experience/journey-contracts/review-exact-version-and-recheck-changes.yaml` |
| `MDC30-C-22` | `J-22` | `media.channel.web`, `media.channel.http-api`, `media.channel.cli`, `media.channel.product-integration` | `.product-experience/pdp-3-product-experience/journey-contracts/deliver-export-with-destination-acknowledgement.yaml` |
| `MDC30-C-23` | `J-23` | `media.channel.web`, `media.channel.cli` | `.product-experience/pdp-3-product-experience/journey-contracts/work-locally-and-reconcile-after-reconnect.yaml` |
| `MDC30-C-24` | `J-24` | `media.channel.cli`, `media.channel.http-api` | `.product-experience/pdp-3-product-experience/journey-contracts/run-cli-batch-and-review-verified-outputs.yaml` |
| `MDC30-C-25` | `J-25` | `media.channel.product-integration`, `media.channel.http-api` | `.product-experience/pdp-3-product-experience/journey-contracts/return-bounded-results-to-integrating-products.yaml` |
| `MDC30-C-26` | `J-26` | `media.channel.web`, `media.channel.http-api`, `media.channel.product-integration` | `.product-experience/pdp-3-product-experience/journey-contracts/delete-or-revoke-media-with-visible-lifecycle.yaml` |
| `MDC30-C-27` | `J-27` | `media.channel.web`, `media.channel.http-api`, `media.channel.cli` | `.product-experience/pdp-3-product-experience/journey-contracts/continue-safely-when-processing-is-unavailable.yaml` |
| `MDC30-C-28` | `J-28` | `media.channel.web`, `media.channel.product-integration` | `.product-experience/pdp-3-product-experience/journey-contracts/export-spatial-media-with-format-loss-reporting.yaml` |
| `MDC30-C-29` | `J-29` | `media.channel.web`, `media.channel.grpc-api` | `.product-experience/pdp-3-product-experience/journey-contracts/live-session-loss-consent-change-and-bounded-recovery.yaml` |
| `MDC30-C-30` | `J-30` | `media.channel.web`, `media.channel.http-api`, `media.channel.cli` | `.product-experience/pdp-3-product-experience/journey-contracts/check-which-processing-options-are-eligible.yaml` |

**Acceptance:** no intended channel omitted or duplicated; all 61 edges have exact authority, valid owned source refs, operation/state/negative/recovery grammar or reasoned exact no-equivalence, no fabricated runtime; negative fixtures must reject missing edge, invented route, mismatched version, missing auth, unknown outcome conflation and CLI fixture-as-production. Source-change invalidation must be evaluated after authoring.

### MDC30-S-01 through S-14 — consequential step/state/finality binding

**What:** reconcile all 14 actual consequential actions. **Where:** `journey-purpose-bindings.yaml`, `step-definition-oracles.yaml`, `journey-transition-edge-bindings.yaml`, `state-transition-bindings.yaml`, `pdp-1-domain-data/states.yaml`, `transitions.yaml`, `operations.yaml`, transition guards, exact journey source. **How:** apply owner-approved interpretation per step below, confirm canonical P1 state machine and operation/guard links or a source-justified `NO_P1_MACHINE_TRANSITION` / deferred owner observation; distinguish request receipt, effect finality, destination ACK, session draft and new immutable version. Never invent P1 transition IDs.

| Subtask | Step | Exact authored P1 operation(s) | Owner-approved effect/finality |
| --- | --- | --- | --- |
| `MDC30-S-01` | `J-09:09` | `media.operation.action.deliver-exact-version` | `REQUEST_NOT_DESTINATION_ACK` |
| `MDC30-S-02` | `J-22:02` | `media.operation.action.deliver-exact-version` | `REQUEST_NOT_DESTINATION_ACK` |
| `MDC30-S-03` | `J-01:03` | `media.operation-slice.create-project` | `INITIAL_STATE_CREATION_NOT_TRANSITION` |
| `MDC30-S-04` | `J-20:05` | `media.operation-slice.cancel-job` | `REQUEST_NOT_CANCELLED_FINALITY` |
| `MDC30-S-05` | `J-20:06` | `media.operation-slice.retry-job` | `GUARDED_RETRY_NOT_BLIND_REPLAY` |
| `MDC30-S-06` | `J-06:01` | `media.operation.capability.media-multimodal-observe-source-grounded` | `SUBMIT_INTENT_NOT_RESULT` |
| `MDC30-S-07` | `J-02:02` | `media.operation-slice.begin-upload` | `INITIAL_SESSION_RECEIVING_AFTER_RECEIPT` |
| `MDC30-S-08` | `J-03:02` | `media.operation.transcription-submission` | `TRANSCRIPTION_SUBMISSION_NOT_SUCCESS` |
| `MDC30-S-09` | `J-03:05` | `media.operation.caption-draft-write` | `SESSION_LOCAL_EDIT_IF_SOURCE_CONFIRMS` |
| `MDC30-S-10` | `J-03:06` | `media.operation.caption-draft-write` | `SESSION_LOCAL_EDIT_IF_SOURCE_CONFIRMS` |
| `MDC30-S-11` | `J-03:07` | `media.operation.caption-version-write` | `IMMUTABLE_VERSION_REGISTRATION_NOT_APPROVAL` |
| `MDC30-S-12` | `J-16:03` | `media.operation.caption-draft-write` | `SESSION_LOCAL_EDIT_IF_SOURCE_CONFIRMS` |
| `MDC30-S-13` | `J-18:04` | `media.operation.caption-draft-write` | `SESSION_LOCAL_EDIT_IF_SOURCE_CONFIRMS` |
| `MDC30-S-14` | `J-02:03` | `media.operation-slice.append-upload-chunk` + `media.operation-slice.complete-upload` | `ORDERED_APPEND_COMPLETE_THEN_VERIFICATION` |

**Acceptance:** 14/14 exact action+operation identities with source-grounded P1 state/edge or explicit no-transition; success, denied, timeout, unknown and recovery have correct finality, conservative denial on missing guard facts, no extra job/delivery state; 54 other source-only transition records retain their real **3 operation-family + 44 event-pending + 1 no-verification-operation + 6 external authority-event** classifications. The observed 118 null dispositions (33 passive, 70 read-only, 14 consequential, 1 external) are review classifications, not 118 executable commands.

### MDC30-I-01 — Approved integrations PDP-3 applicability, canonical source update

**Decision:** `media.surface.integrations` **IS** PDP-3 applicable as source-defined **contract-only** system integration; its host remains `HOST_DEPENDENT`, runtime `SOURCE_ONLY` and qualification `PENDING`. The previous `OWNER_DECISION_PENDING` is **an observed source status, not an unanswered Media owner choice now**.

**Where:** `.product-experience/surface-registry.yaml` consumer `media.surface.integrations`, its topology consumerCrosswalk, `.product-experience/pdp-3-product-experience/services/service-registry.yaml`, J-09/14/22/25/26/28. **How:** add PDP-3 to `applicablePdpArtifacts`, change `applicabilityDisposition` to `TARGET_HOST_CONTRACT_PENDING`, provide explicit PDP-3 machine contract and negative/recovery rationale. Keep service registry 25 implementations as **inventory only**, not accepted product integration endpoints. Bind exact external handoff identities/observation or `UNBOUND` with failure states; no fake provider approval.

**Acceptance:** source consumer record and 17-consumer matrix agree with the approved decision and affected journey edges, all real contract meaning source-linked; external admission still not claimed. Because `surface-registry.yaml` can be upstream material, recapture and selectively reissue impacted PDP-0/1/2 currentness/owner cut **only when actual input fingerprints require it**, not by globally redoing their definitions.

### MDC30-E-01 — External owner-contract material recapture

**Where:** `.product-experience/source-manifest.yaml`, named Media-facing sibling files, public Lifecycle source-currentness adapter. **How:** compare declared contract-file digest to each current content byte stream including locally modified relevant contracts; Git commit ID, dirty/untracked marker and newer remote `main` are provenance, never proof that bytes changed or did not change. Classify actual mismatch by exact path and Media surface/meaning ID; unknown files remain UNKNOWN until read. Do not alter external repo contract authority or manually refresh old immutable observation.

**Acceptance:** all required declared external bytes/membership either current and matching or explicitly impact-mapped with authorized source correction; no meaningless global reopen on metadata-only changes.

### MDC30-V-01 — Validation, status and phase lock

**Where:** targeted PDP-3 suites and new regression tests, `docs/implementation/observations/`, 200-cell matrix. **How:** run `node --test tests/media-pdp-p3-dev-status.test.mjs tests/pdp-3-overview-denominator.test.mjs tests/pdp-3-screen-source-bindings.test.mjs tests/pdp-3-definition-branch-coverage.test.mjs tests/pdp3-api-experience-source-bindings.test.mjs tests/media-discovery-pdp3-owner-directions.test.mjs`, plus new channel-edge/state adversarial tests and `pnpm check:product-experience-local`. Capture exact HEAD, material membership/digests, all 50 PDP-3 applicability rows, outcome counts/skips, source-bound owner acceptance and new immutable MDC-30 observation. Older 19/19 and 8/8 tests are historical observations, **not** proof the forthcoming changes passed.

**Acceptance:** zero outstanding real PDP-3 definition gaps, all per-channel and step-negative fixtures grounded, integrations source status resolved, external material explained, 50 phase cells source-current (or grounded N/A), and a new accepted MDC-30 record. **Only then** start MDC-31.

### Remaining campaign after MDC-30

**MDC-31:** make Explorer **actually usable**, not a static demo: read-only root/composition/26 physical/17 consumer navigation, all PDP0-3 sources, GUI components/tokens/screens and API/gRPC/SDK/CLI/Agent/event contracts, searchable canonical IDs, deep links, keyboard/focus/accessibility, responsive layout, deterministic scenario branch replay, and source status failure visibility. Run actual browser tests at desktop and mobile with verified evidence; never label previews as live product functionality.

**MDC-32:** after MDC-31, validate all 50 PDP-3 cells and canonical 47 screens/30 journeys/130 steps/147 actions/31 scenarios/105 recovery oracles against the *current* source, publish immutable PDP-3 source-current `DEV_COMPLETE` exit with zero open authoring tasks. Do not rewrite historical phase record or claim qualified signoff.

**MDC-40:** derive Discovery PASS/FAIL over 200 phase-review cells from **compatible** current exact-source PDP-0/1/2/3 exits plus Explorer actual checks, preserving unaffected prior exits and fail closed on stale affected descendants; no native Lifecycle closure assertion.

**MDC-41:** after PASS only, freeze source-authoritative Build handoff and start runtime development/test plus independently authorized PDP closure in parallel. Delivery waits for current formal closure and Build/release qualification, not the phase-development status alone.

### Blocker and owner disposition

Internal Media product owner decisions on channel scope, 14 effect categories, integration applicability and generic source-currentness policy are **RESOLVED** by the machine packet. Implementer work that remains includes **source edits, exact P1 transition or no-transition verification, newly generated currentness, tests, Explorer operation and actual phase-exit publication**. External host admission, human-independent certification and Lifecycle receipts remain separate authority, not silently authorized or fabricated. A new actual contradiction must be escalated with exact source ID, digest and bounded alternative; unchanged approved design choices should not be resubmitted.


## Precise unfinished task inventory (5 remaining tasks)

| Unit | Historical authoring status | Remaining Discovery work IDs | Phase source-current / owner |
| --- | --- | --- | --- |
| PDP-0 Product Truth | `DEV_COMPLETE`, 0 open meaning IDs | **0** | R2 exit PASS at `sha256:7a7a0f700890915863e9f93eafa30edc2f6d856adbf7944c17fecc0aadd8031b`; technical currentness, exact-fingerprint owner acceptance and required checks pass |
| PDP-1 Canonical Domain & Data | `DEV_COMPLETE`, 0 open meaning IDs | **0** | Current 50-cell exit R3 PASS at `sha256:53352578058a5deb1ab8faef43857848e9bbab2b8ad0d81a8bb6b6d73bef0baa`; historical status preserved |
| PDP-2 Design & Interface | `DEV_COMPLETE`, 0 open meaning IDs | **0** | Current 50-cell exit R2 PASS at `sha256:954c8930f3e9cc4e68570bfca29ac586be7474869b785a9b8c59ea9beeff4cea`; 154 historical pins reviewed; historical status preserved |
| PDP-3 Complete Experience | `DEV_COMPLETE`, 0 open meaning IDs at historical cut | `MDC-30`, `MDC-31`, `MDC-32` | Current cut reopened at MDC-30; channel binding and applicability gaps block currentness; no current exit |
| Discovery exit/handoff | — | `MDC-40`, `MDC-41` | Both gated behind actual current phase exits |

`MDC-00` through `MDC-05` are **complete** at the previous source capture with focused evidence; MDC-06 is complete at the R2 source cut recorded above. Do not reopen completed work without an affected material input change; never let stale zero-work eligibility substitute for a current capture. **No new human internal approval is needed** for the scoped Media owner choices; only materially changed inputs or true nondelegable external authority require specific follow-up.

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

**Decision/status:** COMPLETED — R2 source-bound phase exit PASS at commit `2aaa15f`; exact material fingerprint `sha256:7a7a0f700890915863e9f93eafa30edc2f6d856adbf7944c17fecc0aadd8031b`. **Predecessor:** MDC-05.

**Evidence:** [Immutable R2 phase exit](observations/media-discovery-pdp0-exit-2026-10-13-r2.json). Technical source currentness, exact-fingerprint delegated owner acceptance, required checks and phase exit are PASS; no changed or outstanding meaning IDs. Checks recorded: physical-topology check PASS; topology tests 13/13; product-definition authority and local product-experience checks PASS; combined Discovery/PDP-0 tests 49/49; phase-exit tests 4/4; zero skips.

**Disposition:** Historical phase status and prior observations remain unchanged. PDP-0 and PDP-1 each have zero remaining phase-local tasks and current source-bound exits. PDP-1 R3 validates 50/50 cells, 30/30 external contract digests and the prescribed 68 tests with zero skips; strict parity still exposes its proposal-only owner-mapping finding, while exact-cut owner acceptance and independent signoff remain unrecorded. Next legal action is PDP-2 MDC-20/MDC-21. Discovery remains FAIL until PDP-2/PDP-3 exits and final barrier requirements pass; Build and native closure remain NOT_ENTERED; Delivery remains BLOCKED.

### MDC-10 — PDP-1 · Media domain/interface owners — completed

**Decision/status:** COMPLETED WITH STRICT OWNER-ADMISSION FINDING; this is a task disposition, not a PDP-1 phase exit. **Predecessor:** MDC-06.

**What:** Reconcile contract-parity checker/test drift and classify four Agent Tool exclusions versus canonical domain semantics.

**Where:** `scripts/check-media-contract-parity.mjs`; `tests/media-contract-parity.test.mjs`; `tests/media-contract-parity-definition-only-cli.test.mjs`; `.product-experience/pdp-3-product-experience/agent-tools/runtime-dispositions.json`.

**How:** Diff checker against pinned historical definition; run strict and definition-only modes; assign every discrepancy to logical PDP-1 meaning, transport admission/Build, external owner acceptance or projection. Preserve four NOT_ADMITTED tools and source-only contracts.

**Evidence:** [MDC-10 observation](observations/media-discovery-pdp1-mdc10-contract-parity-2026-10-13-r1.json). `pnpm check:contract-parity` exits 1 with 46/47 current findings dispositioned and one proposal-only owner-mapping finding unresolved. `node scripts/check-media-contract-parity.mjs --definition-only` passes and explicitly defers owner acceptance/runtime admission. The prescribed focused suite passes 68/68 with zero skips. The four Agent Tool boundaries remain `NOT_ADMITTED`; no logical domain defect or runtime admission is claimed. J-05/J-06/J-08 source crosswalk findings are handed to PDP-3 MDC-30.

**Acceptance:** All discrepancies are classified to definition validation, owner acceptance/runtime admission, or the PDP-3 handoff; no Agent Tool is admitted without its actual host/typed authority. The strict owner-admission finding remains visible.

### MDC-11 — PDP-1 · Media domain/surface owners

**Decision/status:** COMPLETED — all 50 PDP-1 cells are source-current; no phase-local meaning tasks remain. **Predecessor:** MDC-10. **Evidence:** [PDP-1 current exit R3](observations/media-discovery-pdp1-exit-2026-10-13-r3.json).

**What:** Validate canonical PDP-1 domain/state/action/contracts across the full 50-record surface scope.

**Where:** `.product-experience/pdp-1-domain-data/`; `.product-experience/interface-parity/`; `.product-experience/surfaces/media-physical-topology.v1.json`; `docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json`.

**How:** Resolve per-cell exact ownership and material membership; check 448+14 canonical schemas/bindings, 79 wires, 55 guards, version/finality/idempotency/tenant/event/provenance/negative cases. Each support/N/A disposition is a grounded decision; no duplicate root/copied consumer meaning.

**Checks:** `pnpm check:contract-parity`; `node --test tests/media-pdp-p1-dev-status.test.mjs tests/media-contract-parity.test.mjs tests/media-contract-parity-definition-only-cli.test.mjs tests/pdp1-owner-action-wire-contracts.test.mjs tests/pdp1-transition-guard-definition-evaluator.test.mjs`

**Acceptance:** 50 phase-1 cell decisions and current source digests, zero real missing canonical meaning; transparent strict owner-admission/non-admission state.

### MDC-12 — PDP-1 · Media domain/status owner

**Decision/status:** COMPLETED — immutable PDP-1 phase exit R3 PASS; historical status preserved. **Predecessor:** MDC-11. **Evidence:** [PDP-1 current exit R3](observations/media-discovery-pdp1-exit-2026-10-13-r3.json).

**What:** Publish new source-current PDP-1 DEV_COMPLETE phase-exit record without rewriting its historical cut.

**Where:** `docs/implementation/observations/ (new PDP-1 exit)`; `docs/implementation/pdp-1-phase-dev-status.json (read-only)`; `docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json`.

**How:** Capture fresh per-cell membership, source/status predecessor P0 digest, external public contracts and test reports. Verify actual complete applicability and the owner-approved design choices; explicitly record failed/unknown cells and stop if any.

**Checks:** `pnpm check:contract-parity`; `node --test tests/media-pdp-p1-dev-status.test.mjs tests/media-contract-parity.test.mjs tests/media-contract-parity-definition-only-cli.test.mjs tests/pdp1-owner-action-wire-contracts.test.mjs tests/pdp1-transition-guard-definition-evaluator.test.mjs`

**Acceptance:** All applicable PDP-1 cells CURRENT or reasoned N/A, zero outstanding meaning IDs, actual validation results and a new immutable PDP-1 owner status record.

### MDC-20 — PDP-2 · Media design/interface owner

**Decision/status:** COMPLETED — four historical pin changes classified; no PDP-2 meaning defect identified. **Predecessor:** MDC-12. **Evidence:** [MDC-20 drift observation](observations/media-discovery-pdp2-mdc20-design-drift-2026-10-13-r1.json).

**What:** Classify design and executable-projection drift accurately; retain proper GUI/headless semantics.

**Where:** `.product-experience/pdp-2-design-interface-system/`; `apps/media-experience-explorer/specification-artifacts.json`; `libs/audio-video-ui/src/screens/TranscriptCaptionScreen.tsx`; `modules/intelligence/ai-voice/libs/ai-voice-ui-react/`.

**How:** Diff source against historical design pins. Map Shared token/component references, UI state and screen preview. Record React runtime implementation gaps as Build unless truly missing PDP design semantics. Host-dependent AI voice GUI is not a production host; API-only remains headless.

**Checks:** `pnpm check:product-experience-local`; `node --test tests/media-pdp-p2-dev-status.test.mjs tests/pdp-design-interface-parity.test.mjs tests/pdp-design-accessibility-text-spacing-target-size.test.mjs tests/pdp-design-responsive-rendered-references.test.mjs`

**Acceptance:** Every changed path classified with actual owner/impact IDs; no invented complete runtime UI or new design authoring backlog from code drift alone.

### MDC-21 — PDP-2 · Media design/status owner

**Decision/status:** COMPLETED — immutable PDP-2 R2 phase exit PASS with all 50 cells current and zero phase-local meaning tasks. **Predecessor:** MDC-20. **Evidence:** [PDP-2 current exit R2](observations/media-discovery-pdp2-exit-2026-10-13-r2.json).

**What:** Validate 50 PDP-2 phase cells and publish current design/interface cut.

**Where:** `.product-experience/pdp-2-design-interface-system/`; `docs/implementation/observations/ (new PDP-2 exit)`; `docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json`.

**How:** Recalculate 31 component families, 13 templates/11 layouts/13 recipes/42 composition rules/19 patterns; inspect GUI layouts/keyboard/zoom/forced-colors/reduced-motion and headless typed/auth/error/version/cancel/unknown/recovery grammar. Preserve N/A rationale and Shared contract references. Run targeted checks.

**Checks:** `pnpm check:product-experience-local`; `node --test tests/media-pdp-p2-dev-status.test.mjs tests/pdp-design-interface-parity.test.mjs tests/pdp-design-accessibility-text-spacing-target-size.test.mjs tests/pdp-design-responsive-rendered-references.test.mjs`

**Acceptance:** PASSED. The 50 explicit current/justified N/A records bind exact registry/topology owners and source applicability; source membership and required populations match, no definition IDs remain, and the immutable R2 exit is current. The prescribed suites validate source definitions, not rendered or assistive-technology acceptance; no external accessibility certification, Shared package acceptance, exact-cut owner acceptance or independent signoff is claimed.

### MDC-30 — PDP-3 · Media product experience owner

**Decision/status:** **BLOCKED IN PROGRESS** — active after PDP-2 R2; currentness and phase exit are not validated. **Predecessor:** MDC-21.

**What:** Reconcile complete consumer journeys, screens and headless machine experiences at PDP-3.

**Where:** `.product-experience/pdp-3-product-experience/`; `contracts/openapi/media.yaml`; `.product-experience/surface-registry.yaml`; `.product-experience/surfaces/media-physical-topology.v1.json`.

**How:** Check actual canonical population of 47 screen IDs, 30 journeys/130 steps, 147 action IDs, 31 scenarios, 105 bounded-recovery oracles and 4 seeded/26 bounded unseeded journeys. Trace success/denied/unknown/cancel/timeout/recovery/version, intent and states for every physical/composite/consumer. Treat Agent/CLI/SDK/HTTP/gRPC/event channels as real product experiences at source-definition level without inventing live hosts.

**Checks:** `node --test tests/media-pdp-p3-dev-status.test.mjs tests/pdp-3-overview-denominator.test.mjs tests/pdp-3-screen-source-bindings.test.mjs tests/pdp-3-definition-branch-coverage.test.mjs tests/pdp3-api-experience-source-bindings.test.mjs`

**Acceptance:** Every applicable PDP-3 cell has inspectable complete contract and meaningful negative/recovery paths; consumer mapping and runtime non-admission truthful.

**MDC-30 observation:** [Current-cut source and definition review](observations/media-discovery-pdp3-mdc30-currentness-2026-10-13-r1.json). The 337 historical source pins were reviewed; five differ and are classified there. Canonical counts reconcile (47 screens, 30 journeys/130 steps, 147 actions, 31 scenarios, 105 recovery-oracle links); the prescribed suite passes 19/19 and the matrix/transition audit regression passes 8/8, both with zero skips. This does not establish current PDP-3 completion: 24 journey contracts explicitly leave per-channel operation/state/transport/accessibility equivalence unbound; J-01/J-02 lack the common binding-state declaration and J-03/J-20 lack top-level channel lists; the bounded state/transition review classified 54 unbound transition records and 118 null state dispositions (33 local/passive, 70 read-only, 14 consequential command/workflow, one external handoff); exact owner-accepted state mappings remain open for the 14 consequential records; `media.surface.integrations` remains `UNKNOWN_OWNER_DECISION_PENDING` because its registry omits PDP-3 while five journeys reference it. External source-manifest snapshots are also stale for exact sibling-repository currentness. **Do not start MDC-31** until these MDC-30 blockers are resolved and every cell is current.

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

The complete machine-readable 200-cell matrix specifies **owner, manifest/boundary, exact files to inspect, applicability, rationale, predecessor, source currentness, remaining task IDs, what/how, acceptance and next legal action** for every row. This table is a human quick index, not a second editable authority. PDP-0, PDP-1 and PDP-2 rows are current under their R2/R3/R2 exits with zero remaining phase-local tasks; PDP-3 is active at MDC-30. P3 continues through `MDC-30/31/32`; Discovery exit uses `MDC-40/41`. Compositions/root are not duplicated physical leaves.

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
| `media.surface.integrations` | CONSUMER_BINDING | CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · CONSUMER_BINDING_VALIDATE · **UNKNOWN_OWNER_DECISION_PENDING** |
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
| PDP-0 source-current phase exit | **RESOLVED** by delegated decision and [R2 exit evidence](observations/media-discovery-pdp0-exit-2026-10-13-r2.json) at exact fingerprint | No remaining PDP-0 task; reopen only for affected material change | PDP-0 exit PASS; does not pass the whole Discovery barrier |
| PDP-1–3 owner design choices | **PREAUTHORIZED** at historical definition scope | Media delegated owner directions; implementer performs technical verification | Avoid repeated design discussion; not prospective currentness |
| Historical 4 Agent Tools without typed execution | Intent/source complete, **NOT_ADMITTED** | External/public owner and later Build | No phantom runtime or PDP definition reopening |
| API/public-owner strict parity | Owner transport/admission disposition required when changed | External contract owner/Build; create PDP meaning ID only if real schema gap | Not a generic PDP authoring blocker |
| Shared tokens/design publication | Source interface defined; external public distribution separate | Shared public contract owner/Build | No false external owner acceptance |
| Browser Explorer usability | **NOT YET VERIFIED ON CURRENT CUT** | MDC-31 owner, real browser/tests | PDP-3 tooling exit requires actual run |
| Missing independent legal/security/a11y attestation | **NOT ATTESTED**, never fabricated | Qualified independent owner in formal PDP closure/Delivery where required | Not a stand-in for Discovery authoring |
| Lifecycle receipts, convergence and deployment | **NOT ENTERED** | Lifecycle native closure and Build/Delivery owners | Not required to author PDP definitions; required later at real gates |
| Material source changes after this plan commit | **RECAPTURE REQUIRED** | MDC-06 and affected later phase owner; compare exact semantic digests | Never reuse stale `CURRENT` unexamined |

## MDC-06 machine-readable owner-acceptance join — completed evidence

**Approved owner input:** [PDP-0 delegated owner acceptance](observations/media-discovery-delegated-owner-acceptance-pdp0-2026-10-13.json). The implementer does **not** choose this approval or seek it again for an unchanged material fingerprint.

**Observed implementation detail:** `scripts/record-media-discovery-pdp0-currentness.mjs` still emits `phaseDisposition.ownerAcceptance = NOT_OBTAINED` and `pdp0Exit = BLOCKED_PENDING_OWNER_ACCEPTANCE` (the historical technical-observation view at capture time). Treat these as **technical-observer output only**, not a veto on this separate, later owner input. Do **not** edit the old capture's JSON to imply an approval existed then.

**Completed join:** the immutable R2 phase-exit record joins the machine owner input with fresh technical currentness. Validate owner-role/phase/decision ID, the accepted `materialSourceSetFingerprint`, exact 26+6+1+17 scope, zero changed/outstanding meaning IDs and actual required checks. The published record keeps separate `technicalCurrentness`, `delegatedOwnerAcceptance`, `testOutcomes` and `phaseExit` axes; each prerequisite passed independently. A material fingerprint mismatch must yield `STALE_APPROVAL_FOR_CHANGED_MATERIAL` and a targeted owner-change review, not silently reinterpret the old acceptance. If only the root repository's membership changed because planning docs/tests were added and material PDP semantics did not, recompute the current cut through Lifecycle continuity rules and retain this scoped owner decision after verifying the identical material fingerprint.

**Do not rewrite the existing fixed-name observation in place.** The current observer uses a fixed output path and preserves `observedAt`; choose a new immutable capture filename or a separate owned phase-exit artifact. An observer change must avoid self-recursive hashing and count actual tests (including skips) accurately. The R2 evidence records the required pnpm and Node test outcomes; no independent human signature or qualified external specialist signoff is claimed or waived.


## Immediate implementer instructions

1. Read this plan, [owner decision](../../.product-experience/reviews/2026-10-13-discovery-delegated-owner-decision-and-authorizations.md), [evidence](observations/media-discovery-delegated-owner-evidence-2026-10-13.json) and [200-cell matrix](media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json). Treat their internal choices as decided, not a request for implementer to impersonate the owner.
2. Preserve the completed R2 PDP-0 exit and all historical snapshots. Do not reopen MDC-06 absent a material input change.
3. Continue **one phase at a time**: MDC-30/31/32 → MDC-40/41. Produce honest observations and targeted tests; no runtime feature implementation, source migration, native closure or production delivery under Discovery.
4. If a new material meaning contradiction emerges, state owning phase/physical ID, expected/actual bytes/semantic change, exact proposed disposition and affected dependents. Do not ask for reconsideration of any unchanged decision made above.
5. Final answer must include 200-cell phase matrix outcome, exact remaining IDs (zero authoring tasks on a completed phase), Discovery PASS/FAIL, Build status, native PDP closure status, Delivery gate and the permitted next phase.

**Verified in this owner's current review:** remote HEAD, source topology, 50 observed P0 cells, scope counts, prior worklist, 30 external recorded digest comparisons, and observation-only postcapture commit. **Not verified here:** local currentness recapture, Node/pnpm test runs, running Browser Explorer, independent reviewers, formal Lifecycle closure, runtime/release results. The latter must never be backfilled as completed evidence.
