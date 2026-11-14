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
  one 16-bit PCM WAV clip on an AUDIO track starting at story time 0 becomes
  AAC directly; any other audio layout (several clips on any AUDIO tracks,
  overlapping or not, or a single clip not at time 0) is placed sample-exactly
  and mixed by `PcmStemMixer` (unity gain, centre pan, its peak-ceiling guard)
  into one timeline-length 16-bit stereo WAV with silence where no clip plays,
  and that WAV becomes AAC. Mixed clips must be 16-bit stereo WAVs sharing one
  sample rate with whole-sample offsets (no resampling, channel conversion or
  rounding): otherwise typed `422 RENDER_UNSUPPORTED_AUDIO_LAYOUT` (not stereo,
  source too short, clip past the timeline) or `RENDER_UNSUPPORTED_AUDIO_FORMAT`
  (rate mismatch, fractional sample, not PCM16 WAV); lineage `audioMix` records
  each clip's exact artifact version, source digest, story offset, gain/pan,
  the mixed WAV digest and the mixer's applied master gain (rights decision is
  the DEV_ONLY owner-scope visibility one, `productionGrant:false`). The
  project timeline has no transition model, so none are applied. ffprobe verification (codecs, frame count, exact PTS,
  duration) must pass before the `video/mp4` artifact is registered with
  encoding lineage and tool versions. Tools come only from absolute
  `MEDIA_DEV_RENDER_FFMPEG`/`MEDIA_DEV_RENDER_FFPROBE`; absent or unrunnable
  tools are `503 RENDER_CODEC_UNAVAILABLE`, unsupported timelines are typed
  `422 RENDER_UNSUPPORTED_*`, and a failed codec run is
  `502 RENDER_EXECUTION_FAILED`. Artifacts
  that are not this project's render are `404`.
  **Caption clips (MP4 only).** Conservative assumption (owner-delegated design decision): "A project timeline
  CAPTION-track clip references the exact immutable version of an owner WebVTT artifact (content type text/vtt).
  The clip's sourceIn/sourceOut select cues on the WebVTT file's own clock; cues are clipped to that interval and
  shifted so sourceIn maps to the clip's storyStart (no retiming: sourceOut-sourceIn must equal storyDuration).
  Overlapping caption clips are refused. Caption text is rendered verbatim; no translation, no speaker inference."
  The cues become the renderer's embedded `mov_text` stream (verified by ffprobe, cue count included). Lineage
  `sources[]` for a caption clip adds `sourceSha256`, `sourceCueCount` (cues in the file) and `cueCount` (cues
  emitted after clipping). `MediaDevWebVtt` is a strict bounded parser: UTF-8 without NUL/control characters,
  `WEBVTT` signature (optional BOM), `[hh:]mm:ss.ttt --> [hh:]mm:ss.ttt` timings, `NOTE`/`STYLE`/`REGION`
  blocks ignored, caps of 1 MiB, 5000 cues, 4096 characters per cue and per line. Markup policy: cue text is
  plain text and any `<` (tags, voice spans, timestamps) is rejected, never stripped or interpreted; `&` is kept
  literally; cue settings (position/align) are rejected. Typed `422`s: `SOURCE_FORMAT_NOT_SUPPORTED` (not
  `text/vtt`), `CAPTION_WEBVTT_MALFORMED`, `CAPTION_MARKUP_NOT_SUPPORTED`, `CAPTION_CUE_SETTINGS_NOT_SUPPORTED`,
  `CAPTION_CUES_OVERLAP` (within the file), `CAPTION_RETIMING_NOT_SUPPORTED`, `CAPTION_CLIPS_OVERLAP`,
  `CAPTION_TIME_NOT_MS_EXACT` (a mapped time is not whole milliseconds), `RENDER_LIMIT_EXCEEDED`. A GIF render with
  a caption clip stays `422 TRACK_KIND_NOT_SUPPORTED`. Not covered: time-based video
  sources, per-clip gain/pan or transitions, caption styling/positioning/translation,
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
  disclosure. Honesty: every response carries `establishesApproval:false`,
  `humanReviewApproval:false` and scope `DEV_ONLY`, and a recorded ACCEPT
  authorizes no delivery or publication. Not covered: retention expiry, atomic
  project/review CAS and hosted review UI. Routes stay outside the canonical
  manifest/OpenAPI.
  **Reviewer assignment (owner-delegated design decision).** DEV_ONLY review authority is an explicit assignment: the project owner assigns a reviewer principal (different from the owner) to a review case with an explicit scope set (QUALITY, RIGHTS, PROVENANCE, APPROVAL) and an expiry. Only an assigned, unexpired reviewer may record decisions within its scopes; the owner may comment but not decide. Assignments and revocations are versioned, durable and part of the case's CAS. An ACCEPT by an assigned reviewer on a CURRENT subject is recorded as DEV_ASSIGNED_REVIEWER_ACCEPT and still reports establishesApproval=false / humanReviewApproval=false, because the DEV_ONLY signed identity is not a trusted human identity; production-like profiles remain fail-closed until a trusted Shared identity/membership contract exists. When the reviewer was verified by the configured OIDC identity provider the decision is instead recorded as an identity-backed `IDP_VERIFIED_REVIEWER_*` statement (see "Trusted identity via OIDC"); it still never establishes approval.
  `POST /dev/v1/reviews/{caseId}/assignments` (owner only; `requestId`,
  `expectedCaseRevision`, `reviewerPrincipalId`, `scopes[]`, `expiresAt` within
  30 days) creates assignment version 1 (`201`; replay `200`; divergent
  `requestId` reuse `409 REVIEW_REQUEST_ID_REUSED`; CAS miss `409
  REVIEW_CASE_REVISION_CONFLICT`; self-assignment `422
  REVIEW_SELF_ASSIGNMENT_REFUSED`; reviewer already active `409
  REVIEW_ASSIGNMENT_ALREADY_ACTIVE`). `POST .../assignments/{assignmentId}/revoke`
  (owner only, same CAS/idempotency) appends version 2 (`REVOKED`); there is no
  `DELETE`. Decisions now require a `scope` and are checked against the
  assignment: owner or unassigned/revoked reviewer `403 REVIEWER_NOT_ASSIGNED`,
  scope not in the assignment `403 REVIEW_SCOPE_NOT_ASSIGNED`, expired `403
  REVIEW_ASSIGNMENT_EXPIRED`, stale subject still `409 REVIEW_SUBJECT_STALE`. An
  assigned unexpired reviewer may also read and comment; a principal that was
  never assigned (or another tenant) gets `404`. The authority version of a
  reviewer record is `dev-only.assigned-reviewer.v1:{assignmentId}:v{n}[:SCOPE]`
  (an assignment change between request and write is `REVIEW_AUTHORITY_CHANGED`),
  and the case view reports `status` `DEV_ASSIGNED_REVIEWER_{DECISION}_{CURRENT|STALE}`,
  per-record `recordedAs`/`scope` and the `assignments` list. Assignment rows are
  immutable versions in `media_review_assignment_versions` (migration
  `media-project-timeline-dev/V003`, isolated dev location only).
