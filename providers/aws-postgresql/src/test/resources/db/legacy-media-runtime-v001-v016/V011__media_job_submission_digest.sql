ALTER TABLE media_processing_jobs
    ADD COLUMN submission_digest VARCHAR(64) NOT NULL DEFAULT '';
