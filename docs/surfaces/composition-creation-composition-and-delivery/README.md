# Composition: `media.composition.creation-composition-and-delivery`

Authorized creative spec → deterministic scene/timeline → real
rendering/mix → review/approval → versioned export and destination
acknowledgement.

## Input / output

Input: authorized creative specs (storyboard, simulation, 3D, dubbing,
mixing, delivery, interactive experiences). Output: rendered/mixed
media, reviewed approvals, versioned exports with destination ACKs.

## Authority

- Spec compilation/admission: `runtime-contracts`
  (`MediaProductionSpecCompiler`, `MediaProductionAdmissionBinding`,
  `MediaProductionSemanticSource`,
  `MediaProductionSchemaFormatAssertions`);
  `MediaCapabilityNotAdmittedException` keeps unqualified capabilities
  fail-closed.
- UI/studio surfaces: `libs/audio-video-ui` ports (production-studio
  logical surface).
- Recorder path: `libs/audio-video-client` orchestrator + capture
  adapters (HTTP_API/MEDIA_FILE wired; others honestly unwired).
- 2D animation: `AnimationSpecCompiler` validates the versioned envelope;
  `modules/production/animation` renders a bounded, resolved rectangle/ellipse/
  line/particle subset to deterministic PNG frames. Opaque envelope references
  are not resolved into scene objects, and this local renderer does not provide
  video codec output, 3D, audio, or rights-aware asset loading.
- 3D animation: `SpatialRigEngine` produces a bounded local GLB candidate. The
  J-13 scenario slice verifies that source-bound pose output matches the
  encoded node hierarchy and translation/quaternion accessors, with exact
  source/revision/frame metadata and digest. This does not establish viewer
  fidelity, canonical job persistence, restart, or delivery.
- Versioned export/delivery: artifact store + job finality via
  `providers/aws-postgresql`.
- Delivery operation scope preserves the exact tenant, principal, request,
  artifact, version, digest, destination, fingerprint, and dispatch-owner
  values. Blank or surrounding-whitespace values are invalid rather than
  normalized, so delivery identity remains exact across persistence and
  reconciliation.

## Failure / rollback

Unadmitted spec/capability → typed rejection before render effect;
review/approval is an explicit state, not inferred; destination ACK
ambiguity → `UNKNOWN` pending reconciliation; no fabricated render or
delivery success.

## Cross-child behavior test

Spec → compile/admission → scene/timeline → render/mix → review →
export → destination ACK across studio UI, SDK and runtime; denial,
unknown and restart paths covered. Current 2D coverage verifies local PNG
rendering and bounded inputs; the composed Studio/export journey and the
remaining media engines are still implementation work.

## Data flow

Creative spec → admission binding → deterministic scene/timeline →
engine execution (as admitted) → render/mix artifacts → review gate →
versioned export → destination acknowledgement → lifecycle events.
