# Media Discovery — final current-cut implementation and verification plan

**Campaign:** complete Media PDP-0, PDP-1, PDP-2, PDP-3 definition development for **all** 50 scoped review identities (26 physical/support/subsumed, 6 semantic compositions, root, 17 consumer crosswalks); 200 phase-review cells.  
**Last reviewed source baseline:** `f5ae3461c53eb1d490362a9bb8818ce74573147c`.  
**Macro stage:** DISCOVERY. **Earliest currently required verification phase:** **PDP-0**, then PDP-1, PDP-2, resume PDP-3 MDC-30.  
**Source-bound delegated owner decisions:** [current-cut review](../../.product-experience/reviews/2026-10-13-discovery-current-cut-delegated-owner-review.md) and [machine-readable instructions](observations/media-discovery-current-cut-owner-directions-2026-10-13-r2.json).  
**Source observations:** [predecessor-impact audit](observations/media-discovery-predecessor-currentness-impact-2026-10-13-r1.json) and [MDC-30 execution report](observations/media-discovery-pdp3-mdc30-execution-2026-10-13-r1.json).  
**Canonical campaign record:** [17-task worklist](media-discovery-reconciliation-worklist-2026-10-13.json), [200-cell surface matrix](media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json).

## Owner disposition and safe stage law

**APPROVED WITH REQUIRED TECHNICAL CORRECTIONS.** Owner decisions for the exact reviewed source material are made, not pending with the implementer. All three prior phases passed at *their earlier cuts*. Four recorded source pins in **each** prior phase no longer match the active source. Their semantic definitions are accepted for reuse for the exact reviewed change; **no current phase exit is asserted** until a fresh source capture passes. No production runtime, native Lifecycle closure, delivery or independent specialist approval is invented.

Historical PDP-0 R2, PDP-1 R3 and PDP-2 R2 `PASS` receipts are **preserved as input-specific history**. They cannot be relabeled as current simply because the changed material appears informational. The only source-authoring gaps established at this baseline are **32** PDP-3 logical journey-channel edges and **one** J-06 consequential submission linkage; preceding phases require currentness rechecks, not wholesale authoring. The 61 honest `UNBOUND` transports are **Build/admission** boundaries, not automatically 61 Discovery meaning failures.

## Full ordered work graph and remaining tasks

| Order | Task | Where | Definition/exit acceptance |
| --- | --- | --- | --- |
| 1 | `RC-P0-01` | PDP-0 previous 146-path material set; 4 changed | Owner-approved non-impact + fresh currentness & tests, new immutable PDP-0 successor |
| 2 | `RC-P1-01` | PDP-1 previous 329-path set; 4 changed | PDP-0 current, typed/domain parity/currentness, new immutable PDP-1 successor |
| 3 | `RC-P2-01` | PDP-2 previous 405-path set; 4 changed | PDP-1 current, design/headless applicability, new immutable PDP-2 successor |
| 4 | 14 `MDC30-C-*` | 32 exact remaining channel edges across 14 journeys | Every edge logically complete or exact source-proven no-Media-state; negative tests |
| 5 | `MDC30-S-06` | J-06 step 1, capability-invocation-adapter, PDP-1 job submit | Exact 3-role async wrapper join, full guards, unknown/reconciliation, no guessed QUEUED |
| 6 | `MDC30-V-01` | PDP-3 binding registry, 50 PDP-3 cells, generated manifests/tests | 61/61 logical edge dispositions correct, 14/14 bounded consequential steps, zero meaning blockers |
| 7 | `MDC-31` | Explorer & simulation tooling | Actually working full Discovery inspection, browser/a11y/keyboard/mobile+headless checks |
| 8 | `MDC-32` | PDP-3 new source-current exit | All 50 applicable/justified N/A cells current with zero outstanding authoring IDs |
| 9 | `MDC-40` | 200-cell Discovery barrier | Four congruent phase exits, source graph and Explorer PASS; fail closed otherwise |
| 10 | `MDC-41` | Build handoff | Only after Discovery PASS; independently admissible PDP native closure later in parallel Build lane |

These are **3 prerequisite rechecks + 14 channel subtasks + 1 consequential step + 1 MDC30 verification + 4 gated campaign tasks**, under the existing five campaign groups (`MDC-30/31/32/40/41`). Do **not** inflate PDP-0/1/2's completed meaning-task backlogs.

## Stage 1 — ordered predecessor-source review and acceptance

### RC-P0-01 — PDP-0 source-currentness (earliest dependency)

**Owner:** Media Product Truth/status; internal delegated semantic non-impact **approved at reviewed source**, exact technical currentness still pending. **Predecessor:** none (start here).

**What:** compare all **146** prior-exit material paths; exactly **four** changed and zero missing at the historical handoff. No new product meaning ID has been identified or approved for reauthoring.

**Where and accepted change classifications:**
- `.product-experience/artifact-identities.yaml` — `ARTIFACT_IDENTITY_REGISTRATION_OF_PDP3_BINDINGS_AND_OWNER_REVIEW`; recorded `sha256:ed1d0a7ee4ed84…`, observed `sha256:cd6709b2e3bfff…`
- `.product-experience/source-manifest.yaml` — `GENERATED_INDEX_MEMBERSHIP_AND_EXTERNAL_DIAGNOSTICS; REVERIFY_NO_P0_2_MEANING`; recorded `sha256:532e2fc1ace3af…`, observed `sha256:76cdcbff690e6a…`
- `.product-experience/surface-registry.yaml` — `CANONICAL_PDP3_INTEGRATION_APPLICABILITY_ONLY; PRIOR_PHASE_INPUT_BYTES_CHANGED`; recorded `sha256:3d4955aa77c9fd…`, observed `sha256:b2484d65d897da…`
- `apps/media-experience-explorer/specification-artifacts.json` — `EXPLORER_INDEX_PROJECTION_ONLY`; recorded `sha256:ec1616ced628be…`, observed `sha256:2aadeeffe41ea3…`

**How:** Re-run public Lifecycle/Media exact-source currentness for PDP-0 and affected 50-cell projections on the actual current HEAD, binding all 146 declared material paths and four changes; validate owner applicability, root/child/consumer joins, no new meaning IDs, fresh content/membership/external fingerprints and targeted affected tests only. Publish separate immutable PDP-0 successor currentness/owner-status observation if PASS; preserve the old phase exit at its historical input. Use the predecessor source-currentness observation, the exact file bytes, member/owner/catalog/provider fingerprints, consistent source timing and public Lifecycle adapter. An unexplained change/new requirement invalidates only affected units. The 30/30 sibling contract byte comparison at the old capture is not a perpetual freshness guarantee.

