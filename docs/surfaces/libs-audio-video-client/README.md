# Surface: `libs-audio-video-client`

Typed TypeScript client for Ghatana Media: canonical artifact/job/stream SDK,
host-configured CLI, deterministic scenario recorder planning, and
the capture adapter SPI. Package: `@audio-video/client`
(`libs/audio-video-client`).

## Responsibility

- Expose the admitted HTTP operations (artifact upload sessions, artifact
  reads, job submit/list/get/cancel, stream open/get/connect/frame/close)
  through `MediaOperationClient` and `MediaCanonicalClient`.
- Provide the `ghatanamedia-api` CLI with exactly one production command:
  `artifact inspect`, backed by `MediaOperationClient.getArtifact()`. Artifact
  upload, upload-session inspection, job, batch, capture, recorder, and stream
  command identities fail as `INVALID_INVOCATION` before authentication or
  network dispatch. Broader SDK methods remain available to programmatic
  consumers; they do not add CLI commands. The separately maintained Explorer
  CLI remains fixture-only.
- Provide a separate `ghatanamedia-api-dev` executable with an explicit
  loopback-only local-development registry for `artifact upload`,
  `artifact inspect`, `job get`, and `job cancel`. The first three definitions
  bind to existing scoped HTTP operations. `job cancel` binds only to the
  signed DEV_ONLY loopback route, requires a stable request ID, and uses its
  durable reservation/replay behavior; its outcomes never imply provider
  finality. This local-development binding does not admit the production
  operation or host. The production CLI remains artifact-inspect-only and
  production admission remains OPEN.
- Validate local-development upload `contentType` with the same PDP-1 media-type
  predicate as the SDK during argument parsing, before credentials, source-file
  access, or host requests. Invalid invocation must return `INVALID_INVOCATION`
  with no fetch; this preflight does not change host authority or admission.
- Export `@audio-video/client/dev-project-timeline` as a separate loopback-only
  DEV_ONLY consumer for project context/create/read, timeline creation, and
  exact revision reopen and project-head CAS edits, including clip attachment
  and removal. Clip source inspection uses the existing
  `GET /api/v1/artifacts/{id}` operation and requires the verified identity's
  `media:artifact:read`; the exact artifact version and decimal-string rational
  source/story coordinates are included in the DEV_ONLY edit. It rejects
  non-loopback origins, omits cookies, rejects redirects, and never retries
  ambiguous mutations. This local-only transport does not add an OpenAPI or
  production route.
- Keep the legacy `AudioVideoClient` and `MediaOperationClient` method ABI for
  consumers while methods without an admitted Media route fail before HTTP
  dispatch. Canonical job/stream and artifact operations use the v1 routes.
- Provide the source-version-scoped caption-version HTTP transport and stable
  Java-compatible request fingerprint from browser and Node runtimes. The
  transport validates exact source scope, unique version IDs, and complete
  bounded caption snapshots before returning them to a host. Caller tenant and
  principal scope must match the transport's configured identity hints before
  reads dispatch; list/snapshot reads accept an `AbortSignal`.
- Queue offline project edits only when a host supplies a non-extractable key,
  ciphertext-only atomic store, fresh authorization callback, and exact-version
  replay port; reconnect also needs a host-supplied canonical project version
  read and CAS apply operation. Dirty drafts return `REVIEW_REQUIRED` by
  default. The host presents `readEdits()` separately from the current remote
  revision and passes that exact queue snapshot back for replay; a queue change
  during review requires another review. This is a review boundary, not owner
  authorization. The SDK does not provide a production key store, project edit
  route, or delivery writer.
- Plan unattended recordings deterministically (`orchestrateScenario`,
  `compileProductionPlan`) and execute bounded recapture only through the
  trusted capture eligibility seam (`recaptureScenario`).
- Host concrete capture providers per source kind behind
  `captureWithAdmission`; the client never fabricates frames.

## Public operations

