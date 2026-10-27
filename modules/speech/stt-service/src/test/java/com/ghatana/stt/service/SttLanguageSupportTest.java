package com.ghatana.stt.service;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class SttLanguageSupportTest {
    @Test
    void admitsSupportedBaseAndWellFormedRegionalTagsIncludingNepali() {
        assertThat(SttLanguageSupport.isSupported("en")).isTrue();
        assertThat(SttLanguageSupport.isSupported("en-US")).isTrue();
        assertThat(SttLanguageSupport.isSupported("ne")).isTrue();
        assertThat(SttLanguageSupport.isSupported("ne-NP")).isTrue();
    }

    @Test
    void rejectsMalformedAndUnsupportedTags() {
        assertThat(SttLanguageSupport.isSupported("en---US")).isFalse();
        assertThat(SttLanguageSupport.isSupported("en-" )).isFalse();
        assertThat(SttLanguageSupport.isSupported("klingon")).isFalse();
    }

    @Test
    void absentHintAllowsAutomaticDetection() {
        assertThat(SttLanguageSupport.isSupported(null)).isTrue();
        assertThat(SttLanguageSupport.isSupported(" ")).isTrue();
    }
}
