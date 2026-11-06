package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaProjectTimelineContracts;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Created;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Graph;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Project;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectAccessDeniedException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectNotFoundException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectTimelineStore;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Revision;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.RevisionConflictException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.HexFormat;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;

/** Durable tenant/principal-scoped project revisions. The V030 test migration is intentionally not launcher-wired. */
public final class PostgresqlProjectTimelineStore implements ProjectTimelineStore, AutoCloseable {
    private final MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
    private final AtomicBoolean closed = new AtomicBoolean();

    @Override
    public Created create(Actor actor, String workspaceId, String title, String requestId,
                          String projectId, String initialRevisionId, String timelineId) {
        ensureOpen();
        Objects.requireNonNull(actor, "actor");
        MediaProjectTimelineContracts.requireCreateProjectRequestId(requestId);
        workspaceId = MediaProjectTimelineContracts.required(workspaceId, "workspaceId");
        title = MediaProjectTimelineContracts.required(title, "title");
        requestId = MediaProjectTimelineContracts.required(requestId, "requestId");
        projectId = MediaProjectTimelineContracts.required(projectId, "projectId");
        initialRevisionId = MediaProjectTimelineContracts.required(initialRevisionId, "initialRevisionId");
        Graph graph = Graph.empty(timelineId);
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
                Revision initial = new Revision(actor.tenantId(), projectId, initialRevisionId, null, graph);
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
        projectId = MediaProjectTimelineContracts.required(projectId, "projectId");
        try (Connection connection = state.connection()) { return ownedProject(connection, actor, projectId); }
        catch (SQLException failure) { throw new IllegalStateException("project readback failed", failure); }
    }

    @Override public Revision revision(Actor actor, String projectId, String revisionId) {
        ensureOpen();
        projectId = MediaProjectTimelineContracts.required(projectId, "projectId");
        revisionId = MediaProjectTimelineContracts.required(revisionId, "revisionId");
        try (Connection connection = state.connection()) {
            ownedProject(connection, actor, projectId);
            try (PreparedStatement select = connection.prepareStatement("""
                    SELECT parent_revision_id, graph_snapshot::text FROM media_timeline_revisions
                    WHERE tenant_id=? AND project_id=? AND revision_id=?
                    """)) {
                select.setString(1, actor.tenantId()); select.setString(2, projectId); select.setString(3, revisionId);
                try (ResultSet row = select.executeQuery()) {
                    if (!row.next()) throw new ProjectNotFoundException();
                    return new Revision(actor.tenantId(), projectId, revisionId, row.getString(1),
                            graph(row.getString(2)));
                }
            }
        } catch (SQLException failure) { throw new IllegalStateException("project revision readback failed", failure); }
    }

    @Override public Revision commit(Actor actor, String projectId, String expectedHeadRevisionId,
                                     String newRevisionId, Graph graph) {
        ensureOpen();
        Objects.requireNonNull(graph, "graph");
        projectId = MediaProjectTimelineContracts.required(projectId, "projectId");
        String expected = MediaProjectTimelineContracts.required(expectedHeadRevisionId, "expectedHeadRevisionId");
        String revisionId = MediaProjectTimelineContracts.required(newRevisionId, "newRevisionId");
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                Project project = ownedProject(connection, actor, projectId);
                if (!project.headRevisionId().equals(expected)) {
                    throw new RevisionConflictException(expected, project.headRevisionId());
                }
                Revision parent = readRevision(connection, actor.tenantId(), projectId, expected);
                if (!parent.graph().timelineId().equals(graph.timelineId())) {
                    throw new IllegalArgumentException("timeline identity is immutable across project revisions");
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
                Revision revision = new Revision(actor.tenantId(), projectId, revisionId, expected, graph);
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
                SELECT parent_revision_id,graph_snapshot::text FROM media_timeline_revisions
                WHERE tenant_id=? AND project_id=? AND revision_id=?
                """)) {
            select.setString(1, tenantId); select.setString(2, projectId); select.setString(3, revisionId);
            try (ResultSet row = select.executeQuery()) {
                if (!row.next()) throw new ProjectNotFoundException();
                return new Revision(tenantId, projectId, revisionId, row.getString(1), graph(row.getString(2)));
            }
        }
    }

    private void insertRevision(Connection connection, Revision revision) throws SQLException {
        try (PreparedStatement insert = connection.prepareStatement("""
                INSERT INTO media_timeline_revisions
                  (tenant_id,project_id,revision_id,parent_revision_id,graph_snapshot)
                VALUES (?,?,?,?,?::jsonb)
                """)) {
            insert.setString(1, revision.tenantId()); insert.setString(2, revision.projectId());
            insert.setString(3, revision.revisionId()); insert.setString(4, revision.parentRevisionId());
            insert.setString(5, json(revision.graph()));
            insert.executeUpdate();
        }
    }

    private Graph graph(String json) {
        try { return state.mapper().readValue(json, Graph.class); }
        catch (Exception failure) { throw new IllegalStateException("stored project graph snapshot is malformed", failure); }
    }

    private String json(Graph graph) {
        try { return state.mapper().writeValueAsString(graph); }
        catch (Exception failure) { throw new IllegalArgumentException("project graph snapshot is not serializable", failure); }
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
