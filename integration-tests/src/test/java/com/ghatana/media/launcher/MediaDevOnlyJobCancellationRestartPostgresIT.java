package com.ghatana.media.launcher;

import com.ghatana.media.provider.aws.PostgresqlMediaJobStore;
import com.ghatana.media.provider.aws.PostgresqlMediaLifecycleOutboxSource;
import com.ghatana.media.provider.aws.TestAwsStateInstall;
import com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
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
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** Proves the DEV_ONLY cancellation identity survives runtime restart in PostgreSQL. */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevOnlyJobCancellationRestartPostgresIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void unknownDispatchReplaysAfterRuntimeRestartWithoutRedispatch() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-dev-cancel-" + run;
        String tenant = "tenant-dev-cancel-" + run;
        String principal = "principal-dev-cancel-" + run;
        String jobId;
        String requestId = "cancel-stable-" + run;
        try (S3Client s3 = s3()) {
            s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        var installed = TestAwsStateInstall.install(environment(bucket));
        var stateKeeper = new PostgresqlMediaJobStore();
        var cancellations = new AtomicInteger();
        var root = Files.createTempDirectory("media-dev-cancel-restart-");
        try {
            assertThat(stateKeeper.ready()).isTrue();
            MediaRuntime.DevOnlyJobCancellationResult first;
            try (PostgresqlMediaJobStore store = new PostgresqlMediaJobStore();
                 PostgresqlMediaLifecycleOutboxSource outbox = new PostgresqlMediaLifecycleOutboxSource();
                 MediaRuntime runtime = runtime(root, cancellations, store, outbox)) {
                var artifact = upload(runtime, tenant, principal, run);
                var job = runtime.submit(new ProcessingJobRequest(
                        "submit-" + run, tenant, principal, "cancel-restart-correlation-" + run,
                        artifact.artifactId(), JobType.TRANSCODE, "dev-cancel-restart-provider", Map.of()));
                awaitRunning(runtime, tenant, principal, job.jobId());
                jobId = job.jobId();
                first = runtime.cancelLocalDevelopmentJob(tenant, principal, jobId, requestId, null);
            }
            assertThat(first.scope()).isEqualTo("DEV_ONLY");
            assertThat(first.outcome()).isEqualTo("OUTCOME_UNKNOWN");
            assertThat(first.replayed()).isFalse();
            assertThat(cancellations).hasValue(1);

            try (PostgresqlMediaJobStore store = new PostgresqlMediaJobStore();
                 PostgresqlMediaLifecycleOutboxSource outbox = new PostgresqlMediaLifecycleOutboxSource();
                 MediaRuntime restarted = runtime(root, cancellations, store, outbox)) {
                var replay = restarted.cancelLocalDevelopmentJob(tenant, principal, jobId, requestId, null);
                assertThat(replay.requestId()).isEqualTo(requestId);
                assertThat(replay.outcome()).isEqualTo("OUTCOME_UNKNOWN");
                assertThat(replay.replayed()).isTrue();
                assertThat(cancellations).hasValue(1);
                assertThat(replay.job().result()).containsKey("devOnlyCancellation");
            }
        } finally {
            stateKeeper.close();
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

    @Test
    void hardProcessLossDuringCancelDispatchReplaysUnknownWithoutRedispatch() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-dev-cancel-cut-" + run;
        String tenant = "tenant-dev-cancel-cut-" + run;
        String principal = "principal-dev-cancel-cut-" + run;
        String requestId = "cancel-hard-loss-" + run;
        try (S3Client s3 = s3()) {
            s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        var installed = TestAwsStateInstall.install(environment(bucket));
        Path root = Files.createTempDirectory("media-dev-cancel-hard-loss-");
        Path marker = root.resolve("cancel-entered.marker");
        Path calls = root.resolve("cancel-calls.txt");
        Path log = root.resolve("cancel-worker.log");
        Process worker = null;
        try (PostgresqlMediaJobStore stateKeeper = new PostgresqlMediaJobStore()) {
            assertThat(stateKeeper.ready()).isTrue();
            worker = startCancellationCutWorker(root, marker, calls, run, tenant, principal, requestId,
                    environment(bucket), log);
            awaitMarker(worker, marker, log);

            // The fake provider has entered cancel only after MediaRuntime committed the
            // DISPATCH_STARTED reservation. Kill the whole JVM at this ambiguous cut.
            worker.destroyForcibly();
            assertThat(worker.waitFor(15, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            String jobId = Files.readString(marker, StandardCharsets.UTF_8).trim();
            assertThat(jobId).isNotBlank();
            assertThat(Files.readString(calls, StandardCharsets.UTF_8)).isEqualTo("1");

            try (PostgresqlMediaJobStore store = new PostgresqlMediaJobStore();
                 PostgresqlMediaLifecycleOutboxSource outbox = new PostgresqlMediaLifecycleOutboxSource();
                 MediaRuntime restarted = runtimeWithProvider(
                         root, store, outbox, countingCancelProvider(calls))) {
                var replay = restarted.cancelLocalDevelopmentJob(
                        tenant, principal, jobId, requestId, null);
                assertThat(replay.scope()).isEqualTo("DEV_ONLY");
                assertThat(replay.requestId()).isEqualTo(requestId);
                assertThat(replay.outcome()).isEqualTo("OUTCOME_UNKNOWN");
                assertThat(replay.replayed()).isTrue();
                @SuppressWarnings("unchecked")
                Map<String, Object> cancellation = (Map<String, Object>) replay.job().result()
                        .get("devOnlyCancellation");
                @SuppressWarnings("unchecked")
                Map<String, Object> durableCancellation = (Map<String, Object>) stateKeeper
                        .find(tenant, jobId).orElseThrow().result().get("devOnlyCancellation");
                assertThat(cancellation)
                        .containsEntry("requestId", requestId)
                        .containsEntry("outcome", "DISPATCH_STARTED")
                        .containsEntry("requestFingerprint", durableCancellation.get("requestFingerprint"));
                assertThat(cancellation.get("requestFingerprint")).as("persisted cancellation fingerprint")
                        .isInstanceOf(String.class).asString().matches("[a-f0-9]{64}");
                assertThat(Files.readString(calls, StandardCharsets.UTF_8)).isEqualTo("1");
            }
        } finally {
            if (worker != null && worker.isAlive()) worker.destroyForcibly().waitFor(15,
                    java.util.concurrent.TimeUnit.SECONDS);
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
            java.nio.file.Path root,
            AtomicInteger cancellations,
            PostgresqlMediaJobStore jobStore,
            PostgresqlMediaLifecycleOutboxSource outbox) {
        MediaRuntimeConfig config = new MediaRuntimeConfig(true, "dev", 8093, 1_024, 128, 1_024,
                Duration.ofSeconds(5), 2, "", "", true, false, root);
        MediaProcessingProvider provider = new MediaProcessingProvider() {
            @Override public String providerId() { return "dev-cancel-restart-provider"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.TRANSCODE); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 1; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                return new CompletableFuture<>();
            }
            @Override public CancellationOutcome cancel(
                    String tenantId, String principalId, String correlationId, String requestedJobId) {
                cancellations.incrementAndGet();
                throw new IllegalStateException("cancellation acknowledgement was lost");
            }
        };
        return new MediaRuntime(config, new LocalMediaRuntimeSupport.FileArtifactStore(root),
                jobStore, new LocalMediaRuntimeSupport.StreamStore(), null,
                MediaSemanticRedactionRuntime.disabled(config.jobTimeout()), MediaLifecyclePublisher.disabled(),
                List.of(provider), List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()), List.of(outbox));
    }

    private static MediaRuntime runtimeWithProvider(
            Path root, PostgresqlMediaJobStore jobStore, PostgresqlMediaLifecycleOutboxSource outbox,
            MediaProcessingProvider provider) {
        MediaRuntimeConfig config = new MediaRuntimeConfig(true, "dev", 8093, 1_024, 128, 1_024,
                Duration.ofSeconds(5), 2, "", "", true, false, root);
        return new MediaRuntime(config, new LocalMediaRuntimeSupport.FileArtifactStore(root),
                jobStore, new LocalMediaRuntimeSupport.StreamStore(), null,
                MediaSemanticRedactionRuntime.disabled(config.jobTimeout()), MediaLifecyclePublisher.disabled(),
                List.of(provider), List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()), List.of(outbox));
    }

    private static MediaProcessingProvider countingCancelProvider(Path calls) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "dev-cancel-restart-provider"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.TRANSCODE); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 1; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                return new CompletableFuture<>();
            }
            @Override public CancellationOutcome cancel(
                    String tenantId, String principalId, String correlationId, String jobId) {
                try {
                    int count = Integer.parseInt(Files.readString(calls, StandardCharsets.UTF_8).trim());
                    Files.writeString(calls, Integer.toString(count + 1), StandardCharsets.UTF_8);
                    return CancellationOutcome.UNSUPPORTED;
                } catch (Exception failure) {
                    throw new IllegalStateException("failed to record cancellation replay", failure);
                }
            }
        };
    }

    private static Process startCancellationCutWorker(
            Path root, Path marker, Path calls, String run, String tenant, String principal, String requestId,
            Map<String, String> environment, Path log) throws Exception {
        String classpath = System.getProperty("media.child.classpath", "");
        if (classpath.isBlank()) throw new IllegalStateException("Gradle did not provide media.child.classpath");
        Path java = Path.of(System.getProperty("java.home"), "bin", "java");
        ProcessBuilder builder = new ProcessBuilder(java.toString(), "-cp", classpath,
                CancellationCutWorker.class.getName(), root.toString(), marker.toString(), calls.toString(),
                run, tenant, principal, requestId);
        builder.environment().putAll(environment);
        builder.redirectErrorStream(true);
        builder.redirectOutput(log.toFile());
        return builder.start();
    }

    private static void awaitMarker(Process process, Path marker, Path log) throws Exception {
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) {
            if (Files.exists(marker)) return;
            if (!process.isAlive()) {
                throw new AssertionError("worker exited before cancellation dispatch marker: "
                        + Files.readString(log, StandardCharsets.UTF_8));
            }
            Thread.sleep(25);
        }
        throw new AssertionError("timed out waiting for cancellation dispatch marker: "
                + Files.readString(log, StandardCharsets.UTF_8));
    }

    /** Child JVM fixture: calls only a test LOCAL provider and blocks after its cancel callback starts. */
    public static final class CancellationCutWorker {
        private CancellationCutWorker() { }

        public static void main(String[] args) throws Exception {
            Path root = Path.of(args[0]);
            Path marker = Path.of(args[1]);
            Path calls = Path.of(args[2]);
            String run = args[3];
            String tenant = args[4];
            String principal = args[5];
            String requestId = args[6];
            String bucket = System.getenv("MEDIA_S3_BUCKET");
            AutoCloseable installed = TestAwsStateInstall.install(environmentFromProcess(bucket));
            try (PostgresqlMediaJobStore store = new PostgresqlMediaJobStore();
                 PostgresqlMediaLifecycleOutboxSource outbox = new PostgresqlMediaLifecycleOutboxSource()) {
                MediaProcessingProvider provider = new MediaProcessingProvider() {
                    @Override public String providerId() { return "dev-cancel-restart-provider"; }
                    @Override public Set<JobType> capabilities() { return Set.of(JobType.TRANSCODE); }
                    @Override public boolean ready() { return true; }
                    @Override public boolean productionEligible() { return false; }
                    @Override public int priority() { return 1; }
                    @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
                    @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                        return new CompletableFuture<>();
                    }
                    @Override public CancellationOutcome cancel(
                            String tenantId, String principalId, String correlationId, String jobId) {
                        try {
                            Files.writeString(calls, "1", StandardCharsets.UTF_8);
                            Files.writeString(marker, jobId, StandardCharsets.UTF_8);
                            while (true) Thread.sleep(60_000);
                        } catch (InterruptedException interrupted) {
                            Thread.currentThread().interrupt();
                            throw new IllegalStateException("worker interrupted during fake cancellation", interrupted);
                        } catch (Exception failure) {
                            throw new IllegalStateException("failed to publish cancellation cut marker", failure);
                        }
                    }
                };
                try (MediaRuntime runtime = runtimeWithProvider(root, store, outbox, provider)) {
                    var artifact = upload(runtime, tenant, principal, run);
                    var job = runtime.submit(new ProcessingJobRequest(
                            "submit-hard-loss-" + run, tenant, principal, "cancel-hard-loss-correlation-" + run,
                            artifact.artifactId(), JobType.TRANSCODE, "dev-cancel-restart-provider", Map.of()));
                    awaitRunning(runtime, tenant, principal, job.jobId());
                    runtime.cancelLocalDevelopmentJob(tenant, principal, job.jobId(), requestId, null);
                }
            } finally {
                installed.close();
            }
        }
    }

    private static Map<String, String> environmentFromProcess(String bucket) {
        Map<String, String> result = new HashMap<>();
        for (String key : List.of("MEDIA_RUNTIME_ENVIRONMENT", "MEDIA_POSTGRES_JDBC_URL", "MEDIA_POSTGRES_USER",
                "MEDIA_POSTGRES_PASSWORD_REFERENCE", "MEDIA_DEV_CANCEL_DB_PASSWORD", "MEDIA_POSTGRES_POOL_SIZE",
                "MEDIA_S3_ENDPOINT", "MEDIA_S3_REGION", "MEDIA_S3_PATH_STYLE",
                "MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "MEDIA_S3_ACCESS_KEY_REFERENCE",
                "MEDIA_S3_SECRET_KEY_REFERENCE", "MEDIA_DEV_CANCEL_S3_ACCESS", "MEDIA_DEV_CANCEL_S3_SECRET")) {
            String value = System.getenv(key);
            if (value != null) result.put(key, value);
        }
        result.put("MEDIA_S3_BUCKET", bucket);
        return result;
    }

    private static Map<String, String> environment(String bucket) {
        return Map.ofEntries(
                Map.entry("MEDIA_RUNTIME_ENVIRONMENT", "dev"),
                Map.entry("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl()),
                Map.entry("MEDIA_POSTGRES_USER", POSTGRES.getUsername()),
                Map.entry("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_DEV_CANCEL_DB_PASSWORD"),
                Map.entry("MEDIA_DEV_CANCEL_DB_PASSWORD", POSTGRES.getPassword()),
                Map.entry("MEDIA_POSTGRES_POOL_SIZE", "4"),
                Map.entry("MEDIA_S3_BUCKET", bucket),
                Map.entry("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString()),
                Map.entry("MEDIA_S3_REGION", LOCALSTACK.getRegion()),
                Map.entry("MEDIA_S3_PATH_STYLE", "true"),
                Map.entry("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED"),
                Map.entry("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_DEV_CANCEL_S3_ACCESS"),
                Map.entry("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_DEV_CANCEL_S3_SECRET"),
                Map.entry("MEDIA_DEV_CANCEL_S3_ACCESS", LOCALSTACK.getAccessKey()),
                Map.entry("MEDIA_DEV_CANCEL_S3_SECRET", LOCALSTACK.getSecretKey()));
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
        byte[] bytes = ("durable-dev-cancel-source-" + run).getBytes(StandardCharsets.UTF_8);
        String digest = java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        var session = runtime.beginUpload(new UploadRequest(tenant, principal, "source.bin",
                "application/octet-stream", bytes.length, digest, "INTERNAL", Duration.ofMinutes(5), Map.of()),
                "source-" + run);
        runtime.appendChunk(tenant, principal, session.uploadId(), 0, bytes);
        return runtime.completeUpload(tenant, principal, session.uploadId());
    }

    private static void awaitRunning(MediaRuntime runtime, String tenant, String principal, String jobId)
            throws Exception {
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            JobStatus status = runtime.job(tenant, principal, jobId).orElseThrow().status();
            if (status == JobStatus.RUNNING) return;
            if (status != JobStatus.ACCEPTED) throw new AssertionError("job left active state before cancellation: " + status);
            Thread.sleep(10);
        }
        throw new AssertionError("job did not become RUNNING before cancellation");
    }
}
