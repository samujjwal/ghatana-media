package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.audio.video.multimodal.grpc.proto.CanonicalOperationBinding;
import com.ghatana.media.runtime.MediaCapabilityNotAdmittedException;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactContentReadReceipt;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadSession;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSpec;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentLinkedDeque;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Unit coverage of the durable MM operation executor's submit/await/finality split. */
class MediaCanonicalOperationExecutorTest {

    private static final String SHA = "ab".repeat(32);
    private static final AuthenticatedPrincipal AUTH =
            new AuthenticatedPrincipal("tenant-a", "principal-a", Instant.now());

    @Test
    void completedParentFusesAndSpecBindsArtifactDeclaredSourceClock() throws Exception {
        var port = new FixturePort().withSource(clockMetadata())
                .thenStatuses(JobStatus.RUNNING, JobStatus.COMPLETED);
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
        CanonicalOperation<CanonicalOperationOutcome> operation = operation();

        CanonicalOperationOutcome outcome = executor.execute(
                binding(), "op", operation, AUTH);

        assertThat(outcome.status()).isEqualTo(JobStatus.COMPLETED);
        ProcessingJobRequest submitted = port.submitted.peek();
        assertThat(submitted.jobType()).isEqualTo(JobType.MULTIMODAL);
        MultimodalOperationSpec spec = MultimodalOperationSpec.from(submitted);
        MultimodalOperationSpec.SourceClockBinding clock = spec.sourceClock();
        assertThat(clock).isNotNull();
        assertThat(clock.clockId()).isEqualTo("src-clock");
        assertThat(clock.evidenceRef()).isEqualTo("ev-1");
        assertThat(clock.ticksPerSecond()).isEqualTo(48_000);
        assertThat(clock.durationTicks()).isEqualTo(96_000);
        assertThat(spec.children()).hasSize(1);
    }

    @Test
    void parentStillRunningAtDeadlineThrowsUnknownCarryingJobId() {
        var port = new FixturePort().withSource(Map.of())
                .thenStatuses(JobStatus.RUNNING);
        var executor = executor(port, Duration.ofMillis(40), Duration.ofMillis(5));
        assertThatThrownBy(() -> executor.execute(binding(), "op", operation(), AUTH))
                .isInstanceOf(CanonicalOperationUnknownException.class)
                .satisfies(error -> assertThat(
                        ((CanonicalOperationUnknownException) error).jobId()).isEqualTo("job-1"));
    }

    @Test
    void outcomeUnknownParentThrowsUnknownCarryingJobId() {
        var port = new FixturePort().withSource(Map.of())
                .thenStatuses(JobStatus.OUTCOME_UNKNOWN);
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
        assertThatThrownBy(() -> executor.execute(binding(), "op", operation(), AUTH))
                .isInstanceOf(CanonicalOperationUnknownException.class)
                .satisfies(error -> assertThat(
                        ((CanonicalOperationUnknownException) error).jobId()).isEqualTo("job-1"));
    }

    @Test
    void failedParentReachesFusionAsTypedFailedOutcome() {
        var port = new FixturePort().withSource(Map.of())
                .thenStatuses(JobStatus.FAILED);
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
        CanonicalOperation<Object> operation = CanonicalOperations.of(
                CanonicalOperations.plan("cap", List.of(
                        CanonicalOperations.childArtifact("stt", JobType.SPEECH_TO_TEXT, "child-art"))),
                () -> null,
                CanonicalOperations::toVideoAudioResult);
        assertThatThrownBy(() -> executor.execute(binding(), "op", operation, AUTH))
                .isInstanceOf(CanonicalOperationFailedException.class)
                .satisfies(error -> {
                    assertThat(((CanonicalOperationFailedException) error).jobId()).isEqualTo("job-1");
                    assertThat(((CanonicalOperationFailedException) error).failureCode())
                            .isEqualTo("CHILD_FAILED");
                });
    }

    @Test
    void postSubmitReadbackFailureThrowsUnknownCarryingJobId() {
        var port = new FixturePort().withSource(Map.of());
        port.jobFailure = new IllegalStateException("readback lost");
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
        assertThatThrownBy(() -> executor.execute(binding(), "op", operation(), AUTH))
                .isInstanceOf(CanonicalOperationUnknownException.class)
                .satisfies(error -> assertThat(
                        ((CanonicalOperationUnknownException) error).jobId()).isEqualTo("job-1"));
    }

