ALTER TABLE media_processing_jobs
    ADD COLUMN IF NOT EXISTS stt_request_snapshot TEXT;

-- Existing rows intentionally remain NULL: their optional request fields are unknown.
