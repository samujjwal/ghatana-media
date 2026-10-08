-- Legacy rows cannot prove the exact request payload that created them. Keep the column nullable
-- so migrations preserve history; reads normalize NULL to blank and replay admission fails closed.
ALTER TABLE media_processing_jobs
    ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;
