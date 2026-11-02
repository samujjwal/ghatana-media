ALTER TABLE media_upload_sessions
    ADD COLUMN IF NOT EXISTS finalization_token VARCHAR(255);
ALTER TABLE media_upload_sessions
    ADD COLUMN IF NOT EXISTS finalization_started_at BIGINT;

CREATE INDEX IF NOT EXISTS idx_media_upload_finalizing
    ON media_upload_sessions (status, finalization_started_at);
