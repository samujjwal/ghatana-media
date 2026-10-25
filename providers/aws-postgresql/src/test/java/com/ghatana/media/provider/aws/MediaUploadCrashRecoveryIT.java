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
import java.sql.DriverManager;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * A03/A12 durable-upload crash matrix. A "restart" is a fresh {@link S3PostgresqlMediaArtifactStore}
 * instance over the same committed database and S3 bucket — the previous store object is closed as
 * a crashed worker would leave it. Session progress, chunk receipts and finalization claims are
 * read back from durable state only.
 */
@Testcontainers(disabledWithoutDocker = true)
class MediaUploadCrashRecoveryIT {
    private static org.h2.jdbcx.JdbcDataSource h2(String url) {
        var ds = new org.h2.jdbcx.JdbcDataSource();
        ds.setURL(url);
        ds.setUser("sa");
        return ds;
    }


    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private record Harness(String jdbcUrl, String bucket, AutoCloseable installed)
            implements AutoCloseable {
        @Override public void close() throws Exception { installed.close(); }
    }

    private static Harness harness() throws Exception {
        String jdbcUrl = "jdbc:h2:mem:media_upload_crash_" + UUID.randomUUID().toString().replace("-", "")
                + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1";
        String bucket = "media-upload-crash-" + UUID.randomUUID().toString().replace("-", "");
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
        return new Harness(jdbcUrl, bucket,
                MediaAwsPostgresqlRuntimeState.installForTesting(environment));
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

    private static UploadRequest request(String tenant, String principal, byte[] content) throws Exception {
        return new UploadRequest(
                tenant, principal, "clip.wav", "audio/wav", content.length,
                sha256(content), "RESTRICTED", Duration.ofDays(30), Map.of());
    }

    private static byte[] s3Bytes(String bucket, String objectReference) {
        String key = objectReference.substring(("s3://" + bucket + "/").length());
        try (S3Client client = s3()) {
            return client.getObject(GetObjectRequest.builder().bucket(bucket).key(key).build())
                    .readAllBytes();
        } catch (Exception failure) {
            throw new AssertionError("S3 read failed for " + objectReference, failure);
        }
    }

    @Test
    void restartMidUploadResumesExactCommittedBytesAndFinalizesOnce() throws Exception {
        try (Harness h = harness();
             S3PostgresqlMediaArtifactStore anchor = new S3PostgresqlMediaArtifactStore()) {
            byte[] payload = wav("resume-payload".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            int split = payload.length / 3;
            UploadRequest request = request("tenant-a", "principal-a", payload);

            UploadSession begun;
            try (S3PostgresqlMediaArtifactStore workerA = new S3PostgresqlMediaArtifactStore()) {
                begun = workerA.begin(request, "resume-key");
                workerA.append("tenant-a", "principal-a", begun.uploadId(), 0,
                        java.util.Arrays.copyOfRange(payload, 0, split));
                workerA.append("tenant-a", "principal-a", begun.uploadId(), 1,
                        java.util.Arrays.copyOfRange(payload, split, split * 2));
                // Worker A crashes mid-upload; committed session state must survive intact.
            }

            try (S3PostgresqlMediaArtifactStore workerB = new S3PostgresqlMediaArtifactStore()) {
                UploadSession resumed = workerB.upload("tenant-a", begun.uploadId()).orElseThrow();
                assertThat(resumed.status()).isEqualTo(UploadStatus.OPEN);
                assertThat(resumed.nextChunkIndex()).isEqualTo(2);
                assertThat(resumed.bytesReceived()).isEqualTo(split * 2);

                workerB.append("tenant-a", "principal-a", begun.uploadId(), 2,
                        java.util.Arrays.copyOfRange(payload, split * 2, payload.length));
                MediaArtifact artifact = workerB.complete("tenant-a", "principal-a", begun.uploadId());
                assertThat(artifact.sha256()).isEqualTo(sha256(payload));
                // The finalized object bytes are the exact committed chunk sequence.
                assertThat(s3Bytes(h.bucket(), artifact.objectReference())).isEqualTo(payload);
                // A replayed complete resolves to the same artifact, not a second object.
                assertThat(workerB.complete("tenant-a", "principal-a", begun.uploadId()))
                        .isEqualTo(artifact);
            }
        }
    }

    @Test
    void restartBetweenBeginAndAppendKeepsSessionResumable() throws Exception {
        try (Harness h = harness();
             S3PostgresqlMediaArtifactStore anchor = new S3PostgresqlMediaArtifactStore()) {
            byte[] payload = wav("begin-crash".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            UploadRequest request = request("tenant-a", "principal-a", payload);
            String uploadId;
            try (S3PostgresqlMediaArtifactStore workerA = new S3PostgresqlMediaArtifactStore()) {
                uploadId = workerA.begin(request, "begin-crash-key").uploadId();
            }
            try (S3PostgresqlMediaArtifactStore workerB = new S3PostgresqlMediaArtifactStore()) {
                UploadSession resumed = workerB.upload("tenant-a", uploadId).orElseThrow();
                assertThat(resumed.nextChunkIndex()).isZero();
                workerB.append("tenant-a", "principal-a", uploadId, 0, payload);
                assertThat(workerB.complete("tenant-a", "principal-a", uploadId).sha256())
                        .isEqualTo(sha256(payload));
            }
        }
    }

    @Test
    void restartRejectsChunkIndexReusedWithDifferentBytes() throws Exception {
        try (Harness ignored = harness();
             S3PostgresqlMediaArtifactStore anchor = new S3PostgresqlMediaArtifactStore()) {
            byte[] payload = wav("chunk-conflict".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            UploadRequest request = request("tenant-a", "principal-a", payload);
            String uploadId;
            try (S3PostgresqlMediaArtifactStore workerA = new S3PostgresqlMediaArtifactStore()) {
                uploadId = workerA.begin(request, "chunk-conflict-key").uploadId();
                workerA.append("tenant-a", "principal-a", uploadId, 0,
                        java.util.Arrays.copyOfRange(payload, 0, payload.length - 4));
            }
            try (S3PostgresqlMediaArtifactStore workerB = new S3PostgresqlMediaArtifactStore()) {
                // The persisted chunk receipt cannot be silently overwritten by different bytes.
                assertThatThrownBy(() -> workerB.append(
                        "tenant-a", "principal-a", uploadId, 0, "forgery".getBytes(java.nio.charset.StandardCharsets.UTF_8)))
                        .isInstanceOf(RuntimeException.class);
                // The persisted receipt is also replayed byte-identically without conflict.
                UploadSession replayed = workerB.append("tenant-a", "principal-a", uploadId, 0,
                        java.util.Arrays.copyOfRange(payload, 0, payload.length - 4));
                assertThat(replayed.nextChunkIndex()).isEqualTo(1);
            }
        }
    }

    @Test
    void concurrentCompletersProduceExactlyOneArtifact() throws Exception {
        try (Harness h = harness();
             S3PostgresqlMediaArtifactStore anchor = new S3PostgresqlMediaArtifactStore()) {
            byte[] payload = wav("concurrent-complete".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            UploadRequest request = request("tenant-a", "principal-a", payload);
            String uploadId;
            try (S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore()) {
                uploadId = store.begin(request, "concurrent-complete-key").uploadId();
                store.append("tenant-a", "principal-a", uploadId, 0, payload);
            }
            try (S3PostgresqlMediaArtifactStore workerA = new S3PostgresqlMediaArtifactStore();
                 S3PostgresqlMediaArtifactStore workerB = new S3PostgresqlMediaArtifactStore()) {
                var pool = java.util.concurrent.Executors.newFixedThreadPool(2);
                var ready = new java.util.concurrent.CountDownLatch(2);
                var start = new java.util.concurrent.CountDownLatch(1);
                var results = new java.util.concurrent.CopyOnWriteArrayList<MediaArtifact>();
                var futures = new java.util.concurrent.CopyOnWriteArrayList<java.util.concurrent.Future<?>>();
                var failures = new java.util.concurrent.CopyOnWriteArrayList<Throwable>();
                try {
                    for (var worker : new S3PostgresqlMediaArtifactStore[] {workerA, workerB}) {
                        futures.add(pool.submit(() -> {
                            ready.countDown();
                            start.await();
                            try {
                                results.add(worker.complete("tenant-a", "principal-a", uploadId));
                            } catch (RuntimeException failure) {
                                failures.add(failure);
                            }
                            return null;
                        }));
                    }
                    assertThat(ready.await(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                    start.countDown();
                    pool.shutdown();
                    assertThat(pool.awaitTermination(30, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                    for (var future : futures) future.get();
                } finally {
                    start.countDown();
                    pool.shutdownNow();
                }
                // Exactly one artifact is registered; both completers either observe the same
                // artifact or exactly one observes it while the other is fenced out.
                var artifacts = new java.util.HashSet<MediaArtifact>(results);
                assertThat(artifacts).hasSize(1);
                try (var connection = h2(h.jdbcUrl()).getConnection();
                     var statement = connection.createStatement();
                     var rows = statement.executeQuery(
                             "SELECT COUNT(*) FROM media_artifacts WHERE tenant_id='tenant-a'")) {
                    rows.next();
                    assertThat(rows.getLong(1)).isEqualTo(1);
                }
            }
        }
    }

    @Test
    void staleFinalizerClaimIsTakenOverAndProducesOneArtifact() throws Exception {
        try (Harness h = harness();
             S3PostgresqlMediaArtifactStore anchor = new S3PostgresqlMediaArtifactStore()) {
            byte[] payload = wav("stale-finalizer".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            UploadRequest request = request("tenant-a", "principal-a", payload);
            String uploadId;
            try (S3PostgresqlMediaArtifactStore workerA = new S3PostgresqlMediaArtifactStore()) {
                uploadId = workerA.begin(request, "stale-finalizer-key").uploadId();
                workerA.append("tenant-a", "principal-a", uploadId, 0, payload);
            }
            // The crashed worker left a FINALIZING claim whose start is older than the stale
            // takeover window, so a second worker must be able to finalize — exactly once.
            long staleStart = Instant.now().minus(Duration.ofHours(1)).toEpochMilli();
            try (var connection = h2(h.jdbcUrl()).getConnection();
                 var update = connection.prepareStatement(
                         "UPDATE media_upload_sessions SET status='FINALIZING',"
                                 + "finalization_token='dead-worker',finalization_started_at=?,"
                                 + "updated_at=? WHERE tenant_id='tenant-a' AND upload_id=?")) {
                update.setLong(1, staleStart);
                update.setLong(2, staleStart);
                update.setString(3, uploadId);
                update.executeUpdate();
            }
            try (S3PostgresqlMediaArtifactStore workerB = new S3PostgresqlMediaArtifactStore()) {
                MediaArtifact artifact = workerB.complete("tenant-a", "principal-a", uploadId);
                assertThat(artifact.sha256()).isEqualTo(sha256(payload));
                assertThat(s3Bytes(h.bucket(), artifact.objectReference())).isEqualTo(payload);
            }
        }
    }

    private static byte[] wav(byte[] payload) {
        byte[] out = new byte[payload.length + 12];
        out[0] = 'R'; out[1] = 'I'; out[2] = 'F'; out[3] = 'F';
        int size = payload.length + 4;
        out[4] = (byte) size; out[5] = (byte) (size >> 8); out[6] = (byte) (size >> 16); out[7] = (byte) (size >> 24);
        out[8] = 'W'; out[9] = 'A'; out[10] = 'V'; out[11] = 'E';
        System.arraycopy(payload, 0, out, 12, payload.length);
        return out;
    }

    private static String sha256(byte[] value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
    }
}