- **Hosted export with destination acknowledgment (DEV_ONLY).**
  `POST /dev/v1/exports` takes `{requestId, artifactId, artifactVersionId, destinationId}` and
  requires `media:delivery:dev:export` plus `media:artifact:read`;
  `GET /dev/v1/exports/{requestId}` requires `media:delivery:dev:read`. Opt in with
  `MEDIA_DELIVERY_DEV_ENABLED=true` (profile `dev`, `MEDIA_DEV_IDENTITY_ENABLED=true`) and
  `MEDIA_DELIVERY_DEV_DESTINATION_DIR=<absolute existing directory>`; enabled without the directory every
  route is a typed `503 DELIVERY_DESTINATION_UNAVAILABLE`, a relative/`..`/missing directory fails startup.
  `MediaDevDeliveryRuntime` reuses `MediaDeliveryEngine` and the PostgreSQL `DeliveryOperationStore`
  (canonical ledger V031/V032, via the `MediaDevDeliveryStoreFactory` ServiceLoader SPI) and exports the
  owner's exact registered artifact version to the single destination `dev-local-directory`. The
  local-directory adapter writes write-once objects named only by a SHA-256 of tenant/principal/requestId
  (no caller path text, symlinks refused), then independently re-reads the stored bytes; the operation is
  `DESTINATION_CONFIRMED` only when the engine accepts that readback receipt (checksum = artifact digest).
  Responses: `201` first export confirmed, `200` replay of an existing operation, `202` not yet confirmed
  (`OUTCOME_UNKNOWN`/`SENT`, `destinationConfirmed:false`, no receipt). A retry of an unresolved request
  reconciles by readback and resumes from the verified offset without resending accepted bytes; a tampered
  or truncated destination object is never confirmed or overwritten. Duplicate = idempotent replay; the same
  `requestId` with another artifact version is `409 EXPORT_REQUEST_CONFLICT`; an unknown destination is
  `404 DESTINATION_NOT_FOUND`; a foreign principal's artifact or operation is `404`. The transfer
  authorization is a DEV_ONLY owner-read grant, not a signed production authority. Not covered: network or
  third-party destinations, external destination ACK, signed authorization, token revocation UI, rights
  revocation; routes stay outside the canonical manifest/OpenAPI.
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