**Focused checks:** `pnpm check:physical-topology`; `pnpm test:physical-topology`; `pnpm check:product-definition-authority`; `pnpm check:product-experience-local`; `node --test tests/media-discovery-currentness.test.mjs tests/media-discovery-pdp0-phase-exit.test.mjs`. Run only on the affected source cut and log actual pass/fail/skips; the earlier R2/R3/R2 recorded tests remain historical. Strict public owner parity and qualification are separate from PDP-1 definition-only parity.

**Exit acceptance:** No missing paths or material contradictions; current source digests and explicit scope/owner/applicability agree with reviewed delta, actual required targeted tests PASS and source-bound currentness PASS. If material semantic change appears, halt and reopen only earliest owning phase/affected dependents. Publish a *new* immutable successor source-current observation with a distinct owner-status join on the **observed** material fingerprint; keep previous `docs/implementation/observations/media-discovery-pdp0-exit-2026-10-13-r2.json` and unchanged authoring history intact. Do not call the phase CURRENT solely on owner approval.


### RC-P1-01 — PDP-1 source-currentness (earliest dependency)

**Owner:** Media domain/status; internal delegated semantic non-impact **approved at reviewed source**, exact technical currentness still pending. **Predecessor:** RC-P0-01.

**What:** compare all **329** prior-exit material paths; exactly **four** changed and zero missing at the historical handoff. No new product meaning ID has been identified or approved for reauthoring.

**Where and accepted change classifications:**
- `.product-experience/reviews/2026-10-13-discovery-delegated-owner-decision-and-authorizations.md` — `DELEGATED_REVIEW_POINTER_ONLY`; recorded `sha256:634a5e33b20d65…`, observed `sha256:596d3cad8a1829…`
- `.product-experience/source-manifest.yaml` — `GENERATED_INDEX_MEMBERSHIP_AND_EXTERNAL_DIAGNOSTICS; REVERIFY_NO_P0_2_MEANING`; recorded `sha256:532e2fc1ace3af…`, observed `sha256:76cdcbff690e6a…`
- `.product-experience/surface-registry.yaml` — `CANONICAL_PDP3_INTEGRATION_APPLICABILITY_ONLY; PRIOR_PHASE_INPUT_BYTES_CHANGED`; recorded `sha256:3d4955aa77c9fd…`, observed `sha256:b2484d65d897da…`
- `apps/media-experience-explorer/specification-artifacts.json` — `EXPLORER_INDEX_PROJECTION_ONLY`; recorded `sha256:ec1616ced628be…`, observed `sha256:2aadeeffe41ea3…`

**How:** Re-run public Lifecycle/Media exact-source currentness for PDP-1 and affected 50-cell projections on the actual current HEAD, binding all 329 declared material paths and four changes; validate owner applicability, root/child/consumer joins, no new meaning IDs, fresh content/membership/external fingerprints and targeted affected tests only. Publish separate immutable PDP-1 successor currentness/owner-status observation if PASS; preserve the old phase exit at its historical input. Use the predecessor source-currentness observation, the exact file bytes, member/owner/catalog/provider fingerprints, consistent source timing and public Lifecycle adapter. An unexplained change/new requirement invalidates only affected units. The 30/30 sibling contract byte comparison at the old capture is not a perpetual freshness guarantee.

**Focused checks:** `node --test tests/media-pdp-p1-dev-status.test.mjs tests/media-contract-parity.test.mjs tests/media-contract-parity-definition-only-cli.test.mjs`; `pnpm check:product-experience-local`. Run only on the affected source cut and log actual pass/fail/skips; the earlier R2/R3/R2 recorded tests remain historical. Strict public owner parity and qualification are separate from PDP-1 definition-only parity.

**Exit acceptance:** No missing paths or material contradictions; current source digests and explicit scope/owner/applicability agree with reviewed delta, actual required targeted tests PASS and source-bound currentness PASS. If material semantic change appears, halt and reopen only earliest owning phase/affected dependents. Publish a *new* immutable successor source-current observation with a distinct owner-status join on the **observed** material fingerprint; keep previous `docs/implementation/observations/media-discovery-pdp1-exit-2026-10-13-r3.json` and unchanged authoring history intact. Do not call the phase CURRENT solely on owner approval.


### RC-P2-01 — PDP-2 source-currentness (earliest dependency)

**Owner:** Media design/interface-status; internal delegated semantic non-impact **approved at reviewed source**, exact technical currentness still pending. **Predecessor:** RC-P1-01.

**What:** compare all **405** prior-exit material paths; exactly **four** changed and zero missing at the historical handoff. No new product meaning ID has been identified or approved for reauthoring.

**Where and accepted change classifications:**
- `.product-experience/reviews/2026-10-13-discovery-delegated-owner-decision-and-authorizations.md` — `DELEGATED_REVIEW_POINTER_ONLY`; recorded `sha256:634a5e33b20d65…`, observed `sha256:596d3cad8a1829…`
- `.product-experience/source-manifest.yaml` — `GENERATED_INDEX_MEMBERSHIP_AND_EXTERNAL_DIAGNOSTICS; REVERIFY_NO_P0_2_MEANING`; recorded `sha256:532e2fc1ace3af…`, observed `sha256:76cdcbff690e6a…`
- `.product-experience/surface-registry.yaml` — `CANONICAL_PDP3_INTEGRATION_APPLICABILITY_ONLY; PRIOR_PHASE_INPUT_BYTES_CHANGED`; recorded `sha256:3d4955aa77c9fd…`, observed `sha256:b2484d65d897da…`
- `apps/media-experience-explorer/specification-artifacts.json` — `EXPLORER_INDEX_PROJECTION_ONLY`; recorded `sha256:ec1616ced628be…`, observed `sha256:2aadeeffe41ea3…`

**How:** Re-run public Lifecycle/Media exact-source currentness for PDP-2 and affected 50-cell projections on the actual current HEAD, binding all 405 declared material paths and four changes; validate owner applicability, root/child/consumer joins, no new meaning IDs, fresh content/membership/external fingerprints and targeted affected tests only. Publish separate immutable PDP-2 successor currentness/owner-status observation if PASS; preserve the old phase exit at its historical input. Use the predecessor source-currentness observation, the exact file bytes, member/owner/catalog/provider fingerprints, consistent source timing and public Lifecycle adapter. An unexplained change/new requirement invalidates only affected units. The 30/30 sibling contract byte comparison at the old capture is not a perpetual freshness guarantee.

