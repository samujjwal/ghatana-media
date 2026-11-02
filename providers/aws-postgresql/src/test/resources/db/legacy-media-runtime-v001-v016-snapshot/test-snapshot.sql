-- TEST-ONLY RECONSTRUCTION; NOT A DEPLOYED DATABASE EXPORT.
-- Historical source commit: d62557fdaac7a324e036ca25f672d2a62ac532ea
-- Historical source path: providers/aws-postgresql/src/main/resources/db/media-runtime/
-- Fixture path: providers/aws-postgresql/src/test/resources/db/legacy-media-runtime-v001-v016/
-- Synthetic rows below reuse the IP-06 fixture identities and values.
-- History projection contains manifest fields only. installed_by, installed_rank,
-- installed_on, and execution_time require a live PostgreSQL readback.
CREATE SCHEMA IF NOT EXISTS ip06_legacy_v001_v016_snapshot;
SET search_path TO ip06_legacy_v001_v016_snapshot;

-- BEGIN V001__media_runtime_state.sql sha256=14fdc8290e91509ad58f14d118c144ec20abcb1f5445c31f64e9282c6edd392f
CREATE TABLE IF NOT EXISTS media_upload_sessions (
    tenant_id VARCHAR(255) NOT NULL,
    upload_id VARCHAR(255) NOT NULL,
    file_name VARCHAR(1024) NOT NULL,
    content_type VARCHAR(255) NOT NULL,
    expected_size_bytes BIGINT NOT NULL,
    expected_sha256 VARCHAR(64) NOT NULL,
    classification VARCHAR(64) NOT NULL,
    retention_millis BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    bytes_received BIGINT NOT NULL,
    next_chunk_index INTEGER NOT NULL,
    status VARCHAR(32) NOT NULL,
    metadata_json TEXT NOT NULL,
    artifact_id VARCHAR(255),
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, upload_id),
    CONSTRAINT media_upload_status_check CHECK (status IN ('OPEN','FINALIZING','COMPLETED','ABORTED','EXPIRED'))
);
CREATE INDEX IF NOT EXISTS idx_media_upload_expiry
    ON media_upload_sessions (status, expires_at);

CREATE TABLE IF NOT EXISTS media_upload_chunks (
    tenant_id VARCHAR(255) NOT NULL,
    upload_id VARCHAR(255) NOT NULL,
    chunk_index INTEGER NOT NULL,
    object_key VARCHAR(2048) NOT NULL,
    size_bytes BIGINT NOT NULL,
    sha256 VARCHAR(64) NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, upload_id, chunk_index),
    CONSTRAINT fk_media_chunk_upload FOREIGN KEY (tenant_id, upload_id)
        REFERENCES media_upload_sessions(tenant_id, upload_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS media_artifacts (
    tenant_id VARCHAR(255) NOT NULL,
    artifact_id VARCHAR(255) NOT NULL,
    file_name VARCHAR(1024) NOT NULL,
    content_type VARCHAR(255) NOT NULL,
    size_bytes BIGINT NOT NULL,
    sha256 VARCHAR(64) NOT NULL,
    object_reference VARCHAR(2048) NOT NULL,
    classification VARCHAR(64) NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    metadata_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, artifact_id),
    CONSTRAINT uk_media_artifact_hash UNIQUE (tenant_id, sha256, size_bytes)
);
CREATE INDEX IF NOT EXISTS idx_media_artifacts_tenant_created
    ON media_artifacts (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_artifacts_expiry
    ON media_artifacts (expires_at);

CREATE TABLE IF NOT EXISTS media_processing_jobs (
    tenant_id VARCHAR(255) NOT NULL,
    job_id VARCHAR(255) NOT NULL,
    request_id VARCHAR(255) NOT NULL,
    artifact_id VARCHAR(255) NOT NULL,
    job_type VARCHAR(64) NOT NULL,
    provider_id VARCHAR(255) NOT NULL,
    status VARCHAR(32) NOT NULL,
    created_at BIGINT NOT NULL,
    started_at BIGINT,
    completed_at BIGINT,
    result_json TEXT NOT NULL,
    failure_code VARCHAR(128) NOT NULL,
    version BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, job_id),
    CONSTRAINT uk_media_job_request UNIQUE (tenant_id, request_id),
    CONSTRAINT media_job_status_check CHECK (status IN ('ACCEPTED','RUNNING','COMPLETED','FAILED','CANCELLED'))
);
CREATE INDEX IF NOT EXISTS idx_media_jobs_tenant_created
    ON media_processing_jobs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_jobs_recovery
    ON media_processing_jobs (status, started_at);