| Subpath | Contents |
| --- | --- |
| `@audio-video/client` | SDK clients, types, error taxonomy |
| `@audio-video/client/dev-project-timeline` | Loopback-only DEV_ONLY project, timeline, owner-artifact read, and CAS clip edit client |
| `@audio-video/client/operations` | Operation-scoped client methods |
| `@audio-video/client/caption-version` | Browser-safe caption registration/read transport and stable fingerprint |
| `@audio-video/client/canonical-routes`, `/canonical-operations` | Route/operation manifests |
| `@audio-video/client/capture-adapters` | Eligibility seam, `CaptureSourceAdapter`, `routedCaptureAdapter` |
| `@audio-video/client/http-capture-adapter` | `HttpApiCaptureAdapter` (HTTP_API) |
| `@audio-video/client/file-capture-adapter` | `MediaFileCaptureAdapter` (MEDIA_FILE, Node.js) |
| `@audio-video/client/camera-capture-adapter` | `CameraCaptureAdapter`, `CameraCaptureSession`, typed consent/device/clock ports and errors |
| `@audio-video/client/recorder-orchestrator` | Scenario planning, lineage, bounded recapture |
| `@audio-video/client/recorder-checkpoint-store` | Node.js local checkpoint store with content-addressed captured bytes and restart-safe UNKNOWN fences |
| `@audio-video/client/ffmpeg-final-render` | Node.js host muxer using pinned FFmpeg/FFprobe executables and explicit source resolver |
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
revocation stops tracks and discards an in-flight frame. Host capture PTS must
fit a non-negative signed 64-bit value; invalid, throwing, or backwards host
clock observations fail closed and release the active track. This local
timestamp bound does not establish source-clock or physical-device
qualification. Browser consumers can compose the concrete host and adapter
with `createBrowserCameraCaptureAdapter({ sourceVersionRef, consent,
frameClock, ... })`, then register the returned adapter under `CAMERA` in
`routedCaptureAdapter`. The factory uses browser `Permissions` and exact-device
`getUserMedia`; the caller must still provide trusted Media consent and the
host epoch clock. The current source contract has no user-gesture-bound
first-use permission operation: a browser Permissions state of `prompt` (or
an unavailable Permissions API) remains `UNKNOWN`, so this factory requires
permission already granted by the browser and does not initiate a permission
prompt. Browser JPEG capture declares no source clock, and this consumer
wiring does not qualify physical devices. `BROWSER`, `DESKTOP`,
`MOBILE`, `TERMINAL`, and `GRPC_API` still have no wired adapter in this
package; nothing simulates those capture sources.

When a browser host supplies a `MediaStreamTrack`, its `ended` event releases
an idle stream immediately; event listeners are removed on teardown and when
startup fails. A subsequent frame read reports typed `DEVICE_UNAVAILABLE`.
If the track ends while `video.play()` is still starting, startup rechecks the
track state after playback resolves and rejects as `DEVICE_UNAVAILABLE`
instead of returning an already stopped device.
This is browser-host resource handling only: it does not establish physical
device qualification or integration with canonical stream sessions or writers.


## Local pinned FFmpeg render adapter

`PinnedFfmpegFinalRenderMuxer` implements the existing `FinalRenderMuxAndProbePort`
for a bounded local MP4 development profile. Its host configuration requires
absolute FFmpeg/FFprobe paths, exact executable SHA-256 pins, an expected version,
a source root, explicit scene/audio/caption resolvers, and a local development
license profile reference. Source paths are resolved through the injected host
resolver and must resolve to regular files inside that root. Video inputs are limited to
MP4/MOV/M4V/Matroska and audio to WAV/MP3/M4A/AAC; nested protocols are
restricted to local file/pipe and their demuxers are allowlisted. Each input is
bounded to 64 MiB, combined inputs to 256 MiB; the profile accepts at most 64
inputs, 1,920×1,080 output, 30-second default tool timeout and 64 MiB output. It currently accepts MP4,
constant frame rate, a `1/N` timebase, captions encoded as `mov_text`, and no
credit references; unsupported shapes fail before upload.

The adapter encodes H.264/AAC, stores narration track identities in observed
MP4 audio handler names, writes SRT from resolved caption text and exact request
ticks, decodes the complete video/audio output, and uses FFprobe stream/frame/
subtitle packet observations to construct the returned `RenderedContainer`.
`publishFinalRender` remains responsible for checking trusted rights admission
before codec work and canonical upload finality after it. The adapter alone does
not prove source rights, authorization, durable artifact registration or release
qualification.

