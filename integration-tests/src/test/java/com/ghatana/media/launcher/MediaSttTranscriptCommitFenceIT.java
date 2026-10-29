package com.ghatana.media.launcher;

import com.ghatana.governance.PolicyDecisionOutcome;
import com.ghatana.governance.PolicyDecisionRecord;
import com.ghatana.governance.PolicyEngine;
import com.ghatana.governance.PolicyEvaluationContext;
import com.ghatana.governance.PolicyReasonCode;
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
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.media.runtime.MediaSourceRightsAdministration;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission;
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
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * PostgreSQL-backed STT transcript-commit fencing that needs no real model. A fixture provider
 * returns a typed SUCCEEDED submission carrying the canonical transcript response, while the
 * Shared policy verdict is flipped after the provider executes: the current decision must be
 * re-read at the fenced transcript commit boundary and a denied/revoked verdict must leave the
 * durable transcript store untouched even though the job's own outcome already committed. A
 * second case abandons an in-flight attempt (close before any terminal write) and proves a
 * fresh runtime over the same durable state reconciles the job to OUTCOME_UNKNOWN with no
 * transcript side effect.
 */
@Tag("integration")
@Testcontainers(disabledWithoutDocker = true)
class MediaSttTranscriptCommitFenceIT {
    @Container static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    private static com.sun.net.httpserver.HttpsServer s3Stub;
    private static Path keystore;
    private static String stubUrl;
    private static Map<String, String> previousTls = new java.util.HashMap<>();

