# @audio-video/client

Typed client for source-bound Media artifact and job operations. Historical modality facade exports remain for source compatibility; they return `NOT_ADMITTED` without making an HTTP request because their legacy routes have no current source binding.

## What it provides

- `MediaOperationClient` for scoped artifact upload and inspection.
- `MediaCanonicalClient` for the observed job and stream routes.
- Request timeout, cancellation, stable request identity, and typed `OUTCOME_UNKNOWN` handling for dispatched mutations.
- Tenant and caller scope propagation through configured transport.
- `MediaDevProjectTimelineClient` on the separate
  `@audio-video/client/dev-project-timeline` subpath for the loopback-only
  `/dev/v1` preview. It requires a DEV_ONLY token, never sends credentials off
  loopback, reads the host-selected synthetic development workspace, creates
  and reopens exact project revisions, and returns typed stale/unknown
  outcomes without retrying mutations.

`AudioVideoClient` methods for transcription, synthesis, AI voice, vision, and
multimodal processing are compatibility stubs until their operation and route
bindings are admitted. They report `NOT_ADMITTED`; they do not contact a
provider or a legacy endpoint. Use the canonical artifact and job clients for
the currently bound HTTP operations described below.

## Development

```bash
pnpm --filter @audio-video/client test
pnpm --filter @audio-video/client build
```

## Canonical artifact read migration

`MediaOperationClient.getArtifact()` reads `GET /api/v1/artifacts/{artifactId}`
and returns the exact runtime observation type exported from the
`@audio-video/client/operations` subpath:

```ts
import type { CanonicalMediaArtifactObservation } from '@audio-video/client/operations';
```

The result uses runtime field names such as `artifactId`, `contentType`,
`sha256`, `principalId`, and `objectReference`. It is not the older
`@audio-video/types` `MediaArtifact` product shape; that existing type remains
available for its other source-compatible APIs. Artifact reads require
`defaultHeaders: { 'X-Principal-Id': callerPrincipalId }` in addition to the
client's tenant configuration. A 404 preserves the runtime's
`ARTIFACT_NOT_FOUND` code and correlation identity and means only that the
artifact was not visible in the supplied tenant and principal scope.


## Canonical upload migration

`MediaOperationClient.createUploadSession()`, `uploadPart()`, and
`completeUploadSession()` use the runtime routes under
`/api/v1/artifacts/uploads`. Upload requests now use the runtime field names
`contentType`, `expectedSizeBytes`, `expectedSha256`, `classification`, and
ISO-8601 `retention`; the old `mimeType`, `sizeBytes`, `checksumSha256`, and
`kind` request fields are not aliases. Create requests also retain the declared
`idempotencyKey`, sent as `Idempotency-Key`. The current runtime handler does
not establish replay behavior for that key, so callers must not infer a
replay-safe create from the header.

Upload methods require `defaultHeaders: { 'X-Principal-Id': callerPrincipalId }`
and send that caller scope with the configured tenant. Upload sessions use the
exported `CanonicalMediaUploadSessionObservation` runtime DTO. `uploadPart()`
accepts the session's current zero-based `nextChunkIndex`, returns the updated
session, and sends raw `application/octet-stream` bytes. The SDK never retries
an append after a timeout or connection loss: the server may have accepted the
chunk even when its acknowledgement was lost. Query the existing scoped
upload-status HTTP route before deciding how to proceed. Completion
returns `CanonicalMediaArtifactObservation` and sends no request body. Prefer
passing the complete session to `completeUploadSession(session)`; it verifies
the returned artifact's tenant, principal, size, SHA-256, filename, content
type, classification, and metadata against the session. The legacy
`completeUploadSession(uploadId)` overload remains source-compatible but cannot
bind the returned artifact to an expected upload payload because the wire
artifact contains no source upload ID.

## Host-configured CLI inventory

