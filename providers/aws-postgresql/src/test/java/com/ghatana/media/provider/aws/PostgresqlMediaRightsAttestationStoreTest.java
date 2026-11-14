package com.ghatana.media.provider.aws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.runtime.MediaRightsConsentAuthority;
import com.ghatana.media.runtime.MediaRightsConsentAuthority.AttestRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.AttestationRecord;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ConfirmResult;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Confirmation;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RevokeResult;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Revocation;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaRightsConsentContracts.StatementKind;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import java.sql.DriverManager;
import java.time.Clock;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
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

/** PostgreSQL persistence of rights/consent attestations. Principals are clearly synthetic TEST principals. */
@Testcontainers(disabledWithoutDocker = true)
class PostgresqlMediaRightsAttestationStoreTest {
    @Container static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"));
    @Container static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices("s3");

    private static final String UPLOADER = "test-principal-uploader";
    private static final String REVIEWER = "test-principal-reviewer";
    private static final String DIGEST = "c".repeat(64);
    private static final String VERSION = "sha256:" + DIGEST;

    private static AuthenticatedPrincipal who(String tenant, String principal) {
        return new AuthenticatedPrincipal(tenant, principal, Instant.now());
    }

    private static AttestRequest delivery(String artifact) {
        return new AttestRequest(artifact, VERSION, DIGEST, StatementKind.MEDIA_RIGHTS,
                Set.of(Scope.PROCESSING, Scope.EXTERNAL_DELIVERY), "TEST basis for a synthetic fixture", "doc-artifact-1",
                null, Instant.now().plusSeconds(3600));
    }

    @Test
    void attestationsConfirmationsAndRevocationsSurviveStoreRecreationAndResolveFromDurableRecords() throws Exception {
        try (Fixture fixture = openFixture()) {
            String tenant = "tenant-" + UUID.randomUUID();
            String artifact = "artifact-" + UUID.randomUUID();
            String id;
            try (PostgresqlMediaRightsAttestationStore first = new PostgresqlMediaRightsAttestationStore()) {
                MediaRightsConsentAuthority authority = new MediaRightsConsentAuthority(first, Clock.systemUTC());
                AttestationRecord attested = authority.attest(who(tenant, UPLOADER), delivery(artifact));
                id = attested.attestation().attestationId();
                assertThat(authority.resolve(new ResolutionRequest(tenant, artifact, VERSION, DIGEST,
                        Scope.EXTERNAL_DELIVERY)).verdict()).isEqualTo(Verdict.DENIED);
            }
            try (PostgresqlMediaRightsAttestationStore restarted = new PostgresqlMediaRightsAttestationStore()) {
                MediaRightsConsentAuthority authority = new MediaRightsConsentAuthority(restarted, Clock.systemUTC());
                AttestationRecord read = authority.find(tenant, id).orElseThrow();
                assertThat(read.attestation().attestingPrincipalId()).isEqualTo(UPLOADER);
                assertThat(read.attestation().supportingDocumentArtifactRef()).isEqualTo("doc-artifact-1");
                assertThat(read.attestation().scopes()).containsExactlyInAnyOrder(Scope.PROCESSING, Scope.EXTERNAL_DELIVERY);
                assertThat(read.confirmation()).isNull();
                authority.confirm(who(tenant, REVIEWER), id, "TEST reviewer confirmation");
            }
            try (PostgresqlMediaRightsAttestationStore reopened = new PostgresqlMediaRightsAttestationStore()) {
                MediaRightsConsentAuthority authority = new MediaRightsConsentAuthority(reopened, Clock.systemUTC());
                AttestationRecord read = authority.find(tenant, id).orElseThrow();
                assertThat(read.confirmation().confirmingPrincipalId()).isEqualTo(REVIEWER);
                assertThat(authority.resolve(new ResolutionRequest(tenant, artifact, VERSION, DIGEST,
                        Scope.EXTERNAL_DELIVERY)).admitted()).isTrue();
                // Another tenant and another version never see or inherit it.
                assertThat(authority.resolve(new ResolutionRequest("tenant-other", artifact, VERSION, DIGEST,
                        Scope.EXTERNAL_DELIVERY)).verdict()).isEqualTo(Verdict.DENIED);
                String newer = "d".repeat(64);
                assertThat(authority.resolve(new ResolutionRequest(tenant, artifact, "sha256:" + newer, newer,
                        Scope.EXTERNAL_DELIVERY)).verdict()).isEqualTo(Verdict.STALE);
                authority.revoke(who(tenant, UPLOADER), id, "TEST: statement withdrawn");
            }
            try (PostgresqlMediaRightsAttestationStore finalRead = new PostgresqlMediaRightsAttestationStore()) {
                MediaRightsConsentAuthority authority = new MediaRightsConsentAuthority(finalRead, Clock.systemUTC());
                AttestationRecord read = authority.find(tenant, id).orElseThrow();
                assertThat(read.revocation().revokedByPrincipalId()).isEqualTo(UPLOADER);
                assertThat(read.revocation().reason()).isEqualTo("TEST: statement withdrawn");
                assertThat(authority.resolve(new ResolutionRequest(tenant, artifact, VERSION, DIGEST,
                        Scope.EXTERNAL_DELIVERY)).verdict()).isEqualTo(Verdict.REVOKED);
                assertThat(authority.listForVersion(tenant, artifact, VERSION)).hasSize(1);
            }
        }
    }

