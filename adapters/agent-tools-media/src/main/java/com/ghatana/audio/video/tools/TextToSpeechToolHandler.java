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
        Map<String, Object> input;

        log.debug("TTS invocation [{}] tenant={}", envelope.invocationId(), envelope.tenantId());

        try {
            input = AgentToolInput.checked(envelope, contract, TOOL_ID, Set.of("text", "voiceId", "speakingRate", "pitch", "audioEncoding", "storeAsArtifact"));
            String text = AgentToolInput.requiredString(input, "text", 10_000);
            String voiceId = optionalString(input, "voiceId", "en-US-default", 128);
            double speakingRate = AgentToolInput.boundedRate(input.getOrDefault("speakingRate", 1.0));
            String encoding = optionalString(input, "audioEncoding", "MP3", 16);
            if (!Set.of("MP3", "WAV", "OGG_OPUS", "LINEAR16").contains(encoding)) throw new IllegalArgumentException("INVALID_AUDIO_ENCODING");
            Object pitch = input.getOrDefault("pitch", 0.0);
            if (!(pitch instanceof Number pitchNumber) || !Double.isFinite(pitchNumber.doubleValue())
                    || pitchNumber.doubleValue() < -20.0 || pitchNumber.doubleValue() > 20.0)
                throw new IllegalArgumentException("INVALID_PITCH");
            Object store = input.getOrDefault("storeAsArtifact", Boolean.FALSE);
            if (!(store instanceof Boolean)) throw new IllegalArgumentException("INVALID_STORE_AS_ARTIFACT");
            boolean storeAsArtifact = (Boolean) store;

            log.debug("TTS: voice={} rate={} encoding={} storeAsArtifact={}", voiceId, speakingRate, encoding, storeAsArtifact);

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
        if (delegate == null) return providerUnavailable(envelope, start);
        return AgentToolInput.dispatch(delegate, envelope, contract);
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

    private String optionalString(Map<String, Object> input, String key, String fallback, int max) {
        return input.containsKey(key) ? AgentToolInput.requiredString(input, key, max) : fallback;
    }

}
