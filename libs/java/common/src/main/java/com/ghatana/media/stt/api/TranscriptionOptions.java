package com.ghatana.media.stt.api;

import java.time.Duration;
import java.util.Locale;

/**
 * Immutable options controlling a single transcription request.
 *
 * <p>Use {@link #defaults()} for sensible out-of-the-box behaviour, or
 * {@link #builder()} when fine-grained control is needed:
 * <pre>{@code
 * TranscriptionOptions opts = TranscriptionOptions.builder()
 *     .language(Locale.FRENCH)
 *     .enableTimestamps(true)
 *     .maxAlternatives(3)
 *     .timeout(Duration.ofSeconds(10))
 *     .build();
 * }</pre>
 *
 * <p>Constraints:
 * <ul>
 *   <li>{@code maxAlternatives} must be ≥ 1; passing zero or negative is treated as 1.</li>
 *   <li>{@code timeout} must be positive; {@code null} defers to the engine default.</li>
 *   <li>{@code vocabulary} is a hint only — not all engine backends support custom vocabularies;
 *       unsupported values are silently ignored rather than rejected.</li>
 * </ul>
 *
 * @doc.type record
 * @doc.purpose Immutable STT transcription options
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record TranscriptionOptions(
    /** BCP-47 language locale used by the recogniser; defaults to {@code Locale.getDefault()}. */
    Locale language,
    /** When {@code true}, the engine inserts punctuation marks into the transcript. */
    boolean enablePunctuation,
    /**
     * When {@code true}, {@link TranscriptionResult} will include per-word
     * {@link WordTiming} start/end offsets.
     */
    boolean enableTimestamps,
    /**
     * Maximum number of alternative transcription hypotheses to return (≥ 1).
     * Higher values increase memory usage and processing time.
     */
    int maxAlternatives,
    /** When {@code true}, replaces profane words with asterisks before returning the result. */
    boolean profanityFilter,
    /**
     * Optional custom vocabulary hint.  Accepts whitespace-separated words or a
     * URI pointing to a vocabulary file.  Not supported by all engine backends;
     * unsupported values are silently ignored.
     */
    String vocabulary,
    /**
     * Maximum wall-clock time the engine may spend on a single transcription.
     * A {@code null} value defers to the engine's built-in default timeout.
     * Must be positive when non-null.
     */
    Duration timeout
) {
    public static TranscriptionOptions defaults() {
        return new TranscriptionOptions(Locale.getDefault(), true, false, 1, false, null, Duration.ofSeconds(30));
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private Locale language = Locale.getDefault();
        private boolean enablePunctuation = true;
        private boolean enableTimestamps = false;
        private int maxAlternatives = 1;
        private boolean profanityFilter = false;
        private String vocabulary;
        private Duration timeout = Duration.ofSeconds(30);

        public Builder language(Locale value) { this.language = value; return this; }
        public Builder enablePunctuation(boolean value) { this.enablePunctuation = value; return this; }
        public Builder enableTimestamps(boolean value) { this.enableTimestamps = value; return this; }
        public Builder maxAlternatives(int value) { this.maxAlternatives = value; return this; }
        public Builder profanityFilter(boolean value) { this.profanityFilter = value; return this; }
        public Builder vocabulary(String value) { this.vocabulary = value; return this; }
        public Builder timeout(Duration value) { this.timeout = value; return this; }

        public TranscriptionOptions build() {
            return new TranscriptionOptions(language, enablePunctuation, enableTimestamps, maxAlternatives, profanityFilter, vocabulary, timeout);
        }
    }
}
