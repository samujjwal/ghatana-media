-- DEV_ONLY reversible head pointer over a lineage of immutable artifact versions (J-19 quality optimization).
--
-- An append-only event log. BASE names the version a lineage started from, APPLY makes a new immutable version the head,
-- UNDO pops the latest applied version so the previous head is restored exactly (the same artifact version, never a
-- copy). The head is derived by replaying the log; rows are never updated or deleted by the lane. (tenant, lineage, seq)
-- serialises concurrent writers, and (tenant, lineage, request_id) makes every operation idempotent by its requestId.
-- No content lives here and the table is never an authority for rights.
CREATE TABLE media_dev_head_events (
    tenant_id VARCHAR(255) NOT NULL,
    lineage_id VARCHAR(128) NOT NULL,
    seq INTEGER NOT NULL,
    principal_id VARCHAR(255) NOT NULL,
    kind VARCHAR(8) NOT NULL,
    request_id VARCHAR(128) NOT NULL,
    artifact_id VARCHAR(255) NOT NULL,
    artifact_version_id VARCHAR(80) NOT NULL,
    report_artifact_id VARCHAR(255),
    undoes_seq INTEGER,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (tenant_id, lineage_id, seq),
    CONSTRAINT media_dev_head_events_request_unique UNIQUE (tenant_id, lineage_id, request_id),
    CONSTRAINT media_dev_head_events_seq_check CHECK (seq >= 1),
    CONSTRAINT media_dev_head_events_kind_check CHECK (kind IN ('BASE', 'APPLY', 'UNDO')),
    CONSTRAINT media_dev_head_events_undo_check CHECK (
        (kind = 'UNDO' AND undoes_seq IS NOT NULL AND undoes_seq < seq)
        OR (kind <> 'UNDO' AND undoes_seq IS NULL))
);

CREATE INDEX idx_media_dev_head_events_artifact ON media_dev_head_events (tenant_id, artifact_id);
