package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaProjectTimelineContracts;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Created;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Project;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectAccessDeniedException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectListObserved;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectListQuery;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectListRecord;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectListResult;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectListUnknown;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectNotFoundException;
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
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/** Durable tenant/principal-scoped project revisions. Canonical V030 stays test-only; dev wiring uses an isolated schema. */
public final class PostgresqlProjectTimelineStore implements ManagedProjectTimelineStore {
    private static final String PROJECT_LIST_OPERATION = "media.operation-slice.list-projects";
    private static final int PROJECT_LIST_PAGE_SIZE = 50;
    private static final int PROJECT_LIST_MAX_SNAPSHOT_ROWS = 5_000;
    private static final int PROJECT_LIST_MAX_ACTIVE_SCOPE_SNAPSHOTS = 16;
    private static final int PROJECT_LIST_EXPIRED_CLEANUP_BATCH = 4;
    private static final int PROJECT_LIST_TTL_MINUTES = 15;
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

    /**
     * Reads a bounded metadata-only owner snapshot. Continuations are persisted by hash lookup and remain
     * stable across store instances and project-head mutations for the snapshot TTL.
     */
    @Override public ProjectListResult listProjects(ProjectListQuery query) {
        ensureOpen();
        Objects.requireNonNull(query, "query");
        if (!(state instanceof PostgresqlDevProjectTimelinePersistenceState)) {
            return projectListUnknown("QUERY_UNAVAILABLE");
        }
        try (Connection connection = state.connection()) {
            connection.setTransactionIsolation(Connection.TRANSACTION_READ_COMMITTED);
            connection.setAutoCommit(false);
            try {
                ProjectListObserved result = query.pageToken() == null
                        ? createProjectListSnapshot(connection, query)
                        : readProjectListSnapshotPage(connection, query);
                if (result == null) {
                    connection.rollback();
                    return projectListUnknown("QUERY_UNAVAILABLE");
                }
                connection.commit();
                return result;
            } catch (ProjectListUnavailable unavailable) {
                connection.commit();
                return projectListUnknown(unavailable.reason);
            } catch (SQLException | RuntimeException failure) {
                connection.rollback();
                return projectListUnknown("QUERY_UNAVAILABLE");
            }
        } catch (SQLException failure) {
            return projectListUnknown("QUERY_UNAVAILABLE");
        }
    }

