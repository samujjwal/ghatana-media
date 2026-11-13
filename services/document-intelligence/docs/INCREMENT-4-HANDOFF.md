# Increment 4 handoff: Governed Consumer, Durable Extraction State, and Template Intelligence

Increment 3 is closed and frozen (`docs/INCREMENT-3.md` closure record). This document is the worker-side handoff authority for Increment 4. It is not the product behavior authority — product execution authority lives in the consuming product repository (`products/org/docs/document-extraction/INCREMENT-4.md`).

Increment 3 answered: can the real Docling/PaddleOCR/GLiNER/MiniLM provider boundary obey the frozen `@ghatana/document-extraction` contracts? Increment 4 answers:

```text
Can a real product safely consume the frozen extraction engine
with real source authority, durable state, tenant isolation,
idempotent execution, template selection, review, and audit?
```

## Frozen inputs (worker-owned, do not reopen)

- `@ghatana/document-extraction` public runtime contract — semantic fingerprint `be62f3a3596b8f80462afa7769632645f53065f090db9c41db4b9d39a5e13964`, lock `contracts/shared-contract.lock.json`.
- Increment-3 provider protocol — HTTP worker boundary in `src/document_intelligence/app.py`, transport DTOs, error codes, deadline/limit semantics.
- Accepted provider capability catalog — successor fingerprint `2c8abd115056526510def605099a1aead08ab28071d4928e4619875534a455ab` (`evaluation/results/20260919T022904Z-cf9e659f/capabilities.json`); providers: docling, paddle-ocr-en, shared-Devanagari-paddle, gliner-en, gliner-ne, minilm. The prior fingerprint is retained as historical, non-promotable evidence for the affected Paddle leaf.
- Provider identities and measured evidence — successor run `20260919T022904Z-cf9e659f`; reconciliation record: `docs/evidence/increment3-reconciliation.json`.
- TypeScript client/adapters — `clients/typescript` (`@ghatana/document-intelligence-client`).

## Increment-4 owned (product side)

- Org source adapter — governed document/evidence resolution, CLEAN-only admission, tenant scope, digest verification, bounded byte stream.
- Schema adapter — product-owned versioned extraction schemas for existing onboarding document classes.
- Template adapter + template store — governed template records (`CANDIDATE`/`ACTIVE`/`RETIRED`), no customer-document retention.
- `StructureSimilarityPort` — MiniLM embedding → filtered candidates → cosine → deterministic `MATCHED`/`AMBIGUOUS`/`NO_MATCH`, policy frozen before activation.
- Durable execution repository, immutable result store, review store — org-scoped, CAS transitions, material-fingerprint idempotency.
- Audit adapter — product audit authority; no document bytes or extracted PII in logs.
- Product orchestration service, product API, review experience in the existing KYC surface.
- Production consumer registration — `ghatana-shared/config/consumers.json` and `platform/typescript/document-extraction/CONSUMERS.md` only after the real path passes.

## Not Increment 4

- Provider retraining, correction-derived learning, confidence recalibration — Increment 5.
- Automatic template discovery/promotion, model candidate generation, governed learned-artifact promotion — Increment 5.
- Provider fallback/racing, LLM fallback — deferred.
- New formats (DOCX/PPTX/XLSX), scanned-PDF hybrid strategy, additional languages — deferred.
- Vector DB platform, large-scale load/soak, production qualification/deployment certification — deferred.

## Invariants the product must preserve

```text
0 cross-tenant access
0 silent field mutation        — extraction never overwrites applicant/client identity
0 automatic KYC approval       — confidence never approves KYC; human review decides
0 provider-contract bypasses   — product speaks Shared ports, never provider SDKs
0 raw sensitive diagnostic leaks
0 duplicate authoritative results under retry
```

## Worker-side obligations during Increment 4

- Keep the provider protocol stable. Product-reported transport defects become new failing tests here, not contract changes.
- Shared contract remains frozen; consumer admission is a registration step, not a type change.
- If a genuinely new provider capability is required, it enters through a new evaluation lineage — never by rewriting the frozen Increment-3 evidence.
