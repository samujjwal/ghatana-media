/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionFailure;
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
import java.util.Set;

/**
 * {@link ToolHandler} adapter for the Audio-Video Multimodal Inference service.
 *
 * <p>A configured delegate does not establish source authorization, version,
 * temporal provenance, modality eligibility, consent, or cancellation
 * finality. Until an admitted public Media operation binds those inputs,
 * inference fails closed before dispatch.
 *
 * @doc.type class
 * @doc.purpose ToolHandler adapter for the Multimodal Inference capability
 * @doc.layer product
 * @doc.pattern Adapter
 */
public final class MultimodalInferenceToolHandler implements ToolHandler {

    private static final Logger log = LoggerFactory.getLogger(MultimodalInferenceToolHandler.class);
    public static final String TOOL_ID = "av.multimodal-inference";

    public MultimodalInferenceToolHandler() {
        this(null);
    }

    /** Compatibility constructor; a delegate cannot provide admission authority. */
    public MultimodalInferenceToolHandler(ToolHandler ignoredDelegate) {
    }

    @Override
    public Promise<ToolExecutionResult> handle(ToolExecutionEnvelope envelope, ToolContract contract) {
        Objects.requireNonNull(envelope, "envelope must not be null");
        Objects.requireNonNull(contract, "contract must not be null");

        Instant start = Instant.now();
        Map<String, Object> input;

        log.debug("MultimodalInference invocation [{}] tenant={}", envelope.invocationId(), envelope.tenantId());

        try {
            input = AgentToolInput.checked(envelope, contract, TOOL_ID, Set.of("mediaArtifactId", "inferenceMode", "samplingRateMs", "enableTranscription", "enableVisionAnalysis", "languageCode"));
            String mediaArtifactId = AgentToolInput.requiredString(input, "mediaArtifactId", 512);
            Object mode = input.getOrDefault("inferenceMode", "SUMMARY");
            if (!(mode instanceof String inferenceMode) || !Set.of("SUMMARY", "SEGMENT", "FRAME_BY_FRAME", "FULL").contains(inferenceMode)) throw new IllegalArgumentException("INVALID_INFERENCE_MODE");
            Object sampling = input.getOrDefault("samplingRateMs", 1000);
            if (!(sampling instanceof Number rate) || rate.intValue() != rate.doubleValue() || rate.intValue() < 100 || rate.intValue() > 60_000)
                throw new IllegalArgumentException("INVALID_SAMPLING_RATE");
            AgentToolInput.languageTag(input.get("languageCode"), "en-US");
            boolean enableTranscription = optionalBoolean(input, "enableTranscription", true);
            boolean enableVision = optionalBoolean(input, "enableVisionAnalysis", true);
            if (!enableTranscription && !enableVision) throw new IllegalArgumentException("NO_MODALITY_SELECTED");

            log.debug("Multimodal: artifactId={} mode={} stt={} vision={}", mediaArtifactId, inferenceMode, enableTranscription, enableVision);

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
        // A generic ToolHandler is not an admission or provenance authority.
        // The current public operation contract does not bind source version,
        // temporal region, rights/consent, or durable cancellation/finality.
        return notAdmitted(envelope, start);
    }

    private Promise<ToolExecutionResult> notAdmitted(ToolExecutionEnvelope envelope, Instant start) {
        Instant end = Instant.now();
        return Promise.of(ToolExecutionResult.failed(
                envelope.invocationId(),
                new ToolExecutionFailure(ToolExecutionFailure.Kind.UNAVAILABLE,
                        ToolExecutionFailure.Stage.ADMISSION, "MULTIMODAL_NOT_ADMITTED", false, end),
                envelope.invocationId(), end, Duration.between(start, end)));
    }

    private String requireString(Map<String, Object> input, String key) {
        Object val = input.get(key);
        if (!(val instanceof String s) || s.isBlank()) {
            throw new IllegalArgumentException("Required input field '" + key + "' is missing or blank");
        }
        return s;
    }

    private boolean optionalBoolean(Map<String, Object> input, String key, boolean fallback) {
        Object value = input.get(key);
        if (value == null) return fallback;
        if (!(value instanceof Boolean flag)) throw new IllegalArgumentException("INVALID_" + key.toUpperCase());
        return flag;
    }

}
