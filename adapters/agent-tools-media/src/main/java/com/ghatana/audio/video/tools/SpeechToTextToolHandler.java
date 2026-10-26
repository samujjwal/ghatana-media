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
import java.util.Set;

/**
 * {@link ToolHandler} adapter for the Audio-Video Speech-to-Text service.
 *
 * <p>Wraps the AV STT gRPC endpoint as a platform tool. For production deployments
 * a concrete delegate must be supplied by the service composition layer. Without
 * a delegate, the handler fails closed so Data Cloud runtime truth can degrade the
 * provider action instead of accepting an empty transcript as successful work.
 *
 * @doc.type class
 * @doc.purpose ToolHandler adapter for the STT gRPC capability
 * @doc.layer product
 * @doc.pattern Adapter
 */
public final class SpeechToTextToolHandler implements ToolHandler {

    private static final Logger log = LoggerFactory.getLogger(SpeechToTextToolHandler.class);
    public static final String TOOL_ID = "av.speech-to-text";

    private final ToolHandler delegate;

    public SpeechToTextToolHandler() {
        this(null);
    }

    public SpeechToTextToolHandler(ToolHandler delegate) {
        this.delegate = delegate;
    }

    @Override
    public Promise<ToolExecutionResult> handle(ToolExecutionEnvelope envelope, ToolContract contract) {
        Objects.requireNonNull(envelope, "envelope must not be null");
        Objects.requireNonNull(contract, "contract must not be null");

        Instant start = Instant.now();
        Map<String, Object> input;
        String audioSource;

        log.debug("STT invocation [{}] tenant={}", envelope.invocationId(), envelope.tenantId());

        try {
            input = AgentToolInput.checked(envelope, contract, TOOL_ID, Set.of("audioSource", "languageCode", "enableDiarization", "model"));
            audioSource = resolveAudioSource(input);
            AgentToolInput.languageTag(input.get("languageCode"), "en-US");
            if (!(input.getOrDefault("enableDiarization", Boolean.FALSE) instanceof Boolean))
                throw new IllegalArgumentException("INVALID_ENABLE_DIARIZATION");
            if (!Set.of("default", "enhanced", "telephony").contains(input.getOrDefault("model", "default")))
                throw new IllegalArgumentException("INVALID_MODEL");

        } catch (Exception e) {
            log.error("STT handler failed for invocation {}: {}", envelope.invocationId(), e.getMessage(), e);
            Instant end = Instant.now();
            return Promise.of(ToolExecutionResult.failed(
                    envelope.invocationId(),
                    "STT processing error: " + e.getMessage(),
                    envelope.invocationId(),
                    end,
                    Duration.between(start, end)));
        }
        if (delegate == null) return providerUnavailable(envelope, start, audioSource);
        return AgentToolInput.dispatch(delegate, envelope, contract);
    }

    private Promise<ToolExecutionResult> providerUnavailable(
            ToolExecutionEnvelope envelope,
            Instant start,
            String audioSource) {
        Instant end = Instant.now();
        return Promise.of(ToolExecutionResult.failed(
                envelope.invocationId(),
                "Audio-Video STT provider unavailable for " + audioSource + ": no speech-to-text service delegate configured",
                envelope.invocationId(),
                end,
                Duration.between(start, end)));
    }

    private String resolveAudioSource(Map<String, Object> input) {
        return AgentToolInput.source(input, "audioSource", "audioBytes", 20 * 1024 * 1024, false);
    }

}
