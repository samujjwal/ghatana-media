package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import org.junit.jupiter.api.Test;
import org.testcontainers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

import java.nio.charset.StandardCharsets;
import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.DriverManager;
import java.time.Duration;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Local S3-compatible/PostgreSQL checks; these do not qualify AWS or production storage. */
@Testcontainers(disabledWithoutDocker = true)
class S3PostgresqlMediaArtifactAdmissionTest {
    @Container
    static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices("s3");

    @Test
    void rejectsPathComponentsAndControlCharactersInDisplayName() {
        assertThat(S3PostgresqlMediaArtifactStore.safeFileName("clip-final.mp4"))
                .isEqualTo("clip-final.mp4");
        assertThat(S3PostgresqlMediaArtifactStore.safeFileName("clip\r\nfinal.mp4"))
                .isEqualTo("clip__final.mp4");
        for (String input : new String[] {"../clip.mp4", "folder/clip.mp4", "folder\\clip.mp4", "C:clip.mp4", ".."}) {
            assertThatThrownBy(() -> S3PostgresqlMediaArtifactStore.safeFileName(input))
                    .as("reject path-like filename %s", input)
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    void versionPinnedLookupIsTenantScopedAndRequiresTheCapturedDigest() throws Exception {
        withStore((store, admin, bucket, environment) -> {
            byte[] bytes = new byte[] {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10, 1, 2, 3, 4};
            var artifact = upload(store, bytes, "captured.png");
            assertThat(store.artifact("tenant-a", artifact.artifactId(), artifact.version()))
                    .contains(artifact);
            assertThat(store.artifact("tenant-a", artifact.artifactId(),
                    new ArtifactVersion("sha256:" + "0".repeat(64)))).isEmpty();
            assertThat(store.artifact("tenant-b", artifact.artifactId(), artifact.version())).isEmpty();
        });
    }

    @Test
    void contentReadStreamsOnlyOwnedExactVersionAndReturnsReceiptAfterFullDigestCheck() throws Exception {
        withStore((store, admin, bucket, environment) -> {
            byte[] bytes = new byte[] {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10, 1, 2, 3, 4};
            var artifact = upload(store, bytes, "content-read.png");

            ByteArrayOutputStream valid = new ByteArrayOutputStream();
            var receipt = store.copyContent("tenant-a", "principal-a", artifact.artifactId(),
                    artifact.version(), valid, bytes.length).orElseThrow();
            assertThat(valid.toByteArray()).containsExactly(bytes);
            assertThat(receipt.version()).isEqualTo(artifact.version());
            assertThat(receipt.sha256()).isEqualTo(artifact.sha256());
            assertThat(receipt.bytesCopied()).isEqualTo(bytes.length);

            ByteArrayOutputStream wrongPrincipal = new ByteArrayOutputStream();
            assertThat(store.copyContent("tenant-a", "principal-b", artifact.artifactId(),
                    artifact.version(), wrongPrincipal, bytes.length)).isEmpty();
            assertThat(wrongPrincipal.size()).isZero();

            ByteArrayOutputStream wrongTenant = new ByteArrayOutputStream();
            assertThat(store.copyContent("tenant-b", "principal-a", artifact.artifactId(),
                    artifact.version(), wrongTenant, bytes.length)).isEmpty();
            assertThat(wrongTenant.size()).isZero();

            ByteArrayOutputStream staleVersion = new ByteArrayOutputStream();
            assertThat(store.copyContent("tenant-a", "principal-a", artifact.artifactId(),
                    new ArtifactVersion("sha256:" + "0".repeat(64)), staleVersion, bytes.length)).isEmpty();
            assertThat(staleVersion.size()).isZero();

            ByteArrayOutputStream tooSmall = new ByteArrayOutputStream();
            assertThatThrownBy(() -> store.copyContent("tenant-a", "principal-a", artifact.artifactId(),
                    artifact.version(), tooSmall, bytes.length - 1))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("MEDIA_ARTIFACT_READ_LIMIT");
            assertThat(tooSmall.size()).isZero();

            String prefix = "s3://" + bucket + "/";
            String objectReference = artifact.objectReference();
            assertThat(objectReference).startsWith(prefix);
            byte[] altered = Arrays.copyOf(bytes, bytes.length);
            altered[altered.length - 1] ^= 0x01;
            admin.putObject(PutObjectRequest.builder().bucket(bucket)
                            .key(objectReference.substring(prefix.length()))
                            .contentLength((long) altered.length).build(), RequestBody.fromBytes(altered));

            ByteArrayOutputStream corrupted = new ByteArrayOutputStream();
            long stagedBeforeCorruptRead = stagedReadFileCount();
            assertThatThrownBy(() -> store.copyContent("tenant-a", "principal-a", artifact.artifactId(),
                    artifact.version(), corrupted, bytes.length))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("immutable version");
            assertThat(corrupted.size()).isZero();
            assertThat(stagedReadFileCount()).isEqualTo(stagedBeforeCorruptRead);

            byte[] oversized = Arrays.copyOf(bytes, bytes.length + 1);
            admin.putObject(PutObjectRequest.builder().bucket(bucket)
                            .key(objectReference.substring(prefix.length()))
                            .contentLength((long) oversized.length).build(), RequestBody.fromBytes(oversized));
            ByteArrayOutputStream inconsistent = new ByteArrayOutputStream();
            long stagedBeforeOversizedRead = stagedReadFileCount();
            assertThatThrownBy(() -> store.copyContent("tenant-a", "principal-a", artifact.artifactId(),
                    artifact.version(), inconsistent, bytes.length + 1L))
                    .isInstanceOf(java.io.IOException.class)
                    .hasMessageContaining("immutable byte ceiling");
            assertThat(inconsistent.size()).isZero();
            assertThat(stagedReadFileCount()).isEqualTo(stagedBeforeOversizedRead);
        });
    }

    @Test
    void corruptedStoredChunkCannotBecomeAnAvailableArtifact() throws Exception {
        withStore((store, admin, bucket, environment) -> {
            byte[] bytes = "verified on append but changed before finalization".getBytes(StandardCharsets.UTF_8);
            var upload = store.begin(new UploadRequest("tenant-a", "principal-a", "corrupt.bin",
                    "application/octet-stream", bytes.length, sha256(bytes), "RESTRICTED", Duration.ofDays(1), Map.of()), "begin-corrupt");
            store.append("tenant-a", "principal-a", upload.uploadId(), 0, bytes);
            String chunkKey;
            try (var connection = DriverManager.getConnection(environment.get("MEDIA_POSTGRES_JDBC_URL"));
                 var query = connection.prepareStatement(
                         "SELECT object_key FROM media_upload_chunks WHERE tenant_id=? AND upload_id=? AND chunk_index=0")) {
                query.setString(1, "tenant-a");
                query.setString(2, upload.uploadId());
                try (var row = query.executeQuery()) {
                    assertThat(row.next()).isTrue();
                    chunkKey = row.getString(1);
                }
            }
            byte[] altered = Arrays.copyOf(bytes, bytes.length);
            altered[0] ^= 0x01;
            admin.putObject(PutObjectRequest.builder().bucket(bucket).key(chunkKey)
                            .contentLength((long) altered.length).build(), RequestBody.fromBytes(altered));

            assertThatThrownBy(() -> store.complete("tenant-a", "principal-a", upload.uploadId()))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("integrity verification");
            assertThat(store.upload("tenant-a", upload.uploadId()).orElseThrow().status())
                    .isEqualTo(com.ghatana.media.runtime.MediaRuntimeContracts.UploadStatus.OPEN);
            try (var connection = DriverManager.getConnection(environment.get("MEDIA_POSTGRES_JDBC_URL"));
                 var query = connection.prepareStatement(
                         "SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=? AND sha256=?")) {
                query.setString(1, "tenant-a");
                query.setString(2, sha256(bytes));
                try (var row = query.executeQuery()) {
                    assertThat(row.next()).isTrue();
                    assertThat(row.getInt(1)).isZero();
                }
            }
        });
    }

    @Test
    void extensionSpoofIsDurablyRejectedBeforeArtifactRegistration() throws Exception {
        withStore((store, admin, bucket, environment) -> {
            byte[] bytes = "#!/bin/sh\necho should not be catalogued as a png\n"
                    .getBytes(StandardCharsets.UTF_8);
            var upload = store.begin(new UploadRequest("tenant-a", "principal-a", "cover.png",
                    "image/png", bytes.length, sha256(bytes), "RESTRICTED", Duration.ofDays(1), Map.of()), "begin-spoof");
            store.append("tenant-a", "principal-a", upload.uploadId(), 0, bytes);

            assertThatThrownBy(() -> store.complete("tenant-a", "principal-a", upload.uploadId()))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("SIGNATURE_MISMATCH");
            assertThat(store.upload("tenant-a", upload.uploadId()).orElseThrow().status())
                    .isEqualTo(com.ghatana.media.runtime.MediaRuntimeContracts.UploadStatus.ABORTED);
            try (var connection = DriverManager.getConnection(environment.get("MEDIA_POSTGRES_JDBC_URL"));
                 var query = connection.prepareStatement(
                         "SELECT state,detected_format FROM media_artifact_format_verifications "
                                 + "WHERE tenant_id=? AND upload_id=?")) {
                query.setString(1, "tenant-a");
                query.setString(2, upload.uploadId());
                try (var row = query.executeQuery()) {
                    assertThat(row.next()).isTrue();
                    assertThat(row.getString("state")).isEqualTo("SIGNATURE_MISMATCH");
                    assertThat(row.getString("detected_format")).isEqualTo("unknown");
                }
            }
            try (var connection = DriverManager.getConnection(environment.get("MEDIA_POSTGRES_JDBC_URL"));
                 var query = connection.prepareStatement(
                         "SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=? AND sha256=?")) {
                query.setString(1, "tenant-a");
                query.setString(2, sha256(bytes));
                try (var row = query.executeQuery()) {
                    assertThat(row.next()).isTrue();
                    assertThat(row.getInt(1)).isZero();
                }
            }
        });
    }

    @Test
    void unsupportedFormatIsRejectedAndNeverRegisteredAsAvailable() throws Exception {
        withStore((store, admin, bucket, environment) -> {
            byte[] bytes = "opaque but checksum-correct payload".getBytes(StandardCharsets.US_ASCII);
            var upload = store.begin(new UploadRequest("tenant-a", "principal-a", "payload.bin",
                    "application/octet-stream", bytes.length, sha256(bytes), "RESTRICTED", Duration.ofDays(1), Map.of()), "begin-unsupported");
            store.append("tenant-a", "principal-a", upload.uploadId(), 0, bytes);

            assertThatThrownBy(() -> store.complete("tenant-a", "principal-a", upload.uploadId()))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("SIGNATURE_UNRECOGNIZED");
            assertThat(store.upload("tenant-a", upload.uploadId()).orElseThrow().status())
                    .isEqualTo(com.ghatana.media.runtime.MediaRuntimeContracts.UploadStatus.ABORTED);
            try (var connection = DriverManager.getConnection(environment.get("MEDIA_POSTGRES_JDBC_URL"));
                 var query = connection.prepareStatement(
                         "SELECT state,artifact_id FROM media_artifact_format_verifications "
                                 + "WHERE tenant_id=? AND upload_id=?")) {
                query.setString(1, "tenant-a");
                query.setString(2, upload.uploadId());
                try (var row = query.executeQuery()) {
                    assertThat(row.next()).isTrue();
                    assertThat(row.getString("state")).isEqualTo("SIGNATURE_UNRECOGNIZED");
                    assertThat(row.getString("artifact_id")).isNull();
                }
            }
            assertThat(store.artifact("tenant-a", "missing-artifact")).isEmpty();
            try (var connection = DriverManager.getConnection(environment.get("MEDIA_POSTGRES_JDBC_URL"));
                 var query = connection.prepareStatement(
                         "SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=? AND sha256=?")) {
                query.setString(1, "tenant-a");
                query.setString(2, sha256(bytes));
                try (var row = query.executeQuery()) {
                    assertThat(row.next()).isTrue();
                    assertThat(row.getInt(1)).isZero();
                }
            }
        });
    }

    @Test
    void artifactReadsRequirePersistedSignatureMatchState() throws Exception {
        withStore((store, admin, bucket, environment) -> {
            byte[] bytes = new byte[] {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10, 1, 2, 3, 4};
            var session = store.begin(new UploadRequest("tenant-a", "principal-a", "image.png",
                    "image/png", bytes.length, sha256(bytes), "RESTRICTED", Duration.ofDays(1), Map.of()), "begin-reads");
            store.append("tenant-a", "principal-a", session.uploadId(), 0, bytes);
            var artifact = store.complete("tenant-a", "principal-a", session.uploadId());
            assertThat(store.artifact("tenant-a", artifact.artifactId())).contains(artifact);

            try (var connection = DriverManager.getConnection(environment.get("MEDIA_POSTGRES_JDBC_URL"));
                 var update = connection.prepareStatement(
                         "UPDATE media_artifact_format_verifications SET state='SIGNATURE_UNRECOGNIZED' "
                                 + "WHERE tenant_id=? AND upload_id=?")) {
                update.setString(1, "tenant-a");
                update.setString(2, session.uploadId());
                assertThat(update.executeUpdate()).isEqualTo(1);
            }

            assertThat(store.artifact("tenant-a", artifact.artifactId())).isEmpty();
            assertThat(store.artifact("tenant-a", artifact.artifactId(), artifact.version())).isEmpty();
            assertThatThrownBy(() -> store.complete("tenant-a", "principal-a", session.uploadId()))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("lacks an admitted signature state");
        });
    }

    @Test
    void knownSignatureVerificationIsDurableAndRecordsOnlyItsNarrowClaim() throws Exception {
        withStore((store, admin, bucket, environment) -> {
            byte[] pngHeader = new byte[] {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10, 1, 2, 3, 4};
            var upload = store.begin(new UploadRequest("tenant-a", "principal-a", "image.png",
                    "image/png", pngHeader.length, sha256(pngHeader), "RESTRICTED", Duration.ofDays(1), Map.of()), "begin-known-sig");
            store.append("tenant-a", "principal-a", upload.uploadId(), 0, pngHeader);
            var artifact = store.complete("tenant-a", "principal-a", upload.uploadId());
            assertThat(artifact.version().value()).isEqualTo("sha256:" + sha256(pngHeader));
            try (var connection = DriverManager.getConnection(environment.get("MEDIA_POSTGRES_JDBC_URL"));
                 var query = connection.prepareStatement(
                         "SELECT policy_version,state,detected_format FROM media_artifact_format_verifications "
                                 + "WHERE tenant_id=? AND upload_id=? AND artifact_id=?")) {
                query.setString(1, "tenant-a");
                query.setString(2, upload.uploadId());
                query.setString(3, artifact.artifactId());
                try (var row = query.executeQuery()) {
                    assertThat(row.next()).isTrue();
                    assertThat(row.getString("policy_version")).isEqualTo("media-signature-consistency-v1");
                    assertThat(row.getString("state")).isEqualTo("SIGNATURE_MATCH");
                    assertThat(row.getString("detected_format")).isEqualTo("png");
                }
            }
        });
    }

    private static com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact upload(
            S3PostgresqlMediaArtifactStore store, byte[] bytes, String fileName) {
        var session = store.begin(new UploadRequest("tenant-a", "principal-a", fileName,
                "image/png", bytes.length, sha256(bytes), "RESTRICTED", Duration.ofDays(1), Map.of()), "begin-helper");
        store.append("tenant-a", "principal-a", session.uploadId(), 0, bytes);
        return store.complete("tenant-a", "principal-a", session.uploadId());
    }

    private static void withStore(StoreTest test) throws Exception {
        String bucket = "media-artifact-admission-" + UUID.randomUUID().toString().replace("-", "");
        try (S3Client admin = S3Client.builder()
                .endpointOverride(LOCALSTACK.getEndpoint())
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .build()) {
            admin.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            Map<String, String> environment = new LinkedHashMap<>();
            environment.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
            environment.put("MEDIA_POSTGRES_JDBC_URL", "jdbc:h2:mem:media_artifact_"
                    + UUID.randomUUID().toString().replace("-", "")
                    + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
            environment.put("MEDIA_POSTGRES_DRIVER", "org.h2.Driver");
            environment.put("MEDIA_S3_BUCKET", bucket);
            environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpoint().toString());
            environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
            environment.put("MEDIA_S3_PATH_STYLE", "true");
            environment.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
            environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:TEST_AWS_ACCESS_KEY");
            environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:TEST_AWS_SECRET_KEY");
            environment.put("TEST_AWS_ACCESS_KEY", LOCALSTACK.getAccessKey());
            environment.put("TEST_AWS_SECRET_KEY", LOCALSTACK.getSecretKey());
            try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
                 S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore()) {
                test.run(store, admin, bucket, environment);
            }
        }
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception failure) {
            throw new IllegalStateException(failure);
        }
    }

    private static long stagedReadFileCount() throws Exception {
        try (var files = Files.list(Path.of(System.getProperty("java.io.tmpdir")))) {
            return files.filter(path -> path.getFileName().toString().startsWith("media-artifact-read-"))
                    .count();
        }
    }

    @FunctionalInterface
    private interface StoreTest {
        void run(S3PostgresqlMediaArtifactStore store, S3Client admin, String bucket,
                Map<String, String> environment) throws Exception;
    }
}
