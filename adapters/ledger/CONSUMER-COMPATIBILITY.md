# RunLedger adapter consumer compatibility

`AudioVideoRunLedgerAdapter` maps Media job observations to the public
`com.ghatana.datacloud.delivery.ledger.RunLedger` record owned by Data Cloud.
The adapter does not define or version a second ledger schema. Its Data Cloud
API dependency is an `api` dependency because `RunLedger` is part of the
adapter's public Java signatures; Gradle consumers therefore receive the same
contract on their compile classpath.

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
