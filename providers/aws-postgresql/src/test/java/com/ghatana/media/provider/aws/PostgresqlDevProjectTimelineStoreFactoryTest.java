package com.ghatana.media.provider.aws;

import com.ghatana.media.production.timeline.ProjectTimelineEngine;
import com.ghatana.media.production.timeline.ProjectTimelineEngine.AddScene;
import com.ghatana.media.production.timeline.ProjectTimelineEngine.AddTrack;
import com.ghatana.media.production.timeline.ProjectTimelineEngine.Edit;
import com.ghatana.media.production.timeline.ProjectTimelineEngine.PutClip;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Clock;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Clip;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.IdempotencyConflictException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectAccessDeniedException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectNotFoundException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectListObserved;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectListQuery;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectListUnknown;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.RationalTime;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.RevisionConflictException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Scene;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceVersion;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Track;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.TrackKind;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.sql.DriverManager;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@Testcontainers(disabledWithoutDocker = true)
class PostgresqlDevProjectTimelineStoreFactoryTest {
    private static final String WORKSPACE = "dev-workspace.8fcb3f014ad7505274bca5de0470c1a7";
    private static final String FINGERPRINT_0 = "sha256:" + "0".repeat(64);
    private static final String FINGERPRINT_1 = "sha256:" + "1".repeat(64);
    private static final String FINGERPRINT_2 = "sha256:" + "2".repeat(64);

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:16-alpine");

