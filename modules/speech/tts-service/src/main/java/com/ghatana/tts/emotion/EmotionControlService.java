package com.ghatana.tts.emotion;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Objects;
import java.util.Set;

/**
 * Emotion control service for TTS synthesis (AV-008.2).
 *
 * <p>Translates a high-level {@link EmotionType} into prosody adjustments
 * (speaking rate, pitch, volume, SSML prosody tags) that the underlying
 * synthesis engine can consume.  Supports the four canonical emotional tones:
 * {@code HAPPY}, {@code SAD}, {@code NEUTRAL}, and {@code EXCITED}.
 *
 * @doc.type    class
 * @doc.purpose Emotional tone prosody adapter for TTS synthesis
 * @doc.layer   product
 * @doc.pattern Service
 */
public final class EmotionControlService {

    private static final Logger LOG = LoggerFactory.getLogger(EmotionControlService.class);

    /** Supported canonical emotion types (AV-008.2). */
    public enum EmotionType {
        HAPPY, SAD, NEUTRAL, EXCITED;

        /** Returns {@code true} if the given string matches a valid emotion (case-insensitive). */
        public static boolean isValid(String name) {
            if (name == null) return false;
            try {
                valueOf(name.toUpperCase(java.util.Locale.ROOT));
                return true;
            } catch (IllegalArgumentException e) {
                return false;
            }
        }
    }

    private EmotionControlService() {}

    /** Singleton instance — stateless, so a single instance is sufficient. */
    public static final EmotionControlService INSTANCE = new EmotionControlService();

    // ── Prosody resolution ────────────────────────────────────────────────────

    /**
     * Returns the prosody parameters for the given emotion.
     *
     * @param emotion emotion type (must not be null)
     * @return prosody parameters; never {@code null}
     */
    public ProsodyParameters prosodyFor(EmotionType emotion) {
        Objects.requireNonNull(emotion, "emotion must not be null");
        return switch (emotion) {
            case HAPPY    -> new ProsodyParameters(emotion, 1.10f, 0.15f, 0.05f,
                    "<prosody rate=\"fast\" pitch=\"+10%\">", "</prosody>");
            case SAD      -> new ProsodyParameters(emotion, 0.85f, -0.20f, -0.05f,
                    "<prosody rate=\"slow\" pitch=\"-20%\">", "</prosody>");
            case NEUTRAL  -> new ProsodyParameters(emotion, 1.00f,  0.00f,  0.00f,
                    "", "");
            case EXCITED  -> new ProsodyParameters(emotion, 1.20f, 0.25f, 0.10f,
                    "<prosody rate=\"x-fast\" pitch=\"+25%\" volume=\"loud\">", "</prosody>");
        };
    }

    /**
     * Applies SSML prosody tags for the given emotion to the provided text.
     *
     * @param text    input text to wrap (must not be blank)
     * @param emotion emotion type
     * @return SSML-annotated text; or plain text if the emotion produces no tags
     */
    public String applyEmotionSsml(String text, EmotionType emotion) {
        if (text == null || text.isBlank()) {
            throw new IllegalArgumentException("text must not be blank");
        }
        ProsodyParameters params = prosodyFor(emotion);
        String result = params.ssmlOpenTag() + text + params.ssmlCloseTag();
        LOG.debug("Applied emotion={} to text (len={}), ssmlOpen='{}'",
                emotion, text.length(), params.ssmlOpenTag());
        return result;
    }

    /**
     * Parses an emotion from a string, case-insensitively.
     *
     * @param name string representation of the emotion
     * @return parsed emotion type
     * @throws IllegalArgumentException if the string does not match any emotion
     */
    public static EmotionType parseEmotion(String name) {
        if (name == null || name.isBlank())
            throw new IllegalArgumentException("emotion name must not be blank");
        try {
            return EmotionType.valueOf(name.toUpperCase(java.util.Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("Unknown emotion '" + name
                    + "'. Supported: " + Set.of(EmotionType.values()), e);
        }
    }

    // ── Nested types ──────────────────────────────────────────────────────────

    /**
     * Prosody parameters derived from an emotion.
     *
     * @param emotion         the source emotion
     * @param speakingRateMul speaking rate multiplier (1.0 = neutral)
     * @param pitchShiftSt    pitch shift in semitones (0.0 = neutral)
     * @param volumeGainDb    volume gain in dB (0.0 = neutral)
     * @param ssmlOpenTag     SSML open tag string (empty for NEUTRAL)
     * @param ssmlCloseTag    SSML close tag string (empty for NEUTRAL)
     */
    public record ProsodyParameters(
            EmotionType emotion,
            float speakingRateMul,
            float pitchShiftSt,
            float volumeGainDb,
            String ssmlOpenTag,
            String ssmlCloseTag
    ) {
        /** Returns {@code true} if any SSML annotation is needed. */
        public boolean hasSsml() { return !ssmlOpenTag.isEmpty(); }
    }
}
