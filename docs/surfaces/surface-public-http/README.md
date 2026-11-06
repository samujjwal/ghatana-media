# Logical surface: `media.surface.public-http`

Public HTTP channel. Physical owners: `launcher` (route hosting,
`MediaHttpHandler`) and `runtime-contracts` (request/response/error
contracts). Contract source: `contracts/openapi/media.yaml` (34
operations: 8 public operational probes and 26 authenticated API operations).

## Supported operations

The 30 documented REST operations under `/api/v1/` — artifact upload/
chunk append/finalize, job submit/get/list/cancel/outcome, streams
open/connect/frame/close, captions/transcripts, plus typed error
responses. Runtime route manifest: `config/route-manifest.json`.

## States and invariants

- Each operation reconciles schema, auth (tenant/principal headers),
  idempotency, cancellation and typed errors; source-free HTTP consumer
  tests bind the published contract, not internals.
- Unknown provider outcomes surface as `OUTCOME_UNKNOWN`-class states —
  never inferred success from HTTP 202 or event append.
- Accepted job submissions and stream frames return `Location` pointing to
  their canonical job/session read route and `Retry-After: 1`; the header is a
  polling hint and does not assert provider completion. `GET /api/v1/jobs/{jobId}`
  accepts an optional exact `requestId` reconciliation query; mismatches are
  deliberately returned as not found.
- Contract parity is enforced by `scripts/check-media-contract-parity.mjs`
  against OpenAPI, SDK operations and the operation-parity manifest.

## Dependencies

`launcher` composition, `runtime-contracts` types,
`providers/aws-postgresql` durable stores.

## Errors

Typed error taxonomy per OpenAPI; auth/rights denials are explicit 4xx;
ambiguous effects remain reconcilable unknowns.

## Tests

`pnpm test:contract-parity` (currently pinned NON-GREEN on one stale
multimodal SDK route disposition pending owner review);
`modules/integration-tests` wire-level suites; launcher ITs.
