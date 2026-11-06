package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaProjectTimelineContracts;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Graph;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectAccessDeniedException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectNotFoundException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.RevisionConflictException;
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

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.sql.DriverManager;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@Testcontainers(disabledWithoutDocker = true)
@ResourceLock("MediaAwsPostgresqlRuntimeState")
class PostgresqlProjectTimelineStoreTest {
    @Container static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices("s3");

    @Test
    void restartReadbackPreservesCreateReceiptAndImmutableGraphSnapshot() throws Exception {
        try (Fixture fixture = openFixture()) {
            Actor actor = new Actor("tenant-a", "principal-a");
            var created = fixture.store.create(actor, "workspace-a", "My project", "request-1",
                    "project-1", "revision-1", "timeline-1");
            // Hold the isolated test runtime while replacing only the store adapter instance.
            MediaAwsPostgresqlRuntimeState heldState = MediaAwsPostgresqlRuntimeState.acquire();
            try {
                fixture.store.close();
                try (PostgresqlProjectTimelineStore restarted = new PostgresqlProjectTimelineStore()) {
                    assertThat(restarted.project(actor, "project-1")).isEqualTo(created.project());
                    assertThat(restarted.revision(actor, "project-1", "revision-1")).isEqualTo(created.initialRevision());
                    var replay = restarted.create(actor, "workspace-a", "My project", "request-1",
                            "ignored-project", "ignored-revision", "ignored-timeline");
                    assertThat(replay.createdNow()).isFalse();
                    assertThat(replay.project()).isEqualTo(created.project());
                    assertThat(replay.initialRevision()).isEqualTo(created.initialRevision());
                }
            } finally { heldState.release(); }
        }
    }

    @Test
    void createReplayIsIdempotentAndChangedPayloadConflicts() throws Exception {
        try (Fixture fixture = openFixture()) {
            Actor actor = new Actor("tenant-a", "principal-a");
            var first = fixture.store.create(actor, "workspace-a", "Title", "request-1",
                    "project-1", "revision-1", "timeline-1");
            var replay = fixture.store.create(actor, "workspace-a", "Title", "request-1",
                    "project-ignored", "revision-ignored", "timeline-ignored");
            assertThat(replay.createdNow()).isFalse();
            assertThat(replay.project()).isEqualTo(first.project());
            fixture.store.commit(actor, "project-1", "revision-1", "revision-2", Graph.empty("timeline-1"));
            var afterCommitReplay = fixture.store.create(actor, "workspace-a", "Title", "request-1",
                    "project-replacement", "revision-replacement", "timeline-replacement");
            assertThat(afterCommitReplay).isEqualTo(replay);
            assertThat(fixture.store.project(actor, "project-1").headRevisionId()).isEqualTo("revision-2");
            assertThatThrownBy(() -> fixture.store.create(actor, "workspace-a", "Changed", "request-1",
                    "project-2", "revision-2", "timeline-2"))
                    .isInstanceOf(MediaProjectTimelineContracts.IdempotencyConflictException.class);
        }
    }

    @Test
    void closedStoreAndBlankProjectIdentityFailBeforePersistenceAccess() throws Exception {
        try (Fixture fixture = openFixture()) {
            Actor actor = new Actor("tenant-a", "principal-a");
            assertThatThrownBy(() -> fixture.store.project(actor, " "))
                    .isInstanceOf(IllegalArgumentException.class);
            fixture.store.close();
            assertThatThrownBy(() -> fixture.store.project(actor, "project-1"))
                    .isInstanceOf(IllegalStateException.class).hasMessage("project timeline store is closed");
        }
    }

