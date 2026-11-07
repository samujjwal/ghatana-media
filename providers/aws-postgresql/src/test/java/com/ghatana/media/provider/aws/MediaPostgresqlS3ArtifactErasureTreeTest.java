package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactLineage;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactScanDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactScanVerdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifactScanner;
import com.ghatana.media.runtime.MediaRuntimeContracts.QuarantinedArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.ResponseInputStream;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.http.AbortableInputStream;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectRequest;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DriverManager;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** Test-only S3/PostgreSQL retention-authorized artifact erasure and legal-hold denial. */
@Testcontainers(disabledWithoutDocker = true)
class MediaPostgresqlS3ArtifactErasureTreeTest {
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    /** Isolate expired artifact rows because each test uses a different S3 bucket. */
    @BeforeEach
    void resetIsolatedRuntimeSchema() throws Exception {
        try (var connection = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.createStatement()) {
            statement.execute("DROP SCHEMA public CASCADE");
            statement.execute("CREATE SCHEMA public");
        }
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/media-runtime")
                .validateMigrationNaming(true)
                .load()
                .migrate();
    }

    @Test
    void rejectsEscapedS3PathBeforeTenantNamespaceResolution() {
        String tenant = "tenant-escaped-reference";
        String tenantHash = opaque(tenant);
        String ambiguous = "s3://media-ip06-escaped/prefix%2Fquarantine/finalized/"
                + tenantHash + "/upload/sha256";
        assertThatThrownBy(() -> MediaArtifactObjectOwnership.tenantOwnedArtifactKey(
                ambiguous, "media-ip06-escaped", "prefix/quarantine/finalized/",
                "prefix/quarantine/derived/", tenant, "artifact-escaped", "a".repeat(64)))
                .isInstanceOf(SecurityException.class)
                .hasMessageContaining("no object key");
    }

    @Test
    void expiryPurgesExactTenantArtifactTreeAndLegalHoldPreservesDeniedTree() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-ip06-erasure-" + runId;
        String prefix = "ip06-erasure/" + runId;
        String tenant = "tenant-ip06-erasure-" + runId;
        String otherTenant = "tenant-ip06-erasure-other-" + runId;
        String principal = "principal-ip06-erasure-" + runId;
        createBucket(bucket);

