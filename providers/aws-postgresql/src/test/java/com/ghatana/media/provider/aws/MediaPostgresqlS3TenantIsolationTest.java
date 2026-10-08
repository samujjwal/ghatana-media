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
import software.amazon.awssdk.services.s3.model.HeadObjectRequest;

import java.net.URI;
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

/** PostgreSQL and S3 integration coverage for the existing tenant-scoped artifact store API. */
@Testcontainers(disabledWithoutDocker = true)
class MediaPostgresqlS3TenantIsolationTest {
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void uploadAndArtifactOperationsAreScopedByTenant() throws Exception {
        String bucket = createBucketAndStoreName();
        Map<String, String> environment = integrationEnvironment(bucket);
        try (S3Client admin = s3Client();
             AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore()) {
            byte[] bytes = "tenant-scoped-upload".getBytes(StandardCharsets.UTF_8);
            var upload = store.begin(upload("tenant-a", "principal-a", "a.bin", bytes, Duration.ofDays(30)));

            assertThat(store.upload("tenant-b", upload.uploadId())).isEmpty();
            assertThatThrownBy(() -> store.append("tenant-a", "principal-b", upload.uploadId(), 0, bytes))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("Open upload session not found");
            assertThatThrownBy(() -> store.complete("tenant-a", "principal-b", upload.uploadId()))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("Upload session not found");
            assertThatThrownBy(() -> store.append("tenant-b", upload.principalId(), upload.uploadId(), 0, bytes))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("Open upload session not found");
            assertThatThrownBy(() -> store.complete("tenant-b", upload.principalId(), upload.uploadId()))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("Upload session not found");

            assertThat(store.upload("tenant-a", upload.uploadId()).orElseThrow().bytesReceived()).isZero();
            store.append("tenant-a", upload.principalId(), upload.uploadId(), 0, bytes);
            MediaArtifact artifact = store.complete("tenant-a", upload.principalId(), upload.uploadId());
            String objectKey = URI.create(artifact.objectReference()).getPath().substring(1);
            assertThat(store.artifact("tenant-a", artifact.artifactId())).contains(artifact);
            assertThat(store.artifact("tenant-b", artifact.artifactId())).isEmpty();
            assertObjectExists(admin, bucket, objectKey);
        }
    }

    @Test
    void expiredRetentionOnlyRemovesExpiredTenantArtifactsAndUploads() throws Exception {
        String bucket = createBucketAndStoreName();
        Map<String, String> environment = integrationEnvironment(bucket);
        try (S3Client admin = s3Client();
             AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore()) {
            byte[] bytesA = "expired-tenant-a-artifact".getBytes(StandardCharsets.UTF_8);
            byte[] bytesB = "retained-tenant-b-artifact".getBytes(StandardCharsets.UTF_8);
            MediaArtifact artifactA = complete(store, "tenant-a", "principal-a", "a.bin", bytesA);
            MediaArtifact artifactB = complete(store, "tenant-b", "principal-b", "b.bin", bytesB);
            String artifactKeyA = objectKey(artifactA);
            String artifactKeyB = objectKey(artifactB);

            byte[] chunkA = "expired-upload-chunk".getBytes(StandardCharsets.UTF_8);
            byte[] chunkB = "retained-upload-chunk".getBytes(StandardCharsets.UTF_8);
            var uploadA = store.begin(upload("tenant-a", "principal-a", "pending-a.bin", chunkA,
                    Duration.ofDays(30)));
            var uploadB = store.begin(upload("tenant-b", "principal-b", "pending-b.bin", chunkB,
                    Duration.ofDays(30)));
            store.append("tenant-a", uploadA.principalId(), uploadA.uploadId(), 0, chunkA);
            store.append("tenant-b", uploadB.principalId(), uploadB.uploadId(), 0, chunkB);
            String chunkKeyA = chunkObjectKey("tenant-a", uploadA.uploadId());
            String chunkKeyB = chunkObjectKey("tenant-b", uploadB.uploadId());
            assertObjectExists(admin, bucket, chunkKeyA);
            assertObjectExists(admin, bucket, chunkKeyB);

            expireRows(artifactA, uploadA.uploadId());
            try (PostgresqlMediaPrivacyMaintenance maintenance =
                         new PostgresqlMediaPrivacyMaintenance(environment)) {
                var report = maintenance.purgeExpired(Instant.now());
                assertThat(report.artifactsDeleted()).isEqualTo(1);
                assertThat(report.uploadsDeleted()).isEqualTo(1);
                assertThat(report.chunksDeleted()).isEqualTo(1);
            }

            assertThat(store.artifact("tenant-a", artifactA.artifactId())).isEmpty();
            assertThat(store.artifact("tenant-b", artifactB.artifactId())).contains(artifactB);
            assertThat(store.upload("tenant-a", uploadA.uploadId())).isEmpty();
            assertThat(store.upload("tenant-b", uploadB.uploadId())).isPresent();
            assertObjectAbsent(admin, bucket, artifactKeyA);
            assertObjectExists(admin, bucket, artifactKeyB);
            assertObjectAbsent(admin, bucket, chunkKeyA);
            assertObjectExists(admin, bucket, chunkKeyB);
        }
    }