    @Test
    void projectAndRevisionReadsAreTenantScoped() throws Exception {
        try (Fixture fixture = openFixture()) {
            fixture.store.create(new Actor("tenant-a", "principal-a"), "workspace-a", "Title", "request-1",
                    "project-1", "revision-1", "timeline-1");
            Actor otherTenant = new Actor("tenant-b", "principal-a");
            assertThatThrownBy(() -> fixture.store.project(otherTenant, "project-1"))
                    .isInstanceOf(ProjectNotFoundException.class);
            assertThatThrownBy(() -> fixture.store.revision(otherTenant, "project-1", "revision-1"))
                    .isInstanceOf(ProjectNotFoundException.class);
            Actor otherPrincipal = new Actor("tenant-a", "principal-b");
            assertThatThrownBy(() -> fixture.store.project(otherPrincipal, "project-1"))
                    .isInstanceOf(ProjectAccessDeniedException.class);
            assertThatThrownBy(() -> fixture.store.revision(otherPrincipal, "project-1", "revision-1"))
                    .isInstanceOf(ProjectAccessDeniedException.class);
        }
    }

    @Test
    void staleCasHasNoMutation() throws Exception {
        try (Fixture fixture = openFixture()) {
            Actor actor = new Actor("tenant-a", "principal-a");
            fixture.store.create(actor, "workspace-a", "Title", "request-1",
                    "project-1", "revision-1", "timeline-1");
            Graph graph = Graph.empty("timeline-1");
            fixture.store.commit(actor, "project-1", "revision-1", "revision-2", graph);
            assertThatThrownBy(() -> fixture.store.commit(actor, "project-1", "revision-1", "revision-3", graph))
                    .isInstanceOf(RevisionConflictException.class);
            assertThat(fixture.store.project(actor, "project-1").headRevisionId()).isEqualTo("revision-2");
            assertThatThrownBy(() -> fixture.store.revision(actor, "project-1", "revision-3"))
                    .isInstanceOf(ProjectNotFoundException.class);
        }
    }

    @Test
    void concurrentCasHasExactlyOneWinner() throws Exception {
        try (Fixture fixture = openFixture()) {
            Actor actor = new Actor("tenant-a", "principal-a");
            fixture.store.create(actor, "workspace-a", "Title", "request-1",
                    "project-1", "revision-1", "timeline-1");
            var ready = new CountDownLatch(2);
            var start = new CountDownLatch(1);
            try (var pool = Executors.newFixedThreadPool(2)) {
                var a = pool.submit(() -> raceCommit(fixture.store, actor, "revision-2", ready, start));
                var b = pool.submit(() -> raceCommit(fixture.store, actor, "revision-3", ready, start));
                assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
                start.countDown();
                List<Boolean> outcomes = List.of(a.get(20, TimeUnit.SECONDS), b.get(20, TimeUnit.SECONDS));
                assertThat(outcomes).containsExactlyInAnyOrder(true, false);
            }
            String head = fixture.store.project(actor, "project-1").headRevisionId();
            assertThat(head).isIn("revision-2", "revision-3");
            assertThat(fixture.store.revision(actor, "project-1", head).parentRevisionId()).isEqualTo("revision-1");
        }
    }

    private static boolean raceCommit(PostgresqlProjectTimelineStore store, Actor actor, String revision,
                                      CountDownLatch ready, CountDownLatch start) throws Exception {
        ready.countDown();
        if (!start.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("start latch timed out");
        try { store.commit(actor, "project-1", "revision-1", revision, Graph.empty("timeline-1")); return true; }
        catch (RevisionConflictException expected) { return false; }
    }

    private static Fixture openFixture() throws Exception {
        String bucket = "media-timeline-" + UUID.randomUUID().toString().replace("-", "");
        String schema = "media_timeline_" + UUID.randomUUID().toString().replace("-", "");
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
            // Test-only V030 is applied explicitly after the provider's V001-V029 runtime chain.
            Flyway.configure().dataSource(scopedJdbcUrl(schema), POSTGRES.getUsername(), POSTGRES.getPassword())
                    .locations("classpath:db/media-runtime", "classpath:db/media-project-timeline")
                    .load().migrate();
            return new Fixture(installed, new PostgresqlProjectTimelineStore(), schema);
        } catch (RuntimeException failure) {
            installed.close();
            dropSchema(schema);
            throw failure;
        }
    }

    private record Fixture(AutoCloseable installed, PostgresqlProjectTimelineStore store,
                           String schema) implements AutoCloseable {
        @Override public void close() throws Exception {
            try { store.close(); } finally {
                try { installed.close(); } finally { dropSchema(schema); }
            }
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
}
