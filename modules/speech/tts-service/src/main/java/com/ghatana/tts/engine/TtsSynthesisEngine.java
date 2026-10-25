package com.ghatana.tts.engine;

import java.time.Duration;
import java.util.Objects;
import java.util.Set;

/**
 * TTS (text-to-speech) synthesis engine.
 *
 * <p>This compatibility façade has no admitted synthesis provider. It validates
 * requests and fails closed instead of manufacturing bytes that could be
 * mistaken for speech or for an encoded audio format.
 *
 * @doc.type    class
 * @doc.purpose Fail-closed TTS façade until a real synthesis provider is admitted
 * @doc.layer   product
 * @doc.pattern Engine
 */
public class TtsSynthesisEngine {

    /** Output audio encoding. */
    public enum AudioEncoding { PCM_16BIT, PCM_32BIT, OPUS, MP3 }

    /** Voice configuration. */
    public record VoiceConfig(
            String voiceId,
            String languageCode,
            String gender,
            float speakingRate,
            float pitch,
            float volumeGainDb
    ) {
        public static VoiceConfig defaults() {
            return new VoiceConfig("en-US-standard-a", "en-US", "NEUTRAL", 1.0f, 0.0f, 0.0f);
        }
    }

    /** Result of a synthesis request from a real provider. */
    public record SynthesisResult(
            byte[] audioContent,
            AudioEncoding encoding,
            int sampleRateHz,
            Duration duration,
            String voiceId,
            double processingSeconds
    ) {
        public boolean isEmpty() { return audioContent == null || audioContent.length == 0; }
    }

    private final String modelId;
    private final Set<String> supportedVoiceIds;

    public TtsSynthesisEngine(String modelId, Set<String> supportedVoiceIds) {
        Objects.requireNonNull(modelId, "modelId must not be null");
        this.modelId = modelId;
        this.supportedVoiceIds = Set.copyOf(supportedVoiceIds);
    }

    /**
     * Synthesizes speech from plain text or SSML.
     *
     * @param text    input text or SSML (must not be null or blank)
     * @param voice   voice configuration
     * @param encoding desired output encoding
     * @return synthesis result with audio content
     * @throws SynthesisException if text is invalid or the voice is unsupported
     */
    public SynthesisResult synthesize(String text, VoiceConfig voice, AudioEncoding encoding) {
        if (text == null || text.isBlank()) {
            throw new SynthesisException("Input text must not be blank", FailureReason.INVALID_REQUEST);
        }
        if (voice == null) {
            throw new SynthesisException("Voice configuration must not be null", FailureReason.INVALID_REQUEST);
        }
        if (encoding == null) {
            throw new SynthesisException("Audio encoding must not be null", FailureReason.INVALID_REQUEST);
        }

        if (voice.voiceId() == null || !supportedVoiceIds.contains(voice.voiceId())) {
            throw new SynthesisException("Unsupported voice: " + voice.voiceId(), FailureReason.INVALID_REQUEST);
        }
        throw new SynthesisException(
                "TTS synthesis is NOT_ADMITTED: no real provider is configured for model " + modelId,
                FailureReason.NOT_ADMITTED);
    }

    /**
     * Returns the model ID this engine was initialized with.
     */
    public String getModelId() { return modelId; }

    /**
     * Returns the set of voice IDs supported by this engine.
     */
    public Set<String> getSupportedVoiceIds() { return supportedVoiceIds; }

    /** Thrown when synthesis fails. */
    public static class SynthesisException extends RuntimeException {
        private final FailureReason reason;

        public SynthesisException(String message) { this(message, FailureReason.INVALID_REQUEST); }
        public SynthesisException(String message, Throwable cause) {
            super(message, cause);
            this.reason = FailureReason.INVALID_REQUEST;
        }
        public SynthesisException(String message, FailureReason reason) {
            super(message);
            this.reason = Objects.requireNonNull(reason, "reason");
        }

        public FailureReason reason() { return reason; }
    }

    /** Stable classification for callers deciding whether to correct or route a request. */
    public enum FailureReason { INVALID_REQUEST, NOT_ADMITTED }
}
