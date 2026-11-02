CREATE TABLE IF NOT EXISTS media_lifecycle_outbox_delivery_attempts (
    event_id UUID NOT NULL,
    attempt_number INTEGER NOT NULL,
    claim_owner VARCHAR(255) NOT NULL,
    claim_token UUID NOT NULL,
    payload_fingerprint CHAR(64) NOT NULL,
    claimed_at BIGINT NOT NULL,
    claim_expires_at BIGINT NOT NULL,
    broker_accepted_at BIGINT,
    status VARCHAR(32) NOT NULL,
    failure_code VARCHAR(128),
    PRIMARY KEY (event_id, attempt_number),
    CONSTRAINT fk_media_outbox_delivery_attempt FOREIGN KEY (event_id)
        REFERENCES media_lifecycle_outbox(event_id) ON DELETE CASCADE,
    CONSTRAINT media_outbox_delivery_attempt_number_check CHECK (attempt_number > 0),
    CONSTRAINT media_outbox_delivery_attempt_fingerprint_check CHECK (CHAR_LENGTH(payload_fingerprint) = 64),
    CONSTRAINT media_outbox_delivery_attempt_status_check
        CHECK (status IN ('CLAIMED', 'PUBLISHED', 'FAILED', 'CLAIM_RELEASED', 'OUTCOME_UNKNOWN'))
);

CREATE INDEX IF NOT EXISTS idx_media_outbox_delivery_attempt_claim
    ON media_lifecycle_outbox_delivery_attempts (claim_token, status);

COMMENT ON TABLE media_lifecycle_outbox_delivery_attempts IS
    'Durable per-claim delivery evidence. PUBLISHED records broker acceptance plus Media acknowledgement; it is not consumer observation.';

CREATE TABLE IF NOT EXISTS media_lifecycle_outbox_publisher_lease (
    publisher_key VARCHAR(64) PRIMARY KEY,
    claim_owner VARCHAR(255),
    claim_token UUID,
    claim_expires_at BIGINT,
    CONSTRAINT media_outbox_publisher_lease_key_check CHECK (publisher_key = 'media-lifecycle')
);

INSERT INTO media_lifecycle_outbox_publisher_lease (publisher_key)
VALUES ('media-lifecycle');
