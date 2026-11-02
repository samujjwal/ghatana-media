-- A provider cancellation that is not confirmed is not a terminal outcome.
-- Keep the job non-terminal so provider completion/recovery can establish authoritative truth.
-- The cancellationOutcome column records the provider's confirmed or unconfirmed response.
ALTER TABLE media_processing_jobs
    ADD COLUMN IF NOT EXISTS cancellationOutcome VARCHAR(32)
    CHECK (cancellationOutcome IS NULL
        OR cancellationOutcome IN ('CONFIRMED', 'REQUESTED_UNCONFIRMED', 'UNSUPPORTED'));

ALTER TABLE media_processing_jobs
    ADD CONSTRAINT media_job_cancelled_requires_confirmation
    CHECK (
        NOT (
            status = 'CANCELLED'
            AND cancellationOutcome IS DISTINCT FROM 'CONFIRMED'
            AND failure_code IN (
                'CANCELLED_UNCONFIRMED',
                'CANCELLATION_REQUESTED_UNCONFIRMED',
                'CANCELLATION_UNSUPPORTED'
            )
        )
    );