**Focused checks:** `node --test tests/media-pdp-p2-dev-status.test.mjs tests/pdp-design-interface-parity.test.mjs tests/pdp-design-current-public-consumer-bindings.test.mjs`; `pnpm check:product-experience-local`. Run only on the affected source cut and log actual pass/fail/skips; the earlier R2/R3/R2 recorded tests remain historical. Strict public owner parity and qualification are separate from PDP-1 definition-only parity.

**Exit acceptance:** No missing paths or material contradictions; current source digests and explicit scope/owner/applicability agree with reviewed delta, actual required targeted tests PASS and source-bound currentness PASS. If material semantic change appears, halt and reopen only earliest owning phase/affected dependents. Publish a *new* immutable successor source-current observation with a distinct owner-status join on the **observed** material fingerprint; keep previous `docs/implementation/observations/media-discovery-pdp2-exit-2026-10-13-r2.json` and unchanged authoring history intact. Do not call the phase CURRENT solely on owner approval.



## Stage 2 — the 32 outstanding PDP-3 channel edges (full list)

**Architecture preapproved:** retain single canonical `.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml` with all 61 mapping edges, and immutable meaning owners in canonical journey, PDP-1 operations/states, and PDP-2 interface grammar. Preserve the 29 already complete logical bindings. Reuse `scripts/lib/pdp3-step-capability-purpose.mjs`, `tests/pdp3-journey-channel-contract-bindings.test.mjs` and `tests/pdp-experience-step-definition-oracle.test.mjs`.

**Binding proof choice (mandatory one per edge):** (1) exact P1 machine state bound to action/guard; (2) exact typed P1 owner observation with complete purpose/operation join; **or** (3) explicit, source-proven **NO_P1_MACHINE_STATE** justified by a stateless read/local session effect/initial result/external handoff, with typed result and authority/finality/unknown/recovery. A mere `stateRefs: []` or null cannot pass. The semantic third branch requires adding positive verification and adversarial tests; do not weaken the existing missing-state test to unconditionally accept N/A. A command with owner-state effects cannot escape through a false read-only label. Full coverage must account for every exact P1 operation on the edge.

### MDC30-C-03 — J-03, 4 unfinished channel edges

**Owner:** Media speech/transcription and caption-interface owners. **Predecessors:** RC-P0-01 → RC-P1-01 → RC-P2-01 (material currentness) and the existing 29 source-bound edges (reused, not reworked).
**What:** Finish `TRANSCRIPTION_SUBMISSION_THEN_EXACT_CAPTION_DRAFT_OR_VERSION` on `media.channel.cli`, `media.channel.grpc-api`, `media.channel.sdk`, `media.channel.web`. **Approved meaning:** A submission receipt is not transcription completion; session caption edits and immutable caption-version registration remain separate, and denied/UNKNOWN retain same source/version.

**Where:** `.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml`; `.product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml`; `.product-experience/pdp-3-product-experience/capability-invocation-adapters.yaml`; `.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml`; `.product-experience/pdp-1-domain-data/operations.yaml`; `.product-experience/pdp-1-domain-data/states.yaml`; `.product-experience/pdp-2-design-interface-system/interface-grammar.yaml`.

**How:** For EACH named channel: read existing p1OperationBindings, purposeBindingRefs, operationKinds and existing explicit P1 stateRefs/ownerTypedObservationContracts; establish full-coverage exact state OR exact typed observation cited by purpose/action/operation OR a source-proven no-P1-state typed result/owner-receipt/no-side-effect disposition. Verify all required operations are covered (not one partial overlap), exact artifact version, authority and fail-closed guards, success/denied/unknown/timeout/recovery, and channel-specific GUI/headless grammar. Keep transport UNBOUND and runtime NOT_ADMITTED until independently admitted. Never add guessed canonical state IDs, hardcoded endpoint, CLI fixture or observation ref without exact join. For each edge, record the specific chosen complete logical disposition and the actual owning result/state source; never satisfy a multi-operation journey through one overlapping observation.

**Acceptance:** Every named edge has a validated, source-linked complete logical state/observation OR explicit source-proven no-state representation; schema/operation cardinality and typed failure/recovery all validate. Negative cases reject missing/partial operation coverage and invented semantics. A nonadmitted transport is not grounds for fabricating an endpoint.


### MDC30-C-04 — J-04, 3 unfinished channel edges

**Owner:** Media speech/TTS, rights and consent owners. **Predecessors:** RC-P0-01 → RC-P1-01 → RC-P2-01 (material currentness) and the existing 29 source-bound edges (reused, not reworked).
**What:** Finish `AUTHORIZED_VOICE_SYNTHESIS_ASYNC_WITH_RIGHTS_GUARDS` on `media.channel.grpc-api`, `media.channel.sdk`, `media.channel.web`. **Approved meaning:** A voice/license choice or submit receipt cannot prove voice right, generated output, or approval; require consent scope, selected profile, exact source and typed later observation.

**Where:** `.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml`; `.product-experience/pdp-3-product-experience/journey-contracts/authorized-text-to-speech-to-approved-audio.yaml`; `.product-experience/pdp-0-product-truth/policy-authority-model.yaml`; `.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml`; `.product-experience/pdp-1-domain-data/operations.yaml`; `.product-experience/pdp-1-domain-data/states.yaml`; `.product-experience/pdp-2-design-interface-system/interface-grammar.yaml`.

**How:** For EACH named channel: read existing p1OperationBindings, purposeBindingRefs, operationKinds and existing explicit P1 stateRefs/ownerTypedObservationContracts; establish full-coverage exact state OR exact typed observation cited by purpose/action/operation OR a source-proven no-P1-state typed result/owner-receipt/no-side-effect disposition. Verify all required operations are covered (not one partial overlap), exact artifact version, authority and fail-closed guards, success/denied/unknown/timeout/recovery, and channel-specific GUI/headless grammar. Keep transport UNBOUND and runtime NOT_ADMITTED until independently admitted. Never add guessed canonical state IDs, hardcoded endpoint, CLI fixture or observation ref without exact join. For each edge, record the specific chosen complete logical disposition and the actual owning result/state source; never satisfy a multi-operation journey through one overlapping observation.

**Acceptance:** Every named edge has a validated, source-linked complete logical state/observation OR explicit source-proven no-state representation; schema/operation cardinality and typed failure/recovery all validate. Negative cases reject missing/partial operation coverage and invented semantics. A nonadmitted transport is not grounds for fabricating an endpoint.


### MDC30-C-06 — J-06, 3 unfinished channel edges

