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

- Plan targets remaining: authorized scheduling, actual adapter
  execution breadth, source- and scene-keyed recapture, narration,
  subtitle mux and final recording — reuse scenario version refs.
- Only `HTTP_API` and `MEDIA_FILE` have concrete adapters; other source
  kinds remain honestly unwired.
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
`pnpm --filter @audio-video/client test` (381 passed).
