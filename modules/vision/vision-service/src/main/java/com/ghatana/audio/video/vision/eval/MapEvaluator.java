package com.ghatana.audio.video.vision.eval;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Mean Average Precision (mAP) evaluator for object-detection models.
 *
 * <p>Implements the COCO-style mAP calculation:
 * <ul>
 *   <li>IoU threshold configurable (default 0.50).</li>
 *   <li>Per-class Average Precision computed via 11-point interpolation.</li>
 *   <li>mAP is the macro-average of per-class APs.</li>
 * </ul>
 *
 * @doc.type class
 * @doc.purpose COCO-style mAP evaluation for vision models
 * @doc.layer product
 * @doc.pattern Utility
 */
public final class MapEvaluator {

    private MapEvaluator() {}

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Compute per-class Average Precision (AP) and macro mAP.
     *
     * @param groundTruths list of ground-truth bounding boxes
     * @param predictions  list of model predictions (with confidence scores)
     * @param iouThreshold IoU threshold for a detection to count as a true positive
     * @return {@link MapResult} containing per-class AP values and overall mAP
     */
    public static MapResult computeMap(
            List<GroundTruth> groundTruths,
            List<Prediction> predictions,
            double iouThreshold) {

        // Collect all class names
        List<String> classes = groundTruths.stream()
                .map(GroundTruth::className)
                .distinct()
                .sorted()
                .toList();

        List<ClassAp> classAps = new ArrayList<>();
        for (String cls : classes) {
            double ap = computeAp(cls, groundTruths, predictions, iouThreshold);
            classAps.add(new ClassAp(cls, ap));
        }

        double mApValue = classAps.stream()
                .mapToDouble(ClassAp::ap)
                .average()
                .orElse(0.0);

        return new MapResult(mApValue, Collections.unmodifiableList(classAps));
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private static double computeAp(
            String className,
            List<GroundTruth> allGts,
            List<Prediction> allPreds,
            double iouThreshold) {

        List<GroundTruth> gts = allGts.stream()
                .filter(g -> g.className().equals(className))
                .toList();
        List<Prediction> preds = allPreds.stream()
                .filter(p -> p.className().equals(className))
                .sorted((a, b) -> Double.compare(b.confidence(), a.confidence())) // descending
                .toList();

        int nGt = gts.size();
        if (nGt == 0 || preds.isEmpty()) return 0.0;

        boolean[] matched = new boolean[gts.size()];
        int tp = 0, fp = 0;
        double[] precisions = new double[preds.size()];
        double[] recalls    = new double[preds.size()];

        for (int i = 0; i < preds.size(); i++) {
            Prediction pred = preds.get(i);
            // Find the best-matching (unmatched) ground-truth box for this image
            int bestIdx = -1;
            double bestIou = iouThreshold - 1e-9; // must exceed threshold
            for (int j = 0; j < gts.size(); j++) {
                if (matched[j] || !gts.get(j).imageId().equals(pred.imageId())) continue;
                double iou = iou(gts.get(j).box(), pred.box());
                if (iou > bestIou) { bestIou = iou; bestIdx = j; }
            }
            if (bestIdx >= 0) {
                matched[bestIdx] = true;
                tp++;
            } else {
                fp++;
            }
            precisions[i] = (double) tp / (tp + fp);
            recalls[i]    = (double) tp / nGt;
        }

        return elevenPointInterpolation(precisions, recalls);
    }

    /**
     * 11-point interpolated average precision (Pascal VOC style).
     */
    private static double elevenPointInterpolation(double[] precisions, double[] recalls) {
        double sum = 0.0;
        for (int k = 0; k <= 10; k++) {
            double recallThresh = k / 10.0;
            double maxPrec = 0.0;
            for (int i = 0; i < recalls.length; i++) {
                if (recalls[i] >= recallThresh) maxPrec = Math.max(maxPrec, precisions[i]);
            }
            sum += maxPrec;
        }
        return sum / 11.0;
    }

    /**
     * Intersection over Union for two axis-aligned bounding boxes.
     *
     * @param a box as [x, y, width, height]
     * @param b box as [x, y, width, height]
     * @return IoU in [0, 1]
     */
    static double iou(double[] a, double[] b) {
        double ax1 = a[0], ay1 = a[1], ax2 = a[0] + a[2], ay2 = a[1] + a[3];
        double bx1 = b[0], by1 = b[1], bx2 = b[0] + b[2], by2 = b[1] + b[3];

        double interX = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
        double interY = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
        double intersection = interX * interY;

        if (intersection == 0) return 0.0;

        double areaA = a[2] * a[3];
        double areaB = b[2] * b[3];
        return intersection / (areaA + areaB - intersection);
    }

    // -------------------------------------------------------------------------
    // Data types
    // -------------------------------------------------------------------------

    /**
     * Ground-truth annotation for a single object.
     *
     * @param imageId   unique image identifier
     * @param className category label (e.g. "person", "car")
     * @param box       bounding box [x, y, width, height] in pixels
     */
    public record GroundTruth(String imageId, String className, double[] box) {}

    /**
     * Model prediction for a single detected object.
     *
     * @param imageId    image this prediction belongs to
     * @param className  predicted category
     * @param box        predicted bounding box [x, y, width, height]
     * @param confidence detection confidence score in [0, 1]
     */
    public record Prediction(String imageId, String className, double[] box, double confidence) {}

    /**
     * Per-class Average Precision.
     *
     * @param className class label
     * @param ap        11-point interpolated AP in [0, 1]
     */
    public record ClassAp(String className, double ap) {}

    /**
     * Full mAP evaluation result.
     *
     * @param mAp      macro-mean Average Precision across all classes
     * @param classAps per-class AP breakdown
     */
    public record MapResult(double mAp, List<ClassAp> classAps) {
        /** Returns the AP for a specific class, or 0 if not found. */
        public double apFor(String className) {
            return classAps.stream()
                    .filter(c -> c.className().equals(className))
                    .mapToDouble(ClassAp::ap)
                    .findFirst()
                    .orElse(0.0);
        }
    }
}
