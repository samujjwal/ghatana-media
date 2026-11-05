# Logical surface: `media.surface.agent-tools`

Agent-tool delegation channel. Physical owner:
`adapters/agent-tools-media` — four typed handler adapters
(`AudioTranscriptionAgent`, `MultimodalAnalysisAgent` and siblings).

## Supported operations

Four public delegated actions intended to bind to authenticated
Tools/Action Plane identity, operation rights, quotas, idempotency,
cancellation and result redaction — as authorized typed delegates to
the canonical Media runtime.

## States and invariants

- **Delegation remains fail-closed**: handlers validate input and return
  typed `NOT_ADMITTED` results before provider dispatch. The durable
  `FileInvocationLedger` (filesystem-backed atomic claim + CAS complete,
  restart-surviving JSON records) now exists as the `InvocationLedger`
  implementation; authorized delegated execution still awaits canonical
  runtime/public ports and owner admission.
- No direct provider bypass: handlers never call providers
  independently; delegation must carry source identity, rights scope
  and redacted results.
- Completion criteria (consumer tests for all four handlers: forged
  delegation, duplicate call, revoked rights, outage,
  effect-after-timeout, no false success) are plan requirements, not
  yet satisfied.

## Dependencies

Tools/Action Plane identity and rights; canonical Media runtime ports;
durable single-host invocation ledger (implemented; focused safety regression tests require execution); fresh authenticated replay authorization and real canonical dispatch remain open.

## Errors

Input validation failures and `NOT_ADMITTED` typed results; no
fabricated success on outage/timeout.

## Tests

`./gradlew :services:media:adapters:agent-tools-media:test` — current
suites assert validation + zero-dispatch `NOT_ADMITTED` behavior.
