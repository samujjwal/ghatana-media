package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.MediaConsentAuthority;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;

import java.sql.PreparedStatement;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

@Testcontainers(disabledWithoutDocker = true)
class PostgresqlMediaConsentAuthorityTest {
    @Container static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices("s3");

    @Test
    void futureDatedConsentIsNotActiveYet() throws Exception {
        try (Fixture fixture = openFixture()) {
            seed(fixture, "tenant-a", "consent-future", "principal-a",
                    Instant.now().plusSeconds(60).toEpochMilli(), null, null);

            var decision = fixture.authority().verify("tenant-a", "principal-a",
                    governance("consent-future"), "speech_to_text");

            assertThat(decision.verified()).isFalse();
        }
    }

    @Test
    void validConsentIsBoundToTenantAndPrincipalAndReturnsStoredScope() throws Exception {
        try (Fixture fixture = openFixture()) {
            seed(fixture, "tenant-a", "consent-valid", "principal-a",
                    Instant.now().minusSeconds(30).toEpochMilli(),
                    Instant.now().plusSeconds(300).toEpochMilli(), null);

            var allowed = fixture.authority().verify("tenant-a", "principal-a",
                    governance("consent-valid"), "speech_to_text");

            assertThat(allowed.verified()).isTrue();
            assertThat(allowed.authorityId()).isEqualTo("postgresql-media-consent");
            assertThat(allowed.consentId()).isEqualTo("consent-valid");
            assertThat(allowed.permitsPurpose("transcription")).isTrue();
            assertThat(allowed.permitsRegion("local")).isTrue();
            assertThat(allowed.externalProcessingAllowed()).isTrue();
            assertThat(allowed.biometricProcessingAllowed()).isFalse();
            assertThat(allowed.permitsProviderRetention(
                    com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention.NONE)).isTrue();

            assertThat(fixture.authority().verify("other-tenant", "principal-a",
                    governance("consent-valid"), "speech_to_text").verified()).isFalse();
            assertThat(fixture.authority().verify("tenant-a", "other-principal",
                    governance("consent-valid"), "speech_to_text").verified()).isFalse();
        }
    }

    @Test
    void expiredAndRevokedConsentAreUnverified() throws Exception {
        try (Fixture fixture = openFixture()) {
            long now = Instant.now().toEpochMilli();
            seed(fixture, "tenant-a", "consent-expired", "principal-a",
                    now - 60_000, now - 1, null);
            seed(fixture, "tenant-a", "consent-revoked", "principal-a",
                    now - 60_000, now + 60_000, now);

            assertThat(fixture.authority().verify("tenant-a", "principal-a",
                    governance("consent-expired"), "speech_to_text").verified()).isFalse();
            assertThat(fixture.authority().verify("tenant-a", "principal-a",
                    governance("consent-revoked"), "speech_to_text").verified()).isFalse();
            assertThat(fixture.authority().verify("tenant-a", "principal-a",
                    governance("missing-consent"), "speech_to_text").verified()).isFalse();
        }
    }

    private static MediaGovernanceContext governance(String consentId) {
        return new MediaGovernanceContext(consentId, "transcription", "local", java.util.Set.of("local"),
                true, false);
    }

    private static void seed(Fixture fixture, String tenant, String consentId, String principal,
            long grantedAt, Long expiresAt, Long revokedAt) throws Exception {
        try (var connection = fixture.state().connection();
             PreparedStatement statement = connection.prepareStatement("""
                     INSERT INTO media_consents
                       (tenant_id,consent_id,principal_id,purposes_csv,allowed_regions_csv,
                        external_processing_allowed,biometric_processing_allowed,granted_at,
                        expires_at,revoked_at,version)
                     VALUES (?,?,?,?,?,?,?,?,?,?,1)
                     """)) {
            statement.setString(1, tenant);
            statement.setString(2, consentId);
            statement.setString(3, principal);
            statement.setString(4, "transcription");
            statement.setString(5, "local");
            statement.setBoolean(6, true);
            statement.setBoolean(7, false);
            statement.setLong(8, grantedAt);
            if (expiresAt == null) statement.setNull(9, java.sql.Types.BIGINT);
            else statement.setLong(9, expiresAt);
            if (revokedAt == null) statement.setNull(10, java.sql.Types.BIGINT);
            else statement.setLong(10, revokedAt);
            statement.executeUpdate();
        }
    }

    private static Fixture openFixture() throws Exception {
        String bucket = "media-consent-test-" + java.util.UUID.randomUUID();
        try (S3Client client = S3Client.builder()
                .endpointOverride(LOCALSTACK.getEndpoint())
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .build()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "local");
        environment.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        environment.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        environment.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_TEST_DB_PASSWORD");
        environment.put("MEDIA_TEST_DB_PASSWORD", POSTGRES.getPassword());
        environment.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpoint().toString());
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_TEST_S3_ACCESS_KEY");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_TEST_S3_SECRET_KEY");
        environment.put("MEDIA_TEST_S3_ACCESS_KEY", LOCALSTACK.getAccessKey());
        environment.put("MEDIA_TEST_S3_SECRET_KEY", LOCALSTACK.getSecretKey());
        AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
        MediaConsentAuthority authority = null;
        MediaAwsPostgresqlRuntimeState state = null;
        try {
            authority = new PostgresqlMediaConsentAuthority();
            state = MediaAwsPostgresqlRuntimeState.acquire();
            return new Fixture(installed, authority, state);
        } catch (RuntimeException failure) {
            if (state != null) state.release();
            if (authority != null) authority.close();
            installed.close();
            throw failure;
        }
    }

    private record Fixture(AutoCloseable installed, MediaConsentAuthority authority,
            MediaAwsPostgresqlRuntimeState state) implements AutoCloseable {
        @Override public void close() throws Exception {
            try {
                authority.close();
            } finally {
                try {
                    state.release();
                } finally {
                    installed.close();
                }
            }
        }
    }
}
