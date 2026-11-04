# infrastructure/persistence

JPA-based persistence layer for the Audio-Video platform.

## Purpose

Provides legacy-compatible repository interfaces and JPA mappings for audio files and transcription records. The canonical Media job, artifact, and transcript authority remains the runtime/provider store; this adapter must not become a second active writer.

## Layer

`infrastructure` — compatibility data-access adapter; it does not establish canonical job or transcription finality.

## Key Components

| Class | Responsibility |
|---|---|
| `AudioFileRepository` | Repository interface for audio file metadata |
| `JpaAudioFileRepository` | JPA implementation of `AudioFileRepository` |
| `TranscriptionRepository` | Repository interface for transcription records |
| `JpaTranscriptionRepository` | JPA implementation of `TranscriptionRepository` |
| `AudioFileEntity` | JPA entity for audio file metadata |
| `TranscriptionEntity` | JPA entity for transcription results |

## Configuration

Database connection is configured via the host application's `application.properties` or environment variables:

```properties
spring.datasource.url=jdbc:postgresql://localhost:5432/audio_video
spring.jpa.hibernate.ddl-auto=validate
```

## Dependencies

- Jakarta Persistence (JPA)
- `platform:java:database` — shared connection pool and transaction management

## Testing

```bash
./gradlew :services:media:modules:infrastructure:persistence:test
```

Integration tests use Testcontainers with a PostgreSQL image.

### Transaction and concurrency boundaries

`saveWithTranscription` uses the tenant-checked transcription repository in the
same transaction as the audio save. A failure rolls back a transaction it
started or marks an existing transaction rollback-only. The JPA repositories
hold a supplied `EntityManager`; that object is not safe for concurrent access.
Hosts must provide isolated per-operation persistence contexts or serialize
all use of a shared context, including across both service types. Bounded
service executors alone do not make a shared `EntityManager` thread-safe.
The PostgreSQL integration task uses an isolated generated schema and does not
prove production migration history or a writer cutover.

## Source schema and ownership crosswalk (source-only)

The module's `src/main/resources/db/migration/V1__init_schema.sql` creates
`audio_video.audio_files` and `audio_video.transcriptions`. The entity
annotations map to those tables. The canonical provider migrations under
`providers/aws-postgresql/src/main/resources/db/media-runtime/` instead create
and evolve tenant-scoped business tables in the provider-managed runtime
schema. Some coordination tables instead use global keys and omit `tenant_id`
(for example, V014 delivery attempts and the publisher lease); other outbox
rows carry `tenant_id` but use a globally unique event key. These are distinct
source schemas; the crosswalk below records
semantic overlap and migration ownership, not a data copy, deployed schema,
applied Flyway history, or cutover.

### IP-04 transcript lineage boundary

The legacy JPA transcription row is not a projection of canonical transcript
revision history. Its `id` and `audio_file_id` are UUIDs, and its optional
metadata only carries `requestId` and `inputHashSha256`; it has no canonical
`transcript_id`/`revision`, `job_id`/`attempt_number`/`fencing_token`,
`source_artifact_id`/`source_artifact_version`, provider receipt, transcript
version reference, or result digest. Its `@Version` is only the JPA row's
optimistic-lock counter. `JpaTranscriptionRepository` therefore rejects
`COMPLETED` and `CORRECTED` writes, and rejects edits to historical rows in
those states. This prevents a second successful-transcript claim; it does not
join JPA rows to canonical revisions or reconcile their contents.

Canonical transcript lineage belongs to
`PostgresqlMediaTranscriptStore` and `MediaTranscriptStore`: revisions are
bound to a successful job attempt using the revision number, job ID, attempt
number, fencing token, provider operation/receipt, request fingerprint, source
artifact version, transcript version reference, and result digest. A legacy
JPA/canonical-store disagreement cannot be safely matched from the available
JPA identifiers. Treat any such unresolved cross-store outcome as unknown and
reconcile through the canonical job/transcript stores; do not copy the JPA
text/status into canonical history or infer success from matching audio IDs,
request IDs, hashes, or timestamps.

This is a source-level boundary only. Checked-in migrations and repository
code do not establish which schema history is deployed, whether historical
JPA rows can be mapped to canonical revisions, or whether a production writer
cutover occurred. Those claims require the actual applied migration history
and externally recorded deployment/data-transfer evidence. IP-04 remains
incomplete until a source-backed cross-store reconciliation path is available;
this module has no such path today.

