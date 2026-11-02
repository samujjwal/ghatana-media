package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
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
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.DriverManager;
import java.time.Duration;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** IP-06: a restarted reader must not publish bytes when a committed S3 object is missing. */
@Testcontainers(disabledWithoutDocker = true)
class MediaPostgresqlS3MissingObjectRestartTest {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void restartedReadFailsClosedWhenCommittedObjectIsMissing() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-ip06-missing-" + runId;
        String tenant = "tenant-ip06-missing-" + runId;
        String principal = "principal-ip06-missing-" + runId;
        byte[] bytes = wav(("missing-object-source:" + runId).getBytes(StandardCharsets.UTF_8));
        String digest = sha256(bytes);
        createBucket(bucket);
        Map<String, String> environment = environment(bucket);
        MediaArtifact committed;

        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             S3PostgresqlMediaArtifactStore writer = new S3PostgresqlMediaArtifactStore()) {
            var upload = writer.begin(new UploadRequest(tenant, principal, "source.wav",
                    "audio/wav", bytes.length, digest, "RESTRICTED", Duration.ofDays(7), Map.of()),
                    "ip06-missing-" + runId);
            writer.append(tenant, principal, upload.uploadId(), 0, bytes);
            committed = writer.complete(tenant, principal, upload.uploadId());
            assertThat(committed.sha256()).isEqualTo(digest);
        }

        deleteObject(bucket, committed.objectReference());
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             S3PostgresqlMediaArtifactStore restarted = new S3PostgresqlMediaArtifactStore()) {
            assertThat(restarted.artifact(tenant, committed.artifactId())).contains(committed);

            ByteArrayOutputStream callerSink = new ByteArrayOutputStream();
            assertThatThrownBy(() -> restarted.copyContent(tenant, principal, committed.artifactId(),
                    ArtifactVersion.fromSha256(digest), callerSink, bytes.length))
                    .isInstanceOf(IOException.class)
                    .hasMessageContaining("Unable to read exact Media artifact source bytes");
            assertThat(callerSink.size()).as("missing source bytes must not escape to the caller").isZero();
            assertThat(artifactCount(tenant, committed.artifactId())).isEqualTo(1);
        } finally {
            deleteBucket(bucket);
        }
    }

    private static Map<String, String> environment(String bucket) {
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        environment.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        environment.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        environment.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_IP06_MISSING_DB_PASSWORD");
        environment.put("MEDIA_IP06_MISSING_DB_PASSWORD", POSTGRES.getPassword());
        environment.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        environment.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_PREFIX", "ip06-missing");
        environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_IP06_MISSING_S3_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_IP06_MISSING_S3_SECRET");
        environment.put("MEDIA_IP06_MISSING_S3_ACCESS", LOCALSTACK.getAccessKey());
        environment.put("MEDIA_IP06_MISSING_S3_SECRET", LOCALSTACK.getSecretKey());
        return environment;
    }

    private static S3Client s3Client() {
        return S3Client.builder().endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build();
    }

    private static void createBucket(String bucket) {
        try (S3Client s3 = s3Client()) {
            s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
    }

    private static void deleteObject(String bucket, String reference) {
        String key = java.net.URI.create(reference).getPath().substring(1);
        try (S3Client s3 = s3Client()) {
            s3.deleteObject(DeleteObjectRequest.builder().bucket(bucket).key(key).build());
        }
    }

    private static void deleteBucket(String bucket) {
        try (S3Client s3 = s3Client()) {
            for (var object : s3.listObjectsV2(b -> b.bucket(bucket)).contents()) {
                s3.deleteObject(b -> b.bucket(bucket).key(object.key()));
            }
            s3.deleteBucket(b -> b.bucket(bucket));
        } catch (RuntimeException ignored) {
            // Disposable LocalStack and PostgreSQL containers are the outer cleanup boundary.
        }
    }

    private static int artifactCount(String tenant, String artifactId) throws Exception {
        try (var connection = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var query = connection.prepareStatement(
                     "SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=? AND artifact_id=?")) {
            query.setString(1, tenant);
            query.setString(2, artifactId);
            try (var rows = query.executeQuery()) {
                rows.next();
                return rows.getInt(1);
            }
        }
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static byte[] wav(byte[] payload) {
        byte[] bytes = new byte[44 + payload.length];
        bytes[0] = 'R'; bytes[1] = 'I'; bytes[2] = 'F'; bytes[3] = 'F';
        int fileSize = bytes.length - 8;
        bytes[4] = (byte) fileSize; bytes[5] = (byte) (fileSize >>> 8);
        bytes[6] = (byte) (fileSize >>> 16); bytes[7] = (byte) (fileSize >>> 24);
        bytes[8] = 'W'; bytes[9] = 'A'; bytes[10] = 'V'; bytes[11] = 'E';
        bytes[12] = 'f'; bytes[13] = 'm'; bytes[14] = 't'; bytes[15] = ' ';
        bytes[16] = 16; bytes[20] = 1; bytes[22] = 1; bytes[24] = 0x40; bytes[25] = 0x1f;
        bytes[28] = (byte) 0x80; bytes[29] = 0x3e; bytes[32] = 2; bytes[34] = 16;
        bytes[36] = 'd'; bytes[37] = 'a'; bytes[38] = 't'; bytes[39] = 'a';
        bytes[40] = (byte) payload.length; bytes[41] = (byte) (payload.length >>> 8);
        bytes[42] = (byte) (payload.length >>> 16); bytes[43] = (byte) (payload.length >>> 24);
        System.arraycopy(payload, 0, bytes, 44, payload.length);
        return bytes;
    }
}
