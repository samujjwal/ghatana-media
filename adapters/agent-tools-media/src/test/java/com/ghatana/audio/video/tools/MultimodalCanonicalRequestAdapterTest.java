/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolActionClass;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.audio.video.multimodal.grpc.proto.CanonicalOperationBinding;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MultimodalCanonicalRequestAdapterTest {

    @Test
    void mapsExactArtifactAndCrossModalAnalysisReferencesWithoutDefaults() {
        Map<String, Object> input = input();
        ToolExecutionEnvelope envelope = envelope(input);

        MultimodalCanonicalRequestAdapter.MappedRequest mapped =
                MultimodalCanonicalRequestAdapter.map(envelope, input);
        CanonicalOperationBinding binding = mapped.binding();

        assertThat(binding.getCapabilityRef()).isEqualTo("media.multimodal.analyze.cross-modal");
        assertThat(binding.getOperationRef())
                .isEqualTo("media.operation.capability.media-multimodal-analyze-cross-modal");
        assertThat(binding.getOperationVersion()).isEqualTo(1);
        assertThat(binding.getRequestId()).isEqualTo(MediaToolJobBridge.requestIdFor(envelope.invocationId()));
        assertThat(binding.getSourceArtifactId()).isEqualTo("source-artifact-2");
        assertThat(binding.getSourceVersionId()).isEqualTo("immutable-version-7");
        assertThat(binding.getPurpose()).isEqualTo("purpose-ref-1");
        assertThat(binding.getDimensionsList()).isEmpty();
        assertThat(binding.getCorrelationId()).isEmpty();
        assertThat(mapped.parameters()).isEmpty();
        assertThat(mapped.artifactMetadataAssertions()).isEqualTo(
                new MultimodalCanonicalRequestAdapter.ArtifactMetadataAssertions(
                        "source-ref-1", "video/mp4", 1234L));

        var request = binding.getAnalysisRequest();
        assertThat(request.getDimensionsList()).containsExactly("dimension-ref-a", "dimension-ref-b");
        assertThat(request.getTimeRange()).isEqualTo("time-range-ref-1");
        assertThat(request.getPageSize()).isEqualTo(25);
        assertThat(request.getPageToken()).isEqualTo("continuation-ref-1");
        assertThat(request.getCriteria().getSubjectRefsList()).containsExactly("subject-version-ref-1");
        assertThat(request.getCriteria().getAnalysisMethodRef()).isEqualTo("analysis-method-ref-1");
        assertThat(request.getCriteria().getProfileRef()).isEqualTo("profile-version-ref-1");
        assertThat(request.getCriteria().getConfigurationDigest()).isEqualTo("sha256:" + "a".repeat(64));
        assertThat(request.getCriteria().getPurposeRef()).isEqualTo("purpose-ref-1");
        assertThat(request.getCriteria().getSourceTimeRangeRef()).isEqualTo("source-time-range-ref-1");
        assertThat(request.getCriteria().getRegionOrChannelRefs().getValuesList())
                .containsExactly("region-or-channel-ref-1");
        assertThat(request.getCriteria().getUncertaintyPolicyRef()).isEqualTo("uncertainty-policy-ref-1");
    }

    @Test
    void rejectsLegacyAliasesAndMalformedInputBeforeCreatingCanonicalBinding() {
        Map<String, Object> invalid = new java.util.LinkedHashMap<>(input());
        invalid.put("enableVisionAnalysis", true);

        assertThatThrownBy(() -> MultimodalCanonicalRequestAdapter.map(envelope(input()), invalid))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("TOOL_INPUT_SCHEMA_VIOLATION");
    }

    @Test
    void preservesAbsentVersusExplicitlyEmptyRegionOrChannelReferences() {
        Map<String, Object> explicitEmpty = input(List.of(), true);
        Map<String, Object> absent = input(List.of(), false);

        var presentCriteria = MultimodalCanonicalRequestAdapter.map(envelope(explicitEmpty), explicitEmpty)
                .binding().getAnalysisRequest().getCriteria();
        var absentCriteria = MultimodalCanonicalRequestAdapter.map(envelope(absent), absent)
                .binding().getAnalysisRequest().getCriteria();

        assertThat(presentCriteria.hasRegionOrChannelRefs()).isTrue();
        assertThat(presentCriteria.getRegionOrChannelRefs().getValuesList()).isEmpty();
        assertThat(absentCriteria.hasRegionOrChannelRefs()).isFalse();
    }

    @Test
    void preservesAbsentOptionalArtifactMetadataWithoutInventingDeclarations() {
        Map<String, Object> input = input();
        Map<String, Object> withoutMetadata = new java.util.LinkedHashMap<>(input);
        withoutMetadata.put("input1", Map.of("artifactType", "authorized-media-artifacts",
                "payload", Map.of("artifactId", "source-artifact-2", "versionId", "immutable-version-7")));

        var mapped = MultimodalCanonicalRequestAdapter.map(envelope(withoutMetadata), withoutMetadata);

        assertThat(mapped.artifactMetadataAssertions()).isEqualTo(
                new MultimodalCanonicalRequestAdapter.ArtifactMetadataAssertions(null, null, null));
        assertThat(mapped.binding().getSourceArtifactId()).isEqualTo("source-artifact-2");
        assertThat(mapped.binding().getSourceVersionId()).isEqualTo("immutable-version-7");
    }

    private static Map<String, Object> input() {
        return input(List.of("region-or-channel-ref-1"), true);
    }

    private static Map<String, Object> input(List<String> regionOrChannelRefs, boolean includeRegionOrChannelRefs) {
        Map<String, Object> criteria = new java.util.LinkedHashMap<>(Map.of(
                "subjectRefs", List.of("subject-version-ref-1"),
                "analysisMethodRef", "analysis-method-ref-1",
                "profileRef", "profile-version-ref-1",
                "configurationDigest", "sha256:" + "a".repeat(64),
                "purposeRef", "purpose-ref-1",
                "sourceTimeRangeRef", "source-time-range-ref-1",
                "uncertaintyPolicyRef", "uncertainty-policy-ref-1"));
        if (includeRegionOrChannelRefs) criteria.put("regionOrChannelRefs", regionOrChannelRefs);
        return Map.of(
                "input1", Map.of("artifactType", "authorized-media-artifacts",
                        "payload", Map.of("artifactId", "source-artifact-2", "versionId", "immutable-version-7",
                                "sourceRef", "source-ref-1", "declaredMediaType", "video/mp4",
                                "declaredByteLength", 1234)),
                "input2", Map.of("artifactType", "analysis-request",
                        "payload", Map.of(
                                "dimensions", List.of("dimension-ref-a", "dimension-ref-b"),
                                "timeRange", "time-range-ref-1",
                                "pageSize", 25,
                                "pageToken", "continuation-ref-1",
                                "criteria", criteria)));
    }

    private static ToolExecutionEnvelope envelope(Map<String, Object> input) {
        return new ToolExecutionEnvelope("at04-invocation", MultimodalInferenceToolHandler.TOOL_ID,
                "1.0.0", "caller-agent", null, "tenant-a", ToolActionClass.CALL_EXTERNAL,
                "1.0", input, Instant.parse("2026-11-26T00:00:00Z"));
    }
}
