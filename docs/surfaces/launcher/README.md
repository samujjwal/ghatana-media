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
- The canonical chunk `PUT /api/v1/artifacts/uploads/{uploadId}/chunks/{n}` accepts an optional
  `X-Chunk-SHA256` header (64 lowercase hex). When present and different from the received bytes the host answers
  422 `CHUNK_CHECKSUM_MISMATCH` (malformed header: 400 `CHUNK_CHECKSUM_INVALID`) and appends nothing, so the
  acknowledged prefix and next chunk index are unchanged. Absent header: unchanged behaviour. The header is not a
  declared OpenAPI parameter; the final whole-file SHA-256/size verification at completion is unchanged.
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
  **Injectable resolver port** (`com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver`):
  `Resolution resolve(ResolutionRequest)` with `ResolutionRequest(tenantId, artifactId, artifactVersion, contentSha256,
  Scope)` returning `Verdict` `ADMITTED | DENIED | REVOKED | STALE | MISMATCH | UNAVAILABLE`; anything but `ADMITTED`
  must be treated as not admitted, and `RightsConsentResolver.unavailable()` is the fail-closed default.
  `MediaRightsConsentAuthority` implements it over an `AttestationStore` (PostgreSQL V036 in the DEV_ONLY composition)
  and `MediaRightsConsentAuthority.gate(Authority, RightsConsentResolver)` wraps an existing
  `MediaSourceAuthorizationContracts.Authority` so ALLOWED requires both the policy authority and an admitted
  attestation (policy evidence is never synthesised).

- **Rights and consent authority in the canonical composition.** `MEDIA_RIGHTS_AUTHORITY=postgresql` selects the
  PostgreSQL attestation store (`PostgresqlRightsStoreFactory`, over the canonical runtime datasource; no second
  connection config). `MediaRuntime.compose` wraps the canonically selected source-authorization `Authority` with
  `MediaRightsConsentAuthority.gate(...)`: the delegate's Shared-policy evidence is returned unchanged and only
  when the resolver ADMITS the exact artifact version and digest. In production-like profiles an unset selector, an
  unconfigured datasource or a missing factory leaves the authority not ready (`UNAVAILABLE`,
  `RIGHTS_AUTHORITY_UNAVAILABLE` for STT); non-production profiles without the selector keep the previous
  behaviour. Scope mapping: STT, VISION, MULTIMODAL and analysis jobs on a source version use `PROCESSING`; a job
  whose parameters carry a voice or likeness reference (`voiceReference`, `likenessReference`, ...) uses
  `VOICE_OR_LIKENESS_USE`; delivery, export and publish operations use `EXTERNAL_DELIVERY` (the hosted DEV delivery
  lane already enforces it). Migration `V037` (append-only triggers on both attestation tables, truncate refusal and
  a revoked-then-confirm guard) is PostgreSQL only: it lives in `db/media-runtime-vendor/postgresql` (Flyway
  `{vendor}` location); `db/media-runtime-vendor/h2` carries a no-op at the same version so the H2 lineage fixture
  records the identical version sequence. **Known gaps:** no canonical HTTP route creates, confirms or revokes
  statements (the canonical route manifest and OpenAPI are PDP-owned, so none was added; the routes stay DEV_ONLY).
  The internal `MediaRuntime.rightsConsentAdministration()` already enforces `AssurancePolicy`: production-like
  profiles accept an `OIDC_VERIFIED` caller only, DEV-issued identities only in non-production profiles. Binding the
  referenced voice or likeness artifact itself (rather than the source version) to its own statement is not done.

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
| POST | `/dev/v1/intakes` | `media:project:dev:write` | `media:artifact:read` (caller owns the exact finalised version) | `MEDIA_DEV_INTAKE_ENABLED` + `MEDIA_DEV_RENDER_FFPROBE` (PostgreSQL V040 ledger). Registers the upload as the next immutable version of a lineage (201), probes the verified bytes with ffprobe (undecodable media: 422 `INTAKE_MEDIA_NOT_PROBEABLE`, nothing registered), identical content in the lineage deduplicates (200) |
| GET | `/dev/v1/intakes/{lineageId}` | `media:project:dev:read` | lineage owner (foreign owner: concealed 404) | intake: versions, parent links, probes and the live `PROCESSING` admission verdict per exact version |
| POST | `/dev/v1/captions/corrections` | `media:project:dev:write` | `media:artifact:{read,create}` (caller owns the exact base version) | timeline (rights/review: `MEDIA_RIGHTS_DEV_ENABLED`, `MEDIA_DEV_REVIEW_ENABLED`) |
| GET | `/dev/v1/captions/{captionId}` | `media:project:dev:read` | `media:artifact:read` (caller owns the version) | timeline |
| POST | `/dev/v1/exports` | `media:delivery:dev:export` | `media:artifact:read` | `MEDIA_DELIVERY_DEV_ENABLED` + `MEDIA_DELIVERY_DEV_DESTINATION_DIR` |
| GET | `/dev/v1/exports/{requestId}` | `media:delivery:dev:read` | — | delivery |
| GET | `/dev/v1/speech/capabilities` | `media:project:dev:read` | — | local speech (`MEDIA_LOCAL_MODEL_ROOT`); lists only manifest-verified voices, `verifiedLanguages`, `voiceCloning` and the licence attribution notice |
| POST | `/dev/v1/speech/syntheses` | `media:project:dev:write` | `media:artifact:{read,create}`; a `voiceReference`/`likenessReference` additionally needs a confirmed `VOICE_OR_LIKENESS_USE` statement and is then refused `VOICE_CLONING_NOT_SUPPORTED` | local Kokoro TTS |
| POST | `/dev/v1/speech/transcriptions` | `media:project:dev:write` | `media:artifact:{read,create}`, `PROCESSING` rights admission of the exact version | local Whisper STT |
| GET | `/dev/v1/speech/outputs/{outputId}` | `media:project:dev:read` | `media:artifact:read` | local speech |
| GET | `/dev/v1/vision/status` | `media:project:dev:read` | — | `MEDIA_LOCAL_VISION_*` configured |
| POST | `/dev/v1/vision/analyses` | `media:project:dev:write` | `media:artifact:{read,create}` | local vision |
| POST | `/dev/v1/vision/questions` | `media:project:dev:write` | `media:artifact:{read,create}` | local vision |
| POST | `/dev/v1/vision/tracks` | `media:project:dev:write` | `media:artifact:{read,create}` | local vision + `MEDIA_DEV_RENDER_FFMPEG`/`MEDIA_DEV_RENDER_FFPROBE` |
| POST | `/dev/v1/vision/roi-analyses` | `media:project:dev:write` | `media:artifact:{read,create}` | local vision (video also needs FFmpeg/FFprobe) |
| GET | `/dev/v1/vision/outputs/{outputId}` | `media:project:dev:read` | `media:artifact:read` | local vision |
| POST | `/dev/v1/video/enhancements` | `media:project:dev:write` | `media:artifact:{read,create}`, `PROCESSING` rights admission of the exact version | `MEDIA_DEV_RENDER_FFMPEG`/`MEDIA_DEV_RENDER_FFPROBE` |
| GET | `/dev/v1/video/enhancements/{outputId}` | `media:project:dev:read` | `media:artifact:read` | FFmpeg/FFprobe composed |
| POST | `/dev/v1/video/comparisons` | `media:project:dev:write` | `media:artifact:{read,create}`, `PROCESSING` rights admission of every subject and the reference | FFmpeg/FFprobe composed |
| GET | `/dev/v1/video/comparisons/{outputId}` | `media:project:dev:read` | `media:artifact:read` | FFmpeg/FFprobe composed |
| GET | `/dev/v1/animations/status` | `media:project:dev:read` | — | `MEDIA_DEV_RENDER_FFMPEG`/`MEDIA_DEV_RENDER_FFPROBE` + the shared request ledger |
| POST | `/dev/v1/animations/renders` | `media:project:dev:write` | `media:artifact:{read,create}`; `PROCESSING` rights admission of every image asset | FFmpeg/FFprobe composed (J-12) |
| GET | `/dev/v1/animations/renders/{renderId}` | `media:project:dev:read` | `media:artifact:read` (the render id is the manifest artifact id) | FFmpeg/FFprobe composed |
| GET | `/dev/v1/audio/status` | `media:project:dev:read` | — | `MEDIA_DEV_RENDER_FFMPEG` (absolute path); Whisper optional |
| POST | `/dev/v1/audio/restorations` | `media:project:dev:write` | `media:artifact:{read,create}` | `MEDIA_DEV_RENDER_FFMPEG`; PROCESSING rights on the exact source; J-07 (`MediaDevAudioRestorationRuntime`) |
| POST | `/dev/v1/audio/comparisons` | `media:project:dev:write` | `media:artifact:{read,create}` | measured source/restored(/reference) report; optional Whisper transcript diff |
| GET | `/dev/v1/audio/outputs/{outputId}` | `media:project:dev:read` | `media:artifact:read` | reopen a restoration or comparison |
| GET | `/dev/v1/translations/capabilities` | `media:project:dev:read` | `media:artifact:read` | local translation (`MEDIA_LOCAL_VISION_*`) and/or local speech; lists the admitted language pairs, voices, tempo bounds and overflow policies |
| POST | `/dev/v1/translations` | `media:project:dev:write` | `media:artifact:{read,create}`, `PROCESSING` rights admission of the transcript's original source | local Qwen2.5-VL (text-only) via the vision sidecar |
| POST | `/dev/v1/translations/revisions` | `media:project:dev:write` | `media:artifact:{read,create}`, same rights chain | translation (no model run) |
| GET | `/dev/v1/translations/{artifactId}` | `media:project:dev:read` | `media:artifact:read` | translation |
| POST | `/dev/v1/dubs` | `media:project:dev:write` | `media:artifact:{read,create}`, same rights chain; a `voiceReference`/`likenessReference` is refused as in plain synthesis | local Kokoro TTS (+ `MEDIA_DEV_RENDER_FFMPEG` for tempo) |
| GET | `/dev/v1/dubs/{dubId}` | `media:project:dev:read` | `media:artifact:read` | dubbing |
| GET | `/dev/v1/grounded-answers/status` | `media:project:dev:read` | — | local vision + `MEDIA_DEV_RENDER_FFMPEG/FFPROBE` |
| POST | `/dev/v1/grounded-answers` | `media:project:dev:write` | `media:artifact:{read,create}` | local vision + FFmpeg/FFprobe |
| GET | `/dev/v1/grounded-answers/{outputId}` | `media:project:dev:read` | `media:artifact:read` | local vision + FFmpeg/FFprobe |
| GET | `/dev/v1/erasure-plans/{artifactId}` | `media:project:dev:read` | `media:artifact:read` (caller owns the root); read-only preview of the exact tree, dependent records and blocking holds | `MEDIA_DEV_ERASURE_ENABLED` + canonical PostgreSQL/S3 runtime |
| POST | `/dev/v1/erasures` | `media:project:dev:write` | `media:artifact:write`; `confirm:true`; optional `expectedArtifactCount`; owner only; `LEGAL_HOLD_ACTIVE` while a hold covers the tree; `OIDC_VERIFIED` in production-like profiles (or `MEDIA_DEV_ERASURE_REQUIRE_OIDC=true`) | erasure |
| GET | `/dev/v1/erasures/{erasureId}` | `media:project:dev:read` | `media:artifact:read`; content-free receipt (kinds, counts, digests) | erasure |
| POST | `/dev/v1/legal-holds` | `media:project:dev:write` | `media:artifact:write`; owner only; records reason, principal and identity assurance; `OIDC_VERIFIED` in production-like profiles | erasure |
| GET | `/dev/v1/legal-holds/{holdId}` and `/dev/v1/legal-holds?artifactId=` | `media:project:dev:read` | `media:artifact:read`; owner only | erasure |
| POST | `/dev/v1/legal-holds/{holdId}/release` | `media:project:dev:write` | `media:artifact:write`; the placing owner; attributed; `OIDC_VERIFIED` in production-like profiles | erasure |
| GET | `/dev/v1/providers/catalog` | `media:project:dev:read` | — | always (dev); observed readiness of Whisper, Kokoro, Florence-2, Qwen2.5-VL and FFmpeg |


