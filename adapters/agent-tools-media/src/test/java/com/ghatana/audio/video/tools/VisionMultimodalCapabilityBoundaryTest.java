/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolActionClass;
import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionFailure;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.agent.framework.tools.ToolExecutionStatus;
import com.ghatana.agent.framework.tools.ToolTransport;
import com.ghatana.tools.testing.EventloopTestBase;
import com.ghatana.toolruntime.ToolHandler;
import io.activej.promise.Promise;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/** AT-04 boundaries stay fail-closed until source, rights and capability authority are installed. */
class VisionMultimodalCapabilityBoundaryTest extends EventloopTestBase {

    @Test
    void ocrRequestRemainsUnadmittedAndCannotReachAVisionDelegate() {
        AtomicInteger delegateCalls = new AtomicInteger();
        ToolExecutionEnvelope envelope = envelope(VisionAnalysisToolHandler.TOOL_ID, Map.of(
                "mediaSource", Map.of("mediaArtifactId", "source-artifact-1"),
                "analysisTypes", List.of("OCR")));

        ToolExecutionResult result = runPromise(() -> new VisionAnalysisToolHandler(delegate(delegateCalls))
                .handle(envelope, contract(envelope)));

        assertUnadmitted(result, envelope, "VISION_NOT_ADMITTED");
        assertThat(delegateCalls).hasValue(0);
    }

    @Test
    void fullySpecifiedMultimodalRequestDoesNotImplyProviderOrRightsAdmission() {
        AtomicInteger delegateCalls = new AtomicInteger();
        ToolExecutionEnvelope envelope = envelope(MultimodalInferenceToolHandler.TOOL_ID, Map.of(
                "mediaArtifactId", "source-artifact-2",
                "inferenceMode", "FRAME_BY_FRAME",
                "samplingRateMs", 500,
                "enableTranscription", true,
                "enableVisionAnalysis", true,
                "languageCode", "en-US"));

        ToolExecutionResult result = runPromise(() -> new MultimodalInferenceToolHandler(delegate(delegateCalls))
                .handle(envelope, contract(envelope)));

        assertUnadmitted(result, envelope, "MULTIMODAL_NOT_ADMITTED");
        assertThat(delegateCalls).hasValue(0);
    }

    @Test
    void callerSuppliedTenantAndConsentClaimsAreRejectedBeforeAnyProviderCall() {
        AtomicInteger delegateCalls = new AtomicInteger();
        String claimedTenant = "foreign-tenant-secret-sentinel";
        String claimedConsent = "forged-consent-sentinel";
        ToolExecutionEnvelope vision = envelope(VisionAnalysisToolHandler.TOOL_ID, Map.of(
                "mediaSource", Map.of("mediaArtifactId", "source-artifact-3",
                        "tenantId", claimedTenant, "consentRef", claimedConsent),
                "analysisTypes", List.of("OBJECT_DETECTION")));
        ToolExecutionEnvelope multimodal = envelope(MultimodalInferenceToolHandler.TOOL_ID, Map.of(
                "mediaArtifactId", "source-artifact-3", "tenantId", claimedTenant,
                "consentRef", claimedConsent));

        ToolExecutionResult visionResult = runPromise(() -> new VisionAnalysisToolHandler(delegate(delegateCalls))
                .handle(vision, contract(vision)));
        ToolExecutionResult multimodalResult = runPromise(() -> new MultimodalInferenceToolHandler(delegate(delegateCalls))
                .handle(multimodal, contract(multimodal)));

        assertValidationFailure(visionResult);
        assertValidationFailure(multimodalResult);
        assertThat(delegateCalls).hasValue(0);
        assertThat(visionResult.toString()).doesNotContain(claimedTenant, claimedConsent);
        assertThat(multimodalResult.toString()).doesNotContain(claimedTenant, claimedConsent);
    }

    private static void assertUnadmitted(ToolExecutionResult result, ToolExecutionEnvelope envelope, String code) {
        assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
        assertThat(result.invocationId()).isEqualTo(envelope.invocationId());
        assertThat(result.correlationId()).isEqualTo(envelope.invocationId());
        assertThat(result.output()).isNull();
        assertThat(result.failure().kind()).isEqualTo(ToolExecutionFailure.Kind.UNAVAILABLE);
        assertThat(result.failure().stage()).isEqualTo(ToolExecutionFailure.Stage.ADMISSION);
        assertThat(result.failure().code()).isEqualTo(code);
        assertThat(result.failure().retryable()).isFalse();
    }

    private static void assertValidationFailure(ToolExecutionResult result) {
        assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
        assertThat(result.output()).isNull();
        assertThat(result.failure().code()).isEqualTo("TOOL_EXECUTION_FAILED");
        assertThat(result.errorMessage()).isEqualTo("TOOL_EXECUTION_FAILED");
    }

    private static ToolHandler delegate(AtomicInteger calls) {
        return (envelope, contract) -> {
            calls.incrementAndGet();
            return Promise.of(ToolExecutionResult.succeeded(envelope.invocationId(), Map.of(), Map.of(),
                    envelope.invocationId(), Instant.now(), Duration.ZERO));
        };
    }

    private static ToolExecutionEnvelope envelope(String toolId, Map<String, Object> input) {
        return new ToolExecutionEnvelope("at04-invocation", toolId, "1.0.0", "caller-agent", null,
                "tenant-a", ToolActionClass.CALL_EXTERNAL, "1.0", input, Instant.now());
    }

    private static ToolContract contract(ToolExecutionEnvelope envelope) {
        return new ToolContract(envelope.toolId(), envelope.toolVersion(), "AT-04", "boundary fixture",
                envelope.actionClass(), false, true, Map.of(), Map.of(), Set.of(),
                ToolTransport.IN_PROCESS, null, Map.of());
    }
}
