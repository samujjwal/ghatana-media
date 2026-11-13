# Surface: `launcher`

Canonical Media runtime composition and distribution (`launcher`,
Java/Gradle). `MediaRuntime` is the single composed runtime: versioned
upload, identity, rights, provider-attempt fencing, reconcile-after-crash
and stable terminal reads — **no second writer**.

## Responsibility

- `MediaRuntime.compose(environment)` builds the runtime from `MEDIA_*`
  settings; `MediaRuntime` implements `MediaProcessingRuntimePort` and
  owns upload sessions (`beginUpload`/`appendChunk`/`completeUpload`),
  artifact reads, `processingReady`, `resolveSourceAuthorization` and
  `copyArtifactContent`.
- `MediaHttpHandler` + `MediaRouteManifest` + `MediaSecurityFilter` +
  `MediaErrorCode` serve the admitted HTTP surface with the canonical
  route manifest and typed error taxonomy. The controller takes tenant and
  subject only from the server-side authenticated principal: verified Shared
  JWT claims or the configured bootstrap service identity. Caller-supplied
  `X-Principal-Id` is discarded; a local development identity is synthetic
  and cannot select a user principal.
- An explicit local issuer path is available only when
  `MEDIA_DEV_IDENTITY_ENABLED=true` and the profile is exactly `dev`. The
  operator supplies `MEDIA_DEV_JWT_HMAC_SECRET` (at least 32 UTF-8 bytes) to
  both the process and `node scripts/media-dev-identity-token.mjs --tenant
  <tenant> --subject <subject> --permission media:job:read`; repeat
  `--permission` only for needed entries in the canonical route manifest or
  the explicit DEV_ONLY route permission set. The script
  prints an HS256 token valid for 120 seconds by default using issuer
  `urn:ghatana:media:dev-only`, audience `ghatana-media-dev`, and an explicit
  `dev_only: true` claim. This has no mint endpoint or membership claims, and
  is not a Shared identity continuation. In this
  mode only the signed token establishes tenant and subject; API keys and
  caller identity headers are rejected or overwritten. Production-like
  profiles reject verifiable DEV_ONLY tokens, and enabling this mode outside
  exact `dev` fails startup. With the flag unset, legacy `local`/`test`
  fixture behavior is unchanged.
- A separate `/dev/v1` project/timeline preview is available only when both
  `MEDIA_DEV_IDENTITY_ENABLED=true` and
  `MEDIA_PROJECT_TIMELINE_DEV_ENABLED=true` under exact profile `dev`. Its
  signed-token permissions are `media:project:dev:{create,read,write}`. The
  project store uses loopback PostgreSQL and an explicitly named isolated
  `media_dev_*` schema with its own additive migration location. Routes remain
  absent from the canonical route manifest/OpenAPI, and production-like
  profiles cannot authenticate a DEV_ONLY token. The returned workspace is a
  synthetic local owner scope, not Shared membership. The local timeline editor
  can inspect the exact owner artifact using the existing
  `GET /api/v1/artifacts/{id}` route with `media:artifact:read`, then attach or
  remove its exact version using isolated project-head CAS. Source and story
  coordinates are decimal-string rationals. This local operation does not
  establish current rights/revocation, decoder-clock verification, overlap
  semantics, rendering, Shared membership, or production authority; canonical
  production routes and CLI admission are unchanged.
