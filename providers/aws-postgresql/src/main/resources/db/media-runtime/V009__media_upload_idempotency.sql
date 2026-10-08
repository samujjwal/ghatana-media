ALTER TABLE media_upload_sessions
    ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);
ALTER TABLE media_upload_sessions
    ADD COLUMN IF NOT EXISTS request_fingerprint VARCHAR(80);

-- Older sessions intentionally remain without keys/fingerprints. New requests always write both;
-- readers fail closed if a keyed legacy row has no digest rather than guessing replay equivalence.
CREATE UNIQUE INDEX IF NOT EXISTS uk_media_upload_idempotency
    ON media_upload_sessions (tenant_id, principal_id, idempotency_key);