The focused local positive generates three one-second color clips plus synthetic
440 Hz audio, muxes them with one timed caption, fully decodes the MP4, and checks
90 frames, 30 fps, 90,000 Hz timebase, 3-second duration and observed audio and
caption inventories. It uses the host's FFmpeg/FFprobe 6.1.1 wrappers with local
SHA-256 pins (`ebf248ee…c90ec04` and `871e88ff…f0c853d`) and the explicit
`local-development-fixture/gpl-ffmpeg-6.1.1` profile. This is isolated synthetic
fixture evidence only; it does not replace the repository's pinned production
codec profiles or establish that GPL codec binaries may be shipped. Real source
capture, licensed narration, credits, WebM, production hosts, and durable
artifact/job readback remain separate work.

## States and invariants

- SDK upload/job mutations carry stable request identity where the route
  contract defines it; lost acknowledgements surface `OUTCOME_UNKNOWN`, never
  fabricated success. These methods are programmatic SDK operations, not CLI
  command admissions.
- The CLI artifact query returns a point-in-time observation. An unavailable
  read does not establish global absence or failure; the production host is
  not qualified by local package behavior.
- Artifact reads return the runtime observation DTO, not the legacy product
  type; a 404 is scoped non-visibility, not global absence.
- Caption-version fingerprints remain synchronous and wire-compatible without
  importing Node crypto, so browser hosts can use the same registration/read
  contract. Caption list/snapshot responses are rejected as `UNKNOWN_OUTCOME`
  when malformed, duplicated, or outside the exact requested source scope.
- Scenario plans are deterministic: identical scenarios produce identical
  `planIdentity`/lineage; `changedSceneLineages` reports carried/replanned/
  removed scenes.
- `selectSceneCaptureWork` separates source acquisition from caption/narration edits;
  unchanged captured sources can be reused while downstream tracks are recomposed.
- `FileRecorderCheckpointStore` stores one scene attempt at a time and captured
  source bytes under their observed SHA-256 (16 MiB maximum per stored capture). It writes an `OUTCOME_UNKNOWN`
  intent before eligibility or capture dispatch; a process interruption therefore
  fences that scene for reconciliation instead of silently replaying it. The
  fence follows the scene ID across source revisions. An exclusive lock rejects
  concurrent writers. A process crash can leave a stale lock; reconcile owner
  state before removing it. This is a local development store, not a production
  database.
- `dryRunOnly: true` on `OrchestrationResult` — planning performs no effects.
- `publishFinalRender` detaches and deep-freezes canonical upload-session
  observations before later awaited admission checks, so adapter-retained
  objects cannot rewrite validated scope or chunk progress. This does not
  qualify a muxer/decoder or establish playable output.
- `publishFinalRender` snapshots each adapter ACK once and validates/reuses
  that detached snapshot for completion. A getter cannot return one tenant for
  validation and another during publication; snapshot failure after dispatch
  remains `OUTCOME_UNKNOWN`.
- `publishFinalRender` binds the created and acknowledged upload session to the
  requested retention duration, comparing valid ISO duration spellings by
  their millisecond value. For constant frame rate, the declared rational
  clocks must imply an integer frame count and the decoder's observed count
  must match it before upload. These checks bind local observations; they do
  not qualify a codec or establish production authority.
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
- Enqueue and conflict resolution snapshot own edit identity/scope fields and
  serialize the payload before awaiting the store. Replay similarly snapshots
  the reconnect scope before version preflight, so caller mutation while a
  store read is pending cannot retarget the encrypted record or version check.
- `OfflineEditQueue` snapshots and freezes its constructor options, pinning the
  host-selected store and key for the queue lifetime. Mutating the caller's
  options object during reauthorization cannot redirect later replay-state
  writes to a different store.
- Persisted encrypted envelopes are checked before WebCrypto: plaintext length
  metadata must be safe and within the configured cap, AES-GCM nonce length is
  12 bytes, and ciphertext length must equal plaintext length plus the 16-byte
  authentication tag. Decrypted byte length is checked again before JSON
  parsing; malformed records return `STORE_RECORD_INVALID` before rights or
  apply callbacks.
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
  so credentials are not forwarded. Original endpoint paths reject literal
  and percent-encoded dot segments before URL normalization. The fixture CLI
  remains a separate simulation surface. Programmatic SDK transports apply the
  same HTTPS/loopback, credential-free, query-free, and path-traversal checks
  before adding configured credentials.