**Owner:** Media multimodal/capability operation owner. **Predecessors:** RC-P0-01 → RC-P1-01 → RC-P2-01 (material currentness) and the existing 29 source-bound edges (reused, not reworked).
**What:** Finish `EXACT_TARGET_COMMAND_IN_BOUNDED_JOB_SUBMIT_WRAPPER` on `media.channel.grpc-api`, `media.channel.http-api`, `media.channel.product-integration`. **Approved meaning:** Media action → exact capability target → owner job.submit wrapper are three different IDs; retain exact purpose/version, no QUEUED before owner receipt or output before owner observation.

**Where:** `.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml`; `.product-experience/pdp-3-product-experience/capability-invocation-adapters.yaml`; `.product-experience/pdp-1-domain-data/operations.yaml`; `.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml`; `.product-experience/pdp-1-domain-data/operations.yaml`; `.product-experience/pdp-1-domain-data/states.yaml`; `.product-experience/pdp-2-design-interface-system/interface-grammar.yaml`.

**How:** For EACH named channel: read existing p1OperationBindings, purposeBindingRefs, operationKinds and existing explicit P1 stateRefs/ownerTypedObservationContracts; establish full-coverage exact state OR exact typed observation cited by purpose/action/operation OR a source-proven no-P1-state typed result/owner-receipt/no-side-effect disposition. Verify all required operations are covered (not one partial overlap), exact artifact version, authority and fail-closed guards, success/denied/unknown/timeout/recovery, and channel-specific GUI/headless grammar. Keep transport UNBOUND and runtime NOT_ADMITTED until independently admitted. Never add guessed canonical state IDs, hardcoded endpoint, CLI fixture or observation ref without exact join. For each edge, record the specific chosen complete logical disposition and the actual owning result/state source; never satisfy a multi-operation journey through one overlapping observation.

**Acceptance:** Every named edge has a validated, source-linked complete logical state/observation OR explicit source-proven no-state representation; schema/operation cardinality and typed failure/recovery all validate. Negative cases reject missing/partial operation coverage and invented semantics. A nonadmitted transport is not grounds for fabricating an endpoint.


### MDC30-C-07 — J-07, 1 unfinished channel edge

**Owner:** Media audio enhancement and fidelity owner. **Predecessors:** RC-P0-01 → RC-P1-01 → RC-P2-01 (material currentness) and the existing 29 source-bound edges (reused, not reworked).
**What:** Finish `SOURCE_PRESERVING_ENHANCEMENT_COMPARISON` on `media.channel.web`. **Approved meaning:** Comparing or reviewing source/candidate output is read-only; any enhancement command must select explicit version/profile and preserve original source and quality/fidelity disclosures.

**Where:** `.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml`; `.product-experience/pdp-3-product-experience/journey-contracts/clean-noisy-interview-audio.yaml`; `.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml`; `.product-experience/pdp-1-domain-data/operations.yaml`; `.product-experience/pdp-1-domain-data/states.yaml`; `.product-experience/pdp-2-design-interface-system/interface-grammar.yaml`.

**How:** For EACH named channel: read existing p1OperationBindings, purposeBindingRefs, operationKinds and existing explicit P1 stateRefs/ownerTypedObservationContracts; establish full-coverage exact state OR exact typed observation cited by purpose/action/operation OR a source-proven no-P1-state typed result/owner-receipt/no-side-effect disposition. Verify all required operations are covered (not one partial overlap), exact artifact version, authority and fail-closed guards, success/denied/unknown/timeout/recovery, and channel-specific GUI/headless grammar. Keep transport UNBOUND and runtime NOT_ADMITTED until independently admitted. Never add guessed canonical state IDs, hardcoded endpoint, CLI fixture or observation ref without exact join. For each edge, record the specific chosen complete logical disposition and the actual owning result/state source; never satisfy a multi-operation journey through one overlapping observation.

**Acceptance:** Every named edge has a validated, source-linked complete logical state/observation OR explicit source-proven no-state representation; schema/operation cardinality and typed failure/recovery all validate. Negative cases reject missing/partial operation coverage and invented semantics. A nonadmitted transport is not grounds for fabricating an endpoint.


### MDC30-C-11 — J-11, 1 unfinished channel edge

**Owner:** Media editing/undo and version owner. **Predecessors:** RC-P0-01 → RC-P1-01 → RC-P2-01 (material currentness) and the existing 29 source-bound edges (reused, not reworked).
**What:** Finish `EXACT_REGION_EDIT_WITH_UNDO_AND_VERSION_GUARDS` on `media.channel.web`. **Approved meaning:** Preview/compare and local undo must not imply persisted artifact mutation; an actual edit uses exact source version/frame bounds, independent permission and typed conflict/recovery.

**Where:** `.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml`; `.product-experience/pdp-3-product-experience/journey-contracts/edit-tracked-media-region-with-undo.yaml`; `.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml`; `.product-experience/pdp-1-domain-data/operations.yaml`; `.product-experience/pdp-1-domain-data/states.yaml`; `.product-experience/pdp-2-design-interface-system/interface-grammar.yaml`.

**How:** For EACH named channel: read existing p1OperationBindings, purposeBindingRefs, operationKinds and existing explicit P1 stateRefs/ownerTypedObservationContracts; establish full-coverage exact state OR exact typed observation cited by purpose/action/operation OR a source-proven no-P1-state typed result/owner-receipt/no-side-effect disposition. Verify all required operations are covered (not one partial overlap), exact artifact version, authority and fail-closed guards, success/denied/unknown/timeout/recovery, and channel-specific GUI/headless grammar. Keep transport UNBOUND and runtime NOT_ADMITTED until independently admitted. Never add guessed canonical state IDs, hardcoded endpoint, CLI fixture or observation ref without exact join. For each edge, record the specific chosen complete logical disposition and the actual owning result/state source; never satisfy a multi-operation journey through one overlapping observation.

**Acceptance:** Every named edge has a validated, source-linked complete logical state/observation OR explicit source-proven no-state representation; schema/operation cardinality and typed failure/recovery all validate. Negative cases reject missing/partial operation coverage and invented semantics. A nonadmitted transport is not grounds for fabricating an endpoint.


### MDC30-C-12 — J-12, 1 unfinished channel edge

**Owner:** Media animation/composition owner. **Predecessors:** RC-P0-01 → RC-P1-01 → RC-P2-01 (material currentness) and the existing 29 source-bound edges (reused, not reworked).
**What:** Finish `ANIMATION_INTENT_PREVIEW_VS_PERSISTED_RENDER_RESULT` on `media.channel.web`. **Approved meaning:** A source-backed animation plan/preview is not a persisted artifact or final render; timing/geometry/export profile and provenance remain bound to exact selections.

