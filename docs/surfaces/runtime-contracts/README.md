# Surface: `runtime-contracts`

Domain contract authority (`runtime-contracts`, `com.ghatana.media.
runtime`, 34 contract types). The typed Java contracts that define Media's
canonical runtime boundary — consumed by `launcher`, the modality
services, adapters and providers. This is the implementation target for
the reconciled wire contracts; it does not fork new contract versions.

## Responsibility

- **Lifecycle/state**: `MediaLifecycleProjection`,
  `MediaLifecycleEvent`, `MediaLifecycleEventPublisher`,
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
contracts, schema-format assertions.
