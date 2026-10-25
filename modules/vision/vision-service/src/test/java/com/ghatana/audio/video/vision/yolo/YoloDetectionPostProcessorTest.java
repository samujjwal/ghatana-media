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

    @Test void mapsModelPixelBoxesBackToAbsoluteSourceRasterPixelsForLetterboxedInput() {
        var transform = LetterboxTransform.fit(1920, 1080, 640);
        var sourceBox = new LetterboxTransform.Box(192, 108, 960, 540);
        var modelBox = transform.toModelPixels(sourceBox);
        var raw = List.of(new YoloOutputParser.Detection(0, 0.75, modelBox.x(), modelBox.y(),
                modelBox.width(), modelBox.height()));

        var result = YoloDetectionPostProcessor.process(raw, CLASSES, transform, 0.5, 1, MODEL).getFirst();

        assertThat(result.getBoundingBox().getX()).isCloseTo(sourceBox.x(),
                org.assertj.core.data.Offset.offset(1.0));
        assertThat(result.getBoundingBox().getY()).isCloseTo(sourceBox.y(),
                org.assertj.core.data.Offset.offset(1.0));
        assertThat(result.getBoundingBox().getWidth()).isCloseTo(sourceBox.width(),
                org.assertj.core.data.Offset.offset(1.0));
        assertThat(result.getBoundingBox().getHeight()).isCloseTo(sourceBox.height(),
                org.assertj.core.data.Offset.offset(1.0));
        assertThat(result.getAttributes().getAdditionalProperties())
                .containsEntry("bbox.coordinate_space", "exif_oriented_source_raster_pixel_xywh");
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

    @Test void nmsThresholdControlsHowMuchOverlapIsSuppressed() {
        var raw = List.of(
                new YoloOutputParser.Detection(0, 0.9, 10, 10, 20, 20),
                new YoloOutputParser.Detection(0, 0.8, 15, 10, 20, 20));
        var transform = LetterboxTransform.fit(100, 100, 100);

        var stricter = YoloDetectionPostProcessor.process(raw, CLASSES, transform, 0.3, 1, MODEL);
        var morePermissive = YoloDetectionPostProcessor.process(raw, CLASSES, transform, 0.7, 1, MODEL);

        assertThat(stricter).hasSize(1);
        assertThat(morePermissive).hasSize(2);
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

    @Test void rejectsDuplicateLabelsThatWouldCollapseDistinctClassesDuringNms() {
        var overlappingClasses = List.of(
                new YoloOutputParser.Detection(0, 0.9, 10, 10, 20, 20),
                new YoloOutputParser.Detection(1, 0.8, 10, 10, 20, 20));

        assertThatThrownBy(() -> YoloDetectionPostProcessor.process(overlappingClasses,
                List.of("animal", "animal"), LetterboxTransform.fit(100, 100, 100), 0.5, 1, MODEL))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("unique");
    }

    @Test void rejectsNonFiniteAndOutOfRangeDirectDetectionValues() {
        var transform = LetterboxTransform.fit(100, 100, 100);
        for (double invalidConfidence : new double[] {Double.NaN, Double.POSITIVE_INFINITY, -0.01, 1.01}) {
            var detection = new YoloOutputParser.Detection(0, invalidConfidence, 10, 10, 20, 20);
            assertThatThrownBy(() -> YoloDetectionPostProcessor.process(
                    List.of(detection), CLASSES, transform, 0.5, 1, MODEL))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("confidence");
        }

        for (double invalidCoordinate : new double[] {
                Double.NaN, Double.NEGATIVE_INFINITY, 640.0 * 16.0 + 1.0, -640.0 * 16.0 - 1.0}) {
            var detection = new YoloOutputParser.Detection(0, 0.9, invalidCoordinate, 10, 20, 20);
            assertThatThrownBy(() -> YoloDetectionPostProcessor.process(
                    List.of(detection), CLASSES, transform, 0.5, 1, MODEL))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("x");
        }

        for (double invalidDimension : new double[] {Double.NaN, Double.POSITIVE_INFINITY, 0.0, -1.0}) {
            var detection = new YoloOutputParser.Detection(0, 0.9, 10, 10, invalidDimension, 20);
            assertThatThrownBy(() -> YoloDetectionPostProcessor.process(
                    List.of(detection), CLASSES, transform, 0.5, 1, MODEL))
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test void rejectsNullDetectionEntriesAndBlankClassLabels() {
        var transform = LetterboxTransform.fit(100, 100, 100);
        assertThatThrownBy(() -> YoloDetectionPostProcessor.process(
                java.util.Arrays.asList((YoloOutputParser.Detection) null), CLASSES, transform, 0.5, 1, MODEL))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("must not be null");
        assertThatThrownBy(() -> YoloDetectionPostProcessor.process(
                List.of(), List.of("cat", " "), transform, 0.5, 1, MODEL))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("labels");
    }

    @Test void rejectsOversizedDirectDetectionListsBeforeQuadraticSuppression() {
        var transform = LetterboxTransform.fit(100, 100, 100);
        var one = new YoloOutputParser.Detection(0, 0.9, 10, 10, 20, 20);
        List<YoloOutputParser.Detection> oversized =
                java.util.Collections.nCopies(YoloOutputParser.MAX_BOXES + 1, one);

        assertThatThrownBy(() -> YoloDetectionPostProcessor.process(
                oversized, CLASSES, transform, 0.5, 1, MODEL))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("count");
    }

    @Test void boundsWorstCaseNmsComparisonsForManyDisjointDetections() {
        var transform = LetterboxTransform.fit(100_000, 100_000, 640);
        List<YoloOutputParser.Detection> disjoint = java.util.stream.IntStream.range(0, 1_500)
                .mapToObj(index -> new YoloOutputParser.Detection(0, 0.9,
                        (index % 320) * 2.0, (index / 320) * 2.0, 0.5, 0.5))
                .toList();

        assertThatThrownBy(() -> YoloDetectionPostProcessor.process(
                disjoint, CLASSES, transform, 0.5, 1, MODEL))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("YOLO non-maximum suppression exceeded its comparison budget");
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