    @Test
    void devOnlyStoreUsesIsolatedSchemaAndPersistsRevisionAcrossStoreRestart() throws Exception {
        String schema = "media_dev_" + UUID.randomUUID().toString().replace("-", "");
        Map<String, String> environment = environment(schema);
        var factory = new PostgresqlDevProjectTimelineStoreFactory();
        Actor actor = new Actor("tenant-dev", "principal-dev");
        String projectId;
        String initialRevisionId;
        String timelineRevisionId;
        String editedRevisionId;
        String restoredRevisionId;
        String editRequestId = "timeline-edit-replay-main";
        List<Edit> replayableEdit;
        List<Edit> equivalentEncoding;

        try (var store = factory.createDevOnly(environment)) {
            ProjectTimelineEngine engine = new ProjectTimelineEngine(store);
            var created = engine.createProject(actor,
                    "dev-workspace.8fcb3f014ad7505274bca5de0470c1a7", "Persisted project", "request-dev-1");
            assertThat(created.createdNow()).isTrue();
            assertThat(created.initialRevision().timelines()).isEmpty();
            projectId = created.project().projectId();
            initialRevisionId = created.initialRevision().revisionId();
            assertThatThrownBy(() -> engine.project(new Actor("tenant-dev", "principal-other"), projectId))
                    .isInstanceOf(ProjectAccessDeniedException.class);
            assertThatThrownBy(() -> engine.project(new Actor("tenant-other", "principal-dev"), projectId))
                    .isInstanceOf(ProjectNotFoundException.class);
            assertThatThrownBy(() -> engine.createProject(actor,
                    "dev-workspace.8fcb3f014ad7505274bca5de0470c1a7", "Different title", "request-dev-1"))
                    .isInstanceOf(IdempotencyConflictException.class);
            var timeline = engine.createTimeline(actor, projectId, initialRevisionId, "timeline-main");
            assertThat(timeline.parentRevisionId()).isEqualTo(initialRevisionId);
            assertThat(timeline.timelines()).singleElement().satisfies(snapshot -> {
                assertThat(snapshot.timelineId()).isEqualTo("timeline-main");
                assertThat(snapshot.semanticVersionId()).isNotBlank();
                assertThat(snapshot.graph().scenes()).isEmpty();
            });
            timelineRevisionId = timeline.revisionId();
            assertThatThrownBy(() -> engine.createTimeline(actor, projectId, initialRevisionId, "timeline-stale"))
                    .isInstanceOf(RevisionConflictException.class);
            assertThat(engine.project(actor, projectId).headRevisionId()).isEqualTo(timelineRevisionId);

            Scene scene = new Scene("scene-main", 0);
            Track track = new Track("track-main", scene.sceneId(), TrackKind.VIDEO, 0);
            Clip clip = new Clip("clip-main", scene.sceneId(), track.trackId(),
                    new SourceVersion("artifact-main", "version-main"),
                    new RationalTime(0, 30_000, 1, Clock.SOURCE_PRESENTATION),
                    new RationalTime(30_000, 30_000, 1, Clock.SOURCE_PRESENTATION),
                    new RationalTime(0, 24, 1, Clock.STORY),
                    new RationalTime(24, 24, 1, Clock.STORY));
            replayableEdit = List.of(new AddScene(scene), new AddTrack(track), new PutClip(clip));
            Clip equivalentClip = new Clip(clip.clipId(), clip.sceneId(), clip.trackId(), clip.source(),
                    new RationalTime(0, 1, 1, Clock.SOURCE_PRESENTATION),
                    new RationalTime(1, 1, 1, Clock.SOURCE_PRESENTATION),
                    new RationalTime(0, 1, 1, Clock.STORY),
                    new RationalTime(1, 1, 1, Clock.STORY));
            assertThat(equivalentClip).isEqualTo(clip);
            equivalentEncoding = List.of(new AddScene(scene), new AddTrack(track),
                    new PutClip(equivalentClip));
            var edited = engine.edit(actor, projectId, "timeline-main", timelineRevisionId,
                    replayableEdit, editRequestId);
            editedRevisionId = edited.revisionId();
            assertThat(edited.timelines()).singleElement().satisfies(snapshot -> {
                assertThat(snapshot.timelineId()).isEqualTo("timeline-main");
                assertThat(snapshot.semanticVersionId()).isNotEqualTo(
                        engine.revision(actor, projectId, timelineRevisionId).timelines().getFirst().semanticVersionId());
                assertThat(snapshot.graph().scenes()).extracting(sceneEntry -> sceneEntry.sceneId())
                        .containsExactly("scene-main");
            });
            var restored = engine.restore(actor, projectId, editedRevisionId, initialRevisionId);
            restoredRevisionId = restored.revisionId();
            assertThat(restored.timelines()).isEmpty();
            assertThat(engine.project(actor, projectId).headRevisionId()).isEqualTo(restoredRevisionId);
        }

        try (var restarted = factory.createDevOnly(environment)) {
            ProjectTimelineEngine engine = new ProjectTimelineEngine(restarted);
            assertThat(engine.project(actor, projectId).headRevisionId()).isEqualTo(restoredRevisionId);
            assertThat(engine.revision(actor, projectId, initialRevisionId).timelines()).isEmpty();
            assertThat(engine.revision(actor, projectId, timelineRevisionId).timelines())
                    .extracting(snapshot -> snapshot.timelineId()).containsExactly("timeline-main");
            assertThat(engine.revision(actor, projectId, editedRevisionId).timelines().getFirst().graph().scenes())
                    .extracting(scene -> scene.sceneId()).containsExactly("scene-main");
            assertThat(engine.edit(actor, projectId, "timeline-main", timelineRevisionId,
                    replayableEdit, editRequestId)).isEqualTo(
                    engine.revision(actor, projectId, editedRevisionId));
            assertThatThrownBy(() -> engine.edit(actor, projectId, "timeline-main", timelineRevisionId,
                    equivalentEncoding, editRequestId)).isInstanceOf(IdempotencyConflictException.class);
            assertThat(engine.project(actor, projectId).headRevisionId()).isEqualTo(restoredRevisionId);
            assertThat(engine.currentRevision(actor, projectId).timelines()).isEmpty();
            var replay = engine.createProject(actor,
                    "dev-workspace.8fcb3f014ad7505274bca5de0470c1a7", "Persisted project", "request-dev-1");
            assertThat(replay.createdNow()).isFalse();
            assertThat(replay.project().projectId()).isEqualTo(projectId);
            assertThat(replay.initialRevision().revisionId()).isEqualTo(initialRevisionId);
        }

        try (var connection = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.createStatement()) {
            try (var query = statement.executeQuery("SELECT count(*) FROM \"" + schema + "\".media_timeline_projects")) {
                assertThat(query.next()).isTrue();
                assertThat(query.getLong(1)).isEqualTo(1);
            }
            try (var query = statement.executeQuery("SELECT to_regclass('public.media_timeline_projects')")) {
                assertThat(query.next()).isTrue();
                assertThat(query.getString(1)).isNull();
            }
            statement.execute("DROP SCHEMA \"" + schema + "\" CASCADE");
        }
    }