    private ProjectListObserved createProjectListSnapshot(Connection connection, ProjectListQuery query)
            throws SQLException, ProjectListUnavailable {
        Actor actor = query.actor();
        lockProjectListSnapshotScope(connection, actor, query.workspaceId());
        cleanupAndBoundProjectListSnapshots(connection, actor, query.workspaceId());

        List<ProjectListRecord> rows = new ArrayList<>(PROJECT_LIST_PAGE_SIZE);
        int rowCount;
        OffsetDateTime observedAt;
        try (PreparedStatement projects = connection.prepareStatement("""
                WITH selected_projects AS MATERIALIZED (
                    SELECT project_id,workspace_id,title,project_state,head_revision_id,created_at
                    FROM media_timeline_projects
                    WHERE tenant_id=? AND owner_principal_id=? AND workspace_id=?
                    ORDER BY created_at,project_id
                    LIMIT ?
                ), project_count AS (
                    SELECT count(*) AS row_count FROM selected_projects
                )
                SELECT project_count.row_count, statement_timestamp() AS observed_at,
                       selected_projects.project_id,selected_projects.workspace_id,selected_projects.title,
                       selected_projects.project_state,selected_projects.head_revision_id
                FROM project_count
                LEFT JOIN selected_projects ON project_count.row_count <= ?
                ORDER BY selected_projects.created_at,selected_projects.project_id
                """)) {
            projects.setString(1, actor.tenantId());
            projects.setString(2, actor.principalId());
            projects.setString(3, query.workspaceId());
            projects.setInt(4, PROJECT_LIST_MAX_SNAPSHOT_ROWS + 1);
            projects.setInt(5, PROJECT_LIST_MAX_SNAPSHOT_ROWS);
            try (ResultSet result = projects.executeQuery()) {
                if (!result.next()) throw new SQLException("project-list bounded query returned no row");
                rowCount = result.getInt("row_count");
                observedAt = result.getObject("observed_at", OffsetDateTime.class);
                if (rowCount > PROJECT_LIST_MAX_SNAPSHOT_ROWS) {
                    throw new ProjectListUnavailable("QUERY_UNAVAILABLE");
                }
                do {
                    if (result.getString("project_id") == null) continue;
                    rows.add(new ProjectListRecord(result.getString("project_id"), result.getString("workspace_id"),
                            result.getString("title"), result.getString("project_state"),
                            result.getString("head_revision_id")));
                } while (result.next());
            }
        }
        if (rows.size() != rowCount) throw new ProjectListUnavailable("QUERY_UNAVAILABLE");
        String snapshotRef = UUID.randomUUID().toString();
        OffsetDateTime expiresAt;
        try (PreparedStatement time = connection.prepareStatement("""
                SELECT ?::timestamptz + (? * INTERVAL '1 minute') AS expires_at
                """)) {
            time.setObject(1, observedAt);
            time.setInt(2, PROJECT_LIST_TTL_MINUTES);
            try (ResultSet result = time.executeQuery()) {
                if (!result.next()) throw new SQLException("project-list timestamp query returned no row");
                expiresAt = result.getObject("expires_at", OffsetDateTime.class);
            }
        }
        try (PreparedStatement snapshot = connection.prepareStatement("""
                INSERT INTO media_project_list_snapshots
                  (snapshot_ref,tenant_id,principal_id,workspace_id,initial_query_fingerprint,observed_at,expires_at,row_count)
                VALUES (?,?,?,?,?,?,?,?)
                """)) {
            snapshot.setString(1, snapshotRef);
            snapshot.setString(2, actor.tenantId());
            snapshot.setString(3, actor.principalId());
            snapshot.setString(4, query.workspaceId());
            snapshot.setString(5, query.queryFingerprint());
            snapshot.setObject(6, observedAt);
            snapshot.setObject(7, expiresAt);
            snapshot.setInt(8, rows.size());
            snapshot.executeUpdate();
        }
        insertProjectListSnapshotRows(connection, snapshotRef, rows);

        int end = Math.min(PROJECT_LIST_PAGE_SIZE, rows.size());
        String nextPageToken = rows.size() > end
                ? ensureProjectListCursor(connection, snapshotRef, actor, query, PROJECT_LIST_PAGE_SIZE, expiresAt)
                : null;
        return new ProjectListObserved(PROJECT_LIST_OPERATION, "OBSERVED", actor.tenantId(), actor.principalId(),
                query.workspaceId(), query.queryFingerprint(), snapshotRef, observedAt.toInstant().toString(),
                rows.subList(0, end), nextPageToken);
    }

    private ProjectListObserved readProjectListSnapshotPage(Connection connection, ProjectListQuery query)
            throws SQLException, ProjectListUnavailable {
        Actor actor = query.actor();
        String suppliedTokenHash = cursorTokenHash(query.pageToken());
        String snapshotRef;
        int offset;
        int rowCount;
        String observedAt;
        boolean cursorLive;
        boolean snapshotLive;
        try (PreparedStatement cursor = connection.prepareStatement("""
                SELECT c.snapshot_ref,c.tenant_id,c.principal_id,c.workspace_id,c.query_fingerprint,
                       c.next_offset,c.token_value,c.expires_at > clock_timestamp() AS cursor_live,
                       s.snapshot_ref AS available_snapshot_ref,s.observed_at,s.row_count,
                       s.expires_at > clock_timestamp() AS snapshot_live
                FROM media_project_list_cursors c
                LEFT JOIN media_project_list_snapshots s ON s.snapshot_ref=c.snapshot_ref
                WHERE c.token_hash=?
                """)) {
            cursor.setString(1, suppliedTokenHash);
            try (ResultSet result = cursor.executeQuery()) {
                if (!result.next() || !query.pageToken().equals(result.getString("token_value"))) {
                    throw new ProjectListUnavailable("PAGE_TOKEN_INVALID");
                }
                if (!actor.tenantId().equals(result.getString("tenant_id"))
                        || !actor.principalId().equals(result.getString("principal_id"))
                        || !query.workspaceId().equals(result.getString("workspace_id"))
                        || !query.queryFingerprint().equals(result.getString("query_fingerprint"))) {
                    throw new ProjectListUnavailable("PAGE_TOKEN_INVALID");
                }
                if (!result.getBoolean("cursor_live")) {
                    throw new ProjectListUnavailable("PAGE_TOKEN_INVALID");
                }
                if (result.getString("available_snapshot_ref") == null || !result.getBoolean("snapshot_live")) {
                    throw new ProjectListUnavailable("SNAPSHOT_UNAVAILABLE");
                }
                snapshotRef = result.getString("snapshot_ref");
                offset = result.getInt("next_offset");
                rowCount = result.getInt("row_count");
                observedAt = result.getObject("observed_at", OffsetDateTime.class).toInstant().toString();
                cursorLive = result.getBoolean("cursor_live");
                snapshotLive = result.getBoolean("snapshot_live");
            }
        }
        if (!cursorLive || !snapshotLive || offset <= 0 || offset >= rowCount
                || rowCount > PROJECT_LIST_MAX_SNAPSHOT_ROWS) {
            throw new ProjectListUnavailable("SNAPSHOT_UNAVAILABLE");
        }

        List<ProjectListRecord> page = readProjectListSnapshotRows(connection, snapshotRef, offset);
        int expectedPageSize = Math.min(PROJECT_LIST_PAGE_SIZE, rowCount - offset);
        if (page.size() != expectedPageSize) throw new ProjectListUnavailable("SNAPSHOT_UNAVAILABLE");
        int nextOffset = offset + page.size();
        String nextPageToken = nextOffset < rowCount
                ? ensureProjectListCursor(connection, snapshotRef, actor, query, nextOffset, null)
                : null;
        return new ProjectListObserved(PROJECT_LIST_OPERATION, "OBSERVED", actor.tenantId(), actor.principalId(),
                query.workspaceId(), query.queryFingerprint(), snapshotRef, observedAt, page, nextPageToken);
    }

