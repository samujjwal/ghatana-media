-- Lease claims and delayed, bounded retries for durable lifecycle publication.
ALTER TABLE media_processing_lifecycle_outbox ADD COLUMN IF NOT EXISTS claim_owner VARCHAR(255);
ALTER TABLE media_processing_lifecycle_outbox ADD COLUMN IF NOT EXISTS claim_token BIGINT NOT NULL DEFAULT 0;
ALTER TABLE media_processing_lifecycle_outbox ADD COLUMN IF NOT EXISTS claim_expires_at BIGINT;
ALTER TABLE media_processing_lifecycle_outbox ADD COLUMN IF NOT EXISTS next_attempt_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE media_processing_lifecycle_outbox ADD COLUMN IF NOT EXISTS dead_lettered_at BIGINT;
ALTER TABLE media_processing_lifecycle_outbox ADD COLUMN IF NOT EXISTS dead_letter_reason VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_media_processing_lifecycle_outbox_eligible
    ON media_processing_lifecycle_outbox (published_at, dead_lettered_at, next_attempt_at, claim_expires_at, created_at, event_id);