**Where:** `.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml`; `.product-experience/pdp-3-product-experience/journey-contracts/animate-vector-or-procedural-scenes.yaml`; `.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml`; `.product-experience/pdp-1-domain-data/operations.yaml`; `.product-experience/pdp-1-domain-data/states.yaml`; `.product-experience/pdp-2-design-interface-system/interface-grammar.yaml`.

**How:** For EACH named channel: read existing p1OperationBindings, purposeBindingRefs, operationKinds and existing explicit P1 stateRefs/ownerTypedObservationContracts; establish full-coverage exact state OR exact typed observation cited by purpose/action/operation OR a source-proven no-P1-state typed result/owner-receipt/no-side-effect disposition. Verify all required operations are covered (not one partial overlap), exact artifact version, authority and fail-closed guards, success/denied/unknown/timeout/recovery, and channel-specific GUI/headless grammar. Keep transport UNBOUND and runtime NOT_ADMITTED until independently admitted. Never add guessed canonical state IDs, hardcoded endpoint, CLI fixture or observation ref without exact join. For each edge, record the specific chosen complete logical disposition and the actual owning result/state source; never satisfy a multi-operation journey through one overlapping observation.

**Acceptance:** Every named edge has a validated, source-linked complete logical state/observation OR explicit source-proven no-state representation; schema/operation cardinality and typed failure/recovery all validate. Negative cases reject missing/partial operation coverage and invented semantics. A nonadmitted transport is not grounds for fabricating an endpoint.


### MDC30-C-15 — J-15, 2 unfinished channel edges

**Owner:** Media simulation validation and integration owner. **Predecessors:** RC-P0-01 → RC-P1-01 → RC-P2-01 (material currentness) and the existing 29 source-bound edges (reused, not reworked).
**What:** Finish `SIMULATION_OBSERVATION_VS_PROTECTED_SEMANTIC_CHANGE` on `media.channel.product-integration`, `media.channel.web`. **Approved meaning:** Simulation quality observation may be a typed read with no Media domain transition; changing protected simulation semantics requires separately authorized owner operation, and quality evidence is not an execution guarantee.

**Where:** `.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml`; `.product-experience/pdp-3-product-experience/journey-contracts/refine-simulation-passes-with-semantic-validation.yaml`; `.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml`; `.product-experience/pdp-1-domain-data/operations.yaml`; `.product-experience/pdp-1-domain-data/states.yaml`; `.product-experience/pdp-2-design-interface-system/interface-grammar.yaml`.

**How:** For EACH named channel: read existing p1OperationBindings, purposeBindingRefs, operationKinds and existing explicit P1 stateRefs/ownerTypedObservationContracts; establish full-coverage exact state OR exact typed observation cited by purpose/action/operation OR a source-proven no-P1-state typed result/owner-receipt/no-side-effect disposition. Verify all required operations are covered (not one partial overlap), exact artifact version, authority and fail-closed guards, success/denied/unknown/timeout/recovery, and channel-specific GUI/headless grammar. Keep transport UNBOUND and runtime NOT_ADMITTED until independently admitted. Never add guessed canonical state IDs, hardcoded endpoint, CLI fixture or observation ref without exact join. For each edge, record the specific chosen complete logical disposition and the actual owning result/state source; never satisfy a multi-operation journey through one overlapping observation.

**Acceptance:** Every named edge has a validated, source-linked complete logical state/observation OR explicit source-proven no-state representation; schema/operation cardinality and typed failure/recovery all validate. Negative cases reject missing/partial operation coverage and invented semantics. A nonadmitted transport is not grounds for fabricating an endpoint.


### MDC30-C-16 — J-16, 2 unfinished channel edges

**Owner:** Media dubbing/localization and caption owner. **Predecessors:** RC-P0-01 → RC-P1-01 → RC-P2-01 (material currentness) and the existing 29 source-bound edges (reused, not reworked).
**What:** Finish `SOURCE_AND_LOCALE_BOUND_DUBBING_WITH_DRAFT_VS_VERSION` on `media.channel.grpc-api`, `media.channel.web`. **Approved meaning:** Caption timing, language, authorized voice and source version must be exact; a draft correction is not saved immutable caption, dubbing approval or delivery.

**Where:** `.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml`; `.product-experience/pdp-3-product-experience/journey-contracts/translate-and-dub-existing-video.yaml`; `.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml`; `.product-experience/pdp-1-domain-data/operations.yaml`; `.product-experience/pdp-1-domain-data/states.yaml`; `.product-experience/pdp-2-design-interface-system/interface-grammar.yaml`.

**How:** For EACH named channel: read existing p1OperationBindings, purposeBindingRefs, operationKinds and existing explicit P1 stateRefs/ownerTypedObservationContracts; establish full-coverage exact state OR exact typed observation cited by purpose/action/operation OR a source-proven no-P1-state typed result/owner-receipt/no-side-effect disposition. Verify all required operations are covered (not one partial overlap), exact artifact version, authority and fail-closed guards, success/denied/unknown/timeout/recovery, and channel-specific GUI/headless grammar. Keep transport UNBOUND and runtime NOT_ADMITTED until independently admitted. Never add guessed canonical state IDs, hardcoded endpoint, CLI fixture or observation ref without exact join. For each edge, record the specific chosen complete logical disposition and the actual owning result/state source; never satisfy a multi-operation journey through one overlapping observation.

**Acceptance:** Every named edge has a validated, source-linked complete logical state/observation OR explicit source-proven no-state representation; schema/operation cardinality and typed failure/recovery all validate. Negative cases reject missing/partial operation coverage and invented semantics. A nonadmitted transport is not grounds for fabricating an endpoint.


### MDC30-C-17 — J-17, 1 unfinished channel edge

**Owner:** Media audio mastering/fidelity owner. **Predecessors:** RC-P0-01 → RC-P1-01 → RC-P2-01 (material currentness) and the existing 29 source-bound edges (reused, not reworked).
**What:** Finish `MIX_MASTER_QUALITY_OBSERVATION_VS_DELIVERY` on `media.channel.web`. **Approved meaning:** Loudness and channel-layout measurements are read-only evidence; requested mix/master processing and eventual immutable delivered output are distinct effects and finality.

**Where:** `.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml`; `.product-experience/pdp-3-product-experience/journey-contracts/mix-and-master-music-and-effects.yaml`; `.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml`; `.product-experience/pdp-1-domain-data/operations.yaml`; `.product-experience/pdp-1-domain-data/states.yaml`; `.product-experience/pdp-2-design-interface-system/interface-grammar.yaml`.

