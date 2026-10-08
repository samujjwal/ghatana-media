-- A process restart after dispatch leaves the provider outcome unknown, not failed.
-- Keep the job state vocabulary explicit so runtime reconciliation can preserve that distinction.
ALTER TABLE media_processing_jobs
    DROP CONSTRAINT IF EXISTS media_job_status_check;

ALTER TABLE media_processing_jobs
    ADD CONSTRAINT media_job_status_check
    CHECK (status IN ('ACCEPTED','RUNNING','OUTCOME_UNKNOWN','COMPLETED','FAILED','CANCELLED'));