### JPA V1 table and entity bindings

| JPA table / entity | Source columns and identity | Tenant and row-version owner | Canonical overlap and disposition |
|---|---|---|---|
| `audio_video.audio_files` / `AudioFileEntity` | `id UUID` primary key; `tenant_id VARCHAR(64)`; `user_id UUID`; `file_name VARCHAR(512)`; `storage_path VARCHAR(1024)`; `duration_seconds INTEGER`; `sample_rate INTEGER`; `channels INTEGER`; `format VARCHAR(50)`; `file_size_bytes BIGINT`; `metadata JSONB`; `status VARCHAR(32)`; `created_at`, `updated_at TIMESTAMPTZ`; `version BIGINT`; `deleted BOOLEAN`; `deleted_at TIMESTAMPTZ`; entity also maps `failure_reason VARCHAR(1024)`. V1 does **not** declare `failure_reason`. | Tenant isolation is an entity query predicate on `tenant_id`; V1 has no tenant-composite primary/foreign key. `AudioFileEntity.@Version` owns optimistic row version `version`; it is not a content digest. | Overlaps artifact metadata/source reference in `media_artifacts` (`tenant_id`, `artifact_id`, `file_name`, `content_type`, `size_bytes`, `sha256`, `object_reference`, `classification`, timestamps, metadata). IDs, tenant widths, storage representation, and version semantics differ; there is no declared FK or migration mapping. JPA remains compatibility/support-only and must not be treated as a second canonical artifact writer. |
| `audio_video.transcriptions` / `TranscriptionEntity` | `id UUID` primary key; `tenant_id VARCHAR(64)`; `audio_file_id UUID`; `user_id UUID`; `text TEXT`; `language VARCHAR(10)`; `confidence REAL`; `status VARCHAR(32)`; `metadata JSONB`; `model_used VARCHAR(128)`; `processing_time_ms BIGINT`; `created_at`, `updated_at TIMESTAMPTZ`; `version BIGINT`; `deleted BOOLEAN`; `deleted_at TIMESTAMPTZ`. | Tenant is a scalar filter; V1 declares no FK from `audio_file_id` to `audio_files` and no tenant-composite key. `TranscriptionEntity.@Version` owns optimistic row version `version`; it is not a transcript revision or source content version. | Overlaps transcript text/model metadata with immutable `media_transcript_revisions` (V017), but the canonical row binds `tenant_id`, `transcript_id`, `revision`, `principal_id`, `source_artifact_id`, `source_artifact_version`, `source_sha256`, `job_id`, profile/provider/model, language/timebase, text, consent/rights decisions, policy and candidate admission. No V1-to-V017 key/FK conversion is declared. JPA transcription rows do not establish canonical transcript admission or finality. |

### Canonical provider migration ownership and overlap (V009–V029)

