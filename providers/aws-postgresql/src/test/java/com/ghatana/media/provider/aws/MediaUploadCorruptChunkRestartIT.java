package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadSession;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadStatus;
import org.junit.jupiter.api.Test;
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
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

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

/** J-02 negative boundary: staged chunk corruption survives restart as a truthful finalization failure. */
@Testcontainers(disabledWithoutDocker = true)
class MediaUploadCorruptChunkRestartIT {
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private record Harness(String jdbcUrl, String bucket, AutoCloseable installed) implements AutoCloseable {
        @Override public void close() throws Exception { installed.close(); }
    }

    private static Harness harness() throws Exception {
        String id = UUID.randomUUID().toString().replace("-", "");
        String jdbcUrl = "jdbc:h2:mem:media_upload_corrupt_restart_" + id
                + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1";
        String bucket = "media-upload-corrupt-restart-" + id;
        try (S3Client client = s3()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        environment.put("MEDIA_POSTGRES_JDBC_URL", jdbcUrl);
        environment.put("MEDIA_POSTGRES_USER", "sa");
        environment.put("MEDIA_POSTGRES_DRIVER", "org.h2.Driver");
        environment.put("MEDIA_POSTGRES_POOL_SIZE", "8");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_UPLOAD_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_UPLOAD_SECRET");
        environment.put("MEDIA_UPLOAD_ACCESS", LOCALSTACK.getAccessKey());
        environment.put("MEDIA_UPLOAD_SECRET", LOCALSTACK.getSecretKey());
        return new Harness(jdbcUrl, bucket, MediaAwsPostgresqlRuntimeState.installForTesting(environment));
    }

    private static S3Client s3() {
        return S3Client.builder()
                .endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .build();
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static String chunkKey(String tenantId, String uploadId) throws Exception {
        String tenantNamespace = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(tenantId.getBytes(StandardCharsets.UTF_8))).substring(0, 32);
        return "media-runtime/uploads/" + tenantNamespace + "/" + uploadId + "/chunks/0";
    }

    @Test
    void corruptStagedChunkAfterRestartFailsClosedWithoutNewArtifact() throws Exception {
        try (Harness h = harness();
             S3PostgresqlMediaArtifactStore anchor = new S3PostgresqlMediaArtifactStore()) {
            byte[] original = "RIFF-corrupt-after-acknowledgement".getBytes(StandardCharsets.UTF_8);
            UploadRequest request = new UploadRequest("tenant-a", "principal-a", "clip.wav", "audio/wav",
                    original.length, sha256(original), "RESTRICTED", Duration.ofDays(1), Map.of());
            String idempotencyKey = "j02-corrupt-restart-" + UUID.randomUUID();
            String uploadId;

            try (S3PostgresqlMediaArtifactStore workerA = new S3PostgresqlMediaArtifactStore()) {
                UploadSession begun = workerA.begin(request, idempotencyKey);
                uploadId = begun.uploadId();
                workerA.append("tenant-a", "principal-a", uploadId, 0, original);
            }

            // Model loss/corruption of a committed staged object outside the Media writer.
            byte[] corrupted = original.clone();
            corrupted[corrupted.length - 1] ^= 0x01;
            try (S3Client client = s3()) {
                client.putObject(PutObjectRequest.builder().bucket(h.bucket())
                                .key(chunkKey("tenant-a", uploadId)).build(),
                        software.amazon.awssdk.core.sync.RequestBody.fromBytes(corrupted));
            }

            try (S3PostgresqlMediaArtifactStore restartedWorker = new S3PostgresqlMediaArtifactStore()) {
                UploadSession replayedBegin = restartedWorker.begin(request, idempotencyKey);
                assertThat(replayedBegin.uploadId()).isEqualTo(uploadId);
                assertThat(replayedBegin.status()).isEqualTo(UploadStatus.OPEN);
                assertThat(replayedBegin.nextChunkIndex()).isEqualTo(1);
                assertThat(replayedBegin.bytesReceived()).isEqualTo(original.length);

                // Exact request replay preserves the durable receipt; it must not bless altered S3 bytes.
                UploadSession exactReplay = restartedWorker.append(
                        "tenant-a", "principal-a", uploadId, 0, original);
                assertThat(exactReplay.uploadId()).isEqualTo(uploadId);
                assertThat(exactReplay.nextChunkIndex()).isEqualTo(1);
                assertThat(exactReplay.bytesReceived()).isEqualTo(original.length);
                assertThatThrownBy(() -> restartedWorker.complete("tenant-a", "principal-a", uploadId))
                        .isInstanceOf(IllegalStateException.class)
                        .hasMessageContaining("Stored upload chunk failed integrity verification");

                // A retry after the caller observed the failed completion must remain fail-closed.
                assertThatThrownBy(() -> restartedWorker.complete("tenant-a", "principal-a", uploadId))
                        .isInstanceOf(IllegalStateException.class)
                        .hasMessageContaining("Stored upload chunk failed integrity verification");

                UploadSession afterFailure = restartedWorker.upload("tenant-a", uploadId).orElseThrow();
                assertThat(afterFailure.status()).isEqualTo(UploadStatus.OPEN);
                assertThat(afterFailure.nextChunkIndex()).isEqualTo(1);
                assertThat(afterFailure.bytesReceived()).isEqualTo(original.length);
                try (var connection = DriverManager.getConnection(h.jdbcUrl(), "sa", "");
                     var statement = connection.prepareStatement(
                             "SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=? AND sha256=?")) {
                    statement.setString(1, "tenant-a");
                    statement.setString(2, sha256(original));
                    try (var rows = statement.executeQuery()) {
                        assertThat(rows.next()).isTrue();
                        assertThat(rows.getLong(1)).isZero();
                    }
                }
            }
        }
    }
}