- **Project → source → render → artifact → reopen (DEV_ONLY).**
  `POST /dev/v1/projects/{projectId}/renders` takes
  `{requestId, revisionId, timelineId, width, height, framesPerSecond}` and
  requires `media:project:dev:write` plus `media:artifact:{read,create}`.
  `MediaDevProjectRenderRuntime` reads that exact immutable revision (owner
  scope), resolves every clip's source at its exact artifact version (missing,
  foreign or changed version → `404 SOURCE_VERSION_NOT_FOUND`), decodes PNG/GIF/
  JPEG stills under a header-checked 2048px/4 MP ceiling, renders a
  storyboard GIF with the existing `production/animation` `AnimationRenderer`
  (exact rational story-time → frame mapping, ≤240 frames, FPS must divide 100
  so the GIF clock is exact), and registers the bytes through the canonical
  idempotent upload path with lineage metadata (project, revision, timeline
  semantic version, per-clip source versions and frame windows). The render is
  deterministic, so a duplicate `requestId` replays the same artifact (`200`,
  `replayed:true`); reusing it for a different payload is `409`. A crash
  between durable chunk append and completion leaves an open upload that the
  same `requestId` resumes (verified chunk replay) instead of duplicating.
  Registration failure is `502 RENDER_REGISTRATION_FAILED` with no output.
  Audio/caption tracks, non-image sources, empty timelines and ceiling
  overruns are typed `422` (`TRACK_KIND_NOT_SUPPORTED`,
  `SOURCE_FORMAT_NOT_SUPPORTED`, `RENDER_EMPTY_TIMELINE`,
  `RENDER_LIMIT_EXCEEDED`). `GET /dev/v1/projects/{projectId}/renders/{renderId}`
  reopens the registered artifact and its lineage after a restart. An optional
  `"format":"mp4"` routes the same exact revision through the rendering
  module's `FfmpegMultitrackRenderer`: each VIDEO still clip becomes one frame
  held for its exact story duration (normalized to the requested even size),
  one optional 16-bit PCM WAV clip on an AUDIO track starting at story time 0
  becomes AAC, and ffprobe verification (codecs, frame count, exact PTS,
  duration) must pass before the `video/mp4` artifact is registered with
  encoding lineage and tool versions. Tools come only from absolute
  `MEDIA_DEV_RENDER_FFMPEG`/`MEDIA_DEV_RENDER_FFPROBE`; absent or unrunnable
  tools are `503 RENDER_CODEC_UNAVAILABLE`, unsupported timelines are typed
  `422 RENDER_UNSUPPORTED_*`, and a failed codec run is
  `502 RENDER_EXECUTION_FAILED`. Artifacts
  that are not this project's render are `404`. Not covered: time-based video
  sources, multi-clip audio mixing, timeline captions (the renderer supports
  them but the project timeline has no caption-text source yet),
  current-rights revocation, scanner release,
  or any production admission — these routes stay outside the canonical
  manifest/OpenAPI.
- DEV_ONLY hosted versioned review (`MEDIA_DEV_REVIEW_ENABLED=true`, requires
  the project timeline lane; reuses the existing `VersionedReviewEngine` over
  the durable `PostgresqlReviewStore` in the isolated `media_dev_` schema via
  new migration `media-project-timeline-dev/V002`). `POST /dev/v1/reviews`
  opens (idempotently, `201` then `200`) a case on one exact immutable subject
  `{kind:"PROJECT_REVISION",projectId,revisionId}` or
  `{kind:"ARTIFACT_VERSION",artifactId,artifactVersionId}` (e.g. a render
  artifact; needs `media:artifact:read`). `GET /dev/v1/reviews/{caseId}` reads
  records and `currentness`; `POST .../comments` (text, disposition, optional
  time range/ROI) and `POST .../decisions` (ACCEPT/REJECT/REQUEST_CHANGES/DEFER,
  `confirmed:true`) append under `expectedCaseRevision` CAS and a per-owner
  `requestId` (replay `200`, divergent reuse `409 REVIEW_REQUEST_ID_REUSED`,
  CAS miss `409 REVIEW_CASE_REVISION_CONFLICT`). Currentness is re-derived from
  the live project head / artifact version on every call, so any later change
  makes earlier decisions `STALE` and new decisions `409 REVIEW_SUBJECT_STALE`.
  Text is redacted (control characters, e-mail addresses) before storage and
  disclosure. Honesty: the authority is the DEV_ONLY synthetic owner, not an
  issued human reviewer; every response carries `establishesApproval:false`,
  `humanReviewApproval:false` and scope `DEV_ONLY`, and a recorded ACCEPT
  authorizes no delivery or publication. Not covered: reviewer roles,
  multi-reviewer authority, retention expiry, atomic project/review CAS and
  hosted review UI. Routes stay outside the canonical manifest/OpenAPI.
