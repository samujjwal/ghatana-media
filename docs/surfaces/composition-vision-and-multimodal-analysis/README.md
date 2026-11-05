# Composition: `media.composition.vision-and-multimodal-analysis`

Versioned image/video/ROI → Vision/DI and STT child analyses → rational
clock association → grounded typed fused result.

## Input / output

Input: versioned visual/audio artifacts with ROI and clock metadata.
Output: grounded multimodal analysis results with child source/clock
identities — fused, partial or explicitly unknown.

## Authority

- Vision: `modules/vision/vision-service` (10 gRPC methods;
  `PROVIDER_NOT_ADMITTED` until trusted license/provider admission;
  OCI-brokered codec execution, source-only).
- Multimodal: `modules/intelligence/multimodal-service`
  (`MULTIMODAL_FAMILY_NOT_ADMITTED` until canonical per-operation
  bindings; owns temporal association/fusion semantics only).
- DI owns generic OCR — Media consumes via qualified public client
  once gates pass; no Media OCR engine.
- Child analyses: STT/Vision services remain authoritative for their
  modalities; Multimodal composes, never duplicates.

## Failure / rollback

Incompatible clocks → typed rejection/unknown, never silent
re-association; child outage → partial/unknown fused result, not
fabricated completeness; detector admission absent → no detections;
broker ambiguity → `UNKNOWN` until reconciliation.

## Cross-child behavior test

Versioned input → Vision child analysis + STT child analysis → clock
association → fused result; covers incompatible clocks, child outages,
denied admission and unknown-outcome paths across gRPC boundaries.

## Data flow

Artifact version + ROI/clock refs → per-modality child jobs (fenced
attempts) → child results with provenance → rational-clock association
→ `CrossModalFusionEngine` → typed fused/partial/unknown result →
canonical job finality.
