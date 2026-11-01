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
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * {@link ToolHandler} adapter for the Audio-Video Vision Analysis service.
 *
 * <p>A configured delegate does not establish source authorization, version,
 * temporal provenance, model eligibility, consent, or cancellation finality.
 * Until an admitted public Media operation binds those inputs, analysis fails
 * closed before dispatch.
 *
 * @doc.type class
 * @doc.purpose ToolHandler adapter for the Vision Analysis gRPC capability
 * @doc.layer product
 * @doc.pattern Adapter
 */
public final class VisionAnalysisToolHandler implements ToolHandler {

    private static final Logger log = LoggerFactory.getLogger(VisionAnalysisToolHandler.class);
    public static final String TOOL_ID = "av.vision-analysis";

    public VisionAnalysisToolHandler() {
        this(null);
    }

    /** Compatibility constructor; a delegate cannot provide admission authority. */
    public VisionAnalysisToolHandler(ToolHandler ignoredDelegate) {
    }

    @Override
    public Promise<ToolExecutionResult> handle(ToolExecutionEnvelope envelope, ToolContract contract) {
        Objects.requireNonNull(envelope, "envelope must not be null");
        Objects.requireNonNull(contract, "contract must not be null");

        Instant start = Instant.now();
        Map<String, Object> input;

        log.debug("VisionAnalysis invocation [{}] tenant={}", envelope.invocationId(), envelope.tenantId());

        try {
            input = AgentToolInput.checked(envelope, contract, TOOL_ID, Set.of("mediaSource", "analysisTypes", "maxResults", "confidenceThreshold", "customModelId"));
            String mediaSource = resolveMediaSource(input);
            Object rawTypes = input.getOrDefault("analysisTypes", List.of("OBJECT_DETECTION"));
            if (!(rawTypes instanceof List<?> types) || types.isEmpty() || types.size() > 8
                    || types.stream().anyMatch(type -> !(type instanceof String s) || !Set.of("OBJECT_DETECTION", "SCENE_CLASSIFICATION", "OCR", "FACE_DETECTION", "LABEL_DETECTION", "CUSTOM_MODEL").contains(s)))
                throw new IllegalArgumentException("INVALID_ANALYSIS_TYPES");
            @SuppressWarnings("unchecked") List<String> analysisTypes = (List<String>) types;
            int maxResults = AgentToolInput.boundedInt(input.getOrDefault("maxResults", 10));
            Object confidence = input.getOrDefault("confidenceThreshold", 0.5);
            if (!(confidence instanceof Number n) || !Double.isFinite(n.doubleValue()) || n.doubleValue() < 0 || n.doubleValue() > 1)
                throw new IllegalArgumentException("INVALID_CONFIDENCE_THRESHOLD");
            if (analysisTypes.contains("CUSTOM_MODEL")) AgentToolInput.requiredString(input, "customModelId", 512);
            else if (input.containsKey("customModelId")) AgentToolInput.requiredString(input, "customModelId", 512);

            log.debug("Vision: mediaSource={} types={} maxResults={}", mediaSource, analysisTypes, maxResults);

        } catch (Exception e) {
            log.error("VisionAnalysis handler failed for invocation {}: {}", envelope.invocationId(), e.getMessage(), e);
            Instant end = Instant.now();
            return Promise.of(ToolExecutionResult.failed(
                    envelope.invocationId(),
                    "Vision analysis error: " + e.getMessage(),
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
                        ToolExecutionFailure.Stage.ADMISSION, "VISION_NOT_ADMITTED", false, end),
                envelope.invocationId(), end, Duration.between(start, end)));
    }

    private String resolveMediaSource(Map<String, Object> input) {
        return AgentToolInput.source(input, "mediaSource", "imageBytes", 20 * 1024 * 1024, true);
    }

}
