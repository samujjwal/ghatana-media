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
import org.apache.logging.log4j.Level;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.LoggerContext;
import org.apache.logging.log4j.core.appender.AbstractAppender;
import org.apache.logging.log4j.core.config.Configuration;
import org.apache.logging.log4j.core.config.LoggerConfig;
import org.apache.logging.log4j.core.config.Property;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
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

    @Test
    void visionRejectsUnboundSourceVersionAndRegionBeforeAnyDelegateCall() {
        AtomicInteger calls = new AtomicInteger();
        ToolHandler delegate = delegateReturningSuccess(calls);
        VisionAnalysisToolHandler handler = new VisionAnalysisToolHandler(delegate);

        ToolExecutionEnvelope staleVersion = envelope(VisionAnalysisToolHandler.TOOL_ID,
                Map.of("mediaSource", Map.of("mediaArtifactId", "asset-1", "versionId", "stale-version")));
        ToolExecutionEnvelope unboundRegion = envelope(VisionAnalysisToolHandler.TOOL_ID,
                Map.of("mediaSource", Map.of("mediaArtifactId", "asset-1", "region", Map.of("x", 1, "y", 2))));

        ToolExecutionResult staleResult = runPromise(() -> handler.handle(staleVersion, contract(staleVersion)));
        ToolExecutionResult regionResult = runPromise(() -> handler.handle(unboundRegion, contract(unboundRegion)));

        assertPreDispatchFailure(staleResult);
        assertPreDispatchFailure(regionResult);
        assertThat(calls).hasValue(0);
    }

    @Test
    void visionRefusesInlineFrameBeforeBase64DecodeAndDoesNotExposeIt() {
        AtomicInteger calls = new AtomicInteger();
        String rawFrameSentinel = "cHJpdmF0ZS1mcmFtZS1zZW50aW5lbA==";
        ToolExecutionEnvelope envelope = envelope(VisionAnalysisToolHandler.TOOL_ID,
                Map.of("mediaSource", Map.of("imageBytes", rawFrameSentinel)));

        ToolExecutionResult result = runPromise(() -> new VisionAnalysisToolHandler(delegateReturningSuccess(calls))
                .handle(envelope, contract(envelope)));

        assertPreDispatchFailure(result);
        assertThat(result.failure().code()).isNotEqualTo("VISION_NOT_ADMITTED");
        assertThat(calls).hasValue(0);
    }

    @Test
    void multimodalRejectsUnsupportedTensorInputBeforeAnyDelegateCall() {
        AtomicInteger calls = new AtomicInteger();
        ToolExecutionEnvelope envelope = envelope(MultimodalInferenceToolHandler.TOOL_ID,
                Map.of("mediaArtifactId", "asset-1", "tensor", "unadmitted-tensor"));

        ToolExecutionResult result = runPromise(() -> new MultimodalInferenceToolHandler(delegateReturningSuccess(calls))
                .handle(envelope, contract(envelope)));

        assertPreDispatchFailure(result);
        assertThat(calls).hasValue(0);
    }

    @Test
    void visionDiagnosticsDoNotExposeTenantInvocationOrSourceReferences() {
        String invocation = "private-invocation-sentinel";
        String tenant = "private-tenant-sentinel";
        String source = "private-source-ref-sentinel";
        AtomicInteger calls = new AtomicInteger();
        ToolExecutionEnvelope valid = envelope(VisionAnalysisToolHandler.TOOL_ID,
                Map.of("mediaSource", Map.of("mediaArtifactId", source),
                        "analysisTypes", java.util.List.of("OBJECT_DETECTION")), invocation, tenant);
        ToolExecutionEnvelope invalid = envelope(VisionAnalysisToolHandler.TOOL_ID,
                Map.of("mediaSource", Map.of("mediaArtifactId", source),
                        "analysisTypes", java.util.List.of("INVALID_ANALYSIS_TYPE_SENTINEL")), invocation, tenant);

        List<String> logs = captureLogs(VisionAnalysisToolHandler.class, () -> {
            ToolExecutionResult result = runPromise(() -> new VisionAnalysisToolHandler(delegateReturningSuccess(calls))
                    .handle(valid, contract(valid)));
            assertNotAdmitted(result, "VISION_NOT_ADMITTED", valid);

            ToolExecutionResult rejected = runPromise(() -> new VisionAnalysisToolHandler(delegateReturningSuccess(calls))
                    .handle(invalid, contract(invalid)));
            assertPreDispatchFailure(rejected);
        });

        assertThat(logs).contains("Vision input rejected: INVALID_ANALYSIS_TYPES");
        assertThat(logs).noneMatch(message -> message.contains(invocation)
                || message.contains(tenant) || message.contains(source));
        assertThat(calls).hasValue(0);
    }

    @Test
    void multimodalDiagnosticsDoNotExposeTenantInvocationOrArtifactReferences() {
        String invocation = "private-invocation-sentinel";
        String tenant = "private-tenant-sentinel";
        String artifact = "private-artifact-ref-sentinel";
        AtomicInteger calls = new AtomicInteger();
        ToolExecutionEnvelope valid = envelope(MultimodalInferenceToolHandler.TOOL_ID,
                Map.of("mediaArtifactId", artifact), invocation, tenant);
        ToolExecutionEnvelope invalid = envelope(MultimodalInferenceToolHandler.TOOL_ID,
                Map.of("mediaArtifactId", artifact, "inferenceMode", "INVALID_MODE_SENTINEL"), invocation, tenant);

        List<String> logs = captureLogs(MultimodalInferenceToolHandler.class, () -> {
            ToolExecutionResult result = runPromise(() -> new MultimodalInferenceToolHandler(delegateReturningSuccess(calls))
                    .handle(valid, contract(valid)));
            assertNotAdmitted(result, "MULTIMODAL_NOT_ADMITTED", valid);

            ToolExecutionResult rejected = runPromise(() -> new MultimodalInferenceToolHandler(delegateReturningSuccess(calls))
                    .handle(invalid, contract(invalid)));
            assertPreDispatchFailure(rejected);
        });

        assertThat(logs).contains("Multimodal input rejected: INVALID_INFERENCE_MODE");
        assertThat(logs).noneMatch(message -> message.contains(invocation)
                || message.contains(tenant) || message.contains(artifact));
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

    private static void assertPreDispatchFailure(ToolExecutionResult result) {
        assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
        assertThat(result.output()).isNull();
        assertThat(result.failure()).isNotNull();
    }

    private static ToolHandler delegateReturningSuccess(AtomicInteger calls) {
        return (envelope, contract) -> {
            calls.incrementAndGet();
            return Promise.of(ToolExecutionResult.succeeded(envelope.invocationId(), Map.of(), Map.of(),
                    envelope.invocationId(), Instant.now(), Duration.ZERO));
        };
    }

    private static ToolExecutionEnvelope envelope(String toolId, Map<String, Object> input) {
        return envelope(toolId, input, "invocation-test", "tenant-test");
    }

    private static ToolExecutionEnvelope envelope(String toolId, Map<String, Object> input,
            String invocationId, String tenantId) {
        return new ToolExecutionEnvelope(invocationId, toolId, "1.0.0", "caller-agent", null,
                tenantId, ToolActionClass.CALL_EXTERNAL, "1.0", input, Instant.now());
    }

    private static ToolContract contract(ToolExecutionEnvelope envelope) {
        return new ToolContract(envelope.toolId(), envelope.toolVersion(), "test", "test",
                envelope.actionClass(), false, true, Map.of(), Map.of(), Set.of(),
                ToolTransport.IN_PROCESS, null, Map.of());
    }

    private static List<String> captureLogs(Class<?> loggerType, Runnable action) {
        LoggerContext context = (LoggerContext) LogManager.getContext(false);
        Configuration configuration = context.getConfiguration();
        String loggerName = loggerType.getName();
        CapturedAppender appender = new CapturedAppender("privacy-test-" + UUID.randomUUID());
        appender.start();
        LoggerConfig loggerConfig = new LoggerConfig(loggerName, Level.DEBUG, false);
        loggerConfig.addAppender(appender, Level.ALL, null);
        configuration.addLogger(loggerName, loggerConfig);
        context.updateLoggers();
        try {
            action.run();
            return appender.messages();
        } finally {
            configuration.removeLogger(loggerName);
            context.updateLoggers();
            appender.stop();
        }
    }

    private static final class CapturedAppender extends AbstractAppender {
        private final CopyOnWriteArrayList<String> messages = new CopyOnWriteArrayList<>();

        private CapturedAppender(String name) {
            super(name, null, null, true, Property.EMPTY_ARRAY);
        }

        @Override
        public void append(LogEvent event) {
            messages.add(event.getMessage().getFormattedMessage());
            if (event.getThrown() != null) messages.add(event.getThrown().toString());
        }

        private List<String> messages() {
            return List.copyOf(messages);
        }
    }
}
