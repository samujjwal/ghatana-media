-- Test-only store for immutable storyboard draft editions. It is deliberately
-- outside the launcher's production Flyway locations and never writes a project graph.
CREATE TABLE media_storyboard_plan_editions (
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    scene_plan_id TEXT NOT NULL,
    semantic_version TEXT NOT NULL,
    owner_principal_id TEXT NOT NULL,
    expected_project_revision_id TEXT NOT NULL,
    parent_semantic_version TEXT,
    plan_fingerprint CHAR(64) NOT NULL,
    plan_snapshot JSONB NOT NULL,
    owner_receipt TEXT NOT NULL UNIQUE,
    PRIMARY KEY (tenant_id, project_id, scene_plan_id, semantic_version),
    FOREIGN KEY (tenant_id, project_id)
        REFERENCES media_timeline_projects (tenant_id, project_id),
    FOREIGN KEY (tenant_id, project_id, expected_project_revision_id)
        REFERENCES media_timeline_revisions (tenant_id, project_id, revision_id),
    FOREIGN KEY (tenant_id, project_id, scene_plan_id, parent_semantic_version)
        REFERENCES media_storyboard_plan_editions (tenant_id, project_id, scene_plan_id, semantic_version)
        DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE media_storyboard_plan_heads (
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    scene_plan_id TEXT NOT NULL,
    current_semantic_version TEXT NOT NULL,
    PRIMARY KEY (tenant_id, project_id, scene_plan_id),
    FOREIGN KEY (tenant_id, project_id)
        REFERENCES media_timeline_projects (tenant_id, project_id),
    FOREIGN KEY (tenant_id, project_id, scene_plan_id, current_semantic_version)
        REFERENCES media_storyboard_plan_editions (tenant_id, project_id, scene_plan_id, semantic_version)
        DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE media_storyboard_plan_save_receipts (
    tenant_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    project_id TEXT NOT NULL,
    scene_plan_id TEXT NOT NULL,
    semantic_version TEXT NOT NULL,
    owner_receipt TEXT NOT NULL UNIQUE,
    PRIMARY KEY (tenant_id, principal_id, request_id),
    FOREIGN KEY (tenant_id, project_id, scene_plan_id, semantic_version)
        REFERENCES media_storyboard_plan_editions (tenant_id, project_id, scene_plan_id, semantic_version)
);

CREATE FUNCTION media_reject_storyboard_draft_immutable_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Media storyboard draft editions and save receipts are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER media_storyboard_plan_editions_immutable
    BEFORE UPDATE OR DELETE ON media_storyboard_plan_editions
    FOR EACH ROW EXECUTE FUNCTION media_reject_storyboard_draft_immutable_change();

CREATE TRIGGER media_storyboard_plan_save_receipts_immutable
    BEFORE UPDATE OR DELETE ON media_storyboard_plan_save_receipts
    FOR EACH ROW EXECUTE FUNCTION media_reject_storyboard_draft_immutable_change();
