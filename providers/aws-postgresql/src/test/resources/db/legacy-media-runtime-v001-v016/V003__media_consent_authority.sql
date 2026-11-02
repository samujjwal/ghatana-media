CREATE TABLE IF NOT EXISTS media_consents (
    tenant_id VARCHAR(255) NOT NULL,
    consent_id VARCHAR(255) NOT NULL,
    principal_id VARCHAR(255) NOT NULL,
    purposes_csv TEXT NOT NULL,
    allowed_regions_csv TEXT NOT NULL,
    external_processing_allowed BOOLEAN NOT NULL,
    biometric_processing_allowed BOOLEAN NOT NULL,
    granted_at BIGINT NOT NULL,
    expires_at BIGINT,
    revoked_at BIGINT,
    version BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, consent_id),
    CONSTRAINT media_consent_version_check CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS idx_media_consents_principal
    ON media_consents (tenant_id, principal_id, consent_id);
CREATE INDEX IF NOT EXISTS idx_media_consents_expiry
    ON media_consents (expires_at, revoked_at);
