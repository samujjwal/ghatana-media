package com.ghatana.media.launcher;

import com.ghatana.media.provider.aws.PostgresqlMediaJobStore;
import com.ghatana.media.provider.aws.PostgresqlMediaLifecycleOutboxSource;
import com.ghatana.media.provider.aws.TestAwsStateInstall;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import org.junit.jupiter.api.Tag;
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

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
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

import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** A real PostgreSQL attempt-finality regression for unconfirmed local cancellation. */
@Tag("integration")
@Testcontainers(disabledWithoutDocker = true)
class MediaDevOnlyJobCancellationFinalityPostgresIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void definitiveProviderSuccessFinalizesAfterUnconfirmedCancellation() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-cancel-finality-" + run;
        String principal = "principal-cancel-finality-" + run;
        Path root = Files.createTempDirectory("media-dev-cancel-finality-");
        var completion = new CompletableFuture<ProviderSubmission>();
        var providerCalls = new AtomicInteger();
        var cancellationCalls = new AtomicInteger();
        String jobId;
        String bucket = "media-cancel-finality-" + run;
        try (S3Client s3 = s3()) {
            s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        AutoCloseable installed = TestAwsStateInstall.install(environment(bucket));
        try {
            try (var store = new PostgresqlMediaJobStore();
                 var outbox = new PostgresqlMediaLifecycleOutboxSource();
                 var runtime = runtime(root, store, outbox,
                         List.of(provider(completion, providerCalls, cancellationCalls)))) {
                assertThat(store.ready()).isTrue();
                var artifact = upload(runtime, tenant, principal, run);
                var job = runtime.submit(new ProcessingJobRequest(
                        "submit-" + run, tenant, principal, "cancel-finality-" + run,
                        artifact.artifactId(), artifact.version().value(), JobType.TRANSCODE,
                        "dev-cancel-finality-provider", Map.of()));
                jobId = job.jobId();
                awaitRunning(runtime, tenant, principal, jobId);

                var cancellation = runtime.cancelLocalDevelopmentJob(
                        tenant, principal, jobId, "cancel-" + run, null);
                assertThat(cancellation.outcome()).isEqualTo("REQUESTED_UNCONFIRMED");
                assertThat(cancellation.job().status()).isEqualTo(JobStatus.RUNNING);
                assertThat(cancellationCalls).hasValue(1);
                assertThat(providerCalls).hasValue(1);

                completion.complete(new ProviderSubmission(
                        AttemptFinality.SUCCEEDED, "op-" + run, "receipt-" + run,
                        Map.of("outputArtifactId", "derived-" + run), "a".repeat(64), Instant.now()));
                var completed = awaitTerminal(runtime, tenant, principal, jobId);
                assertThat(completed.status()).isEqualTo(JobStatus.COMPLETED);
                assertThat(completed.result()).containsEntry("outputArtifactId", "derived-" + run);

                var attempt = store.findProcessingAttempt(tenant, jobId, 1).orElseThrow();
                assertThat(attempt.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
                assertThat(attempt.providerOperationId()).isEqualTo("op-" + run);
                assertThat(attempt.providerReceiptId()).isEqualTo("receipt-" + run);
            }

            // Reconstruct both the PostgreSQL store and runtime over the same container. This
            // checks persisted job and attempt finality rather than an in-memory durable flag.
            installed.close();
            installed = TestAwsStateInstall.install(environment(bucket));
            try (var storeAfterRestart = new PostgresqlMediaJobStore();
                 var outboxAfterRestart = new PostgresqlMediaLifecycleOutboxSource();
                 var restarted = runtime(root, storeAfterRestart, outboxAfterRestart, List.of())) {
                var persisted = restarted.job(tenant, principal, jobId).orElseThrow();
                assertThat(persisted.status()).isEqualTo(JobStatus.COMPLETED);
                assertThat(persisted.result()).containsEntry("outputArtifactId", "derived-" + run);
                var attempt = storeAfterRestart.findProcessingAttempt(tenant, jobId, 1).orElseThrow();
                assertThat(attempt.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
                assertThat(attempt.providerReceiptId()).isEqualTo("receipt-" + run);
                assertThat(providerCalls).hasValue(1);
            }
        } finally {
            installed.close();
            try (S3Client s3 = s3()) {
                s3.deleteBucket(builder -> builder.bucket(bucket));
            }
            try (var paths = Files.walk(root)) {
                paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                    try { Files.deleteIfExists(path); } catch (Exception ignored) { }
                });
            }
        }
    }

    private static MediaRuntime runtime(
            Path root, PostgresqlMediaJobStore store, PostgresqlMediaLifecycleOutboxSource outbox,
            List<MediaProcessingProvider> providers) {
        MediaRuntimeConfig config = new MediaRuntimeConfig(true, "dev", 8093, 1_024, 128, 1_024,
                Duration.ofSeconds(10), 2, "", "", true, false, root);
        return new MediaRuntime(config, new LocalMediaRuntimeSupport.FileArtifactStore(root), store,
                new LocalMediaRuntimeSupport.StreamStore(), null,
                MediaSemanticRedactionRuntime.disabled(config.jobTimeout()), MediaLifecyclePublisher.disabled(),
                providers, List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()), List.of(outbox));
    }

    private static MediaProcessingProvider provider(
            CompletableFuture<ProviderSubmission> completion, AtomicInteger calls,
            AtomicInteger cancellationCalls) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "dev-cancel-finality-provider"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.TRANSCODE); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 1; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                return CompletableFuture.failedFuture(
                        new AssertionError("durable dispatch must use typed processAttempt"));
            }
            @Override public CompletableFuture<ProviderSubmission> processAttempt(
                    ProcessingContext context, ProviderAttemptContext attempt) {
                calls.incrementAndGet();
                return completion;
            }
            @Override public CancellationOutcome cancel(
                    String tenantId, String principalId, String correlationId, String jobId) {
                cancellationCalls.incrementAndGet();
                return CancellationOutcome.REQUESTED_UNCONFIRMED;
            }
        };
    }

    private static Map<String, String> environment(String bucket) {
        return Map.ofEntries(
                Map.entry("MEDIA_RUNTIME_ENVIRONMENT", "dev"),
                Map.entry("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl()),
                Map.entry("MEDIA_POSTGRES_USER", POSTGRES.getUsername()),
                Map.entry("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_CANCEL_FINALITY_DB_PASSWORD"),
                Map.entry("MEDIA_CANCEL_FINALITY_DB_PASSWORD", POSTGRES.getPassword()),
                Map.entry("MEDIA_POSTGRES_POOL_SIZE", "4"),
                Map.entry("MEDIA_S3_BUCKET", bucket),
                Map.entry("MEDIA_S3_REGION", LOCALSTACK.getRegion()),
                Map.entry("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString()),
                Map.entry("MEDIA_S3_PATH_STYLE", "true"),
                Map.entry("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_CANCEL_FINALITY_S3_ACCESS"),
                Map.entry("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_CANCEL_FINALITY_S3_SECRET"),
                Map.entry("MEDIA_CANCEL_FINALITY_S3_ACCESS", LOCALSTACK.getAccessKey()),
                Map.entry("MEDIA_CANCEL_FINALITY_S3_SECRET", LOCALSTACK.getSecretKey()));
    }

    private static S3Client s3() {
        return S3Client.builder().endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .build();
    }

    private static com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact upload(
            MediaRuntime runtime, String tenant, String principal, String run) throws Exception {
        byte[] bytes = ("provider-finality-source-" + run).getBytes(StandardCharsets.UTF_8);
        String digest = java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        var session = runtime.beginUpload(new UploadRequest(tenant, principal, "source.bin",
                "application/octet-stream", bytes.length, digest, "INTERNAL", Duration.ofMinutes(5), Map.of()),
                "source-" + run);
        runtime.appendChunk(tenant, principal, session.uploadId(), 0, bytes);
        return runtime.completeUpload(tenant, principal, session.uploadId());
    }

    private static void awaitRunning(MediaRuntime runtime, String tenant, String principal, String jobId)
            throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            JobStatus status = runtime.job(tenant, principal, jobId).orElseThrow().status();
            if (status == JobStatus.RUNNING) return;
            if (status != JobStatus.ACCEPTED) throw new AssertionError("job left active state before cancellation: " + status);
            Thread.sleep(10);
        }
        throw new AssertionError("job did not become RUNNING before cancellation");
    }

    private static ProcessingJob awaitTerminal(
            MediaRuntime runtime, String tenant, String principal, String jobId) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            var job = runtime.job(tenant, principal, jobId).orElseThrow();
            if (job.status() == JobStatus.COMPLETED || job.status() == JobStatus.FAILED
                    || job.status() == JobStatus.OUTCOME_UNKNOWN || job.status() == JobStatus.CANCELLED) return job;
            Thread.sleep(10);
        }
        throw new AssertionError("job did not become terminal after provider receipt");
    }
}
