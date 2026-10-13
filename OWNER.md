# Ghatana Media — ownership

**Product and semantic owner:** Media product/platform engineering  
**Canonical Media product meaning:** `ghatana-media/.product-experience/`  
**Canonical executable runtime (until transfer):** `ghatana/services/media`  
**Product-definition state:** PDP-0…PDP-3 `DEV_COMPLETE`, remaining PDP tasks **0**

## Responsibilities

Media owns audio/video/image/speech/timeline product meaning: governed artifact and job versions, captions/revisions, streaming, scene and temporal interpretation, media-specific quality/uncertainty, user experience and public Media consumer contracts.

Media does **not** own Shared generic identity/workflow/messaging/UI primitives, generic Document Intelligence/OCR, generic AI Inference model governance, platform Data Cloud read models or Event Plane delivery, or Lifecycle proof issuance. [BOUNDARY.md](BOUNDARY.md) records authoritative ownership and migration conditions.

Route real implementation defects to the [Build program](docs/implementation/MEDIA-POST-PDP-BUILD-IMPLEMENT-TEST-DELIVER-2026-10-12.md). Changes to normative product meaning require a separately approved, versioned request. Transfer/release requires its actual accountable source and release owners. Do not invent an on-call address, named maintainer, or audit score.

Legacy `audio-video` package coordinates are retained where consumer compatibility requires them; new local names should express domain intent.
