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

## Public operations

| Class | Role |
| --- | --- |
| `AudioVideoRunLedgerAdapter.fromProcessingJob(...)` | Media logical job state → `RunLedger` (three overloads) |
| `AudioVideoRunLedgerAdapter.fromProviderJobStatus(...)` | Provider job-status observation → `RunLedger` |
| `AudioVideoRunLedgerAdapter.validateConversion(...)` | Conversion validation |
| `RunLedgerProjection.project(RunLedger)` | Store-backed projection → `ProjectionResult(disposition, store)` |
| `RunLedgerProjection.reconcile(runId, readback)` | Readback reconciliation → `ReconciliationResult` |
| `LedgerStore` / `LedgerReadback` (interfaces) | Durable CAS store and read ports — injected |

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
  real durable compare-and-set semantics — none ships in this module.

## Errors

`StoreNotDispatchedException` (pre-dispatch store refusal → unavailable),
rejection of non-job-dimension tokens, bounded/redacted unknown
references.

## Tests and commands

```bash
./gradlew :services:media:adapters:ledger:test
```

Target coverage: conflict/restart/replay/lost-acknowledgement against a
real storage adapter and public ledger client; terminal status parity
with the Media writer. See `CONSUMER-COMPATIBILITY.md` for the consumer
contract and the LD-01 mapping table.