- **Rights and consent authority (DEV_ONLY).** Owner decision (2026-11-14, quoted verbatim): "Uploader + reviewer
  (Recommended): The uploader states rights and consent for each source version. A second person must confirm
  before any voice or likeness use, or before any external delivery. Every statement records who gave it, when and
  for which exact file, and can be revoked." Opt in with `MEDIA_RIGHTS_DEV_ENABLED=true` (profile `dev`,
  `MEDIA_DEV_IDENTITY_ENABLED=true`, canonical PostgreSQL configured; migration `db/media-runtime/V036`).
  `POST /dev/v1/rights/attestations` records an attestation bound to tenant, artifact id, exact artifact version
  and the content digest read from the artifact record (the caller must own that version): `statementKind`
  (`MEDIA_RIGHTS` or `IDENTIFIABLE_PERSON_CONSENT`), `scopes` (`PROCESSING`, `VOICE_OR_LIKENESS_USE`,
  `EXTERNAL_DELIVERY`), free-text `basis`, optional `supportingDocumentArtifactRef` (`<artifactId>@<versionId>`,
  must be readable by the caller), optional `requestedConfirmerPrincipalId`, optional `expiresAt`. The attesting
  principal is always the authenticated caller; a body field naming a principal is rejected. A different principal
  confirms (`POST .../{attestationId}/confirm`); self-confirmation is `403 SELF_CONFIRMATION_REFUSED` and is also
  rejected by a database check constraint. `VOICE_OR_LIKENESS_USE` and `EXTERNAL_DELIVERY` are admitted only after
  confirmation; `VOICE_OR_LIKENESS_USE` needs an `IDENTIFIABLE_PERSON_CONSENT` statement and `EXTERNAL_DELIVERY` a
  `MEDIA_RIGHTS` one. The attester or the confirmer may revoke with a reason (`POST .../{attestationId}/revoke`).
  Records are append-only; a new artifact version never inherits earlier statements (`STALE`). Hosted export now
  requires a current confirmed `EXTERNAL_DELIVERY` attestation for the exact source version and re-resolves it for
  every operation: `403 EXPORT_RIGHTS_NOT_ADMITTED` (with `details.rights.verdict` and reasons) or, when no rights
  authority is configured, `503 EXPORT_RIGHTS_AUTHORITY_UNAVAILABLE`. These DEV_ONLY records are statements by
  authenticated DEV_ONLY principals, not a legal determination: `establishesApproval` is always `false`.

### DEV_ONLY route inventory

