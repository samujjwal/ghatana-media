package com.ghatana.audio.video.vision.analysis;

import com.ghatana.audio.video.vision.image.BoundedImageDecoder;
import com.ghatana.audio.video.vision.video.SourceMediaTimestamp;
import java.awt.image.BufferedImage;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.opencv.core.CvType;
import org.opencv.core.Mat;
import org.opencv.core.MatOfByte;
import org.opencv.core.MatOfFloat;
import org.opencv.core.MatOfPoint;
import org.opencv.core.MatOfPoint2f;
import org.opencv.core.Point;
import org.opencv.core.Size;
import org.opencv.core.TermCriteria;
import org.opencv.imgproc.Imgproc;
import org.opencv.video.Video;

/**
 * Bounded global optical-flow candidate for adjacent video frames.
 *
 * <p>A spatially distributed consensus estimates image-plane translation. It is not a
 * ground-truth camera pose: a large coherently moving subject can still resemble camera motion.
 * The result is therefore labeled as an uncalibrated candidate with qualitative uncertainty.
 */
public final class CameraMotionHeuristic {
    private static final int MAX_WORK_SIDE = 320;
    private static final int MIN_WORK_SIDE = 48;
    private static final int MAX_FEATURES = 400;
    private static final int GRID_SIDE = 4;
    private static final int MIN_TRACKED_FEATURES = 12;
    private static final int MIN_CONSENSUS_FEATURES = 12;
    private static final int MIN_CONSENSUS_CELLS = 8;
    private static final double MIN_SUPPORT_FRACTION = 0.70;
    private static final double MAX_TRACK_ERROR = 25.0;
    private static final double MAX_WORK_DISPLACEMENT = 40.0;
    private static final double CONSENSUS_RADIUS = 1.5;
    private static final double NO_TRANSLATION_RADIUS = 0.75;

    private CameraMotionHeuristic() { }

    static Assessment compare(int previousFrameNumber, SourceMediaTimestamp previousTimestamp,
                              byte[] previousFrame, int frameNumber, SourceMediaTimestamp timestamp,
                              byte[] frame, int samplingFps) {
        SourceMediaTimestamp resultTimestamp = timestamp == null
                ? SourceMediaTimestamp.unknown("SOURCE_TIMESTAMP_MISSING") : timestamp;
        if ((long) frameNumber != (long) previousFrameNumber + 1L) {
            return Assessment.unknown(previousFrameNumber, frameNumber, resultTimestamp, UnknownReason.FRAME_GAP);
        }
        if (previousTimestamp == null || !previousTimestamp.isKnown()
                || timestamp == null || !timestamp.isKnown()) {
            return Assessment.unknown(previousFrameNumber, frameNumber, resultTimestamp,
                    UnknownReason.SOURCE_TIMESTAMP_UNKNOWN);
        }
        if (comparePts(timestamp, previousTimestamp) <= 0) {
            return Assessment.unknown(previousFrameNumber, frameNumber, resultTimestamp,
                    UnknownReason.SOURCE_TIMESTAMP_NOT_MONOTONIC);
        }
        if (samplingFps < 1 || exceedsGap(timestamp, previousTimestamp, samplingFps)) {
            return Assessment.unknown(previousFrameNumber, frameNumber, resultTimestamp, UnknownReason.SOURCE_TIMESTAMP_GAP);
        }
        if (previousFrame == null || frame == null) {
            return Assessment.unknown(previousFrameNumber, frameNumber, resultTimestamp,
                    UnknownReason.FRAME_PIXELS_UNAVAILABLE);
        }

        try {
            BufferedImage before = BoundedImageDecoder.decode(previousFrame);
            BufferedImage after = BoundedImageDecoder.decode(frame);
            if (before.getWidth() != after.getWidth() || before.getHeight() != after.getHeight()) {
                return Assessment.unknown(previousFrameNumber, frameNumber, resultTimestamp,
                        UnknownReason.FRAME_DIMENSIONS_MISMATCH);
            }
            if (before.getWidth() < MIN_WORK_SIDE || before.getHeight() < MIN_WORK_SIDE) {
                return Assessment.unknown(previousFrameNumber, frameNumber, resultTimestamp,
                        UnknownReason.FRAME_TOO_SMALL);
            }

            GrayFrame left = toGrayFrame(before);
            GrayFrame right = toGrayFrame(after);
            return estimate(previousFrameNumber, timestamp, frameNumber, left, right,
                    before.getWidth(), before.getHeight());
        } catch (LinkageError unavailableNativeLibrary) {
            return Assessment.unknown(previousFrameNumber, frameNumber, resultTimestamp,
                    UnknownReason.NATIVE_LIBRARY_UNAVAILABLE);
        } catch (RuntimeException unavailableAnalysis) {
            return Assessment.unknown(previousFrameNumber, frameNumber, resultTimestamp,
                    UnknownReason.FRAME_ANALYSIS_UNAVAILABLE);
        }
    }

