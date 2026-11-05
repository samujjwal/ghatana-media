# Logical surface: `media.surface.sdk`

Published typed SDK channel. Physical owners:
`libs/audio-video-client` (implementation) and `libs/audio-video-types`
(contracts). Published as ESM + CJS with isolated-consumer tests.

## Supported operations

Canonical job/artifact/capture/recorder operations via
`MediaCanonicalClient` (submitJob/getJob/listJobs/cancelJob/stream ops/
checkOutcome), `operations.ts` typed calls reconciled to OpenAPI
(`uploadPart` → `PUT /api/v1/artifacts/uploads/{uploadId}/chunks/
{chunkIndex}`), caption-draft sessions, scene-text adapter, capture
adapters (`HttpApiCaptureAdapter`, `MediaFileCaptureAdapter`,
`routedCaptureAdapter`), recorder orchestrator.

## States and invariants

- Exact admission and frame binding: captured frames bind all exact
  request fields (identity, purpose, rights scope, version, secrets,
  frame clock) with detached byte storage; eligibility denial precedes
  endpoint/path resolution or transport effects.
- Capture adapters remain bounded and host-resolved; unwired kinds
  (BROWSER/DESKTOP/MOBILE/TERMINAL/GRPC_API/CAMERA) reject via
  `CaptureAdapterNotWiredError` — nothing simulates them.
- Adapter failures/malformed frames become sanitized
  `CaptureOutcomeUnknownError`; no URLs, secrets or provider detail in
  errors.
- DI-only scene text, job reconciliation, abort and idempotent retry
  semantics per plan.

## Dependencies

`@audio-video/types` contracts; host supplies resolvers/adapters;
package exports verified for ESM and CJS subpaths.

## Errors

Typed SDK errors; `NOT_ADMITTED`/`OUTCOME_UNKNOWN` semantics preserved;
no false success after admitted effects.

## Tests

`pnpm --filter @audio-video/client test` (**381 passed / 42 skipped**),
`typecheck`, package build (ESM+CJS), `test:package` isolated consumer,
subpath smoke tests, `pnpm test:typed-contract-bindings` (39/39).
