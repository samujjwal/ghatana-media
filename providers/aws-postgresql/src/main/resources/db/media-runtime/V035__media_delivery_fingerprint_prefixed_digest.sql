-- MediaDeliveryEngine derives request_fingerprint as MediaCreationContracts.sha256(...), which is the
-- prefixed form "sha256:<64 hex>" (71 chars). V031 declared CHAR(64) with a length-64 check, so the first
-- real engine insert failed. Applied migrations are immutable; widen the column and accept exactly the
-- bare 64-hex form (existing rows/tests) or the prefixed 71-char form.
ALTER TABLE media_delivery_operations DROP CONSTRAINT IF EXISTS media_delivery_fingerprint_check;
ALTER TABLE media_delivery_operations ALTER COLUMN request_fingerprint TYPE VARCHAR(80);
ALTER TABLE media_delivery_operations ADD CONSTRAINT media_delivery_fingerprint_check
    CHECK (request_fingerprint ~ '^([0-9a-f]{64}|sha256:[0-9a-f]{64})$' OR CHAR_LENGTH(request_fingerprint) = 64);
