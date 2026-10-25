package com.ghatana.audio.video.vision.model;

import com.ghatana.audio.video.vision.ocr.OcrService;
import com.ghatana.audio.video.vision.scene.SceneUnderstandingService;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;

class ModelConfidenceValidationTest {

    private static final BoundingBox BOX = BoundingBox.builder()
            .x(0).y(0).width(1).height(1).build();

    @Test
    void classificationCandidateRejectsNonFiniteConfidence() {
        assertThatIllegalArgumentException()
                .isThrownBy(() -> new ClassificationCandidate("object", Double.NaN));
        assertThatIllegalArgumentException()
                .isThrownBy(() -> new ClassificationCandidate("object", Double.POSITIVE_INFINITY));
    }

    @Test
    void detectedFaceRejectsNonFiniteConfidence() {
        assertThatIllegalArgumentException()
                .isThrownBy(() -> new DetectedFace(BOX, Double.NaN));
        assertThatIllegalArgumentException()
                .isThrownBy(() -> new DetectedFace(BOX, Double.NEGATIVE_INFINITY));
    }

    @Test
    void sceneLabelRejectsNonFiniteConfidence() {
        assertThatIllegalArgumentException()
                .isThrownBy(() -> new SceneUnderstandingService.SceneLabel("indoor", Double.NaN));
        assertThatIllegalArgumentException()
                .isThrownBy(() -> new SceneUnderstandingService.SceneLabel("indoor", Double.POSITIVE_INFINITY));
    }

    @Test
    void ocrTextRegionRejectsNonFiniteConfidence() {
        OcrService.BoundingBox textBox = new OcrService.BoundingBox(0, 0, 1, 1);
        assertThatIllegalArgumentException()
                .isThrownBy(() -> new OcrService.TextRegion("text", textBox, Double.NaN, 0));
        assertThatIllegalArgumentException()
                .isThrownBy(() -> new OcrService.TextRegion("text", textBox, Double.NEGATIVE_INFINITY, 0));
    }

    @Test
    void acceptsFiniteConfidenceAtInclusiveBounds() {
        for (double boundary : new double[] {0.0, 1.0}) {
            assertThatCode(() -> new ClassificationCandidate("object", boundary)).doesNotThrowAnyException();
            assertThatCode(() -> new DetectedFace(BOX, boundary)).doesNotThrowAnyException();
            assertThatCode(() -> new SceneUnderstandingService.SceneLabel("indoor", boundary))
                    .doesNotThrowAnyException();
            OcrService.BoundingBox textBox = new OcrService.BoundingBox(0, 0, 1, 1);
            assertThatCode(() -> new OcrService.TextRegion("text", textBox, boundary, 0))
                    .doesNotThrowAnyException();
        }
    }
}
