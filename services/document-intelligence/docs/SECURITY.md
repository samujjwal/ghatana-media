# Security and operational boundary

- Inference is local-only. `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, and `DOCUMENT_INTELLIGENCE_ALLOW_REMOTE=false` are defaults.
- The worker accepts bounded bytes, pages, text, blocks, lines, candidates, evidence and vector dimensions. Invalid or over-budget provider output fails closed.
- Temporary files use a worker-owned directory, random non-semantic names and restrictive permissions. They are removed after success, failure, cancellation, timeout, and startup scavenging.
- Logs contain only operation/provider/model identity, media type, byte/page counts, elapsed time, status and failure category. Document text, OCR text, values, filenames, binary content, raw output, credentials, tokens and temp paths are prohibited.
- Every request has a monotonic deadline and cancellation token. Capacity is bounded per provider; a saturated lane returns retryable `PROVIDER_BUSY`.
- Model identity and provenance are explicit. No `latest` selection, implicit download, provider fallback, racing, LLM fallback or hosted OCR client is allowed.
- The process boundary is internal HTTP bound to `127.0.0.1` by default. It is not a public endpoint or production deployment artifact.
