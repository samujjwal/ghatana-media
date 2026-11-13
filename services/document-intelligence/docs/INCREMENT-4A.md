# Increment 4A: Parsing Breadth, Language Qualification, and Resilience

## Authority boundary

Increment 3 authority is **FROZEN**. Its evaluation manifest, acceptance policy, environment, canonical results, model manifest, strict verifier, Shared contract lock, and semantic contract remain unchanged.

Increment 4A may change worker internals, the provider registry, routing, admitted media, candidate languages, composite providers, TypeScript client adapters, and Increment-4A evaluation material.

Increment 4A may not change `ParsedDocument`, `ExtractionCandidate`, execution or review states, evidence semantics, Shared provider ports, or Shared authority admission.

## Candidate scope

- Scanned and mixed PDF through an explicit composite parser
- DOCX, PPTX, and XLSX through format-specific parsers
- English, Nepali, Hindi, and Marathi qualification
- Independent OCR fallback with governed eligibility

Provider racing and LLM fallback are deferred to a later increment.

Candidate capabilities are not production-qualified until generated from a canonical Increment-4A qualification run. Languages outside `en`, `ne`, `hi`, and `mr` are `NOT_EVALUATED`, not unsupported by design.

## Closure

`scripts/verify_increment4a.py` must derive all leaves from real tests, evaluation evidence, and frozen fingerprints. Closure requires:

```text
sharedContractDrift = 0
increment3Regression = PASS
increment4a = PASS
```

## Historical closure status — revision 12 (superseded)

This record describes canonical-r12 as it stood before canonical-r13 and r14. The current freeze handoff at the end of this document supersedes its active-run and closure statements.

The strict verifier distinguishes test execution from capability qualification. The `increment4a` worker profile starts on `capabilities/increment4a.runtime-authority.json` — the cumulative Increment-3 baseline plus the accepted Increment-4A delta — and rejects unadmitted provider/language combinations. The default no-profile runtime is unchanged and still uses the frozen Increment-3 authority.

| Dimension | State |
| --- | --- |
| Paddle OCR EN/NE/HI/MR | `QUALIFIED` |
| DOCX/PPTX/XLSX required dimensions | `QUALIFIED` |
| PPTX visible content and note exclusion | corrected and `QUALIFIED` |
| Hybrid PDF EN/NE/HI/MR | `QUALIFIED` |
| PNG image fallback EN/NE/HI/MR | `QUALIFIED` |
| JPEG fallback | `NOT_EVALUATED` — direct PaddleOCR only, no fallback claim |
| PDF OCR-region fallback EN/NE/HI/MR | `QUALIFIED` |
| Schema-guided extraction HI | `NOT_QUALIFIED` / `DEFERRED_TO_FUTURE_RELEASE` |
| Schema-guided extraction MR | `NOT_QUALIFIED` / `DEFERRED_TO_FUTURE_RELEASE` |
| Scanned-table structure reconstruction | `UNSUPPORTED_BY_DESIGN`, not advertised |
| Unknown languages | `NOT_EVALUATED` |

The HI/MR extraction thresholds remain 0.80. The active canonical pointer selects `20260920T095300Z-canonical-r12` (`state: ACTIVE`). Its qualification summary is `PASS`, covers 61 observations, and has summary SHA-256 `ca2d728b91fc98229af0dbaf61fb9f77fb998b84ba9184b039a59550218efb74`. It records material fingerprint `dc5b2c475de1965fa50e31297035b2368c717a348025c2a018754c8ddf5492b2`, observations fingerprint `3d34bdf96e9c08737c4e9389a03dfad397435563fcf1f2c8120b5957c22cf1e1`, provider-semantics fingerprint `2871ea2ec73e3cd437a9213d086efe110fdf5f19862d5f7fc150ba14a957ef11`, and evaluator implementation fingerprint `5576862ca9160520e7acc47b814f52599706bc2d13c08b862748a0adfabf298a`.

Canonical-r12 reprojects the same 61 observations from its direct source run, `20260920T065400Z-canonical-r8`; its lineage records `providerExecutionReused: true`, `historicalProviderSemanticsBinding: RECORDED`, and `providerSemanticsBindingStatus: PASS`. The provider campaign was not rerun for r12. Canonical-r8 itself executed all 61 provider fixtures (`providerCampaignExecution: EXECUTED`, `providerExecutionReused: false`) and recorded the same provider-semantics fingerprint; it measured HI F1 0.20 and MR F1 0.3666667. Canonical-r4 predates provider-semantics fingerprints and remains historically `UNRECORDED`. Canonical-r5 reused observations from that unrecorded history and also remains historically `UNRECORDED`; r12's bound lineage to r8 does not backfill those older runs. Canonical-r6 was superseded after operation-generation cancellation semantics changed; canonical-r7 was superseded after the DELETE generation header contract was declared required.

