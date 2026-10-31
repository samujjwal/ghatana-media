package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaTranscriptContracts.MediaTranscriptStore;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDraft;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevision;
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

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Contract-level coverage for successful-attempt append and durable scoped lineage readback. */
@Testcontainers(disabledWithoutDocker = true)
class PostgresqlMediaTranscriptAttemptBindingSpiTest {
    @Container static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices("s3");

    @Test
    void contractAppendReadsExactBindingAfterRestartAndFailsClosedForOtherIdentityOrRevision() throws Exception {
        String tenant = "tenant-spi", principal = "principal-spi", artifact = "source-spi", job = "job-spi";
        String transcript = "transcript-spi", consent = "consent-spi", digest = "a".repeat(64);
        String fingerprint = "b".repeat(64), transcriptVersion = "urn:media:transcript-version:spi-v1";
        String transcriptText = "synthetic candidate transcript";
        Fixture fixture = openFixture();
        String bucket = fixture.state().bucket();
        TranscriptRevision expectedRevision;
        com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptAttemptBinding expectedBinding;
        try {
            seed(fixture.state(), tenant, principal, artifact, job, consent, digest);
            String resultDigest = seedSuccessfulAttempt(fixture.state(), tenant, principal, artifact, job, digest, fingerprint,
                    transcriptVersion, transcriptText, "provider-op-spi", "provider-receipt-spi");
            expectedBinding = new com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptAttemptBinding(
                    job, 1, 73, "provider-a", "provider-op-spi", "provider-receipt-spi", fingerprint,
                    "sha256:" + digest, transcriptVersion, resultDigest);
            TranscriptDraft draft = draft(tenant, principal, transcript, artifact, job, consent, digest, transcriptText);
            MediaTranscriptStore contract = fixture.store();

            expectedRevision = contract.appendFromSuccessfulAttempt(draft, 0, 1, 73, fingerprint, transcriptVersion);
            assertThat(expectedRevision.revision()).isEqualTo(1);
            assertThat(expectedRevision.admissionStatus()).isEqualTo("CANDIDATE");
            assertThat(contract.readAttemptBinding(tenant, principal, transcript, 1)).isEqualTo(expectedBinding);
            assertThat(contract.appendFromSuccessfulAttempt(draft, 0, 1, 73, fingerprint, transcriptVersion))
                    .isEqualTo(expectedRevision);
            assertThat(contract.readAttemptBinding(tenant, principal, transcript, 1)).isEqualTo(expectedBinding);
            assertThatThrownBy(() -> contract.readAttemptBinding(tenant, "principal-other", transcript, 1))
                    .isInstanceOf(IllegalStateException.class);
            assertThatThrownBy(() -> contract.readAttemptBinding("tenant-other", principal, transcript, 1))
                    .isInstanceOf(IllegalStateException.class);
            assertThatThrownBy(() -> contract.readAttemptBinding(tenant, principal, transcript, 2))
                    .isInstanceOf(IllegalStateException.class);

            String unboundTranscript = "transcript-unbound-spi";
            TranscriptRevision legacyRevision = contract.append(draft(
                    tenant, principal, unboundTranscript, artifact, job, consent, digest, transcriptText));
            assertThat(legacyRevision.revision()).isEqualTo(1);
            assertThatThrownBy(() -> contract.readAttemptBinding(tenant, principal, unboundTranscript, 1))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("binding is unavailable");
        } finally {
            fixture.close();
        }

        AutoCloseable installation = MediaAwsPostgresqlRuntimeState.installForTesting(environment(bucket));
        try (installation; PostgresqlMediaTranscriptStore reopened = new PostgresqlMediaTranscriptStore()) {
            MediaTranscriptStore contract = reopened;
            assertThat(contract.revisions(tenant, principal, transcript)).containsExactly(expectedRevision);
            assertThat(contract.readAttemptBinding(tenant, principal, transcript, 1)).isEqualTo(expectedBinding);
            assertThat(contract.appendFromSuccessfulAttempt(
                    expectedRevision.draft(), 0, 1, 73, fingerprint, transcriptVersion)).isEqualTo(expectedRevision);

            MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
            String inconsistentDigest = "0".repeat(64).equals(expectedBinding.resultDigest())
                    ? "1".repeat(64) : "0".repeat(64);
            try (Connection connection = state.connection(); PreparedStatement corrupt = connection.prepareStatement(
                    "UPDATE media_transcript_attempt_bindings SET result_digest=? "
                            + "WHERE tenant_id=? AND transcript_id=? AND transcript_revision=1")) {
                corrupt.setString(1, inconsistentDigest);
                corrupt.setString(2, tenant);
                corrupt.setString(3, transcript);
                assertThat(corrupt.executeUpdate()).isEqualTo(1);
            } finally {
                state.release();
            }
            assertThatThrownBy(() -> contract.readAttemptBinding(tenant, principal, transcript, 1))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("binding is unavailable");
        }
    }

