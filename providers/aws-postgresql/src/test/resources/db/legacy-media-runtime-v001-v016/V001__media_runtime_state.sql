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