The active material lock is `increment4a.material-lock.v4`, frozen at `2026-09-20T09:51:03Z`, with parent material fingerprint `1860d4d645f5cd62ead94c518303b69d5d3f2c6e14ce640636fcc06274a3b2d4`. Its provider-semantics and evaluator implementation fingerprints match r12. The lock records `LIVE_MODEL_RUNTIME_PIN_ALIAS_CORRECTION` and `OBSERVATIONS_REPROJECTED_FROM_CANONICAL_R8`. The model evidence verifier now maps frozen environment keys `runtime.python` and `runtime.uv` to report and manifest evidence keys `pythonVersion` and `uvVersion`, requiring nonempty exact matches and failing closed on missing or changed values. The focused regression for missing, empty, and mismatched environment values passed. The final strict verification for r12 passed: all 253 required pytest nodes passed on the fresh-material run. After an EOF-whitespace cleanup, the affected shutdown leaf ran again and passed 3/3; the final strict run reused the other matching receipts. All required leaves passed, shared-contract drift was 0, the Increment-3 strict regression passed, and the TypeScript live-engine surface passed. The deferral reason remains `QUALITY_BELOW_FROZEN_ACCEPTANCE_THRESHOLD` with `revisitTrigger: EXPLICIT_PRODUCT_REQUIREMENT`.

## Runtime hardening implemented after the canonical-r12 closure (historical notes)

These notes describe the historical r12/r14 implementation and generated authority. Provider source changed after r14, so its selected run, accepted-capability artifact, and generated Increment-4A runtime authority are stale for the current checkout. Keep them as historical records; do not treat their PASS/promotable values as current qualification or release activation. Current source requires requalification before those artifacts can be regenerated.

The qualified runtime surface is enforced at startup, not only by request-time admission:

- Admitted composite providers declare `runtime_dependencies()` and the worker loads the transitive closure before reporting ready — a missing internal provider (e.g. the Tesseract fallback runtime) reports `NOT_READY`.
- Tesseract remains internal: provisioned and readiness-checked, absent from `/v1/providers`, and unreachable by direct client admission.
- The qualified DOCX renderer defaults to ReportLab and requires both pinned `office-renderer` fonts at each render; host font directories cannot satisfy this requirement, and `auto` selection is rejected. `soffice` requires an explicit experimental override and emits a distinct provider identity.
- Operation IDs remain reserved through cancellation until the exact operation generation finishes. Shutdown drains late native work before closing providers or releasing model assets.
- `DELETE /v1/operations/{operationId}` is generation-bound through `X-Operation-Generation`; stale tokens cannot cancel a newer operation that reused the ID. See the README for the TypeScript client contract and legacy submission behavior.
- The model manifest is `FROZEN`, internally reconciles inherited and qualification authority hashes, and is pinned by `profiles/increment4a.yaml`.
- Canonical qualification records deterministic provider-semantic and evaluator implementation fingerprints; source drift marks its evidence stale.
- The strict verifier persists passing pytest leaf receipts in `evaluation/increment4a/test-receipts.json`, keyed by the frozen material, provider semantics, mapped test sources, pytest configuration, verifier logic, and relevant execution environment. It reruns leaves when any key changes; unbound external reports cannot satisfy strict mode.
- The profile health response reports `developmentState: DEVELOPMENT_COMPLETE` and `releaseActivationState: NOT_ACTIVATED` as lifecycle values. They do not assert that the current provider source is qualified; the freeze handoff below records the current verification state as open.
- `/v1/runtime-assets` derives the Paddle language surface from the accepted authority and reports internal dependency readiness without exposing paths.
- The strict gate verifies generated authority artifacts reproduce byte-for-byte (`generatedAuthoritiesCurrent`) and that the profile pins the committed runtime authority (`profileAuthorityPin`).

## Freeze record — FROZEN (2026-09-22, re-sealed after implementation epoch)

Increment 4A is frozen on the current checkout. The 2026-09-21 freeze was invalidated by the post-freeze implementation epoch and by a verification-demonstrated fix to the strict verifier's required-node timeout; the affected authority was requalified and re-sealed. The open handoff below is retained as the historical record of the r14 invalidation; the requalification it required has completed.

### Final disposition

