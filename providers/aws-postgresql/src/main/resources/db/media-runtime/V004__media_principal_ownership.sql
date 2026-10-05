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
