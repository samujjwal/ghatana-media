package com.ghatana.media.provider.aws;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.production.timeline.ProjectTimelineEngine;
import com.ghatana.media.production.timeline.StoryboardPlanner;
import java.sql.DriverManager;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.parallel.ResourceLock;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;

@Testcontainers(disabledWithoutDocker = true)
@ResourceLock("MediaAwsPostgresqlRuntimeState")
class PostgresqlStoryboardPlanAuthorityTest {
    private static final Actor OWNER = new Actor("tenant-storyboard", "principal-storyboard");

    @Container static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices("s3");

    @Test
    void exactReplaySurvivesProjectHeadMovementAndAuthorityRestart() throws Exception {
        try (Fixture fixture = openFixture()) {
            Created created = fixture.createProject(OWNER, "project-create-1");
            StoryboardPlanner planner = planner();
            StoryboardPlanner.ScenePlan plan = plan(created, "plan-a", "v1", "An authored story");
            StoryboardPlanner.SavedPlan saved = planner.save(OWNER, plan, null, "save-story-1", fixture.authority);

            fixture.projects.commit(OWNER, created.project().projectId(), created.project().headRevisionId(),
                    "revision-moved", created.initialRevision().timelines());
            fixture.authority.close();
            fixture.reopenAuthority();

            StoryboardPlanner.SavedPlan replay = planner.save(
                    OWNER, plan, null, "save-story-1", fixture.authority);
            assertThat(replay).isEqualTo(saved);
            assertThat(fixture.authority.read(OWNER, created.project().projectId(), "plan-a", "v1"))
                    .isEqualTo(saved);
            assertThat(fixture.projects.project(OWNER, created.project().projectId()).headRevisionId())
                    .isEqualTo("revision-moved");
        }
    }

    @Test
    void changedPayloadUnderSameRequestIdConflictsWithoutChangingPersistedDraft() throws Exception {
        try (Fixture fixture = openFixture()) {
            Created created = fixture.createProject(OWNER, "project-create-2");
            StoryboardPlanner planner = planner();
            StoryboardPlanner.ScenePlan original = plan(created, "plan-a", "v1", "Original brief");
            StoryboardPlanner.SavedPlan saved = planner.save(OWNER, original, null, "save-story-2", fixture.authority);
            StoryboardPlanner.ScenePlan changed = plan(created, "plan-a", "v1", "Changed brief");

            assertThatThrownBy(() -> planner.save(OWNER, changed, null, "save-story-2", fixture.authority))
                    .isInstanceOf(StoryboardPlanner.ScenePlanConflictException.class)
                    .hasMessageContaining("different payload");
            assertThat(fixture.authority.read(OWNER, created.project().projectId(), "plan-a", "v1"))
                    .isEqualTo(saved);
        }
    }

    @Test
    void projectHeadAndParentVersionCasFailuresHaveNoPartialEdition() throws Exception {
        try (Fixture fixture = openFixture()) {
            Created created = fixture.createProject(OWNER, "project-create-3");
            StoryboardPlanner planner = planner();
            StoryboardPlanner.ScenePlan staleHead = new StoryboardPlanner.ScenePlan(
                    OWNER.tenantId(), OWNER.principalId(), created.project().projectId(), "plan-a", "v1",
                    "revision-stale", new StoryboardPlanner.AuthoredBrief("brief-v1", "b1", "personal-project",
                            "A story", List.of()),
                    List.of(new StoryboardPlanner.PlannedScene("scene-a", 0, "intent", story(0), story(20),
                            List.of(new StoryboardPlanner.PlannedShot("shot-a", 0, "intent", story(0), story(1), List.of())))),
                    List.of(), StoryboardPlanner.DraftDisposition.LOCAL_DRAFT_CANDIDATE);
            assertThatThrownBy(() -> fixture.authority.append(OWNER, staleHead, "revision-stale", null, "save-stale-head"))
                    .isInstanceOf(StoryboardPlanner.ScenePlanConflictException.class)
                    .hasMessageContaining("project head changed");

            StoryboardPlanner.ScenePlan initial = plan(created, "plan-a", "v1", "A story");
            planner.save(OWNER, initial, null, "save-story-3a", fixture.authority);
            StoryboardPlanner.ScenePlan next = plan(created, "plan-a", "v2", "A revised story");
            assertThatThrownBy(() -> planner.save(OWNER, next, "wrong-parent", "save-story-3b", fixture.authority))
                    .isInstanceOf(StoryboardPlanner.ScenePlanConflictException.class)
                    .hasMessageContaining("parent semantic version");
            assertThatThrownBy(() -> fixture.authority.read(OWNER, created.project().projectId(), "plan-a", "v2"))
                    .isInstanceOf(ProjectNotFoundException.class);
            assertThat(fixture.authority.read(OWNER, created.project().projectId(), "plan-a", "v1").plan())
                    .isEqualTo(initial);
        }
    }

