-- Request-driven erasure of an artifact lineage tree (DEV_ONLY routes today) and the owner-authorised legal hold that
-- blocks it. None of these tables stores content: holds carry a reason and principals, operations carry a manifest of
-- identifiers and SHA-256 digests, tombstones carry an artifact id and digest.
--
-- An erasure is a durable state machine so a crash can never leave bytes reachable:
--   DB_ERASED       one transaction removed every metadata row of the tree (artifacts, lineage, transcripts, captions,
--                   deliveries, review records, upload sessions) and wrote the tombstones and this manifest. From this
--                   commit nothing in the tree is readable through any Media read path; remaining S3 objects and local
--                   copies are unreachable orphans that the manifest lists.
--   OBJECTS_ERASED  every S3 object in the manifest is deleted (idempotent, resumable after a crash).
--   COMPLETED       local copies (spool, delivered files, caches) are gone and the receipt is final.
-- Revoking a rights statement is a different act: it only stops new processing and replays and deletes nothing.
CREATE TABLE media_legal_holds (
    tenant_id VARCHAR(255) NOT NULL,
    hold_id VARCHAR(128) NOT NULL,
    request_id VARCHAR(128) NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    root_artifact_id VARCHAR(255) NOT NULL,
    reason VARCHAR(1000) NOT NULL,
    placed_by VARCHAR(255) NOT NULL,
    placed_assurance VARCHAR(32) NOT NULL,
    placed_at TIMESTAMP WITH TIME ZONE NOT NULL,
    state VARCHAR(16) NOT NULL,
    released_by VARCHAR(255),
    released_assurance VARCHAR(32),
    release_reason VARCHAR(1000),
    released_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (tenant_id, hold_id),
    CONSTRAINT media_legal_holds_request_unique UNIQUE (tenant_id, placed_by, request_id),
    CONSTRAINT media_legal_holds_state_check CHECK (state IN ('ACTIVE', 'RELEASED')),
    CONSTRAINT media_legal_holds_release_check CHECK (
        (state = 'ACTIVE' AND released_by IS NULL AND released_at IS NULL AND release_reason IS NULL)
        OR (state = 'RELEASED' AND released_by IS NOT NULL AND released_at IS NOT NULL AND release_reason IS NOT NULL))
);

CREATE INDEX idx_media_legal_holds_active ON media_legal_holds (tenant_id, state, root_artifact_id);

CREATE TABLE media_erasure_operations (
    tenant_id VARCHAR(255) NOT NULL,
    erasure_id VARCHAR(128) NOT NULL,
    principal_id VARCHAR(255) NOT NULL,
    root_artifact_id VARCHAR(255) NOT NULL,
    requested_assurance VARCHAR(32) NOT NULL,
    state VARCHAR(16) NOT NULL,
    manifest_json TEXT NOT NULL,
    receipt_json TEXT,
    requested_at TIMESTAMP WITH TIME ZONE NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (tenant_id, erasure_id),
    CONSTRAINT media_erasure_state_check CHECK (state IN ('DB_ERASED', 'OBJECTS_ERASED', 'COMPLETED')),
    CONSTRAINT media_erasure_completed_check CHECK (
        (state = 'COMPLETED' AND receipt_json IS NOT NULL AND completed_at IS NOT NULL)
        OR (state <> 'COMPLETED' AND receipt_json IS NULL AND completed_at IS NULL))
);

CREATE INDEX idx_media_erasure_operations_open ON media_erasure_operations (state, requested_at);

CREATE TABLE media_erasure_tombstones (
    tenant_id VARCHAR(255) NOT NULL,
    artifact_id VARCHAR(255) NOT NULL,
    erasure_id VARCHAR(128) NOT NULL,
    kind VARCHAR(64) NOT NULL,
    sha256 VARCHAR(64) NOT NULL,
    erased_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (tenant_id, artifact_id),
    CONSTRAINT fk_media_erasure_tombstone_operation FOREIGN KEY (tenant_id, erasure_id)
        REFERENCES media_erasure_operations (tenant_id, erasure_id)
);

-- A request-ledger row whose output was erased must answer "erased", never replay and never re-run the model.
ALTER TABLE media_dev_request_ledger DROP CONSTRAINT media_dev_request_ledger_state_check;
ALTER TABLE media_dev_request_ledger ADD CONSTRAINT media_dev_request_ledger_state_check
    CHECK (state IN ('IN_PROGRESS', 'COMPLETED', 'RELEASED', 'ERASED'));
ALTER TABLE media_dev_request_ledger DROP CONSTRAINT media_dev_request_ledger_completed_check;
ALTER TABLE media_dev_request_ledger ADD CONSTRAINT media_dev_request_ledger_completed_check CHECK (
    (state = 'COMPLETED' AND completed_at IS NOT NULL AND outputs_json <> '[]')
    OR (state = 'ERASED' AND outputs_json = '[]')
    OR (state NOT IN ('COMPLETED', 'ERASED') AND completed_at IS NULL));