```text
status: CLOSED
increment4a:
  state: FROZEN
  developmentState: DEVELOPMENT_COMPLETE
  releaseActivationState: NOT_ACTIVATED

canonicalRun:
  runId: 20260922T071420Z
  state: ACTIVE
  summarySha256: 6678a98641e860539e8b275e1aad1ba9314e473548b9d8a596c5daea6edef927
  materialFingerprint: 75cc92d9bb6ff8c2b93ec3160f5d8f18c7f66097a7563dc3de6b9d67eaab02f4
  providerSemanticsFingerprint: d6eaba84697b3fc5df9ccaa59ad3a1e1bb7eeca2e44bacc12b6343a6a2fea4ac
  evaluationImplementationFingerprint: f9c6cad69637ad03a80741ea5637473c08c8d15a9d9b608a6950d7bd57dc1f1a
  observationsFingerprint: 3a79b1e7f39daf6aeb6bc27d17c8ff1593a124c4caa7cb056a1b57f0e271ab80
  observations: 61 — reprojected from direct campaign 20260922T010529Z-canonical (provider semantics unchanged; evaluator implementation revised)
  qualificationSummary: PASS

strictGate:
  command: DOCUMENT_INTELLIGENCE_LIVE_WORKER_URL=http://127.0.0.1:18766 VITEST_MAX_WORKERS=1 uv run --frozen --offline python scripts/verify_increment4a.py --strict
  result: PASS
  increment3Regression: PASS
  sharedContractDrift: 0
  pytest: 256 passed on the re-sealed material (all required leaves PASS; receipts bound to canonical material fingerprint 75cc92d9)
  vitest: PASS (live engine conformance against the increment4a worker on 127.0.0.1:18766)
  materialLock: PASS (increment4a.material-lock.v4, parent e5994e5021996e3778789b62b7cbf52896afeeaf78b25038d9d435829345cb40)
  generatedAuthoritiesCurrent: PASS
  modelAssetsVerified: PASS
  uvLockSha256: fd4ef3f9291f5b281cf7372cbdc771f1882396d55993ea59e2ea1b9230993960

deferredDispositions:
  extraction.schema-guided.hi: NOT_QUALIFIED / DEFERRED_TO_FUTURE_RELEASE
  extraction.schema-guided.mr: NOT_QUALIFIED / DEFERRED_TO_FUTURE_RELEASE
  scannedTableStructureReconstruction: UNSUPPORTED_BY_DESIGN
  jpegFallback: NOT_EVALUATED

reopenPolicy: reopen only affected capability leaves for a consumer
  requirement, defect, dependency change, or release-readiness need.
```

The provider-source drift recorded in the handoff below was stabilized by committing the PaddleOCR/Docling changes (`f0b06baecb`), which moved the provider-semantics fingerprint to `772f9dfc11c6…`. The whole-set requalification ran as a direct campaign over all 61 fixtures (`providerExecutionReused: false`); r14 was superseded in `superseded-runs.json` with reason codes `PROVIDER_SEMANTICS_SOURCE_DRIFT` and `FRESH_PROVIDER_EVIDENCE_RECOLLECTED`. The `qualificationEvaluation` leaf's stale r8 anchor was re-pinned to the current canonical run (`test_reused_observations_with_current_provider_semantics_remain_eligible`).

## Freeze handoff — historical, superseded by the freeze record above (2026-09-20)

### Current disposition

Do not record Increment 4A as frozen from the current checkout. `canonical-run.json` still selects r14 with `state: ACTIVE`; that value selects the run pointer and does not mean its provider fingerprint is current. Provider source changed after r14, so its PASS summary, accepted capabilities, runtime authority, and passing receipts no longer qualify the current checkout. Release activation remains separate and is `NOT_ACTIVATED`. This handoff records the state and remaining work so later sessions can continue from evidence instead of repeating the investigation.

The last consistent r14 record was:

| Record | Value |
| --- | --- |
| Canonical run | `20260920T181900Z-canonical-r14` |
| Summary SHA-256 | `a27ccbf33c9daa8c09fb1fe6d3019021002411905fbc7f6516902dac61625be3` |
| Material fingerprint | `d97310ba708ce3ecdefefabb10bb10eb47d6988841834aa3dfb651a61fe192f8` |
| Provider-semantics fingerprint at r14 | `2871ea2ec73e3cd437a9213d086efe110fdf5f19862d5f7fc150ba14a957ef11` |
| Evaluator fingerprint | `17b50481c44c87eaf30f7beb7c5889957322580c9e9b21e85c19675196347534` |
| Observations | 61, reused from direct campaign r8 (`20260920T065400Z-canonical-r8`), fingerprint `3d34bdf96e9c08737c4e9389a03dfad397435563fcf1f2c8120b5957c22cf1e1` |
| `uv.lock` SHA-256 | `fd4ef3f9291f5b281cf7372cbdc771f1882396d55993ea59e2ea1b9230993960` |

