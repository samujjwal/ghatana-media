# Evaluation

The frozen corpus is safe synthetic, public-domain, or redacted material described by `evaluation/manifest.yaml`. It covers English/Nepali digital PDFs, English/Nepali PNG/JPEG images, boundaries, GLiNER evidence, GLiNER negative/abstention fixtures, and MiniLM structure templates.

Metrics are frozen before a promotion run in `evaluation/acceptance.yaml`. Threshold-bearing metrics gate promotion: CER/WER, layout IoU, Docling table structure and cell text/coordinate/structure accuracy, GLiNER entity F1 and evidence accuracy, MiniLM recall@1/recall@5/stability. The full I3-11 metric surface is always emitted into `summary.json`, including informational values: region precision/recall, bounding-box agreement, reading-order correctness, GLiNER precision/recall/exact-match/abstention rate and negative-fixture max confidence, MiniLM same/different template cosine distributions and retrieval accuracy, per-provider p50/p95 latency, latency per page, page-count and input-byte coverage, sampled peak RSS and peak RSS growth alongside before/after RSS deltas, cooperative cancellation detection latency, and temporary-residue bytes.

GLiNER abstention is measured on negative fixtures with no honest entity: the provider abstains when every emitted candidate scores below `reporting.gliner.abstentionFloor` in `acceptance.yaml`.

Results are generated under `evaluation/results/<run-id>/`; the summary is never hand edited. Each run records `manifestFingerprint`, `corpusFingerprint`, `acceptanceFingerprint`, `environmentFingerprint`, and `modelManifestFingerprint` under `frozen`. A run is the promotion authority only when all five fingerprints match the files on disk at gate time. Earlier runs whose fingerprints do not match the current frozen authority are marked `INVALIDATED_NON_PROMOTABLE` in `lineage.json` and listed in `invalidatedRuns`.

To reproduce after provisioning models:

```bash
python scripts/fetch_models.py
python scripts/verify_models.py
python evaluation/run_evaluation.py --manifest evaluation/manifest.yaml --acceptance evaluation/acceptance.yaml --environment evaluation/environment.yaml
```

A capability is advertised only when its language/provider corpus passes. Unsupported functionality remains unsupported. A run with missing assets or missing measured scores is `NOT_RUN`, never `PASS`; the strict Increment-3 verifier treats that state as a promotion blocker.

Increment 4A uses `evaluation/increment4a/canonical-run.json`, not lexicographic result ordering. Qualification emits separate execution leaves and `requiredCapabilityLeaves`; measurement execution passing cannot turn a failed capability metric into a pass. Material review requires frozen reviewed ground truth, existing declared fixtures, matching material locks, and either ground truth or an explicit structural-only rationale. Runtime latency calibration is frozen at `evaluation/increment4a/calibration/runtime-latency.json`. The Hindi and Marathi schema-guided extraction leaves remain measured `NOT_QUALIFIED` at unchanged 0.80 thresholds and carry an explicit `DEFERRED_TO_FUTURE_RELEASE` closure disposition: the measurements are preserved in the canonical evidence, the capabilities are never promoted, and they no longer block Increment-4A closure.
