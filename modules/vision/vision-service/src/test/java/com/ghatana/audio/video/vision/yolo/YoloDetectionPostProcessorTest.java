package com.ghatana.audio.video.vision.yolo;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import org.junit.jupiter.api.Test;

class YoloDetectionPostProcessorTest {
    private static final YoloDetectionPostProcessor.Provenance MODEL =
            new YoloDetectionPostProcessor.Provenance("fixture-model", "fixture-version", "a".repeat(64));
    private static final List<String> CLASSES = List.of("cat", "dog");

    @Test void clipsBoxesMapsClassNamesAndIncludesPinnedModelVersionWithoutProbabilityClaim() {
        var raw = List.of(new YoloOutputParser.Detection(1, 0.91, -10, 10, 20, 20));
        var result = YoloDetectionPostProcessor.process(raw, CLASSES,
                LetterboxTransform.fit(100, 100, 100), 0.5, 1, MODEL);
        assertThat(result).hasSize(1);
        assertThat(result.getFirst().getClassName()).isEqualTo("dog");
        assertThat(result.getFirst().getConfidence()).isEqualTo(0.91);
        assertThat(result.getFirst().getBoundingBox().getX()).isZero();
        assertThat(result.getFirst().getBoundingBox().getWidth()).isEqualTo(10);
        assertThat(result.getFirst().getAttributes().getAdditionalProperties())
                .containsEntry("model.version", "fixture-version")
                .containsEntry("model.sha256", "a".repeat(64))
                .containsEntry("confidence.unit", "raw_yolo_score_0_1_uncalibrated");
    }

    @Test void suppressesOverlappingBoxesOfTheSameClassButKeepsDifferentClasses() {
        var raw = List.of(
                new YoloOutputParser.Detection(0, 0.9, 10, 10, 20, 20),
                new YoloOutputParser.Detection(0, 0.8, 15, 10, 20, 20),
                new YoloOutputParser.Detection(1, 0.7, 15, 10, 20, 20));
        var result = YoloDetectionPostProcessor.process(raw, CLASSES,
                LetterboxTransform.fit(100, 100, 100), 0.5, 1, MODEL);
        assertThat(result).extracting(detection -> detection.getClassName() + ":" + detection.getConfidence())
                .containsExactly("cat:0.9", "dog:0.7");
    }

    @Test void rejectsUnknownClassIdsInvalidNmsAndUnpinnedProvenance() {
        var unknownClass = List.of(new YoloOutputParser.Detection(2, 0.9, 1, 1, 2, 2));
        assertThatThrownBy(() -> YoloDetectionPostProcessor.process(unknownClass, CLASSES,
                LetterboxTransform.fit(100, 100, 100), 0.5, 1, MODEL))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("class id");
        assertThatThrownBy(() -> YoloDetectionPostProcessor.process(List.of(), CLASSES,
                LetterboxTransform.fit(100, 100, 100), Double.NaN, 1, MODEL))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("NMS threshold");
        assertThatThrownBy(() -> new YoloDetectionPostProcessor.Provenance("id", "version", "not-a-digest"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("SHA-256");
    }

    @Test void outputProvenanceChangesWhenTheAdmittedModelVersionChanges() {
        var raw = List.of(new YoloOutputParser.Detection(0, 0.9, 10, 10, 20, 20));
        var transform = LetterboxTransform.fit(100, 100, 100);
        var first = YoloDetectionPostProcessor.process(raw, CLASSES, transform, 0.5, 1, MODEL).getFirst();
        var nextVersion = new YoloDetectionPostProcessor.Provenance("fixture-model", "next-version", "b".repeat(64));
        var second = YoloDetectionPostProcessor.process(raw, CLASSES, transform, 0.5, 1, nextVersion).getFirst();
        assertThat(first.getAttributes().getAdditionalProperties()).containsEntry("model.version", "fixture-version");
        assertThat(second.getAttributes().getAdditionalProperties()).containsEntry("model.version", "next-version");
        assertThat(second.getAttributes().getAdditionalProperties()).containsEntry("model.sha256", "b".repeat(64));
    }
}
