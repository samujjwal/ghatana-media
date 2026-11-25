-- DEV_ONLY bounded owner-scoped project-list snapshots and opaque continuations.
-- This migration is loaded only by PostgresqlDevProjectTimelinePersistenceState.
ALTER TABLE media_timeline_projects
    ADD COLUMN project_state TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (project_state IN ('ACTIVE', 'ARCHIVED')),
    ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX media_timeline_projects_owner_list_idx
    ON media_timeline_projects (tenant_id, owner_principal_id, workspace_id, created_at, project_id);

CREATE TABLE media_project_list_snapshots (
    snapshot_ref TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    initial_query_fingerprint TEXT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    row_count INTEGER NOT NULL CHECK (row_count >= 0 AND row_count <= 5000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (expires_at > created_at),
    UNIQUE (snapshot_ref, tenant_id, principal_id, workspace_id),
    UNIQUE (snapshot_ref, workspace_id)
);

CREATE INDEX media_project_list_snapshots_scope_expiry_idx
    ON media_project_list_snapshots (tenant_id, principal_id, workspace_id, expires_at, created_at);

CREATE INDEX media_project_list_snapshots_expiry_idx
    ON media_project_list_snapshots (expires_at, snapshot_ref);

CREATE TABLE media_project_list_snapshot_rows (
    snapshot_ref TEXT NOT NULL,
    row_ordinal INTEGER NOT NULL CHECK (row_ordinal >= 0 AND row_ordinal < 5000),
    project_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    project_state TEXT NOT NULL CHECK (project_state IN ('ACTIVE', 'ARCHIVED')),
    head_revision_id TEXT NOT NULL,
    PRIMARY KEY (snapshot_ref, row_ordinal),
    UNIQUE (snapshot_ref, project_id),
    FOREIGN KEY (snapshot_ref, workspace_id)
        REFERENCES media_project_list_snapshots (snapshot_ref, workspace_id) ON DELETE CASCADE
);

CREATE TABLE media_project_list_cursors (
    token_hash CHAR(64) PRIMARY KEY,
    token_value TEXT NOT NULL UNIQUE CHECK (length(token_value) BETWEEN 1 AND 2048),
    snapshot_ref TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    query_fingerprint TEXT NOT NULL,
    next_offset INTEGER NOT NULL CHECK (next_offset > 0 AND next_offset < 5000),
    expires_at TIMESTAMPTZ NOT NULL,
    UNIQUE (snapshot_ref, next_offset),
    FOREIGN KEY (snapshot_ref, tenant_id, principal_id, workspace_id)
        REFERENCES media_project_list_snapshots (snapshot_ref, tenant_id, principal_id, workspace_id)
        ON DELETE CASCADE
);

CREATE INDEX media_project_list_cursors_scope_idx
    ON media_project_list_cursors (tenant_id, principal_id, workspace_id, expires_at);
