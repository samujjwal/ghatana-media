-- Source provenance, rights scope, and revocation authority for irreversible processing effects.
-- One immutable artifact version maps to exactly one authenticated source-owner record. The
-- revocation_epoch advances on every revocation so previously issued evidence fails closed.
CREATE TABLE IF NOT EXISTS media_source_records (
    tenant_id VARCHAR(255) NOT NULL,
    artifact_id VARCHAR(255) NOT NULL,
    source_version VARCHAR(71) NOT NULL,
    source_sha256 CHAR(64) NOT NULL,
    principal_id VARCHAR(255) NOT NULL,
    source_owner_id VARCHAR(255) NOT NULL,
    source_kind VARCHAR(24) NOT NULL,
    human_consent_disposition VARCHAR(40) NOT NULL,
    consent_decision_id VARCHAR(255) NOT NULL DEFAULT '',
    allowed_operations_csv TEXT NOT NULL,
    allowed_purposes_csv TEXT NOT NULL,
    allowed_regions_csv TEXT NOT NULL,
    allowed_provider_retentions_csv TEXT NOT NULL,
    source_clock_evidence_ref VARCHAR(512) NOT NULL,
    provenance_ref VARCHAR(512) NOT NULL,
    registered_by VARCHAR(255) NOT NULL,
    registered_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    revocation_epoch BIGINT NOT NULL,
    revoked_at BIGINT,
    PRIMARY KEY (tenant_id, artifact_id, source_version),
    CONSTRAINT media_source_version_digest_binding CHECK (
        LENGTH(source_version) = 71 AND SUBSTRING(source_version, 1, 7) = 'sha256:'
        AND LENGTH(source_sha256) = 64 AND source_version = 'sha256:' || source_sha256),
    CONSTRAINT media_source_kind_check CHECK (
        source_kind IN ('ORIGINAL_NONHUMAN','HUMAN_RECORDING','THIRD_PARTY')),
    CONSTRAINT media_source_consent_disposition_check CHECK (
        human_consent_disposition IN ('REQUIRED','NOT_APPLICABLE_HUMAN_CONSENT')),
    CONSTRAINT media_source_consent_binding_check CHECK (
        (source_kind = 'ORIGINAL_NONHUMAN'
            AND human_consent_disposition = 'NOT_APPLICABLE_HUMAN_CONSENT'
            AND consent_decision_id = '')
        OR (source_kind IN ('HUMAN_RECORDING','THIRD_PARTY')
            AND human_consent_disposition = 'REQUIRED'
            AND consent_decision_id <> '')),
    CONSTRAINT media_source_revocation_epoch_check CHECK (revocation_epoch >= 0)
);

CREATE INDEX IF NOT EXISTS idx_media_source_records_owner
    ON media_source_records (tenant_id, principal_id, artifact_id);

-- Authority-issued processing decisions. A durable row lets the canonical transcript store
-- re-verify admission inside the commit boundary instead of trusting a caller-supplied flag.
CREATE TABLE IF NOT EXISTS media_source_rights_decisions (
    tenant_id VARCHAR(255) NOT NULL,
    decision_id VARCHAR(255) NOT NULL,
    artifact_id VARCHAR(255) NOT NULL,
    source_version VARCHAR(71) NOT NULL,
    principal_id VARCHAR(255) NOT NULL,
    source_owner_id VARCHAR(255) NOT NULL,
    operation VARCHAR(64) NOT NULL,
    purpose VARCHAR(255) NOT NULL,
    provider_id VARCHAR(255) NOT NULL,
    provider_version VARCHAR(255) NOT NULL,
    processing_boundary VARCHAR(24) NOT NULL,
    processing_region VARCHAR(255) NOT NULL,
    provider_retention VARCHAR(40) NOT NULL,
    policy_decision_id VARCHAR(255) NOT NULL,
    policy_version VARCHAR(255) NOT NULL,
    revocation_epoch BIGINT NOT NULL,
    decided_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    revoked_at BIGINT,
    PRIMARY KEY (tenant_id, decision_id),
    CONSTRAINT media_source_decision_epoch_check CHECK (revocation_epoch >= 0),
    CONSTRAINT media_source_decision_boundary_check CHECK (
        processing_boundary IN ('LOCAL','EXTERNAL')),
    CONSTRAINT media_source_decision_retention_check CHECK (
        provider_retention IN ('UNKNOWN','NONE','TRANSIENT','PERSISTENT'))
);

CREATE INDEX IF NOT EXISTS idx_media_source_decisions_source
    ON media_source_rights_decisions (tenant_id, artifact_id, source_version);
