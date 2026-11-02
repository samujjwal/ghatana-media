package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaLifecycleEvent;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingAttempt;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptObservation;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Map;

/** Child JVM used by {@link MediaPostgresqlProcessCrashRecoveryTest}; it deliberately waits after commit. */
public final class MediaPostgresqlProcessCrashWorker {
    private static final String PROVENANCE_DIGEST =
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    private MediaPostgresqlProcessCrashWorker() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 3) throw new IllegalArgumentException("marker, tenant, and job are required");
        Path marker = Path.of(args[0]);
        String tenantId = args[1];
        String jobId = args[2];
        try (PostgresqlMediaJobStore store = new PostgresqlMediaJobStore()) {
            ProcessingJob expected = store.find(tenantId, jobId).orElseThrow();
            ProcessingAttempt attempt = store.findProcessingAttempt(tenantId, jobId, 1).orElseThrow();
            write(marker, "READY");

            Instant observedAt = Instant.ofEpochMilli(System.currentTimeMillis());
            Map<String, Object> result = Map.of("storedResult", "process-recovery-fixture");
            ProcessingJob completed = new ProcessingJob(
                    expected.jobId(), expected.requestId(), expected.tenantId(), expected.principalId(),
                    expected.artifactId(), expected.jobType(), expected.providerId(), JobStatus.COMPLETED,
                    expected.createdAt(), expected.startedAt(), observedAt, result, "", expected.version() + 1,
                    expected.expectedArtifactVersion(), expected.requestFingerprint());
            ProviderAttemptObservation observation = new ProviderAttemptObservation(
                    attempt.query(), AttemptFinality.SUCCEEDED, attempt.providerReceiptId(), result,
                    PROVENANCE_DIGEST, observedAt);
            MediaLifecycleEvent event = new MediaLifecycleEvent(
                    "media:ip06:completed:" + jobId, "media.job.completed", tenantId, expected.principalId(),
                    expected.requestId(), expected.requestId(), "job", jobId, completed.version(), "INTERNAL",
                    observedAt, Map.of("status", "COMPLETED"));
            store.commitFinalOutcome(expected, attempt, completed, observation, event);
            write(marker, "COMMITTED");

            // Keep the committed process alive so the parent can terminate it abruptly after the
            // durable method returns, matching an OS-level worker loss rather than close().
            while (true) Thread.sleep(60_000);
        }
    }

    private static void write(Path marker, String value) throws Exception {
        Files.writeString(marker, value, StandardCharsets.UTF_8);
    }
}
