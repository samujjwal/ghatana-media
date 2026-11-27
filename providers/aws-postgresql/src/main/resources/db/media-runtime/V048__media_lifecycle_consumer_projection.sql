-- Durable receipt and aggregate-version fence for the Media lifecycle consumer port.
-- Raw trusted tenant identity is the partition key; event and aggregate refs are public r1 aliases.
CREATE TABLE IF NOT EXISTS media_lifecycle_projection_heads (
    tenant_id VARCHAR(512) NOT NULL,
    aggregate_type VARCHAR(32) NOT NULL,
    aggregate_ref VARCHAR(67) NOT NULL,
    aggregate_version BIGINT NOT NULL CHECK (aggregate_version >= 0),
    PRIMARY KEY (tenant_id, aggregate_type, aggregate_ref)
);

CREATE TABLE IF NOT EXISTS media_lifecycle_projection_receipts (
    tenant_id VARCHAR(512) NOT NULL,
    event_ref VARCHAR(67) NOT NULL,
    aggregate_type VARCHAR(32) NOT NULL,
    aggregate_ref VARCHAR(67) NOT NULL,
    aggregate_version BIGINT NOT NULL CHECK (aggregate_version > 0),
    payload_fingerprint VARCHAR(64) NOT NULL CHECK (LENGTH(payload_fingerprint) = 64),
    PRIMARY KEY (tenant_id, event_ref)
);

CREATE INDEX IF NOT EXISTS idx_media_lifecycle_projection_receipts_aggregate
    ON media_lifecycle_projection_receipts
        (tenant_id, aggregate_type, aggregate_ref, aggregate_version);
