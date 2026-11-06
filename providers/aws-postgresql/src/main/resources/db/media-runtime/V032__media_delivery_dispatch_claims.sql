ALTER TABLE media_delivery_operations
    ADD COLUMN IF NOT EXISTS dispatch_claim_owner_id VARCHAR(255);

ALTER TABLE media_delivery_operations
    ADD COLUMN IF NOT EXISTS dispatch_claim_fence BIGINT NOT NULL DEFAULT 0;

ALTER TABLE media_delivery_operations
    ADD COLUMN IF NOT EXISTS dispatch_claim_expires_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE media_delivery_operations
    ADD CONSTRAINT media_delivery_claim_shape_check CHECK (
        (dispatch_claim_owner_id IS NULL AND dispatch_claim_expires_at IS NULL)
        OR (dispatch_claim_owner_id IS NOT NULL AND dispatch_claim_expires_at IS NOT NULL
            AND dispatch_claim_fence > 0)
    );

COMMENT ON COLUMN media_delivery_operations.dispatch_claim_fence IS
    'Monotonic operation-scoped dispatch fencing token; destinations must reject stale tokens.';
