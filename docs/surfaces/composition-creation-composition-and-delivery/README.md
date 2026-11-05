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
- Animation: `AnimationSpecCompiler` validates specs but reports
  `ANIMATION_RENDERER_NOT_ADMITTED` — no renderer claimed.
- Versioned export/delivery: artifact store + job finality via
  `providers/aws-postgresql`.

## Failure / rollback

Unadmitted spec/capability → typed rejection before render effect;
review/approval is an explicit state, not inferred; destination ACK
ambiguity → `UNKNOWN` pending reconciliation; no fabricated render or
delivery success.

## Cross-child behavior test

Spec → compile/admission → scene/timeline → render/mix → review →
export → destination ACK across studio UI, SDK and runtime; denial,
unknown and restart paths covered. Dedicated engines are plan work —
current coverage asserts fail-closed boundaries.

## Data flow

Creative spec → admission binding → deterministic scene/timeline →
engine execution (as admitted) → render/mix artifacts → review gate →
versioned export → destination acknowledgement → lifecycle events.