CREATE TABLE IF NOT EXISTS media_stream_sessions (
    tenant_id VARCHAR(255) NOT NULL,
    session_id VARCHAR(255) NOT NULL,
    principal_id VARCHAR(255) NOT NULL,
    stream_kind VARCHAR(64) NOT NULL,
    provider_id VARCHAR(255) NOT NULL,
    state VARCHAR(32) NOT NULL,
    connection_token_hash VARCHAR(64) NOT NULL,
    lease_owner VARCHAR(255),
    lease_expires_at BIGINT,
    last_sequence BIGINT NOT NULL,
    buffered_bytes BIGINT NOT NULL,
    maximum_buffered_bytes BIGINT NOT NULL,
    reconnect_count INTEGER NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    closed_at BIGINT,
    metadata_json TEXT NOT NULL,
    version BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, session_id),
    CONSTRAINT media_stream_state_check CHECK (state IN ('OPEN','CONNECTED','DEGRADED','DRAINING','CLOSED','FAILED'))
);
CREATE INDEX IF NOT EXISTS idx_media_stream_sessions_lease
    ON media_stream_sessions (state, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_media_stream_sessions_tenant
    ON media_stream_sessions (tenant_id, updated_at DESC);
-- END V001__media_runtime_state.sql

-- BEGIN V002__media_upload_finalization_claim.sql sha256=112a0e6d7d59187eb4cbe360112fddacd8adbd54031b36bc70bcb6694c03c3c1
ALTER TABLE media_upload_sessions
    ADD COLUMN IF NOT EXISTS finalization_token VARCHAR(255);
ALTER TABLE media_upload_sessions
    ADD COLUMN IF NOT EXISTS finalization_started_at BIGINT;

CREATE INDEX IF NOT EXISTS idx_media_upload_finalizing
    ON media_upload_sessions (status, finalization_started_at);
-- END V002__media_upload_finalization_claim.sql

-- BEGIN V003__media_consent_authority.sql sha256=6ddf65f4d7625fd4c31350338e7cfc1d2b5dd763cad5df967b0203a39440fa4c
CREATE TABLE IF NOT EXISTS media_consents (
    tenant_id VARCHAR(255) NOT NULL,
    consent_id VARCHAR(255) NOT NULL,
    principal_id VARCHAR(255) NOT NULL,
    purposes_csv TEXT NOT NULL,
    allowed_regions_csv TEXT NOT NULL,
    external_processing_allowed BOOLEAN NOT NULL,
    biometric_processing_allowed BOOLEAN NOT NULL,
    granted_at BIGINT NOT NULL,
    expires_at BIGINT,
    revoked_at BIGINT,
    version BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, consent_id),
    CONSTRAINT media_consent_version_check CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS idx_media_consents_principal
    ON media_consents (tenant_id, principal_id, consent_id);
CREATE INDEX IF NOT EXISTS idx_media_consents_expiry
    ON media_consents (expires_at, revoked_at);
-- END V003__media_consent_authority.sql

-- BEGIN V004__media_principal_ownership.sql sha256=28c2555b75bd73fac3b58f1f122a59ef5557205e275047603f7a9d9d4ce8245b
ALTER TABLE media_upload_sessions
    ADD COLUMN IF NOT EXISTS principal_id VARCHAR(255) NOT NULL DEFAULT 'legacy-unowned';

ALTER TABLE media_artifacts
    ADD COLUMN IF NOT EXISTS principal_id VARCHAR(255) NOT NULL DEFAULT 'legacy-unowned';

ALTER TABLE media_processing_jobs
    ADD COLUMN IF NOT EXISTS principal_id VARCHAR(255) NOT NULL DEFAULT 'legacy-unowned';

ALTER TABLE media_artifacts
    DROP CONSTRAINT IF EXISTS uk_media_artifact_hash;

ALTER TABLE media_artifacts
    ADD CONSTRAINT uk_media_artifact_principal_hash
        UNIQUE (tenant_id, principal_id, sha256, size_bytes);

CREATE INDEX IF NOT EXISTS idx_media_upload_principal
    ON media_upload_sessions (tenant_id, principal_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_media_artifact_principal
    ON media_artifacts (tenant_id, principal_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_media_job_principal
    ON media_processing_jobs (tenant_id, principal_id, created_at DESC);
-- END V004__media_principal_ownership.sql

-- BEGIN V005__media_job_worker_lease.sql sha256=ee4ea78b33f298cb148891f380e46c264b8d6b21ca0361834834e6842b0d5293
ALTER TABLE media_processing_jobs
    ADD COLUMN IF NOT EXISTS lease_owner VARCHAR(255);
ALTER TABLE media_processing_jobs
    ADD COLUMN IF NOT EXISTS lease_token BIGINT NOT NULL DEFAULT 0;
ALTER TABLE media_processing_jobs
    ADD COLUMN IF NOT EXISTS lease_expires_at BIGINT;

CREATE INDEX IF NOT EXISTS idx_media_jobs_worker_lease
    ON media_processing_jobs (status, lease_expires_at);
-- END V005__media_job_worker_lease.sql

-- BEGIN V006__media_job_cancellation_truth.sql sha256=0205b444c44df722e4a9cb2bec2651a613376aa0bb0590dcf9a44d7ff5aae0e0
-- A provider cancellation that is not confirmed is not a terminal outcome.
-- Keep the job non-terminal so provider completion/recovery can establish authoritative truth.
-- The cancellationOutcome column records the provider's confirmed or unconfirmed response.
ALTER TABLE media_processing_jobs
    ADD COLUMN IF NOT EXISTS cancellationOutcome VARCHAR(32)
    CHECK (cancellationOutcome IS NULL
        OR cancellationOutcome IN ('CONFIRMED', 'REQUESTED_UNCONFIRMED', 'UNSUPPORTED'));

ALTER TABLE media_processing_jobs
    ADD CONSTRAINT media_job_cancelled_requires_confirmation
    CHECK (
        NOT (
            status = 'CANCELLED'
            AND cancellationOutcome IS DISTINCT FROM 'CONFIRMED'
            AND failure_code IN (
                'CANCELLED_UNCONFIRMED',
                'CANCELLATION_REQUESTED_UNCONFIRMED',
                'CANCELLATION_UNSUPPORTED'
            )
        )
    );
-- END V006__media_job_cancellation_truth.sql

-- BEGIN V007__media_job_unknown_provider_outcome.sql sha256=94a2349a06c99a6de0e55d2c8ddb24f91538b4689f0c69aa33a12299e901e8a6
-- A caller-side timeout cannot establish whether a provider applied its effect.
-- Keep this durable state distinct from FAILED so retries cannot duplicate an unknown effect.
ALTER TABLE media_processing_jobs
    DROP CONSTRAINT IF EXISTS media_job_status_check;

ALTER TABLE media_processing_jobs
    ADD CONSTRAINT media_job_status_check
    CHECK (status IN ('ACCEPTED','RUNNING','COMPLETED','FAILED','CANCELLED','OUTCOME_UNKNOWN'));
-- END V007__media_job_unknown_provider_outcome.sql

-- BEGIN V008__media_job_artifact_content_version.sql sha256=670b8964675c705c4bc2499b1370074f5d5098815964dc81802c90c1b6999bd1
ALTER TABLE media_processing_jobs
    ADD COLUMN expected_artifact_version VARCHAR(71);

UPDATE media_processing_jobs job
SET expected_artifact_version = (
    SELECT 'sha256:' || artifact.sha256
    FROM media_artifacts artifact
    WHERE artifact.tenant_id = job.tenant_id
      AND artifact.artifact_id = job.artifact_id
)
WHERE EXISTS (
    SELECT 1
    FROM media_artifacts artifact
    WHERE artifact.tenant_id = job.tenant_id
      AND artifact.artifact_id = job.artifact_id
);
-- END V008__media_job_artifact_content_version.sql

-- BEGIN V009__media_job_attempts_and_outbox.sql sha256=db57c348b7475c3fc1431a99dda67d55a6ecfb78a291ea600bd0ed4691f80454
CREATE TABLE IF NOT EXISTS media_processing_job_attempts (
    tenant_id VARCHAR(255) NOT NULL,
    job_id VARCHAR(255) NOT NULL,
    attempt_number INTEGER NOT NULL,
    provider_id VARCHAR(255) NOT NULL,
    request_id VARCHAR(255) NOT NULL,
    fencing_token BIGINT NOT NULL,
    status VARCHAR(32) NOT NULL,
    created_at BIGINT NOT NULL,
    completed_at BIGINT,
    outcome_code VARCHAR(128) NOT NULL,
    PRIMARY KEY (tenant_id, job_id, attempt_number),
    CONSTRAINT fk_media_job_attempt FOREIGN KEY (tenant_id, job_id)
        REFERENCES media_processing_jobs(tenant_id, job_id) ON DELETE CASCADE,
    CONSTRAINT media_job_attempt_status_check
        CHECK (status IN ('DISPATCH_INTENT','RUNNING','COMPLETED','FAILED','OUTCOME_UNKNOWN'))
);

CREATE INDEX IF NOT EXISTS idx_media_job_attempt_reconciliation
    ON media_processing_job_attempts (tenant_id, job_id, status, attempt_number DESC);

CREATE TABLE IF NOT EXISTS media_job_dispatch_intents (
    tenant_id VARCHAR(255) NOT NULL,
    job_id VARCHAR(255) NOT NULL,
    attempt_number INTEGER NOT NULL,
    provider_id VARCHAR(255) NOT NULL,
    request_id VARCHAR(255) NOT NULL,
    fencing_token BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, job_id, attempt_number),
    CONSTRAINT fk_media_job_dispatch_intent FOREIGN KEY (tenant_id, job_id, attempt_number)
        REFERENCES media_processing_job_attempts(tenant_id, job_id, attempt_number) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS media_lifecycle_outbox (
    event_id UUID PRIMARY KEY,
    tenant_id VARCHAR(512) NOT NULL,
    subject_id VARCHAR(512) NOT NULL,
    event_type VARCHAR(128) NOT NULL,
    payload_json TEXT NOT NULL,
    occurred_at BIGINT NOT NULL,
    correlation_id VARCHAR(512),
    publication_attempts INTEGER NOT NULL DEFAULT 0,
    published_at BIGINT,
    failed_at BIGINT,
    failure_code VARCHAR(128),
    claim_owner VARCHAR(255),
    claim_token UUID,
    claim_expires_at BIGINT,
    created_at BIGINT NOT NULL,
    CONSTRAINT media_lifecycle_outbox_attempts_check CHECK (publication_attempts >= 0)
);

CREATE INDEX IF NOT EXISTS idx_media_lifecycle_outbox_pending
    ON media_lifecycle_outbox (published_at, claim_expires_at, created_at, event_id);
-- END V009__media_job_attempts_and_outbox.sql

-- BEGIN V010__media_artifact_format_verification.sql sha256=e3438c15f638eeb9cd55abedce4b4a9816fcb374aa9196fafc74606fbb50f5c9
CREATE TABLE IF NOT EXISTS media_artifact_format_verifications (
    tenant_id VARCHAR(255) NOT NULL,
    upload_id VARCHAR(255) NOT NULL,
    artifact_id VARCHAR(255),
    policy_version VARCHAR(128) NOT NULL,
    state VARCHAR(32) NOT NULL,
    claimed_file_name VARCHAR(1024) NOT NULL,
    claimed_content_type VARCHAR(255) NOT NULL,
    detected_format VARCHAR(64) NOT NULL,
    detail VARCHAR(255) NOT NULL,
    checked_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, upload_id),
    CONSTRAINT fk_media_format_verification_upload FOREIGN KEY (tenant_id, upload_id)
        REFERENCES media_upload_sessions(tenant_id, upload_id) ON DELETE CASCADE,
    CONSTRAINT fk_media_format_verification_artifact FOREIGN KEY (tenant_id, artifact_id)
        REFERENCES media_artifacts(tenant_id, artifact_id) ON DELETE CASCADE,
    CONSTRAINT media_format_verification_state_check
        CHECK (state IN ('SIGNATURE_MATCH','SIGNATURE_UNRECOGNIZED','SIGNATURE_MISMATCH'))
);

CREATE INDEX IF NOT EXISTS idx_media_format_verification_state
    ON media_artifact_format_verifications (tenant_id, state, checked_at DESC);
-- END V010__media_artifact_format_verification.sql

-- BEGIN V011__media_job_submission_digest.sql sha256=ed2df1e589003ccd736ae62f1fe2e92b5574089dba939e647cfc0beeedaad656
ALTER TABLE media_processing_jobs
    ADD COLUMN submission_digest VARCHAR(64) NOT NULL DEFAULT '';
-- END V011__media_job_submission_digest.sql

-- BEGIN V012__media_outbox_delivery_attempts.sql sha256=845f9e376b1f574d11ff5704c6f102199513c9f4149e1eb34399088e8708fd6f
CREATE TABLE IF NOT EXISTS media_lifecycle_outbox_delivery_attempts (
    event_id UUID NOT NULL,
    attempt_number INTEGER NOT NULL,
    claim_owner VARCHAR(255) NOT NULL,
    claim_token UUID NOT NULL,
    payload_fingerprint CHAR(64) NOT NULL,
    claimed_at BIGINT NOT NULL,
    claim_expires_at BIGINT NOT NULL,
    broker_accepted_at BIGINT,
    status VARCHAR(32) NOT NULL,
    failure_code VARCHAR(128),
    PRIMARY KEY (event_id, attempt_number),
    CONSTRAINT fk_media_outbox_delivery_attempt FOREIGN KEY (event_id)
        REFERENCES media_lifecycle_outbox(event_id) ON DELETE CASCADE,
    CONSTRAINT media_outbox_delivery_attempt_number_check CHECK (attempt_number > 0),
    CONSTRAINT media_outbox_delivery_attempt_fingerprint_check CHECK (CHAR_LENGTH(payload_fingerprint) = 64),
    CONSTRAINT media_outbox_delivery_attempt_status_check
        CHECK (status IN ('CLAIMED', 'PUBLISHED', 'FAILED', 'CLAIM_RELEASED', 'OUTCOME_UNKNOWN'))
);

CREATE INDEX IF NOT EXISTS idx_media_outbox_delivery_attempt_claim
    ON media_lifecycle_outbox_delivery_attempts (claim_token, status);

COMMENT ON TABLE media_lifecycle_outbox_delivery_attempts IS
    'Durable per-claim delivery evidence. PUBLISHED records broker acceptance plus Media acknowledgement; it is not consumer observation.';

CREATE TABLE IF NOT EXISTS media_lifecycle_outbox_publisher_lease (
    publisher_key VARCHAR(64) PRIMARY KEY,
    claim_owner VARCHAR(255),
    claim_token UUID,
    claim_expires_at BIGINT,
    CONSTRAINT media_outbox_publisher_lease_key_check CHECK (publisher_key = 'media-lifecycle')
);

INSERT INTO media_lifecycle_outbox_publisher_lease (publisher_key)
VALUES ('media-lifecycle');
-- END V012__media_outbox_delivery_attempts.sql

-- BEGIN V013__media_artifact_quarantine_and_lineage.sql sha256=804bf943a2a0fe7fa35bf9d2c9585e9220e2df7560d146cc0894d4212fbe8efb
-- Artifact safety and provenance metadata. Scan evidence is separate from caller metadata and
-- remains UNVERIFIED until a trusted scanner records a decision.
ALTER TABLE media_upload_sessions
    ADD COLUMN IF NOT EXISTS scan_status VARCHAR(24) NOT NULL DEFAULT 'UNVERIFIED';
ALTER TABLE media_upload_sessions ADD COLUMN IF NOT EXISTS scan_policy_version VARCHAR(255);
ALTER TABLE media_upload_sessions ADD COLUMN IF NOT EXISTS scanner_id VARCHAR(255);
ALTER TABLE media_upload_sessions ADD COLUMN IF NOT EXISTS scanned_at BIGINT;

ALTER TABLE media_upload_sessions
    ADD CONSTRAINT media_upload_scan_status_check
    CHECK (scan_status IN ('UNVERIFIED','PENDING','CLEAN','REJECTED','UNAVAILABLE'));

ALTER TABLE media_artifacts
    ADD COLUMN IF NOT EXISTS scan_status VARCHAR(24) NOT NULL DEFAULT 'UNVERIFIED';
ALTER TABLE media_artifacts ADD COLUMN IF NOT EXISTS scan_policy_version VARCHAR(255);
ALTER TABLE media_artifacts ADD COLUMN IF NOT EXISTS scanner_id VARCHAR(255);
ALTER TABLE media_artifacts ADD COLUMN IF NOT EXISTS scanned_at BIGINT;
ALTER TABLE media_artifacts ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE media_artifacts
    ADD CONSTRAINT media_artifact_scan_status_check
    CHECK (scan_status IN ('UNVERIFIED','PENDING','CLEAN','REJECTED','UNAVAILABLE'));

CREATE TABLE IF NOT EXISTS media_artifact_lineage (
    tenant_id VARCHAR(255) NOT NULL,
    derived_artifact_id VARCHAR(255) NOT NULL,
    derived_version VARCHAR(71) NOT NULL,
    source_artifact_id VARCHAR(255) NOT NULL,
    source_version VARCHAR(71) NOT NULL,
    job_id VARCHAR(255) NOT NULL,
    processing_profile VARCHAR(255) NOT NULL,
    rights_decision_id VARCHAR(255) NOT NULL,
    consent_decision_id VARCHAR(255) NOT NULL,
    policy_version VARCHAR(255) NOT NULL,
    admission_status VARCHAR(24) NOT NULL DEFAULT 'CANDIDATE',
    created_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, derived_artifact_id, derived_version),
    CONSTRAINT fk_media_lineage_derived FOREIGN KEY (tenant_id, derived_artifact_id)
        REFERENCES media_artifacts(tenant_id, artifact_id),
    CONSTRAINT fk_media_lineage_source FOREIGN KEY (tenant_id, source_artifact_id)
        REFERENCES media_artifacts(tenant_id, artifact_id),
    CONSTRAINT fk_media_lineage_job FOREIGN KEY (tenant_id, job_id)
        REFERENCES media_processing_jobs(tenant_id, job_id),
    CONSTRAINT media_lineage_admission_status_check CHECK (admission_status IN ('CANDIDATE','VERIFIED')),
    CONSTRAINT media_lineage_version_length CHECK (
        LENGTH(derived_version) = 71 AND SUBSTRING(derived_version, 1, 7) = 'sha256:'
        AND LENGTH(source_version) = 71 AND SUBSTRING(source_version, 1, 7) = 'sha256:'
    )
);

CREATE INDEX IF NOT EXISTS idx_media_artifact_lineage_source
    ON media_artifact_lineage (tenant_id, source_artifact_id, source_version);
-- END V013__media_artifact_quarantine_and_lineage.sql

-- BEGIN V014__media_attempt_finality_and_lifecycle_outbox.sql sha256=5eb66603a65e1bfc311f12e0fd6121cdd926fae5290b06f269c90d0f6439aa53
CREATE TABLE IF NOT EXISTS media_processing_attempts (
    tenant_id VARCHAR(255) NOT NULL,
    job_id VARCHAR(255) NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    request_id VARCHAR(255) NOT NULL,
    provider_id VARCHAR(255) NOT NULL,
    request_fingerprint VARCHAR(64) NOT NULL,
    lease_owner VARCHAR(255) NOT NULL,
    fencing_token BIGINT NOT NULL,
    state VARCHAR(32) NOT NULL,
    provider_operation_id VARCHAR(512),
    provider_receipt_id VARCHAR(512),
    result_json TEXT NOT NULL,
    result_digest VARCHAR(64),
    provenance_json TEXT NOT NULL,
    observation_json TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    observed_at BIGINT,
    PRIMARY KEY (tenant_id, job_id, attempt_number),
    CONSTRAINT fk_media_attempt_job FOREIGN KEY (tenant_id, job_id)
        REFERENCES media_processing_jobs(tenant_id, job_id),
    CONSTRAINT uk_media_attempt_fence UNIQUE (tenant_id, job_id, fencing_token),
    CONSTRAINT media_attempt_state_check CHECK (state IN (
        'DISPATCH_INTENDED','OUTCOME_UNKNOWN','SUCCEEDED','FAILED','NO_EFFECT_PROVEN'
    )),
    CONSTRAINT media_attempt_fingerprint_length CHECK (LENGTH(request_fingerprint) = 64),
    CONSTRAINT media_attempt_result_digest_check CHECK (
        result_digest IS NULL OR LENGTH(result_digest) = 64
    )
);

CREATE INDEX IF NOT EXISTS idx_media_attempt_recovery
    ON media_processing_attempts (tenant_id, state, updated_at);

CREATE TABLE IF NOT EXISTS media_processing_lifecycle_outbox (
    event_id VARCHAR(255) PRIMARY KEY,
    tenant_id VARCHAR(255) NOT NULL,
    aggregate_type VARCHAR(128) NOT NULL,
    aggregate_id VARCHAR(255) NOT NULL,
    aggregate_version BIGINT NOT NULL,
    event_type VARCHAR(255) NOT NULL,
    payload_json TEXT NOT NULL,
    classification VARCHAR(64) NOT NULL,
    created_at BIGINT NOT NULL,
    published_at BIGINT,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error TEXT,
    CONSTRAINT uk_media_processing_lifecycle_outbox_identity UNIQUE (
        tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type
    )
);

CREATE INDEX IF NOT EXISTS idx_media_processing_lifecycle_outbox_unpublished
    ON media_processing_lifecycle_outbox (published_at, created_at, event_id);
-- END V014__media_attempt_finality_and_lifecycle_outbox.sql

-- BEGIN V015__media_transcript_revisions.sql sha256=d2e3137fa658d53589caae47e0dd4b825058d4720a56ba2746c5e7f84795ef78
-- Transcript content is immutable and revisioned. Rights/profile admission remains candidate-only.
CREATE TABLE IF NOT EXISTS media_transcript_revisions (
    tenant_id VARCHAR(255) NOT NULL,
    transcript_id VARCHAR(255) NOT NULL,
    revision INTEGER NOT NULL,
    principal_id VARCHAR(255) NOT NULL,
    source_artifact_id VARCHAR(255) NOT NULL,
    source_artifact_version VARCHAR(71) NOT NULL,
    source_sha256 VARCHAR(64) NOT NULL,
    job_id VARCHAR(255) NOT NULL,
    profile_id VARCHAR(255) NOT NULL,
    provider_id VARCHAR(255) NOT NULL,
    model_id VARCHAR(255) NOT NULL,
    language VARCHAR(64) NOT NULL,
    timebase VARCHAR(255) NOT NULL,
    transcript_text TEXT NOT NULL,
    consent_decision_id VARCHAR(255) NOT NULL,
    rights_decision_id VARCHAR(255) NOT NULL,
    policy_version VARCHAR(255) NOT NULL,
    admission_status VARCHAR(24) NOT NULL DEFAULT 'CANDIDATE',
    created_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, transcript_id, revision),
    CONSTRAINT fk_media_transcript_source FOREIGN KEY (tenant_id, source_artifact_id)
        REFERENCES media_artifacts(tenant_id, artifact_id),
    CONSTRAINT fk_media_transcript_job FOREIGN KEY (tenant_id, job_id)
        REFERENCES media_processing_jobs(tenant_id, job_id),
    CONSTRAINT media_transcript_revision_check CHECK (revision > 0),
    CONSTRAINT media_transcript_digest_check CHECK (LENGTH(source_sha256) = 64),
    CONSTRAINT media_transcript_version_check CHECK (
        LENGTH(source_artifact_version) = 71 AND SUBSTRING(source_artifact_version, 1, 7) = 'sha256:'
    ),
    CONSTRAINT media_transcript_admission_check CHECK (admission_status = 'CANDIDATE')
);

