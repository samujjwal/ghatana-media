# Media Agent Tools adapter

This module binds Media tool calls to Media handlers. `MediaToolExecutionBinder`
requires an atomic, durable invocation claim before dispatch. Its default ledger
claim and completion methods fail closed, and this module does not provide a
production ledger implementation or claim durable dispatch readiness.

Any future durable ledger implementation must enforce tenant and authenticated
principal access on reads and writes, protect stored results according to data
classification with appropriate encryption and retention, and perform fresh
authorization before returning a replayed result. Java compatibility
constructors on `LogicalAction` support local call-site compatibility only;
they do not prove compatibility or migration of serialized ledger records.
`LogicalAction.toString()` intentionally reports only outcome and presence
markers so result payloads and request identity do not enter routine diagnostics.
