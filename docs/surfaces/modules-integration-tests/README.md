# Surface: `modules-integration-tests`

Wire-level integration test module (`modules/integration-tests`,
`:services:media:modules:integration-tests`, test sources only). Exercises
**public wire and installed client consumption** independently of
implementation unit tests — generated protobuf/OpenAPI clients against
the configured server capabilities.

## Responsibility

- Consume the public wire contracts (OpenAPI REST + gRPC) with
  source-free/generated clients; combine identity, rights, job
  reconciliation and provider faults.
- Keep implementation-internal unit coverage in the owning modules;
  this module proves the contracts other systems actually bind to.

## Public operations

Representative suites under `com.ghatana.audio.video.integration`:
`SttAuthenticatedIntegrationTest`, `TtsAuthenticatedIntegrationTest`,
`SttPersistenceE2ETest`, `MultimodalRpcMatrixIntegrationTest`,
`MultimodalContractTest`, `MediaPipelineIntegrationTest`,
`GuardedCrossModalityStreamStateMachineTest`,
`MediaOpenApiContractConsumptionTest`,
`MediaHttpRouteInventoryCountTest`,
`MediaGrpcRegistryDescriptorParityTest`,
`AudioVideoAdvancedServicesIntegrationTest`, plus
`TestJwtServerInterceptor` for authenticated-path coverage.

## States and invariants

- Positive/negative/unsupported/timeout cases against declared
  capabilities; unsupported operations are asserted as typed failures,
  never silently skipped or mocked into success.
- Source-free client consumption: tests bind the published contracts,
  not implementation internals, so contract drift fails here.
- Descriptors/parity tests keep generated gRPC/OpenAPI clients aligned
  with the canonical wire manifests.

## Dependencies and configuration

- Gradle project `:services:media:modules:integration-tests`; depends on
  the service modules under test and generated contract stubs.
- Local/test JWT interceptor for auth paths; no live provider
  credentials.

## Errors

Contract mismatches surface as test failures with route/RPC identity;
unsupported capability assertions verify the typed rejection rather
than inferring behavior.

## Tests and commands

```bash
./gradlew :services:media:modules:integration-tests:test
```

Focused selectors can target individual suites (e.g.
`--tests '*MediaOpenApiContractConsumptionTest'`). Suites requiring
unavailable providers fail closed rather than fabricating results.
