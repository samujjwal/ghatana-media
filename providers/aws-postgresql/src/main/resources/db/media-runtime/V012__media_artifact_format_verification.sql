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