The installed `ghatanamedia-api` executable currently has five host-configured
consumer identities recorded in
`.product-experience/pdp-3-product-experience/cli/production-command-registry.yaml`:

| CLI operation | SDK operation | Source disposition | Runtime boundary |
| --- | --- | --- | --- |
| `artifact inspect` | `MediaOperationClient.getArtifact()` | Source-bound scoped read | Host identity and production qualification remain open |
| `job get` | `MediaCanonicalClient.getJob()` | Source-bound scoped read | Host identity and production qualification remain open |
| `job submit` | `MediaCanonicalClient.submitJob()` | A 202 response is only a submission receipt | Runtime/provider execution is not admitted |
| `job list` | `MediaCanonicalClient.listJobs()` | Projects the bounded v1 snapshot to the exact PDP-1 result after scope validation | Canonical route and production host remain not admitted/unqualified |
| `job cancel` | `MediaCanonicalClient.cancelJob()` | Durable cancellation request, not proof of stop | Runtime/provider stop is not admitted |

This is an implementation/source observation, not admission of a user-facing
product CLI or a qualified production host. The source manifest marks the
registry `OBSERVATION_ONLY_SOURCE`, `RUNTIME_NOT_ADMITTED`, and
`INDEPENDENT_ACCEPTANCE_PENDING`; the physical CLI surface remains
`PROPOSED`/`LOCAL_ONLY`. No production host is qualified.

The endpoint and tenant/principal scope are explicit. The bearer token is read
only from `GHATANA_MEDIA_BEARER_TOKEN` and is never accepted in command
arguments. Requests use the SDK's bounded timeout, configurable with
`GHATANA_MEDIA_REQUEST_TIMEOUT_MS` (integer milliseconds, 1–300000; default
30000). `artifact inspect` performs the source-bound, scoped artifact GET and
returns the observed artifact metadata. A read timeout or unavailable
observation does not establish absence or failure.

All programmatic SDK clients apply the same endpoint transport boundary:
absolute HTTPS URLs are required except for `localhost`, `127.0.0.1`, and
`[::1]` development endpoints. URL user information, query/fragment parts, and
literal or percent-encoded dot segments are rejected before a credential is
attached.

The installed executable has no artifact upload or upload-session commands,
and no batch, capture, recorder, or stream command. Although the installed
binary contains the observed job command identities above, those identities do
not establish product admission. In particular, `job submit` and `job cancel`
remain `NOT_ADMITTED`. PDP-1 defines the scoped `job list` operation and its
closed bounded result. `readVersion` is an opaque store-issued token for the
same coherent tenant/principal query snapshot as `jobs` and `observedAt`; it is
not a cursor, timestamp, response digest, or max row version. The SDK now
projects the v1 response into that result, but the production CLI still returns
`NOT_ADMITTED` before parsing, credentials, or network dispatch because the
canonical route and production host remain unqualified. The 11 Explorer fixture
commands remain a separate synthetic population. Local client and handler tests
do not qualify a production host or release.

```sh
GHATANA_MEDIA_BEARER_TOKEN="$MEDIA_TOKEN" ghatanamedia-api artifact inspect \
  --endpoint https://media.example.test \
  --tenant tenant-1 \
  --principal principal-1 \
  --artifact artifact-1
```

Successful observations use a `media.cli-result.v1` JSON envelope on stdout.
Errors use a typed `media.cli-error.v1` envelope on stderr and a nonzero exit
code; auth/transport details are sanitized. A 404 means the artifact was not
visible in the supplied tenant and principal scope; it does not establish
global absence. Artifact output is a point-in-time metadata observation and
does not establish rights, content retrieval, publication, or downstream
availability.
Remote endpoints require HTTPS; plain HTTP is accepted only for loopback
testing. Redirects are rejected so bearer credentials are not forwarded to
another endpoint.

This production CLI is separate from the 11 deterministic fixture commands in
the Explorer simulator. The fixture executable does not call this SDK; fixture
responses never stand in for provider or host behavior. Local consumer tests do
not qualify a production host or release.

