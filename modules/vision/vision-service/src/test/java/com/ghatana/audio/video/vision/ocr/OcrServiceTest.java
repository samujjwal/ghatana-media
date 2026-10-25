package com.ghatana.audio.video.vision.ocr;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

class OcrServiceTest {

    @Test
    void extractFailsNotAdmittedWithoutCallingLegacyModel() {
        AtomicInteger calls = new AtomicInteger();
        OcrService service = OcrService.of(image -> {
            calls.incrementAndGet();
            return List.of();
        });

        assertThatThrownBy(() -> service.extract(new byte[]{1}))
                .isInstanceOf(OcrService.NotAdmittedException.class)
                .hasMessage("NOT_ADMITTED: Document Intelligence public API adapter is unavailable");
        org.assertj.core.api.Assertions.assertThat(calls).hasValue(0);
    }

    @Test
    void extractTextAlsoFailsNotAdmittedWithoutCallingLegacyModel() {
        AtomicInteger calls = new AtomicInteger();
        OcrService service = OcrService.of(image -> {
            calls.incrementAndGet();
            return List.of();
        });

        assertThatThrownBy(() -> service.extractText(new byte[]{1}))
                .isInstanceOf(OcrService.NotAdmittedException.class)
                .hasMessage("NOT_ADMITTED: Document Intelligence public API adapter is unavailable");
        org.assertj.core.api.Assertions.assertThat(calls).hasValue(0);
    }
}
