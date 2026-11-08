package com.ghatana.media.provider.aws;

import com.ghatana.media.production.timeline.StoryboardPlanner;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectAccessDeniedException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectNotFoundException;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.HexFormat;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Append-only draft persistence for typed storyboard plans.
 *
 * <p>This adapter is not wired into the Media launcher. It stores the immutable
 * planner projection without mapping it into a project timeline graph or
 * establishing reviewer, source-rights, or production authority.</p>
 */
final class PostgresqlStoryboardPlanAuthority implements StoryboardPlanner.ScenePlanAuthority, AutoCloseable {
    private final MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
    private final AtomicBoolean closed = new AtomicBoolean();

    @Override
    public StoryboardPlanner.SavedPlan append(Actor actor, StoryboardPlanner.ScenePlan plan,
            String expectedProjectHeadRevisionId, String expectedParentSemanticVersion, String requestId) {
        ensureOpen();
        Objects.requireNonNull(actor, "actor");
        Objects.requireNonNull(plan, "plan");
        if (!actor.tenantId().equals(plan.tenantId())) throw new ProjectNotFoundException();
        if (!actor.principalId().equals(plan.ownerPrincipalId())) throw new ProjectAccessDeniedException();
        String expectedHead = requiredOpaqueId(expectedProjectHeadRevisionId, "expectedProjectHeadRevisionId");
        String parentVersion = expectedParentSemanticVersion == null
                ? null : requiredSemanticVersion(expectedParentSemanticVersion, "expectedParentSemanticVersion");
        if (!expectedHead.equals(plan.expectedProjectRevisionId())) {
            throw new StoryboardPlanner.ScenePlanAuthorityProtocolException(
                    "append expected project head differs from the prepared plan");
        }
        String request = requiredRequestId(requestId);
        String snapshot = serialize(plan);
        String fingerprint = fingerprint(actor, plan, expectedHead, parentVersion, snapshot);

        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                ProjectRow project = lockProject(connection, actor, plan.projectId());
                ReceiptRow prior = receipt(connection, actor, request);
                if (prior != null) {
                    if (!prior.fingerprint().equals(fingerprint)) {
                        throw new StoryboardPlanner.ScenePlanConflictException(
                                "storyboard save requestId was already used with a different payload");
                    }
                    StoryboardPlanner.SavedPlan replay = readSaved(connection, actor, plan.projectId(),
                            prior.scenePlanId(), prior.semanticVersion());
                    connection.commit();
                    return replay;
                }
                if (!project.headRevisionId().equals(expectedHead)) {
                    throw new StoryboardPlanner.ScenePlanConflictException(
                            "project head changed before the storyboard draft append");
                }

                String currentParent = currentPlanHead(connection, plan);
                if (!Objects.equals(currentParent, parentVersion)) {
                    throw new StoryboardPlanner.ScenePlanConflictException(
                            "expected storyboard parent semantic version is not current");
                }
                if (Objects.equals(currentParent, plan.semanticVersion())) {
                    throw new StoryboardPlanner.DuplicateScenePlanVersionException();
                }
                if (editionExists(connection, actor, plan)) {
                    throw new StoryboardPlanner.DuplicateScenePlanVersionException();
                }

                String ownerReceipt = "storyboard-plan-receipt:" + UUID.randomUUID();
                insertEdition(connection, actor, plan, parentVersion, fingerprint, snapshot, ownerReceipt);
                updatePlanHead(connection, plan, currentParent);
                insertReceipt(connection, actor, request, fingerprint, plan, ownerReceipt);
                connection.commit();
                return new StoryboardPlanner.SavedPlan(plan, ownerReceipt);
            } catch (SQLException | RuntimeException failure) {
                rollback(connection, failure);
                throw failure;
            }
        } catch (SQLException failure) {
            throw new IllegalStateException("storyboard draft append failed", failure);
        }
    }

    /** Read an immutable persisted draft by its exact identity; this is local store evidence only. */
    public StoryboardPlanner.SavedPlan read(Actor actor, String projectId, String scenePlanId,
            String semanticVersion) {
        ensureOpen();
        Objects.requireNonNull(actor, "actor");
        projectId = requiredOpaqueId(projectId, "projectId");
        scenePlanId = requiredOpaqueId(scenePlanId, "scenePlanId");
        semanticVersion = requiredSemanticVersion(semanticVersion, "semanticVersion");
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                lockProject(connection, actor, projectId);
                StoryboardPlanner.SavedPlan saved = readSaved(connection, actor, projectId, scenePlanId, semanticVersion);
                connection.commit();
                return saved;
            } catch (SQLException | RuntimeException failure) {
                rollback(connection, failure);
                throw failure;
            }
        } catch (SQLException failure) {
            throw new IllegalStateException("storyboard draft read failed", failure);
        }
    }

    private ProjectRow lockProject(Connection connection, Actor actor, String projectId) throws SQLException {
        try (PreparedStatement select = connection.prepareStatement("""
                SELECT owner_principal_id,head_revision_id FROM media_timeline_projects
                WHERE tenant_id=? AND project_id=? FOR UPDATE
                """)) {
            select.setString(1, actor.tenantId());
            select.setString(2, projectId);
            try (ResultSet row = select.executeQuery()) {
                if (!row.next()) throw new ProjectNotFoundException();
                if (!actor.principalId().equals(row.getString(1))) throw new ProjectAccessDeniedException();
                return new ProjectRow(row.getString(2));
            }
        }
    }

    private ReceiptRow receipt(Connection connection, Actor actor, String requestId) throws SQLException {
        try (PreparedStatement select = connection.prepareStatement("""
                SELECT request_fingerprint,scene_plan_id,semantic_version
                FROM media_storyboard_plan_save_receipts
                WHERE tenant_id=? AND principal_id=? AND request_id=?
                """)) {
            select.setString(1, actor.tenantId());
            select.setString(2, actor.principalId());
            select.setString(3, requestId);
            try (ResultSet row = select.executeQuery()) {
                return row.next() ? new ReceiptRow(row.getString(1).trim(), row.getString(2), row.getString(3)) : null;
            }
        }
    }

    private String currentPlanHead(Connection connection, StoryboardPlanner.ScenePlan plan) throws SQLException {
        try (PreparedStatement select = connection.prepareStatement("""
                SELECT current_semantic_version FROM media_storyboard_plan_heads
                WHERE tenant_id=? AND project_id=? AND scene_plan_id=? FOR UPDATE
                """)) {
            select.setString(1, plan.tenantId());
            select.setString(2, plan.projectId());
            select.setString(3, plan.scenePlanId());
            try (ResultSet row = select.executeQuery()) {
                return row.next() ? row.getString(1) : null;
            }
        }
    }

    private boolean editionExists(Connection connection, Actor actor, StoryboardPlanner.ScenePlan plan)
            throws SQLException {
        try (PreparedStatement select = connection.prepareStatement("""
                SELECT 1 FROM media_storyboard_plan_editions
                WHERE tenant_id=? AND project_id=? AND scene_plan_id=? AND semantic_version=?
                """)) {
            select.setString(1, actor.tenantId());
            select.setString(2, plan.projectId());
            select.setString(3, plan.scenePlanId());
            select.setString(4, plan.semanticVersion());
            try (ResultSet row = select.executeQuery()) {
                return row.next();
            }
        }
    }

    private void insertEdition(Connection connection, Actor actor, StoryboardPlanner.ScenePlan plan,
            String parentVersion, String fingerprint, String snapshot, String ownerReceipt) throws SQLException {
        try (PreparedStatement insert = connection.prepareStatement("""
                INSERT INTO media_storyboard_plan_editions
                  (tenant_id,project_id,scene_plan_id,semantic_version,owner_principal_id,
                   expected_project_revision_id,parent_semantic_version,plan_fingerprint,plan_snapshot,owner_receipt)
                VALUES (?,?,?,?,?,?,?,?,?::jsonb,?)
                """)) {
            insert.setString(1, actor.tenantId());
            insert.setString(2, plan.projectId());
            insert.setString(3, plan.scenePlanId());
            insert.setString(4, plan.semanticVersion());
            insert.setString(5, actor.principalId());
            insert.setString(6, plan.expectedProjectRevisionId());
            insert.setString(7, parentVersion);
            insert.setString(8, fingerprint);
            insert.setString(9, snapshot);
            insert.setString(10, ownerReceipt);
            insert.executeUpdate();
        }
    }

    private void updatePlanHead(Connection connection, StoryboardPlanner.ScenePlan plan,
            String expectedParent) throws SQLException {
        if (expectedParent == null) {
            try (PreparedStatement insert = connection.prepareStatement("""
                    INSERT INTO media_storyboard_plan_heads
                      (tenant_id,project_id,scene_plan_id,current_semantic_version)
                    VALUES (?,?,?,?)
                    """)) {
                insert.setString(1, plan.tenantId());
                insert.setString(2, plan.projectId());
                insert.setString(3, plan.scenePlanId());
                insert.setString(4, plan.semanticVersion());
                insert.executeUpdate();
            }
        } else {
            try (PreparedStatement update = connection.prepareStatement("""
                    UPDATE media_storyboard_plan_heads SET current_semantic_version=?
                    WHERE tenant_id=? AND project_id=? AND scene_plan_id=? AND current_semantic_version=?
                    """)) {
                update.setString(1, plan.semanticVersion());
                update.setString(2, plan.tenantId());
                update.setString(3, plan.projectId());
                update.setString(4, plan.scenePlanId());
                update.setString(5, expectedParent);
                if (update.executeUpdate() != 1) {
                    throw new StoryboardPlanner.ScenePlanConflictException(
                            "storyboard parent semantic version changed during append");
                }
            }
        }
    }

    private void insertReceipt(Connection connection, Actor actor, String requestId,
            String fingerprint, StoryboardPlanner.ScenePlan plan, String ownerReceipt) throws SQLException {
        try (PreparedStatement insert = connection.prepareStatement("""
                INSERT INTO media_storyboard_plan_save_receipts
                  (tenant_id,principal_id,request_id,request_fingerprint,project_id,scene_plan_id,
                   semantic_version,owner_receipt)
                VALUES (?,?,?,?,?,?,?,?)
                """)) {
            insert.setString(1, actor.tenantId());
            insert.setString(2, actor.principalId());
            insert.setString(3, requestId);
            insert.setString(4, fingerprint);
            insert.setString(5, plan.projectId());
            insert.setString(6, plan.scenePlanId());
            insert.setString(7, plan.semanticVersion());
            insert.setString(8, ownerReceipt);
            insert.executeUpdate();
        }
    }

    private StoryboardPlanner.SavedPlan readSaved(Connection connection, Actor actor, String projectId,
            String scenePlanId, String semanticVersion) throws SQLException {
        try (PreparedStatement select = connection.prepareStatement("""
                SELECT owner_principal_id,plan_snapshot::text,owner_receipt
                FROM media_storyboard_plan_editions
                WHERE tenant_id=? AND project_id=? AND scene_plan_id=? AND semantic_version=?
                """)) {
            select.setString(1, actor.tenantId());
            select.setString(2, projectId);
            select.setString(3, scenePlanId);
            select.setString(4, semanticVersion);
            try (ResultSet row = select.executeQuery()) {
                if (!row.next()) throw new ProjectNotFoundException();
                if (!actor.principalId().equals(row.getString(1))) throw new ProjectAccessDeniedException();
                StoryboardPlanner.ScenePlan plan = deserialize(row.getString(2));
                if (!plan.tenantId().equals(actor.tenantId()) || !plan.ownerPrincipalId().equals(actor.principalId())
                        || !plan.projectId().equals(projectId) || !plan.scenePlanId().equals(scenePlanId)
                        || !plan.semanticVersion().equals(semanticVersion)) {
                    throw new IllegalStateException("persisted storyboard plan identity does not match its key");
                }
                return new StoryboardPlanner.SavedPlan(plan, row.getString(3));
            }
        }
    }

    private String serialize(StoryboardPlanner.ScenePlan plan) {
        try {
            return state.mapper().writeValueAsString(plan);
        } catch (Exception failure) {
            throw new IllegalArgumentException("storyboard plan cannot be serialized", failure);
        }
    }

    private StoryboardPlanner.ScenePlan deserialize(String json) {
        try {
            return state.mapper().readValue(json, StoryboardPlanner.ScenePlan.class);
        } catch (Exception failure) {
            throw new IllegalStateException("persisted storyboard plan cannot be read", failure);
        }
    }

    private String fingerprint(Actor actor, StoryboardPlanner.ScenePlan plan, String expectedHead,
            String parentVersion, String snapshot) {
        try {
            byte[] payload = snapshot.getBytes(StandardCharsets.UTF_8);
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (DataOutputStream output = new DataOutputStream(bytes)) {
                write(output, actor.tenantId());
                write(output, actor.principalId());
                write(output, plan.projectId());
                write(output, plan.scenePlanId());
                write(output, plan.semanticVersion());
                write(output, expectedHead);
                write(output, parentVersion == null ? "" : parentVersion);
                output.writeInt(payload.length);
                output.write(payload);
            }
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes.toByteArray()));
        } catch (IOException | NoSuchAlgorithmException failure) {
            throw new IllegalStateException("storyboard plan fingerprint failed", failure);
        }
    }

    private static void write(DataOutputStream output, String value) throws IOException {
        byte[] encoded = value.getBytes(StandardCharsets.UTF_8);
        output.writeInt(encoded.length);
        output.write(encoded);
    }

    private static String requiredOpaqueId(String value, String field) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
            throw new IllegalArgumentException(field + " is invalid");
        }
        return value;
    }

    private static String requiredSemanticVersion(String value, String field) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9.+:-]{0,127}")) {
            throw new IllegalArgumentException(field + " is invalid");
        }
        return value;
    }

    private static String requiredRequestId(String value) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
            throw new IllegalArgumentException("requestId is invalid");
        }
        return value;
    }

    private static void rollback(Connection connection, Throwable failure) {
        try {
            connection.rollback();
        } catch (SQLException rollbackFailure) {
            failure.addSuppressed(rollbackFailure);
        }
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("PostgreSQL storyboard plan authority is closed");
    }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) state.release();
    }

    private record ProjectRow(String headRevisionId) { }
    private record ReceiptRow(String fingerprint, String scenePlanId, String semanticVersion) { }
}
