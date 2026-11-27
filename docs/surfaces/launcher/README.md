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
- **Version-specific review (J-21, DEV_ONLY).** With `MEDIA_DEV_REVIEW_ENABLED=true` and the intake lane
  (`MEDIA_DEV_INTAKE_ENABLED=true`) an `ARTIFACT_VERSION` review follows the intake lineage: once a later version of the
  same lineage is registered, the earlier version is superseded, so its decisions read `STALE` (`DEV_ASSIGNED_REVIEWER_ACCEPT_STALE`,
  `currentness` `STALE`, `lineage.superseded=true`), a new decision on it is `409 REVIEW_SUBJECT_STALE`, and a fresh case on it is
  `409 REVIEW_SUBJECT_SUPERSEDED` (an existing case stays readable as history). An acceptance is never transferred to the new
  version: the new head starts `NOT_REVIEWED` and needs its own case, assignment and decision. Registration and decisions on the
  same lineage are serialised by one in-process lock, so an approve-versus-revise race ends in exactly one of two outcomes: the
  approval commits first (then reads `STALE`) or the revision commits first (the approval is `409 REVIEW_SUBJECT_STALE`).
  The lock is single-process only; a second launcher process would need a database-level compare-and-set (not provided, no
  migration was added). `GET /dev/v1/reviews/{caseId}/versions` (owner or assigned reviewer) and
  `GET /dev/v1/review-lineages/{lineageId}` (owner) list every version of the lineage with its review state
  (`NOT_REVIEWED`, `IN_REVIEW`, `{DECISION}_CURRENT`, `{DECISION}_STALE`, or `NOT_ASSIGNED` for a reviewer who holds no assignment on
  that version), `head`, `superseded`, `acceptedForHead` and the comment count. `GET /dev/v1/reviews` lists the cases the caller was
  assigned to. `GET /dev/v1/reviews/{caseId}/content` serves the case's exact immutable version bytes (same verification and
  `Range` support as the artifact content route, no query) to the owner or an assigned, unexpired reviewer, so a reviewer who does not own the
  artifact can play exactly what they decide on; revoked or expired reviewers get `403`. The uploader cannot decide
  (`403 REVIEWER_NOT_ASSIGNED`); a principal with no assignment or another tenant gets `404 REVIEW_CASE_NOT_FOUND`.
  **Delivery gate.** Every new or unresolved export requires a configured exact-version review authority and a case whose latest
  decision is an `ACCEPT` within the `APPROVAL` scope from an assigned reviewer, current on the lineage head. The launcher wires
  the gate whenever DEV review is configured; if it is absent, export returns `409 EXPORT_REVIEW_AUTHORITY_UNAVAILABLE` before
  operation insertion or destination write. The former `MEDIA_DEV_REVIEW_REQUIRED_FOR_DELIVERY` opt-in flag no longer disables
  this requirement. With review configured, a missing or ineligible decision returns `409 EXPORT_REVIEW_REQUIRED`,
  `EXPORT_REVIEW_SUPERSEDED`, `EXPORT_REVIEW_STALE`, `EXPORT_REVIEW_NOT_ACCEPTED` or
  `EXPORT_REVIEW_APPROVAL_SCOPE_REQUIRED`, and nothing is exported. A confirmed replay remains read-only. The gate is in addition
  to the rights gate and is never an approval (`establishesApproval=false`). Retention: erasure of a version
  (J-26) deletes its case, comments, decisions and assignments and removes it from the lineage. Erasing the head restores the previous
  version as head; its own ACCEPT is then `CURRENT` again only because it was a decision on that exact, unchanged digest, and the
  revival is never silent: the lineage read carries `headChangedBy: "ERASURE"` and `headChange` (erased version number, artifact
  version id, erasure id, `erasedAt`), the case's `lineage.headChangedBy` is set, and an export admitted on it names the erasure in
  its admission message. The removal is recorded in the erasure operation's manifest (`intakeVersions`, same transaction; no migration),
  so it survives restart. Covered by `MediaDevVersionedReviewIT.erasingTheHeadRestoresTheEarlierAcceptanceVisiblyAndSurvivesRestart`.
  An active legal hold blocks erasure and leaves the review readable.
  Not covered: a trusted human identity (every decision is a DEV_ONLY test-principal statement), multi-process atomicity, retention
  expiry by time, and the J-11/J-19 head ledgers (only the J-02 intake lineage defines "source revision" for review).
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
- J-22 signed-ACK receiver destination `dev-http-receiver` (DEV_ONLY, loopback only). Opt in with
  `MEDIA_DELIVERY_DEV_RECEIVER_URL` (bare `http://127.0.0.1:<port>`; a non-loopback host fails startup),
  `MEDIA_DELIVERY_DEV_RECEIVER_IDENTITY`, `MEDIA_DELIVERY_DEV_RECEIVER_CREDENTIAL_REFERENCE` and
  `MEDIA_DELIVERY_DEV_RECEIVER_ACK_KEY_REFERENCE` (`secret:env:NAME` references), `MEDIA_DELIVERY_DEV_RECEIVER_TENANTS`
  (comma list of permitted tenants), optional `MEDIA_DELIVERY_DEV_RECEIVER_TIMEOUT_MS` (default 15000) and
  `MEDIA_DELIVERY_DEV_DISPATCH_LEASE_MS` (1000-300000, default 300000: how long a crashed dispatcher blocks takeover).
  The directory destination becomes optional when a receiver is configured. The receiver is a separate process with
  its own storage, a revocable upload credential and an independent HMAC-SHA256 ACK key. Wire protocol:
  `PUT /v1/objects/{sha256(tenant,principal,requestId)}/parts?offset=N` (1 MiB parts, `X-Part-Sha256`,
  `X-Object-Size`, `X-Object-Sha256`, `X-Ack-Nonce`, bearer credential) answers a signed PART ack;
  `GET /v1/objects/{key}` answers a signed STATUS (`ABSENT|PARTIAL|COMPLETE` with receivedBytes and the SHA-256 the
  receiver computed over what it stored). Responses carry `X-Ack-Signature: v1=<hmac over the exact body>`; Media
  verifies it in constant time and binds identity, object key, kind, per-call nonce, offsets and, for the final
  receipt, size and checksum. `DELIVERED` is recorded only from a verified COMPLETE status whose checksum equals the
  artifact digest. Views carry `ackState` (`DELIVERED|UNKNOWN|NOT_DELIVERED`), a typed `failure`
  (`CREDENTIAL_REVOKED`, `ACK_SIGNATURE_INVALID`, `DESTINATION_IDENTITY_MISMATCH`, `CHECKSUM_MISMATCH`,
  `DESTINATION_UNREACHABLE`, `DESTINATION_REJECTED`), `destinationReceivedBytes` and `observedAt` (the observation is
  process-local, not durable: after a restart `failure` is empty until the next reconcile). Lost ACK: the export
  stays `OUTCOME_UNKNOWN`; `POST /dev/v1/exports/{requestId}/reconcile` (`media:delivery:dev:export` +
  `media:artifact:read`, body `{}` or `{"resume":bool}`) reads the receiver state. `resume:false` never sends: an
  absent object is `NOT_DELIVERED`, a partial one stays `UNKNOWN`, a complete matching one is confirmed by the
  engine with no second write; `resume:true` (also what a retry of the export does) continues from the
  receiver-verified offset, so stored parts are not resent. A registered destination that the tenant is not
  permitted to use is `403 DESTINATION_NOT_PERMITTED`; an unregistered one stays `404 DESTINATION_NOT_FOUND`
  (existing client contract). A destination whose credential is refused before any write is a terminal
  `UNAVAILABLE`/`NOT_DELIVERED` for that request id. Rights revocation mid-export stops the next part. Erasure of
  copies already delivered to an external receiver is not performed by this host. The exact-version review gate and
  second-person-confirmed `EXTERNAL_DELIVERY` attestation both apply before new or resumed delivery. A verified loopback receiver
  receipt remains DEV_ONLY and does not establish an owner-issued production destination acknowledgment.
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
| GET | `/dev/v1/reviews` | `media:project:dev:read` | `media:artifact:read` is not needed; lists the caller's assigned cases | review |
| GET | `/dev/v1/reviews/{caseId}/versions` | `media:project:dev:read` | `media:artifact:read` for an artifact subject | review + intake (owner or assigned reviewer; per-version review state) |
| GET | `/dev/v1/reviews/{caseId}/content` | `media:project:dev:read` | `media:artifact:read` | review (owner or assigned unexpired reviewer; exact immutable version bytes, `Range` supported) |
| GET | `/dev/v1/review-lineages/{lineageId}` | `media:project:dev:read` | `media:artifact:read` | review + intake (owner; per-version review state of the lineage) |
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
| GET | `/dev/v1/request-outcomes/{lane}/{requestId}` | `media:project:dev:read` | `media:artifact:read`; `lane` is one of `speech.transcribe`, `speech.synthesize`, `vision.analyze`, `vision.ask`, `vision.track`, `vision.roi` | read-only view of the caller's own durable request-ledger row (`ABSENT`/`IN_PROGRESS`/`COMPLETED`+output refs/`RELEASED`/`ERASED`); never claims or re-runs; used by the agent-tools delegation (J-25) to reconcile an ambiguous dispatch |
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
| GET | `/dev/v1/spatial/status` | `media:project:dev:read` | - | FFmpeg/FFprobe composed |
| POST | `/dev/v1/spatial/exports` | `media:project:dev:write` | `media:artifact:{read,create}`, `PROCESSING` rights admission of the exact version; the body must DECLARE `declaration.projection=EQUIRECTANGULAR` and `stereoMode=MONO` | FFmpeg/FFprobe composed |
| GET | `/dev/v1/spatial/exports/{exportId}` | `media:project:dev:read` | `media:artifact:read`, source rights re-admitted | FFmpeg/FFprobe composed |
| POST | `/dev/v1/spatial/viewports` | `media:project:dev:write` | `media:artifact:read`, source rights re-admitted | FFmpeg/FFprobe composed |
| GET | `/dev/v1/interactive-demos/status` | `media:project:dev:read` | - | FFmpeg/FFprobe composed |
| POST | `/dev/v1/interactive-demos` | `media:project:dev:write` | `media:artifact:{read,create}`, `PROCESSING` rights admission of every scene video and caption | FFmpeg/FFprobe composed |
| GET | `/dev/v1/interactive-demos/{demoId}` | `media:project:dev:read` | `media:artifact:read`, every source re-admitted | FFmpeg/FFprobe composed |
| GET | `/dev/v1/interactive-demos/{demoId}/package.zip` | `media:project:dev:read` | `media:artifact:read`, every source re-admitted | FFmpeg/FFprobe composed |
| GET | `/dev/v1/quality/status` | `media:project:dev:read` | — | FFmpeg/FFprobe composed + the shared request ledger (J-19) |
| POST | `/dev/v1/quality/optimizations` | `media:project:dev:write` | `media:artifact:{read,create}`; `PROCESSING` rights admission of the source, replays included | bounded real-encode search (J-19, `MediaDevQualityOptimizationRuntime`) |
| GET | `/dev/v1/quality/optimizations/{reportArtifactId}` | `media:project:dev:read` | `media:artifact:read` | recorded report and chosen version |
| POST | `/dev/v1/quality/optimizations/{requestId}/cancel` | `media:project:dev:write` | the running search's own principal | in-process cancellation; `404` when nothing is running |
| GET | `/dev/v1/quality/lineages/{lineageId}` | `media:project:dev:read` | `media:artifact:read` | head ledger V041; owner only |
| POST | `/dev/v1/quality/lineages/{lineageId}/undo` | `media:project:dev:write` | `media:artifact:read` | head ledger V041; no rights admission (a pointer move, not processing) |
| GET | `/dev/v1/animations/status` | `media:project:dev:read` | — | `MEDIA_DEV_RENDER_FFMPEG`/`MEDIA_DEV_RENDER_FFPROBE` + the shared request ledger |
| POST | `/dev/v1/animations/renders` | `media:project:dev:write` | `media:artifact:{read,create}`; `PROCESSING` rights admission of every image asset | FFmpeg/FFprobe composed (J-12) |
| GET | `/dev/v1/animations/renders/{renderId}` | `media:project:dev:read` | `media:artifact:read` (the render id is the manifest artifact id) | FFmpeg/FFprobe composed |
| GET | `/dev/v1/reference-scenes/status` | `media:project:dev:read` | — | templates, limits, the MODEL state (`available: false`), the rights authority; needs the shared request ledger |
| POST | `/dev/v1/reference-scenes/reference-sets` | `media:project:dev:write` | `media:artifact:{read,create}`; `PROCESSING` rights admission of every reference image | J-10 (`MediaDevReferenceSceneRuntime`): durable reference set manifest |
| GET | `/dev/v1/reference-scenes/reference-sets/{setId}` | `media:project:dev:read` | `media:artifact:read` (the set id is the manifest artifact id) | owner only |
| POST | `/dev/v1/reference-scenes/runs` | `media:project:dev:write` | `media:artifact:{read,create}`; `PROCESSING` rights admission of every USED reference on every call; `mode: MODEL` is `503 MODEL_UNAVAILABLE` | authored template composed by the animation renderer; no model, no FFmpeg |
| GET | `/dev/v1/reference-scenes/runs/{runId}` | `media:project:dev:read` | `media:artifact:read` (the run id is the manifest artifact id) | owner only |
| POST | `/dev/v1/reference-scenes/runs/{runId}/regenerations` | `media:project:dev:write` | `media:artifact:read`; rights re-checked | re-renders from the manifest and compares with the stored scenes; registers nothing |

