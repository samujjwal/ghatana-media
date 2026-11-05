# Surface: `adapters-ledger`

Run-ledger projection adapter (`adapters/ledger`, Java/Gradle). It maps
Media job observations onto the public Data Cloud `RunLedger` record —
it defines no second ledger schema and holds no independent job-status
authority.

## Responsibility

- `AudioVideoRunLedgerAdapter` — converts `MediaLifecycleProjection`
  logical job states (and provider-job-status observations) into public
  `RunLedger` values via `fromProcessingJob` / `fromProviderJobStatus`.
- `RunLedgerProjection` — projects an incoming `RunLedger` through an
  injected durable `LedgerStore` (compare-and-set backing) and reconciles
  via `LedgerReadback`; `StoreNotDispatchedException` marks
  store-guaranteed pre-dispatch refusals as unavailable.
- `RunLedgerProjection.ProjectionStateBacking` — optional durable backing
  for the per-run latest/unavailable/uncertain triple; hydrated once per
  run and persisted after every transition so replay guards, ordering
  floors, uncertain fences and terminal parity survive process restart.
- `FileRunLedgerProjectionState` — filesystem implementation (pre-dispatch uncertainty is persisted before external store contact; focused crash-phase tests added but not executed in this review): one JSON
  document per run (digest filenames), atomic fsync+rename writes,
  fail-closed corrupt reads. Single-node durable state, not replicated.
- `RunLedgerJson` — explicit field-by-field `RunLedger` codec; canonical
  constructors re-validate invariants on decode.

## Public operations

| Class | Role |
| --- | --- |
| `AudioVideoRunLedgerAdapter.fromProcessingJob(...)` | Media logical job state → `RunLedger` (three overloads) |
| `AudioVideoRunLedgerAdapter.fromProviderJobStatus(...)` | Provider job-status observation → `RunLedger` |
| `AudioVideoRunLedgerAdapter.validateConversion(...)` | Conversion validation |
| `RunLedgerProjection.project(RunLedger)` | Store-backed projection → `ProjectionResult(disposition, store)` |
| `RunLedgerProjection.reconcile(runId, readback)` | Readback reconciliation → `ReconciliationResult` |
| `LedgerStore` / `LedgerReadback` (interfaces) | Durable CAS store and read ports — injected (Data Cloud sink) |
| `ProjectionStateBacking` (interface) | Durable per-run projection-state port |
| `FileRunLedgerProjectionState` | Filesystem `ProjectionStateBacking` implementation |

## State mapping (LD-01 boundary)

Only **aggregate job states** map; attempt, quality and delivery are
separate dimensions and are never encoded as job finality:

| Media logical job state | RunLedger state | Outcome |
| --- | --- | --- |
| `QUEUED`, `RETRY_PENDING`, `OUTCOME_UNKNOWN`, `RECONCILING` | `PENDING` | none (`UNKNOWN`/`RECONCILING` carry explicit `jobState=UNKNOWN`, `effectFinality=UNKNOWN` + bounded `sourceStateRef` fingerprint) |
| `RUNNING` | `RUNNING` | none |
| `COMPLETED` | `COMPLETED` | `SUCCEEDED` |
| `PARTIALLY_SUCCEEDED` | `COMPLETED` | `DEGRADED` |
| `FAILED` | `COMPLETED` | `FAILED` |
| `CANCELLED` | `CANCELLED` | `CANCELLED` |

Legacy phase labels map to nonterminal envelopes only; unrecognized or
oversized tokens degrade to `PENDING` + explicit unknown markers
(`UNRECOGNIZED_REDACTED` for unsafe tokens) — never a retry or progress
authorization. Known attempt-only, quality and delivery tokens are
rejected rather than conflated with job uncertainty.

## States and invariants

- The adapter is a **projection**, not an authority: terminal status must
  match the canonical Media writer; the ledger cannot originate job state.
- Ambiguity stays unknown — no silent promotion to success/failure.

## Dependencies and configuration

- Public `com.ghatana.datacloud.delivery.ledger.RunLedger` as an `api`
  dependency (it appears in public signatures); `LedgerStore` must provide
  real durable compare-and-set semantics — the Data Cloud sink itself is
  injected by the host. `FileRunLedgerProjectionState` ships in this
  module as the durable projection-state backing; it is not a ledger
  store and does not replace the Data Cloud `LedgerStore`.

## Errors

`StoreNotDispatchedException` (pre-dispatch store refusal → unavailable),
rejection of non-job-dimension tokens, bounded/redacted unknown
references.

## Tests and commands

```bash
./gradlew :services:media:adapters:ledger:test
```

Coverage: `RunLedgerProjectionTest` (12 ordering/replay/fence cases),
`FileRunLedgerProjectionStateTest` (8 durable-backing cases — codec
round-trip, replay/stale/conflict/terminal parity and uncertain-fence +
unavailable-floor survival across restart, exact-readback reconcile,
digest filenames), `AudioVideoRunLedgerAdapterTest`. The Data Cloud
`LedgerStore` sink and public ledger client remain host-injected; a
real-storage end-to-end run against the live Data Cloud store is still
tracked as integration coverage.
