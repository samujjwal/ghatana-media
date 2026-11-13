# Ghatana document intelligence worker

Increment 3 is a bounded local provider worker for the frozen `@ghatana/document-extraction` contracts.

**Single Ghatana OCR authority:** Document Intelligence is the **only**
Ghatana service that executes OCR. Other products—Media, Data Cloud,
TutorPutor, GharBatai, Kernel and agents—use the same installed public
`@ghatana/document-intelligence-client` gateway; none should implement
a competing OCR runtime. Model/engine switching happens **inside** DI using
its existing provider registry, declared profiles, bounded workers and
source-pinned provider adapters.

```text
Product consumers (Media / documents / data products / other apps)
                         │
                         ▼
       @ghatana/document-intelligence-client
                         │ public frozen v1
                         ▼
            document-intelligence-worker
                         │ internal provider adapter/router
           ┌─────────────┼───────────────┐
           ▼             ▼               ▼
        PaddleOCR     Tesseract         Docling / hybrid PDF
       (qualified)    (fallback)        (qualified profiles)
```

The Shared package is provider-neutral and frozen. The worker wire DTOs are transport-only and never replace Shared domain types.

## Operation cancellation

To make a submission cancellable, send a fresh 32-character lowercase hexadecimal `operationGeneration` for every submission in its JSON or multipart metadata, the `X-Operation-Generation` header, or both. Never reuse a generation token for another submission with the same operation ID. If both metadata and header values are present, they must match. The TypeScript client generates a fresh value for each call and sends it in both places, then reuses it for cancellation. `DELETE /v1/operations/{operationId}` requires that generation in `X-Operation-Generation`; a missing or malformed value is rejected, and a stale generation is an idempotent no-op. A cancellation that reaches the worker before its matching submission is retained briefly and applied when that generation begins. Legacy submissions without a generation remain accepted with a server-generated token, but they cannot be safely cancelled through the v1 endpoint without a caller-supplied generation.

## Local setup

```bash
python -m venv .venv
. .venv/bin/activate
pip install -e '.[runtime,providers,test,evaluation]'
python scripts/fetch_models.py
python scripts/verify_models.py
python -m document_intelligence.app
```

The process binds to `127.0.0.1` by default. Runtime model loading is offline and requires declared local assets.

## Verification

```bash
python scripts/verify_increment3.py
# Full promotion gate (requires provisioned model assets and pytest):
python scripts/verify_increment3.py --strict
pytest tests/contract tests/runtime tests/providers tests/adversarial tests/integration
python evaluation/run_evaluation.py --manifest evaluation/manifest.yaml --acceptance evaluation/acceptance.yaml --environment evaluation/environment.yaml
```

Consumer composition is resolved and present as a non-activating scaffold; activation and governance remain Increment 4 work in `docs/HOST-INTEGRATION.md`.

## Increment 4A status

Increment 4A is development-complete and its release activation remains `NOT_ACTIVATED`. The `increment4a` worker profile loads the cumulative provider authority at `capabilities/increment4a.runtime-authority.json` — the frozen Increment-3 baseline plus the accepted Increment-4A delta from the active canonical run. The no-profile runtime continues to use the frozen Increment-3 authority unchanged. OCR, Office, hybrid PDF, PNG image fallback, and PDF-region fallback are qualified per language; JPEG fallback remains `NOT_EVALUATED` (JPEG parses directly through PaddleOCR). Tesseract is an internal runtime dependency of the qualified fallback routes — loaded and readiness-checked at startup, never admitted to the public provider catalog.

Hindi schema-guided extraction: `NOT_QUALIFIED`, `DEFERRED_TO_FUTURE_RELEASE`. Marathi schema-guided extraction: `NOT_QUALIFIED`, `DEFERRED_TO_FUTURE_RELEASE`. Their measured results remain in the canonical evidence and they are never admitted or advertised. See `docs/INCREMENT-4A.md` for the dimensional status.

## Single OCR gateway and Media consumption

The accepted owner boundary is recorded in the Media product authority
`ghatana-media/docs/migration/decisions/MDI-001-document-intelligence-ownership.md`.
Document Intelligence owns **all OCR execution and provider qualification**.
Provider routing/adapters under `src/document_intelligence/providers/`,
`routing/parser-routing.v1.yaml`, `capabilities/` and `profiles/` select the
actual engine by source-declared media/language/model policy, not by importing
PaddleOCR/Tesseract/Docling directly from consumer repositories. This does
**not** mean every engine or language is admitted; `GET /v1/providers` is the
runtime qualification/readiness source, and unsupported/NOT_EVALUATED profiles
must fail closed.

Media constructs frame/ROI/scene/time and verifies current artifact, tenant,
principal, purpose, consent, source revision and digest itself. It invokes
DI's public `POST /v1/parse` for OCR, then associates verified text lines and
boxes with immutable frame and time source identity. No Media-owned OCR model
is valid. OCR failure only disables OCR-dependent Media features; speech/video
processing and job/asset state remain Media-owned and independent. Data Cloud
is an optional downstream metadata consumer, **not** the OCR execution owner.

**Developer-stage migration:** Replace surviving Media local `OcrService`,
`KernelOcrProviderAdapter`, `VisionModelEngine.extractText` and
`VisionDetector.extractText` consumers with this DI gateway and then delete
or retire the orphan compatibility implementations. Do not create
`document-intelligence.v2`, duplicate public OCR routes or automatically
activate unqualified models. The frozen v1 schema remains authoritative.

**Qualification gate:** The DI client source exists, but its current
`@ghatana/document-extraction: 0.1.0-SNAPSHOT` peer requires a reproducible
source-free installed client check and accepted model/rights/host evidence.
Run `pytest tests/contract/test_single_ocr_gateway.py` for static single-owner
regression, plus existing strict protocol, cancellation, provider readiness,
invalid tenant/source and real OCR image→text tests for actual admission. A
pure source-contract test **does not** prove a live OCR model or published
package. Track real public client/consumer adoption in Ghatana #252.
