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
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * {@link ToolHandler} adapter for the Audio-Video Vision Analysis service.
 *
 * <p>Wraps the AV Vision gRPC endpoint as a platform tool. A concrete delegate
 * must be supplied by the service composition layer. Without one, the handler
 * fails closed so provider availability feeds Runtime Truth accurately.
 *
 * @doc.type class
 * @doc.purpose ToolHandler adapter for the Vision Analysis gRPC capability
 * @doc.layer product
 * @doc.pattern Adapter
 */
public final class VisionAnalysisToolHandler implements ToolHandler {

    private static final Logger log = LoggerFactory.getLogger(VisionAnalysisToolHandler.class);
    public static final String TOOL_ID = "av.vision-analysis";

    private final ToolHandler delegate;

    public VisionAnalysisToolHandler() {
        this(null);
    }

    public VisionAnalysisToolHandler(ToolHandler delegate) {
        this.delegate = delegate;
    }

    @Override
    public Promise<ToolExecutionResult> handle(ToolExecutionEnvelope envelope, ToolContract contract) {
        Objects.requireNonNull(envelope, "envelope must not be null");
        Objects.requireNonNull(contract, "contract must not be null");

        Instant start = Instant.now();
        Map<String, Object> input = envelope.input();

        log.debug("VisionAnalysis invocation [{}] tenant={}", envelope.invocationId(), envelope.tenantId());

        try {
            String mediaSource = resolveMediaSource(input);
            @SuppressWarnings("unchecked")
            List<String> analysisTypes = (List<String>) input.getOrDefault("analysisTypes", List.of("OBJECT_DETECTION"));
            int maxResults = toInt(input.getOrDefault("maxResults", 10));

            log.debug("Vision: mediaSource={} types={} maxResults={}", mediaSource, analysisTypes, maxResults);

            if (delegate == null) {
                return providerUnavailable(envelope, start);
            }

            return delegate.handle(envelope, contract);
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
    }

    private Promise<ToolExecutionResult> providerUnavailable(ToolExecutionEnvelope envelope, Instant start) {
        Instant end = Instant.now();
        return Promise.of(ToolExecutionResult.failed(
                envelope.invocationId(),
                "Audio-Video Vision provider unavailable: no vision analysis service delegate configured",
                envelope.invocationId(),
                end,
                Duration.between(start, end)));
    }

    private String resolveMediaSource(Map<String, Object> input) {
        Object src = input.get("mediaSource");
        if (src instanceof Map<?, ?> srcMap) {
            if (srcMap.containsKey("mediaArtifactId")) return "artifact:" + srcMap.get("mediaArtifactId");
            if (srcMap.containsKey("imageBytes")) return "bytes:inline";
        }
        if (input.containsKey("mediaArtifactId")) return "artifact:" + input.get("mediaArtifactId");
        throw new IllegalArgumentException("mediaSource must contain mediaArtifactId or imageBytes");
    }

    private int toInt(Object value) {
        if (value instanceof Number n) return n.intValue();
        return 10;
    }

}