    private static String createBucketAndStoreName() {
        String bucket = "media-tenant-" + UUID.randomUUID().toString().replace("-", "");
        try (S3Client client = s3Client()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        return bucket;
    }

    private static S3Client s3Client() {
        return S3Client.builder()
                .endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .build();
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

    private static UploadRequest upload(
            String tenantId, String principalId, String fileName, byte[] bytes, Duration retention) throws Exception {
        return new UploadRequest(tenantId, principalId, fileName, "application/octet-stream", bytes.length,
                sha256(bytes), "restricted", retention, Map.of());
    }

    private static MediaArtifact complete(
            S3PostgresqlMediaArtifactStore store,
            String tenantId,
            String principalId,
            String fileName,
            byte[] bytes) throws Exception {
        var upload = store.begin(upload(tenantId, principalId, fileName, bytes, Duration.ofDays(30)));
        store.append(tenantId, upload.principalId(), upload.uploadId(), 0, bytes);
        return store.complete(tenantId, upload.principalId(), upload.uploadId());
    }

    private static void expireRows(MediaArtifact artifact, String uploadId) throws Exception {
        long expiredAt = Instant.now().minus(Duration.ofDays(1)).toEpochMilli();
        try (var connection = DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var artifactUpdate = connection.prepareStatement(
                     "UPDATE media_artifacts SET expires_at=? WHERE tenant_id=? AND artifact_id=?");
             var uploadUpdate = connection.prepareStatement(
                     "UPDATE media_upload_sessions SET expires_at=? WHERE tenant_id=? AND upload_id=?")) {
            artifactUpdate.setLong(1, expiredAt);
            artifactUpdate.setString(2, artifact.tenantId());
            artifactUpdate.setString(3, artifact.artifactId());
            assertThat(artifactUpdate.executeUpdate()).isEqualTo(1);
            uploadUpdate.setLong(1, expiredAt);
            uploadUpdate.setString(2, "tenant-a");
            uploadUpdate.setString(3, uploadId);
            assertThat(uploadUpdate.executeUpdate()).isEqualTo(1);
        }
    }

    private static String objectKey(MediaArtifact artifact) {
        return URI.create(artifact.objectReference()).getPath().substring(1);
    }

    private static String chunkObjectKey(String tenantId, String uploadId) throws Exception {
        try (var connection = DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT object_key FROM media_upload_chunks WHERE tenant_id=? AND upload_id=?")) {
            statement.setString(1, tenantId);
            statement.setString(2, uploadId);
            try (var rows = statement.executeQuery()) {
                assertThat(rows.next()).isTrue();
                return rows.getString(1);
            }
        }
    }

    private static void assertObjectExists(S3Client client, String bucket, String key) {
        assertThat(client.headObject(HeadObjectRequest.builder().bucket(bucket).key(key).build()).contentLength())
                .isPositive();
    }

    private static void assertObjectAbsent(S3Client client, String bucket, String key) {
        assertThatThrownBy(() -> client.headObject(HeadObjectRequest.builder().bucket(bucket).key(key).build()))
                .isInstanceOf(software.amazon.awssdk.services.s3.model.NoSuchKeyException.class);
    }

    private static String sha256(byte[] bytes) throws Exception {
        return java.util.HexFormat.of().formatHex(
                java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
    }
}
