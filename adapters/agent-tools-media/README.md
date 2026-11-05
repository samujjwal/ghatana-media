# Media Agent Tools adapter

This module binds Media tool calls to Media handlers. `MediaToolExecutionBinder`
requires an atomic, durable invocation claim before dispatch. Its default interface methods remain fail-closed. `FileInvocationLedger` now
provides a single-host durable UNKNOWN claim/complete implementation with
exclusive hard-link claim, lock-serialized CAS completion and restart readback.
It is not a tenant-authorizing, encrypting, multi-host ledger and does not
establish provider dispatch admission. Do not use unsafe legacy record upserts.

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
`LogicalAction.toString()` intentionally reports only outcome and presence
markers so result payloads and request identity do not enter routine diagnostics.