    private static void insertProjectListSnapshotRows(Connection connection, String snapshotRef,
                                                      List<ProjectListRecord> rows) throws SQLException {
        try (PreparedStatement insert = connection.prepareStatement("""
                INSERT INTO media_project_list_snapshot_rows
                  (snapshot_ref,row_ordinal,project_id,workspace_id,title,project_state,head_revision_id)
                VALUES (?,?,?,?,?,?,?)
                """)) {
            for (int index = 0; index < rows.size(); index++) {
                ProjectListRecord row = rows.get(index);
                insert.setString(1, snapshotRef);
                insert.setInt(2, index);
                insert.setString(3, row.projectId());
                insert.setString(4, row.workspaceId());
                insert.setString(5, row.title());
                insert.setString(6, row.projectState());
                insert.setString(7, row.headRevisionId());
                insert.addBatch();
            }
            insert.executeBatch();
        }
    }

    private static List<ProjectListRecord> readProjectListSnapshotRows(Connection connection, String snapshotRef,
                                                                         int offset) throws SQLException {
        List<ProjectListRecord> rows = new ArrayList<>(PROJECT_LIST_PAGE_SIZE);
        try (PreparedStatement select = connection.prepareStatement("""
                SELECT project_id,workspace_id,title,project_state,head_revision_id
                FROM media_project_list_snapshot_rows
                WHERE snapshot_ref=? AND row_ordinal>=?
                ORDER BY row_ordinal
                LIMIT ?
                """)) {
            select.setString(1, snapshotRef);
            select.setInt(2, offset);
            select.setInt(3, PROJECT_LIST_PAGE_SIZE);
            try (ResultSet result = select.executeQuery()) {
                while (result.next()) {
                    rows.add(new ProjectListRecord(result.getString("project_id"), result.getString("workspace_id"),
                            result.getString("title"), result.getString("project_state"),
                            result.getString("head_revision_id")));
                }
            }
        }
        return rows;
    }

    private static String ensureProjectListCursor(Connection connection, String snapshotRef, Actor actor,
                                                  ProjectListQuery query, int nextOffset, OffsetDateTime expiresAt)
            throws SQLException {
        try (PreparedStatement insert = connection.prepareStatement("""
                INSERT INTO media_project_list_cursors
                  (token_hash,token_value,snapshot_ref,tenant_id,principal_id,workspace_id,query_fingerprint,next_offset,expires_at)
                VALUES (?,?,?,?,?,?,?,?,COALESCE(?,(SELECT s.expires_at FROM media_project_list_snapshots s WHERE s.snapshot_ref=?)))
                ON CONFLICT (snapshot_ref,next_offset) DO NOTHING
                """)) {
            insert.setString(1, cursorTokenHash(query.nextPageTokenCandidate()));
            insert.setString(2, query.nextPageTokenCandidate());
            insert.setString(3, snapshotRef);
            insert.setString(4, actor.tenantId());
            insert.setString(5, actor.principalId());
            insert.setString(6, query.workspaceId());
            insert.setString(7, query.nextPageTokenQueryFingerprint());
            insert.setInt(8, nextOffset);
            if (expiresAt == null) insert.setNull(9, java.sql.Types.TIMESTAMP_WITH_TIMEZONE);
            else insert.setObject(9, expiresAt);
            insert.setString(10, snapshotRef);
            insert.executeUpdate();
        }
        try (PreparedStatement select = connection.prepareStatement("""
                SELECT token_value FROM media_project_list_cursors
                WHERE snapshot_ref=? AND next_offset=?
                """)) {
            select.setString(1, snapshotRef);
            select.setInt(2, nextOffset);
            try (ResultSet result = select.executeQuery()) {
                if (!result.next()) throw new SQLException("project-list continuation cursor was not persisted");
                return result.getString("token_value");
            }
        }
    }

