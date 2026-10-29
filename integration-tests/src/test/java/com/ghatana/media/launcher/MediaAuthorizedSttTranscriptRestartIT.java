package com.ghatana.media.launcher;

import com.ghatana.governance.PolicyDecisionOutcome;
import com.ghatana.governance.PolicyDecisionRecord;
import com.ghatana.governance.PolicyEngine;
import com.ghatana.governance.PolicyEvaluationContext;
import com.ghatana.governance.PolicyReasonCode;
import com.ghatana.media.config.SttConfig;
import com.ghatana.media.provider.aws.PostgresqlMediaConsentAuthority;
import com.ghatana.media.provider.aws.PostgresqlMediaJobStore;
import com.ghatana.media.provider.aws.PostgresqlMediaSourceAuthorizationAuthority;
import com.ghatana.media.provider.aws.PostgresqlMediaSourceRightsAdministration;
import com.ghatana.media.provider.aws.PostgresqlMediaStreamSessionStore;
import com.ghatana.media.provider.aws.PostgresqlMediaTranscriptStore;
import com.ghatana.media.provider.aws.TestAwsStateInstall;
import com.ghatana.media.runtime.MediaRuntimeContracts.BiometricSensitivity;
import com.ghatana.media.runtime.MediaRuntimeContracts.AutomationRisk;
import com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.media.runtime.MediaSourceRightsAdministration;
import com.ghatana.stt.provider.WhisperOnnxSttProvider;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * First authorized end-to-end STT outcome: a genuinely source-authorized request runs real
 * pinned Whisper inference through the canonical job/attempt/fence pipeline, the runtime
 * projects the successful attempt into the immutable transcript store, and a fresh store
 * instance over the same durable PostgreSQL state reads back the identical ADMITTED revision.
 * Opt-in: requires the private pinned model profile and a rights-safe WAV fixture.
 */
@Tag("integration")
@Testcontainers(disabledWithoutDocker = true)
class MediaAuthorizedSttTranscriptRestartIT {
    @Container static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    private static String lastJobId;
    private static com.sun.net.httpserver.HttpsServer s3Stub;
    private static Path keystore;
    private static String stubUrl;
    private static Map<String, String> previousTls = new java.util.HashMap<>();

