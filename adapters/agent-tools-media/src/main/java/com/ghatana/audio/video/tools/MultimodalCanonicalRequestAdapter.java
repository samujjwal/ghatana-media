/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.audio.video.multimodal.grpc.proto.CanonicalAnalysisCriteria;
import com.ghatana.audio.video.multimodal.grpc.proto.CanonicalAnalysisRequest;
import com.ghatana.audio.video.multimodal.grpc.proto.CanonicalOperationBinding;
import com.ghatana.audio.video.multimodal.grpc.proto.CanonicalReferenceList;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;

import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Maps the closed PDP-1 tool inputs into the canonical cross-modal operation request.
 *
 * <p>This adapter performs structural mapping only. It does not resolve references,
 * establish trusted identity or rights, construct child operations, or dispatch work.
 * Those checks remain mandatory before a caller can use the mapped request.
 */
final class MultimodalCanonicalRequestAdapter {

    private static final int OPERATION_VERSION = 1;
    private static final String CAPABILITY_REF = "media.multimodal.analyze.cross-modal";
    private static final String OPERATION_REF = "media.operation.capability.media-multimodal-analyze-cross-modal";

    private MultimodalCanonicalRequestAdapter() { }

    /**
     * Optional caller declarations about the selected artifact. These values are assertions
     * for an owner-backed resolver to compare with exact artifact metadata; they are not
     * source identity, trusted metadata, or operation parameters.
     */
    record ArtifactMetadataAssertions(String sourceRef, String declaredMediaType, Long declaredByteLength) { }

    /** Canonical request, empty parameters, and untrusted artifact metadata assertions. */
    record MappedRequest(
            CanonicalOperationBinding binding,
            Map<String, Object> parameters,
            ArtifactMetadataAssertions artifactMetadataAssertions) {
        MappedRequest {
            Objects.requireNonNull(binding, "binding");
            parameters = Map.copyOf(Objects.requireNonNull(parameters, "parameters"));
            Objects.requireNonNull(artifactMetadataAssertions, "artifactMetadataAssertions");
            if (!parameters.isEmpty()) {
                throw new IllegalArgumentException("cross-modal operation parameters must be empty");
            }
        }
    }

    static MappedRequest map(ToolExecutionEnvelope envelope, Map<String, Object> input) {
        Objects.requireNonNull(envelope, "envelope");
        MultimodalInferenceToolHandler.validateCanonicalInput(input);

        Map<?, ?> input1 = object(input.get("input1"));
        Map<?, ?> artifact = object(input1.get("payload"));
        Map<?, ?> input2 = object(input.get("input2"));
        Map<?, ?> analysis = object(input2.get("payload"));
        Map<?, ?> criteria = object(analysis.get("criteria"));

        CanonicalAnalysisCriteria.Builder criteriaBuilder = CanonicalAnalysisCriteria.newBuilder()
                .addAllSubjectRefs(strings(criteria.get("subjectRefs")))
                .setAnalysisMethodRef(string(criteria.get("analysisMethodRef")))
                .setProfileRef(string(criteria.get("profileRef")))
                .setConfigurationDigest(string(criteria.get("configurationDigest")))
                .setPurposeRef(string(criteria.get("purposeRef")));
        if (criteria.containsKey("sourceTimeRangeRef")) {
            criteriaBuilder.setSourceTimeRangeRef(string(criteria.get("sourceTimeRangeRef")));
        }
        if (criteria.containsKey("regionOrChannelRefs")) {
            criteriaBuilder.setRegionOrChannelRefs(CanonicalReferenceList.newBuilder()
                    .addAllValues(strings(criteria.get("regionOrChannelRefs")))
                    .build());
        }
        if (criteria.containsKey("uncertaintyPolicyRef")) {
            criteriaBuilder.setUncertaintyPolicyRef(string(criteria.get("uncertaintyPolicyRef")));
        }

        CanonicalAnalysisRequest.Builder analysisBuilder = CanonicalAnalysisRequest.newBuilder()
                .addAllDimensions(strings(analysis.get("dimensions")))
                .setCriteria(criteriaBuilder.build());
        if (analysis.containsKey("timeRange")) {
            analysisBuilder.setTimeRange(string(analysis.get("timeRange")));
        }
        if (analysis.containsKey("pageSize")) {
            analysisBuilder.setPageSize(integer(analysis.get("pageSize")));
        }
        if (analysis.containsKey("pageToken")) {
            analysisBuilder.setPageToken(string(analysis.get("pageToken")));
        }

        String purposeRef = string(criteria.get("purposeRef"));
        // The canonical transport selects only this exact artifact/version pair. The server must resolve
        // authoritative metadata from that version; optional caller declarations never replace its record.
        CanonicalOperationBinding binding = CanonicalOperationBinding.newBuilder()
                .setCapabilityRef(CAPABILITY_REF)
                .setOperationRef(OPERATION_REF)
                .setOperationVersion(OPERATION_VERSION)
                .setRequestId(MediaToolJobBridge.requestIdFor(envelope.invocationId()))
                .setSourceArtifactId(string(artifact.get("artifactId")))
                .setSourceVersionId(string(artifact.get("versionId")))
                .setPurpose(purposeRef)
                .setAnalysisRequest(analysisBuilder.build())
                .build();
        ArtifactMetadataAssertions assertions = new ArtifactMetadataAssertions(
                optionalString(artifact, "sourceRef"),
                optionalString(artifact, "declaredMediaType"),
                optionalLong(artifact, "declaredByteLength"));
        return new MappedRequest(binding, Map.of(), assertions);
    }

    private static Map<?, ?> object(Object value) {
        return (Map<?, ?>) value;
    }

    private static String string(Object value) {
        return (String) value;
    }

    private static int integer(Object value) {
        return ((Number) value).intValue();
    }

    private static String optionalString(Map<?, ?> values, String key) {
        return values.containsKey(key) ? string(values.get(key)) : null;
    }

    private static Long optionalLong(Map<?, ?> values, String key) {
        return values.containsKey(key) ? ((Number) values.get(key)).longValue() : null;
    }

    private static List<String> strings(Object value) {
        return ((List<?>) value).stream().map(String.class::cast).toList();
    }
}
