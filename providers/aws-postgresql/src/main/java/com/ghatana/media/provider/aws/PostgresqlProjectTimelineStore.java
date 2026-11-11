package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaProjectTimelineContracts;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Created;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Project;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectAccessDeniedException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectNotFoundException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectTimelineStore;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Revision;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.RevisionConflictException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.TimelineSnapshot;
import com.ghatana.media.runtime.ManagedProjectTimelineStore;
import tools.jackson.core.type.TypeReference;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;

/** Durable tenant/principal-scoped project revisions. Canonical V030 stays test-only; dev wiring uses an isolated schema. */
public final class PostgresqlProjectTimelineStore implements ManagedProjectTimelineStore {
    private final ProjectTimelinePersistenceState state;
    private final AtomicBoolean closed = new AtomicBoolean();

    public PostgresqlProjectTimelineStore() { this(MediaAwsPostgresqlRuntimeState.acquire()); }

    PostgresqlProjectTimelineStore(ProjectTimelinePersistenceState state) {
        this.state = Objects.requireNonNull(state, "state");
    }

    @Override
    public Created create(Actor actor, String workspaceId, String title, String requestId,
                          String projectId, String initialRevisionId) {
        ensureOpen();
        Objects.requireNonNull(actor, "actor");
        MediaProjectTimelineContracts.requireCreateProjectRequestId(requestId);
        workspaceId = MediaProjectTimelineContracts.requireSelectedWorkspaceId(workspaceId);
        title = MediaProjectTimelineContracts.requiredProjectTitle(title);
        requestId = MediaProjectTimelineContracts.required(requestId, "requestId");
        projectId = MediaProjectTimelineContracts.requiredOpaqueId(projectId, "projectId");
        initialRevisionId = MediaProjectTimelineContracts.requiredOpaqueId(initialRevisionId, "initialRevisionId");
        String fingerprint = fingerprint(workspaceId, title);
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                Created prior = replay(connection, actor, requestId, fingerprint);
                if (prior != null) {
                    connection.rollback();
                    return prior;
                }
                try (PreparedStatement project = connection.prepareStatement("""
                        INSERT INTO media_timeline_projects
                          (tenant_id,project_id,workspace_id,owner_principal_id,title,head_revision_id)
                        VALUES (?,?,?,?,?,?)
                        """)) {
                    project.setString(1, actor.tenantId()); project.setString(2, projectId);
                    project.setString(3, workspaceId); project.setString(4, actor.principalId());
                    project.setString(5, title); project.setString(6, initialRevisionId);
                    project.executeUpdate();
                }
                Revision initial = new Revision(actor.tenantId(), projectId, initialRevisionId, null, List.of());
                insertRevision(connection, initial);
                try (PreparedStatement receipt = connection.prepareStatement("""
                        INSERT INTO media_timeline_create_receipts
                          (tenant_id,principal_id,request_id,request_fingerprint,project_id,initial_revision_id)
                        VALUES (?,?,?,?,?,?)
                        """)) {
                    receipt.setString(1, actor.tenantId()); receipt.setString(2, actor.principalId());
                    receipt.setString(3, requestId); receipt.setString(4, fingerprint);
                    receipt.setString(5, projectId); receipt.setString(6, initialRevisionId);
                    receipt.executeUpdate();
                }
                connection.commit();
                return new Created(new Project(actor.tenantId(), projectId, workspaceId, actor.principalId(),
                        title, initialRevisionId), initial, true);
            } catch (SQLException | RuntimeException failure) {
                connection.rollback();
                if (failure instanceof SQLException sql && "23505".equals(sql.getSQLState())) {
                    return replayAfterConflict(actor, requestId, fingerprint);
                }
                throw failure;
            }
        } catch (SQLException failure) {
            throw new IllegalStateException("project creation persistence failed", failure);
        }
    }

    @Override public Project project(Actor actor, String projectId) {
        ensureOpen();
        projectId = MediaProjectTimelineContracts.requiredOpaqueId(projectId, "projectId");
        try (Connection connection = state.connection()) { return ownedProject(connection, actor, projectId); }
        catch (SQLException failure) { throw new IllegalStateException("project readback failed", failure); }
    }

    @Override public Revision revision(Actor actor, String projectId, String revisionId) {
        ensureOpen();
        projectId = MediaProjectTimelineContracts.requiredOpaqueId(projectId, "projectId");
        revisionId = MediaProjectTimelineContracts.requiredOpaqueId(revisionId, "revisionId");
        try (Connection connection = state.connection()) {
            ownedProject(connection, actor, projectId);
            try (PreparedStatement select = connection.prepareStatement("""
                    SELECT parent_revision_id, timeline_snapshots::text FROM media_timeline_revisions
                    WHERE tenant_id=? AND project_id=? AND revision_id=?
                    """)) {
                select.setString(1, actor.tenantId()); select.setString(2, projectId); select.setString(3, revisionId);
                try (ResultSet row = select.executeQuery()) {
                    if (!row.next()) throw new ProjectNotFoundException();
                    return new Revision(actor.tenantId(), projectId, revisionId, row.getString(1),
                            timelines(row.getString(2)));
                }
            }
        } catch (SQLException failure) { throw new IllegalStateException("project revision readback failed", failure); }
    }

    @Override public Revision commit(Actor actor, String projectId, String expectedHeadRevisionId,
                                     String newRevisionId, List<TimelineSnapshot> timelines) {
        ensureOpen();
        timelines = List.copyOf(Objects.requireNonNull(timelines, "timelines"));
        projectId = MediaProjectTimelineContracts.requiredOpaqueId(projectId, "projectId");
        String expected = MediaProjectTimelineContracts.requiredOpaqueId(expectedHeadRevisionId, "expectedHeadRevisionId");
        String revisionId = MediaProjectTimelineContracts.requiredOpaqueId(newRevisionId, "newRevisionId");
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                Project project = ownedProject(connection, actor, projectId);
                if (!project.headRevisionId().equals(expected)) {
                    throw new RevisionConflictException(expected, project.headRevisionId());
                }
                try (PreparedStatement update = connection.prepareStatement("""
                        UPDATE media_timeline_projects SET head_revision_id=?
                        WHERE tenant_id=? AND project_id=? AND owner_principal_id=? AND head_revision_id=?
                        """)) {
                    update.setString(1, revisionId); update.setString(2, actor.tenantId());
                    update.setString(3, projectId); update.setString(4, actor.principalId()); update.setString(5, expected);
                    if (update.executeUpdate() != 1) {
                        Project latest = ownedProject(connection, actor, projectId);
                        throw new RevisionConflictException(expected, latest.headRevisionId());
                    }
                }
                Revision revision = new Revision(actor.tenantId(), projectId, revisionId, expected, timelines);
                insertRevision(connection, revision);
                connection.commit();
                return revision;
            } catch (SQLException | RuntimeException failure) {
                connection.rollback();
                throw failure;
            }
        } catch (SQLException failure) { throw new IllegalStateException("project revision commit failed", failure); }
    }

    private Created replay(Connection connection, Actor actor, String requestId, String fingerprint) throws SQLException {
        try (PreparedStatement select = connection.prepareStatement("""
                SELECT request_fingerprint,project_id,initial_revision_id FROM media_timeline_create_receipts
                WHERE tenant_id=? AND principal_id=? AND request_id=? FOR UPDATE
                """)) {
            select.setString(1, actor.tenantId()); select.setString(2, actor.principalId()); select.setString(3, requestId);
            try (ResultSet row = select.executeQuery()) {
                if (!row.next()) return null;
                if (!row.getString(1).equals(fingerprint)) {
                    throw new MediaProjectTimelineContracts.IdempotencyConflictException();
                }
                Project currentProject = ownedProject(connection, actor, row.getString(2));
                String initialRevisionId = row.getString(3);
                Project initialProject = new Project(currentProject.tenantId(), currentProject.projectId(),
                        currentProject.workspaceId(), currentProject.ownerPrincipalId(), currentProject.title(),
                        initialRevisionId);
                Revision revision = readRevision(connection, actor.tenantId(), currentProject.projectId(), initialRevisionId);
                return new Created(initialProject, revision, false);
            }
        }
    }

    private Created replayAfterConflict(Actor actor, String requestId, String fingerprint) {
        try (Connection connection = state.connection()) {
            Created replay = replay(connection, actor, requestId, fingerprint);
            if (replay != null) return replay;
            throw new IllegalStateException("project identity already exists in tenant");
        } catch (SQLException failure) { throw new IllegalStateException("project create replay failed", failure); }
    }

    private Project ownedProject(Connection connection, Actor actor, String projectId) throws SQLException {
        Objects.requireNonNull(actor, "actor");
        try (PreparedStatement select = connection.prepareStatement("""
                SELECT workspace_id,owner_principal_id,title,head_revision_id FROM media_timeline_projects
                WHERE tenant_id=? AND project_id=?
                """)) {
            select.setString(1, actor.tenantId()); select.setString(2, projectId);
            try (ResultSet row = select.executeQuery()) {
                if (!row.next()) throw new ProjectNotFoundException();
                if (!row.getString(2).equals(actor.principalId())) throw new ProjectAccessDeniedException();
                return new Project(actor.tenantId(), projectId, row.getString(1), row.getString(2),
                        row.getString(3), row.getString(4));
            }
        }
    }

    private Revision readRevision(Connection connection, String tenantId, String projectId, String revisionId)
            throws SQLException {
        try (PreparedStatement select = connection.prepareStatement("""
                SELECT parent_revision_id,timeline_snapshots::text FROM media_timeline_revisions
                WHERE tenant_id=? AND project_id=? AND revision_id=?
                """)) {
            select.setString(1, tenantId); select.setString(2, projectId); select.setString(3, revisionId);
            try (ResultSet row = select.executeQuery()) {
                if (!row.next()) throw new ProjectNotFoundException();
                return new Revision(tenantId, projectId, revisionId, row.getString(1), timelines(row.getString(2)));
            }
        }
    }

    private void insertRevision(Connection connection, Revision revision) throws SQLException {
        try (PreparedStatement insert = connection.prepareStatement("""
                INSERT INTO media_timeline_revisions
                  (tenant_id,project_id,revision_id,parent_revision_id,timeline_snapshots)
                VALUES (?,?,?,?,?::jsonb)
                """)) {
            insert.setString(1, revision.tenantId()); insert.setString(2, revision.projectId());
            insert.setString(3, revision.revisionId()); insert.setString(4, revision.parentRevisionId());
            insert.setString(5, json(revision.timelines()));
            insert.executeUpdate();
        }
    }

    private List<TimelineSnapshot> timelines(String json) {
        try { return state.mapper().readValue(json, new TypeReference<List<TimelineSnapshot>>() { }); }
        catch (Exception failure) { throw new IllegalStateException("stored project timeline snapshots are malformed", failure); }
    }

    private String json(List<TimelineSnapshot> timelines) {
        try { return state.mapper().writeValueAsString(timelines); }
        catch (Exception failure) { throw new IllegalArgumentException("project timeline snapshots are not serializable", failure); }
    }

    private static String fingerprint(String workspaceId, String title) {
        try {
            byte[] bytes = (workspaceId.length() + ":" + workspaceId + title.length() + ":" + title)
                    .getBytes(StandardCharsets.UTF_8);
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("project timeline store is closed");
    }

    @Override public void close() { if (closed.compareAndSet(false, true)) state.release(); }
}
