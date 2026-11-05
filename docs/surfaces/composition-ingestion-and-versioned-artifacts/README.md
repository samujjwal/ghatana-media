# Composition: `media.composition.ingestion-and-versioned-artifacts`

Upload → durable content → verified immutable version → authorized
read → retention/erasure.

## Input / output

Input: authorized upload requests (REST `/api/v1/artifacts/uploads*`,
SDK `uploadPart`/finalize, chunk append). Output: content-addressed
immutable artifact versions, authorized reads, retention/erasure
lifecycles.

## Authority

- `providers/aws-postgresql`: `S3PostgresqlMediaArtifactStore`
  (S3+Postgres), `MediaArtifactFormatVerifier`,
  `MediaArtifactObjectOwnership`, upload idempotency/finalization-claim
  migrations (V002, V009, V015, V012).
- `runtime-contracts`: artifact store/scan ports,
  `MediaVersionRefRules`, request fingerprints.
- `launcher`/`MediaRuntime`: orchestration and admission.

## Failure / rollback

S3/Postgres crash mid-upload → idempotency keys + finalization claims
recover without duplicate artifacts; invalid hash → rejection before
version promotion; replay → idempotent response; tenant faults →
isolation enforced at store boundary. Crash/recovery covered by
`MediaUploadCrashRecoveryIT`, `MediaPostgresqlS3MissingObjectRestartTest`,
`MediaPostgresqlCreateLostAckProcessCrashTest`.

## Cross-child behavior test

Composable IT: upload → durable content → verified immutable version →
authorized read → retention/erasure across S3/PG with crash, invalid
hash, replay and tenant faults — provider effects observed in stores,
not inferred from HTTP 202.

## Data flow

Client (HTTP/SDK/CLI) → launcher admission (identity/rights/idempotency)
→ chunk store (S3) + metadata (Postgres) → format verification →
immutable version ref → authorized read path → retention/erasure jobs.
