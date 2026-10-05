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
