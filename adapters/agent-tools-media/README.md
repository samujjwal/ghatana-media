# Media Agent Tools adapter

This module binds Media tool calls to Media handlers. `MediaToolExecutionBinder`
requires an atomic, durable invocation claim before dispatch. Its default interface methods remain fail-closed. `FileInvocationLedger` now
provides a single-host durable UNKNOWN claim/complete implementation with
exclusive hard-link claim, lock-serialized CAS completion and restart readback.
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

The four handler adapters currently validate inputs and return typed
`NOT_ADMITTED` results before provider dispatch. Compatibility constructor
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
