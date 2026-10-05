package com.ghatana.media.tts.phoneme;

import java.util.Locale;

/**
 * Strategy interface for converting plain text to a phoneme representation.
 *
 * <p>The default implementation ({@link HeuristicPhonemeConverter}) uses
 * rule-based English phonemisation and is always available without native
 * libraries.  A higher-quality implementation backed by
 * <a href="https://espeak-ng.org/">espeak-ng</a> can be wired in at runtime
 * by providing a {@code TextToPhonemeConverter} bean/factory that delegates to
 * the native espeak-ng JNI binding (see {@link EspeakNgPhonemeConverter}).
 *
 * <p>Example usage (platform-internal):
 * <pre>{@code
 * TextToPhonemeConverter converter = TextToPhonemeConverter.forLocale(Locale.ENGLISH);
 * String phonemes = converter.convert("Hello world");
 * }</pre>
 *
 * @doc.type interface
 * @doc.purpose SPI for text-to-phoneme conversion backends
 * @doc.layer platform
 * @doc.pattern Strategy
 */
public interface TextToPhonemeConverter {

    /**
     * Convert plain text to a phoneme string suitable for passing to a TTS
     * inference engine.
     *
     * @param text  raw input text (may contain punctuation, numbers, etc.)
     * @param locale target language/locale for phonemisation
     * @return phoneme sequence (ARPAbet or IPA depending on implementation)
     * @throws PhonemeConversionException if conversion fails unrecoverably
     */
    String convert(String text, Locale locale);

    /**
     * Convenience overload using {@link Locale#ENGLISH}.
     */
    default String convert(String text) {
        return convert(text, Locale.ENGLISH);
    }

    /**
     * Return the quality tier of this implementation.
     * Higher tier = better quality; the platform selects the highest available.
     */
    default int qualityTier() {
        return 0;
    }

    // ── Factory ──────────────────────────────────────────────────────────────

    /**
     * Returns the best available converter for the given locale.
     *
     * <p>Tries {@link EspeakNgPhonemeConverter} first (quality tier 10).
     * Falls back to {@link HeuristicPhonemeConverter} (quality tier 1) if
     * espeak-ng native library is not available.
     *
     * @param locale target locale
     * @return best available converter
     */
    static TextToPhonemeConverter forLocale(Locale locale) {
        return EspeakNgPhonemeConverter.tryCreate()
            .<TextToPhonemeConverter>map(e -> e)
            .orElseGet(HeuristicPhonemeConverter::new);
    }

    // ── Exception ─────────────────────────────────────────────────────────────

    /** Thrown when phonemisation fails. */
    class PhonemeConversionException extends RuntimeException {
        public PhonemeConversionException(String message) {
            super(message);
        }
        public PhonemeConversionException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