## Local-development CLI definitions

The package also exposes `ghatanamedia-api-dev` as a separate, loopback-only
development executable. Its source registry defines `artifact upload`,
`artifact inspect`, `job get`, `job submit`, and `job cancel`, all bound to
local-development operations. J-24 `batch run` composes the existing `job submit`
command under the separate bounded plan contract below. The commands require an explicitly supplied `localhost`,
`127.0.0.1`, or `[::1]` endpoint and a short-lived `DEV_ONLY` token minted for
the exact `dev` profile, tenant, principal, and command permissions. The CLI
checks the token claim profile before their dispatch; the Media host verifies
the token signature and current authority. A token-shaped claim alone is not
authentication.

```sh
GHATANA_MEDIA_BEARER_TOKEN="$MEDIA_DEV_TOKEN" ghatanamedia-api-dev artifact inspect \
  --endpoint http://127.0.0.1:8080 \
  --tenant tenant-1 \
  --principal principal-1 \
  --artifact artifact-1
```

`artifact upload` validates `--content-type` against the PDP-1 media-type
grammar (3–127 characters) before credentials, source-file access, or host
requests. It then reads a bounded regular file, uses the existing upload
session routes, checks persisted session progress before completion, and
reports ambiguous mutations without blind retry. Before any upload mutation,
the DEV_ONLY CLI reads the authenticated host's `maxChunkBytes` policy and uses
that bound for file hashing and chunk uploads. If the policy cannot be read or
validated, no upload is attempted. This local transfer policy does not admit
production upload commands. Reusing the same upload idempotency key after a CLI
restart resumes only an existing OPEN session: the CLI checks the acknowledged
byte/chunk position, rehashes the local prefix, appends from that exact
position, and checks the full-file digest before completion. An inconsistent
or ambiguous session remains unresolved; the CLI does not start a replacement
upload or replay an uncertain chunk. `job get` returns a scoped, point-in-time
observation and may include `--request-id`; an unknown job state does not
establish provider finality. `job cancel` calls the signed DEV_ONLY
`POST /dev/v1/jobs/{jobId}/cancel` route with a required stable `--request-id`
and optional `--expected-version`. The host durably reserves the request before
provider cancellation, admits only exact `dev` profile jobs with an in-process
LOCAL provider, and replays the same request without a second dispatch.
Responses distinguish confirmation, unconfirmed request, unknown outcome,
unsupported cancellation, terminal state, and terminal race. A cancellation
request never implies provider finality; reuse the same request ID to reconcile
an ambiguous result. Production admission remains `OPEN`: the production CLI
has source-bound artifact inspection and scoped job reads; job submit/cancel
remain `NOT_ADMITTED` before authentication or network dispatch.

### DEV_ONLY structured batch (`batch run --confirm-sha256`)

`ghatanamedia-api-dev batch run --endpoint LOOPBACK_URL --tenant ID --principal ID --file PATH --confirm-sha256 sha256:HEX`
accepts one strict `media.dev.batch.v1` JSON plan with exactly `schemaVersion`
and `items`. It contains 1–16 independent items, each with exactly `id`,
`command`, and `options`; the command is only `job submit`, and its options are
exactly `artifact`, `request-id`, `job-type`, and `await-finality-ms`. It does
not accept provider hints, caller authority, cross-item references, or
continuation flags. The confirmation must equal the SHA-256 of the exact file
bytes read by the CLI; it confirms that plan only and cannot grant authority.

