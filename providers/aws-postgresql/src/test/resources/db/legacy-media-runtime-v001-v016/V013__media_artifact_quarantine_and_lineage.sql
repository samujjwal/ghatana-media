-- Artifact safety and provenance metadata. Scan evidence is separate from caller metadata and
-- remains UNVERIFIED until a trusted scanner records a decision.
ALTER TABLE media_upload_sessions
    ADD COLUMN IF NOT EXISTS scan_status VARCHAR(24) NOT NULL DEFAULT 'UNVERIFIED';
ALTER TABLE media_upload_sessions ADD COLUMN IF NOT EXISTS scan_policy_version VARCHAR(255);
ALTER TABLE media_upload_sessions ADD COLUMN IF NOT EXISTS scanner_id VARCHAR(255);
ALTER TABLE media_upload_sessions ADD COLUMN IF NOT EXISTS scanned_at BIGINT;

ALTER TABLE media_upload_sessions
    ADD CONSTRAINT media_upload_scan_status_check
    CHECK (scan_status IN ('UNVERIFIED','PENDING','CLEAN','REJECTED','UNAVAILABLE'));

ALTER TABLE media_artifacts
    ADD COLUMN IF NOT EXISTS scan_status VARCHAR(24) NOT NULL DEFAULT 'UNVERIFIED';
ALTER TABLE media_artifacts ADD COLUMN IF NOT EXISTS scan_policy_version VARCHAR(255);
ALTER TABLE media_artifacts ADD COLUMN IF NOT EXISTS scanner_id VARCHAR(255);
ALTER TABLE media_artifacts ADD COLUMN IF NOT EXISTS scanned_at BIGINT;
ALTER TABLE media_artifacts ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE media_artifacts
    ADD CONSTRAINT media_artifact_scan_status_check
    CHECK (scan_status IN ('UNVERIFIED','PENDING','CLEAN','REJECTED','UNAVAILABLE'));

CREATE TABLE IF NOT EXISTS media_artifact_lineage (
    tenant_id VARCHAR(255) NOT NULL,
    derived_artifact_id VARCHAR(255) NOT NULL,
    derived_version VARCHAR(71) NOT NULL,
    source_artifact_id VARCHAR(255) NOT NULL,
    source_version VARCHAR(71) NOT NULL,
    job_id VARCHAR(255) NOT NULL,
    processing_profile VARCHAR(255) NOT NULL,
    rights_decision_id VARCHAR(255) NOT NULL,
    consent_decision_id VARCHAR(255) NOT NULL,
    policy_version VARCHAR(255) NOT NULL,
    admission_status VARCHAR(24) NOT NULL DEFAULT 'CANDIDATE',
    created_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, derived_artifact_id, derived_version),
    CONSTRAINT fk_media_lineage_derived FOREIGN KEY (tenant_id, derived_artifact_id)
        REFERENCES media_artifacts(tenant_id, artifact_id),
    CONSTRAINT fk_media_lineage_source FOREIGN KEY (tenant_id, source_artifact_id)
        REFERENCES media_artifacts(tenant_id, artifact_id),
    CONSTRAINT fk_media_lineage_job FOREIGN KEY (tenant_id, job_id)
        REFERENCES media_processing_jobs(tenant_id, job_id),
    CONSTRAINT media_lineage_admission_status_check CHECK (admission_status IN ('CANDIDATE','VERIFIED')),
    CONSTRAINT media_lineage_version_length CHECK (
        LENGTH(derived_version) = 71 AND SUBSTRING(derived_version, 1, 7) = 'sha256:'
        AND LENGTH(source_version) = 71 AND SUBSTRING(source_version, 1, 7) = 'sha256:'
    )
);

CREATE INDEX IF NOT EXISTS idx_media_artifact_lineage_source
    ON media_artifact_lineage (tenant_id, source_artifact_id, source_version);
