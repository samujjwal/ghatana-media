# `@ghatana/document-intelligence-client`

This package is the TypeScript transport/admission boundary for the local Increment 3 worker. It depends on the real frozen `@ghatana/document-extraction` package and does not copy its interfaces. Every worker response is treated as `unknown`, strictly validated, then reconstructed into Shared types. Public Shared capability-admission helpers remain the final authority.


## Only public Ghatana OCR gateway

Every product requiring OCR (including video frame/scene-text in Media) must
consume this same `DocumentIntelligenceClient` and its frozen
`document-intelligence.v1` `providers()` + `parse()` calls. DI chooses
among its model/provider adapters internally, based on actual admitted
catalog/locale/MIME/rights and current model readiness. Products may map
recognized text to document fields or video frames/PTS/ROI, but must not
bypass DI by importing individual OCR provider implementations or running
parallel Media OCR engines. This library does **not** carry the Media-specific
frame/ROI/time/rights envelope; that remains in Media's own consumer.

Source-only TS client code and tests do not establish a published source-free
client, model qualification or permission to process protected source images.
The existing `0.1.0-SNAPSHOT` peer must be locked/qualified for publication
before Ghatana #252 is declared complete.

## Media packaging notes (MDI-002, PROPOSED)

Package `@ghatana/document-intelligence-client@0.1.0`, contract `document-intelligence.v1`, peer `@ghatana/document-extraction@0.1.0-SNAPSHOT`
(locked by `contracts/shared-contract.lock.json`). Public API: `DocumentIntelligenceClient` (`providers`, `parse`, `extract`, `embed`, `cancel`,
`cancelWithOutcome`), `PROTOCOL_VERSION`, wire validators, provider catalog/selection helpers and parser adapters.
Additive hardening relative to the Ghatana source: optional `maxResponseBytes` (default 32 MiB; oversized bodies are rejected unparsed) and
`cancelWithOutcome`, which returns `CANCELLED` only for a matching generation-bound positive acknowledgement and `UNKNOWN` otherwise.
The v1 wire body carries no tenant or principal; tenant isolation is enforced by the consumer (Kernel facade / Media adapter) before calling this client.
Not yet published or installed from an immutable registry artifact.