**How:** For EACH named channel: read existing p1OperationBindings, purposeBindingRefs, operationKinds and existing explicit P1 stateRefs/ownerTypedObservationContracts; establish full-coverage exact state OR exact typed observation cited by purpose/action/operation OR a source-proven no-P1-state typed result/owner-receipt/no-side-effect disposition. Verify all required operations are covered (not one partial overlap), exact artifact version, authority and fail-closed guards, success/denied/unknown/timeout/recovery, and channel-specific GUI/headless grammar. Keep transport UNBOUND and runtime NOT_ADMITTED until independently admitted. Never add guessed canonical state IDs, hardcoded endpoint, CLI fixture or observation ref without exact join. For each edge, record the specific chosen complete logical disposition and the actual owning result/state source; never satisfy a multi-operation journey through one overlapping observation.

**Acceptance:** Every named edge has a validated, source-linked complete logical state/observation OR explicit source-proven no-state representation; schema/operation cardinality and typed failure/recovery all validate. Negative cases reject missing/partial operation coverage and invented semantics. A nonadmitted transport is not grounds for fabricating an endpoint.


### MDC30-C-21 — J-21, 2 unfinished channel edges

**Owner:** Media exact-version review/care rights owner. **Predecessors:** RC-P0-01 → RC-P1-01 → RC-P2-01 (material currentness) and the existing 29 source-bound edges (reused, not reworked).
**What:** Finish `VERSIONED_REVIEW_NOT_DETERMINED_BY_READ_ONLY_INSPECTION` on `media.channel.product-integration`, `media.channel.web`. **Approved meaning:** Viewing/commenting and formal APPROVED are not equivalent; only an explicit owner-authorized review operation can change formal review state on exact immutable version.

**Where:** `.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml`; `.product-experience/pdp-3-product-experience/journey-contracts/review-exact-version-and-recheck-changes.yaml`; `.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml`; `.product-experience/pdp-1-domain-data/operations.yaml`; `.product-experience/pdp-1-domain-data/states.yaml`; `.product-experience/pdp-2-design-interface-system/interface-grammar.yaml`.

**How:** For EACH named channel: read existing p1OperationBindings, purposeBindingRefs, operationKinds and existing explicit P1 stateRefs/ownerTypedObservationContracts; establish full-coverage exact state OR exact typed observation cited by purpose/action/operation OR a source-proven no-P1-state typed result/owner-receipt/no-side-effect disposition. Verify all required operations are covered (not one partial overlap), exact artifact version, authority and fail-closed guards, success/denied/unknown/timeout/recovery, and channel-specific GUI/headless grammar. Keep transport UNBOUND and runtime NOT_ADMITTED until independently admitted. Never add guessed canonical state IDs, hardcoded endpoint, CLI fixture or observation ref without exact join. For each edge, record the specific chosen complete logical disposition and the actual owning result/state source; never satisfy a multi-operation journey through one overlapping observation.

**Acceptance:** Every named edge has a validated, source-linked complete logical state/observation OR explicit source-proven no-state representation; schema/operation cardinality and typed failure/recovery all validate. Negative cases reject missing/partial operation coverage and invented semantics. A nonadmitted transport is not grounds for fabricating an endpoint.


### MDC30-C-22 — J-22, 4 unfinished channel edges

**Owner:** Media delivery and destination acknowledgement owner. **Predecessors:** RC-P0-01 → RC-P1-01 → RC-P2-01 (material currentness) and the existing 29 source-bound edges (reused, not reworked).
**What:** Finish `DELIVERY_REQUEST_RECEIPT_VS_EXTERNAL_ACK` on `media.channel.cli`, `media.channel.http-api`, `media.channel.product-integration`, `media.channel.web`. **Approved meaning:** Download/export/publish initiation is not completed delivery; external ACK/uncertainty must be attributable to exact output, destination and request identity, deny unknown retry.

**Where:** `.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml`; `.product-experience/pdp-3-product-experience/journey-contracts/deliver-export-with-destination-acknowledgement.yaml`; `.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml`; `.product-experience/pdp-1-domain-data/operations.yaml`; `.product-experience/pdp-1-domain-data/states.yaml`; `.product-experience/pdp-2-design-interface-system/interface-grammar.yaml`.

**How:** For EACH named channel: read existing p1OperationBindings, purposeBindingRefs, operationKinds and existing explicit P1 stateRefs/ownerTypedObservationContracts; establish full-coverage exact state OR exact typed observation cited by purpose/action/operation OR a source-proven no-P1-state typed result/owner-receipt/no-side-effect disposition. Verify all required operations are covered (not one partial overlap), exact artifact version, authority and fail-closed guards, success/denied/unknown/timeout/recovery, and channel-specific GUI/headless grammar. Keep transport UNBOUND and runtime NOT_ADMITTED until independently admitted. Never add guessed canonical state IDs, hardcoded endpoint, CLI fixture or observation ref without exact join. For each edge, record the specific chosen complete logical disposition and the actual owning result/state source; never satisfy a multi-operation journey through one overlapping observation.

**Acceptance:** Every named edge has a validated, source-linked complete logical state/observation OR explicit source-proven no-state representation; schema/operation cardinality and typed failure/recovery all validate. Negative cases reject missing/partial operation coverage and invented semantics. A nonadmitted transport is not grounds for fabricating an endpoint.


### MDC30-C-25 — J-25, 2 unfinished channel edges

**Owner:** Media integration/agent delegated authority owner. **Predecessors:** RC-P0-01 → RC-P1-01 → RC-P2-01 (material currentness) and the existing 29 source-bound edges (reused, not reworked).
**What:** Finish `BOUNDED_MACHINE_DELEGATION_NO_RECURSION_OR_UNADMITTED_TOOLS` on `media.channel.http-api`, `media.channel.product-integration`. **Approved meaning:** Machine delegated action is bounded by tenant/actor/purpose/budget/recursion and original request identity; a source-only integration does not become an admitted Tool or public API.

**Where:** `.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml`; `.product-experience/pdp-3-product-experience/journey-contracts/return-bounded-results-to-integrating-products.yaml`; `.product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml`; `.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml`; `.product-experience/pdp-1-domain-data/operations.yaml`; `.product-experience/pdp-1-domain-data/states.yaml`; `.product-experience/pdp-2-design-interface-system/interface-grammar.yaml`.

**How:** For EACH named channel: read existing p1OperationBindings, purposeBindingRefs, operationKinds and existing explicit P1 stateRefs/ownerTypedObservationContracts; establish full-coverage exact state OR exact typed observation cited by purpose/action/operation OR a source-proven no-P1-state typed result/owner-receipt/no-side-effect disposition. Verify all required operations are covered (not one partial overlap), exact artifact version, authority and fail-closed guards, success/denied/unknown/timeout/recovery, and channel-specific GUI/headless grammar. Keep transport UNBOUND and runtime NOT_ADMITTED until independently admitted. Never add guessed canonical state IDs, hardcoded endpoint, CLI fixture or observation ref without exact join. For each edge, record the specific chosen complete logical disposition and the actual owning result/state source; never satisfy a multi-operation journey through one overlapping observation.