CREATE INDEX IF NOT EXISTS idx_media_transcript_source
    ON media_transcript_revisions (tenant_id, source_artifact_id, source_artifact_version);
CREATE INDEX IF NOT EXISTS idx_media_transcript_job
    ON media_transcript_revisions (tenant_id, job_id, transcript_id, revision);
-- END V015__media_transcript_revisions.sql

-- BEGIN V016__media_lifecycle_outbox_leases.sql sha256=0156a7f668892758e0b77d813a608d5961ba49ee71accff388181337b0c62271
-- Lease claims and delayed, bounded retries for durable lifecycle publication.
ALTER TABLE media_processing_lifecycle_outbox ADD COLUMN IF NOT EXISTS claim_owner VARCHAR(255);
ALTER TABLE media_processing_lifecycle_outbox ADD COLUMN IF NOT EXISTS claim_token BIGINT NOT NULL DEFAULT 0;
ALTER TABLE media_processing_lifecycle_outbox ADD COLUMN IF NOT EXISTS claim_expires_at BIGINT;
ALTER TABLE media_processing_lifecycle_outbox ADD COLUMN IF NOT EXISTS next_attempt_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE media_processing_lifecycle_outbox ADD COLUMN IF NOT EXISTS dead_lettered_at BIGINT;
ALTER TABLE media_processing_lifecycle_outbox ADD COLUMN IF NOT EXISTS dead_letter_reason VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_media_processing_lifecycle_outbox_eligible
    ON media_processing_lifecycle_outbox (published_at, dead_lettered_at, next_attempt_at, claim_expires_at, created_at, event_id);