    @org.junit.jupiter.api.BeforeAll
    static void startS3Stub() throws Exception {
        keystore = Files.createTempFile("media-e2e-s3-", ".p12");
        Files.delete(keystore);
        new ProcessBuilder("keytool", "-genkeypair", "-alias", "s3stub",
                "-keyalg", "RSA", "-keysize", "2048", "-validity", "1",
                "-keystore", keystore.toString(), "-storetype", "PKCS12",
                "-storepass", "changeit", "-keypass", "changeit",
                "-dname", "CN=localhost", "-ext", "SAN=dns:localhost,ip:127.0.0.1")
                .inheritIO().start().waitFor();
        javax.net.ssl.KeyManagerFactory keyManagers = javax.net.ssl.KeyManagerFactory
                .getInstance(javax.net.ssl.KeyManagerFactory.getDefaultAlgorithm());
        var store = java.security.KeyStore.getInstance(keystore.toFile(), "changeit".toCharArray());
        keyManagers.init(store, "changeit".toCharArray());
        javax.net.ssl.SSLContext tls = javax.net.ssl.SSLContext.getInstance("TLS");
        tls.init(keyManagers.getKeyManagers(), null, null);
        for (String prop : new String[]{
                "javax.net.ssl.trustStore", "javax.net.ssl.trustStorePassword",
                "javax.net.ssl.trustStoreType"}) {
            previousTls.put(prop, System.getProperty(prop));
        }
        System.setProperty("javax.net.ssl.trustStore", keystore.toString());
        System.setProperty("javax.net.ssl.trustStorePassword", "changeit");
        System.setProperty("javax.net.ssl.trustStoreType", "PKCS12");
        s3Stub = com.sun.net.httpserver.HttpsServer.create(
                new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        s3Stub.setHttpsConfigurator(new com.sun.net.httpserver.HttpsConfigurator(tls));
        s3Stub.createContext("/", exchange -> {
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        s3Stub.start();
        stubUrl = "https://127.0.0.1:" + s3Stub.getAddress().getPort();
    }

    @org.junit.jupiter.api.AfterAll
    static void stopS3Stub() throws Exception {
        if (s3Stub != null) s3Stub.stop(0);
        previousTls.forEach((key, value) -> {
            if (value == null) System.clearProperty(key);
            else System.setProperty(key, value);
        });
        if (keystore != null) Files.deleteIfExists(keystore);
    }

    @Test
    void authorizedWhisperAttemptProducesAdmittedTranscriptWithRestartReadback() throws Exception {
        String profile = System.getenv("GHATANA_MEDIA_WHISPER_PROFILE");
        String audio = System.getenv("GHATANA_MEDIA_WHISPER_AUDIO");
        String gold = System.getenv("GHATANA_MEDIA_WHISPER_GOLD_TRANSCRIPT");
        assumeTrue(profile != null && audio != null && gold != null,
                "Set pinned Whisper profile, rights-safe WAV and independent gold transcript");
        byte[] wav = Files.readAllBytes(Path.of(audio));
        String wavSha = HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(wav));

        AutoCloseable installed = TestAwsStateInstall.install(environment());
        try (var artifactStore = new LocalMediaRuntimeSupport.FileArtifactStore(
                     Files.createTempDirectory("media-e2e-artifacts"));
             var jobStore = new PostgresqlMediaJobStore();
             var streamStore = new PostgresqlMediaStreamSessionStore();
             var consentAuthority = new PostgresqlMediaConsentAuthority();
             var authority = new PostgresqlMediaSourceAuthorizationAuthority(new AllowPolicy());
             var transcriptStore = new PostgresqlMediaTranscriptStore();
             var administration = new PostgresqlMediaSourceRightsAdministration();
             var provider = whisperProvider(profile);
             var runtime = new MediaRuntime(
                     new MediaRuntimeConfig(true, "test", 8093, 8 * 1024 * 1024,
                             4 * 1024 * 1024, 64L * 1024 * 1024, Duration.ofMinutes(4), 4,
                             "", "", false, false, Files.createTempDirectory("media-e2e-root")),
                     artifactStore, jobStore, streamStore, consentAuthority,
                     MediaSemanticRedactionRuntime.disabled(Duration.ofSeconds(2)),
                     MediaLifecyclePublisher.disabled(), List.of(provider),
                     List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()),
                     List.of(), authority, transcriptStore, Clock.systemUTC())) {

            MediaArtifact artifact = upload(runtime, wav, wavSha);
            seedArtifactRow(artifact);
            MediaSourceRightsAdministration.SourceRecord record = administration.register(
                    new MediaSourceRightsAdministration.RegisterRequest(
                            "tenant-a", "principal-a", artifact.artifactId(),
                            artifact.version().value(), wavSha, "owner-producer-1",
                            MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                            MediaSourceAuthorizationContracts.HumanConsentDisposition
                                    .NOT_APPLICABLE_HUMAN_CONSENT,
                            "", Set.of("speech_to_text"), Set.of("transcription"),
                            Set.of("local"), Set.of(ProviderDataRetention.NONE),
                            "fixture-clock-evidence", "provenance://fixture/1",
                            Instant.now().plusSeconds(3600), "correlation-e2e"));
            assertThat(record.revoked()).isFalse();

            var accepted = runtime.submit(new ProcessingJobRequest(
                    "e2e-stt-1", "tenant-a", "principal-a", "correlation-e2e",
                    artifact.artifactId(), artifact.version().value(), JobType.SPEECH_TO_TEXT,
                    "stt-whisper-local", parameters(), governance()));
            assertThat(accepted.status()).isEqualTo(JobStatus.ACCEPTED);

            var terminal = await(runtime, accepted.jobId());
            lastJobId = accepted.jobId();
            assertThat(terminal.status()).as("final job: %s", terminal)
                    .isEqualTo(JobStatus.COMPLETED);
        }

        // Restart-equivalent readback: the runtime is closed; a fresh store over the same
        // still-installed durable state returns the identical ADMITTED revision, exact
        // transcript text and attempt binding, and only for the owning principal.
        try (AutoCloseable reinstalled = TestAwsStateInstall.install(environment());
             var reopened = new PostgresqlMediaTranscriptStore()) {
            var revisions = reopened.revisions(
                    "tenant-a", "principal-a", "transcript:" + lastJobId);
            assertThat(revisions).hasSize(1);
            var revision = revisions.getFirst();
            assertThat(revision.admissionStatus()).isEqualTo("ADMITTED");
            assertThat(revision.draft().text()).isEqualTo(gold());
            assertThat(reopened.readAttemptBinding(
                    "tenant-a", "principal-a", "transcript:" + lastJobId, 1)
                    .providerOperationId()).isNotBlank();
            assertThat(reopened.revisions("tenant-a", "other-principal",
                    "transcript:" + lastJobId)).isEmpty();
        } finally {
            installed.close();
        }
    }

    /** Mirrors the artifact store's durable admission record for the fixture upload. */
    private static void seedArtifactRow(MediaArtifact artifact) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "INSERT INTO media_artifacts (tenant_id,artifact_id,principal_id,file_name,"
                             + "content_type,size_bytes,sha256,object_reference,classification,"
                             + "created_at,expires_at,metadata_json,scan_status,"
                             + "scan_policy_version,scanner_id,scanned_at) "
                             + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'CLEAN',?,?,?)")) {
            statement.setString(1, artifact.tenantId());
            statement.setString(2, artifact.artifactId());
            statement.setString(3, artifact.principalId());
            statement.setString(4, artifact.fileName());
            statement.setString(5, artifact.contentType());
            statement.setLong(6, artifact.sizeBytes());
            statement.setString(7, artifact.sha256());
            statement.setString(8, artifact.objectReference());
            statement.setString(9, artifact.classification());
            statement.setLong(10, artifact.createdAt().toEpochMilli());
            statement.setLong(11, artifact.expiresAt().toEpochMilli());
            statement.setString(12, "{\"sourceClockId\":\"fixture-clock\","
                    + "\"sourceClockMappingEvidenceRef\":\"fixture-clock-evidence\","
                    + "\"sourceClockTicksPerSecond\":1,"
                    + "\"sourceDurationTicks\":" + artifact.sizeBytes() / 2 + "}");
            statement.setString(13, "fixture-scan-policy/v1");
            statement.setString(14, "fixture-scanner/v1");
            statement.setLong(15, Instant.now().toEpochMilli());
            statement.executeUpdate();
        }
    }

    private static String gold() {
        return System.getenv("GHATANA_MEDIA_WHISPER_GOLD_TRANSCRIPT");
    }

    private static ProcessingJob await(MediaRuntime runtime, String jobId) throws Exception {
        for (int i = 0; i < 240; i++) {
            var job = runtime.job("tenant-a", "principal-a", jobId);
            if (job.isPresent() && (job.get().status() == JobStatus.COMPLETED
                    || job.get().status() == JobStatus.FAILED)) {
                return job.get();
            }
            Thread.sleep(500);
        }
        throw new AssertionError("STT job did not reach a terminal state");
    }

    private static WhisperOnnxSttProvider whisperProvider(String profileDir) {
        SttConfig config = SttConfig.builder()
                .modelPath(Path.of(profileDir).resolve("encoder_model_quantized.onnx"))
                .modelId("whisper-tiny-multilingual-onnx-reference")
                .maxConcurrentRequests(1)
                .maxAudioLengthSeconds(30)
                .timeout(Duration.ofMinutes(3))
                .build();
        return new WhisperOnnxSttProvider(config, new WhisperOnnxSttProvider.ProfileBinding(
                "stt-whisper-local", "whisper-tiny-multilingual-onnx-reference",
                "whisper-reference-multilingual", "v1",
                "sha256:2af4a414ca47aa30f61246017e5fe82b0a8d229281d1255ba666a2a7f6b84d19",
                Set.of("en-US"), "wave2-reference-candidates.v1.json#stt-whisper-tiny-multilingual",
                "local", true), 4L * 1024 * 1024);
    }

    private static MediaArtifact upload(MediaRuntime runtime, byte[] wav, String wavSha)
            throws Exception {
        var upload = runtime.beginUpload(new UploadRequest(
                "tenant-a", "principal-a", "fixture.wav", "audio/wav", wav.length, wavSha,
                "CONFIDENTIAL", Duration.ofMinutes(30), Map.of(
                        "sourceClockId", "fixture-clock",
                        "sourceClockMappingEvidenceRef", "fixture-clock-evidence",
                        "sourceClockTicksPerSecond", 1,
                        "sourceDurationTicks", wav.length / 2)), "e2e-upload-1");
        runtime.appendChunk("tenant-a", "principal-a", upload.uploadId(), 0, wav);
        return runtime.completeUpload("tenant-a", "principal-a", upload.uploadId());
    }

    private static Map<String, Object> parameters() {
        return Map.of(
                "profileId", "whisper-reference-multilingual",
                "profileVersion", "v1",
                "profileConfigurationDigest",
                        "sha256:2af4a414ca47aa30f61246017e5fe82b0a8d229281d1255ba666a2a7f6b84d19",
                "languageIntent", Map.of("mode", "EXPLICIT", "languageTag", "en-US"));
    }

    private static MediaGovernanceContext governance() {
        return new MediaGovernanceContext("", "transcription", DataClassification.CONFIDENTIAL,
                "local", Set.of("local"), false, "short-lived-media", false, false, "",
                BiometricSensitivity.NONE, AutomationRisk.ASSISTIVE);
    }

    private static Map<String, String> environment() {
        Map<String, String> env = new java.util.HashMap<>();
        env.put("MEDIA_RUNTIME_ENABLED", "true");
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "integration");
        env.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        env.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_E2E_DB_PASSWORD");
        env.put("MEDIA_E2E_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        env.put("MEDIA_S3_BUCKET", "media-e2e-stt");
        env.put("MEDIA_S3_REGION", "us-east-1");
        env.put("MEDIA_S3_ENDPOINT", stubUrl);
        env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_E2E_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_E2E_SECRET");
        env.put("MEDIA_E2E_ACCESS", "e2e-access");
        env.put("MEDIA_E2E_SECRET", "e2e-secret");
        return env;
    }

    /** Deterministic ALLOW decision for the source-rights authority under test. */
    private static final class AllowPolicy implements PolicyEngine {
        @Override public CompletionStage<PolicyDecisionRecord> evaluate(
                com.ghatana.governance.PolicyEvaluationRequest request) {
            PolicyEvaluationContext context = new PolicyEvaluationContext(
                    request.principalId(), request.tenantId(), request.actionClass(),
                    request.targetType(), request.targetId(), request.toolId(),
                    request.criticality(), request.reversibility(), request.attributes(),
                    Instant.now(), request.correlationId(), request.verifiedContext());
            return CompletableFuture.completedFuture(new PolicyDecisionRecord(
                    "policy-decision-e2e", PolicyDecisionOutcome.ALLOW,
                    List.of("policy-v1:rule-allow-media"), List.of("rule-allow-media"),
                    List.of("e2e policy evaluation"), context, Instant.now(), null,
                    "policy-v1", List.of(PolicyReasonCode.POLICY_ALLOWED)));
        }

        @Override public CompletionStage<Boolean> policyExists(String policyId) {
            return CompletableFuture.completedFuture("policy-v1".equals(policyId));
        }

        @Override public CompletionStage<Boolean> policyExists(String policyId, String version) {
            return policyExists(policyId);
        }

        @Override public boolean isOpen() { return true; }

        @Override public void close() { }

        @Override public com.ghatana.governance.PolicyEngineLifecycle.State lifecycleState() {
            return com.ghatana.governance.PolicyEngineLifecycle.State.OPEN;
        }

        @Override public long inFlightEvaluations() { return 0; }

        @Override public com.ghatana.governance.PolicyEngineLifecycle.Result drain(Duration timeout) {
            return new com.ghatana.governance.PolicyEngineLifecycle.Result(
                    com.ghatana.governance.PolicyEngineLifecycle.State.DRAINED, 0);
        }

        @Override public com.ghatana.governance.PolicyEngineLifecycle.Result close(Duration timeout) {
            return new com.ghatana.governance.PolicyEngineLifecycle.Result(
                    com.ghatana.governance.PolicyEngineLifecycle.State.CLOSED, 0);
        }
    }
}