    @Test
    void projectListSnapshotPagesAreOwnerScopedStableAcrossMutationAndRestart() throws Exception {
        String schema = "media_dev_" + UUID.randomUUID().toString().replace("-", "");
        Map<String, String> environment = environment(schema);
        var factory = new PostgresqlDevProjectTimelineStoreFactory();
        Actor actor = new Actor("tenant-list", "principal-list");
        List<com.ghatana.media.runtime.MediaProjectTimelineContracts.Created> projects = new ArrayList<>();
        ProjectListObserved first;
        String mutatedProjectId;
        String originalHeadRevisionId;

        try {
            try (var store = factory.createDevOnly(environment)) {
                ProjectTimelineEngine engine = new ProjectTimelineEngine(store);
                for (int index = 0; index < 51; index++) {
                    projects.add(engine.createProject(actor, WORKSPACE, "Project " + index,
                            "project-list-create-" + index));
                }
                engine.createProject(new Actor(actor.tenantId(), "principal-list-other"), WORKSPACE,
                        "Other owner's project", "project-list-other-owner");
                var firstResult = store.listProjects(new ProjectListQuery(actor, WORKSPACE, null, FINGERPRINT_0,
                        "cursor-first-page", FINGERPRINT_1));
                assertThat(firstResult).isInstanceOf(ProjectListObserved.class);
                first = (ProjectListObserved) firstResult;
                assertThat(first.records()).hasSize(50);
                assertThat(first.nextPageToken()).isNotNull();

                var firstPageIds = first.records().stream().map(row -> row.projectId()).toList();
                var unobserved = projects.stream().map(created -> created.project().projectId())
                        .filter(projectId -> !firstPageIds.contains(projectId)).findFirst().orElseThrow();
                var before = engine.project(actor, unobserved);
                mutatedProjectId = before.projectId();
                originalHeadRevisionId = before.headRevisionId();
                engine.createTimeline(actor, mutatedProjectId, originalHeadRevisionId,
                        "timeline-after-list-snapshot");

                // A new row committed after page one must not enter this already-observed point-in-time snapshot.
                engine.createProject(actor, WORKSPACE, "Created after snapshot", "project-list-created-later");
            }

            try (var restarted = factory.createDevOnly(environment)) {
                var secondResult = restarted.listProjects(new ProjectListQuery(actor, WORKSPACE, first.nextPageToken(),
                        FINGERPRINT_1, "cursor-second-page", FINGERPRINT_2));
                assertThat(secondResult).isInstanceOf(ProjectListObserved.class);
                var second = (ProjectListObserved) secondResult;
                assertThat(second.snapshotRef()).isEqualTo(first.snapshotRef());
                assertThat(second.observedAt()).isEqualTo(first.observedAt());
                assertThat(second.records()).hasSize(1);
                assertThat(second.records().getFirst().projectId()).isEqualTo(mutatedProjectId);
                assertThat(second.records().getFirst().headRevisionId()).isEqualTo(originalHeadRevisionId);
                assertThat(second.nextPageToken()).isNull();
            }
        } finally { dropSchema(schema); }
    }

    @Test
    void emptyProjectListIsAnObservedTerminalSnapshot() throws Exception {
        String schema = "media_dev_" + UUID.randomUUID().toString().replace("-", "");
        Map<String, String> environment = environment(schema);
        Actor actor = new Actor("tenant-list-empty", "principal-list-empty");
        try (var store = new PostgresqlDevProjectTimelineStoreFactory().createDevOnly(environment)) {
            var result = store.listProjects(new ProjectListQuery(actor, WORKSPACE, null, FINGERPRINT_0,
                    "cursor-empty-list", FINGERPRINT_1));
            assertThat(result).isInstanceOf(ProjectListObserved.class);
            var observed = (ProjectListObserved) result;
            assertThat(observed.tenantId()).isEqualTo(actor.tenantId());
            assertThat(observed.principalId()).isEqualTo(actor.principalId());
            assertThat(observed.workspaceId()).isEqualTo(WORKSPACE);
            assertThat(observed.records()).isEmpty();
            assertThat(observed.nextPageToken()).isNull();
        } finally {
            dropSchema(schema);
        }
    }

