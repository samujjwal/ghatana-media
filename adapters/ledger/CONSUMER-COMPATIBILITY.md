# RunLedger adapter consumer compatibility

`AudioVideoRunLedgerAdapter` maps Media job observations to the public
`com.ghatana.datacloud.delivery.ledger.RunLedger` record owned by Data Cloud.
The adapter does not define or version a second ledger schema. Its Data Cloud
API dependency is an `api` dependency because `RunLedger` is part of the
adapter's public Java signatures; Gradle consumers therefore receive the same
contract on their compile classpath.

## State mapping boundary (LD-01)

The source vocabularies are `MediaLifecycleProjection.LogicalJobStatus`,
`LogicalAttemptStatus`, the PDP-1 `media-quality-disposition` and
`media-delivery` state machines, and the public RunLedger's
`JobExecutionState`/`ExecutionOutcome`. The adapter accepts only aggregate job
states. Attempt, quality, and delivery are separate dimensions and are not
encoded as job finality.

| Media logical job state | RunLedger state | RunLedger outcome | Result |
| --- | --- | --- | --- |
| `QUEUED` | `PENDING` | none | mapped |
| `RUNNING` | `RUNNING` | none | mapped |
| `RETRY_PENDING` | `PENDING` | none | mapped; retry authority is not represented by the ledger state |
| `OUTCOME_UNKNOWN` | — | — | rejected: RunLedger has no unknown state |
| `RECONCILING` | — | — | rejected: RunLedger has no reconciliation state |
| `COMPLETED` | `COMPLETED` | `SUCCEEDED` | mapped |
| `PARTIALLY_SUCCEEDED` | `COMPLETED` | `DEGRADED` | mapped only from the explicit partial job state |
| `FAILED` | `COMPLETED` | `FAILED` | mapped as terminal execution outcome; RunLedger has no separate failed terminal state |
| `CANCELLED` | `CANCELLED` | `CANCELLED` | mapped |

Legacy phase labels `SUBMITTED`, `TRANSCODING`, `PROCESSING`, and `STORING`
map respectively to `PENDING`, `RUNNING`, `RUNNING`, and `RUNNING`, all with
no outcome. Other unrecognized job tokens are rejected. Media's logical
attempt states (`CLAIMED`, `DISPATCH_INTENT_RECORDED`, `DISPATCHED`, `RUNNING`,
`CANCEL_REQUESTED`, `SUCCEEDED`, `FAILED`, `CANCEL_CONFIRMED`,
`OUTCOME_UNKNOWN`, `SUPERSEDED`) describe an attempt, not an aggregate job;
the adapter does not accept them as job-state substitutes. Because the method
takes an untyped string, shared tokens `RUNNING`, `FAILED`, and
`OUTCOME_UNKNOWN` are interpreted only by the aggregate job-state rules above
(`OUTCOME_UNKNOWN` is rejected); this API cannot carry the attempt-state
meaning for those same tokens.

The quality-disposition states (`NOT_ASSESSED`, `ASSESSING`, `PASS`, `FAIL`,
`ABSTAINED`, `REVIEW_REQUIRED`, `SUPERSEDED`) and delivery states
(`NOT_STARTED`, `PREPARING`, `READY_FOR_AUTHORIZED_DELIVERY`, `SUBMITTED`,
`ACKNOWLEDGED`, `PARTIALLY_DELIVERED`, `OUTCOME_UNKNOWN`, `RECONCILING`,
`FAILED`, `REVOKED`) are not independent RunLedger job-state projections.
The current adapter signature receives a string state token without a typed
state-machine discriminator: lexical collisions therefore retain their
aggregate job/legacy meaning (`SUBMITTED` and `PREPARING` map to `PENDING`,
`FAILED` remains the canonical job state, and `OUTCOME_UNKNOWN`/
`RECONCILING` are rejected as unrepresentable job states). The adapter cannot
consume a standalone delivery state context through that API. Distinct values
such as quality `PASS` and delivery `ACKNOWLEDGED` are rejected as job inputs;
quality `PASS` is not job success and delivery `ACKNOWLEDGED` is not job
completion. The public RunLedger has no typed `UNKNOWN` state or outcome;
unknown/unrepresentable job input is rejected instead of assigned a fallback.

## Build profiles

The verified development path is `DEV_SOURCE_COMPOSITE`. In the standalone
Media checkout, `:services:data-cloud:delivery:api` resolves to the sibling
Ghatana source project. The focused adapter tests compile against that current
source API and exercise the adapter's conversions and local ordering guard.
This proves source-composite compatibility for the tested checkout only.

`RELEASE_ARTIFACT_ONLY` is not admitted by
`config/dependency-profile-policy.json`. Its required artifact lock does not
currently provide admitted immutable coordinates and installed-consumer
evidence for Data Cloud's public API. Do not describe the adapter as verified
against a published/source-free RunLedger artifact until the Data Cloud owner
publishes that artifact and the profile's independent lock and consumer checks
are admitted.

## Persistence and readback boundary

Data Cloud owns RunLedger persistence. Media's `RunLedgerProjection` is a
process-local latest-truth guard around a host-supplied store function; it is
not a persistence implementation and is not wired to a production Data Cloud
writer/readback client. Its uncertain-write fence is also process-local. A
store exception after dispatch remains `OUTCOME_UNKNOWN` until the host
reconciles against authoritative readback. The local projection tests do not
prove a Data Cloud write, durable ordering, restart safety, multi-instance
safety, or consumer readback.

## Seeded projection measurement

`AudioVideoRunLedgerAdapterTest.testSeededTenThousandRecordProjectionMeasurement`
constructs 10,000 sanitized `RunLedger` values from a fixed seed and checks
state/outcome mapping, bounded fields, and disclosure filtering. It reports
per-record adapter construction latency and the largest `RunLedger.toString()`
length observed. This is a local micro-measurement, not a Data Cloud storage,
wire-serialization, throughput, memory, or production SLO benchmark. It has no
approved performance threshold; compare its measurements only when the JDK,
host, build profile, and test source are recorded alongside them.
