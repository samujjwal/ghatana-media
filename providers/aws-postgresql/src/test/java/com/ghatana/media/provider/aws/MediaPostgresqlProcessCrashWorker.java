package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaLifecycleEvent;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobLease;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingAttempt;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptObservation;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDraft;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptSegment;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptSegmentTiming;

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
        if (args.length != 3 && args.length != 4) {
            throw new IllegalArgumentException("marker, tenant, job, and optional worker mode are required");
        }
        Path marker = Path.of(args[0]);
        String tenantId = args[1];
        String jobId = args[2];
        if (args.length == 4 && "commit-transcript".equals(args[3])) {
            commitTranscript(marker, tenantId, jobId);
            return;
        }
        try (PostgresqlMediaJobStore store = new PostgresqlMediaJobStore()) {
            if (args.length == 4 && "record-unknown".equals(args[3])) {
                commitMultimodalChildUnknown(store, marker, tenantId, jobId);
                return;
            }
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

    private static void commitTranscript(Path marker, String tenantId, String jobId) throws Exception {
        try (PostgresqlMediaJobStore store = new PostgresqlMediaJobStore();
             PostgresqlMediaTranscriptStore transcripts = new PostgresqlMediaTranscriptStore()) {
            ProcessingJob expected = store.find(tenantId, jobId).orElseThrow();
            ProcessingAttempt attempt = store.findProcessingAttempt(tenantId, jobId, 1).orElseThrow();
            String runId = jobId.substring("job-ip06-stt-".length());
            String transcriptId = jobId.replace("job-", "transcript-");
            String transcriptVersion = "transcript-version-" + runId;
            String text = "crash-safe transcript fixture";
            TranscriptSegment sourceTicks = new TranscriptSegment(
                    "decoded-span", text, "PROVIDER",
                    TranscriptSegmentTiming.sourceTicks(
                            0, 48_000, "source-clock-ip06-" + runId, 48_000, 96_000));
            Instant observedAt = Instant.ofEpochMilli(System.currentTimeMillis());
            Map<String, Object> response = Map.of(
                    "sourceArtifactVersionRef", expected.expectedArtifactVersion(),
                    "requestFingerprint", expected.requestFingerprint(),
                    "transcriptVersionRef", transcriptVersion,
                    "glossaryDisposition", "NOT_REQUESTED",
                    "transcriptText", text,
                    "segments", com.ghatana.media.runtime.MediaTranscriptContracts
                            .segmentsToParametersValue(java.util.List.of(sourceTicks)));
            Map<String, Object> result = Map.of("semanticObservations", Map.of(
                    "requestFingerprint", expected.requestFingerprint(),
                    "glossaryApplication", Map.of("disposition", "NOT_REQUESTED"),
                    "transcriptResponse", response));
            TranscriptDraft draft = new TranscriptDraft(
                    tenantId, expected.principalId(), transcriptId, expected.artifactId(),
                    expected.expectedArtifactVersion(), "c".repeat(64), jobId,
                    "profile-ip06-v1", expected.providerId(), "model-ip06-v1", "en-US", "milliseconds",
                    text, "consent-stt-" + runId, "rights-ip06-" + runId, "policy-v1",
                    "urn:media:purpose:transcription", "transcription", java.util.List.of(sourceTicks));
            ProcessingJob completed = new ProcessingJob(
                    expected.jobId(), expected.requestId(), expected.tenantId(), expected.principalId(),
                    expected.artifactId(), expected.jobType(), expected.providerId(), JobStatus.COMPLETED,
                    expected.createdAt(), expected.startedAt(), observedAt, Map.of("text", text), "",
                    expected.version() + 1, expected.expectedArtifactVersion(), expected.requestFingerprint());
            ProviderAttemptObservation observation = new ProviderAttemptObservation(
                    attempt.query(), AttemptFinality.SUCCEEDED, attempt.providerReceiptId(), result,
                    PROVENANCE_DIGEST, observedAt);
            MediaLifecycleEvent event = new MediaLifecycleEvent(
                    "media:ip06:stt:completed:" + jobId, "media.job.completed", tenantId,
                    expected.principalId(), expected.requestId(), expected.requestId(), "job", jobId,
                    completed.version(), "INTERNAL", observedAt, Map.of("status", "COMPLETED"));
            store.commitFinalOutcomeWithTranscript(expected, attempt, completed, observation, event,
                    transcripts, draft, transcriptVersion);
            write(marker, "COMMITTED");
            // Parent kills this child after PostgreSQL reports COMMIT returned.
            while (true) Thread.sleep(60_000);
        }
    }

    private static void commitMultimodalChildUnknown(
            PostgresqlMediaJobStore store, Path marker, String tenantId, String jobId) throws Exception {
        ProcessingJob expected = store.find(tenantId, jobId).orElseThrow();
        ProcessingAttempt dispatch = store.findProcessingAttempt(tenantId, jobId, 1).orElseThrow();
        JobLease lease = new JobLease(tenantId, jobId, "mm-child-fixture",
                dispatch.fencingToken(), Instant.now().plusSeconds(120));
        ProcessingAttempt withFixtureReceipt = store.recordProviderReceipt(
                dispatch, lease, "fixture-operation-" + jobId, "fixture-receipt-" + jobId);
        Instant observedAt = Instant.ofEpochMilli(System.currentTimeMillis());
        ProcessingJob unknown = new ProcessingJob(
                expected.jobId(), expected.requestId(), expected.tenantId(), expected.principalId(),
                expected.artifactId(), expected.jobType(), expected.providerId(), JobStatus.OUTCOME_UNKNOWN,
                expected.createdAt(), expected.startedAt(), observedAt,
                Map.of("reconciliation", "fixture outcome is intentionally unknown"),
                "PROCESSING_OUTCOME_UNKNOWN", expected.version() + 1,
                expected.expectedArtifactVersion(), expected.requestFingerprint());
        MediaLifecycleEvent event = new MediaLifecycleEvent(
                "media:mm-child:unknown:" + jobId, "media.job.outcome_unknown", tenantId,
                expected.principalId(), expected.requestId(), expected.requestId(), "job", jobId,
                unknown.version(), "INTERNAL", observedAt, Map.of("status", "OUTCOME_UNKNOWN"));
        store.markOutcomeUnknown(expected, withFixtureReceipt, unknown,
                Map.of("fixture", "synthetic child outcome; no provider effect asserted"), event);
        write(marker, "COMMITTED");

        // The caller kills this JVM after the commit marker, modelling abrupt worker loss.
        while (true) Thread.sleep(60_000);
    }

    private static void write(Path marker, String value) throws Exception {
        Files.writeString(marker, value, StandardCharsets.UTF_8);
    }
}
