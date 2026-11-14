package com.ghatana.audio.video.vision.tracking;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Deterministic multi-object tracker, algorithm id {@value #ALGORITHM}. No model, no randomness, no clock.
 *
 * <p>For each sampled frame, in increasing PTS order:
 * <ol>
 *   <li>Every live track (observed within the last {@code maxMissedFrames + 1} sampled frames) is compared with
 *       every detection that has the same label (case-sensitive). The pair score is
 *       {@code max(IoU(lastBox, detection), IoU(predictedBox, detection))}, where {@code predictedBox} extrapolates
 *       the last two observations linearly in PTS time (constant velocity; no prediction for a one-observation
 *       track).</li>
 *   <li>Pairs scoring at least {@code minIou} are sorted by score descending, ties broken by lower track number then
 *       lower detection index, and assigned greedily; each track and detection is used at most once.</li>
 *   <li>Every unassigned detection starts a new track numbered {@code T0001, T0002, ...} in order of first
 *       appearance (frame, then detection index).</li>
 * </ol>
 * Identical inputs therefore always yield identical tracks. It is a plain greedy association (not Hungarian), so
 * crowded scenes with heavily overlapping same-label objects can swap identities; that limitation is documented, not
 * hidden.
 *
 * @doc.type class
 * @doc.purpose Greedy IoU plus label multi-object tracker over source-PTS-ordered detections
 * @doc.layer product
 * @doc.pattern Algorithm
 */
public final class GreedyIouTracker {
    public static final String ALGORITHM = "GREEDY_IOU_LABEL_V1";

    /** One detection in one frame. */
    public record Detection(String label, SourceBox box) { }

    /** One box of one track at one exact frame. */
    public record Observation(int frameIndex, long pts, SourceBox box) { }

    /** A finished track. */
    public record Track(String trackId, String label, List<Observation> observations) {
        public Track { observations = List.copyOf(observations); }
        public int firstFrameIndex() { return observations.get(0).frameIndex(); }
        public int lastFrameIndex() { return observations.get(observations.size() - 1).frameIndex(); }
    }

    private static final class Live {
        final int number;
        final String label;
        final List<Observation> observations = new ArrayList<>();
        int lastOrdinal;
        Live(int number, String label) { this.number = number; this.label = label; }
        Observation last() { return observations.get(observations.size() - 1); }
    }

    private final double minIou;
    private final int maxMissedFrames;
    private final List<Live> all = new ArrayList<>();
    private int ordinal = -1;
    private long lastPts = Long.MIN_VALUE;

    public GreedyIouTracker(double minIou, int maxMissedFrames) {
        if (!(minIou > 0 && minIou < 1)) throw new IllegalArgumentException("minIou must be within (0, 1)");
        if (maxMissedFrames < 0 || maxMissedFrames > 16) {
            throw new IllegalArgumentException("maxMissedFrames must be within [0, 16]");
        }
        this.minIou = minIou;
        this.maxMissedFrames = maxMissedFrames;
    }

    /** Feeds the detections of the next sampled frame; PTS must be strictly increasing. */
    public void update(int frameIndex, long pts, List<Detection> detections) {
        if (pts <= lastPts) throw new IllegalArgumentException("frames must be fed in strictly increasing PTS order");
        lastPts = pts;
        ordinal++;
        record Pair(double score, Live track, int detection) { }
        List<Pair> pairs = new ArrayList<>();
        for (Live track : all) {
            if (ordinal - track.lastOrdinal > maxMissedFrames + 1) continue;
            SourceBox predicted = predict(track, pts);
            for (int i = 0; i < detections.size(); i++) {
                Detection detection = detections.get(i);
                if (!track.label.equals(detection.label())) continue;
                double score = Math.max(track.last().box().iou(detection.box()),
                        predicted == null ? 0 : predicted.iou(detection.box()));
                if (score >= minIou) pairs.add(new Pair(score, track, i));
            }
        }
        pairs.sort(Comparator.<Pair>comparingDouble(pair -> -pair.score())
                .thenComparingInt(pair -> pair.track().number).thenComparingInt(Pair::detection));
        Set<Live> usedTracks = new HashSet<>();
        Set<Integer> usedDetections = new HashSet<>();
        for (Pair pair : pairs) {
            if (usedTracks.contains(pair.track()) || usedDetections.contains(pair.detection())) continue;
            usedTracks.add(pair.track());
            usedDetections.add(pair.detection());
            pair.track().observations.add(new Observation(frameIndex, pts, detections.get(pair.detection()).box()));
            pair.track().lastOrdinal = ordinal;
        }
        for (int i = 0; i < detections.size(); i++) {
            if (usedDetections.contains(i)) continue;
            Live fresh = new Live(all.size() + 1, detections.get(i).label());
            fresh.observations.add(new Observation(frameIndex, pts, detections.get(i).box()));
            fresh.lastOrdinal = ordinal;
            all.add(fresh);
        }
    }

    private static SourceBox predict(Live track, long pts) {
        int n = track.observations.size();
        if (n < 2) return null;
        Observation a = track.observations.get(n - 2);
        Observation b = track.observations.get(n - 1);
        long before = b.pts() - a.pts();
        if (before <= 0) return null;
        double ratio = (pts - b.pts()) / (double) before;
        return new SourceBox(b.box().x() + (b.box().x() - a.box().x()) * ratio,
                b.box().y() + (b.box().y() - a.box().y()) * ratio, b.box().width(), b.box().height());
    }

    /** All tracks in id order (including single-observation tracks). */
    public List<Track> tracks() {
        List<Track> out = new ArrayList<>(all.size());
        for (Live live : all) {
            out.add(new Track(String.format("T%04d", live.number), live.label, live.observations));
        }
        return out;
    }
}
