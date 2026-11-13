# Increment 3 final reconciliation evidence

Strict gate run on 2026-09-20 with `python scripts/verify_increment3.py --strict` (runId `20260920T215719Z`, receipt `docs/evidence/increment3-strict-receipt.json`).

Canonical frozen evaluation run: `evaluation/results/20260920T213604Z-a5f2c729/summary.json` (status `PASS`, all hard metrics zero). The summary binds `providerSemanticsFingerprint` and `evaluationImplementationFingerprint`, so provider/evaluator edits now invalidate measured evidence instead of silently inheriting it. Prior runs against earlier provider source or frozen authorities are marked `INVALIDATED_NON_PROMOTABLE` in their `lineage.json` markers — including `20260918T175824Z-26eb639a`, which was superseded for the Nepali Paddle model authority, and `20260919T022904Z-cf9e659f`, which predates the provider-semantics binding.

The provider catalog is unchanged: the new run's `capabilities.json` is byte-identical to the frozen Increment-3 authority (`sha256:2c8abd11…`), so the default-profile worker still binds the same frozen provider authority and the Increment-4 acceptance pins still hold.

| Leaf | Status | Evidence |
| --- | --- | --- |
| sharedContract | PASS | `capture-shared-contract.mjs --no-build` output byte-equal to `contracts/shared-contract.lock.json` |
| workerContract | PASS | contract + lifecycle test files via pytest JUnitXML |
| docling / paddleEnglish / paddleNepali / glinerEnglish / glinerNepali / minilm | PASS | provider unit + real-provider integration tests plus frozen evaluation thresholds per provider/language |
| cancellation / timeouts / cleanup / diagnosticSafety | PASS | mapped runtime and adversarial test files |
| evaluation | PASS | newest summary PASS, zero hard metrics, complete I3-11 metric surface, all seven frozen fingerprints match disk |
| offlineRuntime | PASS | all four providers executed under process-level denial of outbound socket and DNS primitives |
| sharedEngineConformance | PASS | 8 controlled engine scenarios, 4 live-worker engine/provider compositions, and 3 public helper admissions via vitest JSON |
| consumerScaffold | DEFERRED_TO_INCREMENT_4 | non-activating host module present with `enabled: false` |
| capabilityPromotion | PASS | accepted catalog exactly the four declared providers, docs parity in `docs/PROVIDERS.md` |
| increment3 | PASS | aggregate derived only from the leaves above |

## Provider reconciliation (2026-09-20)

The shared provider material was requalified once before this freeze:

- `docling_parser.py` — merged Docling items are split into real pdfium text lines; a block's `boundingRegion` is the union of the item provenance box and its line extents so `page ⊇ block ⊇ line` holds with true measured geometry (the earlier clamp-to-item variant was rejected because it distorted line evidence).
- `paddle_ocr_parser.py` — the `text_det_unclip_ratio=2.4` override was reverted: it produced identical recognition on every scanned fixture in the corpus but enlarged emitted boxes enough to break the frozen `layoutIoU` threshold. The contrast-based legibility confidence scaling is retained.
- `run_evaluation.py` — `layoutIoU` compares expected regions against block-level regions, matching the ground truth's logical-region granularity (identical to the pre-split measurement, and identical for providers whose block and line boxes coincide).
- `engine-conformance.test.ts` — the fake GLiNER wire now honors `requestedFieldIds`, matching the real adapter which sends only unresolved schema fields.
