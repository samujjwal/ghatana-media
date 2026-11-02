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
