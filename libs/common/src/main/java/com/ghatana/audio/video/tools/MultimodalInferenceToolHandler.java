/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.toolruntime.ToolHandler;
import io.activej.promise.Promise;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Objects;

/**
 * {@link ToolHandler} adapter for the Audio-Video Multimodal Inference service.
 *
 * <p>Wraps the multimodal fusion pipeline as a platform tool. A concrete delegate
 * must be supplied by the service composition layer. Without one, the handler
 * fails closed so Data Cloud receives an honest provider-unavailable result.
 *
 * @doc.type class
 * @doc.purpose ToolHandler adapter for the Multimodal Inference capability
 * @doc.layer product
 * @doc.pattern Adapter
 */
public final class MultimodalInferenceToolHandler implements ToolHandler {

    private static final Logger log = LoggerFactory.getLogger(MultimodalInferenceToolHandler.class);
    public static final String TOOL_ID = "av.multimodal-inference";

    private final ToolHandler delegate;

    public MultimodalInferenceToolHandler() {
        this(null);
    }

    public MultimodalInferenceToolHandler(ToolHandler delegate) {
        this.delegate = delegate;
    }

    @Override
    public Promise<ToolExecutionResult> handle(ToolExecutionEnvelope envelope, ToolContract contract) {
        Objects.requireNonNull(envelope, "envelope must not be null");
        Objects.requireNonNull(contract, "contract must not be null");

        Instant start = Instant.now();
        Map<String, Object> input = envelope.input();

        log.debug("MultimodalInference invocation [{}] tenant={}", envelope.invocationId(), envelope.tenantId());

        try {
            String mediaArtifactId = requireString(input, "mediaArtifactId");
            String inferenceMode = (String) input.getOrDefault("inferenceMode", "SUMMARY");
            boolean enableTranscription = !Boolean.FALSE.equals(input.get("enableTranscription"));
            boolean enableVision = !Boolean.FALSE.equals(input.get("enableVisionAnalysis"));

            log.debug("Multimodal: artifactId={} mode={} stt={} vision={}", mediaArtifactId, inferenceMode, enableTranscription, enableVision);

            if (delegate == null) {
                return providerUnavailable(envelope, start);
            }

            return delegate.handle(envelope, contract);
        } catch (Exception e) {
            log.error("MultimodalInference handler failed for invocation {}: {}", envelope.invocationId(), e.getMessage(), e);
            Instant end = Instant.now();
            return Promise.of(ToolExecutionResult.failed(
                    envelope.invocationId(),
                    "Multimodal inference error: " + e.getMessage(),
                    envelope.invocationId(),
                    end,
                    Duration.between(start, end)));
        }
    }

    private Promise<ToolExecutionResult> providerUnavailable(ToolExecutionEnvelope envelope, Instant start) {
        Instant end = Instant.now();
        return Promise.of(ToolExecutionResult.failed(
                envelope.invocationId(),
                "Audio-Video Multimodal provider unavailable: no multimodal inference service delegate configured",
                envelope.invocationId(),
                end,
                Duration.between(start, end)));
    }

    private String requireString(Map<String, Object> input, String key) {
        Object val = input.get(key);
        if (!(val instanceof String s) || s.isBlank()) {
            throw new IllegalArgumentException("Required input field '" + key + "' is missing or blank");
        }
        return s;
    }

}