DEV_ONLY provider catalog and outage-safe lanes (J-30 `media.dev.outcome-eligible-provider-catalog`, J-27
`media.dev.outcome-provider-outage-safe-path`).
`GET /dev/v1/providers/catalog` (`MediaDevProviderCatalog`) reports, per local provider (`whisper`, `kokoro`, `florence`,
`qwen`, `ffmpeg`): `state`, a stable `reason` code, the manifest `modelId`/`revision`, `license{spdx,noticeRequired,notice}`,
`digests`, `verifiedLanguages`, `voices`, the `device` the provider actually reported (`kind` GPU/CPU/UNREPORTED, `name`),
`productionEligible` (always `false`: this catalog never asserts production eligibility), `fallback:"NONE"`,
`lastCheckedAt` and `probeMillis`. States are observed, never configured: `READY` needs the manifest digests to verify AND a
live probe to answer (`whisper-cli -h` after the pinned executable digest matched; the Kokoro worker's own `/v1/health`, which
also reports the device torch uses; the vision sidecar's `/v1/health`, which reports the device torch reports; and
`ffmpeg -version`, `ffprobe -version` and the `libx264`/`aac`/`mov_text` encoders). `NOT_ADMITTED` carries the reason
(`MODEL_NOT_INSTALLED`, `MODEL_MANIFEST_INVALID`, `MODEL_DIGEST_MISMATCH`, `MODEL_FILE_MISSING`, `MODEL_LICENSE_MISMATCH`,
`BINARY_DIGEST_MISMATCH`, ...). `WITHDRAWN` (`MODEL_FILES_CHANGED`, `BINARY_CHANGED`, `WORKER_REFUSED`) means it was verified
and a file changed afterwards. `UNAVAILABLE` means the process, port, binary or worker is absent (`WORKER_NOT_RUNNING`,
`SIDECAR_UNREACHABLE`, `BINARY_MISSING`, `FFMPEG_BINARY_MISSING`, `NOT_CONFIGURED`, `PROBE_TIMEOUT`); `DEGRADED` means it
answers too slowly or only partly (`SIDECAR_HEALTH_TIMEOUT`, `PROBE_SLOW`, `NO_PERSISTENT_WORKER_TO_PROBE`). The Kokoro
worker starts on its first request unless `MEDIA_LOCAL_MODEL_PRELOAD=true`, so before that it is `UNAVAILABLE
WORKER_NOT_RUNNING`. Whisper's device is `UNREPORTED`: whisper-cli names its device only while it runs inference. FFmpeg's
SPDX identifier is derived from the binary's own `configuration:` line. Probing is bounded: the observation is cached for
`MEDIA_DEV_PROVIDER_CATALOG_TTL_SECONDS` (default 5, max 300), one refresh runs at a time (concurrent callers share it), at most
`MEDIA_DEV_PROVIDER_CATALOG_MAX_CONCURRENT_PROBES` (default 3, max 8) probes run at once and a probe has a 12 s hard deadline
(`PROBE_TIMEOUT`). The view never contains a filesystem path, endpoint or token; production-like profiles additionally omit
device names and runtime versions. Metrics: `media.dev.provider.state{provider,state}` (one-hot gauge, 5x5 series),
`media.dev.provider.checked_at_seconds{provider}` and `media.dev.provider.outages{lane,outcome}` (fixed vocabularies, no
secret or path labels). The Explorer page `dev-provider-status.html` (panel `DevProviderStatusPanel` in `@audio-video/ui`)
proxies only this read-only route and refreshes live.

