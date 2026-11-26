/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolActionClass;
import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.agent.framework.tools.ToolExecutionStatus;
import com.ghatana.agent.framework.tools.ToolTransport;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import com.ghatana.tools.testing.EventloopTestBase;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** Validated inputs remain unadmitted until owner-backed resolution and canonical runtime submit/readback are admitted. */
final class MultimodalAdmissionBoundaryTest extends EventloopTestBase {
    private static final String CONFIGURATION_DIGEST = "sha256:" + "a".repeat(64);

    private static final class CapturingPort implements MediaJobSubmissionPort {
        final List<ProcessingJobRequest> submitted = new ArrayList<>();
        @Override public com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob submit(
                ProcessingJobRequest r, AuthenticatedPrincipal authenticated) {
            submitted.add(r);
            throw new AssertionError("unadmitted multimodal call reached the job port");
        }
        @Override public Optional<ProcessingJob> findByRequestId(AuthenticatedPrincipal authenticated, String requestId) {
            return Optional.empty();
        }
    }

    private record Invocation(ToolExecutionResult result, List<ProcessingJobRequest> submitted) { }

    private Invocation call(Map<String, Object> input) {
        var port = new CapturingPort();
        var bridge = new MediaToolJobBridge(port, "dev");
        var envelope = ToolExecutionEnvelope.of("av.multimodal-inference", "1.0.0", "agent-1", null, "tenant-1",
                ToolActionClass.CALL_EXTERNAL, "1.0", input);
        var contract = new ToolContract(envelope.toolId(), envelope.toolVersion(), "test", "test", envelope.actionClass(),
                false, true, Map.of(), Map.of(), Set.of(), ToolTransport.IN_PROCESS, null, Map.of());
        ToolExecutionResult result = runPromise(() -> new MultimodalInferenceToolHandler(bridge,
                new AuthenticatedPrincipal("tenant-1", "agent-1", Instant.now())).handle(envelope, contract));
        return new Invocation(result, port.submitted);
    }

    @Test
    void canonicalInputShapePassesValidationButUnresolvedReferencesStayNotAdmitted() {
        Invocation invocation = call(canonicalInput(List.of("dimension-ref-a", "dimension-ref-b"), true,
                CONFIGURATION_DIGEST));

        assertNotAdmitted(invocation.result());
        assertThat(invocation.submitted()).isEmpty();
    }

    @Test
    void legacyFlatAliasesAreRejectedBeforeJobDispatch() {
        Invocation invocation = call(Map.of("mediaArtifactId", "art-1", "sourceArtifactVersion", "version-7"));

        assertValidationFailure(invocation.result(), "UNKNOWN_INPUT_FIELD");
        assertThat(invocation.submitted()).isEmpty();
    }

    @Test
    void incompleteOrMalformedCanonicalCriteriaAreRejectedBeforeJobDispatch() {
        Invocation missingProfile = call(canonicalInput(List.of("dimension-ref-a", "dimension-ref-b"), false,
                CONFIGURATION_DIGEST));
        Invocation invalidDigest = call(canonicalInput(List.of("dimension-ref-a", "dimension-ref-b"), true,
                "sha256:NOT-A-DIGEST"));
        Invocation invalidDimension = call(canonicalInput(List.of("invalid dimension", "dimension-ref-b"), true,
                CONFIGURATION_DIGEST));

        assertValidationFailure(missingProfile.result(), "TOOL_INPUT_SCHEMA_VIOLATION");
        assertValidationFailure(invalidDigest.result(), "TOOL_INPUT_SCHEMA_VIOLATION");
        assertValidationFailure(invalidDimension.result(), "TOOL_INPUT_SCHEMA_VIOLATION");
        assertThat(missingProfile.submitted()).isEmpty();
        assertThat(invalidDigest.submitted()).isEmpty();
        assertThat(invalidDimension.submitted()).isEmpty();
    }

    @Test
    void singleOpaqueDimensionCannotBeAssumedCrossModal() {
        Invocation invocation = call(canonicalInput(List.of("unresolved-dimension-ref"), true,
                CONFIGURATION_DIGEST));

        assertNotAdmitted(invocation.result());
        assertThat(invocation.submitted()).isEmpty();
    }

    private static void assertNotAdmitted(ToolExecutionResult result) {
        assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
        assertThat(result.output()).isNull();
        assertThat(result.failure().kind()).isEqualTo(com.ghatana.agent.framework.tools.ToolExecutionFailure.Kind.UNAVAILABLE);
        assertThat(result.failure().stage()).isEqualTo(com.ghatana.agent.framework.tools.ToolExecutionFailure.Stage.ADMISSION);
        assertThat(result.failure().code()).isEqualTo(MultimodalInferenceToolHandler.NOT_ADMITTED_CODE);
        assertThat(result.failure().retryable()).isFalse();
    }

    private static void assertValidationFailure(ToolExecutionResult result, String code) {
        assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
        assertThat(result.output()).isNull();
        assertThat(result.failure().kind()).isEqualTo(com.ghatana.agent.framework.tools.ToolExecutionFailure.Kind.VALIDATION);
        assertThat(result.failure().code()).isEqualTo(code);
    }

    private static Map<String, Object> canonicalInput(List<String> dimensions, boolean includeProfile,
            String configurationDigest) {
        Map<String, Object> criteria = new java.util.LinkedHashMap<>();
        criteria.put("subjectRefs", List.of("subject-version-ref-1"));
        criteria.put("analysisMethodRef", "analysis-method-ref-1");
        if (includeProfile) criteria.put("profileRef", "profile-version-ref-1");
        criteria.put("configurationDigest", configurationDigest);
        criteria.put("purposeRef", "purpose-ref-1");
        return Map.of(
                "input1", Map.of("artifactType", "authorized-media-artifacts",
                        "payload", Map.of("artifactId", "art-1", "versionId", "immutable-version-7",
                                "declaredMediaType", "video/mp4", "declaredByteLength", 4_096)),
                "input2", Map.of("artifactType", "analysis-request",
                        "payload", Map.of("dimensions", dimensions, "criteria", criteria)));
    }
}
