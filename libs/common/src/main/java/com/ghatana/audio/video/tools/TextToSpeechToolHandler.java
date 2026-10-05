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
 * {@link ToolHandler} adapter for the Audio-Video Text-to-Speech service.
 *
 * <p>Wraps the AV TTS gRPC endpoint as a platform tool. A concrete delegate must
 * be supplied by the service composition layer. Without one, the handler fails
 * closed so callers see provider unavailability instead of an empty audio payload.
 *
 * @doc.type class
 * @doc.purpose ToolHandler adapter for the TTS gRPC capability
 * @doc.layer product
 * @doc.pattern Adapter
 */
public final class TextToSpeechToolHandler implements ToolHandler {

    private static final Logger log = LoggerFactory.getLogger(TextToSpeechToolHandler.class);
    static final String TOOL_ID = "av.text-to-speech";

    private final ToolHandler delegate;

    public TextToSpeechToolHandler() {
        this(null);
    }

    public TextToSpeechToolHandler(ToolHandler delegate) {
        this.delegate = delegate;
    }

    @Override
    public Promise<ToolExecutionResult> handle(ToolExecutionEnvelope envelope, ToolContract contract) {
        Objects.requireNonNull(envelope, "envelope must not be null");
        Objects.requireNonNull(contract, "contract must not be null");

        Instant start = Instant.now();
        Map<String, Object> input = envelope.input();

        log.debug("TTS invocation [{}] tenant={}", envelope.invocationId(), envelope.tenantId());

        try {
            String text = requireString(input, "text");
            String voiceId = (String) input.getOrDefault("voiceId", "en-US-default");
            double speakingRate = toDouble(input.getOrDefault("speakingRate", 1.0));
            String encoding = (String) input.getOrDefault("audioEncoding", "MP3");
            boolean storeAsArtifact = Boolean.TRUE.equals(input.get("storeAsArtifact"));

            log.debug("TTS: voice={} rate={} encoding={} storeAsArtifact={}", voiceId, speakingRate, encoding, storeAsArtifact);

            if (delegate == null) {
                return providerUnavailable(envelope, start);
            }

            return delegate.handle(envelope, contract);
        } catch (Exception e) {
            log.error("TTS handler failed for invocation {}: {}", envelope.invocationId(), e.getMessage(), e);
            Instant end = Instant.now();
            return Promise.of(ToolExecutionResult.failed(
                    envelope.invocationId(),
                    "TTS processing error: " + e.getMessage(),
                    envelope.invocationId(),
                    end,
                    Duration.between(start, end)));
        }
    }

    private Promise<ToolExecutionResult> providerUnavailable(ToolExecutionEnvelope envelope, Instant start) {
        Instant end = Instant.now();
        return Promise.of(ToolExecutionResult.failed(
                envelope.invocationId(),
                "Audio-Video TTS provider unavailable: no text-to-speech service delegate configured",
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

    private double toDouble(Object value) {
        if (value instanceof Number n) return n.doubleValue();
        return 1.0;
    }

}