| GET | `/dev/v1/rigs/status` | `media:project:dev:read` | — | `MEDIA_DEV_RENDER_FFMPEG`/`MEDIA_DEV_RENDER_FFPROBE` + the shared request ledger |
| POST | `/dev/v1/rigs/renders` | `media:project:dev:write` | `media:artifact:{read,create}`; `PROCESSING` rights admission of every floor-texture asset | FFmpeg/FFprobe composed (J-13) |
| GET | `/dev/v1/rigs/renders/{renderId}` | `media:project:dev:read` | `media:artifact:read` (the render id is the manifest artifact id) | FFmpeg/FFprobe composed |
| GET | `/dev/v1/masters/status` | `media:project:dev:read` | — | the shared request ledger; the master encode needs `MEDIA_DEV_RENDER_FFMPEG` (stem generation needs no tool) |
| POST | `/dev/v1/masters/stems` | `media:project:dev:write` | `media:artifact:{read,create}` | J-17 (`MediaDevMasterRuntime`): ORIGINAL procedural stem; no rights call (no third-party material) |
| GET | `/dev/v1/masters/stems/{stemId}` | `media:project:dev:read` | `media:artifact:read` | owner only |
| POST | `/dev/v1/masters` | `media:project:dev:write` | `media:artifact:{read,create}`; `PROCESSING` rights admission of every UPLOADED stem | J-17 mix and loudness master; FFmpeg composed |
| GET | `/dev/v1/masters/{masterId}` | `media:project:dev:read` | `media:artifact:read` (the master id is the report artifact id) | owner only |
| GET | `/dev/v1/live-sessions/status` | `media:project:dev:read` | — | J-29 (`MediaDevLiveSessionRuntime`): limits, open sessions, reorder-buffer bytes in use; needs `MEDIA_RIGHTS_DEV_ENABLED=true` |
| POST | `/dev/v1/live-sessions` | `media:project:dev:write` | `media:artifact:{read,create}`; `PROCESSING` or `VOICE_OR_LIKENESS_USE` admission of the consent subject artifact version | open a live session (idempotent per `requestId`) |
| GET | `/dev/v1/live-sessions/{sessionId}` | `media:project:dev:read` | `media:artifact:read` | owner only; acknowledged prefix, held frames, typed state |
| POST | `/dev/v1/live-sessions/{sessionId}/frames` | `media:project:dev:write` | `media:artifact:{read,create}` | binary frame records (may be chunked); ack = contiguous written prefix |
| POST | `/dev/v1/live-sessions/{sessionId}/eos` | `media:project:dev:write` | `media:artifact:{read,create}`; fresh consent decision | end of stream: stores WAV + PTS index (idempotent) |
| POST | `/dev/v1/live-sessions/{sessionId}/abort` | `media:project:dev:write` | `media:artifact:{read,create}` | discards everything received |
| GET | `/dev/v1/simulations/status` | `media:project:dev:read` | — | the shared request ledger; MP4 animation needs `MEDIA_DEV_RENDER_FFMPEG`/`MEDIA_DEV_RENDER_FFPROBE` |
| POST | `/dev/v1/simulations` | `media:project:dev:write` | `media:artifact:{read,create}` | J-14/J-15 (`MediaDevSimulationRuntime`); a `render.video` request also needs FFmpeg/FFprobe |
| GET | `/dev/v1/simulations/{simulationId}` | `media:project:dev:read` | `media:artifact:read` (the simulation id is the result artifact id) | — |