    @Test
    void missingSourceArtifactFailsValidationBeforeSubmit() {
        var port = new FixturePort();
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
        assertThatThrownBy(() -> executor.execute(binding(), "op", operation(), AUTH))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(port.submitted).isEmpty();
    }

    @Test
    void admissionRefusalAndSubmitAmbiguityKeepDistinctFinality() {
        var denied = new FixturePort().withSource(Map.of());
        denied.submitFailure = new MediaCapabilityNotAdmittedException(
                MediaCapabilityNotAdmittedException.Reason.NOT_ADMITTED, "MULTIMODAL", "denied");
        var executor = executor(denied, Duration.ofSeconds(5), Duration.ofMillis(5));
        assertThatThrownBy(() -> executor.execute(binding(), "op", operation(), AUTH))
                .isInstanceOf(MediaCapabilityNotAdmittedException.class);

        var ambiguous = new FixturePort().withSource(Map.of());
        ambiguous.submitFailure = new IllegalStateException("connection lost mid-submit");
        var executor2 = executor(ambiguous, Duration.ofSeconds(5), Duration.ofMillis(5));
        assertThatThrownBy(() -> executor2.execute(binding(), "op", operation(), AUTH))
                .isInstanceOf(CanonicalOperationUnknownException.class)
                .satisfies(error -> assertThat(
                        ((CanonicalOperationUnknownException) error).jobId()).isNull());
    }

    @Test
    void malformedArtifactClockMetadataFailsClosed() {
        var port = new FixturePort().withSource(Map.of(
                "sourceClockMappingEvidenceRef", "ev-1",
                "sourceClockTicksPerSecond", "not-a-number"));
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
        assertThatThrownBy(() -> executor.execute(binding(), "op", operation(), AUTH))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(port.submitted).isEmpty();
    }

    @Test
    void inlineChildBytesIngestThroughCanonicalUploadBeforeSubmit() throws Exception {
        byte[] payload = "pcm-fixture".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        var port = new FixturePort().withSource(Map.of())
                .thenStatuses(JobStatus.COMPLETED);
        var executor = executor(port, Duration.ofSeconds(5), Duration.ofMillis(5));
        CanonicalOperation<CanonicalOperationOutcome> operation = CanonicalOperations.of(
                CanonicalOperations.plan("cap", List.of(
                        CanonicalOperations.childInline(
                                "stt", JobType.SPEECH_TO_TEXT, payload, "audio/wav"))),
                () -> null, outcome -> outcome);

        executor.execute(binding(), "op", operation, AUTH);

        assertThat(port.uploads).hasSize(1);
        assertThat(port.uploads.peek().expectedSha256()).isEqualTo(sha256(payload));
        ProcessingJobRequest submitted = port.submitted.peek();
        MultimodalOperationSpec spec = MultimodalOperationSpec.from(submitted);
        var child = spec.child("stt");
        assertThat(child.artifactId()).isEqualTo("uploaded-art");
        assertThat(child.artifactSha256()).isEqualTo(sha256(payload));
    }

    // ── Fixtures ────────────────────────────────────────────────────────────

    private static MediaCanonicalOperationExecutor executor(
            FixturePort port, Duration deadline, Duration poll) {
        return new MediaCanonicalOperationExecutor(port, deadline, poll, Clock.systemUTC());
    }

    private static CanonicalOperation<CanonicalOperationOutcome> operation() {
        return CanonicalOperations.of(
                CanonicalOperations.plan("cap", List.of(
                        CanonicalOperations.childArtifact("stt", JobType.SPEECH_TO_TEXT, "child-art"))),
                () -> null, outcome -> outcome);
    }

    private static CanonicalOperationBinding binding() {
        return CanonicalOperationBinding.newBuilder()
                .setCapabilityRef("cap")
                .setOperationRef("op")
                .setOperationVersion(1)
                .setRequestId("req-mm-1")
                .setSourceArtifactId("src")
                .setSourceVersionId("sha256:" + SHA)
                .setPurpose("mm-observe")
                .build();
    }

