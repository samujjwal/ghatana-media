package com.ghatana.audio.video.vision.ocr;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;
import static org.assertj.core.api.Assertions.assertThatNullPointerException;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Unit tests for {@link OcrService} — AV-009.3.
 *
 * @doc.type class
 * @doc.purpose OCR accuracy and structural output tests
 * @doc.layer product
 * @doc.pattern Test
 */
@DisplayName("OcrService")
class OcrServiceTest {

    private static final OcrService.BoundingBox BOX = new OcrService.BoundingBox(0.0, 0.0, 1.0, 0.1); 

    /** Stub model: returns two regions — one high confidence, one low confidence. */
    private static final OcrService.OcrModel STUB_MODEL = imageBytes -> List.of( 
            new OcrService.TextRegion("Hello World", BOX, 0.97, 0), 
            new OcrService.TextRegion("Low confidence", BOX, 0.50, 1) 
    );

    // ─── of() ───────────────────────────────────────────────────────────────── 

    @Test
    @DisplayName("of(null) throws NullPointerException")
    void of_null_throwsNPE() { 
        assertThatNullPointerException().isThrownBy(() -> OcrService.of(null)); 
    }

    @Test
    @DisplayName("of(model, threshold > 1) throws IllegalArgumentException")
    void of_invalidThreshold_throwsIAE() { 
        assertThatIllegalArgumentException() 
                .isThrownBy(() -> OcrService.of(STUB_MODEL, 1.5)); 
    }

    // ─── extract() ──────────────────────────────────────────────────────────── 

    @Nested
    @DisplayName("extract()")
    class Extract {

        @Test
        @DisplayName("returns only regions above the confidence threshold")
        void extract_filtersLowConfidence() { 
            OcrService service = OcrService.of(STUB_MODEL, 0.70); 
            List<OcrService.TextRegion> regions = service.extract(new byte[]{1, 2, 3}); 
            assertThat(regions).hasSize(1); 
            assertThat(regions.get(0).text()).isEqualTo("Hello World");
        }

        @Test
        @DisplayName("default threshold of 0.70 filters low-confidence region")
        void extract_defaultThreshold_filters() { 
            OcrService service = OcrService.of(STUB_MODEL); 
            List<OcrService.TextRegion> regions = service.extract(new byte[]{1}); 
            assertThat(regions).hasSize(1); 
        }

        @Test
        @DisplayName("threshold of 0.0 includes all regions")
        void extract_zeroThreshold_includesAll() { 
            OcrService service = OcrService.of(STUB_MODEL, 0.0); 
            List<OcrService.TextRegion> regions = service.extract(new byte[]{1}); 
            assertThat(regions).hasSize(2); 
        }

        @Test
        @DisplayName("null imageBytes throws NullPointerException")
        void extract_null_throwsNPE() { 
            OcrService service = OcrService.of(STUB_MODEL); 
            assertThatNullPointerException().isThrownBy(() -> service.extract(null)); 
        }

        @Test
        @DisplayName("empty imageBytes throws IllegalArgumentException")
        void extract_empty_throwsIAE() { 
            OcrService service = OcrService.of(STUB_MODEL); 
            assertThatIllegalArgumentException() 
                    .isThrownBy(() -> service.extract(new byte[0])); 
        }

        @Test
        @DisplayName("returned list is unmodifiable")
        void extract_unmodifiable() { 
            OcrService service = OcrService.of(STUB_MODEL); 
            var regions = service.extract(new byte[]{1}); 
            assertThatThrownBy(() -> regions.add( 
                    new OcrService.TextRegion("x", BOX, 0.99, 0))) 
                    .isInstanceOf(UnsupportedOperationException.class); 
        }
    }

    // ─── extractText() ──────────────────────────────────────────────────────── 

    @Nested
    @DisplayName("extractText()")
    class ExtractText {

        @Test
        @DisplayName("concatenates recognised text regions with newlines")
        void extractText_concatenatesRegions() { 
            OcrService service = OcrService.of(STUB_MODEL, 0.0); // include all 
            String text = service.extractText(new byte[]{1, 2}); 
            assertThat(text).contains("Hello World").contains("Low confidence");
        }

        @Test
        @DisplayName("returns empty string for image with no regions above threshold")
        void extractText_noneAboveThreshold_empty() { 
            OcrService noMatch = OcrService.of(STUB_MODEL, 0.99); 
            String text = noMatch.extractText(new byte[]{1}); 
            assertThat(text).isEmpty(); 
        }
    }

    // ─── TextRegion validation ────────────────────────────────────────────────

    @Nested
    @DisplayName("TextRegion")
    class TextRegionTests {

        @Test
        @DisplayName("null text throws NullPointerException")
        void textRegion_nullText_throwsNPE() { 
            assertThatNullPointerException() 
                    .isThrownBy(() -> new OcrService.TextRegion(null, BOX, 0.9, 0)); 
        }

        @Test
        @DisplayName("confidence > 1 throws IllegalArgumentException")
        void textRegion_invalidConfidence_throwsIAE() { 
            assertThatIllegalArgumentException() 
                    .isThrownBy(() -> new OcrService.TextRegion("t", BOX, 1.1, 0)); 
        }

        @Test
        @DisplayName("readingOrder < 0 throws IllegalArgumentException")
        void textRegion_negativeReadingOrder_throwsIAE() { 
            assertThatIllegalArgumentException() 
                    .isThrownBy(() -> new OcrService.TextRegion("t", BOX, 0.9, -1)); 
        }
    }
}