-- END V016__media_lifecycle_outbox_leases.sql

-- Synthetic IP-06 rows; no customer or deployed database data.
INSERT INTO media_artifacts
  (tenant_id,artifact_id,file_name,content_type,size_bytes,sha256,object_reference,
   classification,created_at,expires_at,metadata_json) VALUES
  ('ip06-tenant','ip06-artifact','legacy.wav','audio/wav',128,
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
   's3://fixture/ip06','INTERNAL',1700000000000,1800000000000,'{}');
INSERT INTO media_processing_jobs
  (tenant_id,job_id,request_id,artifact_id,job_type,provider_id,status,created_at,
   result_json,failure_code,version) VALUES
  ('ip06-tenant','ip06-job','ip06-request','ip06-artifact','STT','fixture-provider',
   'COMPLETED',1700000000000,'{"legacy":true}','',1);
INSERT INTO media_transcript_revisions
  (tenant_id,transcript_id,revision,principal_id,source_artifact_id,source_artifact_version,
   source_sha256,job_id,profile_id,provider_id,model_id,language,timebase,transcript_text,
   consent_decision_id,rights_decision_id,policy_version,created_at) VALUES
  ('ip06-tenant','ip06-transcript',1,'fixture-principal','ip06-artifact',
   'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','ip06-job',
   'fixture-profile','fixture-provider','fixture-model','en','milliseconds',
   'synthetic legacy transcript','fixture-consent','fixture-rights','fixture-policy',
   1700000001000);
