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
| `InvocationLedger` (interface) | Atomic claim/completion port; **no production implementation ships here** |
| `MediaJobReadback` (interface) | Durable job-state read port for reconciliation |

## States and invariants

- `ClaimResult`: `CLAIMED` / `ALREADY_CLAIMED` / `UNAVAILABLE`; default
  ledger methods **fail closed** — this module does not prove durable
  dispatch readiness.
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
boundary, admission negatives for all four handlers, descriptor identity
(AT-01/AT-05), capability inventory and speech/vision/multimodal admission
boundaries. Tests assert zero provider dispatch while handlers remain
unadmitted — they do not prove real delegated execution.