    private static Assessment estimate(int previousFrameNumber, SourceMediaTimestamp timestamp,
                                       int frameNumber, GrayFrame before, GrayFrame after,
                                       int sourceWidth, int sourceHeight) {
        Mat previousGray = toMat(before);
        Mat currentGray = toMat(after);
        MatOfPoint corners = new MatOfPoint();
        MatOfPoint2f previousPoints = new MatOfPoint2f();
        MatOfPoint2f currentPoints = new MatOfPoint2f();
        MatOfByte status = new MatOfByte();
        MatOfFloat errors = new MatOfFloat();
        try {
            Imgproc.goodFeaturesToTrack(previousGray, corners, MAX_FEATURES, 0.01, 8.0);
            Point[] detected = corners.toArray();
            if (detected.length < MIN_TRACKED_FEATURES) {
                return Assessment.unknown(previousFrameNumber, frameNumber, timestamp,
                        UnknownReason.TOO_FEW_FEATURES);
            }
            previousPoints.fromArray(detected);
            Video.calcOpticalFlowPyrLK(previousGray, currentGray, previousPoints, currentPoints,
                    status, errors, new Size(21, 21), 3,
                    new TermCriteria(TermCriteria.COUNT | TermCriteria.EPS, 30, 0.01));

            Point[] oldPoints = previousPoints.toArray();
            Point[] newPoints = currentPoints.toArray();
            byte[] statuses = status.toArray();
            float[] trackErrors = errors.toArray();
            List<VectorSample> tracks = new ArrayList<>();
            int trackedLimit = Math.min(Math.min(oldPoints.length, newPoints.length),
                    Math.min(statuses.length, trackErrors.length));
            for (int index = 0; index < trackedLimit; index++) {
                if (statuses[index] == 0 || !Float.isFinite(trackErrors[index])
                        || trackErrors[index] > MAX_TRACK_ERROR) continue;
                Point oldPoint = oldPoints[index];
                Point newPoint = newPoints[index];
                double dx = newPoint.x - oldPoint.x;
                double dy = newPoint.y - oldPoint.y;
                if (!Double.isFinite(dx) || !Double.isFinite(dy)
                        || Math.hypot(dx, dy) > MAX_WORK_DISPLACEMENT) continue;
                int column = Math.min(GRID_SIDE - 1,
                        Math.max(0, (int) (oldPoint.x * GRID_SIDE / before.width())));
                int row = Math.min(GRID_SIDE - 1,
                        Math.max(0, (int) (oldPoint.y * GRID_SIDE / before.height())));
                tracks.add(new VectorSample(dx, dy, row * GRID_SIDE + column));
            }
            if (tracks.size() < MIN_TRACKED_FEATURES) {
                return Assessment.unknown(previousFrameNumber, frameNumber, timestamp,
                        UnknownReason.TOO_FEW_TRACKED_FEATURES);
            }

            double medianDx = median(tracks.stream().mapToDouble(VectorSample::dx).toArray());
            double medianDy = median(tracks.stream().mapToDouble(VectorSample::dy).toArray());
            List<VectorSample> inliers = tracks.stream()
                    .filter(track -> Math.hypot(track.dx() - medianDx, track.dy() - medianDy)
                            <= CONSENSUS_RADIUS)
                    .toList();
            Set<Integer> inlierCells = new HashSet<>();
            inliers.forEach(track -> inlierCells.add(track.cell()));
            double support = (double) inliers.size() / tracks.size();
            if (inliers.size() < MIN_CONSENSUS_FEATURES || inlierCells.size() < MIN_CONSENSUS_CELLS
                    || support < MIN_SUPPORT_FRACTION) {
                return Assessment.unknown(previousFrameNumber, frameNumber, timestamp,
                        UnknownReason.NO_DISTRIBUTED_FLOW_CONSENSUS);
            }

            Disposition disposition = Math.hypot(medianDx, medianDy) <= NO_TRANSLATION_RADIUS
                    ? Disposition.NO_TRANSLATION_CANDIDATE : Disposition.CAMERA_MOTION_CANDIDATE;
            return new Assessment(previousFrameNumber, frameNumber, timestamp,
                    medianDx * sourceWidth / before.width(), medianDy * sourceHeight / before.height(),
                    sourceWidth, sourceHeight, tracks.size(), inliers.size(), inlierCells.size(), support,
                    disposition, null, "HEURISTIC_UNCALIBRATED", "QUALITATIVE");
        } finally {
            previousGray.release();
            currentGray.release();
            corners.release();
            previousPoints.release();
            currentPoints.release();
            status.release();
            errors.release();
        }
    }

