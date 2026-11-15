-- DEV_ONLY versioned artifact intake ledger (J-02).
--
-- A lineage is a named, owner-scoped sequence of immutable artifact versions: the user's file and its revisions.
-- Each row binds one canonical artifact (already uploaded, finalised and SHA-256/size verified by the upload store)
-- to the next version number of the lineage, records the parent version it revises, and keeps the media probe
-- (container, duration, per-stream codec) taken from the stored bytes. Rows are append-only: a version never changes
-- and its content is never replaced. Identical content registered again in the same lineage is not a new version
-- (UNIQUE on lineage + artifact version), so it deduplicates to the existing row.
-- This table is never an authority for rights: rights are resolved per exact artifact version by the attestation store.
CREATE TABLE media_dev_artifact_versions (
    tenant_id VARCHAR(255) NOT NULL,
    lineage_id VARCHAR(128) NOT NULL,
    version_number INTEGER NOT NULL,
    principal_id VARCHAR(255) NOT NULL,
    artifact_id VARCHAR(255) NOT NULL,
    artifact_version_id VARCHAR(80) NOT NULL,
    content_sha256 CHAR(64) NOT NULL,
    size_bytes BIGINT NOT NULL,
    parent_artifact_version_id VARCHAR(80),
    probe_json TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (tenant_id, lineage_id, version_number),
    CONSTRAINT media_dev_artifact_versions_content_unique UNIQUE (tenant_id, lineage_id, artifact_version_id),
    CONSTRAINT media_dev_artifact_versions_number_check CHECK (version_number >= 1),
    CONSTRAINT media_dev_artifact_versions_size_check CHECK (size_bytes >= 1),
    CONSTRAINT media_dev_artifact_versions_parent_check CHECK (
        (version_number = 1 AND parent_artifact_version_id IS NULL)
        OR (version_number > 1 AND parent_artifact_version_id IS NOT NULL))
);

CREATE INDEX idx_media_dev_artifact_versions_artifact
    ON media_dev_artifact_versions (tenant_id, artifact_id);
