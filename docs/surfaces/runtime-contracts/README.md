# Surface: `runtime-contracts`

Domain contract authority (`runtime-contracts`, `com.ghatana.media.
runtime`, 34 contract types). The typed Java contracts that define Media's
canonical runtime boundary — consumed by `launcher`, the modality
services, adapters and providers. This is the implementation target for
the reconciled wire contracts; it does not fork new contract versions.

## Responsibility

- **Lifecycle/state**: `MediaLifecycleProjection`,
  `MediaLifecycleEvent`, `MediaPublicLifecycleEvent`, `MediaLifecycleEventType`,
  `MediaLifecycleIdentifierRedactor`, `HmacMediaLifecycleIdentifierRedactor`,
  `MediaLifecycleEventPublisher`,
  `MediaLifecycleOutboxSource`, `MediaJobView` — job state projection,
  lifecycle events and the transactional-outbox source.
- **Contracts by domain**: `MediaRuntimeContracts`,
  `MediaModalityContracts`, `MediaCaptionContracts`,
  `MediaTranscriptContracts`, `MediaVisualContracts`,
  `MediaCreationContracts`, `MediaCaptureSourceContracts`,
  `MediaSourceAuthorizationContracts`, `MediaSourceRightsAdministration`,
  `MediaConsentAdministration`, `MediaPrivacyMaintenance`,
  `MediaSemanticRedactionRuntime`-adjacent sanitizers
  (`MediaExternalDisclosureSanitizer`, `MediaJobResultSanitizer`,
  `MediaMetadataSanitizer`).
- **Identity/versioning**: `MediaJobRequestFingerprint`,
  `MediaUploadRequestFingerprint`, `MediaVersionRefRules`,
  `MediaVersionedContractContent`, `MediaSubmissionDigest`-family rules,
  `MediaTimebase`.
- **Ports/factories**: `MediaProcessingRuntimePort`,
  `MediaRuntimePortFactory`, `ComposedMediaRuntimePortFactory`-style
  ServiceLoader composition.
- **Production/compute**: `MediaProductionSpecCompiler`,
  `MediaProductionAdmissionBinding`,
  `MediaProductionSemanticSource`,
  `MediaProductionSchemaFormatAssertions`, `WhisperComputeContracts`,
  `MediaSpeechToTextAdmission`, `MediaCapabilityNotAdmittedException`,
  `MediaDeploymentProfiles`.

## Public operations

Contract types, ports and compilers under `com.ghatana.media.runtime`;
no standalone entrypoint — consumers wire them through
`MediaRuntimePortFactory`/launcher composition.

## States and invariants

- Contracts are the **single product-semantic implementation target** —
  stable IDs, schema compatibility and negative/error semantics are
  preserved; no second aggregate spec is created.
- Sanitizers bound what may leave the trust boundary: external
  disclosure, job results and metadata are redacted/bounded before
  crossing.
- Admission contracts (`MediaSpeechToTextAdmission`,
  `MediaProductionAdmissionBinding`, `MediaCapabilityNotAdmittedException`)
  keep unqualified capabilities fail-closed — `NOT_ADMITTED` is an
  explicit outcome, never silent degradation.
- Fingerprints bind tenant/project/origin identity with length-framed
  inputs; version refs follow `MediaVersionRefRules` — immutable source
  versions are never rewritten.
- Public lifecycle v1 is a strict typed projection of the nine observed
  runtime event names. Stable HMAC aliases are purpose-separated; raw event,
  tenant, principal, correlation, causation and aggregate IDs are not placed
  in its payload. The alias key must be supplied and protected by the host.
- The public lifecycle parser accepts exact integral numeric representations
  for `aggregateVersion`, including bounded `Float` values, and rejects
  fractional or ambiguous values without rounding.
- Every event append is `NON_FINAL_APPEND`, including terminal-shaped job
  events. Consumers must separately perform authorized terminal job readback;
  event publication/consumption is not provider-effect, job-finality, or
  delivery evidence.

## Dependencies and configuration

- Consumed by `launcher` and modality services; platform common/
  observability primitives where applicable. No runtime configuration of
  its own.

## Errors

`MediaCapabilityNotAdmittedException` and contract-level typed
rejections; unknown outcomes stay `OUTCOME_UNKNOWN`-class — never
fabricated success.

