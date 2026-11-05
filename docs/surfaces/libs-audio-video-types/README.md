# Surface: `libs-audio-video-types`

Canonical TypeScript contract projections for Ghatana Media. Package:
`@audio-video/types` (`libs/audio-video-types`). This surface owns the
strict wire/domain value shapes shared by the SDK, UI, Explorer and contract
parity checks; it performs no I/O and admits nothing at runtime.

## Responsibility

- Define the strict canonical projections consumed by
  `@audio-video/client`: artifacts, upload sessions, the job state machine,
  attempt states, provider capabilities, canonical errors and the
  operation request/result pairs (transcription, synthesis, voice
  training/conversion, multimodal analysis).
- Mirror the PDP-1 attempt lifecycle (`media-attempt` state model) as a
  value projection only — attempt identity and runtime persistence remain
  separately owned contracts.
- Provide the TY-04 declarative-production parsers for the closed,
  versioned production value objects (production spec, scene binding,
  animation spec, model-execution spec, simulation state, validation
  report, clock alignment, AEF bridge, source classification).
- Retain the legacy modality request/result types (`index`) as an
  explicit compatibility surface, not a second canonical contract.

## Public operations

| Subpath | Contents |
| --- | --- |
| `@audio-video/types` | Legacy modality types + re-export of contracts |
| `@audio-video/types/contracts` | Canonical artifact/job/provider/error/operation schemas |
| `@audio-video/types/production` | Declarative-production value parsers |

`contracts.ts` re-exports `production.ts`, so the `contracts` subpath is a
superset — the same parsers, not a duplicate implementation.

## States and invariants

- `MediaJobStateSchema` is the canonical PDP-1 job lifecycle
  (`QUEUED`…`OUTCOME_UNKNOWN`/`RECONCILING`/`COMPLETED`/
  `PARTIALLY_SUCCEEDED`/`FAILED`/`CANCELLED`); `MediaProcessingJobSchema`
  is a discriminated union so per-state required fields are enforced.
- `LegacyMediaJobStateSchema` (`CANCELLING`, `RETRYING`) is retained only
  at the compatibility boundary: `observeMediaJobState` records the raw
  observation with `mappingDisposition` and never coerces a legacy
  spelling into a canonical state it cannot prove.
- `MediaAttemptStateSchema` projects the ten PDP-1 attempt states
  (`CLAIMED`…`SUPERSEDED`) as values only.
- Identity fields reject blank/whitespace-only strings; timestamps are
  ISO-8601 with offset; counts/sizes are non-negative safe integers —
  JSON numbers that JavaScript would silently round are rejected.
- All objects are `.strict()`; arrays and metadata carry explicit bounds
  (e.g. ≤64 metadata properties, ≤512 artifact ids, ≤200k transcript
  words).
- Production parsers use canonical int64 *decimal strings* (no binary
  float rounding), bounded recursion (`MAX_TYPED_VALUE_DEPTH` = 64) and
  node budgets, and every production value declares
  `runtimeAdmission: NOT_ADMITTED` upstream — schemas validate wire
  shape only.

## Dependencies and configuration

- `zod` only; no I/O, no provider calls, no secrets. The package is safe
  to consume from browser, Node and test contexts.

## Errors

Parse failures surface `ZodError` from the relevant `*Schema.parse` /
`parse*` helpers (`parseMediaArtifact`, `parseMediaProcessingJob`,
`parseProviderCapability`, `parseMediaCanonicalError`).
`observeMediaJobState`/`normalizeLegacyMediaJobState` throw `TypeError`
on values outside both the canonical and legacy enums.

## Contract-catalog binding

`.product-experience/interface-parity/typed-contract-bindings.json`
records one source-grounded role per exported type/schema in both the
proposal catalog (`bindings`, `PROPOSAL_ROLE_ONLY`) and the legacy role
manifest (`legacySourceRoleManifest`, `SOURCE_ROLE_ONLY`). Denominators
are asserted by `tests/media-typed-contract-bindings*.mjs`; adding an
export without a binding fails those checks. `runtimeSupport` stays
`false` — catalog presence never implies runtime admission.

## Tests and commands

```bash
pnpm --filter @audio-video/types typecheck
pnpm --filter @audio-video/types test          # vitest + protocol-projection-parity
pnpm --filter @audio-video/types test:package  # build + emitted parity + isolated consumer
```

Coverage includes golden contract shapes, state-discriminated job
parsing, legacy-state observation, decimal-int64/overflow/fuzz cases,
unknown-enum rejection, the protocol-projection snapshot, and an isolated
installed-package ESM/CJS consumer check. Synthetic fixtures are
nonproduction test data only.
