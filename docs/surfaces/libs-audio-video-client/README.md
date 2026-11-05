# Surface: `libs-audio-video-client`

Typed TypeScript client for Ghatana Media: canonical artifact/job/stream SDK,
headless CLI, deterministic scenario recorder planning, and the capture
adapter SPI. Package: `@audio-video/client` (`libs/audio-video-client`).

## Responsibility

- Expose the admitted HTTP operations (artifact upload sessions, artifact
  reads, job submit/list/get/cancel, stream open/get/connect/frame/close)
  through `MediaOperationClient` and `MediaCanonicalClient`.
- Provide the `ghatanamedia-api` CLI for host-configured artifact inspection.
- Plan unattended recordings deterministically (`orchestrateScenario`,
  `compileProductionPlan`) and execute bounded recapture only through the
  trusted capture eligibility seam (`recaptureScenario`).
- Host concrete capture providers per source kind behind
  `captureWithAdmission`; the client never fabricates frames.

## Public operations

| Subpath | Contents |
| --- | --- |
| `@audio-video/client` | SDK clients, types, error taxonomy |
| `@audio-video/client/operations` | Operation-scoped client methods |
| `@audio-video/client/canonical-routes`, `/canonical-operations` | Route/operation manifests |
| `@audio-video/client/capture-adapters` | Eligibility seam, `CaptureSourceAdapter`, `routedCaptureAdapter` |
| `@audio-video/client/http-capture-adapter` | `HttpApiCaptureAdapter` (HTTP_API) |
| `@audio-video/client/file-capture-adapter` | `MediaFileCaptureAdapter` (MEDIA_FILE, Node.js) |
| `@audio-video/client/recorder-orchestrator` | Scenario planning, lineage, bounded recapture |
| `@audio-video/client/production-plan` | Effect-free production plan compiler |

## Capture adapter contract

`CaptureRequest` binds `kind`, `sourceIdentity`, `purposeRef`,
`exactRightsScope`, `sourceVersionRef`, `secretsRef`, and `frameClockRef`.
`CaptureAdapterEligibility.check` is the trusted admission seam; caller
assertions are never inputs. `captureWithAdmission` snapshots the request,
checks eligibility per call, dispatches to the adapter, then validates the
returned `CapturedFrame` (binding echo, non-empty bounded bytes, safe
integer timestamp) and detaches the byte buffer.

- `ADMITTED` → dispatch; `NOT_ADMITTED`/`UNAVAILABLE` → typed rejection
  before any adapter call.
- Adapter rejection or invalid frame after dispatch →
  `CaptureOutcomeUnknownError` (`ADAPTER_REJECTED`/`INVALID_FRAME`); callers
  must reconcile before recapturing. No automatic retry.
- `routedCaptureAdapter` maps each `CaptureSourceKind` to at most one wired
  `CaptureSourceAdapter`; unwired kinds reject with
  `CaptureAdapterNotWiredError` before dispatch.

### Wired adapters

- `HttpApiCaptureAdapter` (`HTTP_API`): host `resolveEndpoint` maps the
  admitted request to a URL. HTTPS required except loopback or explicitly
  `allowedOrigins`-listed origins; userinfo URLs rejected; redirects followed
  manually (≤5 hops) with policy re-applied per hop; overall
  `timeoutMillis` deadline (default 30 s, max 300 s); body capped at
  `maxBytes` (default `MAX_CAPTURED_FRAME_BYTES` = 64 MiB).
- `MediaFileCaptureAdapter` (`MEDIA_FILE`, Node.js): host `resolveSource`
  maps to a local path; optional `allowedRoot` enforces realpath
  containment (symlink/`..` escapes rejected); bounded pre-stat and
  mid-read byte cap.

`BROWSER`, `DESKTOP`, `MOBILE`, `TERMINAL`, `GRPC_API`, and `CAMERA` have no
wired adapter in this package; hosts must supply qualified providers or the
requests remain `NOT_ADMITTED`/`UNAVAILABLE` — nothing simulates device or
browser capture.

## States and invariants

- Upload/job mutations carry stable request identity; lost acknowledgements
  surface `OUTCOME_UNKNOWN`, never fabricated success.
- Artifact reads return the runtime observation DTO, not the legacy product
  type; a 404 is scoped non-visibility, not global absence.
- Scenario plans are deterministic: identical scenarios produce identical
  `planIdentity`/lineage; `changedSceneLineages` reports carried/replanned/
  removed scenes.
- `dryRunOnly: true` on `OrchestrationResult` — planning performs no effects.

## Dependencies and configuration

- `@audio-video/types` (workspace), Node.js ≥18 platform APIs for the file
  adapter and CLI. The eligibility seam and routing are host-injected; the
  package ships `noAdmittedCaptureAdapter` (denies all) and
  `unavailableCaptureAdapter` (reports `UNAVAILABLE`).
- CLI bearer token is read only from `GHATANA_MEDIA_BEARER_TOKEN`; remote
  endpoints require HTTPS (plain HTTP only for loopback); redirects rejected
  so credentials are not forwarded.

## Errors

Typed families: `MediaOperationNotAdmittedError` (unbound routes),
`CaptureNotAdmittedError`/`CaptureUnavailableError` (eligibility),
`CaptureOutcomeUnknownError` (post-dispatch ambiguity),
`CaptureAdapterNotWiredError` (no provider for kind), `ScenarioError`
(`INVALID_SCENARIO`/`ACTOR_UNRESOLVED`). Adapter and provider error detail
never enters results — only safe enums and fixed reasons.

## Tests and commands

```bash
pnpm --filter @audio-video/client typecheck
pnpm --filter @audio-video/client test        # build + vitest (378 tests)
pnpm --filter @audio-video/client test:package # isolated ESM/CJS consumer
```

Capture tests use a real `node:http` server and real temporary files; they
verify actual bytes, redirect/origin policy, byte/time bounds, symlink
containment, and UNKNOWN semantics — no fixture frames stand in for capture.
