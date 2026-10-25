-- Transcript content is immutable and revisioned. Rights/profile admission remains candidate-only.
CREATE TABLE IF NOT EXISTS media_transcript_revisions (
    tenant_id VARCHAR(255) NOT NULL,
    transcript_id VARCHAR(255) NOT NULL,
    revision INTEGER NOT NULL,
    principal_id VARCHAR(255) NOT NULL,
    source_artifact_id VARCHAR(255) NOT NULL,
    source_artifact_version VARCHAR(71) NOT NULL,
    source_sha256 VARCHAR(64) NOT NULL,
    job_id VARCHAR(255) NOT NULL,
    profile_id VARCHAR(255) NOT NULL,
    provider_id VARCHAR(255) NOT NULL,
    model_id VARCHAR(255) NOT NULL,
    language VARCHAR(64) NOT NULL,
    timebase VARCHAR(255) NOT NULL,
    transcript_text TEXT NOT NULL,
    consent_decision_id VARCHAR(255) NOT NULL,
    rights_decision_id VARCHAR(255) NOT NULL,
    policy_version VARCHAR(255) NOT NULL,
    admission_status VARCHAR(24) NOT NULL DEFAULT 'CANDIDATE',
    created_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, transcript_id, revision),
    CONSTRAINT fk_media_transcript_source FOREIGN KEY (tenant_id, source_artifact_id)
        REFERENCES media_artifacts(tenant_id, artifact_id),
    CONSTRAINT fk_media_transcript_job FOREIGN KEY (tenant_id, job_id)
        REFERENCES media_processing_jobs(tenant_id, job_id),
    CONSTRAINT media_transcript_revision_check CHECK (revision > 0),
    CONSTRAINT media_transcript_digest_check CHECK (LENGTH(source_sha256) = 64),
    CONSTRAINT media_transcript_version_check CHECK (
        LENGTH(source_artifact_version) = 71 AND SUBSTRING(source_artifact_version, 1, 7) = 'sha256:'
    ),
    CONSTRAINT media_transcript_admission_check CHECK (admission_status = 'CANDIDATE')
);

CREATE INDEX IF NOT EXISTS idx_media_transcript_source
    ON media_transcript_revisions (tenant_id, source_artifact_id, source_artifact_version);
CREATE INDEX IF NOT EXISTS idx_media_transcript_job
    ON media_transcript_revisions (tenant_id, job_id, transcript_id, revision);