**Acceptance:** Every named edge has a validated, source-linked complete logical state/observation OR explicit source-proven no-state representation; schema/operation cardinality and typed failure/recovery all validate. Negative cases reject missing/partial operation coverage and invented semantics. A nonadmitted transport is not grounds for fabricating an endpoint.


### MDC30-C-27 — J-27, 3 unfinished channel edges

**Owner:** Media runtime resilience and support-experience owner. **Predecessors:** RC-P0-01 → RC-P1-01 → RC-P2-01 (material currentness) and the existing 29 source-bound edges (reused, not reworked).
**What:** Finish `ELIGIBILITY_STATUS_AND_UNAVAILABILITY_ARE_READ_ONLY_UNTIL_EXPLICIT_COMMAND` on `media.channel.cli`, `media.channel.http-api`, `media.channel.web`. **Approved meaning:** Unavailable/stale/unknown status is a scoped observation, not failed job/effect, nor permission to resubmit; fallback requires current rights/licensing/quality/resources and explicit opt-in.

**Where:** `.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml`; `.product-experience/pdp-3-product-experience/journey-contracts/continue-safely-when-processing-is-unavailable.yaml`; `.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml`; `.product-experience/pdp-1-domain-data/operations.yaml`; `.product-experience/pdp-1-domain-data/states.yaml`; `.product-experience/pdp-2-design-interface-system/interface-grammar.yaml`.

**How:** For EACH named channel: read existing p1OperationBindings, purposeBindingRefs, operationKinds and existing explicit P1 stateRefs/ownerTypedObservationContracts; establish full-coverage exact state OR exact typed observation cited by purpose/action/operation OR a source-proven no-P1-state typed result/owner-receipt/no-side-effect disposition. Verify all required operations are covered (not one partial overlap), exact artifact version, authority and fail-closed guards, success/denied/unknown/timeout/recovery, and channel-specific GUI/headless grammar. Keep transport UNBOUND and runtime NOT_ADMITTED until independently admitted. Never add guessed canonical state IDs, hardcoded endpoint, CLI fixture or observation ref without exact join. For each edge, record the specific chosen complete logical disposition and the actual owning result/state source; never satisfy a multi-operation journey through one overlapping observation.

**Acceptance:** Every named edge has a validated, source-linked complete logical state/observation OR explicit source-proven no-state representation; schema/operation cardinality and typed failure/recovery all validate. Negative cases reject missing/partial operation coverage and invented semantics. A nonadmitted transport is not grounds for fabricating an endpoint.


### MDC30-C-30 — J-30, 3 unfinished channel edges

**Owner:** Media diagnostics/eligibility and CLI/API interface owner. **Predecessors:** RC-P0-01 → RC-P1-01 → RC-P2-01 (material currentness) and the existing 29 source-bound edges (reused, not reworked).
**What:** Finish `READ_ONLY_ELIGIBILITY_OBSERVATION_WITH_DISTINCT_UNAVAILABLE_DIMENSIONS` on `media.channel.cli`, `media.channel.http-api`, `media.channel.web`. **Approved meaning:** Provider qualification/license/health/capability and rights are separate; observation/readiness is not a command effect nor a future admission promise; unavailable facts remain UNKNOWN.

**Where:** `.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml`; `.product-experience/pdp-3-product-experience/journey-contracts/check-which-processing-options-are-eligible.yaml`; `.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml`; `.product-experience/pdp-1-domain-data/operations.yaml`; `.product-experience/pdp-1-domain-data/states.yaml`; `.product-experience/pdp-2-design-interface-system/interface-grammar.yaml`.

**How:** For EACH named channel: read existing p1OperationBindings, purposeBindingRefs, operationKinds and existing explicit P1 stateRefs/ownerTypedObservationContracts; establish full-coverage exact state OR exact typed observation cited by purpose/action/operation OR a source-proven no-P1-state typed result/owner-receipt/no-side-effect disposition. Verify all required operations are covered (not one partial overlap), exact artifact version, authority and fail-closed guards, success/denied/unknown/timeout/recovery, and channel-specific GUI/headless grammar. Keep transport UNBOUND and runtime NOT_ADMITTED until independently admitted. Never add guessed canonical state IDs, hardcoded endpoint, CLI fixture or observation ref without exact join. For each edge, record the specific chosen complete logical disposition and the actual owning result/state source; never satisfy a multi-operation journey through one overlapping observation.

**Acceptance:** Every named edge has a validated, source-linked complete logical state/observation OR explicit source-proven no-state representation; schema/operation cardinality and typed failure/recovery all validate. Negative cases reject missing/partial operation coverage and invented semantics. A nonadmitted transport is not grounds for fabricating an endpoint.



**Important test follow-through:** existing `tests/pdp3-journey-channel-contract-bindings.test.mjs` currently asserts historical `29` complete and `32` incomplete counts, and requires a positive state or exact observation ref. Update the test *together with canonical source changes*, to demand **zero logically incomplete** edges and verify a typed/source-backed no-state branch instead of removing checks. The expected **61 UNBOUND transports** may remain until Build; do not make the test falsely claim 61 runnable channels. Reject fake operation/version/schema, partial observation join, wrong authority, guessed state transition, missing source, and simulated CLI-as-production.

## Stage 3 — MDC30-S-06: exact multimodal submission decision

**What:** complete **one** exact P3 definition binding for `J-06:01`, without claiming execution. **Owner:** Media multimodal/domain submission + async job semantics owner. **Where:** `.product-experience/pdp-3-product-experience/capability-invocation-adapters.yaml` record `media.pdp3.invocation-adapter.j06-source-grounded.v1`, `journey-contracts/return-grounded-typed-consumer-results.yaml#/steps/0`, `journey-purpose-bindings.yaml`, P1 `operations.yaml` including `media.operation.job.submit.v1`, `scripts/lib/pdp3-step-capability-purpose.mjs`, `scripts/lib/pdp-job-submit-parameter-contract.mjs` and tests.