- Document Intelligence scene-text consumption bounds a page to 5,000 blocks,
  2,000 lines per block, and 5,000 total observations before materializing
  Media observations. It consumes DI v1; it does not provide an OCR engine.

## Errors

Typed families: `MediaOperationNotAdmittedError` (unbound routes),
`CaptureNotAdmittedError`/`CaptureUnavailableError` (eligibility),
`CaptureOutcomeUnknownError` (post-dispatch ambiguity),
`CaptureAdapterNotWiredError` (no provider for kind), `ScenarioError`
(`INVALID_SCENARIO`/`ACTOR_UNRESOLVED`). Adapter and provider error detail
never enters results — only safe enums and fixed reasons.

## Source-free headless artifact/job example

[`examples/media-headless-api`](../../../examples/media-headless-api/README.md)
is a runnable Node consumer importing the public `operations` and
`canonical-operations` package subpaths. It reads an input file, begins an
upload, sends chunks, completes it, reads the immutable artifact back, submits
a `TRANSCODE` job hinted to `local-diagnostic`, and reads the job by its exact
request ID. It requires host-supplied `GHATANA_MEDIA_BASE_URL`, tenant,
principal, bearer token, and input file environment variables. It does not
mint credentials or add a CLI command.

```bash
pnpm --filter @audio-video/client build
GHATANA_MEDIA_BASE_URL=http://127.0.0.1:8080 \
GHATANA_MEDIA_TENANT_ID=tenant-1 \
GHATANA_MEDIA_PRINCIPAL_ID=principal-1 \
GHATANA_MEDIA_BEARER_TOKEN="$MEDIA_BEARER_TOKEN" \
GHATANA_MEDIA_INPUT_FILE=./sample.wav \
GHATANA_MEDIA_CONTENT_TYPE=audio/wav \
pnpm --filter ./examples/media-headless-api start
```

The example hashes and uploads in bounded sequential blocks from one open file
handle. Its filename or content type must make a supported Media format claim;
when both are known they must agree. Unsupported content types fail before
opening an upload session. The server still verifies the bytes at completion.

The local diagnostic job reports artifact metadata only (`rawMediaRead=false`);
it does not transform media or prove an external provider result. The job read
is a point-in-time observation and may be nonterminal. The example does not
claim provider finality, durable restart, production authentication, or release
qualification. Its injected-fetch contract check is runnable with
`pnpm --filter ./examples/media-headless-api test` and contacts no host.

## Tests and commands

```bash
pnpm --filter @audio-video/client typecheck
pnpm --filter @audio-video/client test        # build + vitest
pnpm --filter @audio-video/client test:package # isolated ESM/CJS consumer
pnpm --filter @audio-video/client exec vitest run src/cli.test.ts -t 'runs admitted upload and job commands through source-free child-process transport'
pnpm --filter @audio-video/client exec vitest run src/caption-version.test.ts
pnpm --filter @audio-video/client exec vitest run src/offline-edit-queue.test.ts src/offline-reconnect.test.ts src/camera-capture-adapter.test.ts src/package-surface.test.ts
```

CLI command regressions run the packaged Node entry point in child processes
with a socket-free fetch replacement. They check production-command
no-dispatch boundaries and local-development upload bytes, persisted session
readback, checksum-bound completion, scoped job observation, stable
cancellation request identity/replay, auth scope, and credential redaction.
These are local CLI and DEV_ONLY-host checks, not production Media integration
or provider-finality evidence.
Capture tests use a real `node:http` server and real temporary files; they
verify actual bytes, redirect/origin policy, byte/time bounds, symlink
containment, and UNKNOWN semantics. Camera tests use injected Node mocks and
prove state handling only; they do not prove real host permission or device
capture. No fixture frames stand in for a real capture provider.

Current focused verification for the DEV_ONLY timeline SDK passes 53/53, with
package typecheck/build and packed ESM/CJS/types consumer checks passing. The
project/timeline clip reference stores declared coordinates only; it does not
establish current rights/revocation, decoder-clock verification, overlap
semantics, rendering, Shared membership, or production authority. Production
CLI commands and route admission are unchanged.
