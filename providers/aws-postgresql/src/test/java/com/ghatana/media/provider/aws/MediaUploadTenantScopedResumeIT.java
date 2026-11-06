package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
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
import software.amazon.awssdk.services.s3.model.GetObjectRequest;

import java.security.MessageDigest;
import java.time.Duration;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * Synthetic J-02 negative boundary: a foreign tenant cannot observe or resume an open upload.
 * Source: PDP-0 {@code journey-catalog.yaml#/journeys/@id=J-02} and PDP-3
 * {@code upload-import-and-verify-artifact.yaml#/steps/2}; this does not exercise the host UI,
 * real source authorization, or production rights/consent decisions.
 */
@Testcontainers(disabledWithoutDocker = true)
class MediaUploadTenantScopedResumeIT {
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private record Harness(String jdbcUrl, String bucket, AutoCloseable installed) implements AutoCloseable {
        @Override public void close() throws Exception { installed.close(); }
    }

    private static Harness harness() throws Exception {
        String id = UUID.randomUUID().toString().replace("-", "");
        String jdbcUrl = "jdbc:h2:mem:media_upload_tenant_resume_" + id
                + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1";
        String bucket = "media-upload-tenant-resume-" + id;
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

    private static byte[] wav(byte[] payload) {
        byte[] out = new byte[payload.length + 12];
        out[0] = 'R'; out[1] = 'I'; out[2] = 'F'; out[3] = 'F';
        int size = payload.length + 4;
        out[4] = (byte) size; out[5] = (byte) (size >> 8);
        out[6] = (byte) (size >> 16); out[7] = (byte) (size >> 24);
        out[8] = 'W'; out[9] = 'A'; out[10] = 'V'; out[11] = 'E';
        System.arraycopy(payload, 0, out, 12, payload.length);
        return out;
    }

    private static byte[] storedBytes(String bucket, String objectReference) throws Exception {
        String key = objectReference.substring(("s3://" + bucket + "/").length());
        try (S3Client client = s3()) {
            return client.getObject(GetObjectRequest.builder().bucket(bucket).key(key).build()).readAllBytes();
        }
    }

    @Test
    void openUploadRemainsTenantScopedAcrossRestartAndResumesOnlyOriginalSourceBytes() throws Exception {
        try (Harness h = harness();
             S3PostgresqlMediaArtifactStore anchor = new S3PostgresqlMediaArtifactStore()) {
            byte[] sourceRevision = wav("synthetic-j02-source-revision-7"
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8));
            byte[] acknowledged = java.util.Arrays.copyOfRange(sourceRevision, 0, 12);
            byte[] remainder = java.util.Arrays.copyOfRange(sourceRevision, 12, sourceRevision.length);
            UploadRequest request = new UploadRequest("tenant-owner", "principal-owner", "clip.wav",
                    "audio/wav", sourceRevision.length, sha256(sourceRevision), "RESTRICTED",
                    Duration.ofDays(1), Map.of("fixture", "non-production", "sourceRevision", "7"));
            String uploadId;

            try (S3PostgresqlMediaArtifactStore firstWorker = new S3PostgresqlMediaArtifactStore()) {
                uploadId = firstWorker.begin(request, "synthetic-j02-upload").uploadId();
                firstWorker.append("tenant-owner", "principal-owner", uploadId, 0, acknowledged);
                assertThat(firstWorker.upload("tenant-foreign", uploadId)).isEmpty();
                assertThatThrownBy(() -> firstWorker.append(
                        "tenant-foreign", "principal-owner", uploadId, 1, remainder))
                        .isInstanceOf(RuntimeException.class);
            }

            try (S3PostgresqlMediaArtifactStore restartedWorker = new S3PostgresqlMediaArtifactStore()) {
                UploadSession resumed = restartedWorker.upload("tenant-owner", uploadId).orElseThrow();
                assertThat(resumed.status()).isEqualTo(UploadStatus.OPEN);
                assertThat(resumed.nextChunkIndex()).isEqualTo(1);
                assertThat(resumed.bytesReceived()).isEqualTo(acknowledged.length);

                // A conflicting replay is rejected; it cannot replace the acknowledged source revision.
                assertThatThrownBy(() -> restartedWorker.append("tenant-owner", "principal-owner", uploadId,
                        0, "corrupt-substitution".getBytes(java.nio.charset.StandardCharsets.UTF_8)))
                        .isInstanceOf(RuntimeException.class);
                restartedWorker.append("tenant-owner", "principal-owner", uploadId, 1, remainder);
                MediaArtifact artifact = restartedWorker.complete("tenant-owner", "principal-owner", uploadId);
                assertThat(artifact.sha256()).isEqualTo(sha256(sourceRevision));
                assertThat(storedBytes(h.bucket(), artifact.objectReference())).isEqualTo(sourceRevision);
                assertThat(restartedWorker.upload("tenant-foreign", uploadId)).isEmpty();
            }
        }
    }
}
