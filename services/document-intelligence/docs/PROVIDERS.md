# Provider catalog

The catalog is local-only and pinned by `models/model-manifest.yaml` (default runtime) plus `models/increment4a/model-manifest.yaml` (Increment-4A profile). No request performs a model-hub download.

Two distinct runtime surfaces exist; they must not be conflated:

- **Default / no-profile runtime** — frozen Increment-3 authority. Providers: Docling, PaddleOCR (`en`, `ne`), GLiNER (`en`, `ne`), MiniLM. No provider falls back to another provider.
- **`increment4a` profile** — cumulative Increment-3 baseline plus the accepted Increment-4A delta. Providers are qualified per language dimension and composite routes may delegate internally.

## Default runtime (Increment-3, frozen)

| Provider | Identity | Input | Languages | Supported | Explicitly unsupported |
| --- | --- | --- | --- | --- | --- |
| Docling | `ghatana.docling` / `docling-standard-pdf-pipeline` | `application/pdf` | digital Unicode content; no language claim | PDF text, coordinates, tables | scanned/hybrid OCR, DOCX/PPTX/XLSX, remote plugins |
| PaddleOCR | `ghatana.paddleocr` / `PP-OCRv5-en` or `PP-OCRv5-devanagari-shared` | `image/png`, `image/jpeg` | `en`, `ne` only after measured acceptance | local OCR, coordinates, confidence | tables, missing language hint, hosted API, unmeasured languages |
| GLiNER | `ghatana.gliner` / `urchade/gliner_multi-v2.1` | bounded parsed lines | `en`, `ne` only after measured acceptance | `TEXT`, `IDENTIFIER`, confidence, multiple cardinality | MONEY, DATE, BOOLEAN, TABLE, OBJECT, LIST and arbitrary prompts |
| MiniLM | `ghatana.minilm` / `sentence-transformers/all-MiniLM-L6-v2` | structure projection v1 | language-neutral structure basis | 384 finite dimensions | template authority, vector-store promotion |

Docling uses `do_ocr=False`, table structure enabled, and no remote services/plugins. Paddle uses explicit orientation/preprocessing configuration and PP-OCRv5 for both English and Nepali. GLiNER uses fixed labels, fixed chunk budget and overlap. MiniLM uses a canonical TypeScript projection with IDs removed.

The exact revision and checksums are recorded in `models/model-manifest.yaml`. The default runtime's admission is pinned to the frozen Increment-3 provider authority artifact and its source SHA-256.

## Increment-4A profile

The `increment4a` worker profile loads `capabilities/increment4a.runtime-authority.json`, composed as the Increment-3 baseline plus the accepted Increment-4A delta (`capabilities/increment4a.accepted.json` from the active canonical run). Under this profile:

- Paddle OCR EN/NE/HI/MR: `QUALIFIED` and admitted; the shared Devanagari artifact covers `ne`/`hi`/`mr`.
- DOCX, PPTX, and XLSX required language dimensions: `QUALIFIED` and admitted; PPTX speaker notes are excluded from visible content.
- Hybrid PDF EN/NE/HI/MR and PDF OCR-region fallback EN/NE/HI/MR: `QUALIFIED` and admitted.
- PNG image fallback EN/NE/HI/MR (PaddleOCR → Tesseract): `QUALIFIED` and admitted through `ghatana.resilient-parser`.
- JPEG fallback: `NOT_EVALUATED`. JPEG parses directly through PaddleOCR only; the resilient route is not admitted for `image/jpeg`, and no fallback claim is made unless separately qualified.
- GLiNER schema-guided extraction HI: `NOT_QUALIFIED` / `DEFERRED_TO_FUTURE_RELEASE`; MR: `NOT_QUALIFIED` / `DEFERRED_TO_FUTURE_RELEASE`. Runtime admission rejects both; GLiNER remains admitted for `en`/`ne` only.
- Scanned-table structure reconstruction: `UNSUPPORTED_BY_DESIGN` in the current provider design and not advertised.
- Unknown languages and dimensions without evidence: `NOT_EVALUATED`.

### Internal runtime dependencies

Composite providers delegate through the worker executor, and every transitive dependency is warmed and readiness-checked at startup — a missing internal provider makes the worker `NOT_READY` even though it never appears in the public catalog:

- `ghatana.docling-docx` renders DOCX to PDF with pinned fonts and delegates to `ghatana.docling`.
- `ghatana.hybrid-pdf` delegates native pages to `ghatana.docling` and OCR regions to `ghatana.resilient-parser`.
- `ghatana.resilient-parser` delegates through the route table in `routing/parser-routing.v1.yaml`, including the qualified PaddleOCR→Tesseract image route.
- `ghatana.tesseractocr` is an **internal** dependency only: provisioned under `.models/tesseract-runtime`, loaded and readiness-checked when fallback routes depend on it, but never admitted to `/v1/providers` and never directly invocable by clients.

The qualified office renderer uses only the pinned font assets in `.models/office-renderer/fonts`. The legacy `DOCUMENT_INTELLIGENCE_OFFICE_RENDERER_HOST_FONTS` setting does not add host font directories to the qualified renderer; missing pinned fonts make the provider unavailable.

## Runtime authority and publication

`/v1/providers` publishes only providers admitted by the active authority and enabled in the worker configuration — the frozen Increment-3 artifact for the default runtime, or the pinned `providerAuthority`/`providerAuthoritySha256` under a profile. Each record carries its provider and model revisions, supported capabilities, and `promotionStatus: ACCEPTED`. PaddleOCR also publishes `languageModelIdentities`, with the exact English (`PP-OCRv5-en` / `PP-OCRv5-local-en`) and shared Devanagari (`PP-OCRv5-devanagari-shared` / `PP-OCRv5-local-devanagari-shared`) bindings. Disabled, unpromoted, internal-only, or authority-mismatched providers are not published.

Startup compares the loaded provider catalog against the pinned authority. A mismatch, unavailable authority, or unavailable internal dependency leaves `/healthz` live and makes `/readyz` return `503` with a safe reason code and diagnostic summary. The standalone live preflight writes the full comparison artifact and exits nonzero unless the worker is live, ready, and an exact semantic match:

```bash
uv run python scripts/verify_live_document_intelligence_authority.py \
  --url http://127.0.0.1:8765 \
  --output runtime-provider-authority-diff.json
```

The JSON artifact records the frozen source and semantic fingerprints, normalized expected and observed records, missing, unexpected, and mismatched records, plus liveness and readiness status. Paths and internal model locations are not included.
