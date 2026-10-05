package com.ghatana.media.tts.phoneme;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.lang.reflect.Method;
import java.util.Locale;
import java.util.Optional;

/**
 * High-quality phonemiser backed by the espeak-ng native library.
 *
 * <p>espeak-ng supports 100+ languages and produces ARPAbet/X-SAMPA/IPA output.
 * This adapter loads the espeak-ng JNI binding reflectively so the platform
 * does not have a hard compile-time dependency on the native library.
 *
 * <h3>Installation</h3>
 * <ol>
 *   <li>Add {@code net.sourceforge.jespeak:jespeak:2.1} (or a custom espeak-ng JNI wrapper)
 *       to the classpath of your deployment.</li>
 *   <li>Ensure the espeak-ng data directory is on the path:
 *       {@code export ESPEAK_NG_DATA=/usr/lib/x86_64-linux-gnu/espeak-ng-data}</li>
 * </ol>
 *
 * <p>If the library is absent {@link #tryCreate()} returns {@link Optional#empty()}
 * and the engine automatically falls back to {@link HeuristicPhonemeConverter}.
 *
 * @doc.type class
 * @doc.purpose espeak-ng JNI adapter for high-quality phonemisation
 * @doc.layer platform
 * @doc.pattern Adapter
 */
public class EspeakNgPhonemeConverter implements TextToPhonemeConverter {

    private static final Logger LOG = LoggerFactory.getLogger(EspeakNgPhonemeConverter.class);

    /** Reflective handle to the espeak-ng textToPhonemes method. */
    private final Object espeakInstance;
    private final Method  textToPhonemes;

    private EspeakNgPhonemeConverter(Object espeakInstance, Method textToPhonemes) {
        this.espeakInstance = espeakInstance;
        this.textToPhonemes = textToPhonemes;
    }

    /**
     * Attempt to create an instance backed by espeak-ng.
     *
     * @return present if espeak-ng JNI is available, empty otherwise
     */
    public static Optional<EspeakNgPhonemeConverter> tryCreate() {
        try {
            // Attempt to load espeak-ng JNI wrapper class
            Class<?> cls = Class.forName("net.sourceforge.jespeak.JEspeak");
            Object instance = cls.getDeclaredConstructor().newInstance();
            Method initialize = cls.getMethod("initialize", String.class);
            String dataDir = System.getenv().getOrDefault(
                "ESPEAK_NG_DATA",
                "/usr/lib/x86_64-linux-gnu/espeak-ng-data"
            );
            initialize.invoke(instance, dataDir);
            Method method = cls.getMethod("textToPhonemes", String.class, String.class);
            LOG.info("espeak-ng JNI binding loaded successfully (data={})", dataDir);
            return Optional.of(new EspeakNgPhonemeConverter(instance, method));
        } catch (ClassNotFoundException e) {
            LOG.debug("espeak-ng JNI not on classpath — using heuristic phonemiser");
            return Optional.empty();
        } catch (Exception e) {
            LOG.warn("espeak-ng initialisation failed: {} — using heuristic phonemiser", e.getMessage());
            return Optional.empty();
        }
    }

    @Override
    public String convert(String text, Locale locale) {
        try {
            String langCode = locale.getLanguage();  // "en", "fr", etc.
            return (String) textToPhonemes.invoke(espeakInstance, text, langCode);
        } catch (Exception e) {
            throw new TextToPhonemeConverter.PhonemeConversionException(
                "espeak-ng conversion failed for: " + text, e);
        }
    }

    @Override
    public int qualityTier() {
        return 10; // highest priority
    }
}