    private static GrayFrame toGrayFrame(BufferedImage source) {
        double scale = Math.min(1.0, (double) MAX_WORK_SIDE / Math.max(source.getWidth(), source.getHeight()));
        int width = Math.max(1, (int) Math.round(source.getWidth() * scale));
        int height = Math.max(1, (int) Math.round(source.getHeight() * scale));
        byte[] pixels = new byte[width * height];
        for (int y = 0; y < height; y++) {
            int sourceY = Math.min(source.getHeight() - 1, (int) ((long) y * source.getHeight() / height));
            for (int x = 0; x < width; x++) {
                int sourceX = Math.min(source.getWidth() - 1, (int) ((long) x * source.getWidth() / width));
                int rgb = source.getRGB(sourceX, sourceY);
                int luma = (299 * ((rgb >>> 16) & 0xff) + 587 * ((rgb >>> 8) & 0xff)
                        + 114 * (rgb & 0xff) + 500) / 1000;
                pixels[y * width + x] = (byte) luma;
            }
        }
        return new GrayFrame(width, height, pixels);
    }

    private static Mat toMat(GrayFrame frame) {
        Mat result = new Mat(frame.height(), frame.width(), CvType.CV_8UC1);
        result.put(0, 0, frame.pixels());
        return result;
    }

    private static double median(double[] values) {
        Arrays.sort(values);
        int middle = values.length / 2;
        if (values.length % 2 == 1) return values[middle];
        return (values[middle - 1] + values[middle]) / 2.0;
    }

    private static int comparePts(SourceMediaTimestamp a, SourceMediaTimestamp b) {
        BigInteger left = BigInteger.valueOf(a.pts()).multiply(BigInteger.valueOf(a.timeBaseNumerator()))
                .multiply(BigInteger.valueOf(b.timeBaseDenominator()));
        BigInteger right = BigInteger.valueOf(b.pts()).multiply(BigInteger.valueOf(b.timeBaseNumerator()))
                .multiply(BigInteger.valueOf(a.timeBaseDenominator()));
        return left.compareTo(right);
    }

    private static boolean exceedsGap(SourceMediaTimestamp current, SourceMediaTimestamp previous, int fps) {
        BigInteger deltaN = BigInteger.valueOf(current.pts()).multiply(BigInteger.valueOf(current.timeBaseNumerator()))
                .multiply(BigInteger.valueOf(previous.timeBaseDenominator()))
                .subtract(BigInteger.valueOf(previous.pts()).multiply(BigInteger.valueOf(previous.timeBaseNumerator()))
                        .multiply(BigInteger.valueOf(current.timeBaseDenominator())));
        BigInteger deltaD = BigInteger.valueOf(current.timeBaseDenominator())
                .multiply(BigInteger.valueOf(previous.timeBaseDenominator()));
        return deltaN.multiply(BigInteger.valueOf(fps)).compareTo(deltaD.multiply(BigInteger.TWO)) > 0;
    }