    @Test
    void historicalSemanticVersionCannotBeRecreatedWithAnotherRequest() throws Exception {
        try (Fixture fixture = openFixture()) {
            Created created = fixture.createProject(OWNER, "project-create-duplicate-version");
            StoryboardPlanner planner = planner();
            StoryboardPlanner.ScenePlan first = plan(created, "plan-a", "v1", "Original v1");
            StoryboardPlanner.SavedPlan savedFirst = planner.save(
                    OWNER, first, null, "save-version-v1", fixture.authority);
            StoryboardPlanner.ScenePlan second = plan(created, "plan-a", "v2", "New v2");
            StoryboardPlanner.SavedPlan savedSecond = planner.save(
                    OWNER, second, "v1", "save-version-v2", fixture.authority);

            assertThatThrownBy(() -> planner.save(
                    OWNER, first, "v2", "save-version-v1-again", fixture.authority))
                    .isInstanceOf(StoryboardPlanner.DuplicateScenePlanVersionException.class);

            assertThat(fixture.authority.read(OWNER, created.project().projectId(), "plan-a", "v1"))
                    .isEqualTo(savedFirst);
            assertThat(fixture.authority.read(OWNER, created.project().projectId(), "plan-a", "v2"))
                    .isEqualTo(savedSecond);
            assertThat(fixture.sqlLong("SELECT count(*) FROM media_storyboard_plan_editions")).isEqualTo(2);
            assertThat(fixture.sqlLong("SELECT count(*) FROM media_storyboard_plan_save_receipts")).isEqualTo(2);
            assertThat(fixture.sqlText("""
                    SELECT current_semantic_version FROM media_storyboard_plan_heads
                    WHERE tenant_id='tenant-storyboard' AND project_id='%s' AND scene_plan_id='plan-a'
                    """.formatted(created.project().projectId()))).isEqualTo("v2");
        }
    }

    @Test
    void databaseRejectsDirectMutationOfEditionsAndSaveReceipts() throws Exception {
        try (Fixture fixture = openFixture()) {
            Created created = fixture.createProject(OWNER, "project-create-immutable-trigger");
            StoryboardPlanner planner = planner();
            StoryboardPlanner.ScenePlan plan = plan(created, "plan-a", "v1", "Immutable authored plan");
            StoryboardPlanner.SavedPlan saved = planner.save(
                    OWNER, plan, null, "save-immutable-trigger", fixture.authority);

            assertThatThrownBy(() -> fixture.sqlUpdate("""
                    UPDATE media_storyboard_plan_editions SET plan_snapshot='{}'::jsonb
                    WHERE tenant_id='tenant-storyboard' AND project_id='%s'
                      AND scene_plan_id='plan-a' AND semantic_version='v1'
                    """.formatted(created.project().projectId())))
                    .isInstanceOf(java.sql.SQLException.class)
                    .hasMessageContaining("immutable");
            assertThatThrownBy(() -> fixture.sqlUpdate("""
                    DELETE FROM media_storyboard_plan_editions
                    WHERE tenant_id='tenant-storyboard' AND project_id='%s'
                      AND scene_plan_id='plan-a' AND semantic_version='v1'
                    """.formatted(created.project().projectId())))
                    .isInstanceOf(java.sql.SQLException.class)
                    .hasMessageContaining("immutable");
            assertThatThrownBy(() -> fixture.sqlUpdate("""
                    UPDATE media_storyboard_plan_save_receipts SET owner_receipt='changed'
                    WHERE tenant_id='tenant-storyboard' AND principal_id='principal-storyboard'
                      AND request_id='save-immutable-trigger'
                    """))
                    .isInstanceOf(java.sql.SQLException.class)
                    .hasMessageContaining("immutable");
            assertThatThrownBy(() -> fixture.sqlUpdate("""
                    DELETE FROM media_storyboard_plan_save_receipts
                    WHERE tenant_id='tenant-storyboard' AND principal_id='principal-storyboard'
                      AND request_id='save-immutable-trigger'
                    """))
                    .isInstanceOf(java.sql.SQLException.class)
                    .hasMessageContaining("immutable");

            assertThat(fixture.authority.read(OWNER, created.project().projectId(), "plan-a", "v1"))
                    .isEqualTo(saved);
            assertThat(planner.save(OWNER, plan, null, "save-immutable-trigger", fixture.authority))
                    .isEqualTo(saved);
            assertThat(fixture.sqlLong("SELECT count(*) FROM media_storyboard_plan_editions")).isEqualTo(1);
            assertThat(fixture.sqlLong("SELECT count(*) FROM media_storyboard_plan_save_receipts")).isEqualTo(1);
        }
    }

