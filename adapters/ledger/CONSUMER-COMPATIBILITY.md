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
| `OUTCOME_UNKNOWN` | `PENDING` | none | marked `jobState=UNKNOWN`, `effectFinality=UNKNOWN`; `sourceStateRef` fingerprints the source token |
| `RECONCILING` | `PENDING` | none | same explicit unknown envelope; never a retry or progress authorization |
| `COMPLETED` | `COMPLETED` | `SUCCEEDED` | mapped |
| `PARTIALLY_SUCCEEDED` | `COMPLETED` | `DEGRADED` | mapped only from the explicit partial job state |
| `FAILED` | `COMPLETED` | `FAILED` | mapped as terminal execution outcome; RunLedger has no separate failed terminal state |
| `CANCELLED` | `CANCELLED` | `CANCELLED` | mapped |

Legacy phase labels `SUBMITTED`, `TRANSCODING`, `PROCESSING`, and `STORING`
map respectively to `PENDING`, `RUNNING`, `RUNNING`, and `RUNNING`, all with
no outcome. Unrecognized or oversized job tokens use `PENDING` only as the
public enum's nonterminal envelope, paired with `jobState=UNKNOWN` and
`effectFinality=UNKNOWN`. Known uncertainty tokens receive a bounded canonical
fingerprint; arbitrary or oversized tokens use the constant
`UNRECOGNIZED_REDACTED` reference. This does not prove dispatch did not happen
or authorize retry. Known attempt-only,
quality, and delivery tokens remain rejected rather than conflated with job
uncertainty. Media's logical
attempt states (`CLAIMED`, `DISPATCH_INTENT_RECORDED`, `DISPATCHED`, `RUNNING`,
`CANCEL_REQUESTED`, `SUCCEEDED`, `FAILED`, `CANCEL_CONFIRMED`,
`OUTCOME_UNKNOWN`, `SUPERSEDED`) describe an attempt, not an aggregate job;
the adapter does not accept them as job-state substitutes. Because the method
takes an untyped string, shared tokens `RUNNING`, `FAILED`, and
`OUTCOME_UNKNOWN` are interpreted only by the aggregate job-state rules above
(`OUTCOME_UNKNOWN` becomes the explicit unknown envelope); this API cannot carry the attempt-state
meaning for those same tokens.

The complete attempt-vocabulary boundary is:

| Media logical attempt state | Result when supplied as the adapter's `jobState` argument | Meaning retained by this adapter |
| --- | --- | --- |
| `CLAIMED` | rejected as an unmapped job state | no attempt-state field exists in `RunLedger` |
| `DISPATCH_INTENT_RECORDED` | rejected as an unmapped job state | no attempt-state field exists in `RunLedger` |
| `DISPATCHED` | rejected as an unmapped job state | no attempt-state field exists in `RunLedger` |
| `RUNNING` | maps under aggregate-job meaning to `RUNNING`, no outcome | supplied attempt number is retained, but attempt state is not distinguished |
| `CANCEL_REQUESTED` | rejected as an unmapped job state | pass the explicit whitelisted `cancellationState=REQUESTED` fact separately; it does not finalize the job |
| `SUCCEEDED` | rejected as an unmapped job state | only aggregate `COMPLETED` supplies successful job finality |
| `FAILED` | maps under aggregate-job meaning to `COMPLETED` + `FAILED` outcome | supplied attempt number is retained, but attempt failure cannot be distinguished from job failure |
| `CANCEL_CONFIRMED` | rejected as an unmapped job state | pass `cancellationState=CONFIRMED` separately; aggregate finality still requires job `CANCELLED` |
| `OUTCOME_UNKNOWN` | maps under aggregate-job meaning to the marked `PENDING`/`UNKNOWN` envelope | preserves uncertainty without claiming attempt or job progress/finality |
| `SUPERSEDED` | rejected as an unmapped job state | no attempt-state field exists in `RunLedger` |

These are input-boundary classifications, not conversion of an attempt
state-machine record into a job record. The only attempt identity carried by
the current public ledger contract is the caller-supplied `attemptNumber`;
there is no attempt status or immutable attempt ID field. Source-provided
tenant, request fingerprint/ID, source version/digest, principal, and rights
authority remain explicit input headers when they pass the adapter's existing
validation. A provider name or provider job reference does not supply any of
those source facts.

The quality-disposition states (`NOT_ASSESSED`, `ASSESSING`, `PASS`, `FAIL`,
`ABSTAINED`, `REVIEW_REQUIRED`, `SUPERSEDED`) and delivery states
(`NOT_STARTED`, `PREPARING`, `READY_FOR_AUTHORIZED_DELIVERY`, `SUBMITTED`,
`ACKNOWLEDGED`, `PARTIALLY_DELIVERED`, `OUTCOME_UNKNOWN`, `RECONCILING`,
`FAILED`, `REVOKED`) are not independent RunLedger job-state projections.
The current adapter signature receives a string state token without a typed
state-machine discriminator: lexical collisions therefore retain their
aggregate job/legacy meaning (`SUBMITTED` and `PREPARING` map to `PENDING`,
`FAILED` remains the canonical job state, and `OUTCOME_UNKNOWN`/
`RECONCILING` become explicit unknown envelopes). The adapter cannot
consume a standalone delivery state context through that API. Distinct values
such as quality `PASS` and delivery `ACKNOWLEDGED` are rejected as job inputs;
quality `PASS` is not job success and delivery `ACKNOWLEDGED` is not job
completion. The public RunLedger has no typed `UNKNOWN` state or outcome;
its coarse `PENDING` value is paired with `effectFinality=UNKNOWN` and never
constitutes Media job authority or retry permission.

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