    @Test
    void projectListRejectsTamperedAndCrossScopeContinuationWithoutRowsOrToken() throws Exception {
        String schema = "media_dev_" + UUID.randomUUID().toString().replace("-", "");
        Map<String, String> environment = environment(schema);
        var factory = new PostgresqlDevProjectTimelineStoreFactory();
        Actor actor = new Actor("tenant-list-negative", "principal-list-negative");
        try {
            try (var store = factory.createDevOnly(environment)) {
                ProjectTimelineEngine engine = new ProjectTimelineEngine(store);
                for (int index = 0; index < 51; index++) {
                    engine.createProject(actor, WORKSPACE, "Project " + index,
                            "project-list-negative-" + index);
                }
                var first = (ProjectListObserved) store.listProjects(new ProjectListQuery(actor, WORKSPACE, null,
                        FINGERPRINT_0, "cursor-negative-first", FINGERPRINT_1));
                String tampered = first.nextPageToken().substring(0, first.nextPageToken().length() - 1)
                        + (first.nextPageToken().endsWith("a") ? "b" : "a");

                var tamperedResult = store.listProjects(new ProjectListQuery(actor, WORKSPACE, tampered,
                        FINGERPRINT_1, "cursor-negative-tampered", FINGERPRINT_2));
                assertUnknownWithoutRows(tamperedResult, "PAGE_TOKEN_INVALID");

                var foreignActor = new Actor(actor.tenantId(), "principal-list-foreign");
                var foreignResult = store.listProjects(new ProjectListQuery(foreignActor, WORKSPACE,
                        first.nextPageToken(), FINGERPRINT_1, "cursor-negative-foreign", FINGERPRINT_2));
                assertUnknownWithoutRows(foreignResult, "PAGE_TOKEN_INVALID");

                var foreignTenant = new Actor("tenant-list-foreign", actor.principalId());
                var foreignTenantResult = store.listProjects(new ProjectListQuery(foreignTenant, WORKSPACE,
                        first.nextPageToken(), FINGERPRINT_1, "cursor-negative-tenant", FINGERPRINT_2));
                assertUnknownWithoutRows(foreignTenantResult, "PAGE_TOKEN_INVALID");

                var foreignWorkspaceResult = store.listProjects(new ProjectListQuery(actor, "workspace-other",
                        first.nextPageToken(), FINGERPRINT_1, "cursor-negative-workspace", FINGERPRINT_2));
                assertUnknownWithoutRows(foreignWorkspaceResult, "PAGE_TOKEN_INVALID");

                var wrongFingerprintResult = store.listProjects(new ProjectListQuery(actor, WORKSPACE,
                        first.nextPageToken(), FINGERPRINT_2, "cursor-negative-fingerprint", FINGERPRINT_2));
                assertUnknownWithoutRows(wrongFingerprintResult, "PAGE_TOKEN_INVALID");

                String expireSql = "UPDATE \"" + schema + "\".media_project_list_snapshots "
                        + "SET observed_at=CURRENT_TIMESTAMP - INTERVAL '2 seconds', "
                        + "created_at=CURRENT_TIMESTAMP - INTERVAL '2 seconds', "
                        + "expires_at=CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE snapshot_ref=?";
                String expireCursorSql = "UPDATE \"" + schema + "\".media_project_list_cursors "
                        + "SET expires_at=CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE snapshot_ref=?";
                try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                        POSTGRES.getPassword());
                     var expire = connection.prepareStatement(expireSql);
                     var expireCursor = connection.prepareStatement(expireCursorSql)) {
                    expire.setString(1, first.snapshotRef());
                    assertThat(expire.executeUpdate()).isEqualTo(1);
                    expireCursor.setString(1, first.snapshotRef());
                    assertThat(expireCursor.executeUpdate()).isEqualTo(1);
                }
                var expiredResult = store.listProjects(new ProjectListQuery(actor, WORKSPACE,
                        first.nextPageToken(), FINGERPRINT_1, "cursor-negative-expired", FINGERPRINT_2));
                assertThat(expiredResult).isInstanceOf(ProjectListUnknown.class);
                assertThat(((ProjectListUnknown) expiredResult).reason()).isEqualTo("PAGE_TOKEN_INVALID");
                assertUnknownHasNoRowsOrContinuation(expiredResult);
            }
        } finally {
            try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                    POSTGRES.getUsername(), POSTGRES.getPassword());
                 var statement = connection.createStatement()) {
                statement.execute("DROP SCHEMA IF EXISTS \"" + schema + "\" CASCADE");
            }
        }
    }

    @Test
    void projectListBoundsActiveSnapshotsPerOwnerWorkspaceAndCleansExpiredRowsOnDemand() throws Exception {
        String schema = "media_dev_" + UUID.randomUUID().toString().replace("-", "");
        Map<String, String> environment = environment(schema);
        Actor actor = new Actor("tenant-list-quota", "principal-list-quota");
        try {
            try (var store = new PostgresqlDevProjectTimelineStoreFactory().createDevOnly(environment)) {
                ProjectListObserved first = null;
                for (int index = 0; index < 16; index++) {
                    var result = store.listProjects(new ProjectListQuery(actor, WORKSPACE, null, FINGERPRINT_0,
                            "cursor-quota-" + index, FINGERPRINT_1));
                    assertThat(result).isInstanceOf(ProjectListObserved.class);
                    if (index == 0) first = (ProjectListObserved) result;
                }
                var overQuota = store.listProjects(new ProjectListQuery(actor, WORKSPACE, null, FINGERPRINT_0,
                        "cursor-quota-over", FINGERPRINT_1));
                assertUnknownWithoutRows(overQuota, "QUERY_UNAVAILABLE");

                String expireSql = "UPDATE \"" + schema + "\".media_project_list_snapshots "
                        + "SET observed_at=CURRENT_TIMESTAMP - INTERVAL '2 seconds', "
                        + "created_at=CURRENT_TIMESTAMP - INTERVAL '2 seconds', "
                        + "expires_at=CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE snapshot_ref=?";
                try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                        POSTGRES.getPassword());
                     var expire = connection.prepareStatement(expireSql)) {
                    expire.setString(1, first.snapshotRef());
                    assertThat(expire.executeUpdate()).isEqualTo(1);
                }
                var afterExpiryCleanup = store.listProjects(new ProjectListQuery(actor, WORKSPACE, null,
                        FINGERPRINT_0, "cursor-quota-after-cleanup", FINGERPRINT_1));
                assertThat(afterExpiryCleanup).isInstanceOf(ProjectListObserved.class);
            }
        } finally {
            dropSchema(schema);
        }
    }

    @Test
    void projectListOverflowReturnsUnknownWithoutPersistingPartialSnapshot() throws Exception {
        String schema = "media_dev_" + UUID.randomUUID().toString().replace("-", "");
        Map<String, String> environment = environment(schema);
        Actor actor = new Actor("tenant-list-overflow", "principal-list-overflow");
        try {
            try (var store = new PostgresqlDevProjectTimelineStoreFactory().createDevOnly(environment);
                 var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                         POSTGRES.getPassword())) {
                connection.setAutoCommit(false);
                String projectInsertSql = "INSERT INTO \"" + schema + "\".media_timeline_projects "
                        + "(tenant_id,project_id,workspace_id,owner_principal_id,title,head_revision_id) "
                        + "VALUES (?,?,?,?,?,?)";
                String revisionInsertSql = "INSERT INTO \"" + schema + "\".media_timeline_revisions "
                        + "(tenant_id,project_id,revision_id,parent_revision_id,timeline_snapshots) "
                        + "VALUES (?,?,?,NULL,'[]'::jsonb)";
                try (var projects = connection.prepareStatement(projectInsertSql);
                     var revisions = connection.prepareStatement(revisionInsertSql)) {
                    for (int index = 0; index < 5_001; index++) {
                        String suffix = "%05d".formatted(index);
                        String projectId = "overflow-project-" + suffix;
                        String revisionId = "overflow-revision-" + suffix;
                        projects.setString(1, actor.tenantId());
                        projects.setString(2, projectId);
                        projects.setString(3, WORKSPACE);
                        projects.setString(4, actor.principalId());
                        projects.setString(5, "Overflow project " + suffix);
                        projects.setString(6, revisionId);
                        projects.addBatch();
                        revisions.setString(1, actor.tenantId());
                        revisions.setString(2, projectId);
                        revisions.setString(3, revisionId);
                        revisions.addBatch();
                    }
                    projects.executeBatch();
                    revisions.executeBatch();
                }
                connection.commit();

                var result = store.listProjects(new ProjectListQuery(actor, WORKSPACE, null, FINGERPRINT_0,
                        "cursor-overflow", FINGERPRINT_1));
                assertUnknownWithoutRows(result, "QUERY_UNAVAILABLE");
                try (var count = connection.prepareStatement("SELECT count(*) FROM \"" + schema
                        + "\".media_project_list_snapshots");
                     var rows = count.executeQuery()) {
                    assertThat(rows.next()).isTrue();
                    assertThat(rows.getLong(1)).isEqualTo(0L);
                }
            }
        } finally {
            dropSchema(schema);
        }
    }

    private static void assertUnknownWithoutRows(Object result, String reason) {
        assertThat(result).isInstanceOf(ProjectListUnknown.class);
        assertThat(((ProjectListUnknown) result).reason()).isEqualTo(reason);
        assertUnknownHasNoRowsOrContinuation(result);
    }

    private static void assertUnknownHasNoRowsOrContinuation(Object result) {
        assertThat(result).isInstanceOf(ProjectListUnknown.class);
        assertThat(result).isNotInstanceOf(ProjectListObserved.class);
    }

    private static void dropSchema(String schema) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword());
             var statement = connection.createStatement()) {
            statement.execute("DROP SCHEMA IF EXISTS \"" + schema + "\" CASCADE");
        }
    }

    @Test
    void refusesNonDevProfileAndNonLoopbackDatabaseBeforeConnecting() {
        assertThatIllegalArgumentException().isThrownBy(() ->
                new PostgresqlDevProjectTimelineStoreFactory().createDevOnly(Map.of(
                        "MEDIA_RUNTIME_ENVIRONMENT", "production",
                        "MEDIA_DEV_IDENTITY_ENABLED", "true",
                        "MEDIA_PROJECT_TIMELINE_DEV_ENABLED", "true")))
                .withMessageContaining("requires profile=dev");
        assertThatIllegalArgumentException().isThrownBy(() ->
                new PostgresqlDevProjectTimelineStoreFactory().createDevOnly(Map.of(
                        "MEDIA_RUNTIME_ENVIRONMENT", "dev",
                        "MEDIA_DEV_IDENTITY_ENABLED", "true",
                        "MEDIA_PROJECT_TIMELINE_DEV_ENABLED", "true",
                        "MEDIA_PROJECT_TIMELINE_POSTGRES_JDBC_URL", "jdbc:postgresql://db.example:5432/media",
                        "MEDIA_PROJECT_TIMELINE_SCHEMA", "media_dev_blocked",
                        "MEDIA_PROJECT_TIMELINE_POSTGRES_USER", "media",
                        "MEDIA_PROJECT_TIMELINE_POSTGRES_PASSWORD_REFERENCE", "secret:env:DEV_DB_PASSWORD",
                        "DEV_DB_PASSWORD", "local-test-password")))
                .withMessageContaining("loopback host");
    }

    private static Map<String, String> environment(String schema) {
        return Map.of(
                "MEDIA_RUNTIME_ENVIRONMENT", "dev",
                "MEDIA_DEV_IDENTITY_ENABLED", "true",
                "MEDIA_PROJECT_TIMELINE_DEV_ENABLED", "true",
                "MEDIA_PROJECT_TIMELINE_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl(),
                "MEDIA_PROJECT_TIMELINE_SCHEMA", schema,
                "MEDIA_PROJECT_TIMELINE_POSTGRES_USER", POSTGRES.getUsername(),
                "MEDIA_PROJECT_TIMELINE_POSTGRES_PASSWORD_REFERENCE", "secret:env:DEV_DB_PASSWORD",
                "DEV_DB_PASSWORD", POSTGRES.getPassword());
    }
}
