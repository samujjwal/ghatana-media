-- Test-only additive schema for the ProjectTimelineStore adapter. This location is
-- deliberately excluded from the provider/launcher Flyway locations.
CREATE TABLE media_timeline_projects (
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    owner_principal_id TEXT NOT NULL,
    title TEXT NOT NULL,
    head_revision_id TEXT NOT NULL,
    PRIMARY KEY (tenant_id, project_id)
);

CREATE TABLE media_timeline_revisions (
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    parent_revision_id TEXT,
    timeline_snapshots JSONB NOT NULL,
    PRIMARY KEY (tenant_id, project_id, revision_id),
    FOREIGN KEY (tenant_id, project_id) REFERENCES media_timeline_projects (tenant_id, project_id),
    FOREIGN KEY (tenant_id, project_id, parent_revision_id)
        REFERENCES media_timeline_revisions (tenant_id, project_id, revision_id)
        DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE media_timeline_projects
    ADD CONSTRAINT media_timeline_projects_head_fk
    FOREIGN KEY (tenant_id, project_id, head_revision_id)
    REFERENCES media_timeline_revisions (tenant_id, project_id, revision_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE media_timeline_create_receipts (
    tenant_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    project_id TEXT NOT NULL,
    initial_revision_id TEXT NOT NULL,
    PRIMARY KEY (tenant_id, principal_id, request_id),
    FOREIGN KEY (tenant_id, project_id, initial_revision_id)
        REFERENCES media_timeline_revisions (tenant_id, project_id, revision_id)
        DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION media_reject_timeline_immutable_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Media timeline revisions and create receipts are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER media_timeline_revisions_immutable
    BEFORE UPDATE OR DELETE ON media_timeline_revisions
    FOR EACH ROW EXECUTE FUNCTION media_reject_timeline_immutable_change();

CREATE TRIGGER media_timeline_create_receipts_immutable
    BEFORE UPDATE OR DELETE ON media_timeline_create_receipts
    FOR EACH ROW EXECUTE FUNCTION media_reject_timeline_immutable_change();