    private static void lockProjectListSnapshotScope(Connection connection, Actor actor, String workspaceId)
            throws SQLException {
        String scope = actor.tenantId().length() + ":" + actor.tenantId()
                + actor.principalId().length() + ":" + actor.principalId()
                + workspaceId.length() + ":" + workspaceId;
        try (PreparedStatement lock = connection.prepareStatement(
                "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))")) {
            lock.setString(1, scope);
            lock.execute();
        }
    }

    private static void cleanupAndBoundProjectListSnapshots(Connection connection, Actor actor, String workspaceId)
            throws SQLException, ProjectListUnavailable {
        try (PreparedStatement cleanup = connection.prepareStatement("""
                DELETE FROM media_project_list_snapshots
                WHERE snapshot_ref = (
                    SELECT snapshot_ref FROM media_project_list_snapshots
                    WHERE expires_at <= clock_timestamp()
                    ORDER BY expires_at,snapshot_ref
                    LIMIT 1
                )
                """)) {
            cleanup.executeUpdate();
        }
        try (PreparedStatement cleanup = connection.prepareStatement("""
                DELETE FROM media_project_list_snapshots
                WHERE snapshot_ref IN (
                    SELECT snapshot_ref FROM media_project_list_snapshots
                    WHERE tenant_id=? AND principal_id=? AND workspace_id=?
                      AND expires_at <= clock_timestamp()
                    ORDER BY expires_at
                    LIMIT ?
                )
                """)) {
            cleanup.setString(1, actor.tenantId());
            cleanup.setString(2, actor.principalId());
            cleanup.setString(3, workspaceId);
            cleanup.setInt(4, PROJECT_LIST_EXPIRED_CLEANUP_BATCH);
            cleanup.executeUpdate();
        }
        if (snapshotCount(connection, actor, workspaceId) >= PROJECT_LIST_MAX_ACTIVE_SCOPE_SNAPSHOTS) {
            throw new ProjectListUnavailable("QUERY_UNAVAILABLE");
        }
    }

    private static int snapshotCount(Connection connection, Actor actor, String workspaceId) throws SQLException {
        String sql = "SELECT count(*) FROM media_project_list_snapshots "
                + "WHERE tenant_id=? AND principal_id=? AND workspace_id=? AND expires_at > clock_timestamp()";
        try (PreparedStatement count = connection.prepareStatement(sql)) {
            count.setString(1, actor.tenantId());
            count.setString(2, actor.principalId());
            count.setString(3, workspaceId);
            try (ResultSet result = count.executeQuery()) {
                if (!result.next()) throw new SQLException("project-list snapshot count returned no row");
                return result.getInt(1);
            }
        }
    }

    private static ProjectListUnknown projectListUnknown(String reason) {
        return new ProjectListUnknown(PROJECT_LIST_OPERATION, "UNKNOWN_OBSERVATION", reason);
    }

