# Logical surface: `media.surface.recorder-orchestrator`

Recorder orchestration channel. Physical owner:
`libs/audio-video-client/src/recorder-orchestrator.ts`.

## Supported operations

- `orchestrateScenario` — deterministic scenario planning (dry-run;
  does not itself perform capture).
- `recaptureScenario` — executes selected scene plans through
  `captureWithAdmission()` → `routedCaptureAdapter()` → concrete
  adapters; validates plan bounds, scene identities, selectors and
  ordering.
- Selective scene lineage and real end-to-end capture verified against
  live `node:http` server and temp files.

## States and invariants

- `executeScenario` now records actual authorized per-scene attempts,
  source digests and honest outcomes. Frame-aligned VTT/TTML caption plans
  use integer ticks and approved-narration gating.
- Remaining: real audio narration rendering, final media mux, qualified
  GRPC_API/CAMERA capture, finished playable recording and persistent
  artifact version. These are separate tasks, not a reason to recreate
  the already implemented orchestration and captions.
- Admission precedes resolution/transport; adapter failures become
  sanitized `CaptureOutcomeUnknownError`.

## Dependencies

`capture-adapters.ts` SPI + routed dispatcher; `http-capture-adapter`,
`file-capture-adapter`; `@audio-video/types` scene/plan contracts.

## Errors

Eligibility denial → zero adapter calls; unwired kind →
`OUTCOME_UNKNOWN`; malformed/mismatched frames sanitized.

## Tests

`recorder-orchestrator.test.ts` end-to-end real-capture suites;
`pnpm --filter @audio-video/client test` (reported 435 passing in latest
implementation pass; re-run affected suites after new API changes).