The CLI validates the full bounded plan and every existing job-submit argument
before any item dispatch. It then submits sequentially and stops at the first
item not observed as terminal `COMPLETED`; later items are `NOT_RUN`. Each item
is independently checked by the local DEV_ONLY host for current identity,
permission, policy and artifact access. The versioned
`media.cli-batch-result.v1` response uses item statuses `SUCCESS`, `ERROR`,
`OUTCOME_UNKNOWN`, and `NOT_RUN`. `SUCCESS` requires exact tenant, principal,
artifact, job type, request ID and terminal `COMPLETED` readback. Typed command
errors without an exact terminal job record have null job finality; exact
terminal `FAILED`/`CANCELLED` readbacks remain typed errors. `ACCEPTED`,
`RUNNING`, timeout, interruption, malformed or mismatched responses remain
`OUTCOME_UNKNOWN` with the original request ID for same-payload reconciliation.
SIGINT stops local observation only and never cancels the submitted job.

Exit codes are 0 when every item is `SUCCESS`, 7 for terminal job failure, 8
for terminal cancellation, 10 for unknown outcome, and 130 when observation is
interrupted; other definitive command failures preserve the existing command
exit code. This local DEV_ONLY composition does not verify output contents,
provider finality, rights approval, delivery, production admission, or complete
J-24 acceptance. The full J-24 verified-output journey remains OPEN.

## DEV_ONLY project and timeline client

The separate `@audio-video/client/dev-project-timeline` subpath is an explicit
loopback consumer for the launcher’s noncanonical `/dev/v1` project routes:

```ts
import { MediaDevProjectTimelineClient } from '@audio-video/client/dev-project-timeline';

const projects = new MediaDevProjectTimelineClient({
  baseUrl: 'http://127.0.0.1:8093',
  bearerToken: () => devTokenHeldInHostMemory,
});
const context = await projects.getContext();
const created = await projects.createProject({
  selectedAuthorizedWorkspaceId: context.selectedAuthorizedWorkspaceId,
  title: 'Local edit',
  requestId: 'create-local-1',
});
const revision = await projects.createTimeline(created.project.projectId, {
  expectedHeadRevisionId: created.initialRevision.revisionId,
  timelineId: 'main',
});
```

The returned workspace is a synthetic local owner scope, not Shared membership.
Only the server-signed DEV_ONLY identity supplies tenant/principal authority.
Network loss during a mutation produces `OUTCOME_UNKNOWN`; read the project or
exact revision before any new command. The client sends no cookies, rejects
redirects, and never retries.

## Current HTTP bindings

The SDK's transport methods are limited to these OpenAPI operations. Route
observations without a corresponding SDK method remain unadvertised here.

| SDK method | OpenAPI operation | Route |
| --- | --- | --- |
| `createUploadSession` | `beginMediaUpload` | `POST /api/v1/artifacts/uploads` |
| `getUploadSession` | `getMediaUpload` | `GET /api/v1/artifacts/uploads/{uploadId}` |
| `uploadPart` | `appendMediaChunk` | `PUT /api/v1/artifacts/uploads/{uploadId}/chunks/{chunkIndex}` |
| `completeUploadSession` | `completeMediaUpload` | `POST /api/v1/artifacts/uploads/{uploadId}/complete` |
| `getArtifact` | `getMediaArtifact` | `GET /api/v1/artifacts/{artifactId}` |
| `submitJob` | `submitMediaJob` | `POST /api/v1/jobs` |
| `listJobs` | `listMediaJobs` | `GET /api/v1/jobs?limit={limit}` |
| `getJob` | `getMediaJob` | `GET /api/v1/jobs/{jobId}` |
| `getJobByRequest` | `getMediaJob` | `GET /api/v1/jobs/{jobId}?requestId={requestId}` |
| `cancelJob` | `cancelMediaJob` | `POST /api/v1/jobs/{jobId}/cancel` |
| `openStream` | `openMediaStream` | `POST /api/v1/streams` |
| `getStream` | `getMediaStream` | `GET /api/v1/streams/{sessionId}` |
| `connectStream` | `connectMediaStream` | `POST /api/v1/streams/{sessionId}/connect` |
| `submitStreamFrame` | `submitMediaStreamFrame` | `POST /api/v1/streams/{sessionId}/frames/{sequence}` |
| `closeStream` | `closeMediaStream` | `POST /api/v1/streams/{sessionId}/close` |

