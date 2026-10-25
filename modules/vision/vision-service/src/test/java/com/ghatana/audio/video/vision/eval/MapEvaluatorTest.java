package com.ghatana.audio.video.vision.eval;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/**
 * Unit tests for {@link MapEvaluator}.
 *
 * @doc.type class
 * @doc.purpose Unit tests for mAP evaluation infrastructure
 * @doc.layer product
 * @doc.pattern TestCase
 */
@DisplayName("MapEvaluator")
class MapEvaluatorTest {

    @Test
    @DisplayName("computeMap rejects non-finite and out-of-range IoU thresholds")
    void computeMapValidatesIouThreshold() {
        for (double invalid : new double[] {
                Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, -0.1, 1.1
        }) {
            org.assertj.core.api.Assertions.assertThatThrownBy(
                    () -> MapEvaluator.computeMap(List.of(), List.of(), invalid))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        for (double boundary : new double[] {0.0, 1.0}) {
            org.assertj.core.api.Assertions.assertThatCode(
                    () -> MapEvaluator.computeMap(List.of(), List.of(), boundary))
                    .doesNotThrowAnyException();
        }
    }

    @Test
    @DisplayName("ground truth and prediction boxes validate geometry and snapshot arrays")
    void boxRecordsValidateAndDefensivelySnapshotGeometry() {
        for (double[] invalid : new double[][] {
                null,
                new double[] {0, 0, 1},
                new double[] {0, 0, 1, 1, 1},
                new double[] {Double.NaN, 0, 1, 1},
                new double[] {Double.POSITIVE_INFINITY, 0, 1, 1},
                new double[] {Double.NEGATIVE_INFINITY, 0, 1, 1},
                new double[] {0, Double.NaN, 1, 1},
                new double[] {0, Double.POSITIVE_INFINITY, 1, 1},
                new double[] {0, 0, Double.NaN, 1},
                new double[] {0, 0, Double.POSITIVE_INFINITY, 1},
                new double[] {0, 0, Double.NEGATIVE_INFINITY, 1},
                new double[] {0, 0, 1, Double.NaN},
                new double[] {0, 0, 1, Double.NEGATIVE_INFINITY},
                new double[] {0, 0, -1, 1},
                new double[] {0, 0, 1, -1},
                new double[] {Double.MAX_VALUE, 0, Double.MAX_VALUE, 1},
                new double[] {0, Double.MAX_VALUE, 1, Double.MAX_VALUE},
                new double[] {0, 0, Double.MAX_VALUE, 2}
        }) {
            org.assertj.core.api.Assertions.assertThatThrownBy(
                    () -> new MapEvaluator.GroundTruth("img", "cat", invalid))
                    .isInstanceOf(IllegalArgumentException.class);
            org.assertj.core.api.Assertions.assertThatThrownBy(
                    () -> new MapEvaluator.Prediction("img", "cat", invalid, 0.5))
                    .isInstanceOf(IllegalArgumentException.class);
        }

        double[] callerBox = box(-4, -2, 3, 0);
        MapEvaluator.GroundTruth groundTruth = new MapEvaluator.GroundTruth("img", "cat", callerBox);
        MapEvaluator.Prediction prediction = new MapEvaluator.Prediction("img", "cat", callerBox, 1.0);
        callerBox[0] = Double.NaN;
        groundTruth.box()[0] = Double.POSITIVE_INFINITY;
        prediction.box()[0] = Double.NEGATIVE_INFINITY;
        assertThat(groundTruth.box()).containsExactly(-4, -2, 3, 0);
        assertThat(prediction.box()).containsExactly(-4, -2, 3, 0);
    }

    @Test
    @DisplayName("Prediction confidence must be finite and within inclusive bounds")
    void predictionValidatesConfidence() {
        for (double invalid : new double[] {
                Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, -0.1, 1.1
        }) {
            org.assertj.core.api.Assertions.assertThatThrownBy(
                    () -> new MapEvaluator.Prediction("img", "cat", box(0, 0, 1, 1), invalid))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        for (double boundary : new double[] {0.0, 1.0}) {
            org.assertj.core.api.Assertions.assertThatCode(
                    () -> new MapEvaluator.Prediction("img", "cat", box(0, 0, 1, 1), boundary))
                    .doesNotThrowAnyException();
        }
    }

    // -------------------------------------------------------------------------
    // IoU unit tests
    // -------------------------------------------------------------------------

    @Test
    @DisplayName("IoU: identical boxes → 1.0")
    void iou_identicalBoxes_isOne() { 
        double iou = MapEvaluator.iou(box(0, 0, 10, 10), box(0, 0, 10, 10)); 
        assertThat(iou).isCloseTo(1.0, within(1e-9)); 
    }

    @Test
    @DisplayName("IoU: non-overlapping boxes → 0.0")
    void iou_noOverlap_isZero() { 
        double iou = MapEvaluator.iou(box(0, 0, 5, 5), box(10, 10, 5, 5)); 
        assertThat(iou).isCloseTo(0.0, within(1e-9)); 
    }

    @Test
    @DisplayName("IoU: 50%% overlap → ~0.33")
    void iou_halfOverlap_correctValue() { 
        // a = [0,0,10,10], b = [5,0,10,10]: intersection=50, union=150
        double iou = MapEvaluator.iou(box(0, 0, 10, 10), box(5, 0, 10, 10)); 
        assertThat(iou).isCloseTo(50.0 / 150.0, within(1e-6)); 
    }

    // -------------------------------------------------------------------------
    // AP + mAP tests
    // -------------------------------------------------------------------------

    @Test
    @DisplayName("mAP: perfect predictions → 1.0")
    void map_perfectPredictions_isOne() { 
        var gts = List.of(gt("img1", "cat",  box(0, 0, 10, 10))); 
        var preds = List.of(pred("img1", "cat", box(0, 0, 10, 10), 0.99)); 

        var result = MapEvaluator.computeMap(gts, preds, 0.5); 
        assertThat(result.mAp()).isCloseTo(1.0, within(1e-6)); 
    }

    @Test
    @DisplayName("mAP: no predictions → 0.0")
    void map_noPredictions_isZero() { 
        var gts = List.of(gt("img1", "dog", box(0, 0, 10, 10))); 
        var result = MapEvaluator.computeMap(gts, List.of(), 0.5); 
        assertThat(result.mAp()).isCloseTo(0.0, within(1e-6)); 
    }

    @Test
    @DisplayName("mAP: wrong class → 0.0")
    void map_wrongClass_isZero() { 
        var gts  = List.of(gt("img1", "cat", box(0, 0, 10, 10))); 
        var preds = List.of(pred("img1", "dog", box(0, 0, 10, 10), 0.9)); // wrong class 
        var result = MapEvaluator.computeMap(gts, preds, 0.5); 
        assertThat(result.apFor("cat")).isCloseTo(0.0, within(1e-6));
    }

    @Test
    @DisplayName("mAP: low IoU prediction → 0.0 at iou=0.5")
    void map_lowIouPrediction_isZero() { 
        var gts   = List.of(gt("img1", "car", box(0, 0, 100, 100))); 
        var preds = List.of(pred("img1", "car", box(90, 90, 100, 100), 0.9)); // barely overlapping 
        var result = MapEvaluator.computeMap(gts, preds, 0.5); 
        assertThat(result.apFor("car")).isCloseTo(0.0, within(1e-6));
    }

    @Test
    @DisplayName("mAP: multi-class, partial match → between 0 and 1")
    void map_multiClass_partialMatch() { 
        var gts = List.of( 
            gt("img1", "cat", box(0, 0, 10, 10)), 
            gt("img1", "dog", box(20, 20, 10, 10)) 
        );
        var preds = List.of( 
            pred("img1", "cat", box(0, 0, 10, 10), 0.9),   // correct 
            pred("img1", "dog", box(100, 100, 10, 10), 0.8) // wrong location 
        );
        var result = MapEvaluator.computeMap(gts, preds, 0.5); 
        assertThat(result.mAp()).isGreaterThan(0.0).isLessThan(1.0); 
        assertThat(result.apFor("cat")).isCloseTo(1.0, within(1e-6));
        assertThat(result.apFor("dog")).isCloseTo(0.0, within(1e-6));
    }

    @Test
    @DisplayName("apFor: unknown class → 0.0")
    void apFor_unknownClass_isZero() { 
        var result = MapEvaluator.computeMap(List.of(), List.of(), 0.5); 
        assertThat(result.apFor("unicorn")).isCloseTo(0.0, within(1e-9));
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private static double[] box(double x, double y, double w, double h) { 
        return new double[]{x, y, w, h};
    }

    private static MapEvaluator.GroundTruth gt(String img, String cls, double[] box) { 
        return new MapEvaluator.GroundTruth(img, cls, box); 
    }

    private static MapEvaluator.Prediction pred(String img, String cls, double[] box, double conf) { 
        return new MapEvaluator.Prediction(img, cls, box, conf); 
    }
}
