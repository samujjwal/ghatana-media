package com.ghatana.media.tts.phoneme;

import java.util.Locale;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class HeuristicPhonemeConverterLocaleTest {
    private final HeuristicPhonemeConverter converter = new HeuristicPhonemeConverter();

    @Test
    void supportsEnglishVoiceLocales() {
        assertThat(converter.convert("hello", Locale.US)).isNotBlank();
    }

    @Test
    void doesNotSilentlyPhonemiseUnsupportedLanguageAsEnglish() {
        assertThatThrownBy(() -> converter.convert("hola", Locale.forLanguageTag("es-ES")))
                .isInstanceOf(TextToPhonemeConverter.PhonemeConversionException.class)
                .hasMessageContaining("only supports English")
                .hasMessageContaining("es-ES");
    }

    @Test
    void requiresAnExplicitLocaleForDirectHeuristicUse() {
        assertThatThrownBy(() -> converter.convert("hello", null))
                .isInstanceOf(TextToPhonemeConverter.PhonemeConversionException.class)
                .hasMessageContaining("locale: unspecified");
    }

    @Test
    void pinnedPiperProcessPhonemizerRejectsLocalesOutsideItsEnUsBundle() {
        assertThatThrownBy(() -> PiperPhonemizeProcessConverter.requireSupportedLocale(
                Locale.forLanguageTag("en-GB")))
                .isInstanceOf(TextToPhonemeConverter.PhonemeConversionException.class)
                .hasMessageContaining("only supports en-US")
                .hasMessageContaining("en-GB");
        assertThatThrownBy(() -> PiperPhonemizeProcessConverter.requireSupportedLocale(
                Locale.forLanguageTag("hi-IN")))
                .isInstanceOf(TextToPhonemeConverter.PhonemeConversionException.class)
                .hasMessageContaining("hi-IN");
        assertThatThrownBy(() -> PiperPhonemizeProcessConverter.requireSupportedLocale(null))
                .isInstanceOf(TextToPhonemeConverter.PhonemeConversionException.class)
                .hasMessageContaining("unspecified");
    }

    @Test
    void pinnedPiperProcessPhonemizerAcceptsEnUsAndLegacyUnregionedEnglish() {
        PiperPhonemizeProcessConverter.requireSupportedLocale(Locale.US);
        PiperPhonemizeProcessConverter.requireSupportedLocale(Locale.ENGLISH);
    }
}
