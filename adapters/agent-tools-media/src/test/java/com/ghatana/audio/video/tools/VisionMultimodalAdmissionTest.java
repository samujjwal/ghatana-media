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
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

class VisionMultimodalAdmissionTest extends EventloopTestBase {

    @Test
    void visionDoesNotTreatConfiguredDelegateAsSourceAndRightsAdmission() {
        AtomicInteger calls = new AtomicInteger();
        ToolExecutionEnvelope envelope = envelope(VisionAnalysisToolHandler.TOOL_ID,
                Map.of("mediaSource", Map.of("mediaArtifactId", "asset-1"),
                        "analysisTypes", java.util.List.of("OBJECT_DETECTION")));
        ToolHandler delegate = delegateReturningSuccess(calls);

        ToolExecutionResult result = runPromise(() -> new VisionAnalysisToolHandler(delegate)
                .handle(envelope, contract(envelope)));

        assertNotAdmitted(result, "VISION_NOT_ADMITTED", envelope);
        assertThat(calls).hasValue(0);
    }

    @Test
    void multimodalDoesNotTreatConfiguredDelegateAsSourceAndRightsAdmission() {
        AtomicInteger calls = new AtomicInteger();
        ToolExecutionEnvelope envelope = envelope(MultimodalInferenceToolHandler.TOOL_ID,
                Map.of("mediaArtifactId", "asset-1"));
        ToolHandler delegate = delegateReturningSuccess(calls);

        ToolExecutionResult result = runPromise(() -> new MultimodalInferenceToolHandler(delegate)
                .handle(envelope, contract(envelope)));

        assertNotAdmitted(result, "MULTIMODAL_NOT_ADMITTED", envelope);
        assertThat(calls).hasValue(0);
    }

    private static void assertNotAdmitted(ToolExecutionResult result, String code,
            ToolExecutionEnvelope envelope) {
        assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
        assertThat(result.invocationId()).isEqualTo(envelope.invocationId());
        assertThat(result.output()).isNull();
        assertThat(result.failure().kind()).isEqualTo(ToolExecutionFailure.Kind.UNAVAILABLE);
        assertThat(result.failure().stage()).isEqualTo(ToolExecutionFailure.Stage.ADMISSION);
        assertThat(result.failure().code()).isEqualTo(code);
    }

    private static ToolHandler delegateReturningSuccess(AtomicInteger calls) {
        return (envelope, contract) -> {
            calls.incrementAndGet();
            return Promise.of(ToolExecutionResult.succeeded(envelope.invocationId(), Map.of(), Map.of(),
                    envelope.invocationId(), Instant.now(), Duration.ZERO));
        };
    }

    private static ToolExecutionEnvelope envelope(String toolId, Map<String, Object> input) {
        return ToolExecutionEnvelope.of(toolId, "1.0.0", "caller-agent", null, "tenant-test",
                ToolActionClass.CALL_EXTERNAL, "1.0", input);
    }

    private static ToolContract contract(ToolExecutionEnvelope envelope) {
        return new ToolContract(envelope.toolId(), envelope.toolVersion(), "test", "test",
                envelope.actionClass(), false, true, Map.of(), Map.of(), Set.of(),
                ToolTransport.IN_PROCESS, null, Map.of());
    }
}