All `/dev/v1` routes require exact profile `dev`, `MEDIA_DEV_IDENTITY_ENABLED=true` and a signed DEV_ONLY
token; none appear in the canonical route manifest or OpenAPI. The filter enforces the listed permission;
handlers additionally require the artifact permissions noted, so access is never looser than the table.

| Method | Path | Filter permission | Extra handler permission | Lane flag |
| --- | --- | --- | --- | --- |
| GET | `/dev/v1/artifact-upload-policy` | `media:artifact:create` | — | always (dev) |
| POST | `/dev/v1/jobs/{jobId}/cancel` | `media:job:cancel` | — | always (dev) |
| GET | `/dev/v1/artifacts/{artifactId}/content` | `media:project:dev:read` | `media:artifact:read` | always (dev); read ceiling `MEDIA_DEV_ARTIFACT_CONTENT_MAX_BYTES` (default 8388608, max 268435456) |
| GET | `/dev/v1/context` | `media:project:dev:read` | — | `MEDIA_PROJECT_TIMELINE_DEV_ENABLED` |
| POST | `/dev/v1/projects` | `media:project:dev:create` | — | timeline |
| GET | `/dev/v1/projects/{projectId}` | `media:project:dev:read` | — | timeline |
| POST | `/dev/v1/projects/{projectId}/timelines` | `media:project:dev:write` | — | timeline |
| POST | `/dev/v1/projects/{projectId}/timelines/{timelineId}/edits` | `media:project:dev:write` | `media:artifact:read` for `putClip` | timeline |
| POST | `/dev/v1/projects/{projectId}/restore` | `media:project:dev:write` | — | timeline |
| GET | `/dev/v1/projects/{projectId}/revisions/{revisionId}` | `media:project:dev:read` | — | timeline |
| POST | `/dev/v1/projects/{projectId}/renders` | `media:project:dev:write` | `media:artifact:{read,create}` | timeline (+ `MEDIA_DEV_RENDER_FFMPEG/FFPROBE` for mp4) |
| GET | `/dev/v1/projects/{projectId}/renders/{renderId}` | `media:project:dev:read` | — | timeline |
| POST | `/dev/v1/reviews` | `media:project:dev:write` | `media:artifact:read` for `ARTIFACT_VERSION` | `MEDIA_DEV_REVIEW_ENABLED` |
| GET | `/dev/v1/reviews/{caseId}` | `media:project:dev:read` | — | review |
| POST | `/dev/v1/reviews/{caseId}/comments` | `media:project:dev:write` | — | review |
| POST | `/dev/v1/reviews/{caseId}/decisions` | `media:project:dev:write` | — | review (assigned reviewer, `scope` required) |
| POST | `/dev/v1/reviews/{caseId}/assignments` | `media:project:dev:write` | — | review (owner only) |
| POST | `/dev/v1/reviews/{caseId}/assignments/{assignmentId}/revoke` | `media:project:dev:write` | — | review (owner only) |
| POST | `/dev/v1/creative-outputs/audio-repairs` | `media:project:dev:write` | `media:artifact:{read,create}` | timeline |
| POST | `/dev/v1/creative-outputs/simulations` | `media:project:dev:write` | `media:artifact:create` | timeline |
| POST | `/dev/v1/creative-outputs/spatial-glb` | `media:project:dev:write` | `media:artifact:{read,create}` | timeline |
| GET | `/dev/v1/creative-outputs/{outputId}` | `media:project:dev:read` | `media:artifact:read` | timeline |
| POST | `/dev/v1/rights/attestations` | `media:project:dev:write` | `media:artifact:read` (caller owns the exact version) | `MEDIA_RIGHTS_DEV_ENABLED` |
| GET | `/dev/v1/rights/attestations/{attestationId}` | `media:project:dev:read` | attester, confirmer or requested confirmer (any tenant principal when none requested) | rights |
| POST | `/dev/v1/rights/attestations/{attestationId}/confirm` | `media:project:dev:write` | a principal other than the attester | rights |
| POST | `/dev/v1/rights/attestations/{attestationId}/revoke` | `media:project:dev:write` | attester or confirmer | rights |
| GET | `/dev/v1/rights/artifacts/{artifactId}/versions/{versionId}/attestations` | `media:project:dev:read` | caller owns the exact version | rights |
| POST | `/dev/v1/exports` | `media:delivery:dev:export` | `media:artifact:read` | `MEDIA_DELIVERY_DEV_ENABLED` + `MEDIA_DELIVERY_DEV_DESTINATION_DIR` |
| GET | `/dev/v1/exports/{requestId}` | `media:delivery:dev:read` | — | delivery |

