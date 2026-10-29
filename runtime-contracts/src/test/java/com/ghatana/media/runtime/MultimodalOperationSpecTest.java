package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSpec;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MultimodalOperationSpecTest {

    private static final String SHA_A = "a".repeat(64);
    private static final String SHA_B = "b".repeat(64);

    @Test
    void specRoundTripsThroughParametersAndDigestIsStable() {
        MultimodalOperationSpec spec = spec();
        Map<String, Object> encoded = spec.toParametersValue();
        MultimodalOperationSpec decoded = MultimodalOperationSpec.fromParameterValue(encoded);
        assertThat(decoded).isEqualTo(spec);
        assertThat(decoded.specDigest()).isEqualTo(spec.specDigest());
    }

    @Test
    void specIsRequiredForMultimodalJobs() {
        ProcessingJobRequest request = request(Map.of());
        assertThatThrownBy(() -> MultimodalOperationSpec.from(request))
                .isInstanceOf(IllegalArgumentException.class);
        ProcessingJobRequest bound = request(
                Map.of(MultimodalOperationSpec.PARAMETERS_KEY, spec().toParametersValue()));
        assertThat(MultimodalOperationSpec.from(bound)).isEqualTo(spec());
    }

    @Test
    void malformedSpecsFailClosed() {
        assertThatThrownBy(() -> new MultimodalOperationSpec(
                "v9", "cap", "op", 1, "src", "sha256:" + SHA_A, SHA_A,
                List.of(child("stt")), null, Map.of()))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION, "cap", "op", 1, "src",
                "sha256:" + SHA_A, SHA_B, List.of(child("stt")), null, Map.of()))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION, "cap", "op", 1, "src",
                "sha256:" + SHA_A, SHA_A,
                List.of(child("stt"), child("vision")), null, Map.of()))
                .isInstanceOf(IllegalArgumentException.class); // duplicate job types
        assertThatThrownBy(() -> new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION, "cap", "op", 1, "src",
                "sha256:" + SHA_A, SHA_A, List.of(), null, Map.of()))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void nestedMultimodalChildrenAreRejected() {
        assertThatThrownBy(() -> new MultimodalOperationSpec.ChildOperationSpec(
                "nested", JobType.MULTIMODAL, "art", "sha256:" + SHA_B, SHA_B, "", Map.of()))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void childRequestIdsAreDeterministicAndBounded() {
        assertThat(MultimodalOperationSpec.childRequestId("req-1", "stt"))
                .isEqualTo("req-1:stt");
        String tooLong = "r".repeat(600);
        assertThatThrownBy(() -> MultimodalOperationSpec.childRequestId(tooLong, "stt"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void specBindingRequiresExactRequestAndArtifact() {
        MultimodalOperationSpec spec = spec();
        MediaArtifact artifact = artifact("src", SHA_A);
        ProcessingJobRequest matching = request(
                Map.of(MultimodalOperationSpec.PARAMETERS_KEY, spec.toParametersValue()));
        assertThat(spec.matchesRequest(matching, artifact)).isTrue();
        MediaArtifact wrongDigest = artifact("src", SHA_B);
        assertThat(spec.matchesRequest(matching, wrongDigest)).isFalse();
        assertThat(spec.matchesRequest(matching, artifact("other", SHA_A))).isFalse();
    }

    private static MultimodalOperationSpec spec() {
        return new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION,
                "media.multimodal.observe.source-grounded",
                "media.operation.capability.media-multimodal-observe-source-grounded",
                1, "src", "sha256:" + SHA_A, SHA_A,
                List.of(child("stt"), visionChild()), null, Map.of());
    }

    private static MultimodalOperationSpec.ChildOperationSpec child(String key) {
        return new MultimodalOperationSpec.ChildOperationSpec(
                key, JobType.SPEECH_TO_TEXT, "art-" + key,
                "sha256:" + SHA_B, SHA_B, "", Map.of());
    }

    private static MultimodalOperationSpec.ChildOperationSpec visionChild() {
        return new MultimodalOperationSpec.ChildOperationSpec(
                "vision", JobType.VISION, "art-vision",
                "sha256:" + SHA_B, SHA_B, "", Map.of());
    }

    private static ProcessingJobRequest request(Map<String, Object> parameters) {
        return new ProcessingJobRequest("req-1", "tenant-a", "principal-a", "correlation-a",
                "src", "sha256:" + SHA_A, JobType.MULTIMODAL, "", parameters);
    }

    private static MediaArtifact artifact(String artifactId, String sha256) {
        return new MediaArtifact("tenant-a", "principal-a", artifactId, "source.bin",
                "application/octet-stream", 4, sha256, "object-ref", "CONFIDENTIAL",
                Instant.now(), Instant.now().plusSeconds(3600), Map.of());
    }
}
