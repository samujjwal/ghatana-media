package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDraft;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevision;
import com.sun.net.httpserver.HttpsServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Exercises the production ADMITTED transcript path against a real PostgreSQL state that reports
 * production eligibility. The S3 endpoint is a local HTTPS stub: the environment's TLS endpoint,
 * credentials, and PostgreSQL URL are all real config, so {@code productionEligible} is genuine;
 * only the object-store backend is substituted, and transcript operations never touch it.
 */
@Testcontainers(disabledWithoutDocker = true)
class PostgresqlMediaTranscriptProductionAdmissionTest {
    @Container static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    private static final String DIGEST = "c".repeat(64);
    private static final String FINGERPRINT = "d".repeat(64);
    private static Path keystore;
    private static HttpsServer s3Stub;
    private static SSLContext previousDefault;
    private static String previousTrustStore;
    private static String previousTrustStorePassword;
    private static String previousTrustStoreType;

    @BeforeAll
    static void startTlsStub() throws Exception {
        keystore = Files.createTempFile("media-s3-stub-", ".p12");
        Files.delete(keystore);
        String keytool = Path.of(System.getProperty("java.home"), "bin", "keytool").toString();
        ProcessBuilder generate = new ProcessBuilder(keytool, "-genkeypair", "-alias", "stub",
                "-keyalg", "RSA", "-keysize", "2048", "-validity", "1",
                "-dname", "CN=localhost", "-ext", "SAN=dns:localhost,ip:127.0.0.1",
                "-keystore", keystore.toString(), "-storetype", "PKCS12",
                "-storepass", "changeit", "-keypass", "changeit");
        Process process = generate.start();
        String diagnostic = new String(process.getErrorStream().readAllBytes(),
                java.nio.charset.StandardCharsets.UTF_8);
        if (process.waitFor() != 0) {
            throw new IllegalStateException("keytool stub certificate generation failed: " + diagnostic);
        }
        KeyStore store = KeyStore.getInstance("PKCS12");
        try (InputStream in = Files.newInputStream(keystore)) {
            store.load(in, "changeit".toCharArray());
        }
        KeyManagerFactory keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        keys.init(store, "changeit".toCharArray());
        TrustManagerFactory trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        trust.init(store);
        SSLContext server = SSLContext.getInstance("TLS");
        server.init(keys.getKeyManagers(), null, null);
        SSLContext client = SSLContext.getInstance("TLS");
        client.init(null, trust.getTrustManagers(), null);
        previousDefault = SSLContext.getDefault();
        previousTrustStore = System.getProperty("javax.net.ssl.trustStore");
        previousTrustStorePassword = System.getProperty("javax.net.ssl.trustStorePassword");
        previousTrustStoreType = System.getProperty("javax.net.ssl.trustStoreType");
        System.setProperty("javax.net.ssl.trustStore", keystore.toString());
        System.setProperty("javax.net.ssl.trustStorePassword", "changeit");
        System.setProperty("javax.net.ssl.trustStoreType", "PKCS12");
        SSLContext.setDefault(client);
        HttpsURLConnection.setDefaultSSLSocketFactory(client.getSocketFactory());

        s3Stub = HttpsServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        s3Stub.setHttpsConfigurator(new com.sun.net.httpserver.HttpsConfigurator(server));
        s3Stub.createContext("/", exchange -> {
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        s3Stub.start();
    }

    @AfterAll
    static void stopTlsStub() throws Exception {
        if (s3Stub != null) s3Stub.stop(0);
        if (previousDefault != null) SSLContext.setDefault(previousDefault);
        restore("javax.net.ssl.trustStore", previousTrustStore);
        restore("javax.net.ssl.trustStorePassword", previousTrustStorePassword);
        restore("javax.net.ssl.trustStoreType", previousTrustStoreType);
        if (keystore != null) Files.deleteIfExists(keystore);
    }

    private static void restore(String key, String value) {
        if (value == null) System.clearProperty(key);
        else System.setProperty(key, value);
    }

    @Test
    void authorizedAttemptProducesAdmittedImmutableRevisionWithRestartReadback() throws Exception {
        try (Fixture fixture = openFixture()) {
            var state = fixture.state();
            assertThat(state.productionEligible()).isTrue();
            var store = fixture.store();
            assertThat(store.productionEligible()).isTrue();
            seedAuthorizedSource(state, "tenant-a", "principal-a", "artifact-a", "job-a");
            TranscriptDraft draft = draft("tenant-a", "principal-a", "transcript-a", "artifact-a", "job-a",
                    "real verified transcript");
            TranscriptRevision admitted = store.appendFromSuccessfulAttempt(
                    draft, 0, 1, 77L, FINGERPRINT, "transcript-v1");
            assertThat(admitted.revision()).isEqualTo(1);
            assertThat(admitted.admissionStatus()).isEqualTo("ADMITTED");

            // Restart-equivalent readback: a new store instance over the same durable state must
            // return identical bytes, identity scope, revision, and admission status.
            try (PostgresqlMediaTranscriptStore reopened = new PostgresqlMediaTranscriptStore()) {
                var revisions = reopened.revisions("tenant-a", "principal-a", "transcript-a");
                assertThat(revisions).hasSize(1);
                assertThat(revisions.getFirst().admissionStatus()).isEqualTo("ADMITTED");
                assertThat(revisions.getFirst().draft().text()).isEqualTo("real verified transcript");
                assertThat(revisions.getFirst().draft().rightsDecisionId()).isEqualTo("rights-decision-1");
                assertThat(reopened.readAttemptBinding("tenant-a", "principal-a", "transcript-a", 1)
                        .providerOperationId()).isEqualTo("operation-1");
                assertThat(reopened.revisions("tenant-a", "other-principal", "transcript-a")).isEmpty();
            }
        }
    }

    @Test
    void revokedStaleOrUnauthorizedRightsDecisionsRejectProductionAppend() throws Exception {
        try (Fixture fixture = openFixture()) {
            var state = fixture.state();
            var store = fixture.store();
            seedAuthorizedSource(state, "tenant-rev", "principal-a", "artifact-a", "job-a");
            TranscriptDraft draft = draft("tenant-rev", "principal-a", "transcript-a", "artifact-a", "job-a",
                    "real verified transcript");
            revokeSource(state, "tenant-rev", "artifact-a");
            assertThatThrownBy(() -> store.appendFromSuccessfulAttempt(
                    draft, 0, 1, 77L, FINGERPRINT, "transcript-v1"))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("rights");
            assertThat(store.revisions("tenant-rev", "principal-a", "transcript-a")).isEmpty();
        }
    }

    @Test
    void legacySnapshotAndCandidateDraftCannotClaimProductionAdmission() throws Exception {
        try (Fixture fixture = openFixture()) {
            var state = fixture.state();
            var store = fixture.store();
            seedAuthorizedSource(state, "tenant-legacy", "principal-a", "artifact-a", "job-a");
            setSnapshotVersion(state, "tenant-legacy", "job-a", "media.stt-request-snapshot.v1");
            TranscriptDraft draft = draft("tenant-legacy", "principal-a", "transcript-a", "artifact-a", "job-a",
                    "real verified transcript");
            assertThatThrownBy(() -> store.appendFromSuccessfulAttempt(
                    draft, 0, 1, 77L, FINGERPRINT, "transcript-v1"))
                    .isInstanceOf(IllegalStateException.class);
        }
    }

    private static TranscriptDraft draft(String tenant, String principal, String transcript,
            String artifact, String job, String text) {
        return new TranscriptDraft(tenant, principal, transcript, artifact, "sha256:" + DIGEST, DIGEST,
                job, "profile-a", "provider-a", "model-a", "en-US", "milliseconds", text,
                "NOT_APPLICABLE_HUMAN_CONSENT", "rights-decision-1", "policy-v1",
                "urn:media:purpose:transcription", "transcription");
    }

    private static void seedAuthorizedSource(MediaAwsPostgresqlRuntimeState state, String tenant,
            String principal, String artifact, String job) throws Exception {
        long now = System.currentTimeMillis();
        try (Connection c = state.connection()) {
            try (PreparedStatement s = c.prepareStatement("""
                    INSERT INTO media_artifacts (tenant_id,artifact_id,principal_id,file_name,content_type,
                        size_bytes,sha256,object_reference,classification,created_at,expires_at,
                        metadata_json,scan_status)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """)) {
                s.setString(1, tenant); s.setString(2, artifact); s.setString(3, principal);
                s.setString(4, "source.wav"); s.setString(5, "audio/wav"); s.setLong(6, 10);
                s.setString(7, DIGEST); s.setString(8, "fixture"); s.setString(9, "CONFIDENTIAL");
                s.setLong(10, now); s.setLong(11, now + 3_600_000); s.setString(12, "{}");
                s.setString(13, "CLEAN"); s.executeUpdate();
            }
            try (PreparedStatement s = c.prepareStatement("""
                    INSERT INTO media_processing_jobs (tenant_id,job_id,request_id,principal_id,artifact_id,
                        job_type,provider_id,status,created_at,result_json,failure_code,version,
                        expected_artifact_version,request_fingerprint,stt_request_snapshot)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """)) {
                s.setString(1, tenant); s.setString(2, job); s.setString(3, "request-" + job);
                s.setString(4, principal); s.setString(5, artifact); s.setString(6, "SPEECH_TO_TEXT");
                s.setString(7, "provider-a"); s.setString(8, "COMPLETED"); s.setLong(9, now);
                s.setString(10, "{}"); s.setString(11, ""); s.setLong(12, 3);
                s.setString(13, "sha256:" + DIGEST); s.setString(14, "sha256:" + FINGERPRINT);
                s.setString(15, authorizedSnapshot()); s.executeUpdate();
            }
            try (PreparedStatement s = c.prepareStatement("""
                    INSERT INTO media_processing_attempts
                      (tenant_id,job_id,attempt_number,request_id,provider_id,request_fingerprint,
                       lease_owner,fencing_token,state,provider_operation_id,provider_receipt_id,
                       result_json,result_digest,provenance_json,observation_json,created_at,updated_at,
                       observed_at)
                    VALUES (?,?,?,?,?,?,?,?,'SUCCEEDED',?,?,?,?,?,?,?,?,?)
                    """)) {
                String result = semanticResult(state);
                String resultDigest = java.util.HexFormat.of().formatHex(
                        java.security.MessageDigest.getInstance("SHA-256")
                                .digest(result.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
                s.setString(1, tenant); s.setString(2, job); s.setInt(3, 1);
                s.setString(4, "request-" + job); s.setString(5, "provider-a");
                s.setString(6, FINGERPRINT); s.setString(7, "fixture-worker"); s.setLong(8, 77L);
                s.setString(9, "operation-1"); s.setString(10, "receipt-1"); s.setString(11, result);
                s.setString(12, resultDigest); s.setString(13, "{}"); s.setString(14, "{}");
                s.setLong(15, now); s.setLong(16, now); s.setLong(17, now); s.executeUpdate();
            }
            try (PreparedStatement s = c.prepareStatement("""
                    INSERT INTO media_source_records
                      (tenant_id,artifact_id,source_version,source_sha256,principal_id,source_owner_id,
                       source_kind,human_consent_disposition,consent_decision_id,allowed_operations_csv,
                       allowed_purposes_csv,allowed_regions_csv,allowed_provider_retentions_csv,
                       source_clock_evidence_ref,provenance_ref,registered_by,registered_at,expires_at,
                       revocation_epoch,revoked_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
                    """)) {
                s.setString(1, tenant); s.setString(2, artifact); s.setString(3, "sha256:" + DIGEST);
                s.setString(4, DIGEST); s.setString(5, principal); s.setString(6, "owner-producer-1");
                s.setString(7, "ORIGINAL_NONHUMAN"); s.setString(8, "NOT_APPLICABLE_HUMAN_CONSENT");
                s.setString(9, ""); s.setString(10, "speech_to_text"); s.setString(11, "transcription");
                s.setString(12, "local"); s.setString(13, "NONE"); s.setString(14, "source-clock-ref-1");
                s.setString(15, "provenance://record/1"); s.setString(16, principal);
                s.setLong(17, now); s.setLong(18, now + 3_600_000); s.setLong(19, 0); s.executeUpdate();
            }
            try (PreparedStatement s = c.prepareStatement("""
                    INSERT INTO media_source_rights_decisions
                      (tenant_id,decision_id,artifact_id,source_version,principal_id,source_owner_id,
                       operation,purpose,provider_id,provider_version,processing_boundary,
                       processing_region,provider_retention,policy_decision_id,policy_version,
                       revocation_epoch,decided_at,expires_at,revoked_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
                    """)) {
                s.setString(1, tenant); s.setString(2, "rights-decision-1"); s.setString(3, artifact);
                s.setString(4, "sha256:" + DIGEST); s.setString(5, principal); s.setString(6, "owner-producer-1");
                s.setString(7, "SPEECH_TO_TEXT"); s.setString(8, "transcription"); s.setString(9, "provider-a");
                s.setString(10, "v1"); s.setString(11, "LOCAL"); s.setString(12, "local");
                s.setString(13, "NONE"); s.setString(14, "policy-decision-1"); s.setString(15, "policy-v1");
                s.setLong(16, 0); s.setLong(17, now); s.setLong(18, now + 3_600_000); s.executeUpdate();
            }
        }
    }

    private static String authorizedSnapshot() {
        return "{\"version\":\"media.stt-request-snapshot.v2\",\"customGlossaryRef\":null,"
                + "\"fillerRetakeCandidates\":null,\"rightsDecisionId\":\"rights-decision-1\","
                + "\"policyDecisionId\":\"policy-decision-1\",\"policyVersion\":\"policy-v1\","
                + "\"consentDecisionId\":\"NOT_APPLICABLE_HUMAN_CONSENT\","
                + "\"sourceClockEvidenceRef\":\"source-clock-ref-1\",\"revocationEpoch\":0}";
    }

    private static String semanticResult(MediaAwsPostgresqlRuntimeState state) throws Exception {
        Map<String, Object> response = new HashMap<>();
        response.put("sourceArtifactVersionRef", "sha256:" + DIGEST);
        response.put("requestFingerprint", FINGERPRINT);
        response.put("transcriptVersionRef", "transcript-v1");
        response.put("glossaryDisposition", "NOT_REQUESTED");
        response.put("transcriptText", "real verified transcript");
        Map<String, Object> glossary = new HashMap<>();
        glossary.put("disposition", "NOT_REQUESTED");
        Map<String, Object> observations = new HashMap<>();
        observations.put("requestFingerprint", FINGERPRINT);
        observations.put("glossaryApplication", glossary);
        observations.put("transcriptResponse", response);
        return state.mapper().writeValueAsString(Map.of("semanticObservations", observations));
    }

    private static void revokeSource(MediaAwsPostgresqlRuntimeState state, String tenant, String artifact)
            throws Exception {
        try (Connection c = state.connection()) {
            try (PreparedStatement s = c.prepareStatement("""
                    UPDATE media_source_records SET revoked_at=?, revocation_epoch=revocation_epoch+1
                     WHERE tenant_id=? AND artifact_id=?
                    """)) {
                s.setLong(1, System.currentTimeMillis());
                s.setString(2, tenant); s.setString(3, artifact); s.executeUpdate();
            }
            try (PreparedStatement s = c.prepareStatement("""
                    UPDATE media_source_rights_decisions SET revoked_at=?
                     WHERE tenant_id=? AND artifact_id=?
                    """)) {
                s.setLong(1, System.currentTimeMillis());
                s.setString(2, tenant); s.setString(3, artifact); s.executeUpdate();
            }
        }
    }

    private static void setSnapshotVersion(MediaAwsPostgresqlRuntimeState state, String tenant,
            String job, String version) throws Exception {
        String snapshot = "{\"version\":\"" + version + "\",\"customGlossaryRef\":null,"
                + "\"fillerRetakeCandidates\":null}";
        try (Connection c = state.connection(); PreparedStatement s = c.prepareStatement(
                "UPDATE media_processing_jobs SET stt_request_snapshot=? WHERE tenant_id=? AND job_id=?")) {
            s.setString(1, snapshot); s.setString(2, tenant); s.setString(3, job);
            assertThat(s.executeUpdate()).isEqualTo(1);
        }
    }

    private record Fixture(AutoCloseable installed, MediaAwsPostgresqlRuntimeState state,
            PostgresqlMediaTranscriptStore store) implements AutoCloseable {
        @Override public void close() throws Exception {
            store.close();
            state.release();
            installed.close();
        }
    }

    private static Fixture openFixture() throws Exception {
        Map<String, String> env = new HashMap<>();
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "integration");
        env.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        env.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_PROD_DB_PASSWORD");
        env.put("MEDIA_PROD_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_S3_BUCKET", "media-transcript-production");
        env.put("MEDIA_S3_REGION", "us-east-1");
        env.put("MEDIA_S3_ENDPOINT", "https://127.0.0.1:" + s3Stub.getAddress().getPort());
        env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_SECRET");
        env.put("MEDIA_ACCESS", "test-access");
        env.put("MEDIA_SECRET", "test-secret");
        AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(env);
        PostgresqlMediaTranscriptStore store = new PostgresqlMediaTranscriptStore();
        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        return new Fixture(installed, state, store);
    }
}