    private static String cursorTokenHash(String token) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(token.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    private static final class ProjectListUnavailable extends Exception {
        private final String reason;
        private ProjectListUnavailable(String reason) { this.reason = reason; }
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
        Revision candidate = new Revision(actor.tenantId(), projectId, revisionId, expected, timelines);
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                Project project = ownedProject(connection, actor, projectId);
                Revision prior = readRevisionIfPresent(connection, actor.tenantId(), projectId, revisionId);
                if (prior != null) {
                    if (!Objects.equals(prior.parentRevisionId(), expected)
                            || !prior.timelines().equals(candidate.timelines())) {
                        throw new IllegalStateException("revision identity was replayed with a different payload");
                    }
                    connection.rollback();
                    return prior;
                }
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
                insertRevision(connection, candidate);
                connection.commit();
                return candidate;
            } catch (SQLException | RuntimeException failure) {
                connection.rollback();
                throw failure;
            }
        } catch (SQLException failure) { throw new IllegalStateException("project revision commit failed", failure); }
    }

    @Override public Revision replayCommand(Actor actor, String projectId, String canonicalOperationRef,
                                            String requestId, String requestFingerprint) {
        validateCommandIdentity(actor, projectId, canonicalOperationRef, requestId, requestFingerprint);
        try (Connection connection = state.connection()) {
            return replayCommand(connection, actor, projectId, canonicalOperationRef, requestId, requestFingerprint);
        } catch (SQLException failure) {
            throw new IllegalStateException("project command receipt readback failed", failure);
        }
    }

    @Override public Revision commitCommand(Actor actor, String projectId, String expectedHeadRevisionId,
                                            String canonicalOperationRef, String requestId, String requestFingerprint,
                                            String newRevisionId, List<TimelineSnapshot> timelines) {
        validateCommandIdentity(actor, projectId, canonicalOperationRef, requestId, requestFingerprint);
        String expected = MediaProjectTimelineContracts.requiredOpaqueId(expectedHeadRevisionId, "expectedHeadRevisionId");
        String revisionId = MediaProjectTimelineContracts.requiredOpaqueId(newRevisionId, "newRevisionId");
        List<TimelineSnapshot> snapshots = List.copyOf(Objects.requireNonNull(timelines, "timelines"));
        Revision candidate = new Revision(actor.tenantId(), projectId, revisionId, expected, snapshots);
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                Revision prior = replayCommand(connection, actor, projectId, canonicalOperationRef,
                        requestId, requestFingerprint);
                if (prior != null) {
                    connection.rollback();
                    return prior;
                }
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
                insertRevision(connection, candidate);
                try (PreparedStatement receipt = connection.prepareStatement("""
                        INSERT INTO media_timeline_command_receipts
                          (tenant_id,principal_id,canonical_operation_ref,request_id,request_fingerprint,project_id,revision_id)
                        VALUES (?,?,?,?,?,?,?)
                        """)) {
                    receipt.setString(1, actor.tenantId()); receipt.setString(2, actor.principalId());
                    receipt.setString(3, canonicalOperationRef); receipt.setString(4, requestId);
                    receipt.setString(5, requestFingerprint); receipt.setString(6, projectId);
                    receipt.setString(7, revisionId); receipt.executeUpdate();
                }
                connection.commit();
                return candidate;
            } catch (SQLException | RuntimeException failure) {
                connection.rollback();
                if (failure instanceof RevisionConflictException
                        || failure instanceof SQLException sql && "23505".equals(sql.getSQLState())) {
                    Revision replay = replayCommand(actor, projectId, canonicalOperationRef, requestId, requestFingerprint);
                    if (replay != null) return replay;
                }
                throw failure;
            }
        } catch (SQLException failure) {
            throw new IllegalStateException("project command commit failed", failure);
        }
    }

    private Revision replayCommand(Connection connection, Actor actor, String projectId, String canonicalOperationRef,
                                   String requestId, String requestFingerprint) throws SQLException {
        try (PreparedStatement select = connection.prepareStatement("""
                SELECT request_fingerprint,project_id,revision_id FROM media_timeline_command_receipts
                WHERE tenant_id=? AND principal_id=? AND canonical_operation_ref=? AND request_id=?
                """)) {
            select.setString(1, actor.tenantId()); select.setString(2, actor.principalId());
            select.setString(3, canonicalOperationRef); select.setString(4, requestId);
            try (ResultSet row = select.executeQuery()) {
                if (!row.next()) return null;
                if (!row.getString(1).equals(requestFingerprint) || !row.getString(2).equals(projectId)) {
                    throw new MediaProjectTimelineContracts.IdempotencyConflictException();
                }
                ownedProject(connection, actor, projectId);
                return readRevision(connection, actor.tenantId(), projectId, row.getString(3));
            }
        }
    }

    private static void validateCommandIdentity(Actor actor, String projectId, String canonicalOperationRef,
                                                String requestId, String requestFingerprint) {
        Objects.requireNonNull(actor, "actor");
        MediaProjectTimelineContracts.requiredOpaqueId(projectId, "projectId");
        MediaProjectTimelineContracts.requireCanonicalOperationRef(canonicalOperationRef);
        MediaProjectTimelineContracts.requireRequestId(requestId);
        MediaProjectTimelineContracts.requireRequestFingerprint(requestFingerprint);
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

    private Revision readRevisionIfPresent(Connection connection, String tenantId, String projectId, String revisionId)
            throws SQLException {
        try (PreparedStatement select = connection.prepareStatement("""
                SELECT parent_revision_id,timeline_snapshots::text FROM media_timeline_revisions
                WHERE tenant_id=? AND project_id=? AND revision_id=?
                """)) {
            select.setString(1, tenantId); select.setString(2, projectId); select.setString(3, revisionId);
            try (ResultSet row = select.executeQuery()) {
                if (!row.next()) return null;
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
