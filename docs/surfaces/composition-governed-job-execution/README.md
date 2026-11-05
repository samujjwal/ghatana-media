# Composition: `media.composition.governed-job-execution`

Canonical job/attempt → policy → bounded provider effect → transactional
outbox → exact terminal readback.

## Input / output

Input: admitted job submissions (REST/gRPC/SDK/CLI/agent channels).
Output: terminal job states readable consistently across all channels;
provider attempts fenced and reconciled.

## Authority

- `runtime-contracts`: `MediaJobView`, `MediaLifecycleProjection`,
  `MediaLifecycleEvent( Publisher|OutboxSource)`, admission bindings,
  `MediaCapabilityNotAdmittedException`.
- `providers/aws-postgresql`: `PostgresqlMediaJobStore`, job-attempt +
  outbox migrations (V005 worker lease, V011 attempts/outbox),
  `HttpMediaProcessingProvider`.
- `launcher`/`MediaRuntime`: canonical writer — the only job-status
  authority.

## Failure / rollback

Fail-closed admission (unqualified capability → typed rejection, no
effect); cancellation propagates to provider fencing; lost ACK →
`OUTCOME_UNKNOWN` until reconciliation; crash → worker lease expiry +
attempt fencing + restart recovery (`MediaMultimodalParentChildRestart
PostgresIT`, `MediaProviderPolicyDeniedFinalityPostgresIT`,
`MediaSttTranscriptCommitFenceIT`). Never blindly retry after an
admitted effect boundary.

## Cross-child behavior test

End-to-end: submit → policy check → bounded provider effect → outbox →
terminal readback across REST/gRPC/SDK with denied, UNKNOWN,
cancelled and restart paths; effects observed in provider/store state.

## Data flow

Channel → launcher admission → job store (Postgres, lease-fenced
attempts) → provider dispatch (bounded) → outbox events → lifecycle
projection → consistent terminal reads on all channels.
