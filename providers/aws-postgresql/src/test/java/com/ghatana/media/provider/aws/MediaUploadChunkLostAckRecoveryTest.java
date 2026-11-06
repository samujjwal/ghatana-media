package com.ghatana.media.provider.aws;

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
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.model.S3Exception;
import software.amazon.awssdk.core.sync.RequestBody;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.DriverManager;
import java.time.Duration;
import java.util.HexFormat;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** Covers an S3 PutObject that commits bytes but loses its acknowledgement before DB metadata. */
@Testcontainers(disabledWithoutDocker = true)
class MediaUploadChunkLostAckRecoveryTest {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void lostPutAcknowledgementDeletesUnownedChunkAndLeavesUploadResumable() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-upload-lost-ack-" + runId;
        String prefix = "upload-lost-ack/" + runId;
        String tenant = "tenant-upload-lost-ack-" + runId;
        String principal = "principal-upload-lost-ack-" + runId;
        byte[] bytes = wav(("lost-chunk-ack:" + runId).getBytes(StandardCharsets.UTF_8));
        String digest = sha256(bytes);
        createBucket(bucket);
        Map<String, String> environment = environment(bucket, prefix);
        AtomicBoolean loseAcknowledgement = new AtomicBoolean(true);

        try {
            String uploadId;
            try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(
                         environment, delegate -> losePutAcknowledgement(delegate, loseAcknowledgement, bucket));
                 S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore()) {
                var upload = store.begin(new UploadRequest(tenant, principal, "source.wav", "audio/wav",
                        bytes.length, digest, "RESTRICTED", Duration.ofDays(7), Map.of()),
                        "upload-lost-ack-" + runId);
                uploadId = upload.uploadId();
                String chunkKey = prefix + "/uploads/" + opaque(tenant) + "/" + uploadId + "/chunks/0";

                assertThatThrownBy(() -> store.append(tenant, principal, uploadId, 0, bytes))
                        .isInstanceOf(S3Exception.class)
                        .hasMessageContaining("injected lost S3 PutObject acknowledgement");
                assertThat(loseAcknowledgement).isFalse();
                assertThat(objectExists(bucket, chunkKey))
                        .as("bytes written before the lost acknowledgement are removed without a DB manifest")
                        .isFalse();
                assertThat(chunkRowCount(tenant, uploadId)).isZero();
                assertThat(store.upload(tenant, uploadId).orElseThrow().nextChunkIndex()).isZero();

                store.append(tenant, principal, uploadId, 0, bytes);
                assertThat(objectExists(bucket, chunkKey)).isTrue();
                assertThat(chunkRowCount(tenant, uploadId)).isEqualTo(1);
                assertThat(store.upload(tenant, uploadId).orElseThrow().bytesReceived()).isEqualTo(bytes.length);
            }
        } finally {
            deleteBucket(bucket);
        }
    }

    @Test
    void retryCannotCommitChunkWhileLostAckCleanupCanStillDeleteItsObject() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-upload-lost-ack-race-" + runId;
        String prefix = "upload-lost-ack-race/" + runId;
        String tenant = "tenant-upload-lost-ack-race-" + runId;
        String principal = "principal-upload-lost-ack-race-" + runId;
        byte[] bytes = wav(("lost-chunk-ack-race:" + runId).getBytes(StandardCharsets.UTF_8));
        String digest = sha256(bytes);
        String uploadId;
        String chunkKey;
        createBucket(bucket);
        Map<String, String> environment = environment(bucket, prefix);
        AtomicBoolean loseAcknowledgement = new AtomicBoolean(true);
        CountDownLatch cleanupEntered = new CountDownLatch(1);
        CountDownLatch releaseCleanup = new CountDownLatch(1);
        CountDownLatch retryStarted = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);

        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(
                     environment, delegate -> losePutAcknowledgementAndPauseCleanup(
                             delegate, loseAcknowledgement, bucket, cleanupEntered, releaseCleanup));
             S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore()) {
            var upload = store.begin(new UploadRequest(tenant, principal, "source.wav", "audio/wav",
                    bytes.length, digest, "RESTRICTED", Duration.ofDays(7), Map.of()),
                    "upload-lost-ack-race-" + runId);
            uploadId = upload.uploadId();
            chunkKey = prefix + "/uploads/" + opaque(tenant) + "/" + uploadId + "/chunks/0";

            Future<Boolean> firstAppend = executor.submit(() -> {
                try {
                    store.append(tenant, principal, uploadId, 0, bytes);
                    return false;
                } catch (S3Exception expectedLostAcknowledgement) {
                    return expectedLostAcknowledgement.getMessage().contains(
                            "injected lost S3 PutObject acknowledgement");
                }
            });
            assertThat(cleanupEntered.await(10, TimeUnit.SECONDS))
                    .as("first append reaches orphan cleanup after its PG transaction rolls back")
                    .isTrue();

            Future<?> retry = executor.submit(() -> {
                retryStarted.countDown();
                return store.append(tenant, principal, uploadId, 0, bytes);
            });
            assertThat(retryStarted.await(10, TimeUnit.SECONDS)).isTrue();
            // Give the retry a bounded window to contend on the durable upload row. The
            // reconciler must keep that row locked through DELETE; otherwise this read can
            // observe a committed manifest while cleanup is still paused.
            Thread.sleep(200);
            assertThat(store.upload(tenant, uploadId).orElseThrow().nextChunkIndex())
                    .as("a retry cannot commit the manifest until the orphan cleanup releases its lock")
                    .isZero();

            releaseCleanup.countDown();
            assertThat(firstAppend.get(10, TimeUnit.SECONDS)).isTrue();
            retry.get(10, TimeUnit.SECONDS);
            assertThat(store.upload(tenant, uploadId).orElseThrow().nextChunkIndex()).isEqualTo(1);
            assertThat(chunkRowCount(tenant, uploadId)).isEqualTo(1);
            assertThat(s3Object(bucket, chunkKey)).containsExactly(bytes);
        } finally {
            releaseCleanup.countDown();
            executor.shutdownNow();
            deleteBucket(bucket);
        }
    }

    private static S3Client losePutAcknowledgementAndPauseCleanup(
            S3Client delegate,
            AtomicBoolean loseAcknowledgement,
            String bucket,
            CountDownLatch cleanupEntered,
            CountDownLatch releaseCleanup) {
        return (S3Client) Proxy.newProxyInstance(S3Client.class.getClassLoader(), new Class<?>[] {S3Client.class},
                (proxy, method, arguments) -> {
                    if (method.getName().equals("putObject") && arguments != null && arguments.length > 0
                            && arguments[0] instanceof PutObjectRequest request
                            && bucket.equals(request.bucket()) && request.key().contains("/chunks/0")) {
                        try {
                            Object response = method.invoke(delegate, arguments);
                            if (loseAcknowledgement.compareAndSet(true, false)) {
                                throw S3Exception.builder().statusCode(503)
                                        .message("injected lost S3 PutObject acknowledgement").build();
                            }
                            return response;
                        } catch (InvocationTargetException failure) {
                            throw failure.getCause();
                        }
                    }
                    if (method.getName().equals("deleteObject") && arguments != null && arguments.length > 0
                            && arguments[0] instanceof DeleteObjectRequest request
                            && bucket.equals(request.bucket()) && request.key().contains("/chunks/0")) {
                        cleanupEntered.countDown();
                        if (!releaseCleanup.await(10, TimeUnit.SECONDS)) {
                            throw new IllegalStateException("timed out waiting to resume orphan cleanup");
                        }
                    }
                    try {
                        return method.invoke(delegate, arguments);
                    } catch (InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                });
    }

    private static S3Client losePutAcknowledgement(
            S3Client delegate, AtomicBoolean loseAcknowledgement, String bucket) {
        return (S3Client) Proxy.newProxyInstance(S3Client.class.getClassLoader(), new Class<?>[] {S3Client.class},
                (proxy, method, arguments) -> {
                    if (method.getName().equals("putObject") && arguments != null && arguments.length > 0
                            && arguments[0] instanceof PutObjectRequest request
                            && bucket.equals(request.bucket()) && request.key().contains("/chunks/0")) {
                        try {
                            Object response = method.invoke(delegate, arguments);
                            if (loseAcknowledgement.compareAndSet(true, false)) {
                                throw S3Exception.builder().statusCode(503)
                                        .message("injected lost S3 PutObject acknowledgement").build();
                            }
                            return response;
                        } catch (InvocationTargetException failure) {
                            throw failure.getCause();
                        }
                    }
                    try {
                        return method.invoke(delegate, arguments);
                    } catch (InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                });
    }

    private static Map<String, String> environment(String bucket, String prefix) {
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        environment.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        environment.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        environment.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_UPLOAD_LOST_ACK_DB_PASSWORD");
        environment.put("MEDIA_UPLOAD_LOST_ACK_DB_PASSWORD", POSTGRES.getPassword());
        environment.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        environment.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_PREFIX", prefix);
        environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_UPLOAD_LOST_ACK_S3_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_UPLOAD_LOST_ACK_S3_SECRET");
        environment.put("MEDIA_UPLOAD_LOST_ACK_S3_ACCESS", LOCALSTACK.getAccessKey());
        environment.put("MEDIA_UPLOAD_LOST_ACK_S3_SECRET", LOCALSTACK.getSecretKey());
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

    private static boolean objectExists(String bucket, String key) {
        try (S3Client s3 = s3Client()) {
            s3.headObject(b -> b.bucket(bucket).key(key));
            return true;
        } catch (S3Exception missing) {
            if (missing.statusCode() == 404) return false;
            throw missing;
        }
    }

    private static byte[] s3Object(String bucket, String key) {
        try (S3Client s3 = s3Client()) {
            return s3.getObjectAsBytes(GetObjectRequest.builder().bucket(bucket).key(key).build()).asByteArray();
        }
    }

    private static int chunkRowCount(String tenant, String uploadId) throws Exception {
        try (var connection = DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var query = connection.prepareStatement(
                     "SELECT COUNT(*) FROM media_upload_chunks WHERE tenant_id=? AND upload_id=?")) {
            query.setString(1, tenant);
            query.setString(2, uploadId);
            try (var rows = query.executeQuery()) {
                rows.next();
                return rows.getInt(1);
            }
        }
    }

    private static String opaque(String value) throws Exception {
        return sha256(value.getBytes(StandardCharsets.UTF_8)).substring(0, 32);
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

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static void deleteBucket(String bucket) {
        try (S3Client s3 = s3Client()) {
            for (var object : s3.listObjectsV2(b -> b.bucket(bucket)).contents()) {
                s3.deleteObject(b -> b.bucket(bucket).key(object.key()));
            }
            s3.deleteBucket(b -> b.bucket(bucket));
        } catch (RuntimeException ignored) {
            // Disposable LocalStack and PostgreSQL containers are the test cleanup boundary.
        }
    }
}
