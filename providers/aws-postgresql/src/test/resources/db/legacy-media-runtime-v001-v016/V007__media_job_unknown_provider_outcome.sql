-- A caller-side timeout cannot establish whether a provider applied its effect.
-- Keep this durable state distinct from FAILED so retries cannot duplicate an unknown effect.
ALTER TABLE media_processing_jobs
    DROP CONSTRAINT IF EXISTS media_job_status_check;

ALTER TABLE media_processing_jobs
    ADD CONSTRAINT media_job_status_check
    CHECK (status IN ('ACCEPTED','RUNNING','COMPLETED','FAILED','CANCELLED','OUTCOME_UNKNOWN'));
