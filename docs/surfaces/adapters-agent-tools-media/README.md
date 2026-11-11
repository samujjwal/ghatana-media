# Surface: `adapters-agent-tools-media`

Media Agent Tools adapter (`adapters/agent-tools-media`, Java/Gradle,
ActiveJ promises). It binds delegated tool calls to the four Media tool
handlers behind an atomic durable-invocation seam. It is **not** a
provider bypass: handlers validate input and return typed `NOT_ADMITTED`
before any provider dispatch today.

## Responsibility

- Expose the four canonical tool IDs — `av.speech-to-text`,
  `av.text-to-speech`, `av.vision-analysis`, `av.multimodal-inference` —
  through `AudioVideoToolHandlerFactory` and `ToolHandler` implementations.
- Gate every delegated execution through `MediaToolExecutionBinder`,
  which requires an atomic durable `InvocationLedger` claim **before**
  dispatch so duplicate/replayed calls cannot double-execute.
- Preserve typed failure taxonomy (`ToolExecutionFailure.Stage.ADMISSION`
  etc.) and `OUTCOME_UNKNOWN` semantics for post-dispatch ambiguity.

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
