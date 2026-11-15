-- DEV_ONLY compare-and-set version history of tracked region edits (J-11).
--
-- A lineage is an owner-scoped append-only sequence of immutable versions. Version 1 is the BASE (the user's own video,
-- registered by reference and never changed). Every later version is an EDIT (a newly rendered artifact derived from the
-- version immediately before it) or an UNDO (a version that points at the exact artifact of an earlier version: its bytes
-- and metadata are that artifact's, not a copy, so the SHA-256 is identical by construction).
-- The primary key (tenant, lineage, version_number) is the compare-and-set: of several concurrent appenders of the same
-- head exactly one inserts head+1. A request id is unique inside a lineage so a retry returns the version it produced.
-- This table is never an authority for rights: rights are resolved per exact artifact version by the attestation store.
CREATE TABLE media_dev_region_edit_versions (
    tenant_id VARCHAR(255) NOT NULL,
    principal_id VARCHAR(255) NOT NULL,
    lineage_id VARCHAR(128) NOT NULL,
    version_number INTEGER NOT NULL,
    kind VARCHAR(8) NOT NULL,
    request_id VARCHAR(128) NOT NULL,
    artifact_id VARCHAR(255) NOT NULL,
    artifact_version_id VARCHAR(80) NOT NULL,
    content_sha256 CHAR(64) NOT NULL,
    size_bytes BIGINT NOT NULL,
    manifest_artifact_id VARCHAR(255),
    manifest_artifact_version_id VARCHAR(80),
    parent_version_number INTEGER,
    restores_version_number INTEGER,
    detail_json TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (tenant_id, lineage_id, version_number),
    CONSTRAINT media_dev_region_edit_request_unique UNIQUE (tenant_id, lineage_id, request_id),
    CONSTRAINT media_dev_region_edit_kind_check CHECK (kind IN ('BASE', 'EDIT', 'UNDO')),
    CONSTRAINT media_dev_region_edit_size_check CHECK (size_bytes >= 1 AND version_number >= 1),
    CONSTRAINT media_dev_region_edit_manifest_check CHECK (
        (manifest_artifact_id IS NULL) = (manifest_artifact_version_id IS NULL)),
    CONSTRAINT media_dev_region_edit_shape_check CHECK (
        (kind = 'BASE' AND version_number = 1 AND parent_version_number IS NULL AND restores_version_number IS NULL)
        OR (kind = 'EDIT' AND version_number >= 2 AND parent_version_number = version_number - 1
            AND restores_version_number IS NULL AND manifest_artifact_id IS NOT NULL)
        OR (kind = 'UNDO' AND version_number >= 3 AND parent_version_number = version_number - 1
            AND restores_version_number IS NOT NULL AND restores_version_number >= 1
            AND restores_version_number < parent_version_number))
);

CREATE INDEX idx_media_dev_region_edit_versions_artifact
    ON media_dev_region_edit_versions (tenant_id, artifact_id);