INSERT INTO media_processing_lifecycle_outbox
  (event_id,tenant_id,aggregate_type,aggregate_id,aggregate_version,event_type,
   payload_json,classification,created_at) VALUES
  ('ip06-event','ip06-tenant','MEDIA_JOB','ip06-job',1,'MEDIA_JOB_COMPLETED',
   '{"legacy":true}','INTERNAL',1700000002000);

-- Manifest-backed applied-history projection; not a PostgreSQL readback.
CREATE TABLE flyway_schema_history_manifest_projection (
  version VARCHAR(50) NOT NULL, description VARCHAR(200) NOT NULL,
  script VARCHAR(1000) NOT NULL, checksum INTEGER NOT NULL, success BOOLEAN NOT NULL
);
INSERT INTO flyway_schema_history_manifest_projection (version,description,script,checksum,success) VALUES ('001','media runtime state','V001__media_runtime_state.sql',2011091060,TRUE);
INSERT INTO flyway_schema_history_manifest_projection (version,description,script,checksum,success) VALUES ('002','media upload finalization claim','V002__media_upload_finalization_claim.sql',-1739934140,TRUE);
INSERT INTO flyway_schema_history_manifest_projection (version,description,script,checksum,success) VALUES ('003','media consent authority','V003__media_consent_authority.sql',-1700736947,TRUE);
INSERT INTO flyway_schema_history_manifest_projection (version,description,script,checksum,success) VALUES ('004','media principal ownership','V004__media_principal_ownership.sql',-106672087,TRUE);
INSERT INTO flyway_schema_history_manifest_projection (version,description,script,checksum,success) VALUES ('005','media job worker lease','V005__media_job_worker_lease.sql',-1755849979,TRUE);
INSERT INTO flyway_schema_history_manifest_projection (version,description,script,checksum,success) VALUES ('006','media job cancellation truth','V006__media_job_cancellation_truth.sql',1500389172,TRUE);
INSERT INTO flyway_schema_history_manifest_projection (version,description,script,checksum,success) VALUES ('007','media job unknown provider outcome','V007__media_job_unknown_provider_outcome.sql',-2036800623,TRUE);
INSERT INTO flyway_schema_history_manifest_projection (version,description,script,checksum,success) VALUES ('008','media job artifact content version','V008__media_job_artifact_content_version.sql',-863726996,TRUE);
INSERT INTO flyway_schema_history_manifest_projection (version,description,script,checksum,success) VALUES ('009','media job attempts and outbox','V009__media_job_attempts_and_outbox.sql',-392192638,TRUE);
INSERT INTO flyway_schema_history_manifest_projection (version,description,script,checksum,success) VALUES ('010','media artifact format verification','V010__media_artifact_format_verification.sql',-2015988551,TRUE);
INSERT INTO flyway_schema_history_manifest_projection (version,description,script,checksum,success) VALUES ('011','media job submission digest','V011__media_job_submission_digest.sql',-1104155036,TRUE);
INSERT INTO flyway_schema_history_manifest_projection (version,description,script,checksum,success) VALUES ('012','media outbox delivery attempts','V012__media_outbox_delivery_attempts.sql',1299987228,TRUE);
INSERT INTO flyway_schema_history_manifest_projection (version,description,script,checksum,success) VALUES ('013','media artifact quarantine and lineage','V013__media_artifact_quarantine_and_lineage.sql',-1451326476,TRUE);
INSERT INTO flyway_schema_history_manifest_projection (version,description,script,checksum,success) VALUES ('014','media attempt finality and lifecycle outbox','V014__media_attempt_finality_and_lifecycle_outbox.sql',548832866,TRUE);
INSERT INTO flyway_schema_history_manifest_projection (version,description,script,checksum,success) VALUES ('015','media transcript revisions','V015__media_transcript_revisions.sql',659110515,TRUE);
INSERT INTO flyway_schema_history_manifest_projection (version,description,script,checksum,success) VALUES ('016','media lifecycle outbox leases','V016__media_lifecycle_outbox_leases.sql',-1645731082,TRUE);