No-fallback policy: Media never substitutes a different model, voice or engine for a provider that failed. A lane whose
provider is down or degraded answers with exactly one of three typed outcomes (each error carries `details.outcome` and
`details.fallback:"NONE"` and is counted in `media.dev.provider.outages`), registers nothing, and a retry with the same
`requestId` runs once through the durable request ledger:

| Provider condition | Outcome | Speech (STT / TTS) | Vision | Grounded | Render (MP4) |
| --- | --- | --- | --- | --- | --- |
| nothing ran (binary missing, port closed, no worker, sidecar 5xx such as GPU OOM) | `UNAVAILABLE` 503 | `SPEECH_RUNTIME_UNAVAILABLE` | `LOCAL_VISION_UNAVAILABLE` | `GROUNDED_UNAVAILABLE` | `RENDER_CODEC_UNAVAILABLE` |
| may have run (crash, exit 139, connection lost mid-call) | `UNKNOWN` 503 | `SPEECH_OUTCOME_UNKNOWN` | `VISION_OUTCOME_UNKNOWN` | `GROUNDED_OUTCOME_UNKNOWN` | `RENDER_OUTCOME_UNKNOWN` |
| beyond its deadline (the call is abandoned, a late result is never used) | `TIMEOUT` 504 | `SPEECH_TIMEOUT` | `VISION_TIMEOUT` | `GROUNDED_TIMEOUT` | `RENDER_TIMEOUT` (`MEDIA_DEV_RENDER_TIMEOUT_SECONDS`) |

Captions: the machine WebVTT comes from the transcription lane and follows its outcomes; human caption correction calls no
model and keeps working while a provider is down. `GROUNDED_UNAVAILABLE` is returned when an evidence child (speech or
vision) was unavailable and `allowPartial` is not set; with `allowPartial` the remaining evidence answers and the result is
labelled `PARTIAL`, an explicit caller choice and not a model substitution. A TIMEOUT stops the caller's wait and kills the
local process (FFmpeg, whisper-cli); the vision sidecar has no cancellation protocol, so its GPU work may finish and is
discarded.