        Map<String, String> environment = environment(bucket, prefix);
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore();
             PostgresqlMediaPrivacyMaintenance maintenance = new PostgresqlMediaPrivacyMaintenance(environment);
             S3Client admin = s3Client()) {
            MediaArtifact source = complete(store, tenant, principal, "source.wav", "source:" + runId);
            MediaArtifact held = complete(store, tenant, principal, "held.wav", "held:" + runId);
            MediaArtifact aliasedSource = complete(store, tenant, principal, "aliased.wav", "aliased:" + runId);
            MediaArtifact otherTenantArtifact = complete(
                    store, otherTenant, principal, "other-tenant.wav", "other-tenant:" + runId);
            byte[] derivedBytes = ("derived:" + runId).getBytes(StandardCharsets.UTF_8);
            String derivedSha = sha256(derivedBytes);
            String derivedId = "derived-" + runId;
            String derivedKey = prefix + "/quarantine/derived/" + opaque(tenant) + "/"
                    + opaque(derivedId) + "/" + derivedSha;
            admin.putObject(PutObjectRequest.builder().bucket(bucket).key(derivedKey)
                    .contentLength((long) derivedBytes.length).build(), RequestBody.fromBytes(derivedBytes));
            insertDerivedArtifactAndLineage(bucket, tenant, principal, source, derivedId,
                    "job-" + runId, derivedKey, derivedBytes.length, derivedSha, false);
            String aliasId = "live-alias-" + runId;
            insertObjectReferenceArtifact(tenant, principal, aliasId,
                    aliasedSource.objectReference(), runId, false);

            MediaArtifact heldParent = complete(store, tenant, principal, "held-parent.wav", "held-parent:" + runId);
            String heldChildId = "held-child-" + runId;
            byte[] heldChildBytes = ("held-child:" + runId).getBytes(StandardCharsets.UTF_8);
            String heldChildSha = sha256(heldChildBytes);
            String heldChildKey = prefix + "/quarantine/derived/" + opaque(tenant) + "/"
                    + opaque(heldChildId) + "/" + heldChildSha;
            admin.putObject(PutObjectRequest.builder().bucket(bucket).key(heldChildKey)
                    .contentLength((long) heldChildBytes.length).build(), RequestBody.fromBytes(heldChildBytes));
            insertDerivedArtifactAndLineage(bucket, tenant, principal, heldParent, heldChildId,
                    "held-job-" + runId, heldChildKey, heldChildBytes.length, heldChildSha, true);

            String sourceKey = objectKey(source.objectReference());
            String heldKey = objectKey(held.objectReference());
            String aliasedSourceKey = objectKey(aliasedSource.objectReference());
            String otherTenantKey = objectKey(otherTenantArtifact.objectReference());
            expireArtifact(tenant, source.artifactId(), false);
            expireArtifact(tenant, held.artifactId(), true);
            expireArtifact(tenant, aliasedSource.artifactId(), false);
            expireArtifact(tenant, heldParent.artifactId(), false);

            assertObjectExists(admin, bucket, sourceKey);
            assertObjectExists(admin, bucket, derivedKey);
            assertObjectExists(admin, bucket, heldKey);
            assertObjectExists(admin, bucket, aliasedSourceKey);
            assertObjectExists(admin, bucket, objectKey(heldParent.objectReference()));
            assertObjectExists(admin, bucket, heldChildKey);
            assertObjectExists(admin, bucket, otherTenantKey);

            var report = maintenance.purgeExpired(Instant.now());

            // The expired source authorizes its unheld descendant tree: both blobs and rows go,
            // and the lineage foreign-key record is reconciled in the same metadata transaction.
            assertThat(report.artifactsDeleted()).isEqualTo(3);
            assertArtifactAbsent(tenant, source.artifactId());
            assertArtifactAbsent(tenant, derivedId);
            assertArtifactAbsent(tenant, aliasedSource.artifactId());
            assertThat(lineageCount(tenant, derivedId)).isZero();
            assertObjectAbsent(admin, bucket, sourceKey);
            assertObjectAbsent(admin, bucket, derivedKey);
            // Read-after-erasure must remain closed at the artifact-store boundary: stale
            // artifact/version coordinates cannot disclose bytes after the row and object are gone.
            ByteArrayOutputStream postErasureRead = new ByteArrayOutputStream();
            assertThat(store.copyContent(tenant, principal, source.artifactId(), source.version(),
                    postErasureRead, source.sizeBytes())).isEmpty();
            assertThat(postErasureRead.size()).as("erased content is never copied to the caller").isZero();
            assertArtifactPresent(tenant, aliasId);
            assertObjectExists(admin, bucket, aliasedSourceKey);

            // A legal hold denies the same expiry-driven effect; an unrelated tenant's live
            // artifact is outside this expired candidate set and remains readable.
            assertArtifactPresent(tenant, held.artifactId());
            assertArtifactPresent(tenant, heldParent.artifactId());
            assertArtifactPresent(tenant, heldChildId);
            assertArtifactPresent(otherTenant, otherTenantArtifact.artifactId());
            assertObjectExists(admin, bucket, heldKey);
            assertObjectExists(admin, bucket, objectKey(heldParent.objectReference()));
            assertObjectExists(admin, bucket, heldChildKey);
            assertThat(lineageCount(tenant, heldChildId)).as("held descendant blocks parent tree purge").isEqualTo(1);
            assertObjectExists(admin, bucket, otherTenantKey);

            String maliciousId = "foreign-reference-" + runId;
            insertForeignObjectReferenceArtifact(tenant, principal, maliciousId,
                    otherTenantArtifact.objectReference(), runId);
            assertThatThrownBy(() -> maintenance.purgeExpired(Instant.now()))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("tenant-owned namespace");
            assertArtifactPresent(tenant, maliciousId);
            assertObjectExists(admin, bucket, otherTenantKey);
            assertArtifactPresent(otherTenant, otherTenantArtifact.artifactId());
        } finally {
            deleteBucket(bucket);
        }
    }

    @Test
    void expiryWaitsForAnAlreadyStagedReadBeforeErasureCanCommit() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-ip06-read-fence-" + runId;
        String prefix = "ip06-read-fence/" + runId;
        String tenant = "tenant-ip06-read-fence-" + runId;
        String principal = "principal-ip06-read-fence-" + runId;
        createBucket(bucket);

        Map<String, String> environment = environment(bucket, prefix);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        CountDownLatch stagedBytesReady = new CountDownLatch(1);
        CountDownLatch allowPublication = new CountDownLatch(1);
        ByteArrayOutputStream delivered = new ByteArrayOutputStream();
        OutputStream blockingTarget = new OutputStream() {
            @Override public void write(int value) { delivered.write(value); }
            @Override public void write(byte[] bytes, int offset, int length) throws IOException {
                stagedBytesReady.countDown();
                try {
                    if (!allowPublication.await(15, TimeUnit.SECONDS)) {
                        throw new IOException("timed out waiting to publish verified fixture bytes");
                    }
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IOException("interrupted while holding fixture read publication", interrupted);
                }
                delivered.write(bytes, offset, length);
            }
        };
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore();
             PostgresqlMediaPrivacyMaintenance maintenance = new PostgresqlMediaPrivacyMaintenance(environment)) {
            MediaArtifact expired = complete(store, tenant, principal, "read-race.wav", "read-race:" + runId);

            Future<java.util.Optional<com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactContentReadReceipt>> read =
                    executor.submit(() -> store.copyContent(tenant, principal, expired.artifactId(), expired.version(),
                            blockingTarget, expired.sizeBytes()));
            assertThat(stagedBytesReady.await(15, TimeUnit.SECONDS))
                    .as("reader reached publication after staging and digest verification").isTrue();
            // Make it a purge candidate only after the read has resolved its live metadata and
            // staged its bytes, so the controlled race is specifically publication vs erasure.
            expireArtifact(tenant, expired.artifactId(), false);

            Future<com.ghatana.media.runtime.MediaPrivacyMaintenance.PurgeReport> purge =
                    executor.submit(() -> maintenance.purgeExpired(Instant.now()));
            // This observes the purge waiting on the same tenant mutation fence while the reader
            // is paused between verification and caller-visible publication.
            awaitAdvisoryWaiter(0x4d454449, tenant.hashCode());
            assertThat(purge.isDone()).as("erasure cannot commit while verified bytes are publishing").isFalse();

            allowPublication.countDown();
            assertThat(read.get(15, TimeUnit.SECONDS)).isPresent();
            assertThat(delivered.toByteArray()).hasSize((int) expired.sizeBytes());
            assertThat(purge.get(15, TimeUnit.SECONDS).artifactsDeleted()).isEqualTo(1);
            assertArtifactAbsent(tenant, expired.artifactId());
            assertThat(delivered.toByteArray()).hasSize((int) expired.sizeBytes());
        } finally {
            allowPublication.countDown();
            executor.shutdownNow();
            deleteBucket(bucket);
        }
    }

    @Test
    void lostDeleteAcknowledgementKeepsMetadataForIdempotentErasureRetry() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-ip06-erasure-lost-ack-" + runId;
        String prefix = "ip06-erasure-lost-ack/" + runId;
        String tenant = "tenant-ip06-erasure-lost-ack-" + runId;
        String principal = "principal-ip06-erasure-lost-ack-" + runId;
        createBucket(bucket);

        Map<String, String> environment = environment(bucket, prefix);
        AtomicBoolean loseFirstDeleteAck = new AtomicBoolean(true);
        AtomicReference<String> targetKey = new AtomicReference<>();
        AtomicReference<String> deletedKey = new AtomicReference<>();
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment,
                     delegate -> (S3Client) Proxy.newProxyInstance(S3Client.class.getClassLoader(),
                             new Class<?>[] {S3Client.class}, (proxy, method, arguments) -> {
                                 Object result;
                                 try {
                                     result = method.invoke(delegate, arguments);
                                 } catch (InvocationTargetException failure) {
                                     throw failure.getCause();
                                 }
                                 if ("deleteObject".equals(method.getName()) && arguments != null
                                         && arguments.length > 0 && arguments[0] instanceof DeleteObjectRequest request
                                         && bucket.equals(request.bucket())
                                         && request.key().equals(targetKey.get())
                                         && loseFirstDeleteAck.compareAndSet(true, false)) {
                                     deletedKey.set(request.key());
                                     throw software.amazon.awssdk.services.s3.model.S3Exception.builder()
                                             .statusCode(503).message("injected lost erasure delete acknowledgement")
                                             .build();
                                 }
                                 return result;
                             }));
             S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore();
             PostgresqlMediaPrivacyMaintenance maintenance = new PostgresqlMediaPrivacyMaintenance(environment);
             S3Client admin = s3Client()) {
            MediaArtifact expired = complete(store, tenant, principal, "expired.wav", "expired:" + runId);
            String objectKey = objectKey(expired.objectReference());
            targetKey.set(objectKey);
            expireArtifact(tenant, expired.artifactId(), false);
            assertObjectExists(admin, bucket, objectKey);

            assertThatThrownBy(() -> maintenance.purgeExpired(Instant.now()))
                    .isInstanceOf(software.amazon.awssdk.services.s3.model.S3Exception.class)
                    .hasMessageContaining("injected lost erasure delete acknowledgement");

            // S3 performed the delete, but its lost ACK forced the metadata transaction to roll
            // back. The artifact remains visible for retry while its bytes are already absent.
            assertThat(deletedKey.get()).isEqualTo(objectKey);
            assertObjectAbsent(admin, bucket, objectKey);
            assertArtifactPresent(tenant, expired.artifactId());

            var retry = maintenance.purgeExpired(Instant.now());
            assertThat(retry.artifactsDeleted()).isEqualTo(1);
            assertArtifactAbsent(tenant, expired.artifactId());
            assertObjectAbsent(admin, bucket, objectKey);
        } finally {
            deleteBucket(bucket);
        }
    }

    @Test
    void malformedUploadChunkKeyFailsClosedBeforeMetadataDeletion() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "m-ip06-bad-key-" + runId;
        String prefix = "ip06-erasure-bad-chunk-key/" + runId;
        String tenant = "tenant-ip06-erasure-bad-chunk-key-" + runId;
        String principal = "principal-ip06-erasure-bad-chunk-key-" + runId;
        createBucket(bucket);

        Map<String, String> environment = environment(bucket, prefix);
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore();
             PostgresqlMediaPrivacyMaintenance maintenance = new PostgresqlMediaPrivacyMaintenance(environment);
             S3Client admin = s3Client()) {
            byte[] bytes = wav(("unfinished-upload:" + runId).getBytes(StandardCharsets.UTF_8));
            var upload = store.begin(new UploadRequest(tenant, principal, "unfinished.wav", "audio/wav",
                    bytes.length, sha256(bytes), "RESTRICTED", Duration.ofDays(1), Map.of()), "bad-key-" + runId);
            store.append(tenant, principal, upload.uploadId(), 0, bytes);

            String originalKey;
            try (var connection = DriverManager.getConnection(
                         POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                 var query = connection.prepareStatement(
                         "SELECT object_key FROM media_upload_chunks WHERE tenant_id=? AND upload_id=?")) {
                query.setString(1, tenant);
                query.setString(2, upload.uploadId());
                try (var rows = query.executeQuery()) {
                    assertThat(rows.next()).isTrue();
                    originalKey = rows.getString(1);
                }
            }
            try (var connection = DriverManager.getConnection(
                         POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                 var corrupt = connection.prepareStatement(
                         "UPDATE media_upload_chunks SET object_key=' ' WHERE tenant_id=? AND upload_id=?")) {
                corrupt.setString(1, tenant);
                corrupt.setString(2, upload.uploadId());
                assertThat(corrupt.executeUpdate()).isEqualTo(1);
            }
            try (var connection = DriverManager.getConnection(
                         POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                 var expire = connection.prepareStatement(
                         "UPDATE media_upload_sessions SET expires_at=? WHERE tenant_id=? AND upload_id=?")) {
                expire.setLong(1, Instant.now().minusSeconds(60).toEpochMilli());
                expire.setString(2, tenant);
                expire.setString(3, upload.uploadId());
                assertThat(expire.executeUpdate()).isEqualTo(1);
            }

            assertThatThrownBy(() -> maintenance.purgeExpired(Instant.now()))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("Refusing to delete Media object without a valid object key");

            assertThat(store.upload(tenant, upload.uploadId())).isPresent();
            try (var connection = DriverManager.getConnection(
                         POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                 var count = connection.prepareStatement(
                         "SELECT COUNT(*) FROM media_upload_chunks WHERE tenant_id=? AND upload_id=?")) {
                count.setString(1, tenant);
                count.setString(2, upload.uploadId());
                try (var rows = count.executeQuery()) {
                    assertThat(rows.next()).isTrue();
                    assertThat(rows.getInt(1)).isEqualTo(1);
                }
            }
            assertObjectExists(admin, bucket, originalKey);
        } finally {
            deleteBucket(bucket);
        }
    }

    @Test
    void derivedRegistrationSerializesWithExpiryTreePurge() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-ip06-erasure-race-" + runId;
        String prefix = "ip06-erasure-race/" + runId;
        String tenant = "tenant-ip06-erasure-race-" + runId;
        String principal = "principal-ip06-erasure-race-" + runId;
        String jobId = "job-ip06-erasure-race-" + runId;
        int barrierNamespace = 0x49503036;
        int barrierKey = runId.hashCode();
        createBucket(bucket);
        Map<String, String> environment = environment(bucket, prefix);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        Connection barrierConnection = null;
        boolean triggerInstalled = false;
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore(cleanScanner());
             PostgresqlMediaPrivacyMaintenance maintenance = new PostgresqlMediaPrivacyMaintenance(environment);
             S3Client admin = s3Client()) {
            MediaArtifact source = complete(store, tenant, principal, "race-source.wav", "race-source:" + runId);
            expireArtifact(tenant, source.artifactId(), false);
            insertDerivedJobAndConsent(tenant, principal, source, jobId, "consent-" + runId, "derived-profile");

            byte[] childBytes = ("racing-derived:" + runId).getBytes(StandardCharsets.UTF_8);
            String childSha = sha256(childBytes);
            String childId = "racing-derived-" + runId;
            String childKey = prefix + "/quarantine/derived/" + opaque(tenant) + "/"
                    + opaque(childId) + "/" + childSha;
            admin.putObject(PutObjectRequest.builder().bucket(bucket).key(childKey)
                    .contentLength((long) childBytes.length).build(), RequestBody.fromBytes(childBytes));
            MediaArtifact child = new MediaArtifact(tenant, principal, childId, "derived.bin",
                    "application/octet-stream", childBytes.length, childSha, "s3://" + bucket + "/" + childKey,
                    "RESTRICTED", Instant.now(), Instant.now().plus(Duration.ofDays(30)), Map.of());
            ArtifactLineage lineage = new ArtifactLineage(tenant, source.artifactId(), source.version(),
                    jobId, "derived-profile", "consent-" + runId, "rights-" + runId, "policy-v1");

            installLineageInsertBarrier(barrierNamespace, barrierKey);
            triggerInstalled = true;
            barrierConnection = DriverManager.getConnection(
                    POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
            barrierConnection.setAutoCommit(false);
            acquireAdvisoryLock(barrierConnection, barrierNamespace, barrierKey);

            Future<MediaArtifact> registration = executor.submit(() -> store.registerDerived(child, lineage));
            awaitAdvisoryWaiter(barrierNamespace, barrierKey);

            Future<com.ghatana.media.runtime.MediaPrivacyMaintenance.PurgeReport> purge =
                    executor.submit(() -> maintenance.purgeExpired(Instant.now()));
            awaitAdvisoryWaiter(0x4d454449, tenant.hashCode());

            barrierConnection.commit();
            barrierConnection.close();
            barrierConnection = null;
            assertThat(registration.get(15, TimeUnit.SECONDS)).isEqualTo(child);
            var report = purge.get(15, TimeUnit.SECONDS);

            assertThat(report.artifactsDeleted()).isEqualTo(2);
            assertArtifactAbsent(tenant, source.artifactId());
            assertArtifactAbsent(tenant, childId);
            assertThat(lineageCount(tenant, childId)).isZero();
            assertObjectAbsent(admin, bucket, objectKey(source.objectReference()));
            assertObjectAbsent(admin, bucket, childKey);
        } finally {
            if (barrierConnection != null) {
                try { barrierConnection.rollback(); } catch (Exception ignored) { }
                try { barrierConnection.close(); } catch (Exception ignored) { }
            }
            executor.shutdownNow();
            if (triggerInstalled) dropLineageInsertBarrier();
            deleteBucket(bucket);
        }
    }

    @Test
    void purgeWinningRegistrationFailureCleansUnownedDerivedObject() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-ip06-purge-wins-" + runId;
        String prefix = "ip06-purge-wins/" + runId;
        String tenant = "tenant-ip06-purge-wins-" + runId;
        String principal = "principal-ip06-purge-wins-" + runId;
        String jobId = "job-ip06-purge-wins-" + runId;
        int barrierNamespace = 0x49503657;
        int barrierKey = runId.hashCode();
        createBucket(bucket);
        Map<String, String> environment = environment(bucket, prefix);
        AtomicInteger scannerCalls = new AtomicInteger();
        ExecutorService executor = Executors.newFixedThreadPool(2);
        Connection barrierConnection = null;
        boolean triggerInstalled = false;

        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore(cleanScanner(scannerCalls));
             PostgresqlMediaPrivacyMaintenance maintenance = new PostgresqlMediaPrivacyMaintenance(environment);
             S3Client admin = s3Client()) {
            MediaArtifact source = complete(store, tenant, principal, "purge-source.wav", "purge-source:" + runId);
            scannerCalls.set(0);
            expireArtifact(tenant, source.artifactId(), false);
            insertDerivedJobAndConsent(tenant, principal, source, jobId, "consent-" + runId, "derived-profile");

            byte[] childBytes = ("orphaned-derived:" + runId).getBytes(StandardCharsets.UTF_8);
            String childSha = sha256(childBytes);
            String childId = "orphaned-derived-" + runId;
            String childKey = prefix + "/quarantine/derived/" + opaque(tenant) + "/"
                    + opaque(childId) + "/" + childSha;
            admin.putObject(PutObjectRequest.builder().bucket(bucket).key(childKey)
                    .contentLength((long) childBytes.length).build(), RequestBody.fromBytes(childBytes));
            MediaArtifact child = new MediaArtifact(tenant, principal, childId, "derived.bin",
                    "application/octet-stream", childBytes.length, childSha, "s3://" + bucket + "/" + childKey,
                    "RESTRICTED", Instant.now(), Instant.now().plus(Duration.ofDays(30)), Map.of());
            ArtifactLineage lineage = new ArtifactLineage(tenant, source.artifactId(), source.version(),
                    jobId, "derived-profile", "consent-" + runId, "rights-" + runId, "policy-v1");

            installArtifactDeleteBarrier(barrierNamespace, barrierKey);
            triggerInstalled = true;
            barrierConnection = DriverManager.getConnection(
                    POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
            barrierConnection.setAutoCommit(false);
            acquireAdvisoryLock(barrierConnection, barrierNamespace, barrierKey);
            Future<com.ghatana.media.runtime.MediaPrivacyMaintenance.PurgeReport> purge =
                    executor.submit(() -> maintenance.purgeExpired(Instant.now()));
            // Observing the source bytes gone proves purge has passed its S3 delete while its
            // transaction is still held in the artifact-delete trigger. This is more stable
            // than inferring trigger entry from pg_locks, whose lock-row projection is brittle
            // across PostgreSQL/Testcontainers versions.
            awaitObjectAbsent(admin, bucket, objectKey(source.objectReference()), purge);
            CountDownLatch registrationEntered = new CountDownLatch(1);
            Future<MediaArtifact> registration = executor.submit(() -> {
                registrationEntered.countDown();
                return store.registerDerived(child, lineage);
            });
            assertThat(registrationEntered.await(10, TimeUnit.SECONDS))
                    .as("registration worker starts while purge holds the tenant lock").isTrue();
            assertThatThrownBy(() -> registration.get(200, TimeUnit.MILLISECONDS))
                    .as("registration remains fenced while purge holds the tenant transaction lock")
                    .isInstanceOf(java.util.concurrent.TimeoutException.class);
            barrierConnection.commit();
            barrierConnection.close();
            barrierConnection = null;
            var report = purge.get(15, TimeUnit.SECONDS);
            assertThat(report.artifactsDeleted()).isEqualTo(1);
            assertThatThrownBy(() -> registration.get(15, TimeUnit.SECONDS))
                    .isInstanceOf(ExecutionException.class)
                    .hasRootCauseInstanceOf(IllegalStateException.class)
                    .hasRootCauseMessage("Derived artifact source version is missing or stale");
            assertThat(scannerCalls).as("source revalidation fails before scan").hasValue(0);
            assertArtifactAbsent(tenant, source.artifactId());
            assertArtifactAbsent(tenant, childId);
            assertThat(lineageCount(tenant, childId)).isZero();
            assertObjectAbsent(admin, bucket, objectKey(source.objectReference()));
            assertObjectAbsent(admin, bucket, childKey);
        } finally {
            if (barrierConnection != null) {
                try { barrierConnection.rollback(); } catch (Exception ignored) { }
                try { barrierConnection.close(); } catch (Exception ignored) { }
            }
            executor.shutdownNow();
            if (triggerInstalled) dropArtifactDeleteBarrier();
            deleteBucket(bucket);
        }
    }

    @Test
    void derivedRegistrationStopsReadingObjectOnceDeclaredSizeIsExceeded() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-ip06-derived-size-" + runId;
        String prefix = "ip06-derived-size/" + runId;
        String tenant = "tenant-ip06-derived-size-" + runId;
        String principal = "principal-ip06-derived-size-" + runId;
        String jobId = "job-ip06-derived-size-" + runId;
        String consentId = "consent-" + runId;
        createBucket(bucket);
        Map<String, String> environment = environment(bucket, prefix);
        AtomicInteger scannerCalls = new AtomicInteger();
        AtomicInteger consumedObjectBytes = new AtomicInteger();
        AtomicReference<String> countedObjectKey = new AtomicReference<>();

        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment,
                     delegate -> countObjectBodyBytes(delegate, bucket, countedObjectKey, consumedObjectBytes));
             S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore(cleanScanner(scannerCalls));
             S3Client admin = s3Client()) {
            MediaArtifact source = complete(store, tenant, principal, "size-source.wav", "size-source:" + runId);
            scannerCalls.set(0);
            insertDerivedJobAndConsent(tenant, principal, source, jobId, consentId, "derived-profile");

            byte[] declaredBytes = ("declared-derived:" + runId).getBytes(StandardCharsets.UTF_8);
            byte[] oversizedBytes = new byte[declaredBytes.length + 4 * 1024 * 1024];
            System.arraycopy(declaredBytes, 0, oversizedBytes, 0, declaredBytes.length);
            String digest = sha256(declaredBytes);
            String derivedId = "oversized-derived-" + runId;
            String key = prefix + "/quarantine/derived/" + opaque(tenant) + "/"
                    + opaque(derivedId) + "/" + digest;
            countedObjectKey.set(key);
            admin.putObject(PutObjectRequest.builder().bucket(bucket).key(key)
                    .contentLength((long) oversizedBytes.length).build(), RequestBody.fromBytes(oversizedBytes));
            MediaArtifact derived = new MediaArtifact(tenant, principal, derivedId, "derived.bin",
                    "application/octet-stream", declaredBytes.length, digest, "s3://" + bucket + "/" + key,
                    "RESTRICTED", Instant.now(), Instant.now().plus(Duration.ofDays(30)), Map.of());
            ArtifactLineage lineage = new ArtifactLineage(tenant, source.artifactId(), source.version(),
                    jobId, "derived-profile", consentId, "rights-" + runId, "policy-v1");

            assertThatThrownBy(() -> store.registerDerived(derived, lineage))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("exceed the declared immutable version size");
            assertThat(consumedObjectBytes).as("verification consumes at most one excess byte")
                    .hasValue(declaredBytes.length + 1);
            assertThat(scannerCalls).as("oversized bytes are rejected before content scanning").hasValue(0);
            assertThat(artifactExists(tenant, derivedId)).isFalse();
            assertThat(lineageCount(tenant, derivedId)).isZero();
            assertObjectAbsent(admin, bucket, key);
        } finally {
            deleteBucket(bucket);
        }
    }

    @Test
    void derivedRegistrationRejectsReferencedAndMismatchedIdentityKeysWithoutDeletingBytes() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-ip06-derived-alias-" + runId;
        String prefix = "ip06-derived-alias/" + runId;
        String tenant = "tenant-ip06-derived-alias-" + runId;
        String principal = "principal-ip06-derived-alias-" + runId;
        String jobId = "job-ip06-derived-alias-" + runId;
        String consentId = "consent-" + runId;
        createBucket(bucket);
        Map<String, String> environment = environment(bucket, prefix);
        AtomicInteger scannerCalls = new AtomicInteger();

        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore(cleanScanner(scannerCalls));
             S3Client admin = s3Client()) {
            MediaArtifact source = complete(store, tenant, principal, "alias-source.wav", "alias-source:" + runId);
            scannerCalls.set(0);
            insertDerivedJobAndConsent(tenant, principal, source, jobId, consentId, "derived-profile");

            byte[] bytes = ("registered-derived:" + runId).getBytes(StandardCharsets.UTF_8);
            String digest = sha256(bytes);
            String derivedId = "registered-derived-" + runId;
            String key = prefix + "/quarantine/derived/" + opaque(tenant) + "/"
                    + opaque(derivedId) + "/" + digest;
            admin.putObject(PutObjectRequest.builder().bucket(bucket).key(key)
                    .contentLength((long) bytes.length).build(), RequestBody.fromBytes(bytes));
            MediaArtifact alreadyRegistered = new MediaArtifact(tenant, principal, derivedId, "derived.bin",
                    "application/octet-stream", bytes.length, digest, "s3://" + bucket + "/" + key,
                    "RESTRICTED", Instant.now(), Instant.now().plus(Duration.ofDays(30)), Map.of());
            insertDerivedArtifactAndLineage(bucket, tenant, principal, source, derivedId, jobId,
                    key, bytes.length, digest, false);
            ArtifactLineage lineage = new ArtifactLineage(tenant, source.artifactId(), source.version(),
                    jobId, "derived-profile", consentId, "rights-" + runId, "policy-v1");

            assertThatThrownBy(() -> store.registerDerived(alreadyRegistered, lineage))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("already referenced by an artifact");
            assertThat(store.artifact(tenant, derivedId)).isPresent();
            assertThat(admin.getObjectAsBytes(GetObjectRequest.builder().bucket(bucket).key(key).build())
                    .asByteArray()).containsExactly(bytes);

            byte[] aliasedBytes = ("different-digest:" + runId).getBytes(StandardCharsets.UTF_8);
            MediaArtifact identityAlias = new MediaArtifact(tenant, principal, "different-derived-" + runId,
                    "alias.bin", "application/octet-stream", aliasedBytes.length, sha256(aliasedBytes),
                    "s3://" + bucket + "/" + key, "RESTRICTED",
                    Instant.now(), Instant.now().plus(Duration.ofDays(30)), Map.of());
            assertThatThrownBy(() -> store.registerDerived(identityAlias, lineage))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("tenant, artifact, and version namespace");
            assertThat(scannerCalls).hasValue(0);
            assertThat(store.artifact(tenant, derivedId)).isPresent();
            assertThat(admin.getObjectAsBytes(GetObjectRequest.builder().bucket(bucket).key(key).build())
                    .asByteArray()).containsExactly(bytes);
        } finally {
            deleteBucket(bucket);
        }
    }

    private static MediaArtifact complete(S3PostgresqlMediaArtifactStore store, String tenant,
            String principal, String name, String payload) {
        byte[] bytes = wav(payload.getBytes(StandardCharsets.UTF_8));
        UploadRequest request = new UploadRequest(tenant, principal, name, "audio/wav", bytes.length,
                sha256(bytes), "RESTRICTED", Duration.ofDays(30), Map.of());
        var upload = store.begin(request, "ip06-erasure-" + UUID.randomUUID());
        store.append(tenant, principal, upload.uploadId(), 0, bytes);
        return store.complete(tenant, principal, upload.uploadId());
    }

    private static void insertDerivedArtifactAndLineage(String bucket, String tenant, String principal, MediaArtifact source,
            String derivedId, String jobId, String key, long size, String digest, boolean legalHold) throws Exception {
        long now = Instant.now().toEpochMilli();
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword())) {
            connection.setAutoCommit(false);
            try (var job = connection.prepareStatement(
                    "INSERT INTO media_processing_jobs (tenant_id,job_id,request_id,artifact_id,job_type,"
                            + "provider_id,status,created_at,result_json,failure_code,version) "
                            + "VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (tenant_id,job_id) DO NOTHING")) {
                job.setString(1, tenant); job.setString(2, jobId); job.setString(3, "request-" + jobId);
                job.setString(4, source.artifactId()); job.setString(5, "DERIVATION");
                job.setString(6, "test-profile"); job.setString(7, "COMPLETED"); job.setLong(8, now);
                job.setString(9, "{}"); job.setString(10, ""); job.setLong(11, 1L);
                job.executeUpdate();
            }
            try (var artifact = connection.prepareStatement(
                    "INSERT INTO media_artifacts (tenant_id,artifact_id,principal_id,file_name,content_type,"
                            + "size_bytes,sha256,object_reference,classification,created_at,expires_at,metadata_json,"
                            + "scan_status,legal_hold) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")) {
                artifact.setString(1, tenant); artifact.setString(2, derivedId); artifact.setString(3, principal);
                artifact.setString(4, "derived.bin"); artifact.setString(5, "application/octet-stream");
                artifact.setLong(6, size); artifact.setString(7, digest);
                artifact.setString(8, "s3://" + bucket + "/" + key);
                artifact.setString(9, "RESTRICTED"); artifact.setLong(10, now);
                artifact.setLong(11, now + Duration.ofDays(30).toMillis()); artifact.setString(12, "{}");
                artifact.setString(13, "CLEAN"); artifact.setBoolean(14, legalHold); artifact.executeUpdate();
            }
            try (var lineage = connection.prepareStatement(
                    "INSERT INTO media_artifact_lineage (tenant_id,derived_artifact_id,derived_version,"
                            + "source_artifact_id,source_version,job_id,processing_profile,rights_decision_id,"
                            + "consent_decision_id,policy_version,admission_status,created_at) "
                            + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")) {
                lineage.setString(1, tenant); lineage.setString(2, derivedId); lineage.setString(3, "sha256:" + digest);
                lineage.setString(4, source.artifactId()); lineage.setString(5, source.version().value());
                lineage.setString(6, jobId); lineage.setString(7, "test-profile");
                lineage.setString(8, "test-rights"); lineage.setString(9, "test-consent");
                lineage.setString(10, "test-policy-v1"); lineage.setString(11, "CANDIDATE");
                lineage.setLong(12, now); lineage.executeUpdate();
            }
            connection.commit();
        }
    }

    private static void insertDerivedJobAndConsent(String tenant, String principal, MediaArtifact source,
            String jobId, String consentId, String profileId) throws Exception {
        long now = Instant.now().toEpochMilli();
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword())) {
            try (var job = connection.prepareStatement(
                    "INSERT INTO media_processing_jobs (tenant_id,job_id,request_id,principal_id,artifact_id,"
                            + "job_type,provider_id,status,created_at,result_json,failure_code,version,"
                            + "expected_artifact_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")) {
                job.setString(1, tenant); job.setString(2, jobId); job.setString(3, "request-" + jobId);
                job.setString(4, principal); job.setString(5, source.artifactId());
                job.setString(6, "DERIVATION"); job.setString(7, profileId); job.setString(8, "RUNNING");
                job.setLong(9, now); job.setString(10, "{}"); job.setString(11, ""); job.setLong(12, 1L);
                job.setString(13, source.version().value()); job.executeUpdate();
            }
            try (var consent = connection.prepareStatement(
                    "INSERT INTO media_consents (tenant_id,consent_id,principal_id,purposes_csv,allowed_regions_csv,"
                            + "external_processing_allowed,biometric_processing_allowed,granted_at,version) "
                            + "VALUES (?,?,?,?,?,?,?,?,?)")) {
                consent.setString(1, tenant); consent.setString(2, consentId); consent.setString(3, principal);
                consent.setString(4, "DERIVATION"); consent.setString(5, "local"); consent.setBoolean(6, false);
                consent.setBoolean(7, false); consent.setLong(8, now); consent.setLong(9, 1L); consent.executeUpdate();
            }
        }
    }

    private static void installLineageInsertBarrier(int firstKey, int secondKey) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()); var statement = connection.createStatement()) {
            statement.execute("CREATE FUNCTION ip06_wait_lineage_insert() RETURNS trigger LANGUAGE plpgsql AS $$ "
                    + "BEGIN PERFORM pg_advisory_xact_lock(" + firstKey + "," + secondKey + "); RETURN NEW; END; $$");
            statement.execute("CREATE TRIGGER ip06_wait_lineage_insert BEFORE INSERT ON media_artifact_lineage "
                    + "FOR EACH ROW EXECUTE FUNCTION ip06_wait_lineage_insert()");
        }
    }

    private static void dropLineageInsertBarrier() throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()); var statement = connection.createStatement()) {
            statement.execute("DROP TRIGGER IF EXISTS ip06_wait_lineage_insert ON media_artifact_lineage");
            statement.execute("DROP FUNCTION IF EXISTS ip06_wait_lineage_insert()");
        }
    }

    private static void installArtifactDeleteBarrier(int firstKey, int secondKey) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()); var statement = connection.createStatement()) {
            statement.execute("CREATE FUNCTION ip06_wait_artifact_delete() RETURNS trigger LANGUAGE plpgsql AS $$ "
                    + "BEGIN PERFORM pg_advisory_xact_lock(" + firstKey + "," + secondKey + "); RETURN OLD; END; $$");
            statement.execute("CREATE TRIGGER ip06_wait_artifact_delete BEFORE DELETE ON media_artifacts "
                    + "FOR EACH ROW EXECUTE FUNCTION ip06_wait_artifact_delete()");
        }
    }

    private static void dropArtifactDeleteBarrier() throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()); var statement = connection.createStatement()) {
            statement.execute("DROP TRIGGER IF EXISTS ip06_wait_artifact_delete ON media_artifacts");
            statement.execute("DROP FUNCTION IF EXISTS ip06_wait_artifact_delete()");
        }
    }

    private static void acquireAdvisoryLock(Connection connection, int firstKey, int secondKey) throws Exception {
        try (var lock = connection.prepareStatement("SELECT pg_advisory_xact_lock(?,?)")) {
            lock.setInt(1, firstKey); lock.setInt(2, secondKey); lock.execute();
        }
    }

    private static void awaitAdvisoryWaiter(int firstKey, int secondKey) throws Exception {
        awaitAdvisoryWaiters(firstKey, secondKey, 1);
    }

    private static void awaitObjectAbsent(
            S3Client s3, String bucket, String key,
            Future<com.ghatana.media.runtime.MediaPrivacyMaintenance.PurgeReport> purge) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            try {
                s3.headObject(HeadObjectRequest.builder().bucket(bucket).key(key).build());
            } catch (software.amazon.awssdk.services.s3.model.NoSuchKeyException deleted) {
                return;
            }
            if (purge.isDone()) {
                var report = purge.get();
                throw new AssertionError("purge completed before source-byte deletion; artifacts deleted: "
                        + report.artifactsDeleted());
            }
            Thread.sleep(20);
        }
        throw new AssertionError("purge did not delete source bytes before the test barrier");
    }

    private static void awaitAdvisoryWaiters(int firstKey, int secondKey, int expectedWaiters) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                    POSTGRES.getUsername(), POSTGRES.getPassword());
                 var query = connection.prepareStatement(
                         "SELECT COUNT(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted "
                                 + "AND classid=? AND objid=? AND objsubid=2")) {
                query.setLong(1, Integer.toUnsignedLong(firstKey));
                query.setLong(2, Integer.toUnsignedLong(secondKey));
                try (var rows = query.executeQuery()) {
                    rows.next();
                    if (rows.getInt(1) >= expectedWaiters) return;
                }
            }
            Thread.sleep(20);
        }
        throw new AssertionError("expected " + expectedWaiters + " PostgreSQL advisory-lock waiter(s) were not observed");
    }

    private static MediaArtifactScanner cleanScanner() {
        return cleanScanner(null);
    }

    private static MediaArtifactScanner cleanScanner(AtomicInteger scans) {
        return new MediaArtifactScanner() {
            @Override public String scannerId() { return "ip06-erasure-test-clean"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }

            @Override
            public ArtifactScanDecision scan(QuarantinedArtifact artifact) {
                if (scans != null) scans.incrementAndGet();
                Instant now = Instant.now();
                return new ArtifactScanDecision(scannerId(), "test-v1", "ip06-erasure-test", "v1",
                        artifact.tenantId(), artifact.principalId(), artifact.uploadId(), artifact.sha256(),
                        artifact.sizeBytes(), artifact.contentType(), ArtifactScanVerdict.CLEAN,
                        now, now.plusSeconds(60));
            }
        };
    }

    private static void expireArtifact(String tenant, String artifactId, boolean legalHold) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword());
             var update = connection.prepareStatement(
                     "UPDATE media_artifacts SET expires_at=?,legal_hold=? WHERE tenant_id=? AND artifact_id=?")) {
            update.setLong(1, Instant.now().minusSeconds(60).toEpochMilli());
            update.setBoolean(2, legalHold); update.setString(3, tenant); update.setString(4, artifactId);
            assertThat(update.executeUpdate()).isEqualTo(1);
        }
    }

    private static int lineageCount(String tenant, String derivedId) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword());
             var query = connection.prepareStatement(
                     "SELECT COUNT(*) FROM media_artifact_lineage WHERE tenant_id=? AND derived_artifact_id=?")) {
            query.setString(1, tenant); query.setString(2, derivedId);
            try (var rows = query.executeQuery()) { rows.next(); return rows.getInt(1); }
        }
    }

    private static void assertArtifactAbsent(String tenant, String artifactId) throws Exception {
        assertThat(artifactExists(tenant, artifactId)).isFalse();
    }

    private static void assertArtifactPresent(String tenant, String artifactId) throws Exception {
        assertThat(artifactExists(tenant, artifactId)).isTrue();
    }

    private static boolean artifactExists(String tenant, String artifactId) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword());
             var query = connection.prepareStatement(
                     "SELECT 1 FROM media_artifacts WHERE tenant_id=? AND artifact_id=?")) {
            query.setString(1, tenant); query.setString(2, artifactId);
            try (var rows = query.executeQuery()) { return rows.next(); }
        }
    }

    private static void insertForeignObjectReferenceArtifact(
            String tenant, String principal, String artifactId,
            String foreignObjectReference, String runId) throws Exception {
        insertObjectReferenceArtifact(tenant, principal, artifactId, foreignObjectReference, runId, true);
    }

    private static void insertObjectReferenceArtifact(
            String tenant, String principal, String artifactId,
            String objectReference, String runId, boolean expired) throws Exception {
        long now = Instant.now().toEpochMilli();
        byte[] marker = ("foreign-reference-row:" + artifactId + ":" + runId).getBytes(StandardCharsets.UTF_8);
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword());
             var insert = connection.prepareStatement(
                     "INSERT INTO media_artifacts (tenant_id,artifact_id,principal_id,file_name,content_type,"
                             + "size_bytes,sha256,object_reference,classification,created_at,expires_at,metadata_json,"
                             + "scan_status,legal_hold) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,FALSE)")) {
            insert.setString(1, tenant); insert.setString(2, artifactId); insert.setString(3, principal);
            insert.setString(4, "foreign-reference.bin"); insert.setString(5, "application/octet-stream");
            insert.setLong(6, marker.length); insert.setString(7, sha256(marker));
            insert.setString(8, objectReference); insert.setString(9, "RESTRICTED");
            insert.setLong(10, now); insert.setLong(11, expired
                    ? now - Duration.ofSeconds(1).toMillis() : now + Duration.ofDays(30).toMillis());
            insert.setString(12, "{}"); insert.setString(13, "CLEAN"); insert.executeUpdate();
        }
    }

    private static Map<String, String> environment(String bucket, String prefix) {
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        environment.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        environment.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        environment.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_IP06_ERASURE_DB_PASSWORD");
        environment.put("MEDIA_IP06_ERASURE_DB_PASSWORD", POSTGRES.getPassword());
        environment.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        environment.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_PREFIX", prefix);
        environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_IP06_ERASURE_S3_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_IP06_ERASURE_S3_SECRET");
        environment.put("MEDIA_IP06_ERASURE_S3_ACCESS", LOCALSTACK.getAccessKey());
        environment.put("MEDIA_IP06_ERASURE_S3_SECRET", LOCALSTACK.getSecretKey());
        return environment;
    }

    private static S3Client s3Client() {
        return S3Client.builder().endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build();
    }

    private static S3Client countObjectBodyBytes(
            S3Client delegate, String bucket, AtomicReference<String> targetKey, AtomicInteger consumedBytes) {
        return (S3Client) Proxy.newProxyInstance(S3Client.class.getClassLoader(), new Class<?>[] {S3Client.class},
                (proxy, method, arguments) -> {
                    Object result;
                    try {
                        result = method.invoke(delegate, arguments);
                    } catch (InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                    if ("getObject".equals(method.getName()) && arguments != null && arguments.length > 0
                            && arguments[0] instanceof GetObjectRequest request
                            && bucket.equals(request.bucket()) && request.key().equals(targetKey.get())
                            && result instanceof ResponseInputStream<?> response) {
                        @SuppressWarnings("unchecked")
                        ResponseInputStream<software.amazon.awssdk.services.s3.model.GetObjectResponse> object =
                                (ResponseInputStream<software.amazon.awssdk.services.s3.model.GetObjectResponse>) response;
                        InputStream countedBody = new FilterInputStream(object) {
                            @Override
                            public int read() throws IOException {
                                int value = super.read();
                                if (value >= 0) consumedBytes.incrementAndGet();
                                return value;
                            }

                            @Override
                            public int read(byte[] bytes, int offset, int length) throws IOException {
                                int count = super.read(bytes, offset, length);
                                if (count > 0) consumedBytes.addAndGet(count);
                                return count;
                            }
                        };
                        return new ResponseInputStream<>(object.response(),
                                AbortableInputStream.create(countedBody, object::abort));
                    }
                    return result;
                });
    }

    private static void createBucket(String bucket) {
        try (S3Client s3 = s3Client()) {
            s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
    }

    private static void assertObjectExists(S3Client s3, String bucket, String key) {
        s3.headObject(HeadObjectRequest.builder().bucket(bucket).key(key).build());
    }

    private static void assertObjectAbsent(S3Client s3, String bucket, String key) {
        assertThatThrownBy(() -> s3.headObject(HeadObjectRequest.builder().bucket(bucket).key(key).build()))
                .isInstanceOf(software.amazon.awssdk.services.s3.model.NoSuchKeyException.class);
    }

    private static void deleteBucket(String bucket) {
        try (S3Client s3 = s3Client()) {
            for (var object : s3.listObjectsV2(b -> b.bucket(bucket)).contents()) {
                s3.deleteObject(DeleteObjectRequest.builder().bucket(bucket).key(object.key()).build());
            }
            s3.deleteBucket(b -> b.bucket(bucket));
        } catch (RuntimeException ignored) {
            // Disposable Testcontainers are the cleanup boundary if LocalStack has already stopped.
        }
    }

    private static String objectKey(String reference) {
        return java.net.URI.create(reference).getPath().substring(1);
    }

    private static String sha256(byte[] bytes) {
        try {
            return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static String opaque(String value) {
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
}
