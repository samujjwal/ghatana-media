CREATE TABLE media_timeline_command_receipts (
    tenant_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    canonical_operation_ref TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    project_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    PRIMARY KEY (tenant_id, principal_id, canonical_operation_ref, request_id),
    FOREIGN KEY (tenant_id, project_id, revision_id)
        REFERENCES media_timeline_revisions (tenant_id, project_id, revision_id)
        DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT media_timeline_command_receipt_fingerprint_check CHECK (CHAR_LENGTH(request_fingerprint) = 64)
);

CREATE TRIGGER media_timeline_command_receipts_immutable
    BEFORE UPDATE OR DELETE ON media_timeline_command_receipts
    FOR EACH ROW EXECUTE FUNCTION media_reject_timeline_immutable_change();