| GET | `/dev/v1/region-edits/status` | `media:project:dev:read` | — | `MEDIA_DEV_REGION_EDIT_ENABLED=true` + absolute `MEDIA_DEV_RENDER_FFMPEG`/`MEDIA_DEV_RENDER_FFPROBE` + the shared request ledger (J-11) |
| POST | `/dev/v1/region-edits/lineages` | `media:project:dev:write` | `media:artifact:{read,create}`; the caller owns the exact video version | names a stored video as version 1 (BASE) of a lineage (201, or 200 when the same owner names the same version again; another video or owner under the same id is `409 LINEAGE_EXISTS`) |
| GET | `/dev/v1/region-edits/lineages/{lineageId}` | `media:project:dev:read` | `media:artifact:read` | the version history, the head, `undoAvailable` (another principal or tenant: `404 LINEAGE_NOT_FOUND`) |
| POST | `/dev/v1/region-edits/lineages/{lineageId}/edits` | `media:project:dev:write` | `media:artifact:{read,create}`; `PROCESSING` rights admission of the lineage's root video on every call | tracked region edit rendered as a NEW version (V042 compare-and-set) |
| POST | `/dev/v1/region-edits/lineages/{lineageId}/undo` | `media:project:dev:write` | `media:artifact:{read,create}`; `PROCESSING` rights admission of the root video | appends a version that points at the exact artifact of the version being restored |
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
| GET | `/dev/v1/composite-renders/capabilities` | `media:project:dev:read` | `media:artifact:read` | FFmpeg composite render |
| POST | `/dev/v1/composite-renders` | `media:project:dev:write` | `media:artifact:{read,create}`; every source version needs an ADMITTED PROCESSING rights decision (403 when denied/revoked, 422 when no statement) | `MEDIA_DEV_RENDER_FFMPEG/FFPROBE`, request ledger |
| GET | `/dev/v1/composite-renders/{renderId}` | `media:project:dev:read` | `media:artifact:read` | composite render |
| POST | `/dev/v1/composite-renders/{requestId}/cancel` | `media:project:dev:write` | `media:artifact:{read,create}` | kills the running encoder; nothing is registered |
| GET | `/dev/v1/storyboards/capabilities` | `media:project:dev:read` | `media:artifact:read` | `MEDIA_DEV_STORYBOARD_ENABLED=true` |
| POST | `/dev/v1/storyboards` | `media:project:dev:write` | `media:artifact:{read,create}`; brief to version 1 (drafted placeholder scenes when `scenes` is omitted) | storyboard store (artifact + version ledger), request ledger |
| GET | `/dev/v1/storyboards/{id}` | `media:project:dev:read` | `media:artifact:read` | owner scoped (404 otherwise) |
| GET / POST | `/dev/v1/storyboards/{id}/versions` | `media:project:dev:read` / `write` | `media:artifact:{read,create}`; POST edits against `expectedVersion` (409 `STORYBOARD_VERSION_STALE`) | storyboard store |
| GET | `/dev/v1/storyboards/{id}/versions/{n}` | `media:project:dev:read` | `media:artifact:read` | storyboard store |
| GET | `/dev/v1/storyboards/{id}/readiness` | `media:project:dev:read` | `media:artifact:read` | derived per shot from live state |
| POST | `/dev/v1/storyboards/{id}/renders` | `media:project:dev:write` | `media:artifact:{read,create}`; every source needs an ADMITTED PROCESSING decision (403 `STORYBOARD_RIGHTS_DENIED`), blocked shots are 422 `STORYBOARD_NOT_RENDERABLE` | composite + animation lanes, request ledger |
| GET | `/dev/v1/storyboards/{id}/versions/{n}/render` | `media:project:dev:read` | `media:artifact:read` | composite render |
| GET / POST | `/dev/v1/storyboards/{id}/versions/{n}/review` | `media:project:dev:read` / `write` | `media:artifact:{read,create}` (POST); the case is read and decided through `/dev/v1/reviews` | `MEDIA_DEV_REVIEW_ENABLED=true` |
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

DEV_ONLY multitrack composite render (J-18, `media.dev.outcome-multitrack-finished-master`). `POST /dev/v1/composite-renders`
`{requestId, projectId, revisionId, timelineId, width, height, framesPerSecond, gapPolicy?: REFUSE|BLACK, captionMode?:
NONE|MUX|BURN|BOTH, color?: {brightness, contrast, saturation}, overlays?: [{clipId, x, y, opacity?}], audio?: [{clipId, gainDb}],
maxOutputBytes?, audioPeakPolicy?: LIMIT|REFUSE, truePeakCeilingDbtp?: [-6.0, -0.1]}` renders one exact timeline with real FFmpeg into an H.264+AAC MP4 (optional mov_text subtitle stream): VIDEO-track
clips (any fps/resolution, trimmed by source interval, conformed to the output grid, letterboxed, never retimed), AUDIO-track clips
(mono duplicated to stereo, per-clip gain, sample-exact placement, summed without normalisation; the sum is then peak-protected:
LIMIT (default) caps its 8x-oversampled true peak at `truePeakCeilingDbtp` (default -1.0) with the J-17 master limiter, leaving the
sum untouched when it is already under the ceiling; REFUSE returns 422 `COMPOSITE_AUDIO_CLIPS` with the measured peak; the pre-limit
and post-limit true peaks and the gain reduction are recorded in `lineage.composition.audioPeak`), WebVTT caption clips (muxed
and/or burned), OVERLAY-track PNG clips (explicit position/opacity), and an `eq` colour grade applied to the program video before
graphics and burned captions. A video clip's embedded audio is not used. The output is probed and refused unless frame count,
codecs, geometry, frame rate and duration match the plan. `sources[]` lineage names every exact source version (erasure follows
it); the durable request ledger gives replay (200) / `409 REQUEST_ID_REUSED`. `POST /dev/v1/composite-renders/{requestId}/cancel`
stops the encoder (`409 RENDER_CANCELLED` to the waiting caller, nothing registered). Typed 422 refusals carry `details.path`:
`TIMELINE_OVERLAP`, `TIMELINE_GAP`, `TIME_NOT_FRAME_ALIGNED`, `TRIM_OUT_OF_RANGE`, `RETIMING_NOT_SUPPORTED`,
`OVERLAY_OUT_OF_FRAME`, `OVERLAY_PLACEMENT_REQUIRED`, `CLIP_PAST_TIMELINE_END`, `CAPTION_CLIPS_OVERLAP`, `RENDER_DURATION_BUDGET`,
`RENDER_OUTPUT_BUDGET_EXCEEDED`, `RENDER_SPACE_BUDGET`, `SOURCE_FORMAT_NOT_SUPPORTED`. Budgets: `MEDIA_DEV_COMPOSITE_MAX_SECONDS`
(120), `_MAX_OUTPUT_BYTES` (64 MiB), `_MAX_SOURCE_BYTES` (128 MiB), `_SPACE_RESERVE_BYTES` (512 MiB), `_TEMP_ROOT`, `_X264_PRESET`
(medium). A launcher killed mid-render leaves an orphan work directory and encoder that the next start sweeps.

