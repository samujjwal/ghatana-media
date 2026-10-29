# Data Cloud media provider adapters

This Gradle library implements the Data Cloud `MediaProcessorPort` SPI. Its
source types define the adapter contract; the library being present in the
FULL build does not establish runtime wiring, provider availability, or
qualification.

## Public boundary and dependencies

`DataCloudSttAdapter`, `DataCloudVisionAdapter`, and
`DataCloudMultimodalAdapter` implement
`com.ghatana.datacloud.memory.media.MediaProcessorPort`. Their constructor
inputs are the Media-owned `PersistentSttService`, `PersistentVisionService`,
and `PersistentMultimodalService` respectively. The Gradle project also
requires Data Cloud's delivery API and shared SPI projects, ActiveJ promises,
and SLF4J.

The SPI calls carry an `artifactId`, `tenantId`, one operation selector
(`languageCode`, `analysisType`, or `indexType`), and `Map<String, String>`
parameters. Successful calls return `Promise<String>` containing a transcript,
frame-index, or multimodal-index identifier. `isAvailable` and the supported
language, analysis, and index arrays advertise each adapter's source-declared
capabilities. Unsupported operations currently resolve to `null` in the STT
and Vision adapters and fail with `UnsupportedOperationException` in the
Multimodal adapter. Consumers must not interpret these source declarations as
proof that any adapter is wired or admitted.

The adapter sources declare no local SPI version or compatibility negotiation.
Their Java compatibility follows the Data Cloud API project selected by the
Gradle dependency; Data Cloud owns evolution of `MediaProcessorPort`.

## Errors, tenant, and data handling

The SPI requires callers to enforce tenant, consent, retention, and event
publication rules. Adapter calls pass the tenant identifier through to their
Media service. STT and Vision preserve delegated promise failures and emit
message-only logs. Multimodal validates nonblank artifact, tenant, and index
type; a missing service or delegated failure returns a generic integration
unavailable error. No adapter accepts credentials or declares a resource
ceiling, deadline, or cancellation mechanism.

`MediaSemanticObservationProjector` is a separate local projection helper. It
requires matching source/projection tenant and artifact version, classification
preservation, and a redaction reference, then returns a Data Cloud semantic
object with source/provider/consent/provenance references. It validates the
projection's fields; it does not authenticate those references, authorize
publication, or perform evidence admission.

The existing Media `DEP-DATA-CLOUD` boundary remains authoritative for the
owner split: Data Cloud may expose governed metadata/read models, while Media
retains artifact, upload, job, stream, consent, and processing lifecycle
semantics. The exact Java SPI source and each adapter class are linked from the
Media contract-definition surface matrix.
