package com.ghatana.stt.service;

import java.util.Locale;
import java.util.IllformedLocaleException;
import java.util.Set;

/** Shared syntax and conservative language-hint validation for STT entry points. */
public final class SttLanguageSupport {
    private static final Set<String> SUPPORTED_BASE_LANGUAGES = Set.of(
            "en", "ne", "hi", "es", "fr", "de", "ja", "zh");

    private SttLanguageSupport() {}

    /** A blank or absent hint means automatic language selection; malformed or unsupported tags fail closed. */
    public static boolean isSupported(String languageTag) {
        if (languageTag == null || languageTag.isBlank()) return true;
        try {
            Locale locale = new Locale.Builder().setLanguageTag(languageTag).build();
            String language = locale.getLanguage();
            return !language.isEmpty() && SUPPORTED_BASE_LANGUAGES.contains(language);
        } catch (IllformedLocaleException invalidTag) {
            return false;
        }
    }

    public static Set<String> supportedBaseLanguages() {
        return SUPPORTED_BASE_LANGUAGES;
    }
}