DEV_ONLY versioned storyboard and shot plan (J-09, `media.dev.outcome-brief-to-reviewed-media`; `MEDIA_DEV_STORYBOARD_ENABLED=true`
needs the DEV_ONLY project timeline and request ledger). Contract `media.dev.storyboard.v1` (owner decision of J-09: the planner in
`modules/production/timeline` is a PDP candidate over project revisions and is not used here): `{requestId, storyboardId?, brief:
{title, text}, format?: {width, height, fps} (320x240 at 25), captions?: {artifactId, artifactVersionId}, scenes?: [{sceneId, title,
narration?: {artifactId, artifactVersionId}, shots: [{shotId, durationMs, source}]}]}`. A shot `source` is exactly one of
`{kind:"ANIMATION", spec}` (a J-12 animation spec; `width`, `height`, `fps` and `frameCount` are derived and refused when authored),
`{kind:"ASSET", artifactId, artifactVersionId, sourceInMs?}` (an exact stored video version) or `{kind:"PLACEHOLDER", note?}` (never
renders). Story time is DERIVED, never authored: scenes and their shots play in array order, contiguous, so there is no overlap and no
gap; every `durationMs` (and `sourceInMs`) must be a whole number of output frames (`DURATION_NOT_FRAME_ALIGNED`, nothing is rounded).
Ceilings: 24 scenes, 12 shots per scene, 24 shots, 60 s per shot, and the composite render duration budget. Omitting `scenes` drafts one
scene with one placeholder shot per brief paragraph. Each version is an immutable `application/json` artifact appended to an owner
scoped lineage of the DEV_ONLY version ledger (durable, gapless, survives restart); an edit names the `expectedVersion` it was made
against and any other head is `409 STORYBOARD_VERSION_STALE` with nothing written (concurrent edits serialise: one wins). The durable
request ledger gives replay (200) and `409 REQUEST_ID_REUSED`; a second create of one id is `409 STORYBOARD_EXISTS`. Refusals are
typed 422 with the JSON `path` (`STORYBOARD_INVALID`, `DURATION_NOT_FRAME_ALIGNED`, `STORYBOARD_LIMIT_EXCEEDED`). `GET .../readiness`
is derived from live state on every call, per shot, with typed reasons: `RENDERER_UNAVAILABLE`, `PLACEHOLDER_NOT_RENDERABLE`,
`ASSET_UNAVAILABLE`, `ASSET_NOT_VIDEO`, `ASSET_TOO_SHORT`, `RIGHTS_DENIED` (no current statement) / `RIGHTS_REVOKED`,
`ANIMATION_RENDERER_UNAVAILABLE`, `ANIMATION_ASSET_UNAVAILABLE`, `AUTHORED_RIGHTS_DENIED|REVOKED` (the authored procedural animation
is covered only by a rights statement the OWNER records for the exact storyboard version; the host never makes it),
`NARRATION_UNAVAILABLE|NOT_AUDIO|LONGER_THAN_SCENE`, `CAPTIONS_UNAVAILABLE|NOT_VTT`, `RENDER_DURATION_BUDGET`. `POST .../renders`
`{requestId, storyboardVersion}` renders only the HEAD version (older: `409 STORYBOARD_VERSION_STALE`), refuses blocked storyboards
before any effect (403 `STORYBOARD_RIGHTS_DENIED` when a blocker is a rights decision, otherwise 422 `STORYBOARD_NOT_RENDERABLE`, both
with the per-shot `blockers`), renders animation shots with the J-12 lane (the storyboard version is the video's authored
`source`/`parent`), places shots, per-scene narration (never cut or sped up) and the caption file at their derived story times on a
project timeline and renders one H.264+AAC MP4 with the J-18 lane (`annotations` in the lineage name the storyboard version, every
shot with its frames and every source). One render per storyboard version (another request converges on it). Erasing any source
erases the render. `POST .../versions/{n}/review` opens (idempotently) the J-21 version-specific case of that exact render; the
review runtime treats the render as superseded as soon as the storyboard has a later version, so earlier decisions are STALE, new
decisions are `409 REVIEW_SUBJECT_STALE` and delivery admission is `REVIEW_SUPERSEDED`. Nothing here is an approval. Not in this
lane: cancelling a storyboard render (cancel the underlying `composite-renders/{requestId}` request) and per-shot transitions.

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