The compatibility modality methods, provider-capability lookup, legacy
operation retry, cursor listing, stream watch, outcome lookup, and exact
artifact-version inspection have no admitted method-to-route binding. They
remain `NOT_ADMITTED`; they do not dispatch to similarly named legacy paths.
The route-parity test checks the exported method inventory against the current
OpenAPI and route manifest.

## Canonical upload-session read

`MediaOperationClient.getUploadSession(uploadId)` reads the existing
`getMediaUpload` query at `GET /api/v1/artifacts/uploads/{uploadId}` and returns
the exact `CanonicalMediaUploadSessionObservation` runtime DTO. It requires the
configured tenant and `defaultHeaders: { 'X-Principal-Id': callerPrincipalId }`;
the SDK rejects a response whose tenant, principal, or upload ID differs from
that request. Its `retention` is the persisted requested-retention duration in
ISO-8601 form; `expiresAt` remains the separate transfer-session expiry. The
method accepts only a safe single path-segment upload ID.

```ts
const observation = await client.getUploadSession(uploadId);
```

The response is a point-in-time stored observation. It does not establish
currentness, completion finality, rights, artifact availability, or permission
to replay a mutation. A 404 preserves `UPLOAD_NOT_FOUND` and its correlation
identity and means only that the upload was not visible in the supplied tenant
and principal scope.

## Production plan fingerprints

The effect-free client planner binds each resolver result to the requested
reference and a bounded immutable revision. Unknown eligibility is rejected.
Its fingerprint includes tenant and project identity. Previously generated
client plan fingerprints omitted these identities and will change: recompile
and reconcile an existing plan before using it in a downstream workflow; do
not treat an old fingerprint as evidence for a newly compiled plan. The Java
runtime compiler uses its own plan representation and fingerprints; these
values are not an interchangeability claim between the two compilers.

## Headless recorder and capture SPI

The existing headless modules are available through explicit subpaths:

```ts
import { captureWithAdmission, noAdmittedCaptureAdapter } from '@audio-video/client/capture-adapters';
import { orchestrateScenario, recaptureScenario } from '@audio-video/client/recorder-orchestrator';
import { compileProductionPlan } from '@audio-video/client/production-plan';
```

`orchestrateScenario()` and `compileProductionPlan()` produce deterministic,
effect-free plans. They do not capture media, invoke a browser/device, or
establish product completion. `recaptureScenario()` only calls an adapter
after the supplied trusted eligibility seam returns `ADMITTED`; the default
`noAdmittedCaptureAdapter` denies capture. Exporting the SPI does not admit a
source, adapter, provider, or host.

Capture requests bind source identity, purpose, immutable source version,
controlled-secret reference, and frame clock. The adapter must return actual
bounded bytes matching the requested source and clock. The client does not
manufacture frames or treat fixture output as real capture. An adapter
rejection or invalid returned frame after dispatch raises
`CaptureOutcomeUnknownError` with only a safe source-kind enum and fixed
reason. The error contains no request references or provider detail; callers
must reconcile the attempt before deciding whether to recapture, and the
client performs no automatic retry.

Concrete providers ship as explicit subpaths:
`@audio-video/client/http-capture-adapter` (`HttpApiCaptureAdapter`, real
bounded HTTPS/loopback GET with redirect and origin policy) and
`@audio-video/client/file-capture-adapter` (`MediaFileCaptureAdapter`,
Node.js bounded file reads with optional `allowedRoot` containment).
`routedCaptureAdapter` dispatches an admitted request to the adapter wired
for its source kind; kinds without a wired provider reject before dispatch.
Browser, desktop, mobile, terminal, gRPC and camera sources still require a
host-qualified adapter — exporting these providers does not admit a source,
provider, or host.