The `uv.lock` reconciliation is implemented: freeze refreshes the runtime lock digest in the model manifest and evaluation environment, model verification checks both against the live lock file, and `runtimeEvidence` records the digest. The focused model-authority tests passed 10/10, verification-receipt tests passed 18/18, and `freeze_increment4a.py --check` passed before the later provider-source edits.

### Source drift found after r14

The shared worktree contains uncommitted edits to two files in the frozen `providerSemantics` source set:

| File | Observed local modification time | Behavior changed |
| --- | --- | --- |
| `src/document_intelligence/providers/paddle_ocr_parser.py` | 2026-09-20 12:01:52 PDT | Changes Paddle detection unclip ratio and scales OCR confidence using measured image contrast. |
| `src/document_intelligence/providers/docling_parser.py` | 2026-09-20 12:14:29 PDT | Uses pdfium text rectangles to split Docling PDF text items into per-line geometry. |

At the time of this handoff, the current provider-semantics fingerprint was `09eb9c202482c23721bbe454e07549ca1809617e41b62933f94d63d33b220944`, while r14 is bound to `2871ea2ec73e3cd437a9213d086efe110fdf5f19862d5f7fc150ba14a957ef11`. The receipt-context check returned `(None, None)` for the current checkout. The current provider edits therefore invalidate r14's qualification and its 45 passing Python receipts. Keep those receipts as historical r14 evidence; do not relabel them as current.

The file timestamps changed during this review. Before running another verification, confirm the separate session has stopped editing these files and capture one stable `git status` and diff. Do not discard or revert its edits without deciding whether they belong in the Increment-4A release scope.

### Verification attempts and duplicate-work record

- The r14 strict run completed 256 Python tests successfully, but its aggregate failed `liveEngineConformance`, `evaluationTests`, `increment3Regression`, and therefore `increment4a`. Its output is `/tmp/document-intelligence-increment4a-strict-output.log`. The command did not preserve detailed Vitest or Increment-3 child reports.
- An isolated, readiness-gated Increment-4A live Vitest run passed all 9 cases. Its report was `/tmp/increment4a-engine-live-vitest-ready.json`.
- A combined Vitest run with the outer Increment-4A worker on port `18765` passed 53 tests and failed the Hindi Paddle/GLiNER extraction with `EXTERNAL_CALL_TIMEOUT`. The Increment-3 live-engine test also starts its own worker on `18765`; the shared port and parallel file execution are test-runner setup conflicts.
- A combined run with the outer worker on `18766` and default Vitest parallelism passed 51 and failed 3 Increment-3 live engine cases with `EXTRACTION_OUTPUT_INVALID`. `docling_parser.py` was edited during this diagnostic period, so it is not authoritative against a stable source snapshot.
- A later strict attempt used worker port `18766` and `VITEST_MAX_WORKERS=1`. It was stopped after the receipt cache correctly treated r14 receipts as stale and began running the Python suite. It did not complete; its partial pytest progress is not a result.
- The earlier task **“Harden Increment 4A freeze”** recorded a 42/42 strict pass and Increment-3 pass on canonical-r5. That evidence predates r14 and the source edits above. The completed **“Implement OCR hardening plan”** task also has historical verification, not evidence for the present provider fingerprint. A Codex task listing showed no other active Codex verification task during this review; the file timestamps still show edits arriving during this review, so verify worktree stability directly before continuing.

### Remaining tasks

1. **Coordinate and stabilize the two sessions.** Confirm which changes to `docling_parser.py` and `paddle_ocr_parser.py` should be retained. Wait for all editing processes to stop. Record the stable source diff and timestamp snapshot. Preserve the changes unless the owner explicitly decides to defer them.
2. **Set the requalification scope from that snapshot.** Both changed files are covered by the whole-directory `providerSemantics` source set. The current run-reuse verifier requires the source run's provider fingerprint to match the current provider fingerprint for the whole observation set. It cannot reuse r8 unchanged or reuse only selected r8 observations under the new fingerprint. If these edits remain, do a direct canonical provider campaign for all 61 fixtures under the stable new source fingerprint; do not project r8 observations as if provider behavior were unchanged.
3. **Create the next material revision only after source stabilization.** Refresh model verification, material lock, canonical/profile pins, canonical run, accepted capabilities, and cumulative runtime authority. Keep the actual `uv.lock` SHA at `fd4ef3f9291f5b281cf7372cbdc771f1882396d55993ea59e2ea1b9230993960` unless the lock file itself changes.
4. **Verify generated authority and deferred dispositions.** Keep HI/MR schema-guided extraction `NOT_QUALIFIED / DEFERRED_TO_FUTURE_RELEASE`, scanned-table reconstruction `UNSUPPORTED_BY_DESIGN`, and all required qualified dimensions closed. Confirm the ReportLab DOCX path and Increment-3 cumulative runtime authority remain pinned.
5. **Run the focused checks on the stable revision:**

   ```bash
   uv run --frozen --offline python scripts/freeze_increment4a.py --check
   uv run --frozen --offline pytest tests/evaluation/test_model_authority.py
   uv run --frozen --offline pytest tests/evaluation/test_verification_receipts.py
   ```