## Tests and commands

```bash
./gradlew :services:media:runtime-contracts:test
```

Coverage: contract shape/compatibility, fingerprint stability,
sanitizer bounds, admission fail-closed paths, outbox/lifecycle event
contracts, public lifecycle v1 ABI and redaction assertions, schema-format
assertions.

## Scoped contract: multimodal fused result

### Vision and non-goals

`MediaRuntimeContracts.MultimodalOperationSpec.fusedResult` deterministically
composes the durable terminal child-job snapshots for one persisted multimodal
operation. Its purpose is to make the same source-clock-grounded observation
projection available during the live provider attempt and restart reconciliation.
The parent operation spec remains the existing v1 persisted contract. This
projection is internal composition data; it is not the PDP-1 typed cross-modal
product output or a shared legacy multimodal-family result contract. It does not
introduce a new operation version or user-facing endpoint.

This result is a local composition record. It does not prove that a provider was
licensed, admitted, authorized by rights/consent, or quality-qualified. A shared
clock projection means coordinates are comparable under the declared source
clock binding; it does not claim measured synchronization, calibrated confidence,
or biometric identity.

### Consumers and boundary

The live `DelegatingMultimodalProvider` composes canonical child jobs through
`fusedResult(spec, children)`. `MediaRuntime` uses that same deterministic
function when reconciling a parent from persisted child rows after restart. The
runtime owns tenant/principal and child artifact/version binding checks before
accepting those rows. Restart recovery must also respect current authority; the
existing projection alone does not re-establish source rights or consent. The
runtime-contracts module owns only the typed operation specification and pure
internal projection; it does not dispatch jobs, access providers, or make rights
decisions.

The projection keeps child outcome/status and result observations separate.
Each child digest covers its complete canonical durable result, subject to the
runtime's bounded result limits. The emitted child observation object is limited
to 8,192 canonical JSON characters and uses sorted top-level keys; a non-timing
field that cannot fit rejects composition instead of producing an incomplete
success. Timed observations share that size budget and retain the existing
per-child and global entry limits. If timing entries are omitted for either
limit, the timing section reports `SYNC_UNDETERMINED` with a budget reason.
Timed observations are grounded only when their source-clock identity, tick
rate, and duration fit the persisted source-clock binding. Missing, malformed,
conflicting, or unverifiable timing remains `SYNC_UNDETERMINED` with a typed
reason.

### API and compatibility policy

The existing Java API is `MultimodalOperationSpec.fusedResult(List<ProcessingJob>)`
and its source-clock-aware overload
`fusedResult(MultimodalOperationSpec, List<ProcessingJob>)`. Preserve the
persisted `media.multimodal-operation-spec.v1` input shape and deterministic
live/restart output parity. Do not make this generic map stand in for
`media.typed-output.source-grounded-cross-modal-result-with-provenance-and-uncertainty`;
the PDP-1 type has a closed `artifactType`/`payload` envelope with required result
`artifactId` and `versionId`. Do not invent shared family aggregate semantics,
field placement, schema versions, clock semantics, thresholds, or owner
authority. Product output requires the exact capability operation's declared
typed result and its owning persistence/authority path.

### Example

Given a parent spec with source clock `src-clock`, tick rate 48,000, epoch offset
9,600, and duration 96,000, a child observation on the same clock with interval
`[9,600, 14,400)` is projected as `TIMESTAMP_ALIGNED` at media ticks
`[0, 4,800)` and milliseconds `[0, 100)`. An unknown clock or mismatched tick
rate is preserved as an undetermined observation; the contract does not estimate
or silently convert between clocks.

### Required checks and evidence

Focused contract check:

```sh
./gradlew :services:media:runtime-contracts:test --tests com.ghatana.media.runtime.MultimodalOperationSpecTest
```

For an internal projection change, compile and run direct reverse consumers after
the focused contract test: `:services:media:modules:intelligence:multimodal-service:compileJava`,
`:services:media:modules:intelligence:multimodal-service:test`, and the launcher
multimodal restart selectors documented in the scoped verification plan. Repository-recorded test
output is local implementation evidence only. Lifecycle-owned Evidence
Generator artifacts remain necessary for formal convergence; this repository
does not hand-author `.evidence/**` or claim a convergence result here.
