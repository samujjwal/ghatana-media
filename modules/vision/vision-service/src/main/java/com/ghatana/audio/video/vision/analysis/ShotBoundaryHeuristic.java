package com.ghatana.audio.video.vision.analysis;

import com.ghatana.audio.video.vision.image.BoundedImageDecoder;
import com.ghatana.audio.video.vision.video.SourceMediaTimestamp;

import java.awt.image.BufferedImage;
import java.math.BigInteger;

/**
 * Conservative, source-timestamped shot-change candidate detector for extracted frames.
 *
 * <p>This computes a coarse luminance-difference heuristic only. Its result is an
 * {@code ESTIMATED/QUALITATIVE} candidate, not a measured or ground-truth shot boundary.
 * It is not a canonical capability result because it has no immutable artifact reference.
 */
public final class ShotBoundaryHeuristic {
    private static final int GRID_SIZE = 16;
    /** Conservative local starting point; no representative corpus has calibrated it. */
    private static final double CANDIDATE_THRESHOLD = 0.40;

    private ShotBoundaryHeuristic() { }

    static int[] decodeSignatureOrUnknown(byte[] frameBytes) {
        try {
            BufferedImage image = BoundedImageDecoder.decode(frameBytes);
            int[] lumaSamples = new int[GRID_SIZE * GRID_SIZE];
            int index = 0;
            for (int row = 0; row < GRID_SIZE; row++) {
                int y = sampleCoordinate(row, image.getHeight());
                for (int column = 0; column < GRID_SIZE; column++) {
                    int x = sampleCoordinate(column, image.getWidth());
                    lumaSamples[index++] = luma(image.getRGB(x, y));
                }
            }
            return lumaSamples;
        } catch (IllegalArgumentException invalidFrame) {
            return null;
        }
    }

    static Assessment compare(
            int previousFrameNumber,
            SourceMediaTimestamp previousTimestamp,
            int[] previousLuma,
            int frameNumber,
            SourceMediaTimestamp timestamp,
            int[] luma) {
        if ((long) frameNumber != (long) previousFrameNumber + 1L) {
            return Assessment.unknown(previousFrameNumber, frameNumber, timestamp, UnknownReason.FRAME_GAP);
        }
        if (previousTimestamp == null || !previousTimestamp.isKnown()
                || timestamp == null || !timestamp.isKnown()) {
            return Assessment.unknown(previousFrameNumber, frameNumber, timestamp,
                    UnknownReason.SOURCE_TIMESTAMP_UNKNOWN);
        }
        if (comparePts(timestamp, previousTimestamp) <= 0) {
            return Assessment.unknown(previousFrameNumber, frameNumber, timestamp,
                    UnknownReason.SOURCE_TIMESTAMP_NOT_MONOTONIC);
        }
        if (previousLuma == null || luma == null) {
            return Assessment.unknown(previousFrameNumber, frameNumber, timestamp,
                    UnknownReason.FRAME_PIXELS_UNAVAILABLE);
        }

        double difference = meanAbsoluteLumaDifference(previousLuma, luma);
        Disposition disposition = difference >= CANDIDATE_THRESHOLD
                ? Disposition.BOUNDARY_CANDIDATE
                : Disposition.NO_BOUNDARY_CANDIDATE;
        return new Assessment(previousFrameNumber, frameNumber, timestamp, difference,
                disposition, null, "HEURISTIC_UNCALIBRATED", "QUALITATIVE");
    }

    private static double meanAbsoluteLumaDifference(int[] left, int[] right) {
        if (left.length != GRID_SIZE * GRID_SIZE || right.length != GRID_SIZE * GRID_SIZE) {
            throw new IllegalArgumentException("Shot-boundary luminance signatures have the wrong sample count");
        }
        double sum = 0.0;
        for (int index = 0; index < left.length; index++) {
            sum += Math.abs(left[index] - right[index]) / 255.0;
        }
        return sum / left.length;
    }

    private static int sampleCoordinate(int sample, int dimension) {
        return Math.min(dimension - 1, (int) (((sample + 0.5) * dimension) / GRID_SIZE));
    }

    private static int luma(int rgb) {
        int red = (rgb >>> 16) & 0xff;
        int green = (rgb >>> 8) & 0xff;
        int blue = rgb & 0xff;
        return (299 * red + 587 * green + 114 * blue + 500) / 1000;
    }

    private static int comparePts(SourceMediaTimestamp a, SourceMediaTimestamp b) {
        BigInteger left = BigInteger.valueOf(a.pts()).multiply(BigInteger.valueOf(a.timeBaseNumerator()))
                .multiply(BigInteger.valueOf(b.timeBaseDenominator()));
        BigInteger right = BigInteger.valueOf(b.pts()).multiply(BigInteger.valueOf(b.timeBaseNumerator()))
                .multiply(BigInteger.valueOf(a.timeBaseDenominator()));
        return left.compareTo(right);
    }

    public enum Disposition { BOUNDARY_CANDIDATE, NO_BOUNDARY_CANDIDATE, UNKNOWN }

    public enum UnknownReason {
        FRAME_GAP,
        SOURCE_TIMESTAMP_UNKNOWN,
        SOURCE_TIMESTAMP_NOT_MONOTONIC,
        FRAME_PIXELS_UNAVAILABLE,
        PIXEL_ASSESSMENT_NOT_COMPUTED
    }

    public record Assessment(
            int previousFrameNumber,
            int frameNumber,
            SourceMediaTimestamp sourceTimestamp,
            Double meanAbsoluteLumaDifference,
            Disposition disposition,
            UnknownReason unknownReason,
            String methodStatus,
            String uncertaintyDisposition) {
        public Assessment {
            if (previousFrameNumber < 0 || frameNumber < 0) {
                throw new IllegalArgumentException("Shot-boundary assessment frame numbers must be non-negative");
            }
            java.util.Objects.requireNonNull(sourceTimestamp, "sourceTimestamp");
            java.util.Objects.requireNonNull(disposition, "disposition");
            java.util.Objects.requireNonNull(methodStatus, "methodStatus");
            java.util.Objects.requireNonNull(uncertaintyDisposition, "uncertaintyDisposition");
            if (disposition == Disposition.UNKNOWN) {
                if (unknownReason == null || meanAbsoluteLumaDifference != null
                        || !"UNKNOWN".equals(uncertaintyDisposition)) {
                    throw new IllegalArgumentException("Unknown shot-boundary assessments require a reason and no score");
                }
            } else if (sourceTimestamp == null || !sourceTimestamp.isKnown() || unknownReason != null
                    || meanAbsoluteLumaDifference == null
                    || !Double.isFinite(meanAbsoluteLumaDifference)
                    || meanAbsoluteLumaDifference < 0.0 || meanAbsoluteLumaDifference > 1.0
                    || !"QUALITATIVE".equals(uncertaintyDisposition)) {
                throw new IllegalArgumentException("Estimated shot-boundary assessments require a finite score in [0,1]");
            }
        }

        static Assessment unknown(int previousFrameNumber, int frameNumber,
                                  SourceMediaTimestamp timestamp, UnknownReason reason) {
            return new Assessment(previousFrameNumber, frameNumber, timestamp, null,
                    Disposition.UNKNOWN, reason, "HEURISTIC_UNCALIBRATED", "UNKNOWN");
        }
    }
}
