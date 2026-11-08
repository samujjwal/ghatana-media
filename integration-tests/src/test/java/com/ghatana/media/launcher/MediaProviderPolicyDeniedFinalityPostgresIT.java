package com.ghatana.media.launcher;

import com.ghatana.media.provider.aws.PostgresqlMediaJobStore;
import com.ghatana.media.provider.aws.TestAwsStateInstall;
import com.ghatana.media.runtime.MediaCapabilityNotAdmittedException;
import com.ghatana.media.runtime.MediaRuntimeContracts.AutomationRisk;
import com.ghatana.media.runtime.MediaRuntimeContracts.BiometricSensitivity;
import com.ghatana.media.runtime.MediaRuntimeContracts.ConsentDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaConsentAuthority;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.junit.jupiter.api.Tag;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;

import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** PostgreSQL-backed finality regression for policy denial after an external provider effect. */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaProviderPolicyDeniedFinalityPostgresIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void policyDenialAfterRecordedProviderEffectStaysUnknownAcrossRuntimeReconstruction(
            boolean asynchronousDenial) throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-policy-finality-" + runId;
        try (S3Client s3 = s3()) {
            s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        Map<String, String> environment = Map.ofEntries(
                Map.entry("MEDIA_RUNTIME_ENVIRONMENT", "test"),
                Map.entry("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl()),
                Map.entry("MEDIA_POSTGRES_USER", POSTGRES.getUsername()),
                Map.entry("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_FINALITY_DB_PASSWORD"),
                Map.entry("MEDIA_FINALITY_DB_PASSWORD", POSTGRES.getPassword()),
                Map.entry("MEDIA_POSTGRES_POOL_SIZE", "8"),
                Map.entry("MEDIA_S3_BUCKET", bucket),
                Map.entry("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString()),
                Map.entry("MEDIA_S3_REGION", LOCALSTACK.getRegion()),
                Map.entry("MEDIA_S3_PATH_STYLE", "true"),
                Map.entry("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED"),
                Map.entry("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_FINALITY_S3_ACCESS"),
                Map.entry("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_FINALITY_S3_SECRET"),
                Map.entry("MEDIA_FINALITY_S3_ACCESS", LOCALSTACK.getAccessKey()),
                Map.entry("MEDIA_FINALITY_S3_SECRET", LOCALSTACK.getSecretKey()));
        AtomicInteger providerEffects = new AtomicInteger();
        AtomicInteger fallbackCalls = new AtomicInteger();
        MediaProcessingProvider external = externalProvider(asynchronousDenial, providerEffects);
        MediaProcessingProvider fallback = fallbackProvider(fallbackCalls);
        var providers = List.of(external, fallback);
        var installed = TestAwsStateInstall.install(environment);
        var root = Files.createTempDirectory("media-provider-policy-finality-");
        try (PostgresqlMediaJobStore stateKeeper = new PostgresqlMediaJobStore()) {
            assertThat(stateKeeper.ready()).isTrue();
            MediaRuntime firstRuntime = runtime(root, providers);
            String tenant = "tenant-" + runId;
            String principal = "principal-" + runId;
            String requestId = "request-" + runId;
            String artifactId;
            String artifactVersion;
            String acceptedJobId;
            try {
                var artifact = uploadFixture(firstRuntime, tenant, principal, runId);
                artifactId = artifact.artifactId();
                artifactVersion = artifact.version().value();
                var accepted = firstRuntime.submit(new ProcessingJobRequest(
                        requestId, tenant, principal, "correlation-" + runId,
                        artifactId, artifactVersion, JobType.VISION,
                        "", Map.of(), governance()),
                        authenticated(tenant, principal));
                acceptedJobId = accepted.jobId();
                ProcessingJob unknown = awaitTerminal(firstRuntime, tenant, principal, accepted.jobId());

                assertThat(unknown.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
                assertThat(unknown.failureCode()).isEqualTo("PROCESSING_OUTCOME_UNKNOWN");
                assertThat(unknown.result()).containsEntry("providerOutcome", "UNKNOWN");
                assertThat(unknown.jobId()).isEqualTo(acceptedJobId);
                assertThat(unknown.artifactId()).isEqualTo(artifactId);
                assertThat(unknown.expectedArtifactVersion()).isEqualTo(artifactVersion);
                assertThat(providerEffects).hasValue(1);
                assertThat(fallbackCalls).hasValue(0);
                assertThat(postgresAttemptState(tenant, accepted.jobId())).isEqualTo("OUTCOME_UNKNOWN");
                assertThat(unknownOutboxRows(tenant, accepted.jobId())).isGreaterThanOrEqualTo(1);
            } finally {
                firstRuntime.close();
            }

            try (MediaRuntime restarted = runtime(root, providers)) {
                ProcessingJob recovered = restarted.job(tenant, principal,
                        readJobId(tenant, requestId)).orElseThrow();
                assertThat(recovered.jobId()).isEqualTo(acceptedJobId);
                assertThat(recovered.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
                assertThat(recovered.failureCode()).isEqualTo("PROCESSING_OUTCOME_UNKNOWN");
                assertThat(recovered.artifactId()).isEqualTo(artifactId);
                assertThat(recovered.expectedArtifactVersion()).isEqualTo(artifactVersion);
                assertThat(postgresAttemptState(tenant, recovered.jobId())).isEqualTo("OUTCOME_UNKNOWN");
                assertThat(unknownOutboxRows(tenant, recovered.jobId())).isGreaterThanOrEqualTo(1);
                assertThat(providerEffects).hasValue(1);
                assertThat(fallbackCalls).hasValue(0);
            }
        } finally {
            try {
                installed.close();
            } finally {
                deleteBucket(bucket);
                deleteDirectory(root);
            }
        }
    }

    @org.junit.jupiter.api.Test
    void dispatchedProviderOutageStaysUnknownWithoutFallbackAcrossRuntimeReconstruction() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-provider-outage-" + runId;
        try (S3Client s3 = s3()) {
            s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        Map<String, String> environment = Map.ofEntries(
                Map.entry("MEDIA_RUNTIME_ENVIRONMENT", "test"),
                Map.entry("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl()),
                Map.entry("MEDIA_POSTGRES_USER", POSTGRES.getUsername()),
                Map.entry("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_OUTAGE_DB_PASSWORD"),
                Map.entry("MEDIA_OUTAGE_DB_PASSWORD", POSTGRES.getPassword()),
                Map.entry("MEDIA_POSTGRES_POOL_SIZE", "8"),
                Map.entry("MEDIA_S3_BUCKET", bucket),
                Map.entry("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString()),
                Map.entry("MEDIA_S3_REGION", LOCALSTACK.getRegion()),
                Map.entry("MEDIA_S3_PATH_STYLE", "true"),
                Map.entry("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED"),
                Map.entry("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_OUTAGE_S3_ACCESS"),
                Map.entry("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_OUTAGE_S3_SECRET"),
                Map.entry("MEDIA_OUTAGE_S3_ACCESS", LOCALSTACK.getAccessKey()),
                Map.entry("MEDIA_OUTAGE_S3_SECRET", LOCALSTACK.getSecretKey()));
        AtomicInteger providerDispatches = new AtomicInteger();
        AtomicInteger fallbackCalls = new AtomicInteger();
        var providers = List.of(outageProvider(providerDispatches), fallbackProvider(fallbackCalls));
        var installed = TestAwsStateInstall.install(environment);
        var root = Files.createTempDirectory("media-provider-outage-finality-");
        try (PostgresqlMediaJobStore stateKeeper = new PostgresqlMediaJobStore()) {
            assertThat(stateKeeper.ready()).isTrue();
            String tenant = "tenant-" + runId;
            String principal = "principal-" + runId;
            String requestId = "outage-request-" + runId;
            String artifactId;
            String artifactVersion;
            String jobId;
            try (MediaRuntime runtime = runtime(root, providers)) {
                var artifact = uploadFixture(runtime, tenant, principal, runId);
                artifactId = artifact.artifactId();
                artifactVersion = "sha256:" + artifact.sha256();
                var accepted = runtime.submit(new ProcessingJobRequest(
                        requestId, tenant, principal, "outage-correlation-" + runId,
                        artifactId, artifactVersion, JobType.VISION,
                        "fixture-provider-transport-outage", Map.of(), governance()),
                        authenticated(tenant, principal));
                jobId = accepted.jobId();
                ProcessingJob unknown = awaitTerminal(runtime, tenant, principal, jobId);

                assertThat(unknown.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
                assertThat(unknown.failureCode()).isEqualTo("PROCESSING_OUTCOME_UNKNOWN");
                assertThat(unknown.result()).containsEntry("providerOutcome", "UNKNOWN")
                        .doesNotContainKey("fallback").doesNotContainKey("result");
                assertThat(unknown.artifactId()).isEqualTo(artifactId);
                assertThat(unknown.expectedArtifactVersion()).isEqualTo(artifactVersion);
                assertThat(providerDispatches).hasValue(1);
                assertThat(fallbackCalls).hasValue(0);
                assertThat(postgresAttemptState(tenant, jobId)).isEqualTo("OUTCOME_UNKNOWN");
                assertThat(unknownOutboxRows(tenant, jobId)).isGreaterThanOrEqualTo(1);
            }

            try (MediaRuntime restarted = runtime(root, providers)) {
                ProcessingJob recovered = restarted.job(tenant, principal,
                        readJobId(tenant, requestId)).orElseThrow();
                assertThat(recovered.jobId()).isEqualTo(jobId);
                assertThat(recovered.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
                assertThat(recovered.failureCode()).isEqualTo("PROCESSING_OUTCOME_UNKNOWN");
                assertThat(recovered.artifactId()).isEqualTo(artifactId);
                assertThat(recovered.expectedArtifactVersion()).isEqualTo(artifactVersion);
                assertThat(postgresAttemptState(tenant, jobId)).isEqualTo("OUTCOME_UNKNOWN");
                assertThat(unknownOutboxRows(tenant, jobId)).isGreaterThanOrEqualTo(1);
                assertThat(providerDispatches).hasValue(1);
                assertThat(fallbackCalls).hasValue(0);
            }
        } finally {
            try {
                installed.close();
            } finally {
                deleteBucket(bucket);
                deleteDirectory(root);
            }
        }
    }

    private static MediaRuntime runtime(java.nio.file.Path root, List<MediaProcessingProvider> providers) {
        var config = new MediaRuntimeConfig(true, "test", 8_093, 1_024, 1_024, 1_048_576,
                Duration.ofSeconds(10), 4, "", "", false, false, root);
        return new MediaRuntime(config, new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new PostgresqlMediaJobStore(), new LocalMediaRuntimeSupport.StreamStore(), consentAuthority(),
                MediaSemanticRedactionRuntime.disabled(config.jobTimeout()), MediaLifecyclePublisher.disabled(),
                providers, List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()), List.of(),
                sourceAuthorizationAuthority(), null, java.time.Clock.systemUTC());
    }

    private static com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact uploadFixture(
            MediaRuntime runtime, String tenant, String principal, String runId) throws Exception {
        byte[] bytes = ("provider-effect-" + runId).getBytes(StandardCharsets.UTF_8);
        String sha = java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        var session = runtime.beginUpload(new UploadRequest(tenant, principal, "fixture.bin",
                "application/octet-stream", bytes.length, sha, "INTERNAL", Duration.ofHours(1), Map.of()),
                "upload-" + runId);
        runtime.appendChunk(tenant, principal, session.uploadId(), 0, bytes);
        return runtime.completeUpload(tenant, principal, session.uploadId());
    }

    private static MediaProcessingProvider externalProvider(boolean asynchronous, AtomicInteger effects) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "external-effect-before-policy-denial"; }
            @Override public String providerVersion() { return "test-v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 1; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.EXTERNAL; }
            @Override public String processingRegion() { return "us"; }
            @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }
            @Override public boolean fallbackEligible(Throwable failure) { return true; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                effects.incrementAndGet(); // models a provider-side effect before its refusal is observed
                var denied = new MediaCapabilityNotAdmittedException(
                        MediaCapabilityNotAdmittedException.Reason.POLICY_DENIED,
                        "VISION", "provider denied after effect");
                if (asynchronous) return CompletableFuture.failedFuture(denied);
                throw denied;
            }
        };
    }

    private static MediaProcessingProvider outageProvider(AtomicInteger dispatches) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "fixture-provider-transport-outage"; }
            @Override public String providerVersion() { return "test-v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 1; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.EXTERNAL; }
            @Override public String processingRegion() { return "us"; }
            @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }
            @Override public boolean fallbackEligible(Throwable failure) { return true; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                dispatches.incrementAndGet();
                // The simulated transport breaks after handoff; no provider finality is returned.
                return CompletableFuture.failedFuture(new java.io.IOException("fixture connection reset"));
            }
        };
    }

    private static MediaProcessingProvider fallbackProvider(AtomicInteger calls) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "must-not-run-fallback"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 2; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                calls.incrementAndGet();
                return CompletableFuture.completedFuture(Map.of("fallback", true));
            }
        };
    }

    private static MediaConsentAuthority consentAuthority() {
        return new MediaConsentAuthority() {
            @Override public String authorityId() { return "test-consent"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public ConsentDecision verify(String tenant, String principal,
                    MediaGovernanceContext governance, String operation) {
                Instant now = Instant.now();
                return new ConsentDecision(true, "test-consent", governance.consentId(), now,
                        now.plusSeconds(300), Set.of(governance.purpose()), Set.of("us"), true, false,
                        Set.of(ProviderDataRetention.NONE));
            }
        };
    }

    private static com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated(
            String tenant, String principal) {
        return new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal(
                tenant, principal, Instant.now());
    }

    private static com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Authority
            sourceAuthorizationAuthority() {
        return new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Authority() {
            @Override public String authorityId() { return "fixture-source-authorization"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision resolve(
                    com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Request request,
                    com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated) {
                if (!authenticated.tenantId().equals(request.tenantId())
                        || !authenticated.principalId().equals(request.principalId())) {
                    return new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision(
                            com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.DENIED, null);
                }
                Instant now = Instant.now();
                var evidence = new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Evidence(
                        authorityId(), "fixture-decision-" + request.artifactId(),
                        request.tenantId(), request.principalId(), "fixture-owner", request.artifactId(),
                        request.sourceVersion(), request.sourceSha256(), request.operation(), request.purpose(),
                        request.providerId(), request.providerVersion(), request.processingBoundary(),
                        request.processingRegion(), request.providerRetention(),
                        Set.of(request.operation().toLowerCase(java.util.Locale.ROOT)),
                        Set.of(request.processingRegion()), Set.of(request.providerRetention()),
                        "fixture-rights", "fixture-policy", "fixture-policy-v1",
                        com.ghatana.media.runtime.MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                        com.ghatana.media.runtime.MediaSourceAuthorizationContracts
                                .HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                        "", "fixture-source-clock", 0, now.minusSeconds(1), now.plusSeconds(300));
                return new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision(
                        com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.ALLOWED, evidence);
            }
            @Override public com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision revalidate(
                    com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Request request,
                    com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Evidence expectedEvidence,
                    com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated) {
                return new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision(
                        com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.ALLOWED, expectedEvidence);
            }
        };
    }

    private static MediaGovernanceContext governance() {
        return new MediaGovernanceContext("consent-finality", "media-analysis", DataClassification.INTERNAL,
                "us", Set.of("us"), true, "short-lived", false, false, "",
                BiometricSensitivity.NONE, AutomationRisk.ASSISTIVE);
    }

    private static ProcessingJob awaitTerminal(
            MediaRuntime runtime, String tenant, String principal, String jobId)
            throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        ProcessingJob current;
        do {
            current = runtime.job(tenant, principal, jobId).orElseThrow();
            if (current.status() == JobStatus.OUTCOME_UNKNOWN || current.status() == JobStatus.FAILED
                    || current.status() == JobStatus.COMPLETED) return current;
            Thread.sleep(10);
        } while (System.nanoTime() < deadline);
        throw new AssertionError("Job did not reach a terminal status: " + current.status());
    }

    private static String readJobId(String tenant, String requestId) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT job_id FROM media_processing_jobs WHERE tenant_id=? AND request_id=?")) {
            statement.setString(1, tenant);
            statement.setString(2, requestId);
            try (var rows = statement.executeQuery()) {
                assertThat(rows.next()).isTrue();
                return rows.getString(1);
            }
        }
    }

    private static String postgresAttemptState(String tenant, String jobId) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT state FROM media_processing_attempts WHERE tenant_id=? AND job_id=?")) {
            statement.setString(1, tenant);
            statement.setString(2, jobId);
            try (var rows = statement.executeQuery()) {
                assertThat(rows.next()).isTrue();
                return rows.getString(1);
            }
        }
    }

    private static int unknownOutboxRows(String tenant, String jobId) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT COUNT(*) FROM media_processing_lifecycle_outbox WHERE tenant_id=? "
                             + "AND aggregate_id=? AND event_type LIKE '%unknown%'")) {
            statement.setString(1, tenant);
            statement.setString(2, jobId);
            try (var rows = statement.executeQuery()) {
                assertThat(rows.next()).isTrue();
                return rows.getInt(1);
            }
        }
    }

    private static S3Client s3() {
        return S3Client.builder().endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .build();
    }

    private static void deleteBucket(String bucket) {
        try (S3Client s3 = s3()) {
            var pages = s3.listObjectsV2Paginator(
                    software.amazon.awssdk.services.s3.model.ListObjectsV2Request.builder()
                            .bucket(bucket).build());
            for (var page : pages) {
                if (!page.contents().isEmpty()) {
                    s3.deleteObjects(software.amazon.awssdk.services.s3.model.DeleteObjectsRequest.builder()
                            .bucket(bucket).delete(software.amazon.awssdk.services.s3.model.Delete.builder()
                                    .objects(page.contents().stream().map(object ->
                                            software.amazon.awssdk.services.s3.model.ObjectIdentifier.builder()
                                                    .key(object.key()).build()).toList()).build()).build());
                }
            }
            s3.deleteBucket(software.amazon.awssdk.services.s3.model.DeleteBucketRequest.builder()
                    .bucket(bucket).build());
        } catch (RuntimeException cleanupFailure) {
            // The bucket is unique to this test and LocalStack is stopped by JUnit after the class.
        }
    }

    private static void deleteDirectory(java.nio.file.Path directory) {
        if (!Files.exists(directory)) return;
        try (var paths = Files.walk(directory)) {
            paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (java.io.IOException ignored) {
                    // Test cleanup is best effort; the temporary root is unique to this test.
                }
            });
        } catch (java.io.IOException ignored) {
            // Test cleanup is best effort; the temporary root is unique to this test.
        }
    }
}
