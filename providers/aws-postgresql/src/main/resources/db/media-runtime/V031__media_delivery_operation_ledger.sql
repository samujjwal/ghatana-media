CREATE TABLE IF NOT EXISTS media_delivery_operations (
    tenant_id VARCHAR(255) NOT NULL,
    request_id VARCHAR(255) NOT NULL,
    principal_id VARCHAR(255) NOT NULL,
    artifact_id VARCHAR(255) NOT NULL,
    version_ref VARCHAR(512) NOT NULL,
    artifact_digest VARCHAR(80) NOT NULL,
    destination_ref VARCHAR(512) NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL,
    acknowledged_bytes INTEGER NOT NULL DEFAULT 0,
    destination_receipt_ref VARCHAR(512),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, request_id),
    CONSTRAINT media_delivery_fingerprint_check CHECK (CHAR_LENGTH(request_fingerprint) = 64),
    CONSTRAINT media_delivery_status_check CHECK (status IN (
        'QUEUED', 'SENT', 'DESTINATION_CONFIRMED', 'OUTCOME_UNKNOWN', 'REVOKED', 'UNAVAILABLE'
    )),
    CONSTRAINT media_delivery_acknowledged_bytes_check CHECK (acknowledged_bytes BETWEEN 0 AND 67108864),
    CONSTRAINT media_delivery_receipt_check CHECK (
        (status = 'DESTINATION_CONFIRMED' AND destination_receipt_ref IS NOT NULL)
        OR (status <> 'DESTINATION_CONFIRMED' AND destination_receipt_ref IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_media_delivery_operations_updated
    ON media_delivery_operations (tenant_id, updated_at);

COMMENT ON TABLE media_delivery_operations IS
    'Internal Media export operation state and exact artifact version identity; destination finality remains external.';