| Source migration | Exact table/column change | Tenant, key, and version/finality owner in source | Source owner and collision note |
|---|---|---|---|
| V009 `media_upload_idempotency` | `media_upload_sessions.idempotency_key VARCHAR(255)`, `request_fingerprint VARCHAR(80)`; unique index `(tenant_id, principal_id, idempotency_key)`. | Upload session composite identity remains `(tenant_id, upload_id)` from V001; replay uniqueness includes tenant and principal. No row-version column added here. | `S3PostgresqlMediaArtifactStore` reads/writes these upload columns. Distinct from JPA `audio_files`; there is no JPA idempotency mapping. |
| V010 `media_job_artifact_content_version` | `media_processing_jobs.expected_artifact_version VARCHAR(71)`, backfilled from same-tenant `media_artifacts.sha256` as `sha256:<digest>`. | Job primary key `(tenant_id, job_id)`; the field pins artifact content version, while `media_processing_jobs.version` remains the job CAS version from V001. | `PostgresqlMediaJobStore` checks the expected artifact version; `S3PostgresqlMediaArtifactStore` supplies artifact identity/content. This is not JPA `@Version`. |
| V011 `media_job_attempts_and_outbox` | Creates `media_processing_job_attempts` with `tenant_id, job_id, attempt_number, provider_id, request_id, fencing_token, status, created_at, completed_at, outcome_code`; creates `media_job_dispatch_intents` with the same composite key; creates `media_lifecycle_outbox` with `event_id, tenant_id, subject_id, event_type, payload_json, occurred_at, correlation_id, publication_attempts, published_at, failed_at, failure_code, claim_owner, claim_token, claim_expires_at, created_at`. | `media_processing_job_attempts` PK is `(tenant_id, job_id, attempt_number)` and its FK is only `(tenant_id, job_id)` to `media_processing_jobs`. `media_job_dispatch_intents` PK is `(tenant_id, job_id, attempt_number)` and its FK is that full key to `media_processing_job_attempts`. Fencing token is attempt ownership. Outbox uses globally primary `event_id` and a tenant column, not a tenant-composite PK. | `PostgresqlMediaJobStore` writes the `media_processing_job_attempts`/dispatch-intent family; `PostgresqlMediaOutboxPublicationSource` owns publication of `media_lifecycle_outbox`. These are separate from V016's `media_processing_attempts` and `media_processing_lifecycle_outbox` families (see collisions below). |
| V012 `media_artifact_format_verification` | Creates `media_artifact_format_verifications(tenant_id, upload_id, artifact_id, policy_version, state, claimed_file_name, claimed_content_type, detected_format, detail, checked_at)` with tenant-scoped upload/artifact FKs. | Primary key `(tenant_id, upload_id)`; artifact FK `(tenant_id, artifact_id)`. No separate version column; `policy_version` identifies the verification policy. | `S3PostgresqlMediaArtifactStore` records format evidence. JPA has no verification table or corresponding authority. |
| V013 `media_job_submission_digest` | Adds `media_processing_jobs.submission_digest VARCHAR(64) NOT NULL DEFAULT ''`; copies valid 64-hex `request_fingerprint` values into it. | Job remains keyed by `(tenant_id, job_id)`; both digest fields describe submitted request identity, not mutable job row version. | `PostgresqlMediaJobStore` reads/writes submission digest and retains the request fingerprint fallback. No corresponding JPA field exists. |
| V014 `media_outbox_delivery_attempts` | Creates `media_lifecycle_outbox_delivery_attempts(event_id, attempt_number, claim_owner, claim_token, payload_fingerprint, claimed_at, claim_expires_at, broker_accepted_at, status, failure_code)` and `media_lifecycle_outbox_publisher_lease(publisher_key, claim_owner, claim_token, claim_expires_at)`. | Neither table has a `tenant_id` column. Delivery attempts key `(event_id, attempt_number)` and reference global outbox `event_id`; publisher lease is keyed by `publisher_key` constrained to the singleton `media-lifecycle`. Attempt number is delivery sequence, not aggregate version. | `PostgresqlMediaOutboxPublicationSource` owns these claims and acknowledgements. This delivery-attempt ledger belongs to the V011 outbox family. |
| V015 `media_artifact_quarantine_and_lineage` | Adds upload/artifact scan columns `scan_status`, `scan_policy_version`, `scanner_id`, `scanned_at`; adds `media_artifacts.legal_hold`; creates `media_artifact_lineage(tenant_id, derived_artifact_id, derived_version, source_artifact_id, source_version, job_id, processing_profile, rights_decision_id, consent_decision_id, policy_version, admission_status, created_at)`. | Artifact/upload scan state is attached to existing tenant-scoped rows. Lineage key is `(tenant_id, derived_artifact_id, derived_version)`; source and derived versions are `sha256:` content versions and all artifact/job FKs include tenant. | `S3PostgresqlMediaArtifactStore` writes lineage and format/scan evidence; privacy maintenance reads/deletes lineage. JPA `version` is unrelated to these content versions. |
| V016 `media_attempt_finality_and_lifecycle_outbox` | Creates `media_processing_attempts(tenant_id, job_id, attempt_number, request_id, provider_id, request_fingerprint, lease_owner, fencing_token, state, provider_operation_id, provider_receipt_id, result_json, result_digest, provenance_json, observation_json, created_at, updated_at, observed_at)`; creates `media_processing_lifecycle_outbox(event_id, tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_json, classification, created_at, published_at, attempts, last_error)`. | Attempt key `(tenant_id, job_id, attempt_number)`, unique `(tenant_id, job_id, fencing_token)`; state distinguishes `DISPATCH_INTENDED`, `OUTCOME_UNKNOWN`, `SUCCEEDED`, `FAILED`, `NO_EFFECT_PROVEN`. Outbox uniqueness is `(tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type)`. `aggregate_version` is event ordering/version, not JPA row version. | `PostgresqlMediaJobStore` owns attempt state and writes the V016 processing lifecycle outbox; `PostgresqlMediaTranscriptStore` binds transcript admission to the attempt. V016 creates distinct tables from V011; both families exist in checked-in source. |
| V017 `media_transcript_revisions` | Creates `media_transcript_revisions(tenant_id, transcript_id, revision, principal_id, source_artifact_id, source_artifact_version, source_sha256, job_id, profile_id, provider_id, model_id, language, timebase, transcript_text, consent_decision_id, rights_decision_id, policy_version, admission_status, created_at)`. | Primary key `(tenant_id, transcript_id, revision)`; source artifact/job FKs are tenant-scoped. `revision` is immutable transcript revision; `source_artifact_version` and `source_sha256` bind source bytes. Migration constraint allows only `CANDIDATE` admission. | `PostgresqlMediaTranscriptStore` owns transcript revision persistence/readback. JPA `transcriptions` has no revision, source digest/version, rights/consent, or admission binding. |
| V018 `media_lifecycle_outbox_leases` | Adds `media_processing_lifecycle_outbox.claim_owner`, `claim_token BIGINT NOT NULL DEFAULT 0`, `claim_expires_at`, `next_attempt_at BIGINT NOT NULL DEFAULT 0`, `dead_lettered_at`, `dead_letter_reason`; adds an eligibility index over publication/dead-letter/retry/lease fields. | Same V016 tenant-scoped aggregate identity; claim token is lease fencing for publication, not an aggregate or entity version. | `PostgresqlMediaJobStore` lifecycle outbox dispatch source uses these columns. This lease family is separate from V014's `media_lifecycle_outbox_publisher_lease`. |
| V019 `media_stream_acknowledgements` | Adds sequence-token hash, acknowledgement revision, and finality to `media_stream_sessions`, with nonnegative revision and enumerated finality checks. | Stream session tenant/key and acknowledgement revision belong to the provider stream store; revision is not a JPA entity version. | Provider stream state only; JPA audio/transcription tables have no stream-session mapping. |
| V020 `media_stream_inflight_attempts` | Adds in-flight sequence and attempt ID to `media_stream_sessions`, constrained as an all-or-none pair with the next sequence. | Stream-session sequence/attempt ownership remains with the provider stream store; no JPA row or version mapping exists. | Provider stream state only; no compatibility migration from JPA tables is declared. |
| V021 `media_transcript_processing_purpose` | Adds `purpose_ref` and `processing_purpose` to `media_transcript_revisions`, with explicit unresolved sentinels for prior rows. | Purpose belongs to each canonical candidate transcript revision. The sentinel does not establish that a prior JPA row has an attributable purpose. | `PostgresqlMediaTranscriptStore` owns canonical revision writes; JPA transcription metadata has no authoritative purpose binding. |
| V022 `media_transcript_attempt_binding` | Creates `media_transcript_attempt_bindings`, keyed by tenant/transcript/revision and binding the exact job attempt, fencing token, provider operation/receipt, request fingerprint, source version ref, transcript version ref, and result digest. | Binding references the exact tenant-scoped canonical revision and processing attempt; these identifiers provide the durable lineage absent from JPA transcription rows. | Canonical transcript attempt/readback lineage only; no JPA-to-canonical key conversion is declared. |
| V023 `media_stt_request_snapshot` | Adds nullable `stt_request_snapshot` to `media_processing_jobs`; existing rows remain NULL because their optional request fields are unknown. | The snapshot is owned by the canonical job row and preserves the submitted STT request; it is not inferred from a JPA transcription. | `PostgresqlMediaJobStore` owns the job snapshot. JPA metadata does not provide an equivalent immutable request snapshot. |
| V024 `media_source_rights_authority` | Creates tenant/artifact/source-version keyed source records and tenant/decision keyed rights decisions, including source digest, principal/owner, operation/purpose/provider/region/retention, consent, expiry, and revocation epoch. | Source and decision authority is tenant-scoped and version-bound; rights/consent decisions govern sensitive dispatch and canonical transcript admission. | Provider authority tables; JPA audio/transcription rows contain no source-rights or consent authority binding. |
| V025 `media_transcript_production_admission` | Widens canonical transcript admission to `CANDIDATE` or `ADMITTED`; application code is responsible for verifying the authorized snapshot and live rights decision in the commit boundary. | Admission belongs to canonical transcript revision state and is distinct from JPA `TranscriptionStatus`. | `PostgresqlMediaTranscriptStore` owns admission checks. A JPA `COMPLETED`/`CORRECTED` status is not canonical admission. |
| V026 `media_multimodal_operation_snapshot` | Adds nullable `mm_operation_snapshot` to `media_processing_jobs`; prior rows remain NULL because no such snapshot existed. | The immutable operation snapshot belongs to a canonical multimodal parent job, not a JPA transcription or audio row. | `PostgresqlMediaJobStore` owns the snapshot; no JPA mapping exists. |
| V027 `media_transcript_segment_timing` | Adds timing availability and segment JSON to canonical transcript revisions, defaulting prior rows to explicit `NOT_SUPPLIED` and an empty segment list. | Segment timing is canonical transcript revision content; absence is represented explicitly rather than synthesized from legacy JPA rows. | `PostgresqlMediaTranscriptStore` owns revision timing. JPA transcription text has no segment-level timing contract. |
| V028 `media_caption_versions` | Creates immutable `media_caption_registrations`, keyed by tenant/principal/request and uniquely identifying caption version and registration receipt; stores source artifact version, parent version, clock, language/purpose disposition, and segments. | Caption version and receipt identities are canonical, with tenant/principal/request replay identity; JPA transcription rows do not represent caption registrations. | Provider caption registration/readback only; no JPA mapping or conversion is declared. |
| V029 `media_transcript_version_ref_readback` | Adds an index on `(tenant_id, transcript_version_ref)` for exact transcript-version lookup through attempt bindings. | Readback resolves the exact persisted revision bound to the reference; it must not guess the latest revision. | Canonical transcript readback only. JPA `id`/`@Version` cannot substitute for `transcript_version_ref` or revision selection. |

