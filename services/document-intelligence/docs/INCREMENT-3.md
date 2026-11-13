# Increment 3: Concrete Document Intelligence Providers

This worker proves concrete, locally hosted Docling, PaddleOCR, GLiNER, and MiniLM providers against the frozen Increment-2 contracts.

## Frozen authority

- `@ghatana/document-extraction`
- package version: `0.1.0-SNAPSHOT`
- the semantic lock in `contracts/shared-contract.lock.json` is the authority

## Allowed

Provider runtime, provider mappings, provider transport, provider adapters, evaluation corpus and metrics, provider-specific tests, and the non-activating host composition scaffold.

## Forbidden without explicitly reopening Increment 2

`ParsedDocument`, `ExtractionCandidate`, `FieldEvidenceRef`, `StructureDescriptor`, extraction schemas, execution/review states, source authority, correction semantics, routing semantics, provider port signatures, public errors, and public limits.

Provider inconvenience is not justification for changing Shared. The worker is a transport/runtime boundary, not a second document-extraction domain model.

## Execution evidence

The frozen Shared baseline is recorded under `docs/evidence/increment3-baseline.md`; the final strict-gate reconciliation is recorded under `docs/evidence/increment3-final.md`. `scripts/verify_increment3.py --strict` emits machine-readable per-leaf reconciliation derived from authoritative evidence: the Shared contract diff, the pytest JUnitXML run mapped to each leaf, the vitest JSON run mapped to the named engine-level scenarios, and the newest frozen evaluation summary validated for status, hard metrics, complete I3-11 metric surface, and frozen fingerprint freshness (manifest, corpus, acceptance, environment, model manifest). `offlineRuntime` is proven by executing all four providers under process-level denial of outbound socket and DNS primitives. `consumerScaffold` reports `PASS` for the non-activating host composition or `DEFERRED_TO_INCREMENT_4`; `increment3` is `PASS` only when every other emitted leaf is `PASS`. Consumer admission remains frozen; `S/CONSUMERS.md` and `ghatana-shared/config/consumers.json` are intentionally not edited.

## Closure record

```text
status: CLOSED

sharedContract:
  state: FROZEN
  semanticFingerprint: be62f3a3596b8f80462afa7769632645f53065f090db9c41db4b9d39a5e13964
  lockSha256: 6d9bed353280c0c22cfd534fa393bb466ede8218cf69b4521b8589eaee2a7f48
  lock: contracts/shared-contract.lock.json

providerCatalog:
  state: FROZEN
  fingerprint: 70673ee505bf5527de26aadb4d564bb370ce0712950db21f97663ccf80c4aec2
  source: evaluation/results/20260918T175824Z-26eb639a/capabilities.json
  providers: [docling, paddle-ocr-en, paddle-ocr-ne, gliner-en, gliner-ne, minilm]

evaluation:
  canonicalRun: 20260918T175824Z-26eb639a
  manifestFingerprint: 0be76defc0ab7c95f69a17b5478a8d6f87e471f67ac40961a4b7d7ae29cdd906
  corpusFingerprint: 0eeb0efb1fafb435a3cf5beffb5d78d27180d5dec1df6cca939191447a9c26be
  acceptanceFingerprint: 0dd78eb41720a5c0278faec8309b0eae5771fc31508273d99839e7d4ea9ad4c9
  modelManifestFingerprint: 18632d616f3aa35726fca5e66de17359c240a86b5bbf516cdf848d2fb371c595
  environmentFingerprint: d6cac6eaff3fcd8c473354332a52f0da53cf1b57d182c00bf8613158c2a996e9

unsupported:
  - scannedPdfHybrid
  - docx
  - pptx
  - xlsx
  - unmeasuredLanguages
  - providerFallback
  - providerRacing
  - llmFallback

nextIncrement: Increment 4 — Governed Consumer + Template Intelligence
```

This record is evidence identity, not Git authority. Future material changes produce new evaluation lineage rather than rewriting this frozen evidence.

## Authority reconciliation addendum (2026-09-19)

The historical Increment-3 state remains `CLOSED`. Only the Paddle/model-material
leaf was reopened for reconciliation because the provisioned Nepali artifact was
the shared Devanagari model while the historical record named `PP-OCRv5-ne`.
Docling, GLiNER, MiniLM, Shared, and their evidence remain frozen for reuse.

The successor authority is recorded in
`docs/evidence/increment3-reconciliation.json` and uses:

```text
providerCatalogFingerprint: 2c8abd115056526510def605099a1aead08ab28071d4928e4619875534a455ab
canonicalRun: 20260919T022904Z-cf9e659f
neModelRef: PP-OCRv5-devanagari-shared
neModelVersion: PP-OCRv5-local-devanagari-shared
modelManifestFingerprint: df2c11968b21c4cfe5c7ae6e8be8eb1764a950a12e5be355f475b9ba4511e2c4
strictMeasuredStatus: PASS
```

The prior run and final evidence remain retained as historical material and are
not overwritten; the successor is the only promotable authority for downstream
consumer reconciliation.

## Provider material requalification addendum (2026-09-20)

The shared provider implementation changed after the 20260919 authority run
(Docling line splitting, Paddle legibility confidence, related evaluator and
conformance corrections). Provider-bound evidence predating the
provider-semantics binding is retained but non-promotable; the measured lane
was requalified once against current source:

```text
canonicalRun: 20260920T213604Z-a5f2c729
providerSemanticsFingerprint: 772f9dfc11c67d481d4eef8b789baca5996f21d4aa8e163c4cd9613fcd599077
evaluationImplementationFingerprint: 3155819f54c00a4dec89be267a1d9c1e3e681b2e3c14ef2ed2097f9232f00532
providerCatalogFingerprint: 2c8abd115056526510def605099a1aead08ab28071d4928e4619875534a455ab
strictReceipt: docs/evidence/increment3-strict-receipt.json
strictReceiptRunId: 20260920T215719Z
strictMeasuredStatus: PASS
```

The provider catalog is byte-identical to the frozen authority, so downstream
pins (`expectedProviderCatalogFingerprint`, `observedProviderCatalogFingerprint`,
model manifest) still resolve unchanged. The strict gate now carries a
fingerprint-keyed receipt: executed leaves (pytest, vitest, tsc) may be reused
only while every declared material input matches, and strict output goes to
ephemeral locations so the gate does not mutate the source tree.
