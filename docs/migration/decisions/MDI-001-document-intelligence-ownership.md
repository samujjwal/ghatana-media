# MDI-001 — Document Intelligence is a Ghatana platform service

**Status:** accepted migration boundary decision  
**Authority:** the user's supplemental instruction on 2026-10-04  
**Source note:** [`document-intelligence-ownership-instruction.md`](./document-intelligence-ownership-instruction.md)

This decision supplements the expert-reviewed master plan and supersedes its
document-worker move instructions in §13.1–13.3 and MIG-002 to the extent that
they classify `services/media/modules/intelligence/document-intelligence-worker`
as Media-owned source.

The generic document-intelligence/OCR/parser runtime will not move into
`ghatana-media`. It remains a reusable Ghatana platform capability and is
rehomed behavior-preservingly to `ghatana/services/document-intelligence`.
Shared remains the owner of `@ghatana/documents` and
`@ghatana/document-extraction`. Document Intelligence owns generic parsing,
OCR/parser providers, extraction execution, evaluation and qualification.
Document Intelligence may consume AI Inference for generic model execution.

`ghatana-media` owns media-specific recognition intent and temporal/scene
semantics: frame sampling, shot selection, time ranges, region tracking,
duplicate suppression, scene identity, overlays, translation/render intent and
text use in editing or composition. It may call the Document Intelligence
public API through a narrow adapter. The MIME type alone does not determine
ownership: a receipt image is a document; text tracked across video frames is a
Media capability. Media must not copy Shared `ParsedDocument` or extraction
schemas or become the OCR dependency for other Ghatana consumers.

The worker is transferred at its existing internal layout under
`services/document-intelligence/` for the first move. Provider identities,
profiles, capability admissions, model manifests, evaluation assets, shared
contract lock, cancellation semantics, offline behavior, provenance and
non-activation state are preserved. Restructuring its modules is a later,
separately scoped change after parity.

This decision does not expand the work into a new OCR API, add providers or
activate document formats/models. It requires the migration inventory to split
the current worker by ownership, the Media build/package to omit the generic
worker, and current consumers to bind to Document Intelligence's public client
without changing their accepted contracts or qualification.

## Relationship to the master plan

All other master-plan migration requirements remain in force. The original
plan is preserved byte-for-byte in
[`../expert-reviewed-master-plan.md`](../expert-reviewed-master-plan.md); this
decision and the user's preserved source note provide the applicable
document-intelligence ownership overlay.

## Single Ghatana OCR authority — reaffirmed October 30, 2026

**Owner decision (refines MDI-001 without creating a second contract):** All OCR
execution anywhere in Ghatana is exposed **exclusively through Document
Intelligence**. Its frozen, provider-neutral `document-intelligence.v1` public
client/worker is the one gateway. PaddleOCR, Tesseract, Docling/hybrid PDF,
future OCR models, host-native engines and third-party providers are *internal
adapters chosen and qualified by Document Intelligence*. None are alternate
Ghatana product OCR APIs. No direct OCR-model imports into Media, Data Cloud,
TutorPutor, GharBatai, Kernel, Agents or other consumer products.

**Media remains a consumer, not an OCR producer.** Media may select frame
and ROI, preserve source version and digest, enforce authenticated tenant,
purpose and consent, map bounding boxes to frame/time/scene, and compose or
render recognized text. Those are Media business behaviors, not an alternative
recognition algorithm or generic provider. Its Media-owned
`authorized-scene-text.ts` must only reach Document Intelligence through
`DocumentIntelligenceSceneTextAdapter`; a generic local
`MediaSceneTextRecognizer` or model fallback is not an admitted production
choice. Missing DI availability makes only dependent OCR operations unavailable;
Media upload/jobs/speech/video continue independently.

**Development-stage cleanup decision:** The historical `OcrService`,
`KernelOcrProviderAdapter`, `VisionModelEngine.extractText`, and
`VisionDetector.extractText` are compatibility remnants, **not second OCR
services**. Freeze their provider admission (remain NOT_ADMITTED), migrate
every real consumer to the canonical DI client, and remove obsolete OCR
implementations/exports after precise source-free consumer conformance.
No new Media OCR worker is to be developed. Do not remove unrelated object
detection, video frame extraction or non-OCR Vision behavior.

**Single wire contract, adapter-based internals:** The DI worker retains its
existing frozen `document-intelligence.v1` schema, provider catalog,
cancellation generation and admission semantics. Add only registered,
backward-compatible optional extensions when necessary; the Media
frame/time/ROI/source-rights envelope stays **outside** DI's generic parse
contract, with a real authorized frame crop (not a made-up OCR API version).
All product consumers use the *published installed DI client* and its Shared
document-extraction peer at compatible, immutable versions. Internal OCR
provider adapters may be replaced without changing this gateway.

**Qualification is not inherited from an owner decision.** Current code/tests
demonstrate fail-closed adapters and source/rights checks but not an admitted
real OCR provider, publisher/installed-consumer parity, model rights, or real
image→text quality. The existing VIS-09 / OC-04 / Ghatana #252 gates remain
open until independently executed and recorded. No automatic PDP/gtool/release
status promotion. The `PDP0-003-D4` clarification in
`.product-experience/pdp-0-product-truth/ocr-ownership.yaml` is the one
Product Truth record of this decision.
