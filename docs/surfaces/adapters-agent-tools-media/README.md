# Surface: `adapters-agent-tools-media`

Media Agent Tools adapter (`adapters/agent-tools-media`, Java/Gradle,
ActiveJ promises). It binds delegated tool calls to the four Media tool
handlers behind an atomic durable-invocation seam. It is **not** a
provider bypass: handlers validate input and, without a configured job bridge,
return typed `NOT_ADMITTED`; with one they only submit canonical Media jobs.

## Responsibility

- Expose the four canonical tool IDs — `av.speech-to-text`,
  `av.text-to-speech`, `av.vision-analysis`, `av.multimodal-inference` —
  through `AudioVideoToolHandlerFactory` and `ToolHandler` implementations.
- Gate every delegated execution through `MediaToolExecutionBinder`,
  which requires an atomic durable `InvocationLedger` claim **before**
  dispatch so duplicate/replayed calls cannot double-execute.
- Preserve typed failure taxonomy (`ToolExecutionFailure.Stage.ADMISSION`
  etc.) and `OUTCOME_UNKNOWN` semantics for post-dispatch ambiguity.

## Canonical Media job mapping (conservative assumption)

Conservative assumption (owner-delegated design decision): "Each Media agent tool maps to exactly one canonical Media job: av.speech-to-text → JobType.SPEECH_TO_TEXT, av.text-to-speech → TEXT_TO_SPEECH, av.vision-analysis → VISION, av.multimodal-inference → MULTIMODAL, submitted through the canonical Media job submission path with the caller's exact source artifact version, a request id derived from the durable invocation id, and the tool's validated parameters. The tool result is the canonical job's observed outcome (terminal result, or ACCEPTED/RUNNING with a job reference, or the job pipeline's own typed NOT_ADMITTED/UNAVAILABLE/OUTCOME_UNKNOWN). No model, voice, licence, consent or quality is self-admitted: provider admission stays exactly as the Media runtime decides it, so without an admitted provider every tool returns the runtime's typed refusal. Tool identity is bound to an authenticated Media principal; in development this is the DEV_ONLY signed identity, and production-like profiles stay fail-closed until a trusted Tools identity contract exists."

| Tool | Job type | Source binding | Job parameters |
| --- | --- | --- | --- |
| `av.speech-to-text` | `SPEECH_TO_TEXT` | `audioSource.mediaArtifactId` + `sourceArtifactVersion` | language, diarization, model |
| `av.text-to-speech` | `TEXT_TO_SPEECH` | `sourceArtifactId` + `sourceArtifactVersion` | text, voice, speakingRate, pitch, audioEncoding, storeAsArtifact |
| `av.vision-analysis` | `VISION` | `mediaSource.mediaArtifactId` + `sourceArtifactVersion` | analysisTypes, maxResults, confidenceThreshold, customModelId |
| `av.multimodal-inference` | `MULTIMODAL` | `mediaArtifactId` + `sourceArtifactVersion` | inferenceMode, samplingRateMs, language, enableTranscription, enableVisionAnalysis |

- Seam: `MediaJobSubmissionPort` (adapter interface). `RuntimeMediaJobSubmissionPort`
  implements it over the published `MediaProcessingRuntimePort`
  (`submit(request, AuthenticatedPrincipal)`); launcher internals are not imported.
- Wiring: `new AudioVideoToolHandlerFactory(binder, new MediaToolJobBridge(port, profile))`;
  `bridge.readback()` is the binder's `MediaJobReadback`. Without a bridge every
  handler stays typed `*_NOT_ADMITTED` exactly as before.
- Request: id `agtool-<sha256(invocationId)>`, correlation id = invocation id, tenant from the
  envelope, principal from the authenticated identity, empty provider hint, default (non-
  consenting, non-external) governance context. Inline bytes and a missing/malformed
  `sourceArtifactVersion` are rejected (`SOURCE_ARTIFACT_REQUIRED`, `SOURCE_VERSION_REQUIRED`,
  `SOURCE_VERSION_INVALID`) before any submission; a stale/mismatched version is the runtime's
  `MEDIA_SOURCE_VERSION_STALE` refusal.
- Outcome mapping: `COMPLETED` → SUCCESS with job reference + the job's stored result;
  `ACCEPTED`/`RUNNING`/`OUTCOME_UNKNOWN` → non-final `OUTCOME_UNKNOWN` carrying the job id
  (fence stays UNKNOWN); `FAILED` → FAILED with the job failure code; `CANCELLED` → CANCELLED;
  `MediaCapabilityNotAdmittedException` → `MEDIA_NOT_ADMITTED` / `MEDIA_PROVIDER_UNAVAILABLE` /
  `MEDIA_SOURCE_VERSION_STALE` (UNAVAILABLE at ADMISSION) or `MEDIA_POLICY_DENIED` (DENIED).
  Any other submit exception, or a returned job whose identity does not match the request,
  is ambiguous: it stays on the error channel (binder `OutcomeUnknownException`) and is
  reconciled via `MediaJobReadback` by the derived request id. Duplicate invocations are
  fenced by the ledger and never resubmit.