### Source collisions and unresolved runtime history

- **Artifact metadata overlap:** JPA `audio_video.audio_files` and provider `media_artifacts` both describe stored media and tenant ownership but use different primary keys, tenant widths, storage fields, content identity, and lifecycle fields. No migration or dual-read/write bridge in the sources maps one row to the other.
- **Transcript overlap:** JPA `audio_video.transcriptions` and canonical `media_transcript_revisions` both store transcript text, but only V017 binds immutable revisions to source content version/digest, job, principal, rights, consent, policy and admission. Treating the JPA row as the canonical transcript would lose those bindings.
- **Attempt generations:** V011 `media_processing_job_attempts` plus `media_job_dispatch_intents` and V016 `media_processing_attempts` are separate attempt/finality stores. The checked-in `PostgresqlMediaJobStore` contains SQL paths for both. Their runtime migration ordering, retained purpose, and any historical reconciliation are not established by source inspection.
- **Outbox generations:** V011/V014 `media_lifecycle_outbox`, its delivery-attempt table and singleton publisher lease coexist in source with V016/V018 `media_processing_lifecycle_outbox`. `PostgresqlMediaOutboxPublicationSource` publishes the first family; `PostgresqlMediaJobStore` writes the second. No source proves that production has one active publisher or that events are not duplicated across both families.
- **Applied migration history is unknown here:** repository migration files establish intended source definitions only. The environment's actual database endpoint/schema, `flyway_schema_history` rows/checksums/success states, migration locations/baselines/repair history, and any manually applied DDL have not been read. Therefore this crosswalk does not assert which V001–V018 migrations are applied or that the provider schema is present.
- **Fixture lineage is not applied history:** `providers/aws-postgresql/src/test/java/com/ghatana/media/provider/aws/MediaMigrationLineageFixtureTest.java` seeds an isolated H2 PostgreSQL-mode database through V001–V009, then exercises the checked-in forward migrations V010–V029. This is a source-fixture result only. In `docs/implementation/media-persistence-schema-lineage.v1.json`, `canonical.sourceMigrationRange: V001..V029` describes checked-in source files, while `canonical.appliedRange: UNKNOWN_NOT_READ` records that no live `flyway_schema_history` was read. Neither field asserts deployed database state.
- **Legacy active writer/cutover is unproven by this module:** the repository direction says the legacy `ghatana/services/media` binary may remain the sole active database/worker/outbox writer until separately verified M08 cutover. The actual deployed binary/version, process/worker/publisher inventory, datasource/schema bindings, and owner-approved cutover evidence were not inspected here. Do not start a second Media writer or infer cutover from these source files or integration tests.
