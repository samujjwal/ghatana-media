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
}