    @Test
    void schemaRefusesSelfConfirmationDuplicateEventsAndInconsistentVersionDigest() throws Exception {
        try (Fixture fixture = openFixture();
             PostgresqlMediaRightsAttestationStore store = new PostgresqlMediaRightsAttestationStore()) {
            String tenant = "tenant-" + UUID.randomUUID();
            String artifact = "artifact-" + UUID.randomUUID();
            MediaRightsConsentAuthority authority = new MediaRightsConsentAuthority(store, Clock.systemUTC());
            String id = authority.attest(who(tenant, UPLOADER), delivery(artifact)).attestation().attestationId();

            Confirmation self = new Confirmation(UPLOADER, Instant.now(), "self");
            assertThat(store.confirm(tenant, id, self)).isEqualTo(ConfirmResult.SELF_CONFIRMATION);
            assertThat(store.confirm(tenant, "missing", self)).isEqualTo(ConfirmResult.NOT_FOUND);
            // Direct SQL cannot bypass the second-person rule either.
            try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                    POSTGRES.getPassword());
                 var insert = connection.prepareStatement("""
                         INSERT INTO media_rights_attestation_events
                           (tenant_id,attestation_id,event_kind,principal_id,attesting_principal_id,occurred_at,detail)
                         VALUES (?,?,'CONFIRMED',?,?,CURRENT_TIMESTAMP,'')""")) {
                insert.setString(1, tenant); insert.setString(2, id);
                insert.setString(3, UPLOADER); insert.setString(4, UPLOADER);
                assertThatThrownBy(insert::executeUpdate).hasMessageContaining("media_rights_event_self_confirmation_check");
            }
            Confirmation other = new Confirmation(REVIEWER, Instant.now(), "ok");
            assertThat(store.confirm(tenant, id, other)).isEqualTo(ConfirmResult.CONFIRMED);
            assertThat(store.confirm(tenant, id, new Confirmation("test-principal-third", Instant.now(), ""))).isEqualTo(
                    ConfirmResult.ALREADY_CONFIRMED);
            assertThat(store.revoke(tenant, id, new Revocation(REVIEWER, Instant.now(), "TEST reason")))
                    .isEqualTo(RevokeResult.REVOKED);
            assertThat(store.revoke(tenant, id, new Revocation(UPLOADER, Instant.now(), "TEST again")))
                    .isEqualTo(RevokeResult.ALREADY_REVOKED);
            assertThat(store.revoke(tenant, "missing", new Revocation(UPLOADER, Instant.now(), "x")))
                    .isEqualTo(RevokeResult.NOT_FOUND);
            assertThatThrownBy(() -> store.append(store.find(tenant, id).orElseThrow().attestation()))
                    .isInstanceOf(IllegalStateException.class);
            try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                    POSTGRES.getPassword());
                 var bad = connection.prepareStatement("""
                         INSERT INTO media_rights_attestations
                           (tenant_id,attestation_id,artifact_id,artifact_version,content_sha256,attesting_principal_id,
                            attested_at,statement_kind,scopes_csv,basis)
                         VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,'MEDIA_RIGHTS','PROCESSING','basis')""")) {
                bad.setString(1, tenant); bad.setString(2, "bad-version");
                bad.setString(3, artifact); bad.setString(4, "sha256:" + "e".repeat(64));
                bad.setString(5, DIGEST); bad.setString(6, UPLOADER);
                assertThatThrownBy(bad::executeUpdate).hasMessageContaining("media_rights_attestation_version_digest_check");
            }
        }
    }

    @Test
    void concurrentConfirmationsRecordExactlyOneConfirmation() throws Exception {
        try (Fixture fixture = openFixture();
             PostgresqlMediaRightsAttestationStore left = new PostgresqlMediaRightsAttestationStore();
             PostgresqlMediaRightsAttestationStore right = new PostgresqlMediaRightsAttestationStore();
             ExecutorService workers = Executors.newFixedThreadPool(2)) {
            String tenant = "tenant-" + UUID.randomUUID();
            String artifact = "artifact-" + UUID.randomUUID();
            String id = new MediaRightsConsentAuthority(left, Clock.systemUTC())
                    .attest(who(tenant, UPLOADER), delivery(artifact)).attestation().attestationId();
            CountDownLatch ready = new CountDownLatch(2);
            CountDownLatch start = new CountDownLatch(1);
            AtomicInteger confirmed = new AtomicInteger();
            Future<?> a = workers.submit(() -> race(left, tenant, id, "test-principal-a", ready, start, confirmed));
            Future<?> b = workers.submit(() -> race(right, tenant, id, "test-principal-b", ready, start, confirmed));
            ready.await();
            start.countDown();
            a.get();
            b.get();
            assertThat(confirmed.get()).isEqualTo(1);
        }
    }

    private static void race(PostgresqlMediaRightsAttestationStore store, String tenant, String id, String principal,
                             CountDownLatch ready, CountDownLatch start, AtomicInteger confirmed) {
        try {
            ready.countDown();
            start.await();
            if (store.confirm(tenant, id, new Confirmation(principal, Instant.now(), "")) == ConfirmResult.CONFIRMED) {
                confirmed.incrementAndGet();
            }
        } catch (InterruptedException failure) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(failure);
        }
    }

    private static Fixture openFixture() throws Exception {
        String bucket = "media-rights-" + UUID.randomUUID().toString().replace("-", "");
        try (S3Client client = S3Client.builder().endpointOverride(LOCALSTACK.getEndpoint())
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment(bucket));
        MediaAwsPostgresqlRuntimeState keepAlive = MediaAwsPostgresqlRuntimeState.acquire();
        return new Fixture(installed, keepAlive);
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
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_RIGHTS_DB_PASSWORD");
        env.put("MEDIA_RIGHTS_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_S3_BUCKET", bucket);
        env.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        env.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpoint().toString());
        env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_RIGHTS_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_RIGHTS_SECRET");
        env.put("MEDIA_RIGHTS_ACCESS", LOCALSTACK.getAccessKey());
        env.put("MEDIA_RIGHTS_SECRET", LOCALSTACK.getSecretKey());
        return env;
    }
}