**Owner-approved exact meaning:** the user action `media.action.submit-validated-request` owns `media.operation.action.submit-validated-request`; explicitly selected capability `media.multimodal.observe.source-grounded` owns `media.operation.capability.media-multimodal-observe-source-grounded` (with exact version and closed target schema); invocation wraps the target in `media.operation.job.submit.v1`. These **three operation roles are not identical**. Validation must prove target binding uniqueness, source/version/purpose, actor/tenant/consent/rights, selected profile, resource limits, typed request fields and unknown-safe idempotent same-request reconciliation. Job `QUEUED` or result AVAILABLE is **not** inferred from merely submitting. Use existing `validatePdp3JobSubmitAdapter` and `resolveJobSubmitParameterSchema`; do not create a Media-only equivalent. Add negative cases for wrong target/version/schema, duplicate job, missing source/authority, recursion, untrusted actor labels and ambiguous outcome.

**How:** source-bind adapter ↔ J06 step ↔ exact purpose operation ↔ wrapper contract and its target parameter/schema validator. Retain `NO_P1_MACHINE_TRANSITION` and no job-state claim until actual owner-issued receipt/state observation is part of the exact definition. If the existing P1 canonical contract is actually incomplete, reopen the exact P1 owner ID and affected dependencies; otherwise P3-only resolution.

**Acceptance:** the triple link validates as exactly one chosen target for this journey, step sourceRefs and purposeRefs reconcile, typed request/result/error/finality/denied/unknown branches are complete, no fabricated runtime, and `node --test tests/media-pdp3-mdc30-s-step-bindings.test.mjs tests/pdp-experience-step-definition-oracle.test.mjs tests/pdp-experience-step-version-binding-contracts.test.mjs` passes after newly added negative cases.

## Stage 4 — MDC30-V-01 and the actually verified Experience Explorer

**MDC30-V-01 (Media experience/status owner).** Run `pnpm check:product-experience-local`; `node --test tests/media-pdp-p3-dev-status.test.mjs tests/pdp-3-overview-denominator.test.mjs tests/pdp-3-screen-source-bindings.test.mjs tests/pdp-3-definition-branch-coverage.test.mjs tests/pdp3-api-experience-source-bindings.test.mjs tests/pdp3-journey-channel-contract-bindings.test.mjs tests/media-pdp3-mdc30-s-step-bindings.test.mjs tests/media-discovery-current-cut-owner-plan.test.mjs`; plus all affected logical source/negative case suites. Re-generate manifests only through their scripts. Resolve all 50 P3 cells (26 physical, 6 compositions, root, 17 consumers incl archived explicit N/A) against a stable current source, current predecessor cuts and source graph, and issue a **new immutable** technical/currentness observation with actual tests. Do not overwrite historical `MDC30-R1` or try to change prior historical phase status. The 30 declared external contract matches in R2 are reusable only for those exact bytes; recheck if declared material changes.

**MDC-31 (Media Explorer + UX/a11y owner).** Make and verify actual Explorer inspectability: source hierarchy; 30 journeys and 130 steps; 47 screens and design-system tokens/components/layouts/templates; 61 channel edges (including 32 corrected) across API/RPC/SDK/CLI/Agent/Event consumers; 31 scenarios with positive/denied/unknown/timeout/recovery branches; source-currentness and N/A/UNBOUND disclosure; stable canonical search, deep-links, keyboard focus, tablet/mobile reflow, reduced motion/forced colors. Use `pnpm test:experience-browser` and `node --test tests/media-explorer-canonical-id-search.test.mjs tests/media-explorer-physical-topology.test.mjs tests/media-explorer-task-first-navigation.test.mjs tests/media-experience-explorer-accessibility.test.mjs tests/media-explorer-verification-interface-boundaries.test.mjs`. Create honest browser evidence (route/viewport/errors/screenshots/fixtures). A failing/unrun browser verification is **not** a PASS. Product runtime implementation remains BUILD.

**MDC-32 (Media PDP-3 status).** Validate current canonical 47 screens, 30 journeys/130 steps, 147 actions, 31 scenario definitions, 105 bounded-recovery oracles, source-specific channel and headless negative behavior, real Explorer verification and 50/50 exact source/applicability rows. Publish source-bound PDP-3 `DEV_COMPLETE` successor exit with zero remaining meaning IDs and separate owner/currentness/independent/closure fields. Accept a source-only interface contract with `NOT_ADMITTED` runtime only when logical behavior is fully defined; do not invent deployed endpoints, live video, 30 executable journeys, or independent certifications.

**MDC-40 (Discovery barrier).** Aggregate all four actual source-current exits over **200** phase-review cells; preserve deduplicated physical membership, explicit N/A decisions, owner/consumer roots, exact dependencies and affected successor receipts, actual browser inspections and zero meaning tasks. `DISCOVERY=PASS` only when every applicable phase/cell current, four source fingerprints congruent, no unknown input/owner meaning and full Explorer inspectability validated. Native PDP closure remains separate.

**MDC-41 (Build handoff).** Only after MDC-40 PASS, freeze source truth/versions and route runtime development/test tasks into BUILD; allow the independently authorized Lifecycle PDP acceptance/closure lane concurrently against the frozen sources. Release/Deliver wait for real Build verification, formal closure, external required professional/owner approvals and release qualification. The new handoff must include exact root+component fingerprints and implementation-test acceptance, not a claim that source definition produced a running product.

## Continuous protection against back-and-forth loops

- **Single owner and single phase:** phase-local meaning stays at PDP0/1/2/3 owner; status and Explorer are projections; external provider authority stays external.
- **Stop reopening unchanged definitions:** semantic source digest and declared dependency impacts decide tests; changed commit/derived index alone cannot reopen an untouched PDP meaning. Preserve old receipts and source-bound reuse; no re-execution of huge unrelated suites.
- **Do not accept missing technical meaning by assertion:** NO_P1_MACHINE_STATE needs positive proof and robust negative test; 32 incomplete edges cannot be stamped green by new status text.
- **Serialize authored sources and phase/currentness publication, parallelize only read-only scanning and resource-isolated tests**. On branch/source movement, recalculate affected material and invalidate only impacted cells and their required dependents.
- **No fabricated qualified reviews:** owner decisions in this document are explicitly AI-assisted internal delegation. Independent legal/security/privacy/a11y/public-contract owner approvals, if mandated later, remain genuine separate formal closure/Delivery gates.
- **No hidden Build work:** operational endpoints, storage/job handlers, production transports, runtime model/provider qualification, real UI integration and release/deploy are downstream Build/Deliver, not accepted substitutes for Discovery definitions.

**Owner approval status:** internal Media semantics and scope decisions **APPROVED** for the exact observed material and source-grounded rules above; technical currentness/authoring/test/Explorer/phase exits **not claimed**. **Current gate:** Discovery **FAIL**, Build NOT_ENTERED, native closure NOT_ENTERED, Delivery BLOCKED. **Next legal action:** RC-P0-01, then RC-P1-01, RC-P2-01, remaining PDP3 MDC30 work.