DEV_ONLY exact-byte artifact read (`GET /dev/v1/artifacts/{artifactId}/content`, in-process HTTP plus a real-process
PostgreSQL/S3 restart IT with Range; outside the canonical manifest/OpenAPI): the caller names the exact immutable
version with `?version=sha256:<hex>` and/or `If-Match` (quoted or bare strong ETag; if both are present they must
agree); a missing version is `400 ARTIFACT_VERSION_REQUIRED`, a malformed one `400 ARTIFACT_VERSION_INVALID`, a
mismatch `412 ARTIFACT_VERSION_MISMATCH`, and an unknown or non-owner artifact `404 ARTIFACT_NOT_FOUND` without
disclosure. A single `Range: bytes=a-b | a- | -n` returns `206` with `Content-Range`; multi-range, malformed or
unsatisfiable ranges are `416` with `Content-Range: bytes */<total>`. Full reads and each range are bounded by
`MEDIA_DEV_ARTIFACT_CONTENT_MAX_BYTES`; larger requests are `413 ARTIFACT_CONTENT_TOO_LARGE` and clients must use
ranges. The whole object is verified (owner, version, size, SHA-256) before any byte is released
(`MediaRuntime.copyArtifactContentRange` / `copyArtifactContent`); a verification failure is a typed
`409/500 ARTIFACT_CONTENT_INTEGRITY_FAILED` with no content. Responses carry the artifact's exact `Content-Type`,
`Content-Length`, `ETag: "<version>"`, `Accept-Ranges: bytes`, `Cache-Control: private, no-store`,
`X-Content-Type-Options: nosniff` and a sandboxing `Content-Security-Policy`; `Content-Disposition` is `inline` only
for `image/png|gif|jpeg`, `video/mp4` and `audio/wav` and `attachment` for every other type (conservative: SVG, HTML,
PDF, JSON and GLB are never rendered inline). Only GET is supported (no HEAD).

## Public operations

| Entry point | Contents |
| --- | --- |
| `MediaLauncher.main` | Process start (`bin/launcher` in the install dist) |
| `MediaRuntime.compose` / upload & artifact methods | Canonical runtime port |
| `MediaHttpHandler` | HTTP request handling over `MediaRouteManifest` |
| `MediaDevProjectTimelineRuntime` | Optional isolated owner-only DEV_ONLY project and timeline preview |
| `MediaDevDeliveryRuntime` / `MediaDevDeliveryRoutes` | DEV_ONLY hosted export to a read-back local directory destination over `MediaDeliveryEngine` |
| `MediaDevProjectRenderRuntime` | DEV_ONLY revision-exact storyboard render registered as an immutable artifact with lineage |
| `MediaDevWebVtt` | Strict bounded WebVTT cue parser for MP4 caption clips (plain text only) |
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

## Trusted identity via OIDC (self-hosted Keycloak, any standard provider)

Owner decision, recorded verbatim (user, 2026-11-14): "Self-hosted Keycloak (Recommended): An open-source
(Apache-2.0) login server running in Docker. I wire Media to verify its tokens over the standard OIDC protocol and
test the whole flow locally. Swapping in another OIDC provider later only changes configuration."

The launcher verifies OIDC **access tokens** (JWT, `Authorization: Bearer`). It does not run a login UI and has no
Keycloak-specific code; Keycloak is the provider used for local development and tests (`deploy/keycloak/README.md`).

