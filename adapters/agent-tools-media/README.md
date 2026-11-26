# Media Agent Tools adapter

This module binds Media tool calls to Media handlers. `MediaToolExecutionBinder`
requires an atomic, durable invocation claim before dispatch. Its default interface methods remain fail-closed. `FileInvocationLedger` now
provides a single-host durable UNKNOWN claim/complete implementation with
exclusive hard-link claim, lock-serialized CAS completion and restart readback.
Terminal completion first persists a per-invocation `.completion-pending`
marker; replay remains `UNKNOWN` until the terminal record and marker removal
are both directory-synced. If that final sync fails, a restarted ledger keeps
the invocation fenced instead of exposing a potentially non-durable terminal
result.
Construction requires a host-injected AES key, a positive result-retention
duration and a clock; this adapter does not generate or persist keys. Terminal
result JSON is AES-GCM encrypted with invocation and request identity
authenticated as additional data. Expiry purges the result and actor/request
metadata, retaining only an opaque file-key tombstone so expiration never
enables another dispatch. It
accepts only a current-user-owned POSIX directory with mode `0700`, rejects
symlinked directories and record/lock entries, and creates ledger files with
mode `0600`. The host must protect the key and supply a fresh authenticated
principal plus an authorization decision for result replay. The old binder
constructor denies replay by default; envelope caller/tenant fields are not
credentials. This remains a single-host development store and does not
establish provider dispatch admission. Do not use unsafe legacy record upserts.

The four handler adapters validate inputs and, by default, return typed
`NOT_ADMITTED` results before provider dispatch. A host may instead construct
`AudioVideoToolHandlerFactory(binder, MediaLauncherDelegate)` (J-25): each tool
then delegates, as the host-authenticated USER and under that user's explicit,
scoped, revocable `MediaDelegationGrant`, to a real Media launcher operation over
the launcher's own HTTP routes (so the launcher's permission, tenant and
rights/consent gates decide exactly as for the user; there is no service
super-user and no provider bypass). Mapping, chosen as the closest match that
exists and runs on CPU: `av.speech-to-text` to `POST /dev/v1/speech/transcriptions`
(local Whisper, `PROCESSING` rights admission of the exact version),
`av.text-to-speech` to `POST /dev/v1/speech/syntheses` (Kokoro stock voice, WAV
artifact; MP3/other encodings, pitch, `storeAsArtifact=false` and a source
artifact stay typed refusals), `av.vision-analysis` to `POST /dev/v1/vision/analyses`
(Florence-2 `detect`/`ocr`/`caption`; face detection, custom models and inline
bytes stay refused). PXD-238 binds `av.multimodal-inference` to the canonical
cross-modal analysis operation; the current handler validates its exact
`input1`/`input2` contract, then returns `MULTIMODAL_NOT_ADMITTED` before
dispatch. A structural canonical request mapper is unit-tested, but owner-backed
reference/profile/rights resolution and canonical runtime submit/result readback
remain unavailable. It does not route to the vision-only `/dev/v1/vision/tracks`
operation or accept legacy modality toggles.
The grant is re-read on every dispatch, replay and reconciliation, and revoking it
also stops a recorded result from being replayed. The launcher request id is
derived from the durable invocation id, so the launcher's own request ledger makes
a repeated dispatch one effect. An ambiguous dispatch (killed host, lost
response) is reconciled by `MediaToolExecutionBinder.AmbiguousInvocationReconciler`
through the launcher's read-only `GET /dev/v1/request-outcomes/{lane}/{requestId}`:
only a launcher-recorded `COMPLETED` request is fetched (replayed, never re-run)
and recorded; `IN_PROGRESS`/`ABSENT` stay `OUTCOME_UNKNOWN`; `RELEASED` becomes a
typed no-effect failure. `FileMediaDelegationGrantStore` is a single-host
development stand-in for the Action Plane delegation registry and holds no
credential; the bearer credential comes from a host-owned `CredentialSource`.
Compatibility constructor
delegates are ignored. The Data Cloud artifact entry in the shared capability
descriptor is read-model metadata only; it is not a Media handler or an
authenticated execution grant.

Any future shared or multi-host ledger implementation must enforce tenant and
authenticated principal access on reads and writes, protect stored results
according to data classification with appropriate encryption and retention,
and perform fresh authorization before returning a replayed result. Java compatibility
constructors on `LogicalAction` support local call-site compatibility only;
they do not prove compatibility or migration of serialized ledger records.
The binder's `InvocationReplayAuthorizer` is the authentication/authorization
boundary; only the host can supply a principal obtained from its authenticated
request context. The file store encrypts all terminal result bodies uniformly;
serialized request identity and terminal outcome metadata remain visible in
the owner-only directory. The host owns key custody and decides whether the
caller-agent identity is authorized for the authenticated principal. Do not
expose this store to untrusted or multi-tenant callers without that host
boundary. Multi-process hosting still requires a separate transactional CAS
implementation through a declared public port; none is currently required.
`LogicalAction.toString()` intentionally reports only outcome and presence
markers so result payloads and request identity do not enter routine diagnostics.

Directory synchronization is part of the claim/completion acknowledgement:
each newly created path component is synced through its containing parent,
and the final store entry is synced even when it already exists. The nearest
pre-existing canonical ancestor is host-provisioned durable storage. Record-
directory sync must succeed before a claim or terminal completion is
acknowledged. Unsupported or failed sync fails closed. A hard
stop can leave `.inv-*.tmp` staging files; they never replace digest-named
`.json` records as ledger truth, and the store does not remove them
automatically. For safe recovery, stop every process that can write to the
directory, inventory staging-file names, sizes and SHA-256 values, then remove
only `.inv-*.tmp` files. Preserve `.json` records, `.lock` sidecars, and
`.completion-pending` markers, retain
the before/after inventory with the local operator record, then restart and
verify expected invocation readback. Do not delete staging files by age while
a writer may be active.