    @org.junit.jupiter.api.BeforeAll
    static void startS3Stub() throws Exception {
        keystore = Files.createTempFile("media-fence-s3-", ".p12");
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
    void admittedAttemptAppendsTranscriptRevisionThroughTheFence() throws Exception {
        AtomicBoolean providerRan = new AtomicBoolean();
        Path root = Files.createTempDirectory("media-fence-allow-");
        AutoCloseable installed = TestAwsStateInstall.install(environment());
        try (var artifactStore = new LocalMediaRuntimeSupport.FileArtifactStore(root);
             var jobStore = new PostgresqlMediaJobStore();
             var streamStore = new PostgresqlMediaStreamSessionStore();
             var consentAuthority = new PostgresqlMediaConsentAuthority();
             var authority = new PostgresqlMediaSourceAuthorizationAuthority(
                     new FlippingPolicy(new AtomicBoolean()));
             var transcriptStore = new PostgresqlMediaTranscriptStore();
             var administration = new PostgresqlMediaSourceRightsAdministration();
             var runtime = runtime(root, artifactStore, jobStore, streamStore, consentAuthority,
                     authority, transcriptStore, List.of(fenceProvider(providerRan)))) {
            MediaArtifact artifact = upload(runtime, "allow");
            seedArtifactRow(artifact);
            administration.register(register(artifact), authenticated("tenant-a", "principal-a"));

            var accepted = runtime.submit(jobRequest(artifact, "allow"),
                    authenticated("tenant-a", "principal-a"));
            var terminal = await(runtime, accepted.jobId());
            assertThat(terminal.status()).as("final job: %s", terminal)
                    .isEqualTo(JobStatus.COMPLETED);
            assertThat(providerRan).isTrue();

            var revisions = transcriptStore.revisions(
                    "tenant-a", "principal-a", "transcript:" + accepted.jobId());
            assertThat(revisions).hasSize(1);
            var revision = revisions.getFirst();
            assertThat(revision.admissionStatus()).isEqualTo("ADMITTED");
            assertThat(revision.draft().text()).isEqualTo("fence transcript");
            assertThat(transcriptStore.readAttemptBinding(
                    "tenant-a", "principal-a", "transcript:" + accepted.jobId(), 1)
                    .providerOperationId()).isEqualTo("op-fence-1");
        } finally {
            installed.close();
        }
    }

    @Test
    void policyDenialAfterProviderSuccessBlocksTheFencedTranscriptCommit() throws Exception {
        AtomicBoolean providerRan = new AtomicBoolean();
        Path root = Files.createTempDirectory("media-fence-deny-");
        AutoCloseable installed = TestAwsStateInstall.install(environment());
        try (var artifactStore = new LocalMediaRuntimeSupport.FileArtifactStore(root);
             var jobStore = new PostgresqlMediaJobStore();
             var streamStore = new PostgresqlMediaStreamSessionStore();
             var consentAuthority = new PostgresqlMediaConsentAuthority();
             var authority = new PostgresqlMediaSourceAuthorizationAuthority(
                     new FlippingPolicy(providerRan));
             var transcriptStore = new PostgresqlMediaTranscriptStore();
             var administration = new PostgresqlMediaSourceRightsAdministration();
             var runtime = runtime(root, artifactStore, jobStore, streamStore, consentAuthority,
                     authority, transcriptStore, List.of(fenceProvider(providerRan)))) {
            MediaArtifact artifact = upload(runtime, "deny");
            seedArtifactRow(artifact);
            administration.register(register(artifact), authenticated("tenant-a", "principal-a"));

            var accepted = runtime.submit(jobRequest(artifact, "deny"),
                    authenticated("tenant-a", "principal-a"));
            var terminal = await(runtime, accepted.jobId());
            // The provider succeeded and the job outcome committed; the Shared policy verdict
            // read at the fenced commit boundary had flipped to DENY, so the transcript store
            // must show no revision and no attempt binding for this job.
            assertThat(terminal.status()).as("final job: %s", terminal)
                    .isEqualTo(JobStatus.COMPLETED);
            assertThat(providerRan).isTrue();
            assertThat(transcriptStore.revisions(
                    "tenant-a", "principal-a", "transcript:" + accepted.jobId())).isEmpty();
        } finally {
            installed.close();
        }
    }

    @Test
    void abandonedAttemptReconcilesToUnknownOnRestartAndLeavesNoTranscript() throws Exception {
        AtomicBoolean providerRan = new AtomicBoolean();
        Path root = Files.createTempDirectory("media-fence-kill-");
        AutoCloseable installed = TestAwsStateInstall.install(environment());
        String jobId;
        try {
            try (var artifactStore = new LocalMediaRuntimeSupport.FileArtifactStore(root);
                 var jobStore = new PostgresqlMediaJobStore();
                 var streamStore = new PostgresqlMediaStreamSessionStore();
                 var consentAuthority = new PostgresqlMediaConsentAuthority();
                 var authority = new PostgresqlMediaSourceAuthorizationAuthority(
                         new FlippingPolicy(new AtomicBoolean()));
                 var transcriptStore = new PostgresqlMediaTranscriptStore();
                 var administration = new PostgresqlMediaSourceRightsAdministration();
                 var runtime = runtime(root, artifactStore, jobStore, streamStore,
                         consentAuthority, authority, transcriptStore,
                         List.of(blockingProvider(providerRan)))) {
                MediaArtifact artifact = upload(runtime, "kill");
                seedArtifactRow(artifact);
                administration.register(register(artifact),
                        authenticated("tenant-a", "principal-a"));
                var accepted = runtime.submit(jobRequest(artifact, "kill"),
                        authenticated("tenant-a", "principal-a"));
                jobId = accepted.jobId();
                for (int i = 0; i < 240 && !providerRan.get(); i++) {
                    Thread.sleep(250);
                }
                assertThat(providerRan).as("attempt dispatched before close").isTrue();
                // Leaving the try closes the runtime while the attempt is still in flight:
                // no terminal write happens. Expiring the lease models the crashed worker's
                // claim timing out, which is what a fresh runtime recovers from.
                expireLease(jobId);
            }

            // A fresh installation and runtime over the same durable state reconciles the
            // abandoned RUNNING row to OUTCOME_UNKNOWN and never produces a transcript.
            try (AutoCloseable reinstalled = TestAwsStateInstall.install(environment());
                 var artifactStoreB = new LocalMediaRuntimeSupport.FileArtifactStore(root);
                 var jobStoreB = new PostgresqlMediaJobStore();
                 var streamStoreB = new PostgresqlMediaStreamSessionStore();
                 var consentAuthorityB = new PostgresqlMediaConsentAuthority();
                 var authorityB = new PostgresqlMediaSourceAuthorizationAuthority(
                         new FlippingPolicy(new AtomicBoolean()));
                 var transcriptStoreB = new PostgresqlMediaTranscriptStore();
                 var runtimeB = runtime(root, artifactStoreB, jobStoreB, streamStoreB,
                         consentAuthorityB, authorityB, transcriptStoreB, List.of())) {
                var reconciled = runtimeB.job("tenant-a", "principal-a", jobId).orElseThrow();
                assertThat(reconciled.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
                assertThat(transcriptStoreB.revisions(
                        "tenant-a", "principal-a", "transcript:" + jobId)).isEmpty();
            }
        } finally {
            installed.close();
        }
    }

    private static MediaRuntime runtime(
            Path root,
            LocalMediaRuntimeSupport.FileArtifactStore artifactStore,
            PostgresqlMediaJobStore jobStore,
            PostgresqlMediaStreamSessionStore streamStore,
            PostgresqlMediaConsentAuthority consentAuthority,
            PostgresqlMediaSourceAuthorizationAuthority authority,
            PostgresqlMediaTranscriptStore transcriptStore,
            List<MediaProcessingProvider> providers) throws Exception {
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "test", 8093, 8 * 1024 * 1024,
                        4 * 1024 * 1024, 64L * 1024 * 1024, Duration.ofMinutes(4), 4,
                        "", "", false, false, root),
                artifactStore, jobStore, streamStore, consentAuthority,
                MediaSemanticRedactionRuntime.disabled(Duration.ofSeconds(2)),
                MediaLifecyclePublisher.disabled(), providers,
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()),
                List.of(), authority, transcriptStore, Clock.systemUTC());
    }

    private static MediaProcessingProvider fenceProvider(AtomicBoolean ran) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "stt-fence-fixture"; }
            @Override public String providerVersion() { return "v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.SPEECH_TO_TEXT); }
            @Override public java.util.Optional<MediaSpeechToTextAdmission.Profile> speechToTextProfile() {
                return java.util.Optional.of(new MediaSpeechToTextAdmission.Profile(
                        "stt-fence-fixture", "v1", "fence-profile", "v1",
                        "sha256:" + "a".repeat(64),
                        MediaSpeechToTextAdmission.ProfileQualification.QUALIFIED,
                        Set.of("en-US"), false,
                        MediaSpeechToTextAdmission.TimingDisposition.SOURCE_CLOCK_BOUND,
                        "fixture-qualification-evidence"));
            }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public String processingRegion() { return "local"; }
            @Override public ProviderDataRetention providerDataRetention() {
                return ProviderDataRetention.NONE;
            }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                return CompletableFuture.failedFuture(
                        new AssertionError("durable dispatch must use the typed attempt path"));
            }
            @Override public CompletableFuture<ProviderSubmission> processAttempt(
                    ProcessingContext context, ProviderAttemptContext attempt) {
                ran.set(true);
                String fingerprint = attempt.requestFingerprint();
                return CompletableFuture.completedFuture(new ProviderSubmission(
                        AttemptFinality.SUCCEEDED, "op-fence-1", "receipt-fence-1",
                        Map.of("text", "fence transcript",
                                "semanticObservations", Map.of(
                                        "requestFingerprint", fingerprint,
                                        "glossaryApplication", Map.of(
                                                "disposition", "NOT_REQUESTED"),
                                        "transcriptResponse", Map.of(
                                                "sourceArtifactVersionRef",
                                                context.artifact().version().value(),
                                                "requestFingerprint", fingerprint,
                                                "transcriptVersionRef", "tv-fence-1",
                                                "glossaryDisposition", "NOT_REQUESTED",
                                                "transcriptText", "fence transcript"))),
                        "a".repeat(64), Instant.now()));
            }
        };
    }

    private static MediaProcessingProvider blockingProvider(AtomicBoolean ran) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "stt-fence-fixture"; }
            @Override public String providerVersion() { return "v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.SPEECH_TO_TEXT); }
            @Override public java.util.Optional<MediaSpeechToTextAdmission.Profile> speechToTextProfile() {
                return java.util.Optional.of(new MediaSpeechToTextAdmission.Profile(
                        "stt-fence-fixture", "v1", "fence-profile", "v1",
                        "sha256:" + "a".repeat(64),
                        MediaSpeechToTextAdmission.ProfileQualification.QUALIFIED,
                        Set.of("en-US"), false,
                        MediaSpeechToTextAdmission.TimingDisposition.SOURCE_CLOCK_BOUND,
                        "fixture-qualification-evidence"));
            }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public String processingRegion() { return "local"; }
            @Override public ProviderDataRetention providerDataRetention() {
                return ProviderDataRetention.NONE;
            }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                return new CompletableFuture<>();
            }
            @Override public CompletableFuture<ProviderSubmission> processAttempt(
                    ProcessingContext context, ProviderAttemptContext attempt) {
                ran.set(true);
                return new CompletableFuture<>();
            }
        };
    }

    private static MediaArtifact upload(MediaRuntime runtime, String tag) throws Exception {
        byte[] wav = ("fence-audio-bytes-" + tag)
                .getBytes(java.nio.charset.StandardCharsets.UTF_8);
        String wavSha = HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(wav));
        var upload = runtime.beginUpload(new UploadRequest(
                "tenant-a", "principal-a", "fence.wav", "audio/wav", wav.length, wavSha,
                "CONFIDENTIAL", Duration.ofMinutes(30), Map.of(
                        "sourceClockId", "fixture-clock",
                        "sourceClockMappingEvidenceRef", "fixture-clock-evidence",
                        "sourceClockTicksPerSecond", 1,
                        "sourceDurationTicks", wav.length / 2)), "fence-upload-" + tag);
        runtime.appendChunk("tenant-a", "principal-a", upload.uploadId(), 0, wav);
        return runtime.completeUpload("tenant-a", "principal-a", upload.uploadId());
    }

    private static MediaSourceRightsAdministration.RegisterRequest register(MediaArtifact artifact) {
        return new MediaSourceRightsAdministration.RegisterRequest(
                "tenant-a", "principal-a", artifact.artifactId(), artifact.version().value(),
                artifact.sha256(), "principal-a",
                MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                MediaSourceAuthorizationContracts.HumanConsentDisposition
                        .NOT_APPLICABLE_HUMAN_CONSENT,
                "", Set.of("speech_to_text"), Set.of("transcription"), Set.of("local"),
                Set.of(ProviderDataRetention.NONE), "fixture-clock-evidence",
                "provenance://fixture/fence", Instant.now().plusSeconds(3600), "corr-fence");
    }

    private static ProcessingJobRequest jobRequest(MediaArtifact artifact, String tag) {
        return new ProcessingJobRequest(
                "fence-stt-" + tag, "tenant-a", "principal-a", "correlation-fence-" + tag,
                artifact.artifactId(), artifact.version().value(), JobType.SPEECH_TO_TEXT,
                "stt-fence-fixture", Map.of(
                        "profileId", "fence-profile",
                        "profileVersion", "v1",
                        "profileConfigurationDigest", "sha256:" + "a".repeat(64),
                        "languageIntent", Map.of("mode", "EXPLICIT", "languageTag", "en-US")),
                new MediaGovernanceContext("", "transcription", DataClassification.CONFIDENTIAL,
                        "local", Set.of("local"), false, "short-lived-media", false, false, "",
                        BiometricSensitivity.NONE, AutomationRisk.ASSISTIVE));
    }

    private static MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated(
            String tenantId, String principalId) {
        return new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(
                tenantId, principalId, Instant.now());
    }

    private static ProcessingJob await(MediaRuntime runtime, String jobId) throws Exception {
        for (int i = 0; i < 240; i++) {
            var job = runtime.job("tenant-a", "principal-a", jobId);
            if (job.isPresent() && (job.get().status() == JobStatus.COMPLETED
                    || job.get().status() == JobStatus.FAILED)) {
                return job.get();
            }
            Thread.sleep(250);
        }
        throw new AssertionError("STT job did not reach a terminal state");
    }

    /** Models the crashed worker's lease timing out so a fresh runtime can recover the row. */
    private static void expireLease(String jobId) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "UPDATE media_processing_jobs SET lease_expires_at=0 WHERE job_id=?")) {
            statement.setString(1, jobId);
            assertThat(statement.executeUpdate()).isEqualTo(1);
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

    private static Map<String, String> environment() {
        Map<String, String> env = new java.util.HashMap<>();
        env.put("MEDIA_RUNTIME_ENABLED", "true");
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "integration");
        env.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        env.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_FENCE_DB_PASSWORD");
        env.put("MEDIA_FENCE_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        env.put("MEDIA_S3_BUCKET", "media-fence-stt");
        env.put("MEDIA_S3_REGION", "us-east-1");
        env.put("MEDIA_S3_ENDPOINT", stubUrl);
        env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_FENCE_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_FENCE_SECRET");
        env.put("MEDIA_FENCE_ACCESS", "fence-access");
        env.put("MEDIA_FENCE_SECRET", "fence-secret");
        return env;
    }

    /** Deterministic Shared policy: ALLOW until the provider executes, then DENY. */
    private static final class FlippingPolicy implements PolicyEngine {
        private final AtomicBoolean providerRan;

        FlippingPolicy(AtomicBoolean providerRan) {
            this.providerRan = providerRan;
        }

        @Override public CompletionStage<PolicyDecisionRecord> evaluate(
                com.ghatana.governance.PolicyEvaluationRequest request) {
            PolicyEvaluationContext context = new PolicyEvaluationContext(
                    request.principalId(), request.tenantId(), request.actionClass(),
                    request.targetType(), request.targetId(), request.toolId(),
                    request.criticality(), request.reversibility(), request.attributes(),
                    Instant.now(), request.correlationId(), request.verifiedContext());
            boolean deny = providerRan.get();
            return CompletableFuture.completedFuture(new PolicyDecisionRecord(
                    "policy-decision-fence", deny
                            ? PolicyDecisionOutcome.DENY : PolicyDecisionOutcome.ALLOW,
                    List.of("policy-v1:rule-media"), List.of("rule-media"),
                    List.of("fence policy evaluation"), context, Instant.now(), null,
                    "policy-v1", List.of(deny
                            ? PolicyReasonCode.POLICY_DENIED : PolicyReasonCode.POLICY_ALLOWED)));
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
