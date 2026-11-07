package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaJobStore;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingAttempt;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptIdentity;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/** J-27 local fault journey: unresolved provider finality is never presented as success or auto-fallback. */
class MediaRuntimeProviderOutageJourneyTest {
    @Test
    void typedUnknownFinalityRemainsUnknownAndDoesNotDispatchFallback() throws Exception {
        var root = Files.createTempDirectory("media-j27-provider-unknown-");
        var primary = new UnknownProvider();
        var fallback = new CountingProvider();
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(3), 1, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                durableUnknownFinalityStore(new LocalMediaRuntimeSupport.JobStore()),
                new LocalMediaRuntimeSupport.StreamStore(), null,
                List.of(primary, fallback),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
        try {
            byte[] source = "j27-provider-outage".getBytes(StandardCharsets.UTF_8);
            var upload = runtime.beginUpload(new UploadRequest("tenant-j27", "principal-j27", "clip.bin",
                    "application/octet-stream", source.length, sha256(source), "CONFIDENTIAL",
                    Duration.ofHours(1), Map.of()), "j27-upload");
            runtime.appendChunk("tenant-j27", "principal-j27", upload.uploadId(), 0, source);
            var artifact = runtime.completeUpload("tenant-j27", "principal-j27", upload.uploadId());

            var accepted = runtime.submit(new ProcessingJobRequest("j27-request", "tenant-j27", "principal-j27",
                    "j27-correlation", artifact.artifactId(), JobType.VISION, "", Map.of()),
                    new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal(
                            "tenant-j27", "principal-j27", Instant.now()));
            assertThat(primary.dispatched().await(3, TimeUnit.SECONDS)).isTrue();

            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
            var observed = runtime.job("tenant-j27", "principal-j27", accepted.jobId()).orElseThrow();
            while (observed.status() == JobStatus.ACCEPTED || observed.status() == JobStatus.RUNNING) {
                assertThat(System.nanoTime()).isLessThan(deadline);
                Thread.sleep(5);
                observed = runtime.job("tenant-j27", "principal-j27", accepted.jobId()).orElseThrow();
            }

            assertThat(observed.tenantId()).isEqualTo("tenant-j27");
            assertThat(observed.principalId()).isEqualTo("principal-j27");
            assertThat(observed.artifactId()).isEqualTo(artifact.artifactId());
            assertThat(observed.requestId()).isEqualTo("j27-request");
            assertThat(observed.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
            assertThat(observed.failureCode()).isEqualTo("PROCESSING_OUTCOME_UNKNOWN");
            assertThat(observed.result()).containsEntry("providerOutcome", "UNKNOWN")
                    .doesNotContainKey("caption").doesNotContainKey("result");
            assertThat(primary.dispatches()).isEqualTo(1);
            assertThat(fallback.dispatches()).isZero();
        } finally {
            runtime.close();
        }
    }

    private static String sha256(byte[] value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
    }

    private static MediaJobStore durableUnknownFinalityStore(LocalMediaRuntimeSupport.JobStore delegate) {
        AtomicReference<ProcessingAttempt> attempt = new AtomicReference<>();
        return (MediaJobStore) Proxy.newProxyInstance(MediaJobStore.class.getClassLoader(),
                new Class<?>[] {MediaJobStore.class}, (proxy, method, args) -> {
                    try {
                        switch (method.getName()) {
                            case "durable" -> { return true; }
                            case "startAttempt" -> {
                                var accepted = (com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob) args[0];
                                var running = (com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob) args[1];
                                var lease = (com.ghatana.media.runtime.MediaRuntimeContracts.JobLease) args[2];
                                var stored = delegate.update(lease, accepted, running);
                                var started = new ProcessingAttempt(accepted.tenantId(), accepted.jobId(),
                                        accepted.requestId(), (Integer) args[3], lease.fencingToken(), (String) args[4],
                                        running.providerId(), "", "", com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality.UNKNOWN,
                                        "", "", Instant.now());
                                attempt.set(started);
                                return new com.ghatana.media.runtime.MediaRuntimeContracts.AttemptStart(stored, started);
                            }
                            case "recordProviderReceipt" -> {
                                var current = (ProcessingAttempt) args[0];
                                var recorded = new ProcessingAttempt(current.tenantId(), current.jobId(),
                                        current.requestId(), current.attemptNumber(), current.fencingToken(),
                                        current.requestFingerprint(), current.providerId(), (String) args[2], (String) args[3],
                                        com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality.UNKNOWN,
                                        "", "", Instant.now());
                                attempt.set(recorded);
                                return recorded;
                            }
                            case "findProcessingAttempt" -> { return java.util.Optional.ofNullable(attempt.get()); }
                            case "markOutcomeUnknown" ->
                                { return delegate.update((com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob) args[0],
                                        (com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob) args[2]); }
                            default -> { return method.invoke(delegate, args); }
                        }
                    } catch (InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                });
    }

    private static final class UnknownProvider implements MediaProcessingProvider {
        private final AtomicInteger dispatches = new AtomicInteger();
        private final CountDownLatch dispatched = new CountDownLatch(1);

        @Override public String providerId() { return "j27-unknown-provider"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 1; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }
        @Override public boolean fallbackEligible(Throwable failure) { return true; }
        @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            throw new AssertionError("typed provider finality is required");
        }
        @Override public java.util.Optional<ProviderAttemptIdentity> prepareAttemptIdentity(
                ProcessingJobRequest request, MediaArtifact artifact, ProviderAttemptContext attempt) {
            return java.util.Optional.of(new ProviderAttemptIdentity("j27-operation", "j27-receipt"));
        }
        @Override public CompletableFuture<ProviderSubmission> processAttempt(
                ProcessingContext context, ProviderAttemptContext attempt) {
            dispatches.incrementAndGet();
            dispatched.countDown();
            return CompletableFuture.completedFuture(ProviderSubmission.unknown());
        }
        int dispatches() { return dispatches.get(); }
        CountDownLatch dispatched() { return dispatched; }
    }

    private static final class CountingProvider implements MediaProcessingProvider {
        private final AtomicInteger dispatches = new AtomicInteger();
        @Override public String providerId() { return "j27-must-not-fallback"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 2; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }
        @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            dispatches.incrementAndGet();
            throw new AssertionError("J-27 UNKNOWN must not dispatch an unconfirmed fallback");
        }
        int dispatches() { return dispatches.get(); }
    }
}