DEV_ONLY translation and dubbing (J-16; owner decision of the Media owner delegate, 2026-11-15, Spanish only). `POST
/dev/v1/translations` `{requestId, transcriptArtifactId, transcriptArtifactVersionId, sourceLanguage:"en", targetLanguage:"es"}`
translates an exact speech-transcript version segment by segment with the local Qwen2.5-VL (text-only, through the vision
sidecar's additive `/v1/translate`), keeping segment ids and source-clock times; `POST /dev/v1/translations/revisions` registers a
human revision as a new version (same ids/times). `POST /dev/v1/dubs` `{requestId, translatedArtifactId,
translatedArtifactVersionId, voice?, overflowPolicy?: REFUSE|ALLOW_SPILL}` synthesizes each segment with a Spanish stock voice,
fits it to its source window (bounded `atempo` up to 1.25, never truncation) and registers a timing-aligned WAV, WebVTT and the
per-segment timing metadata (source window, dub duration, tempo factor, overflow). Typed refusals: `422 LANGUAGE_NOT_ADMITTED`,
`422 DUB_TIMING_OVERFLOW` (details list every segment), `422 VOICE_LOCALE_MISMATCH`, `VOICE_CLONING_NOT_SUPPORTED`,
`403 RIGHTS_DECISION_*` / `422 RIGHTS_AUTHORITY_UNAVAILABLE` (the root source of the derivation chain needs a PROCESSING
statement, re-checked on every call), `503 TRANSLATION_OUTCOME_UNKNOWN` / `DUB_OUTCOME_UNKNOWN` (nothing registered; retrying the
same `requestId` registers once). Outputs carry `source` / `sourceTranscript` / `parent` lineage so derived outputs can be found.

DEV_ONLY voice synthesis (J-04; real Kokoro-82M, Apache-2.0, stock voices, no voice cloning).
`POST /dev/v1/speech/syntheses` takes `{requestId, text, voice?, speakingRate?, locale?, voiceReference?, likenessReference?}`
where a reference is `{artifactId, artifactVersionId}` and `locale` defaults to `en`. The verified voices, verified
languages, voice-cloning status and attribution notice come from `GET /dev/v1/speech/capabilities` (the pinned manifest),
never from a client list. Typed refusals, all with no model run and no artifact: `422 LOCALE_NOT_ADMITTED` (primary
language outside `verifiedLanguages`), `422 VOICE_NOT_ADMITTED`, `400` for any other field (a voice sample or embedding
cannot be passed), and for a reference `404 SOURCE_VERSION_NOT_FOUND` (not owner-visible), `403 RIGHTS_DECISION_DENIED |
REVOKED | STALE | MISMATCH` unless the exact version carries a second-person-confirmed `VOICE_OR_LIKENESS_USE`
(`IDENTIFIABLE_PERSON_CONSENT`) statement, `422 RIGHTS_AUTHORITY_UNAVAILABLE`, and then, even when admitted,
`422 VOICE_CLONING_NOT_SUPPORTED`. Rights are re-evaluated on every call, so a retry after a revocation is refused. If the
synthesis process ends without a verified result (killed or crashed) the response is `503 SPEECH_OUTCOME_UNKNOWN`
and nothing is registered; retrying the same `requestId` creates exactly one artifact and later retries replay it
(`200`, `replayed=true`; local synthesis is not byte-stable, so the requestId-to-output mapping is the durable request ledger
(see "DEV_ONLY durable request ledger" below): a retry after success re-reads the registered artifact and never runs the model
again, also after a restart; a different request under the same `requestId` is `409 SPEECH_REQUEST_ID_REUSED`). The bounded,
owner-only spool (`MEDIA_DEV_SPEECH_SPOOL_DIR`, default under the temp directory, 256 entries) is now only a byte cache that
lets a retry after a crash between synthesis and registration register the SAME bytes instead of synthesizing again; its
eviction loses no replay. Altering any pinned weight file withdraws the profile at once (`ready=false`, no voices,
`503 SPEECH_RUNTIME_UNAVAILABLE`). The output is a mono 24 kHz PCM16 WAV artifact whose lineage records voice, locale,
model/runtime digests and the input text digest only. The Explorer page `dev-voice-synthesis.html` (panel
`VoiceSynthesisPanel` in `@audio-video/ui`) proxies only the synthesis routes of this lane; transcription is not proxied.
DEV_ONLY audio restoration and measured comparison (J-07, `media.dev.outcome-audio-restoration`; `MediaDevAudioRestorationRuntime`,
`MediaDevAudioRoutes`). `POST /dev/v1/audio/restorations` takes `{requestId, artifactId, artifactVersionId, operations}` where
`operations` is a strict typed set (at least one of `declip{threshold 1-100}`, `dehum{frequencyHz 50|60}`,
`denoise{reductionDb 1-40, noiseFloorDb -80..-20, trackNoise}`, `normalize{targetLufs -30..-10}`; normalization is off unless
present). Invalid or unknown parameters are refused (422 `AUDIO_PARAMETERS_INVALID` or 400) before any rights call, source read or
engine start. The exact PCM16 WAV version (at most 8 MiB, 8-96 kHz, mono/stereo) needs `Scope.PROCESSING` from the rights resolver on
every call (replays included); a different current version is 409 `SOURCE_VERSION_STALE`. The filter graph is built only from the
validated numbers and run through `BoundedProcessRunner` (argument array, cleared environment, wall-clock deadline
`MEDIA_DEV_AUDIO_RESTORE_TIMEOUT_SECONDS` default 60, output ceiling); the FFT denoiser's sampleRate/40 latency is absorbed so the
result stays sample-aligned. The result is a NEW `audio/wav` version whose lineage records the source version digest, the filter graph,
the typed parameters and the engine version line and binary digest; the WAV also carries the request id and source digest in its
RIFF comment so a second request never collides with the tenant's content-addressed uniqueness. A killed, timed-out or over-ceiling
engine is 503 `AUDIO_RESTORATION_OUTCOME_UNKNOWN` (nothing registered; the ledger claim is released so a retry of the same requestId
runs again and registers exactly once; a SIGKILLed launcher is reclaimed through the dead-owner path). `POST /dev/v1/audio/comparisons`
takes `{requestId, source, restored, reference?, transcript?{language, referenceText?}}` (all exact versions; the restored version
must be a recorded restoration of that source) and registers a JSON report: SNR and segmental SNR against the reference, clipped-sample
count, noise-floor level and spectral flatness for source and restored, deltas, a verdict derived only from the numbers (no reference
means `NOT_MEASURED_AGAINST_REFERENCE`), and an optional local Whisper transcript diff (word error rate against the clean reference
text or Whisper-on-reference). `GET /dev/v1/audio/outputs/{id}` reopens either after restart.

DEV_ONLY video tracking and ROI analysis (J-05, `media.dev.outcome-vision-detection-and-tracking`; same models, rights,
registration and `/dev/v1/vision/outputs/{outputId}` readback as in the lane described below; `MediaDevVisionTrackingRuntime`).
`POST /dev/v1/vision/tracks` takes `{requestId, artifactId, artifactVersionId, maxFrames?(1-64, default 16),
strideFrames?(0 = automatic), minIou?(0.05-0.9, default 0.3), maxMissedFrames?(0-4, default 1)}` for a `video/*`
version. The real frame timeline comes from `ffprobe -show_frames` (integer PTS in the stream's rational time base,
sorted into PTS order, so variable frame rate works; duplicate PTS or a missing time base is `422
VIDEO_TIMELINE_UNTRUSTED`). A deterministic uniform PTS-order sample is decoded in one FFmpeg pass
(`select=eq(n,..)`, `-fps_mode passthrough`), each frame's raster must equal the probed geometry, and Florence-2
object detection runs per frame (bounded batches of 4; one sidecar call per frame, nothing is registered until every
sampled frame completed). Detections are linked by `GREEDY_IOU_LABEL_V1`: for each frame, live tracks (seen within
`maxMissedFrames + 1` sampled frames) are paired with same-label detections by score = max(IoU(last box), IoU(constant
velocity prediction in PTS time)); pairs at or above `minIou` are assigned greedily by score, then lower track number,
then detection index; unmatched detections start `T0001, T0002, ...`. It is plain greedy association (no Hungarian
step, no appearance model): same-label objects that overlap heavily can swap identity, and a detector label that
flips between frames (for example car and truck) splits a track; both are documented limits, not hidden. The registered
`media.dev.vision-tracks.v1` document holds `video{width,height,timeBase{num,den},frameCount,variableFrameRate}`,
`frames[{frameIndex,pts,ptsMicros,frameSha256,detections,rejectedDetections}]`, `tracks[{trackId,label,
observations[{frameIndex,pts,ptsMicros,box{x,y,width,height}}]}]` in source-frame pixels (top-left origin; EXIF
orientation is not applied to stills), and the model identity. Boxes up to one pixel outside the raster are clamped;
anything further out is dropped and counted in `rejectedDetections`. Lineage (`source`, `models`, `video`, `tracking`,
`rightsDecision`, `resultSha256`) binds the exact source version digest and the digest-qualified model. A retry with the
same requestId replays the registered tracks (`200`) from the durable request ledger without re-running the detector; it
is never a second registration, and the same requestId with different parameters is `409 VISION_REQUEST_ID_REUSED`. ROI
analysis (`vision.roi` ledger lane) behaves the same way.

DEV_ONLY deterministic 2D animation (J-12, `media.dev.outcome-two-dimensional-animation`; `MediaDevAnimationRuntime`,
`MediaDevAnimationSpec`, `MediaDevAnimationRoutes`; composed only when both absolute `MEDIA_DEV_RENDER_FFMPEG` and
`MEDIA_DEV_RENDER_FFPROBE` are set, with the shared durable request ledger). `POST /dev/v1/animations/renders` takes
`{requestId, spec, encoder?{crf 10-30, default 14}}` where `spec` is `media.dev.animation-spec.v1`: `width`/`height`
(even, 16-1280 x 16-720), opaque `background` (`#RRGGBB`), `fps{numerator,denominator}` (1-60), `frameCount` (1-240, at most
33,554,432 total pixels), `shapes[]` (`RECTANGLE`, `ELLIPSE`, `LINE`, `RASTER_ASSET`; `x,y,width,height`, `color`
`#RRGGBB[AA]`, `keyframes[]` of `{frame,x,y,scaleX,scaleY,rotationDegrees,opacity,easing}` with `LINEAR`, `EASE_IN`,
`EASE_OUT` or `EASE_IN_OUT` easing to the next keyframe; keyframe x/y are pixel offsets from the shape's own position),
optional seeded `particleFields[]` and optional `assets[]` (`{id,artifactId,artifactVersionId}` exact `image/png` or
`image/jpeg` versions, at most 1 MiB pixels). There is deliberately no text primitive: glyph rasterization depends on host
fonts and would break determinism. Unknown fields and wrong types are `422 ANIMATION_SPEC_INVALID` with
`details.path` (for example `$.shapes[1].keyframes[2].frame`); a ceiling is `422 ANIMATION_BUDGET_EXCEEDED` with
`details{path,limit,ceiling,requested}`; both happen before any source lookup, rights call, permit or process. Each asset
must be visible to the caller (otherwise `404 SOURCE_VERSION_NOT_FOUND`) and resolve ADMITTED for `PROCESSING` on every
call, a replay included (`403 RIGHTS_NOT_ADMITTED` with the verdict, `503 RIGHTS_AUTHORITY_UNAVAILABLE`); nothing is read,
rendered or registered otherwise. The verified renderer produces PNG frames (no antialiasing, exact-rational PTS, seeded
particles); FFmpeg (bounded no-shell runner, absolute path, empty environment, 5 minute deadline, 64 MiB output ceiling)
encodes them with libx264 (`-preset medium`, High profile, no B-frames, single thread, `yuv420p`, BT.709 limited range
tagged, `-fflags +bitexact`, a track timescale that makes every frame duration an exact integer). Before registration the MP4
is re-probed with ffprobe: codec, pixel format, geometry, exact frame count, exact rational frame rate, time base and every
frame's PTS tick; any disagreement registers nothing. Two NEW artifacts are registered: the `video/mp4` and an
`application/json` frame manifest (`media.dev.animation-manifest.v1`: the canonical spec, per-frame exact PTS and story time,
PNG and decoded-pixel SHA-256, the frame-set digest, the verified encode and each asset's rights decision); the response
returns both plus the manifest (`201`, or `200 replayed:true`). The request id is in the MP4 container comment, so two
requests never share bytes. The same requestId and body replays the stored output from the ledger; a different body is
`409 ANIMATION_REQUEST_ID_REUSED`; an FFmpeg process that is killed or times out is `503 ANIMATION_OUTCOME_UNKNOWN`
with nothing registered, and a retry (or a retry after a launcher restart, taken over from the dead owner) registers exactly
once. The MP4 is read back through `GET /dev/v1/artifacts/{id}/content` (Range supported). The output is a lossy YUV420
encode of the frames; no quality, rights, approval or production claim.

DEV_ONLY video enhancement and independent measured comparison (J-08, `media.dev.outcome-video-enhancement`;
`MediaDevVideoRuntime`, `MediaDevVideoRoutes`, `MediaDevVideoQualityMetrics`; composed only when both absolute
`MEDIA_DEV_RENDER_FFMPEG` and `MEDIA_DEV_RENDER_FFPROBE` are set, with the shared durable request ledger).
`POST /dev/v1/video/enhancements` takes `{requestId, artifactId, artifactVersionId, operations[1-5], encoder?{crf 10-30,
default 18}}` for a `video/*` version. `operations` is a bounded typed set, each type at most once, applied in the fixed
order deinterlace, denoise, deblock, sharpen, colour correction regardless of request order: `{type:"deinterlace"}`
(`yadif` mode 0, frame count unchanged), `{type:"denoise", method:"hqdn3d"|"nlmeans", strength}` (hqdn3d 0.5-12,
nlmeans 1-10), `{type:"deblock", strength 0.02-0.4}`, `{type:"sharpen", amount 0.1-1.5}` (`unsharp`, luma only) and
`{type:"colourCorrection", brightness -0.3..0.3, contrast 0.5-2, saturation 0-2.5, gamma 0.5-2}` (`eq`). A value out of
range, an unknown type or key, a duplicate type or too many operations is `422 VIDEO_PARAMETER_OUT_OF_RANGE` while the
body is parsed, before any source lookup, rights call or process. FFmpeg is run through the bounded no-shell runner
(absolute path, empty environment, 10 minute deadline, 256 MiB output ceiling watched while it runs; source <= 128 MiB,
<= 1080p, <= 1800 frames); request text never reaches the command line, only the formatted numbers of the typed
operations. Video is re-encoded with libx264 (`-preset medium`, `-pix_fmt yuv420p`, `-fps_mode passthrough`, source
track timescale kept when the time base is `1/n`) and every audio stream is copied (`-c:a copy`). Before anything is
registered the output is re-probed: frame count, every frame's presentation instant (exact rational equality), geometry,
duration and the audio stream parameters plus the MD5 of the copied audio packets must equal the source, otherwise
`422 ENHANCEMENT_TIMELINE_MISMATCH`/`ENHANCEMENT_AUDIO_MISMATCH` and nothing is registered. The result is a NEW
`video/mp4` artifact (the source is untouched); lineage `videoSchema=media.dev.video-enhancement.v1` holds `source`
(artifact, exact version, SHA-256), `operations`, the exact `filterGraph`, `encoder`, the verified `timeline` and `audio`,
the FFmpeg version, `rightsDecision` and `resultSha256`. A source that ffprobe cannot read, has no video stream, a
broken timeline, or a rotation matrix is `422 SOURCE_VIDEO_CORRUPT`/`SOURCE_FORMAT_NOT_SUPPORTED`; a non-video
artifact is `422 SOURCE_FORMAT_NOT_SUPPORTED`. An FFmpeg process that is killed (signal exit) or exceeds the deadline is
`503 VIDEO_OUTCOME_UNKNOWN` with nothing registered; a retry with the same requestId runs again and registers exactly
once (upload idempotency key plus the ledger lane `video.enhance`), and a completed request replays (`200`) without
running FFmpeg, even after a launcher restart. The same requestId with another graph is `409 VIDEO_REQUEST_ID_REUSED`.
Rights are re-resolved on every call, replays included: a missing, revoked or unavailable `PROCESSING` admission is
`403 RIGHTS_DENIED|RIGHTS_REVOKED|...` / `503 RIGHTS_AUTHORITY_UNAVAILABLE`. `POST /dev/v1/video/comparisons` takes
`{requestId, reference?{artifactId, artifactVersionId}, subjects[1-3]{label, artifactId, artifactVersionId}}`; every
subject and the reference needs its own `PROCESSING` admission (an enhanced output is a new artifact). The luma plane
of each decoded video is measured in Java, independently of FFmpeg's `psnr`/`ssim` filters (the tests cross-check
them): per-frame PSNR, per-frame mean SSIM (8x8 windows, stride 4), and without or in addition to a reference the
Immerkaer noise-sigma estimate and the Laplacian variance. Frames are paired by exact presentation instant, not by
index; unpaired frames are counted (`unalignedSubjectFrames`, `unalignedReferenceFrames`, `fullyAligned`) and zero
pairs is `422 PTS_ALIGNMENT_FAILED`; differing frame sizes are `422 VIDEO_GEOMETRY_MISMATCH` (no scaling is done).
Subject 0 is the baseline; each later subject reports `meanPsnrYDeltaDb`, `meanSsimYDelta`, noise/sharpness deltas, the
per-frame counts that improved and regressed and a `verdict` of IMPROVED, REGRESSED or MIXED (NO_REFERENCE when no
reference was given): a regression is reported as such, never smoothed. Identical frames have no finite PSNR and are
reported as 100 dB and counted in `identicalFrames`. The registered `media.dev.video-comparison.v1` JSON carries the
method, per-frame values and aggregates; its lineage `summary` repeats the aggregates. Claims are limited to measured
luma PSNR/SSIM and the two no-reference estimates (edges and texture inflate the noise estimate, noise inflates the
Laplacian variance): no perceptual-quality, rights, approval or production claim. Reopen with
`GET /dev/v1/video/{enhancements|comparisons}/{outputId}` (a mismatched kind is `404`). The Explorer page
`dev-video-comparison.html` (panel `DevVideoComparisonPanel`, player `VideoWipeComparison` in `@audio-video/ui`) proxies
only the four routes above and shows a wipe or side-by-side player with a per-frame metrics chart.
A sidecar that fails or is killed mid-run is `503 VISION_OUTCOME_UNKNOWN` (`outcome:"UNKNOWN"`, `framesCompleted`,
`framesPlanned`): never success, nothing registered, retry the same requestId. A withdrawn model (digest changed) is
`503 LOCAL_MODEL_NOT_ADMITTED` before any byte is read.
`POST /dev/v1/vision/roi-analyses` takes `{requestId, artifactId, artifactVersionId, tasks:["detect"|"ocr"], roi:{x,y,
width,height}, frameIndex?}` (`frameIndex` is the PTS-order ordinal for video; stills ignore it). The ROI is validated
in stages: structurally when the request is parsed, before any source lookup, rights call or byte read (`422
ROI_MALFORMED` for non-integer, missing, extra or overflowing fields, `ROI_NEGATIVE`, `ROI_ZERO_SIZE`), and against the
decoded frame before any model call (`422 ROI_OUT_OF_FRAME`; for video the probed geometry is used so no frame is even
decoded; `422 FRAME_INDEX_OUT_OF_RANGE`). The model sees only the crop; detection boxes and scene-text quads are
translated back into source-frame pixels (`media.dev.vision-roi.v1`). Scene text remains Florence-2's own OCR task, not
the Document Intelligence gateway. The Explorer's `dev-vision-tracks.html` page (`DevVisionTracksPanel`,
`VisionTrackOverlay` in `libs/audio-video-ui`) tracks or reopens a result, verifies both the tracks bytes and the
source video bytes against their registered SHA-256, then draws the boxes of the sampled frame that governs the
playhead over the player (marking `exact` or `held`) with an accessible list of tracks.

DEV_ONLY local vision and multimodal lane (owner-selected local open models; outside the canonical manifest/OpenAPI).
Owner decision, 2026-11-14, verbatim: "Local open models (Recommended): Whisper large-v3-turbo via whisper.cpp for
speech-to-text (MIT). Kokoro-82M for text-to-speech (Apache-2.0, no voice cloning). Florence-2 for vision (MIT).
Qwen2.5-VL-7B for multimodal (Apache-2.0). Media stays on this machine, with no per-use cost." and "we will abide by all
license requirements." This lane covers Florence-2 and Qwen2.5-VL only. Enabled by `MEDIA_LOCAL_VISION_MODELS_ROOT`
(absolute directory holding `florence-2-large/` and `qwen2.5-vl-7b-instruct/`, each with a digest manifest),
`MEDIA_LOCAL_VISION_SIDECAR_URL` (http loopback only; anything else fails at construction),
`MEDIA_LOCAL_VISION_SIDECAR_TOKEN` (>= 24 chars) and optional `MEDIA_LOCAL_VISION_TIMEOUT_SECONDS` (default 240);
video frames additionally need the existing absolute `MEDIA_DEV_RENDER_FFMPEG`. Install and start the sidecar with
`tools/model-runtimes/vision/README.md`. `POST /dev/v1/vision/analyses` takes
`{requestId, artifactId, artifactVersionId, tasks:["caption","detect","ocr"], frameTimeMs?}` and
`POST /dev/v1/vision/questions` takes `{requestId, artifactId, artifactVersionId, question, frameTimeMs?}`. The exact
immutable owner-visible version (image/* or, with `frameTimeMs` as integer milliseconds, video/*) is read and verified,
inferred by the digest-qualified model, and the structured result is registered as an immutable `application/json`
artifact through the canonical idempotent upload path (`201`, replay `200`, requestId reuse with a different request
`409 VISION_REQUEST_ID_REUSED`). Lineage metadata binds the source artifact id/version/SHA-256, the frame position and
frame digest for video, and the model identity (id, upstream revision, SPDX licence, file-set digest). Inference is
greedy and the registered JSON carries no timestamps; the requestId is not made idempotent by re-deriving bytes but by the
durable request ledger (see "DEV_ONLY durable request ledger"), so the model is never re-run for a completed request. Typed refusals:
`404 SOURCE_VERSION_NOT_FOUND` (stale/foreign/unknown version), `403 ARTIFACT_PERMISSION_REQUIRED`,
`422 SOURCE_FORMAT_NOT_SUPPORTED | FRAME_EXTRACTION_UNAVAILABLE | FRAME_EXTRACTION_FAILED`,
`503 LOCAL_MODEL_NOT_ADMITTED` (manifest missing or digest/licence/identity mismatch; nothing is dispatched) and
`503 LOCAL_VISION_UNAVAILABLE` (sidecar unreachable or timed out). Rights: before any byte is read, the exact source version and content digest are resolved for
`Scope.PROCESSING` through the injectable `MediaRightsConsentContracts.RightsConsentResolver` (enabled with
`MEDIA_RIGHTS_DEV_ENABLED`; an attestation for that exact version is created through `/dev/v1/rights/attestations`).
Anything not ADMITTED is refused with nothing dispatched: `503 RIGHTS_AUTHORITY_UNAVAILABLE` (no authority configured or
failing) or `403 RIGHTS_DENIED | RIGHTS_REVOKED | RIGHTS_STALE | RIGHTS_MISMATCH`. Lineage records the verdict and the
admitting attestation ids (`productionGrant:false`). No face or person identification is offered, so
`VOICE_OR_LIKENESS_USE` is never needed. The canonical VISION job admission is unchanged. The same provider is registered as `local-open-vision` (VISION job type, LOCAL boundary, no
retention) when configured: it is `productionEligible` only when both models are digest-qualified and a production-eligible
`LocalVisionRightsAuthority` is ready; the default reports `RIGHTS_AUTHORITY_UNAVAILABLE` (the DEV attestation store is
not production eligible), so production-like profiles never use it. Florence-2 scene text is its own OCR task, not the Document Intelligence OCR
gateway, and no quality or accuracy claim is made.

DEV_ONLY grounded cross-modal answer lane (J-06; `MediaDevGroundedAnswerRuntime`, outside the canonical
manifest/OpenAPI; the `av.multimodal-inference` tool schema is PDP-owned and gains no `question` field, so the question
flow lives only on these DEV routes). `POST /dev/v1/grounded-answers` takes
`{requestId, artifactId, artifactVersionId, question (<=200 chars), language?, allowPartial?}` for one exact `video/*`
version. Order: exact owner-visible version, `Scope.PROCESSING` rights (anything not ADMITTED is refused before any byte is
read: `503 RIGHTS_AUTHORITY_UNAVAILABLE` or `403 RIGHTS_DENIED|REVOKED|STALE|MISMATCH`), then ffprobe derives the source
clock (container `start_time`, per-stream `time_base`/`start_pts`; a missing value is `422 SOURCE_CLOCK_UNDETERMINED`,
never defaulted). Two independent evidence children run: STT (whisper.cpp over the extracted audio track; segment times
are `audio.start_time + segment offset`, expressed in container microseconds) and vision (Florence-2 caption, objects and
scene-text regions on up to three decoded frames, each with the decoded frame's own PTS in the video stream timebase and
the frame size). Every child repeats the parent's pin (source version and SHA-256, clock id, container start, timebase)
and is refused otherwise: `409 SOURCE_CLOCK_MISMATCH` (different clock, timebase or container start, or evidence time
outside the clock) or `409 STALE_CHILD_SOURCE_VERSION`; nothing is registered. Qwen2.5-VL then answers over the first
sampled frame with a bounded (1000-char) prompt that lists evidence ids and requires JSON claims citing only those ids.
The server validates every citation: cited ids must exist, have been offered in the prompt, and lie inside the clock and
(for boxes) the frame; uncited, unknown, un-offered or out-of-range claims are listed under `flaggedClaims` with flags
(`UNCITED`, `UNKNOWN_EVIDENCE_ID:..`, `EVIDENCE_NOT_OFFERED:..`, `EVIDENCE_OUT_OF_RANGE:..`, `MALFORMED_CITATION`) and are
never in `claims`; status is `GROUNDED | PARTIALLY_GROUNDED | UNGROUNDED | ANSWER_UNPARSEABLE`. This proves citation
integrity only, not that a claim is entailed by its evidence. A failed child is `502 GROUNDED_CHILD_FAILED` with per-child
statuses by default, or a `PARTIAL` evidence answer only with `allowPartial:true` (and `422 GROUNDED_NO_EVIDENCE` when no
vision evidence remains); a child or answerer whose outcome is unknown (sidecar lost) is `503 GROUNDED_OUTCOME_UNKNOWN`
with nothing registered, and retrying the same `requestId` resumes. Rights are re-resolved after inference and before
registration, so a revocation during the run leaves no artifact. The typed document is registered as an immutable
`application/json` artifact (`201`; replay `200`; a different request under the same `requestId`
`409 GROUNDED_REQUEST_ID_REUSED`; a retry after success replays the registered answer from the durable request ledger and
re-runs neither the evidence children nor the answering model); `GET /dev/v1/grounded-answers/{outputId}` reads the
registered document back after a restart. The Document Intelligence child is always reported `UNAVAILABLE` (no DI v1 gateway client is wired here;
on-screen text is the local Florence-2 reader, not DI). Evidence beyond the prompt budget is not citable
(`evidenceOmittedForPromptBudget`). Local open-model output: no quality, entailment, rights or production claim.

DEV_ONLY human caption correction (J-03; `MediaDevCaptionRuntime`, outside the canonical manifest/OpenAPI):
`POST /dev/v1/captions/corrections` takes `{requestId, baseArtifactId, expectedVersionId, cues:[{startMillis, endMillis,
text}]}` and registers the edited cues as a NEW immutable `text/vtt` artifact on top of one exact owner-visible caption
version (the unreviewed Whisper WebVTT from `POST /dev/v1/speech/transcriptions`, or an earlier correction). The base is
never overwritten. `201` (replay of the same requestId and cues `200`); the lineage records the exact parent version and
digest, the machine version the chain started from, `correctionNumber`, `correctedByPrincipalId` (the authenticated
caller; no body field names a principal), the source audio and the admitting rights evidence, plus a per-cue edit
summary. Optimistic concurrency: `expectedVersionId` must equal the base's current version or `409
CAPTION_VERSION_CONFLICT` (the response names the current version); each parent version has at most one child because
the child is registered under an idempotency key derived from the parent, so two correctors of the same parent collide in
the durable idempotency store (`409 CAPTION_VERSION_CONFLICT`; the same requestId with different cues is also `409`).
Rights are re-resolved for the exact source audio (`Scope.PROCESSING`) on every correction: `403
RIGHTS_DECISION_DENIED | REVOKED | STALE | MISMATCH` or `422 RIGHTS_AUTHORITY_UNAVAILABLE`, with nothing registered. Other
refusals: `404 SOURCE_VERSION_NOT_FOUND` (not the owner or unknown; no text disclosed), `403 ARTIFACT_PERMISSION_REQUIRED`,
`422 CAPTION_BASE_NOT_SUPPORTED | CAPTION_UNCHANGED | CAPTION_DRAFT_EMPTY | CAPTION_TIMING_INVALID | CAPTION_TEXT_EMPTY |
CAPTION_MARKUP_NOT_SUPPORTED | CAPTION_TEXT_INVALID | CAPTION_LIMIT_EXCEEDED` (cues are never repaired or reordered).
`GET /dev/v1/captions/{captionId}` returns the parsed cues, lineage and the review use of that exact version
(`review.acceptedByAssignedReviewer`, `establishesApproval:false`). Review of a caption uses the existing
`ARTIFACT_VERSION` review subject (owner opens a case and assigns a different reviewer; the owner cannot decide). Use in a
render: with `MEDIA_DEV_CAPTION_REVIEW_REQUIRED=true` (default false) a timeline CAPTION clip is rendered only when its
exact artifact version is a DEV_ONLY caption version with a current ACCEPT from an assigned reviewer and its source
rights are still admitted; otherwise `422 CAPTION_NOT_REVIEWED | CAPTION_RIGHTS_NOT_ADMITTED`. Recognizer worker
failures on `POST /dev/v1/speech/transcriptions` (process killed, crashed or no valid output) are `503
SPEECH_OUTCOME_UNKNOWN` (never success, nothing registered, `retrySafe:true`); retrying the same requestId registers the
outputs exactly once. A retry AFTER a completed registration (also after a restart) replays the first transcript and WebVTT
outputs (`200`, `replayed=true`) from the durable request ledger without re-running the recognizer, whatever real Whisper
would now produce under GPU contention; the same requestId for a different source version or language is `409
SPEECH_REQUEST_ID_REUSED`. A caption correction (`captions.correct` ledger lane) replays the same way, and the same
requestId with different cues is `409 CAPTION_REQUEST_ID_REUSED`.
A correction is a statement by a DEV_ONLY principal, not a verified human, a quality claim or an approval. The Explorer
page is `/dev-caption-correction.html`. Tests: `MediaDevCaptionCorrectionHttpTest`, `MediaDevCaptionJourneyIT` (real
launcher, real Whisper, faults), `MediaDevExplorerCaptionCorrectionLiveIT` (real Chromium).

DEV_ONLY retention, legal hold and erasure (J-26, `media.dev.outcome-retention-and-erasure`; `MediaDevErasureRuntime`,
`PostgresqlMediaErasureAuthority`, V039 `media_legal_holds` / `media_erasure_operations` / `media_erasure_tombstones`; enabled by
`MEDIA_DEV_ERASURE_ENABLED=true` over the canonical PostgreSQL/S3 runtime, profile `dev`). **Revoking a rights statement is not
erasure**: revocation stops new processing and replays and deletes nothing; erasure is a separate, explicit, owner-only act.
`POST /dev/v1/erasures {erasureId, artifactId, confirm:true, expectedArtifactCount?}` erases the artifact and everything derived
from it. The tree is derived from `media_artifact_lineage` and from the artifact-reference fields of the lineage metadata every
lane registers (`source`, `parent`, `sources[]`, `machineVersion`, `inputReferences[]`), for the same tenant and owning principal
only, so transcripts, WebVTT, corrected caption versions, synthesized audio, vision analyses/tracks/ROI, grounded answers,
renders/dubs and creative outputs of an erased source go with it; erasing a derived artifact removes only its own subtree.
`GET /dev/v1/erasure-plans/{artifactId}` previews that exact tree (id, kind, content type, digest, parents), the dependent records
and any blocking hold, and removes nothing. The durable order is fixed so a crash can never leave bytes reachable: (1) one
PostgreSQL transaction under the tenant mutation lock removes every metadata row of the tree (artifacts, lineage, transcript
revisions, caption registrations, delivery operations, review cases and records in the canonical and DEV_ONLY review schemas,
upload sessions, staged chunks), marks the request-ledger rows of the erased outputs `ERASED`, writes one tombstone per artifact
(id, kind, digest) and a content-free manifest; from that commit no Media read path can return the tree; (2) every S3 object in the
manifest is deleted and verified absent (an object another artifact still references is kept); (3) the host removes its local
copies (speech spool entries by audio digest, delivered files by hashed name, the delivery engine's in-memory copy of the exported
bytes, the process-local ledger, an optional tenant cache invalidation) and finalises the receipt. The operation is idempotent by
`erasureId`; a launcher that died between steps resumes every incomplete operation at start-up before it serves a request, and
the same `erasureId` resumes it too. `MEDIA_DEV_ERASURE_CRASH_AT=AFTER_DB_ERASED|AFTER_OBJECTS_ERASED` halts the JVM at that point
(DEV_ONLY fault injection for the real-process tests only). The receipt (`GET /dev/v1/erasures/{erasureId}`) lists kinds and counts
with the SHA-256 digests of the removed objects and `contentDisclosed:"none"`; it never contains content. After erasure an erased
id answers `410 ARTIFACT_ERASED` on the DEV artifact content, speech, caption, vision, grounded, creative and rights-by-artifact
reads (`404` on the canonical `/api/v1/artifacts/{id}`), and a request-ledger replay of an erased output answers
`410 OUTPUT_ERASED`: it neither replays bytes nor runs a model again under that requestId. Refusals: `404 ARTIFACT_NOT_FOUND` for a
non-owner, `409 LEGAL_HOLD_ACTIVE`, `409 ERASURE_TREE_CHANGED` (the reviewed `expectedArtifactCount` no longer matches),
`409 ERASURE_ID_REUSED`, `422 ERASURE_NOT_CONFIRMED`, `422 ERASURE_TREE_TOO_LARGE` (bound 2000), `410 ARTIFACT_ERASED`. A legal hold
(`POST /dev/v1/legal-holds {requestId, artifactId, reason}`) is owner-authorised, records the reason, the placing principal and its
identity assurance, and blocks erasure of any tree that overlaps the held tree (a hold on a derived render blocks erasing its
source; a hold on the source blocks erasing the render) until `POST /dev/v1/legal-holds/{holdId}/release {reason}` by the placing
owner, which is attributed. Expiry purge also honors holds. In production-like profiles (or with
`MEDIA_DEV_ERASURE_REQUIRE_OIDC=true`) hold, release and erase need an `OIDC_VERIFIED` principal (`403
IDENTITY_ASSURANCE_REQUIRED` otherwise, from both the route and the authority); a read-only plan stays available. Not erased by this
increment: rights attestations/consent records (an audit trail naming ids and statements, no content), processing-job rows, and
project-timeline documents (they keep artifact ids, no bytes); no all-copy claim covers backups, replicas or external providers.
The Explorer page `dev-erasure.html` (panel `DevErasurePanel` in `@audio-video/ui`) shows the tree, holds and the receipt, and
requires a checkbox plus the typed root id before it sends the erase.
DEV_ONLY durable request ledger (`MediaDevRequestLedger`, V038 `media_dev_request_ledger`; used by the speech STT/TTS,
caption correction, vision tracking/ROI and grounded-answer lanes). Local model output is not byte-reproducible, so
idempotency is not "re-run and compare bytes": the ledger is keyed by `(tenant, principal, lane, requestId)` and stores the
SHA-256 fingerprint of the canonical request (exact input artifact id/version/digest plus every parameter) and, once the lane
completes, the registered output artifact ids and versions. Each lane first validates the request and re-checks rights
(a revoked source refuses even a replay; each lane keeps its existing rights semantics), then consults the ledger BEFORE any
model runs: COMPLETED with the same fingerprint replays the registered output (`200`, artifact re-read, no model run); a
different fingerprint is the lane's `409 *_REQUEST_ID_REUSED`; IN_PROGRESS under a live lease waits up to
`MEDIA_DEV_REQUEST_LEDGER_WAIT_SECONDS` (default 20) and then answers `409 REQUEST_IN_PROGRESS`; a stale lease (the owner
crashed, outcome UNKNOWN) is taken over under a higher fencing token, and the superseded owner's late completion is refused
(a run owned by a launcher process on the same host that provably no longer exists, by pid and start time, is reclaimed at
once by a compare-and-set instead of waiting for the lease, so an immediate retry after a killed launcher works);
a run that failed with nothing registered releases the claim so a retry runs again. `503 REQUEST_LEDGER_UNAVAILABLE` and
`409 REQUEST_OUTPUT_UNAVAILABLE` (a completed request whose artifact is no longer readable) are typed refusals. Configuration:
`MEDIA_DEV_REQUEST_LEDGER=postgresql|memory|auto` (default `auto`: PostgreSQL through the canonical runtime datasource when
`MEDIA_POSTGRES_JDBC_URL` is set, otherwise a process-local ledger that is logged as non-durable), and
`MEDIA_DEV_REQUEST_LEDGER_LEASE_SECONDS` (default 900, 30-86400). Remaining limits: the lease is not renewed, so a model run
longer than the lease may be taken over (the late owner is fenced and registration stays idempotent by its upload key); a
crash between artifact registration and ledger completion leaves the row IN_PROGRESS until the lease expires and the
takeover re-runs the model, which can be refused as `409 *_REQUEST_ID_REUSED` when a nondeterministic model produced
different bytes than the already registered artifact (never a second artifact; speech synthesis is covered by its byte
cache); ledger rows are not pruned.

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
