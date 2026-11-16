package com.ghatana.media.provider.aws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.runtime.HmacMediaLifecycleIdentifierRedactor;
import com.ghatana.media.runtime.MediaDevLifecycleFeedContracts.Entry;
import com.ghatana.media.runtime.MediaDevLifecycleFeedContracts.Page;
import com.ghatana.media.runtime.MediaLifecycleEventType;
import com.ghatana.media.runtime.MediaPublicLifecycleEvent;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.localstack.LocalStackContainer;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;

/** The durable DEV_ONLY lifecycle feed (V043): cursors, redelivery numbering, tenant isolation, aggregate resolution. */
@Testcontainers(disabledWithoutDocker = true)
class PostgresqlMediaDevLifecycleFeedTest {
    @Container static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"));
    @Container static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices("s3");
    private static final HmacMediaLifecycleIdentifierRedactor REDACTOR =
            new HmacMediaLifecycleIdentifierRedactor(new byte[32]);

    private static MediaPublicLifecycleEvent event(String eventId, String tenant, String job, long version,
                                                   MediaLifecycleEventType type) {
        return new MediaPublicLifecycleEvent(MediaPublicLifecycleEvent.SCHEMA_VERSION,
                REDACTOR.redact("event", eventId), type, REDACTOR.redact("tenant", tenant),
                REDACTOR.redact("principal", "p"), REDACTOR.redact("correlation", "c"), "", "job",
                REDACTOR.redact("aggregate", job), version, "INTERNAL", Instant.parse("2026-11-15T10:00:00Z"),
                MediaPublicLifecycleEvent.AppendFinality.NON_FINAL_APPEND, type.terminalReadbackRequired());
    }

    @Test
    void redeliveryGetsTheNextDeliveryNoCursorsIncreaseAndEveryReaderSeesEveryEntryOnceFromItsOwnCursor() throws Exception {
        try (Fixture fixture = openFixture(); PostgresqlMediaDevLifecycleFeed feed = new PostgresqlMediaDevLifecycleFeed()) {
            String tenant = "tenant-" + UUID.randomUUID();
            String other = "tenant-" + UUID.randomUUID();
            var accepted = event("o1", tenant, "job-1", 1, MediaLifecycleEventType.JOB_ACCEPTED);
            var completed = event("o2", tenant, "job-1", 3, MediaLifecycleEventType.JOB_COMPLETED);
            Entry a = feed.append(tenant, "o1", "job-1", accepted);
            Entry a2 = feed.append(tenant, "o1", "job-1", accepted); // crash-after-publish redelivery
            Entry c = feed.append(tenant, "o2", "job-1", completed);
            feed.append(other, "o9", "job-9", event("o9", other, "job-9", 1, MediaLifecycleEventType.JOB_ACCEPTED));
            assertThat(a.deliveryNo()).isEqualTo(1);
            assertThat(a2.deliveryNo()).isEqualTo(2);
            assertThat(c.deliveryNo()).isEqualTo(1);
            assertThat(a.cursor()).isLessThan(a2.cursor());
            assertThat(a2.cursor()).isLessThan(c.cursor());

            Page first = feed.read(tenant, 0, 10);
            assertThat(first.entries()).extracting(Entry::cursor).containsExactly(a.cursor(), a2.cursor(), c.cursor());
            assertThat(first.entries().get(1).event().eventRef()).isEqualTo(first.entries().get(0).event().eventRef());
            assertThat(first.nextCursor()).isEqualTo(c.cursor());
            // A second reader, and a reader resuming from a mid cursor, are independent of the first.
            assertThat(feed.read(tenant, 0, 10).entries()).hasSize(3);
            assertThat(feed.read(tenant, a2.cursor(), 10).entries()).extracting(Entry::cursor).containsExactly(c.cursor());
            assertThat(feed.read(tenant, 0, 2).entries()).hasSize(2);
            Page drained = feed.read(tenant, c.cursor(), 10);
            assertThat(drained.entries()).isEmpty();
            assertThat(drained.nextCursor()).isEqualTo(c.cursor());
            // Tenant isolation, including the aggregate reference resolution.
            assertThat(feed.read(other, 0, 10).entries()).hasSize(1);
            assertThat(feed.read("tenant-none-" + UUID.randomUUID(), 0, 10).entries()).isEmpty();
            String jobRef = REDACTOR.redact("aggregate", "job-1");
            assertThat(feed.resolveAggregateId(tenant, "job", jobRef)).contains("job-1");
            assertThat(feed.resolveAggregateId(other, "job", jobRef)).isEmpty();
            assertThatThrownBy(() -> feed.read(tenant, -1, 10)).isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> feed.read(tenant, 0, 201)).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    void theFactoryRefusesAnythingButTheDevProfileWithDevIdentity() {
        PostgresqlDevLifecycleFeedFactory factory = new PostgresqlDevLifecycleFeedFactory();
        assertThatThrownBy(() -> factory.createDevOnly(Map.of("MEDIA_RUNTIME_ENVIRONMENT", "production")))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> factory.createDevOnly(Map.of("MEDIA_RUNTIME_ENVIRONMENT", "dev")))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private static void createBucket(String bucket) {
        try (S3Client s3 = S3Client.builder().endpointOverride(LOCALSTACK.getEndpoint()).region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(
                        AwsBasicCredentials.create(LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build()) {
            s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
    }

    private static Fixture openFixture() {
        String bucket = "media-feed-" + UUID.randomUUID().toString().replace("-", "");
        createBucket(bucket);
        AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment(bucket));
        return new Fixture(installed, MediaAwsPostgresqlRuntimeState.acquire());
    }

    private record Fixture(AutoCloseable installed, MediaAwsPostgresqlRuntimeState keepAlive) implements AutoCloseable {
        @Override public void close() throws Exception {
            try { keepAlive.release(); } finally { installed.close(); }
        }
    }

    private static Map<String, String> environment(String bucket) {
        Map<String, String> env = new HashMap<>();
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        env.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        env.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_FEED_DB_PASSWORD");
        env.put("MEDIA_FEED_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_S3_BUCKET", bucket);
        env.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        env.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpoint().toString());
        env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_FEED_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_FEED_SECRET");
        env.put("MEDIA_FEED_ACCESS", LOCALSTACK.getAccessKey());
        env.put("MEDIA_FEED_SECRET", LOCALSTACK.getSecretKey());
        return env;
    }
}
