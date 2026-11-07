# Surface: `libs-audio-video-client`

Typed TypeScript client for Ghatana Media: canonical artifact/job/stream SDK,
headless CLI, deterministic scenario recorder planning, and the capture
adapter SPI. Package: `@audio-video/client` (`libs/audio-video-client`).

## Responsibility

- Expose the admitted HTTP operations (artifact upload sessions, artifact
  reads, job submit/list/get/cancel, stream open/get/connect/frame/close)
  through `MediaOperationClient` and `MediaCanonicalClient`.
- Provide the `ghatanamedia-api` CLI for artifact and job reads/commands. Capture
  and recorder commands keep their CLI identities but return typed
  `NOT_ADMITTED` until canonical runtime contracts exist.
- Keep the legacy `AudioVideoClient` and `MediaOperationClient` method ABI for
  consumers while methods without an admitted Media route fail before HTTP
  dispatch. Canonical job/stream and artifact operations use the v1 routes.
- Queue offline project edits only when a host supplies a non-extractable key,
  ciphertext-only atomic store, fresh authorization callback, and exact-version
  replay port; reconnect also needs a host-supplied canonical project version
  read and CAS apply operation. The SDK does not provide a production key
  store, project edit route, or delivery writer.
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
| `@audio-video/client/camera-capture-adapter` | `CameraCaptureAdapter`, `CameraCaptureSession`, typed consent/device/clock ports and errors |
| `@audio-video/client/recorder-orchestrator` | Scenario planning, lineage, bounded recapture |
| `@audio-video/client/production-plan` | Effect-free production plan compiler |
| `@audio-video/client/offline-edit-queue` | Encrypted local edit queue with explicit rights/version/idempotency ports |
| `@audio-video/client/offline-reconnect` | Typed reconnect coordinator and host-supplied project-operation ports |

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

`CAMERA` has an injectable host-wired adapter. Its device, consent and frame
clock ports are host supplied: it does not call browser camera APIs, grant
permission, or establish that a real host device is authorized. It requires
fresh exact source/purpose rights before open and rechecks around frame reads;
revocation stops tracks and discards an in-flight frame. `BROWSER`, `DESKTOP`,
`MOBILE`, `TERMINAL`, and `GRPC_API` still have no wired adapter in this
package; nothing simulates those capture sources.

When a browser host supplies a `MediaStreamTrack`, its `ended` event releases
an idle stream immediately; event listeners are removed on teardown and when
startup fails. A subsequent frame read reports typed `DEVICE_UNAVAILABLE`.
This is browser-host resource handling only: it does not establish physical
device qualification or integration with canonical stream sessions or writers.

## States and invariants

- Upload/job mutations carry stable request identity; lost acknowledgements
  surface `OUTCOME_UNKNOWN`, never fabricated success.
- Artifact reads return the runtime observation DTO, not the legacy product
  type; a 404 is scoped non-visibility, not global absence.
- Scenario plans are deterministic: identical scenarios produce identical
  `planIdentity`/lineage; `changedSceneLineages` reports carried/replanned/
  removed scenes.
- `dryRunOnly: true` on `OrchestrationResult` — planning performs no effects.
- `publishFinalRender` detaches and deep-freezes canonical upload-session
  observations before later awaited admission checks, so adapter-retained
  objects cannot rewrite validated scope or chunk progress. This does not
  qualify a muxer/decoder or establish playable output.
- Offline edits persist AES-GCM ciphertext only; the key is host supplied and
  non-extractable. Reconnect returns `UNAVAILABLE` until the host supplies
  canonical project version-read and CAS apply operations. With those ports,
  reconnect checks exact tenant/project scope, fresh rights, exact current
  revision and the stored idempotency key before dispatch. Revoked, conflicting,
  and post-dispatch unknown outcomes are terminal; pre-dispatch authorization or
  version-read uncertainty leaves the edit `PENDING` for a fresh explicit
  reconnect. Unknown apply outcomes are never blindly retried.
- Offline edit payloads must be faithful, bounded JSON data trees (plain objects
  and dense arrays with finite numbers and no accessors or cycles). Validation
  counts the exact serialized UTF-8 bytes before stringification and rejects
  oversized or unsupported values; it does not coerce arbitrary JavaScript
  values into JSON.
- Unsupported legacy processing methods keep their public signatures but
  return a typed `NOT_ADMITTED` outcome without a network request. The canonical
  SDK remains the only client surface bound to the runtime route manifest.

## Dependencies and configuration

- `@audio-video/types` (workspace), Node.js ≥18 platform APIs for the file
  adapter and CLI. The eligibility seam and routing are host-injected; the
  package ships `noAdmittedCaptureAdapter` (denies all) and
  `unavailableCaptureAdapter` (reports `UNAVAILABLE`).
- CLI bearer token is read only from `GHATANA_MEDIA_BEARER_TOKEN`; remote
  endpoints require HTTPS (plain HTTP only for loopback); redirects rejected
  so credentials are not forwarded. Capture and recorder CLI commands are
  explicitly unavailable until their canonical execution ports are admitted.

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
pnpm --filter @audio-video/client test        # build + vitest
pnpm --filter @audio-video/client test:package # isolated ESM/CJS consumer
pnpm --filter @audio-video/client exec vitest run src/offline-edit-queue.test.ts src/offline-reconnect.test.ts src/camera-capture-adapter.test.ts src/package-surface.test.ts
```

Capture tests use a real `node:http` server and real temporary files; they
verify actual bytes, redirect/origin policy, byte/time bounds, symlink
containment, and UNKNOWN semantics. Camera tests use injected Node mocks and
prove state handling only; they do not prove real host permission or device
capture. No fixture frames stand in for a real capture provider.