- The DEV_ONLY artifact intake host reads `GET /dev/v1/artifact-upload-policy`
  using a signed DEV_ONLY identity with `media:artifact:create`. The exact
  response is `{schemaVersion:"media.dev.artifact-upload-policy.v1",
  scope:"DEV_ONLY",maxChunkBytes:<runtime.config().maximumChunkBytes>}`.
  This route remains available when project/timeline storage is disabled; it
  advertises the runtime's bounded request size and does not create an artifact
  operation. It remains outside the canonical route manifest/OpenAPI and is
  not production admission.
- Local development cancellation is a signed `POST /dev/v1/jobs/{jobId}/cancel`
  operation requiring `media:job:cancel` and exact profile `dev`. The route is
  owner-scoped, admits only providers declared LOCAL, and persists its stable
  request ID and dispatch phase on the job before cancellation can be invoked.
  If a running LOCAL provider has no dedicated cancel operation, the launcher
  persists `REQUESTED_UNCONFIRMED` before signalling that job's cooperative
  cancellation token; it does not cancel the future or claim provider finality.
  Replaying the same ID reads that durable operation without redispatch;
  response loss or a persisted dispatch-in-progress remains `OUTCOME_UNKNOWN`.
  `REQUESTED_UNCONFIRMED` does not establish job finality, which must be read
  from the owner-scoped job route. This DEV_ONLY route stays outside the
  canonical production route manifest and does not change production
  cancellation admission.
- Accepted job submissions and stream-frame acknowledgements expose canonical
  `Location` status links plus `Retry-After: 1`; the retry hint means poll the
  exact job/session read route and is not a completion claim. Job reads can
  include `requestId` to require exact submission identity during reconciliation.
- Supporting runtimes compose consent administration, caption
  registration/parent-clock, lifecycle publication, privacy maintenance,
  semantic redaction, production-run coordination and canonical stream
  frame port — each behind its own admission checks.
- If a stream provider call or ACK persistence has an uncertain result,
  `MediaRuntime` marks session finality `UNKNOWN`; the HTTP route returns a
  sanitized 503 `UNKNOWN_OUTCOME` with `retryable:false` so clients inspect the
  session before another action. This does not add exact-frame replay receipts
  or change the operation's external admission gate.
- Caption-version history and exact-version reads recheck current source
  rights before returning content. A revoked or out-of-scope record is a typed
  `POLICY_DENIED`; ambiguous or unavailable rights are `PROVIDER_UNAVAILABLE`.
  This protects stored-caption disclosure and does not admit STT inference or
  qualify a model, source, or production host.
- `MediaLauncher` is the process entrypoint; `MediaRuntimeConfig` and
  `LocalMediaRuntimeSupport` hold configuration/support wiring;
  `ComposedMediaRuntimePortFactory` is the ServiceLoader registration
  shared with the standalone `vision-service` entrypoint;
  `MediaSubmissionDigest` supplies submission identity.

## Public operations

| Entry point | Contents |
| --- | --- |
| `MediaLauncher.main` | Process start (`bin/launcher` in the install dist) |
| `MediaRuntime.compose` / upload & artifact methods | Canonical runtime port |
| `MediaHttpHandler` | HTTP request handling over `MediaRouteManifest` |
| `MediaDevProjectTimelineRuntime` | Optional isolated owner-only DEV_ONLY project and timeline preview |
| `MediaDevProjectRenderRuntime` | DEV_ONLY revision-exact storyboard render registered as an immutable artifact with lineage |
| `vision-service` (`bin/vision-service`) | Standalone Vision gRPC server on the same packaged classpath |

## States and invariants

