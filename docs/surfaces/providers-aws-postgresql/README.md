# Surface: `providers-aws-postgresql`

AWS PostgreSQL + S3 provider implementations of the canonical Media
runtime ports (`providers/aws-postgresql`,
`:services:media:providers:aws-postgresql`, package
`com.ghatana.media.provider.aws`). This is the durable backing for the
canonical job/artifact/stream/session/outbox contracts — the single
writer side of Media persistence, composed via `runtime-contracts`.

## Responsibility

PostgreSQL-backed stores and S3-backed artifact storage implementing the
`runtime-contracts` ports, registered through `META-INF/services`
ServiceLoader files:

| Port (contract) | Implementation |
| --- | --- |
| `MediaRuntimeContracts$MediaJobStore` | `PostgresqlMediaJobStore` |
| `MediaRuntimeContracts$MediaArtifactStore` | `S3PostgresqlMediaArtifactStore` |
| `MediaRuntimeContracts$MediaArtifactScanner` | `DevelopmentMediaArtifactScanner` |
| `MediaRuntimeContracts$MediaStreamSessionStore` | `PostgresqlMediaStreamSessionStore` |
| `MediaRuntimeContracts$MediaStreamingProvider` | `HttpMediaStreamingProvider` |
| `MediaRuntimeContracts$MediaProcessingProvider` | `HttpMediaProcessingProvider` |
| `MediaRuntimeContracts$MediaConsentAuthority` | `PostgresqlMediaConsentAuthority` |
| `MediaSourceAuthorizationContracts$Authority` | `PostgresqlMediaSourceAuthorizationAuthority` |
| `MediaSourceRightsAdministration` | `PostgresqlMediaSourceRightsAdministration` |
| `MediaConsentAdministration` | `PostgresqlMediaConsentAdministration` |
| `MediaPrivacyMaintenance` | `PostgresqlMediaPrivacyMaintenance` |
| `MediaCaptionContracts$MediaCaptionStore` | `PostgresqlMediaCaptionStore` |
| `MediaTranscriptContracts$MediaTranscriptStore` | `PostgresqlMediaTranscriptStore` |
| `MediaLifecycleOutboxSource` | `PostgresqlMediaLifecycleOutboxSource` (+ `PostgresqlMediaOutboxPublicationSource`) |

Supporting types: `MediaAwsPostgresqlRuntimeState`,
`MediaArtifactFormatVerifier`, `MediaArtifactObjectOwnership`,
`MediaHttpProviderClient`.

## Public operations

Store/port implementations only — no standalone entrypoint. Consumed by
`launcher` composition through `MediaRuntimePortFactory` ServiceLoader
resolution; HTTP provider clients call configured provider endpoints.

## States and invariants

- **One canonical writer**: these stores implement the authoritative
  job/artifact/session/outbox state — adapters (ledger, Data Cloud,
  cache, persistence JPA) project or read but never become a second
  active writer.
- Schema is Flyway-managed under
  `src/main/resources/db/media-runtime/` (29 migrations, V001–V0xx:
  runtime state, upload idempotency/finalization claim, worker lease,
  job attempts + outbox, stream ACKs, artifact quarantine/lineage/format
  verification, transcript segment timing/production admission,
  processing purpose, etc.). Applied migrations are never altered —
  expand → dual-read/backfill → verify → contract.
- Upload idempotency, finalization claims, worker leases and stream-ACK
  fencing provide crash/restart-safe semantics; lost-ack and
  process-crash recovery are covered by dedicated tests.
- Durable job and outbox lease deadlines use epoch-millisecond precision;
  returned lease values match the persisted deadline, and overflow rejects
  the claim before any publisher effect. Lifecycle outbox claim leases that
  truncate below that precision are rejected before publication, preventing
  an immediately expired claim from admitting concurrent duplicate publish.
- Tenant isolation is enforced at the store boundary
  (`MediaPostgresqlS3TenantIsolationTest`).
- Delivery operation readback preserves stored scope values exactly; corrupted
  padded identity or digest values are rejected instead of trimmed into a
  different operation. Dispatch-owner IDs with surrounding whitespace are
  rejected as well.
- `PostgresqlMediaSourceAuthorizationAuthority` binds source rights to the
  authenticated tenant/principal, immutable digest, operation, purpose,
  region, provider version/boundary and retention. Human/third-party sources
  also require a live `media_consents` row for the same tenant, principal,
  purpose and region at both resolution and revalidation; revoked/future/
  expired consent and missing consent fail closed. The current consent schema
  does not authorize provider retention beyond `NONE`. Shared PolicyEngine
  remains required; caller consent/retention labels are not evidence.

## Dependencies and configuration

- PostgreSQL datasource + S3 object store via host configuration;
  `platform:java:database` connection/transaction management; HTTP
  provider client for processing/streaming providers.
- Flyway migrations under `db/media-runtime/` apply at startup per host
  policy.

## Errors

Store-level constraint/lease/claim conflicts surface as typed
persistence exceptions mapped at runtime boundaries; ambiguous provider
outcomes remain `UNKNOWN` pending reconciliation — never inferred
success.

## Tests and commands

```bash
./gradlew :services:media:providers:aws-postgresql:test
```

Coverage includes: legacy migration history readback (V001–V016
fixtures), Flyway process-crash recovery, create-lost-ack crash,
Postgres/S3 restart and missing-object recovery, tenant isolation,
streaming close fence, job-store metrics, upload crash recovery IT,
HTTP provider behavior, migration lineage fixtures.
