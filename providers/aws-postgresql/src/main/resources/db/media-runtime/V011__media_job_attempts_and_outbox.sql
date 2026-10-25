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
