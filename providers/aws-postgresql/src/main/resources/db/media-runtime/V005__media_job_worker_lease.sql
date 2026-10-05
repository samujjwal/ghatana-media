ALTER TABLE media_processing_jobs
    ADD COLUMN IF NOT EXISTS lease_owner VARCHAR(255);
ALTER TABLE media_processing_jobs
    ADD COLUMN IF NOT EXISTS lease_token BIGINT NOT NULL DEFAULT 0;
ALTER TABLE media_processing_jobs
    ADD COLUMN IF NOT EXISTS lease_expires_at BIGINT;

CREATE INDEX IF NOT EXISTS idx_media_jobs_worker_lease
    ON media_processing_jobs (status, lease_expires_at);
