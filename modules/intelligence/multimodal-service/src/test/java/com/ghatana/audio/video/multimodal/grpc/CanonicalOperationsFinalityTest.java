package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class CanonicalOperationsFinalityTest {
    @Test
    void completedChildObservationFusesIntoTheExistingAudioResult() throws Exception {
        CanonicalOperationOutcome outcome = completed(List.of(child(
                JobType.SPEECH_TO_TEXT, JobStatus.COMPLETED, Map.of("text", "grounded words"))));

        var result = CanonicalOperations.toMultimodalResult(outcome, true, false);

        assertThat(result.getAudioResult().getTranscription()).isEqualTo("grounded words");
    }

    @Test
    void parentCompletionWithUnknownChildRemainsUnknownAndRetainsJobIdentity() {
        CanonicalOperationOutcome outcome = completed(List.of(child(
                JobType.SPEECH_TO_TEXT, JobStatus.OUTCOME_UNKNOWN, Map.of("text", "partial"))));

        assertThatThrownBy(() -> CanonicalOperations.toMultimodalResult(outcome, true, false))
                .isInstanceOfSatisfying(CanonicalOperationUnknownException.class, failure ->
                        assertThat(failure.jobId()).isEqualTo("job-mm-1"));
    }

    @Test
    void duplicateChildModalityCannotOverwriteTheGroundedResult() {
        CanonicalOperationOutcome outcome = completed(List.of(
                child(JobType.SPEECH_TO_TEXT, JobStatus.COMPLETED, Map.of("text", "first")),
                child(JobType.SPEECH_TO_TEXT, JobStatus.COMPLETED, Map.of("text", "replacement"))));

        assertThatThrownBy(() -> CanonicalOperations.toMultimodalResult(outcome, true, false))
                .isInstanceOfSatisfying(CanonicalOperationUnknownException.class, failure ->
                        assertThat(failure.jobId()).isEqualTo("job-mm-1"));
    }

    @Test
    void unselectedChildObservationCannotLeakIntoMultimodalFamilyNarrative() {
        CanonicalOperationOutcome outcome = completed(List.of(
                child(JobType.SPEECH_TO_TEXT, JobStatus.COMPLETED, Map.of("text", "grounded words")),
                child(JobType.VISION, JobStatus.COMPLETED, Map.of("caption", "unselected frame"))));

        assertThatThrownBy(() -> CanonicalOperations.toMultimodalResult(outcome, true, false))
                .isInstanceOfSatisfying(CanonicalOperationUnknownException.class, failure ->
                        assertThat(failure.jobId()).isEqualTo("job-mm-1"));
    }

    @Test
    void failedChildCannotBeFusedAsSuccessfulParentOutput() {
        CanonicalOperationOutcome outcome = completed(List.of(child(
                JobType.SPEECH_TO_TEXT, JobStatus.FAILED, Map.of("text", "untrusted"))));

        assertThatThrownBy(() -> CanonicalOperations.toMultimodalResult(outcome, true, false))
                .isInstanceOfSatisfying(CanonicalOperationFailedException.class, failure -> {
                    assertThat(failure.jobId()).isEqualTo("job-mm-1");
                    assertThat(failure.status()).isEqualTo(JobStatus.FAILED);
                });
    }

    @Test
    void cancelledChildCannotBeFusedAsSuccessfulParentOutput() {
        CanonicalOperationOutcome outcome = completed(List.of(child(
                JobType.SPEECH_TO_TEXT, JobStatus.CANCELLED, Map.of("text", "untrusted"))));

        assertThatThrownBy(() -> CanonicalOperations.toMultimodalResult(outcome, true, false))
                .isInstanceOfSatisfying(CanonicalOperationFailedException.class, failure -> {
                    assertThat(failure.jobId()).isEqualTo("job-mm-1");
                    assertThat(failure.status()).isEqualTo(JobStatus.CANCELLED);
                });
    }

    @Test
    void aSingleSuccessfulChildCannotCompleteARequestedTwoModalityFamily() {
        CanonicalOperationOutcome outcome = completed(List.of(child(
                JobType.SPEECH_TO_TEXT, JobStatus.COMPLETED, Map.of("text", "grounded words"))));

        assertThatThrownBy(() -> CanonicalOperations.toVideoAudioResult(outcome, true, true))
                .isInstanceOfSatisfying(CanonicalOperationUnknownException.class, failure ->
                        assertThat(failure.jobId()).isEqualTo("job-mm-1"));
    }

    @Test
    void selectedAudioOnlyOperationDoesNotRequireOrInventVideoResult() throws Exception {
        CanonicalOperationOutcome outcome = completed(List.of(child(
                JobType.SPEECH_TO_TEXT, JobStatus.COMPLETED, Map.of("text", "grounded words"))));

        var result = CanonicalOperations.toVideoAudioResult(outcome, true, false);

        assertThat(result.getAudioResult().getTranscription()).isEqualTo("grounded words");
        assertThat(result.getVideoResult()).isNull();
    }

    @Test
    void selectedVideoOnlyOperationDoesNotRequireOrInventAudioResult() throws Exception {
        CanonicalOperationOutcome outcome = completed(List.of(child(
                JobType.VISION, JobStatus.COMPLETED, Map.of("caption", "grounded frame"))));

        var result = CanonicalOperations.toVideoAudioResult(outcome, false, true);

        assertThat(result.getAudioResult()).isNull();
        assertThat(result.getVideoResult().getSceneDescription()).isEqualTo("grounded frame");
    }

    @Test
    void unknownSelectedChildRemainsUnknownWithoutPartialFamilyResult() {
        CanonicalOperationOutcome outcome = completed(List.of(child(
                JobType.SPEECH_TO_TEXT, JobStatus.OUTCOME_UNKNOWN, Map.of("text", "partial"))));

        assertThatThrownBy(() -> CanonicalOperations.toVideoAudioResult(outcome, true, false))
                .isInstanceOfSatisfying(CanonicalOperationUnknownException.class, failure ->
                        assertThat(failure.jobId()).isEqualTo("job-mm-1"));
    }

    @Test
    void unselectedChildObservationCannotBeFoldedIntoSelectedOperation() {
        CanonicalOperationOutcome outcome = completed(List.of(
                child(JobType.SPEECH_TO_TEXT, JobStatus.COMPLETED, Map.of("text", "grounded words")),
                child(JobType.VISION, JobStatus.COMPLETED, Map.of("caption", "unselected frame"))));

        assertThatThrownBy(() -> CanonicalOperations.toVideoAudioResult(outcome, true, false))
                .isInstanceOfSatisfying(CanonicalOperationUnknownException.class, failure ->
                        assertThat(failure.jobId()).isEqualTo("job-mm-1"));
    }

    private static CanonicalOperationOutcome completed(List<Map<String, Object>> observations) {
        return CanonicalOperationOutcome.completed(
                "job-mm-1", Map.of("observations", observations));
    }

    private static Map<String, Object> child(
            JobType type, JobStatus status, Map<String, Object> observations) {
        return Map.of(
                "childJobId", "child-" + type.name().toLowerCase(java.util.Locale.ROOT),
                "childRequestId", "request-" + type.name().toLowerCase(java.util.Locale.ROOT),
                "childJobType", type.name(),
                "childStatus", status.name(),
                "childResultDigest", "a".repeat(64),
                "observations", observations);
    }
}
