-- Bind each candidate transcript revision to its exact purpose reference.
-- Existing revisions remain explicitly unbound; new application appends reject that sentinel.
ALTER TABLE media_transcript_revisions
    ADD COLUMN IF NOT EXISTS purpose_ref VARCHAR(256) NOT NULL
        DEFAULT '__UNBOUND_PURPOSE_REF__';

ALTER TABLE media_transcript_revisions
    ADD COLUMN IF NOT EXISTS processing_purpose VARCHAR(255) NOT NULL
        DEFAULT '__UNRESOLVED_PROCESSING_PURPOSE__';

ALTER TABLE media_transcript_revisions
    ADD CONSTRAINT media_transcript_purpose_binding_check
        CHECK (LENGTH(TRIM(purpose_ref)) > 0 AND LENGTH(TRIM(processing_purpose)) > 0);