    @Test
    void tenantAndPrincipalScopeAreCheckedOnPersistedReadback() throws Exception {
        try (Fixture fixture = openFixture()) {
            Created created = fixture.createProject(OWNER, "project-create-4");
            StoryboardPlanner.ScenePlan plan = plan(created, "plan-a", "v1", "A story");
            fixture.authority.append(OWNER, plan, created.project().headRevisionId(), null, "save-story-4");

            assertThatThrownBy(() -> fixture.authority.read(
                    new Actor("other-tenant", OWNER.principalId()), created.project().projectId(), "plan-a", "v1"))
                    .isInstanceOf(ProjectNotFoundException.class);
            assertThatThrownBy(() -> fixture.authority.read(
                    new Actor(OWNER.tenantId(), "other-principal"), created.project().projectId(), "plan-a", "v1"))
                    .isInstanceOf(ProjectAccessDeniedException.class);
        }
    }

    @Test
    void concurrentInitialAppendsHaveOneParentCasWinnerAndNoLosingEdition() throws Exception {
        try (Fixture fixture = openFixture(); var executor = Executors.newFixedThreadPool(2)) {
            Created created = fixture.createProject(OWNER, "project-create-5");
            StoryboardPlanner planner = planner();
            StoryboardPlanner.ScenePlan first = plan(created, "plan-a", "v1", "First authored story");
            StoryboardPlanner.ScenePlan second = plan(created, "plan-a", "v2", "Second authored story");
            CountDownLatch start = new CountDownLatch(1);
            var firstResult = executor.submit(() -> appendAfter(start, planner, first, "save-race-1", fixture.authority));
            var secondResult = executor.submit(() -> appendAfter(start, planner, second, "save-race-2", fixture.authority));
            start.countDown();
            RaceResult one = firstResult.get(30, TimeUnit.SECONDS);
            RaceResult two = secondResult.get(30, TimeUnit.SECONDS);

            assertThat(List.of(one, two).stream().filter(result -> result.failure() == null)).hasSize(1);
            assertThat(List.of(one, two).stream().filter(result -> result.failure() instanceof StoryboardPlanner.ScenePlanConflictException))
                    .hasSize(1);
            String winnerVersion = one.saved() == null ? two.saved().plan().semanticVersion() : one.saved().plan().semanticVersion();
            assertThat(fixture.authority.read(OWNER, created.project().projectId(), "plan-a", winnerVersion).plan())
                    .isIn(first, second);
            String loserVersion = winnerVersion.equals("v1") ? "v2" : "v1";
            assertThatThrownBy(() -> fixture.authority.read(OWNER, created.project().projectId(), "plan-a", loserVersion))
                    .isInstanceOf(ProjectNotFoundException.class);
        }
    }