**Configuration (environment).** The verifier is enabled by `MEDIA_OIDC_ISSUER`; a half-configured issuer is a
startup failure, never silently disabled verification.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MEDIA_OIDC_ISSUER` | unset (OIDC off) | Exact `iss` value. https required (http only for loopback hosts). |
| `MEDIA_OIDC_AUDIENCE` | required with issuer | Value that must appear in `aud`. |
| `MEDIA_OIDC_JWKS_URI` | discovery | Optional override; otherwise `<issuer>/.well-known/openid-configuration` supplies `jwks_uri` (its `issuer` must equal the configured one). |
| `MEDIA_OIDC_TENANT_CLAIM` | `tenant_id` | Claim (dotted path) carrying the Media tenant. Missing tenant = refused. |
| `MEDIA_OIDC_PERMISSION_CLAIMS` | `realm_access.roles,resource_access.<audience>.roles` | Comma-separated claim paths whose values (string arrays or space/comma-separated strings) are the granted Media permissions, e.g. `media:job:read`. |
| `MEDIA_OIDC_CLOCK_SKEW_SECONDS` | `30` (max 120) | Skew for `exp`/`nbf`/`iat`. |
| `MEDIA_OIDC_JWKS_TTL_SECONDS` | `300` | JWKS cache lifetime. |
| `MEDIA_OIDC_JWKS_MIN_REFRESH_SECONDS` | `30` | Minimum gap between JWKS fetch attempts, including the one refetch an unknown `kid` may trigger. |
| `MEDIA_OIDC_REQUIRED` | `false` | When `true`, a production-like profile refuses to start without OIDC configured. |

**Verification.** Algorithm allow-list RS256 and ES256 only (`none` and all HMAC algorithms are refused; header
`jku`/`jwk`/`x5u` are never used); a `kid` is required and the key must be published by the issuer's JWKS with a matching
key type; then signature, `iss`, `aud`, `exp` (required), `nbf`, `iat`, ID/refresh tokens refused, `sub` and tenant
required. JWKS: bounded body (1 MiB), at most 64 keys, RSA 2048+ and EC P-256 signature keys only, no redirects, 5 second
timeouts, cached for the TTL, a stale-if-error grace of two minutes, then fail closed. An unreachable or unusable IdP
yields `503 IDENTITY_PROVIDER_UNAVAILABLE`; any invalid token yields `401 UNAUTHENTICATED` with no reason disclosed.

**Identity mapping.** The principal is `oidc:<first 12 bytes of SHA-256(issuer), hex>:<sub>`
(`MediaVerifiedIdentityContracts.oidcPrincipalId`); email and display names are never identity. Tenant and
permissions come only from verified claims; the request's `X-Tenant-Id`/`X-Principal-Id` headers are overwritten. The
`oidc:` principal space is reserved: a DEV token whose subject starts with `oidc:` is refused.

**Where it applies.**

- Production-like profiles with OIDC configured accept **only** OIDC tokens: shared-secret JWTs, DEV tokens and API keys
  (including the bootstrap key) are refused. Without `MEDIA_OIDC_ISSUER` the previous mechanisms are unchanged (set
  `MEDIA_OIDC_REQUIRED=true` to forbid that).
- Profile `dev` with `MEDIA_DEV_IDENTITY_ENABLED=true` accepts **both** a DEV token and an OIDC token. An OIDC token
  there may use the `/dev/v1` routes only if it carries the `media:project:dev:*` / `media:delivery:dev:*` roles.
- Other non-production profiles use OIDC for any bearer token when it is configured.

**Trusted identity contract** (`runtime-contracts`, package `com.ghatana.media.runtime`,
`MediaVerifiedIdentityContracts`): `VerifiedIdentity(issuer, subject, tenantId, authenticatedAt, AssuranceSource)`,
`AssuranceSource {OIDC_VERIFIED, DEV_ISSUED, SHARED_SECRET_JWT, BOOTSTRAP_SERVICE_KEY, LOCAL_UNVERIFIED, UNSPECIFIED}`
and `VerifiedIdentityPort.verify(String bearerToken): Optional<VerifiedIdentity>` (implemented by
`com.ghatana.media.launcher.oidc.OidcAccessTokenVerifier`). `AuthenticatedPrincipal` now carries `assurance()`; the
three-argument constructor stays and means `UNSPECIFIED`, which is never identity-provider backed. The filter exposes
the request's identity to features via `MediaSecurityFilter.verifiedIdentity(exchange)`.

**What it changes downstream.**

- *Reviewer decisions.* A decision by an assigned reviewer whose request identity was `OIDC_VERIFIED` is recorded under
  authority `idp-verified.assigned-reviewer.v1:<assignmentId>:v<n>:<SCOPE>` and reported as
  `IDP_VERIFIED_REVIEWER_<DECISION>` with `identityAssurance:"OIDC_VERIFIED"` and `identityBackedHumanDecision:true`.
  This records **who** decided (principal = issuer + subject) and that the identity provider vouched for them. It does
  not invent an approval: `establishesApproval` and `humanReviewApproval` stay `false`, nothing authorizes delivery or
  publication, and the assignment, scope, expiry and currentness rules are unchanged. A DEV-issued reviewer remains
  `DEV_ASSIGNED_REVIEWER_*` with `identityAssurance:"NOT_IDP_VERIFIED"`. No schema migration was needed.
- *Agent tools.* Production-like profiles now admit a tool invocation only for an `OIDC_VERIFIED` invoking principal and
  carry it, unchanged, into job submission (see `docs/surfaces/adapters-agent-tools-media/README.md`).

**Still fail-closed.** Production approval of any kind, Shared membership/tenant-admin contracts, provider activation
and release are not changed by this identity: the verified identity is authentication evidence only. Authorization is
the mapped permissions plus the existing per-feature rules.

**Swapping providers.** Point `MEDIA_OIDC_ISSUER`/`MEDIA_OIDC_AUDIENCE` at the new provider, and if its claim layout
differs set `MEDIA_OIDC_TENANT_CLAIM` and `MEDIA_OIDC_PERMISSION_CLAIMS` (for example `permissions` or `scope`). The
provider must issue RS256/ES256 JWT access tokens, publish a JWKS, put the audience in `aud` and carry a tenant claim.
Existing principals change when the issuer changes (the principal embeds an issuer hash), by design.

Tests: `OidcAccessTokenVerifierTest` (bad signature, wrong iss/aud, expired/skew, alg none/HS256, unknown kid refetched
once and rate-limited, JWKS unreachable fail-closed and stale grace), `MediaSecurityFilterOidcTest`,
`MediaDevReviewHttpTest` (OIDC reviewer), and `MediaOidcKeycloakIT` (Testcontainers Keycloak `26.8.2`: real token
accepted and persisted under the verified principal; forged, foreign-realm, tampered and `alg=none` tokens refused).

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

Hosted export with destination acknowledgment (in-process + real launcher/PostgreSQL/S3 restart):

```bash
./gradlew :services:media:launcher:test \
  --tests 'com.ghatana.media.launcher.MediaDevDeliveryHttpTest'
