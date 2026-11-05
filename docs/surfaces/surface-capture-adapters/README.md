# Logical surface: `media.surface.capture-adapters`

Capture provider channel. Physical owners:
`libs/audio-video-client/src/capture-adapters.ts` (typed SPI +
dispatcher) and `runtime-contracts` (capture source contracts).

## Supported operations

`CaptureSourceAdapter` SPI (`kind` + `capture(CaptureRequest) →
CapturedFrame`); `routedCaptureAdapter()` dispatches by
`CaptureSourceKind` with eager wiring validation;
`captureWithAdmission()` snapshots/validates exact source identity,
purpose, rights scope, version, secrets and frame-clock bindings.

Concrete adapters: `HttpApiCaptureAdapter` (HTTP_API — host-resolved
endpoints, HTTPS-or-loopback/allowlist, userinfo rejection, ≤5
revalidated redirects, deadline, byte cap) and
`MediaFileCaptureAdapter` (MEDIA_FILE — host-resolved path, optional
`allowedRoot` realpath containment, bounded reads).

## States and invariants

- Supported kinds: BROWSER, DESKTOP, MOBILE, TERMINAL, HTTP_API,
  GRPC_API, CAMERA, MEDIA_FILE — only HTTP_API and MEDIA_FILE are
  wired; others reject via `CaptureAdapterNotWiredError` before
  dispatch. Nothing simulates unwired providers.
- Admission outcomes: `ADMITTED`, `NOT_ADMITTED`, `UNAVAILABLE`.
- Errors never contain endpoint URLs, resolved paths, payload/provider
  detail or caller references.
- Captured bytes are detached and validated before entering the
  recorder pipeline.

## Dependencies

Host-trusted resolvers; `runtime-contracts` source contracts;
`libs/audio-video-types` frame contracts.

## Errors

`CaptureAdapterNotWiredError`, `CaptureOutcomeUnknownError` (sanitized),
eligibility denial before any transport effect.

## Tests

`capture-adapters.test.ts` (34 tests: real HTTP server, real temp
files, redirect/origin policy, oversize/timeout/escape → UNKNOWN,
denied-eligibility zero-dispatch); recorder end-to-end suites.