- Principal: the authenticated tenant must equal the envelope tenant; mismatch or absent
  principal is refused before submission. Only dev-class profiles (`local/dev/development/
  test/ci`) accept an identity; production-like or unknown profiles return
  `TOOLS_IDENTITY_CONTRACT_UNAVAILABLE`. The adapter does not verify the DEV_ONLY signature;
  the host that authenticates the principal owns that.
- Host must supply: the authenticated principal per call, a durable request-id lookup for
  reconciliation (the runtime port has none, so `RuntimeMediaJobSubmissionPort` only
  resolves submissions whose acknowledgment it saw), and an admitted provider. Positive tests
  use a TEST-ONLY fixture port and do not prove any real provider, model, voice, licence or
  consent is admitted.

## Public operations

| Entry point | Contents |
| --- | --- |
| `AudioVideoToolHandlerFactory.create(toolId)` | Returns the typed handler, optionally wrapped by the execution binder |
| `AudioVideoToolHandlerFactory.toolIds()` | Canonical registered tool IDs |
| `MediaToolExecutionBinder.execute(handler, envelope, contract)` | Claim → dispatch → complete/reconcile |
| `InvocationLedger` (interface) | Atomic claim/completion port |
| `FileInvocationLedger` | Single-host filesystem development backing: create-if-absent hard-link claim, lock-file CAS completion, restart-surviving JSON records, digest filenames |
| `MediaJobReadback` (interface) | Durable job-state read port for reconciliation |

## States and invariants

- `ClaimResult`: `CLAIMED` / `ALREADY_CLAIMED` / `UNAVAILABLE`; the
  interface defaults still **fail closed** for ledgers that do not
  implement claim/complete.
- `FileInvocationLedger` is a single-host development backing. Record and
  lock filenames use the invocation ID's SHA-256 digest. The JSON record
  still contains the request identity and terminal outcome metadata in
  plaintext inside an owner-only (`0700` directory / `0600` files) location;
  terminal result bodies are AES-GCM encrypted with a host-injected key and
  expire under the host-supplied retention duration. Claims use an atomic
  create-if-absent hard link to a forced temporary record. Completion
  serializes through a lock sidecar, verifies the exact UNKNOWN fence, and
  atomically replaces it. Each newly created path component's containing
  directory is synced, as is the final store entry even when it already
  exists; the nearest pre-existing canonical ancestor is host-provisioned
  durable storage. Claim and completion sync their record directory before
  acknowledging. Unsupported sync fails closed. The store itself does not enforce tenant-scoped
  access control or provide multi-host replication; fresh principal
  authorization remains with the binder's host-supplied authorizer.

## Crash recovery

A hard stop may leave `.inv-*.tmp` staging files. They do not replace the
digest-named `.json` records as ledger truth, and the implementation does not
delete them automatically. Reclaim them only after all writers for this
directory have stopped: inventory their names, sizes and SHA-256 values, then
remove only `.inv-*.tmp` files. Preserve `.json` records and `.lock` sidecars,
retain the before/after inventory, then restart and verify expected invocation
readback. Age-based cleanup while a writer may be active is unsafe.
- `LogicalOutcome`: `SUCCESS` / `FAILED` / `OUTCOME_UNKNOWN`;
  `OutcomeUnknownException` carries `invocationId` + `durableJobState`.
- `RequestIdentity`/`LogicalAction` bind invocation id, tool id, tenant,
  caller agent and an input fingerprint; `LogicalAction.toString()`
  reports only outcome/presence markers so payloads and request identity
  never enter routine diagnostics.
- Compatibility constructor delegates on `LogicalAction` are local
  call-site compatibility only — they do not prove serialized-ledger
  compatibility.
- The Data Cloud artifact entry in the shared capability descriptor is
  read-model metadata, not a handler or an execution grant.

## Dependencies and configuration

- `com.ghatana.platform:tool-test-support` (test), JUnit 5, AssertJ,
  Mockito; shared tool contracts (`ToolHandler`, `ToolExecutionEnvelope`,
  `ToolExecutionResult`) come from the platform tool boundary — handlers
  never call providers directly.
- Any future `InvocationLedger` implementation must enforce tenant +
  authenticated-principal scoping on reads/writes, classification-aware
  result protection (encryption/retention), and fresh authorization
  before returning a replayed result.

## Errors

Typed `NOT_ADMITTED` results per handler (`STT_NOT_ADMITTED`,
`TTS_NOT_ADMITTED`, `MULTIMODAL_NOT_ADMITTED`, vision admission codes such
as `INLINE_IMAGE_NOT_ADMITTED`); `InvocationIdentityConflictException`,
`InvocationClaimUnavailableException`, `OutcomeUnknownException`;
`IllegalArgumentException` for unknown tool IDs.

## Tests and commands

```bash
./gradlew :services:media:adapters:agent-tools-media:test
```

Suites cover binder claim/conflict/UNKNOWN behavior, input-dispatch
boundary, `FileInvocationLedgerTest` (durable claim/CAS/restart/
corrupt-record/digest-filename coverage), admission negatives for all
four handlers, descriptor identity (AT-01/AT-05), capability inventory
and speech/vision/multimodal admission boundaries. Tests assert zero
provider dispatch while handlers remain unadmitted — they do not prove
real delegated execution.
