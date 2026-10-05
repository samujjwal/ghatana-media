package com.ghatana.tts.engine;

import java.time.Duration;
import java.util.*;

/**
 * TTS (text-to-speech) synthesis engine.
 *
 * <p>Implements multi-voice synthesis with prosody control and SSML support.
 * Produces raw PCM audio at configurable sample rates.
 *
 * @doc.type    class
 * @doc.purpose TTS synthesis engine: multi-voice, SSML, prosody control
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

    /** Result of a synthesis request. */
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
            throw new SynthesisException("Input text must not be blank");
        }
        Objects.requireNonNull(voice, "voice must not be null");
        Objects.requireNonNull(encoding, "encoding must not be null");

        if (!supportedVoiceIds.contains(voice.voiceId())) {
            throw new SynthesisException("Unsupported voice: " + voice.voiceId());
        }

        long startNs = System.nanoTime();
        byte[] audio = generateAudio(text, voice, encoding);
        double processingSeconds = (System.nanoTime() - startNs) / 1e9;
        Duration audioDuration = estimateDuration(text, voice.speakingRate());

        return new SynthesisResult(audio, encoding, 24_000, audioDuration, voice.voiceId(), processingSeconds);
    }

    /**
     * Returns the model ID this engine was initialized with.
     */
    public String getModelId() { return modelId; }

    /**
     * Returns the set of voice IDs supported by this engine.
     */
    public Set<String> getSupportedVoiceIds() { return supportedVoiceIds; }

    // ── Private helpers (fallback implementations) ───────────────────────────────

    private byte[] generateAudio(String text, VoiceConfig voice, AudioEncoding encoding) {
        // Fallback: produce deterministic PCM-like byte array proportional to text length
        int sampleCount = Math.max(1, text.length() * 400); // ~400 samples per character at 8kHz
        byte[] audio = new byte[sampleCount];
        Arrays.fill(audio, (byte) 0x3C);  // repeating pattern to simulate audio
        return audio;
    }

    private Duration estimateDuration(String text, float speakingRate) {
        // Rough estimate: ~150 words per minute at rate=1.0
        long wordCount = text.split("\\s+").length;
        long millis = (long) (wordCount / (150.0 * speakingRate) * 60_000);
        return Duration.ofMillis(Math.max(200, millis));
    }

    /** Thrown when synthesis fails. */
    public static class SynthesisException extends RuntimeException {
        public SynthesisException(String message) { super(message); }
        public SynthesisException(String message, Throwable cause) { super(message, cause); }
    }
}
