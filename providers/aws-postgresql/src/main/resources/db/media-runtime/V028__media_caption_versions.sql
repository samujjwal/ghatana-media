-- Immutable caption-version registrations (media.operation.caption-version-write).
-- Append-only: committed versions are never updated or deleted; later correction
-- creates a new version keyed by a distinct caption_version_id.
CREATE TABLE IF NOT EXISTS media_caption_registrations (
    tenant_id               TEXT    NOT NULL,
    principal_id            TEXT    NOT NULL,
    request_id              TEXT    NOT NULL,
    request_fingerprint     TEXT    NOT NULL,
    caption_version_id      TEXT    NOT NULL,
    registration_receipt_id TEXT    NOT NULL,
    source_artifact_id      TEXT    NOT NULL,
    source_artifact_version_id TEXT NOT NULL,
    parent_version_kind     TEXT    NOT NULL,
    parent_version_id       TEXT    NOT NULL,
    source_clock_id         TEXT    NOT NULL,
    ticks_per_second        BIGINT  NOT NULL,
    source_duration_ticks   BIGINT  NOT NULL,
    language_disposition    TEXT    NOT NULL,
    language_tag_present    BOOLEAN NOT NULL,
    language_tag            TEXT,
    purpose_present         BOOLEAN NOT NULL,
    purpose                 TEXT,
    segments_json           TEXT    NOT NULL,
    registered_at           BIGINT  NOT NULL,
    PRIMARY KEY (tenant_id, principal_id, request_id),
    UNIQUE (caption_version_id),
    UNIQUE (registration_receipt_id)
);
CREATE INDEX IF NOT EXISTS media_caption_registrations_source_idx
    ON media_caption_registrations (tenant_id, principal_id, source_artifact_id, source_artifact_version_id);
