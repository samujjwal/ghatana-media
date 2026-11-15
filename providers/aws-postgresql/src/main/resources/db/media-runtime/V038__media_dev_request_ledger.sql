-- Durable request ledger for the DEV_ONLY local-model lanes (speech STT/TTS, caption correction, vision
-- tracking/ROI, grounded answers).
--
-- Local model output is not byte-reproducible (GPU contention changes it), so a lane cannot make a retry idempotent
-- by re-running the model and comparing bytes. This ledger maps (tenant, principal, lane, requestId) to the SHA-256
-- fingerprint of the canonical request (exact input versions plus parameters) and, once the lane completes, to the
-- registered output artifact ids and versions. A retry looks the key up BEFORE running a model: a COMPLETED row with
-- the same fingerprint replays the stored output; a different fingerprint is a reused requestId.
--
-- An IN_PROGRESS row carries a bounded lease and a monotonically increasing fencing token. A stale lease (the owner
-- crashed) can be taken over under a higher token; the outcome of the superseded run stays UNKNOWN, and its late
-- completion is refused because the token no longer matches, so nothing is registered or recorded twice.
-- RELEASED means the owner reported a failure that registered nothing, so a retry runs again.
-- The ledger is never an authority for rights: lanes re-check rights on every call, replays included.
CREATE TABLE media_dev_request_ledger (
    tenant_id VARCHAR(255) NOT NULL,
    principal_id VARCHAR(255) NOT NULL,
    lane VARCHAR(64) NOT NULL,
    request_id VARCHAR(128) NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    state VARCHAR(16) NOT NULL,
    lease_owner VARCHAR(128) NOT NULL,
    lease_token BIGINT NOT NULL,
    lease_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    attempts INTEGER NOT NULL,
    outputs_json TEXT NOT NULL DEFAULT '[]',
    last_failure_code VARCHAR(128) NOT NULL DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (tenant_id, principal_id, lane, request_id),
    CONSTRAINT media_dev_request_ledger_state_check CHECK (state IN ('IN_PROGRESS', 'COMPLETED', 'RELEASED')),
    CONSTRAINT media_dev_request_ledger_token_check CHECK (lease_token >= 1 AND attempts >= 1),
    CONSTRAINT media_dev_request_ledger_completed_check CHECK (
        (state = 'COMPLETED' AND completed_at IS NOT NULL AND outputs_json <> '[]')
        OR (state <> 'COMPLETED' AND completed_at IS NULL))
);

CREATE INDEX idx_media_dev_request_ledger_open
    ON media_dev_request_ledger (state, lease_expires_at);