    private static Map<String, Object> clockMetadata() {
        return Map.of("sourceClockId", "src-clock",
                "sourceClockMappingEvidenceRef", "ev-1",
                "sourceClockTicksPerSecond", 48_000,
                "sourceDurationTicks", 96_000);
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static final class FixturePort implements MediaProcessingRuntimePort {
        private final Deque<ProcessingJobRequest> submitted = new ConcurrentLinkedDeque<>();
        private final Deque<UploadRequest> uploads = new ConcurrentLinkedDeque<>();
        private final Deque<JobStatus> statuses = new ArrayDeque<>();
        private MediaArtifact source;
        private RuntimeException submitFailure;
        private RuntimeException jobFailure;

        FixturePort withSource(Map<String, Object> metadata) {
            this.source = artifact("src", SHA, metadata);
            return this;
        }

        FixturePort thenStatuses(JobStatus... sequence) {
            statuses.addAll(List.of(sequence));
            return this;
        }

        private static MediaArtifact artifact(String id, String sha, Map<String, Object> metadata) {
            return new MediaArtifact("tenant-a", "principal-a", id, id + ".bin",
                    "application/octet-stream", 4, sha, "ref", "CONFIDENTIAL",
                    Instant.now(), Instant.now().plusSeconds(3_600), metadata);
        }

        @Override public ProcessingJob submit(ProcessingJobRequest request) {
            return submit(request, AUTH);
        }

        @Override public ProcessingJob submit(
                ProcessingJobRequest request, AuthenticatedPrincipal authenticated) {
            if (submitFailure != null) throw submitFailure;
            submitted.add(request);
            return job("job-1", request.requestId(), JobStatus.ACCEPTED, Map.of());
        }

        @Override public Optional<ProcessingJob> job(
                String tenantId, String principalId, String jobId) {
            if (jobFailure != null) throw jobFailure;
            JobStatus status = statuses.isEmpty() ? JobStatus.RUNNING
                    : statuses.size() == 1 ? statuses.peek() : statuses.poll();
            Map<String, Object> result = status == JobStatus.COMPLETED
                    ? Map.of("observations", List.of(Map.of(
                            "childJobType", "SPEECH_TO_TEXT",
                            "observations", Map.of("text", "grounded"))))
                    : Map.of();
            String failureCode = status == JobStatus.FAILED ? "CHILD_FAILED" : "";
            return Optional.of(job(jobId, "req-mm-1", status, result, failureCode));
        }

        private static ProcessingJob job(String jobId, String requestId, JobStatus status,
                                         Map<String, Object> result) {
            return job(jobId, requestId, status, result, "");
        }

        private static ProcessingJob job(String jobId, String requestId, JobStatus status,
                                         Map<String, Object> result, String failureCode) {
            return new ProcessingJob(jobId, requestId, "tenant-a", "principal-a", "src",
                    JobType.MULTIMODAL, "mm", status, Instant.now(), Instant.now(),
                    status == JobStatus.ACCEPTED || status == JobStatus.RUNNING
                            ? null : Instant.now(),
                    result, failureCode, 1, "sha256:" + SHA, "sha256:" + SHA);
        }

        @Override public Optional<MediaArtifact> artifact(
                String tenantId, String principalId, String artifactId) {
            if (source != null && artifactId.equals(source.artifactId())) {
                return Optional.of(source);
            }
            if ("child-art".equals(artifactId)) {
                return Optional.of(artifact("child-art", SHA, Map.of()));
            }
            if ("uploaded-art".equals(artifactId)) {
                return Optional.of(artifact("uploaded-art", SHA, Map.of()));
            }
            return Optional.empty();
        }

        @Override public UploadSession beginUpload(
                UploadRequest request, String idempotencyKey, AuthenticatedPrincipal authenticated) {
            uploads.add(request);
            return new UploadSession("up-1", request.tenantId(), request.principalId(),
                    request.fileName(), request.contentType(), request.expectedSizeBytes(),
                    request.expectedSha256(), request.classification(), Instant.now(),
                    Instant.now().plusSeconds(3_600), 0, 0,
                    UploadStatus.OPEN, request.metadata());
        }

        @Override public UploadSession appendUploadChunk(
                AuthenticatedPrincipal authenticated, String uploadId, int chunkIndex, byte[] bytes) {
            UploadRequest request = uploads.peek();
            return new UploadSession(uploadId, authenticated.tenantId(), authenticated.principalId(),
                    request.fileName(), request.contentType(), request.expectedSizeBytes(),
                    request.expectedSha256(), request.classification(), Instant.now(),
                    Instant.now().plusSeconds(3_600), 0, chunkIndex + 1,
                    UploadStatus.OPEN, request.metadata());
        }

        @Override public MediaArtifact completeUpload(
                AuthenticatedPrincipal authenticated, String uploadId) {
            return artifact("uploaded-art", uploads.peek().expectedSha256(), Map.of());
        }
    }
}
