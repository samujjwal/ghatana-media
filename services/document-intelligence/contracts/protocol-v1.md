# document-intelligence.v1

All responses carry `protocolVersion`, `operationId`, and `providerRef`. Parse uses multipart `metadata` plus an opaque binary `file` part. Extraction carries only requested field descriptors and bounded parsed page/block/line material. Embedding carries only the canonical `document-structure-embedding.v1` projection. No Shared source authority, schema validators, normalizers, routing policy, review state, persistence authority, or filename crosses the process boundary.

Errors are exact, sanitized envelopes:

```json
{
  "protocolVersion": "document-intelligence.v1",
  "operationId": "operation-1",
  "code": "PROVIDER_FAILED",
  "retryable": false,
  "providerRef": "ghatana.docling"
}
```

`DELETE /v1/operations/{operationId}` requires the `X-Operation-Generation` header containing the operation's 32-character lowercase hexadecimal generation token. Cancellation is idempotent for that generation and wins over a late provider result; a stale token cannot cancel a newer operation that reused the same operation ID. Unknown keys, invalid identifiers, malformed numbers, unsupported media/language, unbounded arrays/strings, and provider identity mismatches fail closed.

Evidence `textSpan.start` and `textSpan.end` are zero-based, end-exclusive UTF-16 code-unit offsets into the referenced Shared line text. Python providers convert native Unicode code-point offsets to UTF-16 only when producing wire evidence; provider inference and internal projection continue to use code-point offsets.