6. **Run the final strict gate with unambiguous worker ownership.** Keep the external Increment-4A worker on `127.0.0.1:18766`; the Increment-3 live-engine suite uses `127.0.0.1:18765`. Set `DOCUMENT_INTELLIGENCE_LIVE_WORKER_URL=http://127.0.0.1:18766` and `VITEST_MAX_WORKERS=1` for the strict command so the heavy live files run serially. Wait for `/readyz` before starting verification. Keep the verifier's Python environment fixed so the receipt key stays stable.
7. **Capture the final proof durably.** Record command, environment, date, canonical run ID and summary hash, material/provider/evaluator fingerprints, `uv.lock` SHA, Python receipt count and verification time, Vitest result, Increment-3 result, shared-contract drift, and every aggregate status in this document. Preserve temporary raw logs only as supporting diagnostics.
8. **Close only after the final strict gate is green.** Then update the closure state to `developmentState: FROZEN / DEVELOPMENT_COMPLETE` and `releaseActivationState: NOT_ACTIVATED`. Retain the explicit future policy: reopen only affected capability leaves for a consumer requirement, defect, dependency change, or release-readiness need.

After the next successful strict run, matching keyed Python receipts can be reused when material, provider, per-leaf test/config/verifier hashes, and relevant environment values remain unchanged. The live Vitest and Increment-3 gate currently have no receipt cache and run again under strict mode. Provider-source changes invalidate the current r14 receipt context; their one-time requalification is necessary for the changed authority.

## Cross-increment seal — 2026-09-21 (post-freeze)

The document-intelligence program is sealed by
`docs/evidence/document-intelligence-freeze-set.v1.json`, generated and
reconciled by `scripts/build_freeze_set.py` (`--check` is read-only). The
manifest binds:

- **Provider/runtime stability** — `docs/evidence/provider-runtime-stability.json`
  declares `providerRuntimeState: STABLE`; any change under the protected
  source sets (`providers/`, `mapping/`, `strategies/`, `lifecycle.py`,
  `config.py`, `operations.py`, profile/catalog logic, worker protocol, model
  selection, runtime dependencies) invalidates it and routes back through the
  affected Increment-3/4A leaves.
- **Increment 3** — strict receipt `20260920T215719Z` reused against current
  input fingerprints; canonical run `20260920T213604Z-a5f2c729`; provider
  catalog `2c8abd11…`; Shared contract `be62f3a3…` (lock `6d9bed35…`).
- **Increment 4** — campaign manifest
  `products/org/docs/document-extraction/evaluation/results/campaign-manifest.json`
  (content-addressed evidence graph), consumer admission `ADMITTED`, strict
  report 55/0, closure `CLEAR`, release not activated.
- **Increment 4A** — canonical run `20260921T123710Z-canonical`, material lock
  `FROZEN`, 45 receipts bound to current material/provider semantics, profile
  pins verified.
- **Cross-profile isolation** — `docs/evidence/cross-profile-regression.v1.json`
  proves a default worker's catalog is byte-identical before and after an
  Increment-4A worker ran, across distinct processes.

Reuse rule for all of the above: observations may be reused only while every
bound fingerprint — provider semantics, provider implementations, model
manifest/assets, `uv.lock`, runtime/toolchain, corpus, evaluation
implementation and configuration — matches the sealed values.

Re-measurement note (2026-09-21): the seal's
`i4ProductImplementationCurrent` check correctly detected that the measured
Increment-4 campaign predated three product-source edits (language-hint
defaulting in `document-extraction.service.ts`, controller injection
declaration, and review-workspace i18n keys). The affected leaves were
re-run live against the current source — real worker `18765`, migrated
PostgreSQL `5435`, and the authenticated browser journey — and the freeze
set was rebuilt to `sealState: SEALED` only after the new campaign
(`increment4-1942879-1790018069833`) rebound every fingerprint to current
material. Release activation remains `NOT_ACTIVATED`.
