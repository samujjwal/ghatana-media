package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.audio.video.multimodal.engine.AudioResult;
import com.ghatana.audio.video.multimodal.engine.MultimodalResult;
import com.ghatana.audio.video.multimodal.engine.VideoAudioResult;
import com.ghatana.audio.video.multimodal.engine.VisualResult;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.Callable;

/**
 * Builders for typed canonical operations used by the multimodal gRPC service. Plans are
 * serializable child selections; fusions map the durably grounded parent result into the
 * existing engine projections. No family aggregate PARTIAL is ever produced: a fused
 * result requires every declared child's grounded observation.
 */
final class CanonicalOperations {
    private CanonicalOperations() { }

    interface Fusion<T> { T apply(CanonicalOperationOutcome outcome) throws Exception; }

    static <T> CanonicalOperation<T> of(
            CanonicalOperationPlan plan, Callable<T> fixtureAction, Fusion<T> fusion) {
        return new CanonicalOperation<>() {
            @Override public CanonicalOperationPlan plan() { return plan; }
            @Override public Callable<T> fixtureAction() { return fixtureAction; }
            @Override public T fuse(CanonicalOperationOutcome outcome) throws Exception {
                return fusion.apply(outcome);
            }
        };
    }

    static CanonicalOperationPlan plan(
            String capabilityRef, List<CanonicalChildSelection> children) {
        return new CanonicalOperationPlan(capabilityRef, children, null);
    }

    static CanonicalChildSelection childArtifact(
            String childKey, JobType jobType, String artifactId) {
        return new CanonicalChildSelection(
                childKey, jobType, artifactId, null, null, "", Map.of());
    }

    static CanonicalChildSelection childInline(
            String childKey, JobType jobType, byte[] inlineSource, String contentType) {
        return new CanonicalChildSelection(
                childKey, jobType, "", inlineSource, contentType, "", Map.of());
    }

    /** Selects the inline payload when present, otherwise the durable source artifact. */
    static CanonicalChildSelection childSource(
            String childKey, JobType jobType, byte[] inlineSource,
            String contentType, String sourceArtifactId) {
        return inlineSource != null && inlineSource.length > 0
                ? childInline(childKey, jobType, inlineSource, contentType)
                : childArtifact(childKey, jobType, sourceArtifactId);
    }

    // ── Grounded fusions ─────────────────────────────────────────────────────

    /** Requires one grounded observation per declared child job type. */
    static Map<JobType, Map<String, Object>> requireGroundedChildren(
            CanonicalOperationOutcome outcome) throws Exception {
        if (outcome.status() == JobStatus.FAILED || outcome.status() == JobStatus.CANCELLED) {
            throw new CanonicalOperationFailedException(
                    outcome.jobId(), outcome.status(), outcome.failureCode());
        }
        Object raw = outcome.result().get("observations");
        if (!(raw instanceof List<?> list) || list.isEmpty()) {
            throw new IllegalStateException(
                    "multimodal parent result carries no grounded child observations");
        }
        Map<JobType, Map<String, Object>> byType = new java.util.EnumMap<>(JobType.class);
        for (Object entry : list) {
            if (!(entry instanceof Map<?, ?> map)) continue;
            Object type = map.get("childJobType");
            Object observations = map.get("observations");
            if (!(observations instanceof Map<?, ?> childResult)) continue;
            JobType jobType = JobType.valueOf(String.valueOf(type));
            Map<String, Object> typed = new java.util.LinkedHashMap<>();
            childResult.forEach((key, value) -> typed.put(String.valueOf(key), value));
            byType.put(jobType, Map.copyOf(typed));
        }
        return byType;
    }

    static AudioResult audioFrom(Map<String, Object> childResult) {
        Object text = childResult.getOrDefault("text", childResult.get("transcript"));
        AudioResult.Builder builder = AudioResult.builder()
                .transcription(text instanceof String s ? s : "");
        Object confidence = childResult.get("confidence");
        if (confidence instanceof Number number) {
            builder.confidence(number.doubleValue());
        }
        return builder.build();
    }

    static VisualResult visualFrom(Map<String, Object> childResult) {
        Object description = childResult.getOrDefault("caption",
                childResult.getOrDefault("description", childResult.get("sceneDescription")));
        VisualResult.Builder builder = VisualResult.builder()
                .sceneDescription(description instanceof String s ? s : "");
        Object confidence = childResult.get("confidence");
        if (confidence instanceof Number number) {
            builder.confidence(number.doubleValue());
        }
        return builder.build();
    }

    static String groundedNarrative(
            CanonicalOperationOutcome outcome, Map<JobType, Map<String, Object>> children) {
        List<String> parts = new ArrayList<>();
        for (Map.Entry<JobType, Map<String, Object>> child : children.entrySet()) {
            parts.add(child.getKey().name().toLowerCase(java.util.Locale.ROOT) + " grounded");
        }
        return "source-grounded multimodal operation " + outcome.jobId()
                + " (" + String.join(", ", parts) + ")";
    }

    static MultimodalResult toMultimodalResult(
            CanonicalOperationOutcome outcome, boolean wantAudio, boolean wantVisual)
            throws Exception {
        Map<JobType, Map<String, Object>> children = requireGroundedChildren(outcome);
        AudioResult audio = wantAudio
                ? audioFrom(requireChild(children, JobType.SPEECH_TO_TEXT)) : null;
        VisualResult visual = wantVisual
                ? visualFrom(requireChild(children, JobType.VISION)) : null;
        return MultimodalResult.builder()
                .audioResult(audio)
                .visualResult(visual)
                .combinedAnalysis(groundedNarrative(outcome, children))
                .processingTimeMs(0)
                .build();
    }

    static VideoAudioResult toVideoAudioResult(CanonicalOperationOutcome outcome)
            throws Exception {
        Map<JobType, Map<String, Object>> children = requireGroundedChildren(outcome);
        return VideoAudioResult.builder()
                .audioResult(audioFrom(requireChild(children, JobType.SPEECH_TO_TEXT)))
                .videoResult(visualFrom(requireChild(children, JobType.VISION)))
                .combinedNarrative(groundedNarrative(outcome, children))
                .processingTimeMs(0)
                .build();
    }

    private static Map<String, Object> requireChild(
            Map<JobType, Map<String, Object>> children, JobType type) {
        Map<String, Object> child = children.get(type);
        if (child == null) {
            throw new IllegalStateException(
                    "multimodal parent result is missing the declared " + type + " child");
        }
        return child;
    }
}

/** The durable parent operation reached a terminal FAILED or CANCELLED state. */
final class CanonicalOperationFailedException extends Exception {
    private final String jobId;
    private final JobStatus status;
    private final String failureCode;
    CanonicalOperationFailedException(String jobId, JobStatus status, String failureCode) {
        super("MULTIMODAL_OPERATION_" + status + " jobId=" + jobId
                + (failureCode == null || failureCode.isBlank() ? "" : " " + failureCode));
        this.jobId = java.util.Objects.requireNonNull(jobId, "jobId");
        this.status = java.util.Objects.requireNonNull(status, "status");
        this.failureCode = failureCode == null ? "" : failureCode;
    }
    String jobId() { return jobId; }
    JobStatus status() { return status; }
    String failureCode() { return failureCode; }
}
