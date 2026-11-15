package com.ghatana.media.launcher;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Per-frame integer masks derived from a tracked region, on the exact presentation timeline of a video.
 *
 * <p>The tracker reports a box only at the frames it sampled. The mask of every frame in between is the box
 * interpolated <em>linearly in presentation time</em> (the exact integer PTS of each frame), never in frame index, so
 * a variable-frame-rate clip keeps the region on the object whatever the gaps between frames. A frame outside the
 * observed span has no mask unless the caller asks to hold the nearest observation. The box is padded and then
 * snapped outward to even pixel coordinates (4:2:0 chroma planes are half size), clamped to the frame.</p>
 *
 * <p>{@link #drift} reports, without any ground truth, how well linear interpolation explains the tracker's own
 * observations: each interior observation is predicted from its two neighbours and compared to what was observed.</p>
 */
final class MediaDevRegionMask {
    static final String OBSERVED = "OBSERVED";
    static final String INTERPOLATED = "INTERPOLATED";
    static final String HELD = "HELD";
    static final String NONE = "NONE";

    private MediaDevRegionMask() { }

    /** One tracker observation: PTS-order frame ordinal, exact PTS ticks and a box in source pixels (top-left origin). */
    record Observation(int frameIndex, long pts, double x, double y, double width, double height) {
        Observation {
            if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(width) || !Double.isFinite(height)
                    || width <= 0 || height <= 0) {
                throw new IllegalArgumentException("observation box must be finite with positive size");
            }
        }
    }

    /** Integer rectangle in frame pixels; {@code x}, {@code y}, {@code width} and {@code height} are even. */
    record Rect(int x, int y, int width, int height) {
        int right() { return x + width; }
        int bottom() { return y + height; }
    }

    /** The mask of one frame; {@code rect} is null when the frame is not edited. */
    record FrameMask(int frameIndex, long pts, Rect rect, String source) { }

    /** How well the tracker's observations are explained by interpolation of their neighbours. */
    record Drift(int observations, int maxGapFrames, long maxGapTicks, int heldOutObservations,
                 double maxCenterErrorPx, double meanCenterErrorPx, double minIou) { }

    /** Throws {@link IllegalArgumentException} when the observations are not strictly increasing on the timeline. */
    static void requireOrdered(List<Observation> observations, long[] framePts) {
        if (observations.isEmpty()) throw new IllegalArgumentException("a track needs at least one observation");
        int previousFrame = -1;
        long previousPts = Long.MIN_VALUE;
        for (Observation observation : observations) {
            if (observation.frameIndex() < 0 || observation.frameIndex() >= framePts.length) {
                throw new IllegalArgumentException("observation frame index is outside the video timeline");
            }
            if (observation.frameIndex() <= previousFrame || observation.pts() <= previousPts) {
                throw new IllegalArgumentException("observations must be strictly increasing in frame order and PTS");
            }
            if (framePts[observation.frameIndex()] != observation.pts()) {
                throw new IllegalArgumentException("observation PTS differs from the video timeline");
            }
            previousFrame = observation.frameIndex();
            previousPts = observation.pts();
        }
    }

    static List<FrameMask> derive(long[] framePts, int width, int height, List<Observation> observations,
                                  int paddingPx, boolean holdEnds) {
        requireOrdered(observations, framePts);
        if (paddingPx < 0) throw new IllegalArgumentException("padding must not be negative");
        List<FrameMask> masks = new ArrayList<>(framePts.length);
        int segment = 0;
        Observation first = observations.getFirst();
        Observation last = observations.getLast();
        for (int i = 0; i < framePts.length; i++) {
            long pts = framePts[i];
            double[] box;
            String source;
            if (pts < first.pts()) {
                box = holdEnds ? box(first) : null;
                source = holdEnds ? HELD : NONE;
            } else if (pts > last.pts()) {
                box = holdEnds ? box(last) : null;
                source = holdEnds ? HELD : NONE;
            } else {
                while (segment + 1 < observations.size() && observations.get(segment + 1).pts() <= pts) segment++;
                Observation a = observations.get(segment);
                if (a.pts() == pts) {
                    box = box(a);
                    source = OBSERVED;
                } else {
                    Observation b = observations.get(segment + 1);
                    box = interpolate(a, b, pts);
                    source = INTERPOLATED;
                }
            }
            Rect rect = box == null ? null : snap(box, width, height, paddingPx);
            masks.add(new FrameMask(i, pts, rect, rect == null ? NONE : source));
        }
        return masks;
    }

    /** Linear interpolation in presentation time between two observations (exact long arithmetic for the fraction). */
    static double[] interpolate(Observation a, Observation b, long pts) {
        double alpha = (double) (pts - a.pts()) / (double) (b.pts() - a.pts());
        return new double[] {
            a.x() + (b.x() - a.x()) * alpha, a.y() + (b.y() - a.y()) * alpha,
            a.width() + (b.width() - a.width()) * alpha, a.height() + (b.height() - a.height()) * alpha};
    }

    private static double[] box(Observation o) { return new double[] {o.x(), o.y(), o.width(), o.height()}; }

    /** Pads, snaps outward to even coordinates and clamps; null when nothing of the box remains inside the frame. */
    static Rect snap(double[] box, int width, int height, int paddingPx) {
        int x0 = Math.max(0, floorEven(box[0] - paddingPx));
        int y0 = Math.max(0, floorEven(box[1] - paddingPx));
        int x1 = Math.min(width, ceilEven(box[0] + box[2] + paddingPx));
        int y1 = Math.min(height, ceilEven(box[1] + box[3] + paddingPx));
        if (x1 - x0 < 2 || y1 - y0 < 2) return null;
        return new Rect(x0, y0, x1 - x0, y1 - y0);
    }

    private static int floorEven(double value) { return (int) Math.floor(value / 2.0) * 2; }

    private static int ceilEven(double value) { return (int) Math.ceil(value / 2.0) * 2; }

    static Drift drift(List<Observation> observations) {
        int maxGap = 0;
        long maxTicks = 0;
        for (int i = 1; i < observations.size(); i++) {
            maxGap = Math.max(maxGap, observations.get(i).frameIndex() - observations.get(i - 1).frameIndex());
            maxTicks = Math.max(maxTicks, observations.get(i).pts() - observations.get(i - 1).pts());
        }
        int held = 0;
        double maxCenter = 0;
        double sumCenter = 0;
        double minIou = 1;
        for (int i = 1; i + 1 < observations.size(); i++) {
            Observation actual = observations.get(i);
            double[] predicted = interpolate(observations.get(i - 1), observations.get(i + 1), actual.pts());
            double dx = predicted[0] + predicted[2] / 2 - (actual.x() + actual.width() / 2);
            double dy = predicted[1] + predicted[3] / 2 - (actual.y() + actual.height() / 2);
            double center = Math.hypot(dx, dy);
            maxCenter = Math.max(maxCenter, center);
            sumCenter += center;
            minIou = Math.min(minIou, iou(predicted, new double[] {actual.x(), actual.y(), actual.width(), actual.height()}));
            held++;
        }
        return new Drift(observations.size(), maxGap, maxTicks, held, round3(maxCenter),
                held == 0 ? 0 : round3(sumCenter / held), held == 0 ? 1 : round3(minIou));
    }

    static double iou(double[] a, double[] b) {
        double ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
        double iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
        double inter = ix * iy;
        double union = a[2] * a[3] + b[2] * b[3] - inter;
        return union <= 0 ? 0 : inter / union;
    }

    static double round3(double value) { return Math.round(value * 1000.0) / 1000.0; }

    /** Stable digest input: one line per frame, {@code index:pts:x,y,w,h|-}. */
    static String canonical(List<FrameMask> masks) {
        StringBuilder out = new StringBuilder();
        for (FrameMask mask : masks) {
            out.append(mask.frameIndex()).append(':').append(mask.pts()).append(':');
            if (mask.rect() == null) out.append('-');
            else out.append(String.format(Locale.ROOT, "%d,%d,%d,%d", mask.rect().x(), mask.rect().y(),
                    mask.rect().width(), mask.rect().height()));
            out.append('\n');
        }
        return out.toString();
    }
}
