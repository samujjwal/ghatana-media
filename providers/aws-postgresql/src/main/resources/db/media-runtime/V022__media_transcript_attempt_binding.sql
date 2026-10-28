-- Bind each candidate transcript revision to the exact successful durable provider attempt.
CREATE TABLE IF NOT EXISTS media_transcript_attempt_bindings (
    tenant_id VARCHAR(255) NOT NULL,
    transcript_id VARCHAR(255) NOT NULL,
    transcript_revision INTEGER NOT NULL,
    job_id VARCHAR(255) NOT NULL,
    attempt_number INTEGER NOT NULL,
    fencing_token BIGINT NOT NULL,
    provider_id VARCHAR(255) NOT NULL,
    provider_operation_id VARCHAR(512) NOT NULL,
    provider_receipt_id VARCHAR(512) NOT NULL,
    request_fingerprint VARCHAR(64) NOT NULL,
    source_artifact_version_ref VARCHAR(384) NOT NULL,
    transcript_version_ref VARCHAR(384) NOT NULL,
    result_digest VARCHAR(64) NOT NULL,
    PRIMARY KEY (tenant_id, transcript_id, transcript_revision),
    CONSTRAINT fk_media_transcript_attempt_revision FOREIGN KEY (tenant_id, transcript_id, transcript_revision)
        REFERENCES media_transcript_revisions(tenant_id, transcript_id, revision) ON DELETE CASCADE,
    CONSTRAINT fk_media_transcript_attempt_exact FOREIGN KEY (tenant_id, job_id, attempt_number)
        REFERENCES media_processing_attempts(tenant_id, job_id, attempt_number),
    CONSTRAINT media_transcript_attempt_binding_check CHECK (
        attempt_number > 0 AND fencing_token > 0 AND LENGTH(request_fingerprint) = 64
        AND LENGTH(result_digest) = 64 AND LENGTH(TRIM(provider_operation_id)) > 0
        AND LENGTH(TRIM(provider_receipt_id)) > 0
    )
);