- One active writer: the runtime owns job/attempt state; legacy binaries
  may remain the sole active writer until verified M08 cutover — never
  run a second writer against the same state.
- Fail-closed admission: missing factory/runtime/rights or DI admission
  denies rather than degrades. The current scene-text source does not
  admit DI pixel dispatch (no external-processing consent revalidation
  or trusted boundary/region/retention binding); OCR requests stay
  denied. Frame source handles still images only — video-frame OCR is
  unqualified.
- External job submission requires an exact immutable source version and
  current source-owner/Shared-policy evidence bound to the authenticated
  principal, operation, purpose, provider version, region, and retention.
  Rights and consent are checked before job creation, again at the provider
  effect boundary, and before bounded source bytes are exposed. Missing,
  stale, mismatched, revoked, or biometric/retention-disallowed authorization
  produces a typed pre-dispatch denial with no job or provider effect.
- Production-plan fingerprints include tenant/project/origin identity
  with length-framed inputs; earlier fingerprints change — existing
  records must be reconciled against original inputs, never rewritten.
- The H-02 DAG places its manual rights-review gate before capture; the
  H-07 step coordinator does not yet enforce DAG dependencies — callers
  must not dispatch children of skipped/unresolved gates. A durable
  dependency-aware production executor is still required.

## Dependencies and configuration

- `MEDIA_*` environment configuration for the runtime; `VISION_CAPABILITY_PROFILE`
  + `DI_*` endpoint/provider/model settings for the DI consumer path.
  Distribution: `./gradlew :services:media:launcher:installDist`.
- Logging defaults to human-readable plain output. Set LOG_FORMAT=json to
  opt in to JSON, or set `-Dmedia.log.format=json`; the system property takes
  precedence over the environment variable. LOG_LEVEL defaults to INFO, and
  `-Dmedia.log.level` similarly takes precedence over LOG_LEVEL.

## Errors

`MediaErrorCode` typed taxonomy over HTTP; admission denials are explicit
(`NOT_ADMITTED`-class), never silent fallbacks.
Inbound JSON uses strict duplicate-member detection, so ambiguous fields such
as repeated tenant identity are rejected before upload persistence.
Dynamic HTTP path identifiers also reject malformed percent-encoded UTF-8
before resource lookup, so replacement decoding cannot alias a job identity.
Provider-profile poll failures use poll-start time when invalidating metrics;
an older slow failure preserves a newer published observation.

## Tests and commands

```bash
./gradlew :services:media:launcher:test
./gradlew :services:media:launcher:installDist
```

Executable completion targets (plan §07): J01/J02/J20/J03 integration,
process-kill before/after commit, stale tenant, idempotency,
cancel/late response, startup readiness, bounded threads and memory.
Project-to-media-output workflow (in-process + real launcher/PostgreSQL/S3 restart):

```bash
./gradlew :services:media:launcher:test \
  --tests 'com.ghatana.media.launcher.MediaDevProjectRenderHttpTest'
./gradlew :services:media:integration-tests:test \
  --tests 'com.ghatana.media.integration.MediaDevProjectTimelineRestartIT'
```

DEV_ONLY hosted versioned review (in-process + real launcher/PostgreSQL restart):

```bash
./gradlew :services:media:launcher:test \
  --tests 'com.ghatana.media.launcher.MediaDevReviewHttpTest'
./gradlew :services:media:integration-tests:test \
  --tests 'com.ghatana.media.integration.MediaDevReviewRestartIT'
```

Focused identity and rights coverage:

```bash
./gradlew :services:media:launcher:test \
  --tests 'com.ghatana.media.launcher.MediaSecurityFilterTest' \
  --tests 'com.ghatana.media.launcher.MediaRuntimeSpeechAdmissionTest' \
  --tests 'com.ghatana.media.launcher.MediaRuntimeJobGovernanceTest' \
  -Pghatana.media.compositeScope=FOCUSED -Pghatana.media.focusedModules=launcher
```