    private record GrayFrame(int width, int height, byte[] pixels) { }
    private record VectorSample(double dx, double dy, int cell) { }

    public enum Disposition { CAMERA_MOTION_CANDIDATE, NO_TRANSLATION_CANDIDATE, UNKNOWN }

    public enum UnknownReason {
        FRAME_GAP,
        SOURCE_TIMESTAMP_UNKNOWN,
        SOURCE_TIMESTAMP_NOT_MONOTONIC,
        SOURCE_TIMESTAMP_GAP,
        FRAME_PIXELS_UNAVAILABLE,
        FRAME_DIMENSIONS_MISMATCH,
        FRAME_TOO_SMALL,
        NATIVE_LIBRARY_UNAVAILABLE,
        FRAME_ANALYSIS_UNAVAILABLE,
        SHOT_BOUNDARY_CANDIDATE,
        TOO_FEW_FEATURES,
        TOO_FEW_TRACKED_FEATURES,
        NO_DISTRIBUTED_FLOW_CONSENSUS
    }

    public record Assessment(int previousFrameNumber, int frameNumber, SourceMediaTimestamp sourceTimestamp,
                            Double xTranslationPixels, Double yTranslationPixels, int sourceWidth, int sourceHeight,
                            int trackedFeatureCount, int consensusFeatureCount, int consensusCellCount,
                            Double supportFraction, Disposition disposition, UnknownReason unknownReason,
                            String methodStatus, String uncertaintyDisposition) {
        public Assessment {
            if (previousFrameNumber < 0 || frameNumber < 0) {
                throw new IllegalArgumentException("Camera-motion assessment frame numbers must be non-negative");
            }
            java.util.Objects.requireNonNull(sourceTimestamp, "sourceTimestamp");
            java.util.Objects.requireNonNull(disposition, "disposition");
            java.util.Objects.requireNonNull(methodStatus, "methodStatus");
            java.util.Objects.requireNonNull(uncertaintyDisposition, "uncertaintyDisposition");
            if (disposition == Disposition.UNKNOWN) {
                if (unknownReason == null || xTranslationPixels != null || yTranslationPixels != null
                        || supportFraction != null || !"UNKNOWN".equals(uncertaintyDisposition)) {
                    throw new IllegalArgumentException("Unknown camera-motion assessments require a reason and no estimate");
                }
            } else if (!sourceTimestamp.isKnown() || unknownReason != null || xTranslationPixels == null
                    || yTranslationPixels == null || !Double.isFinite(xTranslationPixels)
                    || !Double.isFinite(yTranslationPixels) || sourceWidth < 1 || sourceHeight < 1
                    || trackedFeatureCount < MIN_TRACKED_FEATURES || consensusFeatureCount < MIN_CONSENSUS_FEATURES
                    || consensusCellCount < MIN_CONSENSUS_CELLS || supportFraction == null
                    || !Double.isFinite(supportFraction) || supportFraction < MIN_SUPPORT_FRACTION
                    || supportFraction > 1.0 || !"QUALITATIVE".equals(uncertaintyDisposition)) {
                throw new IllegalArgumentException("Estimated camera motion requires distributed optical-flow consensus");
            }
        }

        static Assessment unknown(int previousFrameNumber, int frameNumber, SourceMediaTimestamp timestamp,
                                  UnknownReason reason) {
            return new Assessment(previousFrameNumber, frameNumber, timestamp, null, null, 0, 0,
                    0, 0, 0, null, Disposition.UNKNOWN, reason,
                    "HEURISTIC_UNCALIBRATED", "UNKNOWN");
        }
    }
}