./gradlew :services:media:integration-tests:test \
  --tests 'com.ghatana.media.integration.MediaDevDeliveryRestartIT'
```

DEV_ONLY creative outputs (in-process HTTP; outside the canonical manifest/OpenAPI):

- `POST /dev/v1/creative-outputs/audio-repairs` runs `BoundedPcmDeclipper` on one exact owner artifact version
  (16-bit PCM WAV) and registers the repaired candidate as a NEW artifact. Lineage names the exact source version,
  engine/profile and the `AudioRepairComparison` metrics as the engine reports them (sample statistics only, no
  quality claim); the source version is never modified. No clipped samples is a typed 422, not an empty success.
- `POST /dev/v1/creative-outputs/simulations` runs `PhysicalSimulation` on an explicit bounded scenario and
  registers the JSON output (with units) only when `SimulationSemanticValidator` returns VALID. The output is labelled
  simulated model output, never a measurement; REJECTED/ABSTAIN/solver abstention is a typed 422 with no artifact.
  Input references are content-addressed to the request payload only (no external owner currentness authority).
- `GET /dev/v1/creative-outputs/{outputId}` reopens the output and its lineage from the artifact after restart.
- Both engines are deterministic, so a duplicate `requestId` replays the same artifact (200, `replayed:true`), a
  divergent reuse is 409, and a failed registration is a typed 502 that resumes with the same `requestId`.
- Admission control (DEV_ONLY render and creative-output lanes): a bounded global permit pool
  (`MEDIA_DEV_RENDER_MAX_CONCURRENT`, default 4, 1..64) and a per-tenant bound
  (`MEDIA_DEV_RENDER_MAX_CONCURRENT_PER_TENANT`, default 2, 0 = unbounded, at most the global bound) are acquired with
  `tryAcquire` and never waited on. When either is exhausted the route returns a typed retryable `429`
  `RENDER_CAPACITY_EXHAUSTED` with `Retry-After: 1` and `details.scope` of `global` or `tenant`, before any decode,
  render, artifact or upload exists (no side effect). `429` matches the runtime's existing retryable-status set; it is
  a transient per-caller back-pressure signal rather than a dependency outage (`503`). Permits are released in a
  `finally` on success, typed failure and unexpected exceptions. An idempotent replay still takes a permit, because
  replay is only recognised after the bytes are regenerated and compared; skipping admission would weaken idempotency.
- Metrics on `/metrics`: `media_dev_output_requests_total{lane,format,outcome}` (lane `render|creative|export`; format
  `gif|mp4|audio_repair|simulation|spatial_glb|delivery`; outcome from a fixed vocabulary such as `success`, `replayed`,
  `capacity_exhausted`, `not_supported`, `registration_failed`), `media_dev_output_duration_seconds{lane,format,outcome}`
  for permit-holding operations, and `media_dev_output_in_flight{lane}`. Tenant, principal, project, file and digest
  values are never labels.
- `POST /dev/v1/creative-outputs/spatial-glb` exports an explicit bounded rig (bones, exact-rational keyframes, the
  engine-supported coordinate frame: right-handed +X/+Y/+Z, metre, unit quaternion XYZW) with `SpatialRigEngine`'s
  existing GLB export and registers `model/gltf-binary`. Every `rig.sourceVersions` entry must be an exact artifact
  version of the requesting principal (else 404 `SOURCE_VERSION_NOT_FOUND`). Lineage carries the exact source
  versions, revision/rig refs as given, coordinate frame, `float32LossFields` as embedded by the engine, and engine
  identity. The engine's rights port is answered by a DEV_ONLY owner-scope visibility check (labelled
  `DEV_ONLY_OWNER_SCOPE_VISIBILITY`, `productionGrant:false`), never a production grant. Engine refusals (missing
  revision/source, unsupported frame, joint bound, float32 time collapse, invalid rig) are typed 422. No target
  profile registry, transform, field-loss binding, 360 or viewer fidelity claim is made. The durable store's format
  verifier now admits `model/gltf-binary`/`.glb` by `glTF` magic + version 2 only.

```bash
./gradlew :services:media:launcher:test \
  --tests 'com.ghatana.media.launcher.MediaDevCreativeOutputHttpTest'
```

Focused identity and rights coverage:

```bash
./gradlew :services:media:launcher:test \
  --tests 'com.ghatana.media.launcher.MediaSecurityFilterTest' \
  --tests 'com.ghatana.media.launcher.MediaRuntimeSpeechAdmissionTest' \
  --tests 'com.ghatana.media.launcher.MediaRuntimeJobGovernanceTest' \
  -Pghatana.media.compositeScope=FOCUSED -Pghatana.media.focusedModules=launcher
```
