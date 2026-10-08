package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectRequest;

import java.nio.charset.StandardCharsets;
import java.sql.DriverManager;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** PostgreSQL-native regression for a deferred constraint failure at purge COMMIT. */
@Testcontainers(disabledWithoutDocker = true)
class MediaPostgresqlArtifactPurgeCommitFailureTest {
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void completeCanRetryAfterDeferredArtifactInsertCommitFailure() throws Exception {
        String bucket = "media-complete-commit-" + UUID.randomUUID().toString().replace("-", "");
        try (S3Client admin = S3Client.builder()
                .endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .build()) {
            admin.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            Map<String, String> environment = integrationEnvironment(bucket);

            try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
                 S3PostgresqlMediaArtifactStore artifacts = new S3PostgresqlMediaArtifactStore()) {
                byte[] bytes = "commit-failure-complete-retry".getBytes(StandardCharsets.UTF_8);
                var upload = artifacts.begin(new UploadRequest("tenant-complete-commit", "principal-complete-commit",
                        "complete.bin", "application/octet-stream", bytes.length, sha256(bytes),
                        "RESTRICTED", Duration.ofDays(30), Map.of()), "complete-commit");
                artifacts.append(upload.tenantId(), upload.principalId(), upload.uploadId(), 0, bytes);
                createDeferredArtifactInsertFailureTrigger();

                try {
                    assertThatThrownBy(() -> artifacts.complete(upload.tenantId(), upload.principalId(), upload.uploadId()))
                            .isInstanceOf(IllegalStateException.class)
                            .hasMessageContaining("persist Media artifact")
                            .satisfies(failure -> assertThat(failure.getCause())
                                    .hasMessageContaining("injected deferred artifact insert commit failure"));

                    var retryable = artifacts.upload(upload.tenantId(), upload.uploadId()).orElseThrow();
                    assertThat(retryable.status().name()).isEqualTo("OPEN");
                    assertThat(retryable.bytesReceived()).isEqualTo(bytes.length);
                    assertThat(artifactRowsForUpload(upload.tenantId(), upload.uploadId())).isZero();
                } finally {
                    dropDeferredArtifactInsertFailureTrigger();
                }

                MediaArtifact artifact = artifacts.complete(upload.tenantId(), upload.principalId(), upload.uploadId());
                String key = java.net.URI.create(artifact.objectReference()).getPath().substring(1);
                assertThat(artifact.sizeBytes()).isEqualTo(bytes.length);
                assertThat(artifact.sha256()).isEqualTo(sha256(bytes));
                assertThat(artifacts.upload(upload.tenantId(), upload.uploadId()))
                        .get().extracting(session -> session.status().name()).isEqualTo("COMPLETED");
                assertThat(artifacts.artifact(upload.tenantId(), artifact.artifactId())).contains(artifact);
                assertThat(artifactRowsForUpload(upload.tenantId(), upload.uploadId())).isEqualTo(1);
                assertThat(admin.getObjectAsBytes(GetObjectRequest.builder().bucket(bucket).key(key).build())
                        .asByteArray()).containsExactly(bytes);
            }
        }
    }

    @Test
    void retryRemovesMetadataAfterDeferredPostgresqlCommitFailure() throws Exception {
        String bucket = "media-commit-" + UUID.randomUUID().toString().replace("-", "");
        try (S3Client admin = S3Client.builder()
                .endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .build()) {
            admin.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            Map<String, String> environment = new HashMap<>();
            environment.put("MEDIA_RUNTIME_ENVIRONMENT", "integration");
            environment.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
            environment.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
            environment.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_DB_PASSWORD");
            environment.put("MEDIA_DB_PASSWORD", POSTGRES.getPassword());
            environment.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
            environment.put("MEDIA_POSTGRES_POOL_SIZE", "4");
            environment.put("MEDIA_S3_BUCKET", bucket);
            environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
            environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
            environment.put("MEDIA_S3_PATH_STYLE", "true");
            environment.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
            environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:TEST_AWS_ACCESS_KEY");
            environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:TEST_AWS_SECRET_KEY");
            environment.put("TEST_AWS_ACCESS_KEY", LOCALSTACK.getAccessKey());
            environment.put("TEST_AWS_SECRET_KEY", LOCALSTACK.getSecretKey());

            try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
                 S3PostgresqlMediaArtifactStore artifacts = new S3PostgresqlMediaArtifactStore()) {
                byte[] bytes = "commit-failure-purge-retry".getBytes(StandardCharsets.UTF_8);
                var upload = artifacts.begin(new UploadRequest("tenant-commit", "principal-commit",
                        "commit.bin", "application/octet-stream", bytes.length, sha256(bytes),
                        "RESTRICTED", Duration.ofDays(30), Map.of()), "purge-commit");
                artifacts.append(upload.tenantId(), upload.principalId(), upload.uploadId(), 0, bytes);
                MediaArtifact artifact = artifacts.complete(upload.tenantId(), upload.principalId(), upload.uploadId());
                String key = java.net.URI.create(artifact.objectReference()).getPath().substring(1);
                try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                        POSTGRES.getUsername(), POSTGRES.getPassword());
                     var update = connection.prepareStatement(
                             "UPDATE media_artifacts SET expires_at=? WHERE tenant_id=? AND artifact_id=?")) {
                    update.setLong(1, Instant.now().minus(Duration.ofDays(2)).toEpochMilli());
                    update.setString(2, artifact.tenantId());
                    update.setString(3, artifact.artifactId());
                    assertThat(update.executeUpdate()).isEqualTo(1);
                }
                createDeferredCommitFailureTrigger();

                try (PostgresqlMediaPrivacyMaintenance maintenance =
                             new PostgresqlMediaPrivacyMaintenance(environment)) {
                    assertThatThrownBy(() -> maintenance.purgeExpired(Instant.now()))
                            .isInstanceOf(IllegalStateException.class)
                            .hasMessageContaining("delete expired Media artifact metadata")
                            .satisfies(failure -> assertThat(failure.getCause())
                                    .hasMessageContaining("injected deferred artifact deletion commit failure"));
                }
                assertThat(artifactRowExists(artifact)).isTrue();
                assertObjectAbsent(admin, bucket, key);

                dropDeferredCommitFailureTrigger();
                try (PostgresqlMediaPrivacyMaintenance maintenance =
                             new PostgresqlMediaPrivacyMaintenance(environment)) {
                    assertThat(maintenance.purgeExpired(Instant.now()).artifactsDeleted()).isEqualTo(1);
                }
                assertThat(artifactRowExists(artifact)).isFalse();
                assertObjectAbsent(admin, bucket, key);
            }
        }
    }

    private static void createDeferredCommitFailureTrigger() throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()); var statement = connection.createStatement()) {
            statement.execute("CREATE FUNCTION fail_artifact_delete_at_commit() RETURNS trigger "
                    + "LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION "
                    + "'injected deferred artifact deletion commit failure'; END; $$");
            statement.execute("CREATE CONSTRAINT TRIGGER fail_artifact_delete_at_commit "
                    // Deferred constraint triggers run as part of COMMIT, after DELETE succeeds.
                    + "AFTER DELETE ON media_artifacts DEFERRABLE INITIALLY DEFERRED "
                    + "FOR EACH ROW EXECUTE FUNCTION fail_artifact_delete_at_commit()");
        }
    }

    private static void createDeferredArtifactInsertFailureTrigger() throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()); var statement = connection.createStatement()) {
            statement.execute("CREATE FUNCTION fail_artifact_insert_at_commit() RETURNS trigger "
                    + "LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION "
                    + "'injected deferred artifact insert commit failure'; END; $$");
            statement.execute("CREATE CONSTRAINT TRIGGER fail_artifact_insert_at_commit "
                    + "AFTER INSERT ON media_artifacts DEFERRABLE INITIALLY DEFERRED "
                    + "FOR EACH ROW EXECUTE FUNCTION fail_artifact_insert_at_commit()");
        }
    }

    private static void dropDeferredArtifactInsertFailureTrigger() throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()); var statement = connection.createStatement()) {
            statement.execute("DROP TRIGGER fail_artifact_insert_at_commit ON media_artifacts");
            statement.execute("DROP FUNCTION fail_artifact_insert_at_commit()");
        }
    }

    private static Map<String, String> integrationEnvironment(String bucket) {
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "integration");
        environment.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        environment.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        environment.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_DB_PASSWORD");
        environment.put("MEDIA_DB_PASSWORD", POSTGRES.getPassword());
        environment.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        environment.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:TEST_AWS_ACCESS_KEY");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:TEST_AWS_SECRET_KEY");
        environment.put("TEST_AWS_ACCESS_KEY", LOCALSTACK.getAccessKey());
        environment.put("TEST_AWS_SECRET_KEY", LOCALSTACK.getSecretKey());
        return environment;
    }

    private static int artifactRowsForUpload(String tenantId, String uploadId) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=? AND principal_id=("
                             + "SELECT principal_id FROM media_upload_sessions WHERE tenant_id=? AND upload_id=?)")) {
            statement.setString(1, tenantId);
            statement.setString(2, tenantId);
            statement.setString(3, uploadId);
            try (var rows = statement.executeQuery()) { rows.next(); return rows.getInt(1); }
        }
    }

    private static void dropDeferredCommitFailureTrigger() throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()); var statement = connection.createStatement()) {
            statement.execute("DROP TRIGGER fail_artifact_delete_at_commit ON media_artifacts");
            statement.execute("DROP FUNCTION fail_artifact_delete_at_commit()");
        }
    }

    private static boolean artifactRowExists(MediaArtifact artifact) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=? AND artifact_id=?")) {
            statement.setString(1, artifact.tenantId());
            statement.setString(2, artifact.artifactId());
            try (var rows = statement.executeQuery()) { rows.next(); return rows.getInt(1) == 1; }
        }
    }

    private static void assertObjectAbsent(S3Client admin, String bucket, String key) {
        assertThatThrownBy(() -> admin.headObject(
                HeadObjectRequest.builder().bucket(bucket).key(key).build()))
                .isInstanceOf(software.amazon.awssdk.services.s3.model.NoSuchKeyException.class);
    }

    private static String sha256(byte[] bytes) throws Exception {
        return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
    }
}
