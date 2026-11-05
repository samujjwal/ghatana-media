# Media Agent Tools adapter

This module binds Media tool calls to Media handlers. `MediaToolExecutionBinder`
requires an atomic, durable invocation claim before dispatch. Its default interface methods remain fail-closed. `FileInvocationLedger` now
provides a single-host durable UNKNOWN claim/complete implementation with
exclusive hard-link claim, lock-serialized CAS completion and restart readback.
It accepts only a current-user-owned POSIX directory with mode `0700`, rejects
symlinked directories and record/lock entries, and creates ledger files with
mode `0600`. It is still not a tenant-authorizing, encrypting, multi-host
ledger and does not establish provider dispatch admission. Do not use unsafe
legacy record upserts.

The four handler adapters currently validate inputs and return typed
`NOT_ADMITTED` results before provider dispatch. Compatibility constructor
delegates are ignored. The Data Cloud artifact entry in the shared capability
descriptor is read-model metadata only; it is not a Media handler or an
authenticated execution grant.

Any future durable ledger implementation must enforce tenant and authenticated
principal access on reads and writes, protect stored results according to data
classification with appropriate encryption and retention, and perform fresh
authorization before returning a replayed result. Java compatibility
constructors on `LogicalAction` support local call-site compatibility only;
they do not prove compatibility or migration of serialized ledger records.
The current binder compares replayed records with caller identity fields inside
the Tools envelope; those fields are a consistency check, not a verified
principal or authorization grant. This adapter has no authenticated-principal,
rights-readback, encryption-key, or retention-policy port. Replay is therefore
identity-matched only, records remain plaintext until the host protects the
ledger volume, and retention is unmanaged. Do not expose this file store to
untrusted or multi-tenant callers. The owning host must provide authenticated
identity/authorization and storage policy through a contract before results
can be called securely replayable.
`LogicalAction.toString()` intentionally reports only outcome and presence
markers so result payloads and request identity do not enter routine diagnostics.