DEV_ONLY live capture sessions (J-29, `media.dev.outcome-live-session-recovery`; `MediaDevLiveSessionRuntime`,
`MediaDevLiveSessionRoutes`; composed whenever `MEDIA_RIGHTS_DEV_ENABLED=true`). Transport is plain authenticated HTTP: every request
carries the DEV_ONLY bearer token, so there is no session-level credential. `POST /dev/v1/live-sessions` takes `{requestId,
consent{artifactId, artifactVersionId, scope PROCESSING|VOICE_OR_LIKENESS_USE}, format{sampleRate 16000|24000|48000, channels 1|2,
samplesPerFrame 80-4800}, startPtsSamples, reorderWindowFrames 1-64, leaseSeconds 1-300}`; the consent subject is an exact artifact
version that carries a current statement for the scope (a second person must confirm `VOICE_OR_LIKENESS_USE`), resolved through
`MediaRightsConsentAuthority` at open, on a poll (`MEDIA_DEV_LIVE_REVOCATION_POLL_MS`, default 250) while the session is open, and
again, uncached, at end of stream. `POST .../frames` takes a binary record stream (big-endian `u64 sequence, u64 ptsSamples, u32
payloadBytes, u32 crc32(payload)`, then the PCM16LE payload; `payloadBytes` must equal `samplesPerFrame*channels*2` and
`ptsSamples` must equal `startPts + sequence*samplesPerFrame`). Frames are applied as they are read, so a request cut mid-frame keeps
the whole frames before the cut. In-order frames are written to an owner-only append-only spool; a frame ahead of the next expected
sequence by less than the window is held and drained when the gap fills, one at or beyond the window is `409
SEQUENCE_WINDOW_EXCEEDED` (never buffered); a repeated sequence is absorbed (`duplicates`) and a conflicting repeat is `409
DUPLICATE_SEQUENCE_CONFLICT`; a bad CRC, PTS or size is `422` and stores nothing. `ackedThroughSequence` is the contiguous written
prefix and is the only resume point a client needs. Held frames of all sessions share one byte budget
(`MEDIA_DEV_LIVE_GLOBAL_BUFFER_BYTES`, default 16 MiB): when it is full the frame is refused `429 BACKPRESSURE_SLOW_CONSUMER`
(`Retry-After`), and a request that cannot take the session lock within 2 s is `503 BACKPRESSURE_SLOW_CONSUMER`. `POST .../eos`
`{finalSequence}` is `409 EOS_GAP` (with the missing sequences) until every frame up to it is present, then stores a 16-bit WAV and a
`media.dev.live-pts-index.v1` JSON (every frame's sequence, exact PTS, sample count and CRC, plus the PCM and WAV digests) under
deterministic registration keys, so repeating it is idempotent (`200`, same artifacts). Terminal states are typed and final: `ABORTED`,
`EXPIRED` (the lease renews on every accepted frame, capped at 15 minutes total), `REVOKED` (consent no longer admitted: the spool is
destroyed and nothing is registered), `FAILED`, `COMPLETED`; further calls are `410 SESSION_<STATE>`. An unreachable rights authority
refuses new frames `503` without destroying the session. State lives in `MEDIA_DEV_LIVE_SESSION_DIR` (owner-only), not PostgreSQL;
after a launcher restart the spool is rescanned (a torn tail is cut), open sessions are `recovered: true` with a renewed lease and
resume from `ackedThroughSequence`, a session that was `FINALIZING` stays `FINALIZING` until end of stream is repeated, and a
session whose state is gone is `404 SESSION_NOT_FOUND` (never reported completed). Audio only; stored artifacts are for the owning
principal; no rights clearance, quality or production claim.

DEV_ONLY stems, foley, mix and loudness master (J-17, `media.dev.outcome-music-effects-master`; `MediaDevMasterRuntime`,
`MediaDevMasterSpec`, `MediaDevMasterDsp`, `MediaDevMasterRoutes`; composed with the shared durable request ledger, the master
encode needs absolute `MEDIA_DEV_RENDER_FFMPEG`). Lawful inputs only: a stem is either ORIGINAL audio Media synthesizes from a
typed spec (`POST /dev/v1/masters/stems` with `{requestId, spec{kind TONE|CHORD|DRUM|FOLEY, durationMs 50-30000, channels 1|2,
amplitudeDb -60..0, frequencyHz | frequenciesHz[] | drum KICK|SNARE|HAT | foley FOOTSTEP|WHOOSH|IMPACT, seed}}`; StrictMath and a
SplitMix64 noise generator, so identical bytes on every run and after a restart, 48 kHz PCM16; the generator spec and digest are the
recorded provenance, no model and no third-party sample) or an uploaded 48 kHz PCM16 mono/stereo WAV that carries an ADMITTED
`PROCESSING` rights statement (missing or revoked is `403 RIGHTS_NOT_ADMITTED`, re-resolved on every call, replays included). A
stem is treated as Media's own only when its recorded spec re-synthesizes to exactly its stored digest; forged metadata on an upload
buys nothing. `POST /dev/v1/masters` takes `{requestId, stems[]{artifactId,artifactVersionId,gainDb -60..12,pan -1..1,startFrame,
fadeInFrames,fadeOutFrames}, durationFrames?, target?{integratedLufs -30..-9 default -16, truePeakDbtp -6..-0.1 default -1}}`
(at most 32 placements, 60 s, uploaded stems at most 8 MiB each and 32 MiB in total; starts and fades are exact sample counts, the
pan law is `left=1-max(pan,0)`, `right=1+min(pan,0)` so a centred mono stem is duplicated exactly) and stores three artifacts: a 16-bit
stereo WAV, a lossless FLAC (re-decoded by FFmpeg and compared sample for sample before registration) and a JSON report with lineage
to every stem, the rights record and loudness measured on the exact output samples (BS.1770 K-weighted gated integrated loudness,
8x-oversampled true peak, sample peak, clipped samples, pre-limiter gain and limiter activity). Failures are typed: `422
MASTER_PARAMETERS_INVALID` with `details.path`, `422 MASTER_BUDGET_EXCEEDED`, `422 STEM_FORMAT_NOT_SUPPORTED` (more than two
channels, another sample rate, truncated frames, not a WAV), `422 MASTER_TOO_SHORT_TO_MEASURE`, `422 MASTER_STEM_PAST_END` and
`422 MASTER_LOUDNESS_TARGET_UNREACHABLE` (an abstention: silent mix, gain beyond +48 dB, or the ceiling keeps the target out of reach;
`details.reason`, `details.outcome=ABSTAINED`, nothing registered); another tenant or owner is `404 SOURCE_VERSION_NOT_FOUND`; the
same requestId with a different body is `409 MASTER_REQUEST_ID_REUSED`. Registration keys derive from the content request, so a killed
encode (`503 MASTER_OUTCOME_UNKNOWN`) or a killed launcher followed by a retry registers exactly one set of outputs. Responses are
labelled DEV_ONLY with no rights-clearance, quality, approval or production claim.

DEV_ONLY rights-checked reference scenes (J-10, `media.dev.outcome-reference-continuity`;
`MediaDevReferenceSceneRuntime`, `MediaDevReferenceSceneSpec`, `MediaDevReferenceSceneImaging`,
`MediaDevReferenceSceneRoutes`; composed with the shared durable request ledger, no FFmpeg and no model). There is NO local
generative image or video model (the local models are Whisper, Kokoro, Florence-2 and Qwen2.5-VL, which understand media),
so `mode: MODEL` is `503 MODEL_UNAVAILABLE` with `details{reason: NO_ADMITTED_GENERATIVE_MODEL, fallback: NONE,
artifactsCreated: 0}`: no rights lookup, no read, no artifact and NO silent fallback to a template. `mode: TEMPLATE` composes
authored, versioned templates (`reference-stage` v1: up to three references on a floor line; `product-spotlight` v1: one
reference in a ring) with the verified `AnimationRenderer`: each reference is decoded, area-scaled to its seeded placement,
optionally recoloured (`tint{color,strength}`), and drawn 1:1 over a palette background with optional seeded sparkles; the
seed drives per-scene drift (SplitMix64) and `push{start,end}` scales the placement across scenes. A reference set
(`POST .../reference-sets`, `{requestId, name?, references[{referenceId, artifactId, artifactVersionId}]}`) lists 1-6 exact
`image/png|jpeg` versions, each ADMITTED for `PROCESSING` when listed (`403 RIGHTS_NOT_ADMITTED` with `details.path`,
`503 RIGHTS_AUTHORITY_UNAVAILABLE`, `404 SOURCE_VERSION_NOT_FOUND` for another owner's artifact). A run
(`{requestId, mode: TEMPLATE, referenceSetId, template{id,version}, seed, sceneCount 1-8, parameters{canvas?, palette 2-6
#RRGGBB, slots[]|subject, drift?, push?, sparkles?}, continuity?}`) validates everything before any rights call (`422
REFERENCE_SCENE_SPEC_INVALID` with `details.path`; a slot naming a reference outside the set is `422 REFERENCE_NOT_IN_SET`; a
placement that does not fit the canvas is the `height` path), then re-checks `PROCESSING` for every USED reference (a replay
included: revoked is `403`), then renders. Continuity is measured on the DECODED PNGs: per placed reference the colour
histogram distance (64 bins, total variation), global luma SSIM and 64-bit difference-hash distance against the reference
scaled to its placed size (opaque pixels only), the render fidelity (maximum channel difference of the decoded crop against
the independently recoloured expectation, tolerance 2), the cross-scene histogram and hash distance of the reference crop
against scene 0, and the palette adherence of everything outside the references. A threshold failure is
`422 CONTINUITY_THRESHOLD_FAILED` with the failing metrics and nothing registered (defaults: histogram <= 0.35, SSIM >= 0.50,
hash <= 16, palette >= 0.98, cross-scene histogram <= 0.30; overridable per request). A pass registers one PNG per scene
and one manifest (template id and version, seed, canonical parameters, exact reference versions with their rights decisions,
per-scene canonical and pixel SHA-256, rectangles and metrics). The store refuses two artifacts with identical bytes, so each
stored PNG carries one `tEXt` chunk `media.reference-scene` with `requestId:index`; removing exactly that chunk gives the
canonical renderer PNG, and `POST .../runs/{runId}/regenerations` re-checks rights, re-renders from the manifest and proves
`byteIdentical` against the manifest digests and the stored bytes (artifacts created: 0). A different body under a used
`requestId` is `409 REFERENCE_SCENE_REQUEST_ID_REUSED`; the ledger replays a finished request (`200`). The Explorer page is
`/dev-reference-scenes.html`. Labelled DEV_ONLY with no quality, rights-clearance, approval or production claim.

DEV_ONLY deterministic 3D rig render (J-13, `media.dev.outcome-three-dimensional-animation`; `MediaDevRigRuntime`,
`MediaDevRigSpec`, `MediaDevRigRaster`, `MediaDevRigRoutes`; composed only when both absolute `MEDIA_DEV_RENDER_FFMPEG`
and `MEDIA_DEV_RENDER_FFPROBE` are set, with the shared durable request ledger). `POST /dev/v1/rigs/renders` takes
`{requestId, spec, encoder?{crf 10-30, default 14}}` where `spec` is `media.dev.rig-render-spec.v1`: `width`/`height`
(even, 64-960 x 64-540), opaque `background`, `fps{numerator,denominator}` (1-60), `frameCount` (1-240, at most 33,554,432
total pixels), a required `coordinateFrame{handedness: RIGHT_HANDED, upAxis: Y, unit: METRE}` (anything else is
`422 COORDINATE_PROFILE_UNSUPPORTED`), a perspective `camera{position, lookAt, verticalFovDegrees, near, far}` (looks
along its local -Z, +Y up), `bones[]` (at most 16: `id`, `parent` or null, `restPosition`, optional `restRotation{axis,
degrees}`, `tip` (the capsule's far end in the bone's local frame), `radius`, `color`, `maxDeviationDegrees` (a ball-joint
limit on the angular deviation from rest), `keyframes[]` of `{frame, rotation{axis,degrees} (a delta from rest), position?}`,
at most 64), an `endEffector{bone, offset, markerRadius, color}` and an optional textured `floor{y, halfExtent, tiles,
colorA, colorB, textureAssetId?}` with `assets[]` (`{id,artifactId,artifactVersionId}` exact `image/png`/`image/jpeg`
versions). Keyframe times are frame indices, i.e. the exact rationals `frame*fpsDen/fpsNum` seconds. The verified
`SpatialRigEngine` solves forward kinematics and enforces the joint limits (keyframe values and the shortest-arc
interpolation between them); frames come from a deterministic CPU software rasterizer (z-buffer, near-plane-clipped
flat-shaded floor triangles, ray-cast capsules, an overlay disc at the exactly projected end effector; no GPU, no external
renderer). Unknown fields and wrong types are `422 RIG_SPEC_INVALID` with `details.path`; a rotation beyond a limit is
`422 JOINT_LIMIT_EXCEEDED` (`details{path,bone,limitDegrees,requestedDegrees,frame}`, path e.g.
`$.bones[1].keyframes[2].rotation`, or `$.bones[0].keyframes` when only the interpolation between two keys leaves the
limit); a ceiling is `422 RIG_BUDGET_EXCEEDED`; `422 END_EFFECTOR_NOT_VISIBLE` when the marker would leave the image; all
before any lookup, rights call, permit or process. A floor texture must be visible to the caller (`404
SOURCE_VERSION_NOT_FOUND`) and ADMITTED for `PROCESSING` on every call, a replay included (`403 RIGHTS_NOT_ADMITTED`,
`503 RIGHTS_AUTHORITY_UNAVAILABLE`). The procedural rig itself is the authored source version
`authored-rig-spec@sha256:<spec digest>` in the GLB (no rights statement, no approval). Three NEW immutable artifacts are
registered per render with lineage: the MP4 (`video/mp4`, H.264 yuv420p bt709, exact PTS ticks), the GLB 2.0
(`model/gltf-binary`, node TRS rest pose + LINEAR translation/rotation channels, float32 approximation, coordinate
declaration in `extras.mediaSpatial`; bound to the request id) and a manifest (`application/json`: per-frame exact PTS,
pre-encode RGB24 digest, joint angles, bone world transforms, end-effector world position and projected pixel, per-frame
PSNR of the full FFmpeg decode against the pre-encode frame, gated at 20 dB; the camera, the coordinate frame, encoder and
verification). The MP4 is re-probed (codec, geometry, exact frame count, rational frame rate, time base, per-frame PTS) and
the GLB's embedded frame is read back before anything is registered. The same requestId and body replays (200); another
body is `409 RIG_REQUEST_ID_REUSED`; a killed encoder is `503 RIG_OUTCOME_UNKNOWN` with nothing registered, and a retry (also
after a launcher restart) registers exactly one video, one GLB and one manifest. `GET /dev/v1/rigs/renders/{renderId}`
reopens a render owner-scoped; the MP4 and the GLB are read through `GET /dev/v1/artifacts/{id}/content`. Outputs are labelled DEV_ONLY
with no quality, rights-clearance, approval or production claim.

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

DEV_ONLY scientific simulation (J-14 `media.dev.outcome-scientific-simulation` and J-15
`media.dev.outcome-validated-simulation-pass`; `MediaDevSimulationRuntime`, `MediaDevSimulationRoutes`,
`MediaDevSimulationPlot` over the `production/simulation` `scenario` package: `Scenario`, `ScenarioUnits`,
`ScenarioSolver`; always composed with the shared durable request ledger, the MP4 animation only when both absolute
`MEDIA_DEV_RENDER_FFMPEG` and `MEDIA_DEV_RENDER_FFPROBE` are set). `POST /dev/v1/simulations` takes `{requestId, scenario}`
where `scenario` is `media.dev.simulation-scenario.v1`: `model` (`NEWTON_CONSTANT_FORCE{mass,force}`,
`DAMPED_SPRING{mass,springConstant,damping,equilibrium?}`, `PROJECTILE{mass,gravity?,drag{law NONE|LINEAR|QUADRATIC,
coefficient}}`), `initial` (`{position,velocity}` or, for the projectile, `{x,y,speed,angle}`), `solver` (`duration`,
`maxStep`, `minStep`, `positionTolerance`, `velocityTolerance`, `maxAcceptedSteps` at most 10,000, `maxIterations` at most
100,000, `mode` `ADAPTIVE`|`FIXED_STEP`, `terminateOnGroundImpact`), optional `constraints[]` (`{id, observable
POSITION_X|POSITION_Y|VELOCITY_X|VELOCITY_Y|SPEED|TOTAL_ENERGY|TIME, aggregate FINAL|MAX|MIN, op LE|GE, limit}` at most 16),
`validation.energyRelativeTolerance` (default 1e-6) and `render{plot (default true), video (default false)}`. Every quantity is
`{value, unit}`; the unit is checked against the dimension its field requires (mass, length, time, velocity, acceleration,
force, spring constant, linear damping `kg/s`, quadratic drag `kg/m`, energy, angle; `GET .../status` lists every symbol with
its dimension) and converted to SI at the boundary, so `2000 g`, `6000 mN`, `2000 ms` is the same scenario as `2 kg`, `6 N`,
`2 s` and the same requestId replays it. A scenario that cannot be run is `422` with `details.path` before any solver step,
permit, ledger row or artifact: `SIMULATION_UNIT_MISMATCH` (`details{path,expected,received,unit}`),
`SIMULATION_NON_FINITE_INPUT` (a literal such as `1e999`, or a value that overflows or underflows the SI conversion),
`SIMULATION_BUDGET_EXCEEDED` (`details{path,limit,ceiling,requested}`) and `SIMULATION_SCENARIO_INVALID` (unknown field, wrong
type, non-positive mass or spring constant, negative damping or drag coefficient, magnitude over 1e12 SI units). The solver is
classical fourth-order Runge-Kutta with Richardson step doubling as the local error estimate (adaptive step to the declared
tolerances, or a fixed step that still measures and enforces the estimate), plus ground-impact refinement (bisection inside
the step) for the projectile. A solved scenario is `201` (`200 replayed:true`) with `outcome` `COMPLETED` or `ABSTAINED`.
`COMPLETED` carries the unit-labelled SI trace, the final observables, the verification (accepted steps, iterations, largest
error ratio, step range, termination, the energy law and its measured drift against the tolerance, the model domain, each
declared constraint with its observed value) and the pixel transform of the plot; energy must be conserved for a
conservative model and non-increasing for a dissipative one. `ABSTAINED` is the J-15 outcome for a pass that cannot be
trusted and carries typed `reasons[{code,path,message,details}]` and honest solver counters but NO trace, observable or plot,
also in the stored bytes: `STEP_BUDGET_EXHAUSTED`, `NON_CONVERGENCE` (the tolerances need a step below `minStep`),
`DIVERGED` (non-finite, or any state beyond 1e12 SI units), `OUT_OF_MODEL_DOMAIN` (speed over 10 % of c, or over the speed of
sound with a drag law), `ERROR_ESTIMATE_EXCEEDS_TOLERANCE` (fixed step), `ENERGY_NOT_CONSERVED`, `ENERGY_INCREASED` and
`CONSTRAINT_VIOLATED` (whose `details` carry the declared limit and the observed value; constraints are evaluated at the
accepted solver samples). The result is registered as an `application/json` artifact (`media.dev.simulation-result.v1`) with
lineage (`scenarioSha256`, solver id/version/mode, `evidenceClass` `SIMULATED_MODEL_OUTPUT_NOT_MEASUREMENT_EVIDENCE`,
`productionEligible:false`, siblings); a `COMPLETED` pass also registers a 800x400 `image/png` plot (two panels, no text;
the plot description gives each panel's pixel rectangle and data range) and, with `render.video`, a verified 48-frame 24 fps
H.264 `video/mp4` animation (ffprobe checks codec, pixel format, geometry, frame count and rate before registration). The
request id is embedded in the PNG and MP4 metadata so two requests never share bytes. The same requestId and scenario
(in any equivalent units) replays the stored output from the ledger without running the solver; a different scenario is
`409 SIMULATION_REQUEST_ID_REUSED`; a process killed mid-encode is `503 SIMULATION_OUTCOME_UNKNOWN` with no result
registered (the plot of that run may already exist and is reused by the retry, which registers each artifact exactly once,
also after a launcher restart). `GET /dev/v1/simulations/{id}` reopens a result in the caller's tenant and owner scope only
(`404 SIMULATION_NOT_FOUND` otherwise). Uncertainty is NOT propagated by this lane (stated, never zero-filled). Everything is
simulated model output; nothing is a measurement and nothing claims rights, approval, quality or production eligibility.

DEV_ONLY bounded quality optimization with a measured report and a reversible head (J-19,
`media.dev.outcome-bounded-quality-improvement`; `MediaDevQualityOptimizationRuntime`, `MediaDevQualitySearch`,
`MediaDevQualityRoutes`, head ledger `MediaHeadLedgerContracts` over migration V041 `media_dev_head_events`; composed only
when the J-08 video lane is, with the shared durable request ledger, and durable exactly when that ledger is). `POST
/dev/v1/quality/optimizations` takes `{requestId, lineageId, artifactId, artifactVersionId, target, search?}` for ONE exact
owner-visible `video/*` version. `target` is `{type:"MIN_BYTES_AT_QUALITY", metric:"ssim"|"psnr", minQuality}` (smallest
file that stays at or above a measured quality; SSIM 0.5-0.9999, PSNR 20-80 dB) or `{type:"MAX_QUALITY_UNDER_BYTES",
metric, maxBytes}` (best quality within 4 KiB to 256 MiB). `search` is `{crfMin 12-45 (default 16), crfMax 12-45 (default
40), maxAttempts 1-8 (default 6)}`. Any out-of-range value, unknown target type or malformed id is `422
QUALITY_PARAMETER_OUT_OF_RANGE` with `details.parameter` before any source lookup, rights call or process; unknown fields
are `400`. The search is a deterministic bisection over the integer CRF range (`MediaDevQualitySearch`): every attempt is a
real FFmpeg libx264 encode of the source (`-preset medium`, `yuv420p`, `-threads 1`, `-fflags +bitexact`, audio copied
bit for bit, source PTS passed through, no shell, absolute path, empty environment), re-probed (frame count, geometry and
every presentation instant must equal the source, else `422 OPTIMIZATION_TIMELINE_MISMATCH`), decoded and measured against
the decoded source with the same independent Java luma PSNR (global, `10*log10(255^2/mean MSE)`) and mean SSIM as J-08 (not
FFmpeg's filters). The chosen attempt is always one that was measured and satisfied the target: `MIN_BYTES_AT_QUALITY`
requires quality at or above the threshold and a file smaller than the source and picks the fewest bytes (then the lowest
CRF); `MAX_QUALITY_UNDER_BYTES` requires bytes within the budget and picks the highest quality (then fewest bytes, then
lowest CRF). The report (`media.dev.quality-optimization-report.v1`, an `application/json` artifact) lists every attempt
(CRF, bytes, size ratio, output SHA-256, mean/global/min PSNR, mean/min SSIM, identical frames, verdict), the stop reason
(`RANGE_EXHAUSTED`, or `ATTEMPT_BUDGET_EXHAUSTED`, so a budget-limited result is not claimed to be an optimum), the outcome
and the chosen attempt. It contains no timestamps, request id or lineage id, so identical inputs give byte-identical
report and chosen-video bytes across runs and across a launcher restart. Outcome `SELECTED` (`201`, or `200 replayed:true`):
the chosen attempt is registered as a NEW immutable `video/mp4` artifact (source untouched, no rights attestation of its own,
so processing it again needs its own statement) and an `APPLY` event moves the lineage head to it (a first use of the lineage
also records a `BASE` event for the source; a lineage whose head is not the named source is `409 LINEAGE_HEAD_MOVED`
with the real head). Outcome `ABSTAINED` (`201`): no attempt met the target inside the bounds; the report is registered with
`abstainReason: NO_ATTEMPT_MET_TARGET`, nothing is chosen or versioned and no head moves. The source must resolve ADMITTED for
`PROCESSING` on every call, a replay included (`403 RIGHTS_DENIED|RIGHTS_REVOKED`, `503 RIGHTS_AUTHORITY_UNAVAILABLE`); another
principal or tenant sees `404 SOURCE_VERSION_NOT_FOUND`. The same requestId and body replays from the request ledger without
encoding; a different body is `409 QUALITY_REQUEST_ID_REUSED`; a concurrent duplicate waits and replays or is
`409 REQUEST_IN_PROGRESS`; a killed FFmpeg is `503 OPTIMIZATION_OUTCOME_UNKNOWN` with nothing registered and a retry registers
exactly once. `POST .../optimizations/{requestId}/cancel` stops a search running in this process for the caller (the FFmpeg
child is killed): the original call answers `409 OPTIMIZATION_CANCELLED`, nothing is registered, the head does not move and the
requestId is free to retry; once registration has begun it answers `409 OPTIMIZATION_PAST_CANCELLATION_POINT`. `POST
.../lineages/{lineageId}/undo` takes `{requestId, expectedHeadArtifactVersionId}` and appends an `UNDO` event so the previous
head (the very same artifact id and version, never a copy) is the head again; a stale expectation is `409
LINEAGE_HEAD_MOVED`, undoing the base is `409 NOTHING_TO_UNDO`, a version that is no longer readable is `409
HEAD_VERSION_UNAVAILABLE`, and the same requestId replays. The head log is append-only, owner scoped, never a rights
authority, and a lineage whose events name an erased artifact is dropped in the erasure transaction. Measured luma only: no
perceptual, rights, approval or production claim.

DEV_ONLY tracked region edit with exact version compare-and-set and undo (J-11, `media.dev.outcome-reversible-tracked-edit`;
`MediaDevRegionEditRuntime`, `MediaDevRegionMask`, `MediaDevRegionPixels`, `MediaDevRegionEditRoutes`; composed only when
`MEDIA_DEV_REGION_EDIT_ENABLED=true` with profile dev, the DEV identity, an absolute executable FFmpeg/FFprobe pair and the
shared request ledger; the history is PostgreSQL (V042 `media_dev_region_edit_versions`) when the canonical datasource is
configured, else a process-local non-durable ledger that is logged). `POST .../edits` takes
`{requestId, baseVersion, track{artifactId, artifactVersionId, trackId}, effect{type: BLUR(radius 1-32, default 8) |
PIXELATE(blockSize even 2-64, default 16) | FILL(color #RRGGBB, default #000000)}, paddingPx? (0-64, default 4), holdEnds?
(false), maxDriftPx? (0.5-500), encoder?{crf 0-30, default 0}}`; `baseVersion` is the head the caller last saw. The track
must be a `LOCAL_VISION_TRACKS` artifact that THIS launcher produced for THIS principal: the durable `vision.track` request
ledger row of its requestId must be COMPLETED and name exactly that artifact version (an uploaded JSON that merely claims to
be a track is `422 TRACK_PROVENANCE_UNVERIFIED`); it must have been computed on the lineage's original video
(`TRACK_SOURCE_MISMATCH`) and agree with the video's own frame timeline (geometry, time base, every sampled frame's PTS:
`TRACK_TIMELINE_MISMATCH`). The per-frame mask is the observed box interpolated LINEARLY IN PTS (not frame index, so
variable frame rate is exact) between observations, padded and snapped outward to even pixel coordinates; frames outside the
observed span are not edited unless `holdEnds`. The manifest reports the tracker's own drift (leave-one-out interpolation
error: max/mean centre error px, min IoU, largest gap) and `maxDriftPx` refuses a track whose max error is larger
(`TRACK_DRIFT_EXCEEDED`). Rendering decodes every frame to raw `yuv420p` (sources must have exactly one video stream,
`yuv420p`, even geometry, at most 600 frames and 1280x720 pixels; audio is not supported), applies the effect only inside
the mask and encodes with FFmpeg libx264 (`-qp 0` lossless for crf 0, High 4:4:4 Predictive profile; lossy crf otherwise),
single threaded and bit-exact, with a generated `setpts` table so EVERY frame's source PTS is restored exactly. Before
registration the output is re-probed (codec, pixel format, geometry, time base, frame count, every PTS) and decoded again
beside the source: for a lossless edit every sample outside the masks must be bit-identical, for a lossy edit the outside
PSNR must be at least 30 dB, and the inside must have changed (`REGION_EDIT_NO_VISIBLE_CHANGE` otherwise); the measured
numbers are in the manifest. Two NEW artifacts are registered per edit (the `video/mp4` and the
`media.dev.region-edit-manifest.v1` JSON with the per-frame masks); the source bytes never change. An edit against a head that
moved is `409 STALE_BASE_VERSION` with `details{expectedVersion, headVersion}`; of two concurrent editors of one head exactly
one appends (the loser's rendered artifacts stay registered but are not referenced by the lineage). `POST .../undo`
(`{requestId, baseVersion}`) appends an UNDO version whose artifact is the exact artifact of the version restored (same bytes,
digest and metadata), one edit at a time; at the original video it is `409 NOTHING_TO_UNDO`. Rights: the lineage's root video
must resolve ADMITTED for PROCESSING on every edit and undo, a replay included (`403 RIGHTS_DECISION_DENIED|REVOKED`; reads
stay available). The request ledger (`region.edit`, `region.undo`) makes a retry exactly-once: same body replays (`200`),
a different body under the same requestId is `409 REGION_EDIT_REQUEST_ID_REUSED`, an FFmpeg process killed or timed out is
`503 REGION_EDIT_OUTCOME_UNKNOWN` with nothing registered, and a retry after a launcher kill mid-render registers exactly
once. The mask follows the detector's boxes, not ground truth; no quality, rights, approval or production claim.

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
`MEDIA_DEV_REQUEST_LEDGER_LEASE_SECONDS` (default 900, 30-86400), and `MEDIA_DEV_REQUEST_LEDGER_RETENTION_DAYS` (default 30,
integer 1-3650; a malformed value fails startup). Terminal rows (COMPLETED, RELEASED) last updated more than the retention
ago are pruned by one daemon thread about one minute after start and then hourly, at most 500 rows per pass; IN_PROGRESS
rows are never pruned, and ERASED rows are kept permanently so an erased output is never produced again. After a row is
pruned, a retry with the same `requestId` is a NEW request: the model runs again and the fingerprint is not compared with
the old run (a different request under that id is accepted, not `409`). Registered artifacts are never deleted by pruning;
a retry that reproduces the identical bytes replays the existing artifact through the upload idempotency key while the
upload store still holds that record, and different bytes are refused by that key (no second artifact). Remaining limits: the lease is not renewed, so a model run
longer than the lease may be taken over (the late owner is fenced and registration stays idempotent by its upload key); a
crash between artifact registration and ledger completion leaves the row IN_PROGRESS until the lease expires and the
takeover re-runs the model, which can be refused as `409 *_REQUEST_ID_REUSED` when a nondeterministic model produced
different bytes than the already registered artifact (never a second artifact; speech synthesis is covered by its byte
cache); ledger rows are not pruned.

**DEV_ONLY real TRANSCODE provider and restart reconciliation (J-20).** When profile `dev` has `MEDIA_DEV_FFMPEG_JOB_SPOOL`
(absolute directory) plus absolute `MEDIA_DEV_RENDER_FFMPEG`/`MEDIA_DEV_RENDER_FFPROBE`, the launcher also registers the LOCAL,
non-production provider `local-ffmpeg-transcode` for canonical `TRANSCODE` jobs (select it with `providerHint`; it never
wins a hint-less job). It decodes the exact source bytes with FFmpeg and writes a FLAC or WAV file
(`parameters`: `container` flac|wav, `sampleRateHz` 8000-48000, `channels` 1-2; anything else is refused before an attempt
is dispatched). The effect is committed atomically in the spool (`begin.json`, then `out.bin`, then `receipt.json`); the
output digest is in the job result. A job is cancellable until the commit (`CONFIRMED` once FFmpeg is stopped and the
partial discarded); after the commit a cancel is `REQUESTED_UNCONFIRMED` and the definitive success finalizes the job.
After a launcher crash the job stays `RUNNING` (its owner lease is `MEDIA_JOB_TIMEOUT_MS` + 30 s) until the recovery pass
(every 30 s) finds the expired lease; a provider that declares `reconcilesExpiredAttempts()` is then asked read-only about
its exact attempt: a receipt whose output digest re-verifies completes the job (`providerOutcome SUCCEEDED`, never re-run);
a dead owner with no receipt proves `NO_EFFECT_PROVEN` and fails the job `RESTART_NO_EFFECT_PROVEN`; a live or unprovable
owner, a missing provider, or any doubt records `OUTCOME_UNKNOWN`, which is terminal and never rewritten. The finalization
is one PostgreSQL transaction (`resolveExpiredAttempt`: attempt finality, job state, lifecycle outbox). Invalid transcode
parameters are refused with HTTP 400 `INVALID_REQUEST` at submission, before the job, attempt or spool directory exists
(the provider's opt-in `validateSubmission` hook; other providers are unaffected). Nothing is served from the spool (no
download route). **Spool retention:** `MEDIA_DEV_FFMPEG_JOB_SPOOL_RETENTION_DAYS` (integer 1-3650, default `7`; malformed
values fail startup) sets how long an attempt directory is kept. At startup and on every recovery pass (every 30 s) the
launcher examines at most 256 directories and removes one only when all hold: its marker identifies the attempt and the
directory name matches that identity; its job is terminal (`COMPLETED`, `FAILED` or `CANCELLED`) in the job store, so a
committed receipt that a restart still has to reconcile is never removed; no attempt for that job is active in this
process; and the directory has not changed within the retention window. Anything unidentifiable, non-terminal or recent is
kept. `MEDIA_DEV_FFMPEG_JOB_FAULT_GATE_DIR` is a test-only fault-injection hook that pauses a run at `before-effect`,
`after-ffmpeg` or `after-commit`.

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
| `MediaDevDeliveryRuntime` / `MediaDevDeliveryRoutes` | DEV_ONLY hosted export to a read-back local directory destination or a signed-ACK loopback receiver (`MediaDevHttpReceiverDestination`, `MediaDevDestinationRouter`) over `MediaDeliveryEngine` |
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

**First-use journey proof (J-01).** `MediaDevOidcFirstUseJourneyIT` signs a first-time user in through a real Keycloak
(authorization code + PKCE in Chromium, Explorer page `/dev-project-timeline.html`), creates the workspace-scoped project
and a first timeline/scene revision, restarts the launcher process and reopens the exact head. Tenants are Keycloak
groups mapped to the `media_tenant` claim (`MEDIA_OIDC_TENANT_CLAIM=media_tenant`; a list claim is accepted only with
exactly one entry, so no group or two groups is a 401). Fault suite with genuine tokens: other tenant 404 without
disclosure (the `X-Tenant-Id` header cannot choose), colleague 403/404, same request id replays (200, `createdNow:false`)
and a different payload is 409, expired/tampered/bad-signature/other-audience tokens 401, a user removed from the tenant
group is refused on the next token (an already-issued token lives until `exp`, 5 minutes), sign-out drops the in-memory
token. Realm and run instructions: `deploy/keycloak/README.md` ("TEST realm").

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

Signed-ACK destination, lost-ACK reconciliation and Explorer delivery page (J-22; Docker, real launcher, independent receiver):

```bash
./gradlew :services:media:integration-tests:test \
  --tests 'com.ghatana.media.integration.MediaDevDeliveryAckIT' \
  --tests 'com.ghatana.media.integration.MediaDevExplorerDeliveryLiveIT'
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

### 360 export, viewer and sandboxed interactive demonstrations (J-28, DEV_ONLY)

`POST /dev/v1/spatial/exports` `{requestId, artifactId, artifactVersionId, declaration{projection:"EQUIRECTANGULAR",
stereoMode:"MONO", initialView?{yawDegrees,pitchDegrees,rollDegrees}}}` stream-copies a stored video into an MP4 and
writes Spherical Video V2 `st3d` + `sv3d` (FFmpeg cannot set this side data, so the boxes are inserted into the container
FFmpeg wrote) ONLY when the user declared the source and its geometry agrees: exactly 2:1, no display rotation, no spherical
or stereo metadata already present. No declaration is `422 SPHERICAL_DECLARATION_REQUIRED` (path `declaration`); another
projection or stereo mode `422 PROJECTION_NOT_SUPPORTED|STEREO_MODE_NOT_SUPPORTED`; a source that cannot be
equirectangular `422 SOURCE_NOT_EQUIRECTANGULAR`; an existing spatial box `422 SOURCE_ALREADY_HAS_SPATIAL_METADATA`; a codec
MP4 cannot copy `422 SOURCE_CODEC_NOT_MP4_COPYABLE`. Before registration the output is re-probed: every frame PTS equals the
source's, the video packets hash identically, it decodes, and ffprobe plus an independent box read return exactly the
declared side data. The projection bounds are the full sphere; the only declared pose is `initialView` (default 0/0/0).
`POST /dev/v1/spatial/viewports` `{artifactId, artifactVersionId, frameIndex, yawDegrees, pitchDegrees, fovDegrees?,
width?, height?}` behaves as a viewer of an EXPORTED file: it reads the projection from the file (a file without it is
`422 NO_SPHERICAL_METADATA`, a non-export `422 NOT_A_SPATIAL_EXPORT`), renders one decoded frame through `v360` and returns the
PNG (base64), the source pixel the direction maps to (yaw 0 = frame centre, + right; pitch 0 = frame centre, + up) and the
frame's PTS. Rights, tenancy and the ledger behave as in the other DEV lanes (`403`, `404`, replay `200`, id reuse `409`).

`POST /dev/v1/interactive-demos` `{requestId, title, startNodeId, sourceTruth{kind:"CURATED"|"LIVE", curationNote?},
nodes[{id,label,video{artifactId,artifactVersionId},captions?{artifactId,artifactVersionId,language},choices[{id,label,to}]}]}`
registers one package artifact (a JSON bundle; `GET .../package.zip` serves the deterministic ZIP). The graph is checked
first (`422` with the JSON path: `EDGE_DANGLING`, `NODE_UNREACHABLE`, `GRAPH_CYCLE_WITHOUT_EXIT`, `LABEL_BLANK`,
`NODE_ID_DUPLICATE`, `START_NODE_UNKNOWN`, ...); then each source version (`404` with the path) and its `PROCESSING`
admission (`403` with the path); a caption whose lineage names another video version is `422 CAPTION_VERSION_MISMATCH`.
`LIVE` is accepted only when every scene video is an output registered by this runtime (else `422 SOURCE_TRUTH_NOT_LIVE`);
`CURATED` needs a curation note. The ZIP holds `index.html` (meta Content-Security-Policy `default-src 'none'; script-src
'self'; media-src blob:; connect-src 'self'`, no inline script), a vanilla `player.js`, `player.css`, `manifest.json`
and content-addressed `assets/<sha256>.<ext>` / `captions/<sha256>.vtt`. The player verifies each digest before a scene can
play and refuses a changed asset (`ASSET_DIGEST_MISMATCH`), changed captions (`CAPTION_DIGEST_MISMATCH`), captions bound to
another video (`CAPTION_VERSION_MISMATCH`) and an off-package path (`ASSET_PATH_INVALID`) with a visible `role=alert`.
Serve it from its own origin; send the same policy as a header where the host can.