    private static RaceResult appendAfter(CountDownLatch start, StoryboardPlanner planner,
            StoryboardPlanner.ScenePlan plan, String requestId, PostgresqlStoryboardPlanAuthority authority) {
        try {
            if (!start.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("race start timed out");
            return new RaceResult(planner.save(OWNER, plan, null, requestId, authority), null);
        } catch (RuntimeException | InterruptedException failure) {
            if (failure instanceof InterruptedException) Thread.currentThread().interrupt();
            return new RaceResult(null, failure);
        }
    }

    private static StoryboardPlanner planner() {
        return new StoryboardPlanner((actor, source, purpose) -> StoryboardPlanner.SourceDecision.ELIGIBLE);
    }

    private static StoryboardPlanner.ScenePlan plan(Created created, String planId, String version, String narrative) {
        StoryboardPlanner planner = planner();
        return planner.prepare(OWNER, created.project().projectId(), created.project().headRevisionId(), planId, version,
                new StoryboardPlanner.AuthoredBrief("brief-" + version, "b1", "personal-project", narrative, List.of()),
                List.of(new StoryboardPlanner.AuthoredScene("scene-" + version, 0, "scene intent", story(0), story(20),
                        List.of(new StoryboardPlanner.ShotInput("shot-" + version, 0, "shot intent", story(0),
                                story(1), List.of())))));
    }

    private static RationalTime story(long seconds) {
        return new RationalTime(seconds * 24, 24, 1, Clock.STORY);
    }

    private static Fixture openFixture() throws Exception {
        String suffix = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-storyboard-" + suffix;
        String schema = "media_storyboard_" + suffix;
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var create = connection.createStatement()) {
            create.execute("CREATE SCHEMA " + schema);
        }
        try (S3Client client = S3Client.builder().endpointOverride(LOCALSTACK.getEndpoint())
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment(bucket, schema));
        try {
            Flyway.configure().dataSource(scopedJdbcUrl(schema), POSTGRES.getUsername(), POSTGRES.getPassword())
                    .locations("classpath:db/media-runtime", "classpath:db/media-project-timeline")
                    .outOfOrder(true).load().migrate();
            return new Fixture(installed, schema);
        } catch (RuntimeException failure) {
            installed.close();
            dropSchema(schema);
            throw failure;
        }
    }

    private static Map<String, String> environment(String bucket, String schema) {
        Map<String, String> env = new HashMap<>();
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        env.put("MEDIA_POSTGRES_JDBC_URL", scopedJdbcUrl(schema));
        env.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_TIMELINE_DB_PASSWORD");
        env.put("MEDIA_TIMELINE_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_S3_BUCKET", bucket);
        env.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        env.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpoint().toString());
        env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_TIMELINE_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_TIMELINE_SECRET");
        env.put("MEDIA_TIMELINE_ACCESS", LOCALSTACK.getAccessKey());
        env.put("MEDIA_TIMELINE_SECRET", LOCALSTACK.getSecretKey());
        return env;
    }

    private static String scopedJdbcUrl(String schema) {
        String base = POSTGRES.getJdbcUrl();
        return base + (base.contains("?") ? "&" : "?") + "currentSchema=" + schema;
    }

    private static void dropSchema(String schema) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var drop = connection.createStatement()) {
            drop.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        }
    }

    private static final class Fixture implements AutoCloseable {
        private final AutoCloseable installed;
        private final String schema;
        private final PostgresqlProjectTimelineStore projects;
        private PostgresqlStoryboardPlanAuthority authority;

        Fixture(AutoCloseable installed, String schema) {
            this.installed = installed;
            this.schema = schema;
            this.projects = new PostgresqlProjectTimelineStore();
            this.authority = new PostgresqlStoryboardPlanAuthority();
        }

        Created createProject(Actor actor, String requestId) {
            Created created = new ProjectTimelineEngine(projects)
                    .createProject(actor, "workspace-storyboard", "Storyboard project", requestId);
            assertThat(created.initialRevision().timelines()).isEmpty();
            return created;
        }

        long sqlLong(String sql) throws Exception {
            try (var connection = DriverManager.getConnection(
                    scopedJdbcUrl(schema), POSTGRES.getUsername(), POSTGRES.getPassword());
                 var statement = connection.createStatement();
                 var result = statement.executeQuery(sql)) {
                if (!result.next()) throw new AssertionError("query returned no rows");
                return result.getLong(1);
            }
        }

        String sqlText(String sql) throws Exception {
            try (var connection = DriverManager.getConnection(
                    scopedJdbcUrl(schema), POSTGRES.getUsername(), POSTGRES.getPassword());
                 var statement = connection.createStatement();
                 var result = statement.executeQuery(sql)) {
                if (!result.next()) throw new AssertionError("query returned no rows");
                return result.getString(1);
            }
        }

        void sqlUpdate(String sql) throws Exception {
            try (var connection = DriverManager.getConnection(
                    scopedJdbcUrl(schema), POSTGRES.getUsername(), POSTGRES.getPassword());
                 var statement = connection.createStatement()) {
                statement.executeUpdate(sql);
            }
        }

        void reopenAuthority() {
            authority.close();
            authority = new PostgresqlStoryboardPlanAuthority();
        }

        @Override public void close() throws Exception {
            try { authority.close(); } finally {
                try { projects.close(); } finally {
                    try { installed.close(); } finally { dropSchema(schema); }
                }
            }
        }
    }

    private record RaceResult(StoryboardPlanner.SavedPlan saved, Throwable failure) { }
}
