package com.ghatana.media.provider.aws;

import com.ghatana.media.production.timeline.ProjectTimelineEngine;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.IdempotencyConflictException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectAccessDeniedException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectNotFoundException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.RevisionConflictException;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.sql.DriverManager;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@Testcontainers(disabledWithoutDocker = true)
class PostgresqlDevProjectTimelineStoreFactoryTest {
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

            var edited = engine.edit(actor, projectId, "timeline-main", timelineRevisionId,
                    java.util.List.of(new ProjectTimelineEngine.AddScene(
                            new com.ghatana.media.runtime.MediaProjectTimelineContracts.Scene("scene-main", 0))));
            editedRevisionId = edited.revisionId();
            assertThat(edited.timelines()).singleElement().satisfies(snapshot -> {
                assertThat(snapshot.timelineId()).isEqualTo("timeline-main");
                assertThat(snapshot.semanticVersionId()).isNotEqualTo(
                        engine.revision(actor, projectId, timelineRevisionId).timelines().getFirst().semanticVersionId());
                assertThat(snapshot.graph().scenes()).extracting(scene -> scene.sceneId()).containsExactly("scene-main");
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