    private static Fixture openFixture() throws Exception {
        String bucket = "media-transcript-spi-" + UUID.randomUUID().toString().replace("-", "");
        try (S3Client client = S3Client.builder().endpointOverride(LOCALSTACK.getEndpoint())
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        AutoCloseable installation = MediaAwsPostgresqlRuntimeState.installForTesting(environment(bucket));
        PostgresqlMediaTranscriptStore store = null;
        MediaAwsPostgresqlRuntimeState state = null;
        try {
            store = new PostgresqlMediaTranscriptStore();
            state = MediaAwsPostgresqlRuntimeState.acquire();
            return new Fixture(installation, store, state);
        } catch (RuntimeException failure) {
            if (store != null) store.close();
            if (state != null) state.release();
            installation.close();
            throw failure;
        }
    }

    private record Fixture(AutoCloseable installation, PostgresqlMediaTranscriptStore store,
                           MediaAwsPostgresqlRuntimeState state) implements AutoCloseable {
        @Override public void close() throws Exception {
            try { store.close(); } finally {
                try { state.release(); } finally { installation.close(); }
            }
        }
    }

    private static void seed(MediaAwsPostgresqlRuntimeState state, String tenant, String principal,
            String artifact, String job, String consent, String digest) throws Exception {
        try (Connection c = state.connection()) {
            try (PreparedStatement s = c.prepareStatement("""
                    INSERT INTO media_artifacts
                      (tenant_id,artifact_id,principal_id,file_name,content_type,size_bytes,sha256,object_reference,
                       classification,created_at,expires_at,metadata_json,scan_status)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """)) {
                s.setString(1, tenant); s.setString(2, artifact); s.setString(3, principal);
                s.setString(4, "fixture.wav"); s.setString(5, "audio/wav"); s.setLong(6, 10);
                s.setString(7, digest); s.setString(8, "fixture"); s.setString(9, "CONFIDENTIAL");
                s.setLong(10, System.currentTimeMillis()); s.setLong(11, System.currentTimeMillis() + 60_000);
                s.setString(12, "{}"); s.setString(13, "CLEAN"); s.executeUpdate();
            }
            try (PreparedStatement s = c.prepareStatement("""
                    INSERT INTO media_processing_jobs
                      (tenant_id,job_id,request_id,principal_id,artifact_id,job_type,provider_id,status,created_at,
                       result_json,failure_code,version,expected_artifact_version)
                    VALUES (?,?,?,?,?,'SPEECH_TO_TEXT','provider-a','COMPLETED',?,'{}','',3,?)
                    """)) {
                s.setString(1, tenant); s.setString(2, job); s.setString(3, "request-" + job);
                s.setString(4, principal); s.setString(5, artifact); s.setLong(6, System.currentTimeMillis());
                s.setString(7, "sha256:" + digest); s.executeUpdate();
            }
            String snapshot = "{\"version\":\"media.stt-request-snapshot.v1\",\"customGlossaryRef\":null,\"fillerRetakeCandidates\":null}";
            try (PreparedStatement s = c.prepareStatement(
                    "UPDATE media_processing_jobs SET stt_request_snapshot=? WHERE tenant_id=? AND job_id=?")) {
                s.setString(1, snapshot); s.setString(2, tenant); s.setString(3, job); s.executeUpdate();
            }
            try (PreparedStatement s = c.prepareStatement("""
                    INSERT INTO media_consents
                      (tenant_id,consent_id,principal_id,purposes_csv,allowed_regions_csv,external_processing_allowed,
                       biometric_processing_allowed,granted_at,revoked_at,version)
                    VALUES (?,?,?,'transcription','local',false,false,?,NULL,1)
                    """)) {
                s.setString(1, tenant); s.setString(2, consent); s.setString(3, principal);
                s.setLong(4, System.currentTimeMillis()); s.executeUpdate();
            }
        }
    }

    private static String seedSuccessfulAttempt(MediaAwsPostgresqlRuntimeState state, String tenant, String principal,
            String artifact, String job, String digest, String fingerprint, String transcriptVersion,
            String transcriptText, String operation, String receipt) throws Exception {
        Map<String, Object> response = Map.of("sourceArtifactVersionRef", "sha256:" + digest,
                "requestFingerprint", fingerprint, "transcriptVersionRef", transcriptVersion,
                "glossaryDisposition", "NOT_REQUESTED", "transcriptText", transcriptText);
        Map<String, Object> observations = Map.of("requestFingerprint", fingerprint,
                "glossaryApplication", Map.of("disposition", "NOT_REQUESTED"), "transcriptResponse", response);
        String result = state.mapper().writeValueAsString(Map.of("semanticObservations", observations));
        String resultDigest = sha256(result);
        try (Connection c = state.connection()) {
            try (PreparedStatement s = c.prepareStatement(
                    "UPDATE media_processing_jobs SET request_fingerprint=? WHERE tenant_id=? AND job_id=?")) {
                s.setString(1, "sha256:" + fingerprint); s.setString(2, tenant); s.setString(3, job); s.executeUpdate();
            }
            try (PreparedStatement s = c.prepareStatement("""
                    INSERT INTO media_processing_attempts
                      (tenant_id,job_id,attempt_number,request_id,provider_id,request_fingerprint,lease_owner,
                       fencing_token,state,provider_operation_id,provider_receipt_id,result_json,result_digest,
                       provenance_json,observation_json,created_at,updated_at,observed_at)
                    VALUES (?,?,1,?,?,?,'fixture-worker',73,'SUCCEEDED',?,?,?,?,?,?,?, ?,?)
                    """)) {
                long now = System.currentTimeMillis();
                s.setString(1, tenant); s.setString(2, job); s.setString(3, "request-" + job);
                s.setString(4, "provider-a"); s.setString(5, fingerprint); s.setString(6, operation);
                s.setString(7, receipt); s.setString(8, result); s.setString(9, resultDigest);
                s.setString(10, "{}"); s.setString(11, "{}"); s.setLong(12, now); s.setLong(13, now); s.setLong(14, now);
                s.executeUpdate();
            }
        }
        return resultDigest;
    }

    private static TranscriptDraft draft(String tenant, String principal, String transcript, String artifact,
            String job, String consent, String digest, String text) {
        return new TranscriptDraft(tenant, principal, transcript, artifact, "sha256:" + digest, digest, job,
                "profile-candidate", "provider-a", "model-candidate", "en-US", "milliseconds", text,
                consent, "rights-candidate", "policy-candidate", "urn:media:purpose:transcription", "transcription");
    }

    private static String sha256(String value) throws Exception {
        return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8)));
    }

    private static Map<String, String> environment(String bucket) {
        Map<String, String> env = new HashMap<>();
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        env.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl()); env.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_TRANSCRIPT_DB_PASSWORD");
        env.put("MEDIA_TRANSCRIPT_DB_PASSWORD", POSTGRES.getPassword()); env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_S3_BUCKET", bucket); env.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        env.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpoint().toString()); env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_SECRET");
        env.put("MEDIA_ACCESS", LOCALSTACK.getAccessKey()); env.put("MEDIA_SECRET", LOCALSTACK.getSecretKey());
        return env;
    }
}
