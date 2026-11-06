package com.ghatana.media.production.rendering;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.List;
import java.util.Objects;

/**
 * Validates and freezes a bounded multitrack render graph. This is a planning
 * boundary only: it does not encode, mux, or claim that a playable artifact exists.
 */
public final class MultitrackRenderPlanner {
    public static final String CAPABILITY_ID = "media.dev.multitrack-composition-render";
    public static final int MAX_CLIPS = 256;
    public static final int MAX_FRAMES_PER_CLIP = 100_000;
    public static final int MAX_CAPTIONS = 20_000;
    public static final int MAX_TRANSITIONS = 256;
    public static final long MAX_GRAPH_DURATION_NANOS = 24L * 60 * 60 * 1_000_000_000;
    public static final long MAX_DECLARED_OUTPUT_BYTES = 8L * 1024 * 1024 * 1024;

    private MultitrackRenderPlanner() { }

    public enum Modality { VIDEO, AUDIO, GRAPHIC }
    public enum TransitionKind { CROSSFADE, WIPE }
    public enum Outcome { PLAN_READY, NOT_ADMITTED, UNAVAILABLE }
    public enum Reason { CODEC_PIPELINE_NOT_ADMITTED, CODEC_PIPELINE_UNAVAILABLE }

    /** Exact rational seconds; normalized values keep equivalent timestamps canonical. */
    public record Time(long numerator, long denominator) implements Comparable<Time> {
        public Time {
            if (denominator <= 0) throw invalid("time denominator must be positive");
            BigInteger n = BigInteger.valueOf(numerator);
            BigInteger d = BigInteger.valueOf(denominator);
            BigInteger gcd = n.abs().gcd(d);
            n = n.divide(gcd);
            d = d.divide(gcd);
            if (n.bitLength() > 63 || d.bitLength() > 63) throw invalid("time is outside supported range");
            numerator = n.longValueExact();
            denominator = d.longValueExact();
        }

        @Override public int compareTo(Time other) {
            return BigInteger.valueOf(numerator).multiply(BigInteger.valueOf(other.denominator))
                    .compareTo(BigInteger.valueOf(other.numerator).multiply(BigInteger.valueOf(denominator)));
        }

        public Time plus(Time other) {
            BigInteger n = BigInteger.valueOf(numerator).multiply(BigInteger.valueOf(other.denominator))
                    .add(BigInteger.valueOf(other.numerator).multiply(BigInteger.valueOf(denominator)));
            BigInteger d = BigInteger.valueOf(denominator).multiply(BigInteger.valueOf(other.denominator));
            return fromBig(n, d);
        }

        public Time minus(Time other) {
            BigInteger n = BigInteger.valueOf(numerator).multiply(BigInteger.valueOf(other.denominator))
                    .subtract(BigInteger.valueOf(other.numerator).multiply(BigInteger.valueOf(denominator)));
            BigInteger d = BigInteger.valueOf(denominator).multiply(BigInteger.valueOf(other.denominator));
            return fromBig(n, d);
        }

        private static Time fromBig(BigInteger n, BigInteger d) {
            BigInteger gcd = n.abs().gcd(d);
            n = n.divide(gcd);
            d = d.divide(gcd);
            if (n.bitLength() > 63 || d.bitLength() > 63) throw invalid("time arithmetic overflow");
            return new Time(n.longValueExact(), d.longValueExact());
        }

        @Override public String toString() { return numerator + "/" + denominator; }
    }

    /** Immutable source identity and an explicitly retained source presentation-time map. */
    public record Clip(String id, Modality modality, String sourceArtifactId, String sourceVersion,
            String sourceSha256, Time timelineStart, Time sourceStart, Time sourceEnd,
            List<Time> sourceFramePts) {
        public Clip {
            id = opaque(id, "clip id");
            Objects.requireNonNull(modality, "modality");
            sourceArtifactId = opaque(sourceArtifactId, "source artifact id");
            sourceVersion = opaque(sourceVersion, "source version");
            sourceSha256 = digest(sourceSha256, "source sha256");
            Objects.requireNonNull(timelineStart, "timelineStart");
            Objects.requireNonNull(sourceStart, "sourceStart");
            Objects.requireNonNull(sourceEnd, "sourceEnd");
            if (timelineStart.numerator() < 0 || sourceStart.numerator() < 0 || sourceEnd.compareTo(sourceStart) <= 0) {
                throw invalid("clip times must be non-negative and sourceEnd must follow sourceStart");
            }
            sourceFramePts = boundedCopy(sourceFramePts, MAX_FRAMES_PER_CLIP, "sourceFramePts",
                    "each clip must retain between 1 and " + MAX_FRAMES_PER_CLIP + " source PTS values");
            if (sourceFramePts.isEmpty() || sourceFramePts.size() > MAX_FRAMES_PER_CLIP) {
                throw invalid("each clip must retain between 1 and " + MAX_FRAMES_PER_CLIP + " source PTS values");
            }
            Time prior = null;
            for (Time pts : sourceFramePts) {
                Objects.requireNonNull(pts, "source frame PTS");
                if (pts.compareTo(sourceStart) < 0 || pts.compareTo(sourceEnd) >= 0
                        || (prior != null && pts.compareTo(prior) <= 0)) {
                    throw invalid("source frame PTS must be strictly increasing within the selected source interval");
                }
                prior = pts;
            }
            if (modality != Modality.VIDEO && sourceFramePts.size() != 1) {
                throw invalid("only video clips may carry multiple frame PTS values");
            }
        }

        public Time duration() { return sourceEnd.minus(sourceStart); }
        public Time timelineEnd() { return timelineStart.plus(duration()); }
        public Time mappedFramePts(Time sourcePts) { return timelineStart.plus(sourcePts.minus(sourceStart)); }
    }

    public record Caption(String id, Time start, Time end, String text) {
        public Caption {
            id = opaque(id, "caption id");
            Objects.requireNonNull(start, "caption start");
            Objects.requireNonNull(end, "caption end");
            if (start.numerator() < 0 || end.compareTo(start) <= 0) throw invalid("caption interval must be positive");
            text = Objects.requireNonNull(text, "caption text");
            if (text.isBlank() || text.length() > 4_096 || text.indexOf('\0') >= 0) {
                throw invalid("caption text must contain 1..4096 non-NUL characters");
            }
            if (hasUnpairedSurrogate(text)) {
                throw invalid("caption text must contain valid Unicode scalar values");
            }
        }
    }

    public record Transition(String id, String leftClipId, String rightClipId, TransitionKind kind,
            Time start, Time duration) {
        public Transition {
            id = opaque(id, "transition id");
            leftClipId = opaque(leftClipId, "left clip id");
            rightClipId = opaque(rightClipId, "right clip id");
            Objects.requireNonNull(kind, "transition kind");
            Objects.requireNonNull(start, "transition start");
            Objects.requireNonNull(duration, "transition duration");
            if (start.numerator() < 0 || duration.numerator() <= 0) throw invalid("transition interval must be positive");
        }
        public Time end() { return start.plus(duration); }
    }

    public record Graph(List<Clip> clips, List<Caption> captions, List<Transition> transitions,
            long declaredOutputBudgetBytes) {
        public Graph {
            clips = boundedCopy(clips, MAX_CLIPS, "clips", "graph clip count exceeds limit");
            captions = boundedCopy(captions, MAX_CAPTIONS, "captions", "caption count exceeds limit");
            transitions = boundedCopy(transitions, MAX_TRANSITIONS, "transitions", "transition count exceeds limit");
            if (clips.isEmpty() || clips.size() > MAX_CLIPS) throw invalid("graph must contain 1.." + MAX_CLIPS + " clips");
            if (captions.size() > MAX_CAPTIONS) throw invalid("caption count exceeds limit");
            if (transitions.size() > MAX_TRANSITIONS) throw invalid("transition count exceeds limit");
            if (declaredOutputBudgetBytes <= 0 || declaredOutputBudgetBytes > MAX_DECLARED_OUTPUT_BYTES) {
                throw invalid("declared output budget must be within 1.." + MAX_DECLARED_OUTPUT_BYTES + " bytes");
            }
        }
    }

    public record MappedFrame(String clipId, int frameIndex, Time sourcePts, Time timelinePts) { }
    public record Plan(String capabilityId, String canonicalManifest, String manifestSha256,
            Time duration, List<MappedFrame> frameMap, long declaredOutputBudgetBytes) {
        public Plan {
            frameMap = List.copyOf(frameMap);
        }
    }
    public record PlanResult(Outcome outcome, Plan plan, Reason reason) {
        public PlanResult {
            Objects.requireNonNull(outcome, "outcome");
            if (outcome == Outcome.PLAN_READY && (plan == null || reason != null)) throw invalid("ready plan must have only a plan");
            if (outcome != Outcome.PLAN_READY && (plan != null || reason == null)) throw invalid("non-ready result must have only a reason");
        }
    }

    /** Pipeline admission remains an explicit host responsibility. */
    public interface CodecPipeline {
        boolean admitted();
        boolean available();
    }

    public static PlanResult plan(Graph graph) {
        Objects.requireNonNull(graph, "graph");
        validateGraph(graph);
        Time duration = graph.clips().stream().map(Clip::timelineEnd).max(Time::compareTo).orElseThrow();
        if (duration.compareTo(new Time(MAX_GRAPH_DURATION_NANOS, 1_000_000_000L)) > 0) {
            throw invalid("graph duration exceeds 24-hour bound");
        }
        List<MappedFrame> mapped = graph.clips().stream().flatMap(clip -> {
            var frames = new java.util.ArrayList<MappedFrame>(clip.sourceFramePts().size());
            for (int i = 0; i < clip.sourceFramePts().size(); i++) {
                Time pts = clip.sourceFramePts().get(i);
                frames.add(new MappedFrame(clip.id(), i, pts, clip.mappedFramePts(pts)));
            }
            return frames.stream();
        }).toList();
        String manifest = canonicalManifest(graph, duration, mapped);
        return new PlanResult(Outcome.PLAN_READY,
                new Plan(CAPABILITY_ID, manifest, sha256(manifest.getBytes(StandardCharsets.UTF_8)), duration,
                        mapped, graph.declaredOutputBudgetBytes()), null);
    }

    public static PlanResult execute(Plan plan, CodecPipeline pipeline) {
        Objects.requireNonNull(plan, "plan");
        if (pipeline == null || !pipeline.admitted()) {
            return new PlanResult(Outcome.NOT_ADMITTED, null, Reason.CODEC_PIPELINE_NOT_ADMITTED);
        }
        if (!pipeline.available()) {
            return new PlanResult(Outcome.UNAVAILABLE, null, Reason.CODEC_PIPELINE_UNAVAILABLE);
        }
        // This package intentionally has no encoder/muxer implementation yet.
        return new PlanResult(Outcome.UNAVAILABLE, null, Reason.CODEC_PIPELINE_UNAVAILABLE);
    }

    private static void validateGraph(Graph graph) {
        var byId = new java.util.HashMap<String, Clip>();
        long totalFrames = 0;
        for (Clip clip : graph.clips()) {
            if (byId.putIfAbsent(clip.id(), clip) != null) throw invalid("clip ids must be unique");
            totalFrames = Math.addExact(totalFrames, clip.sourceFramePts().size());
            if (totalFrames > MAX_FRAMES_PER_CLIP) throw invalid("aggregate frame map exceeds bounded planner capacity");
        }
        var captionIds = new java.util.HashSet<String>();
        for (Caption caption : graph.captions()) {
            if (!captionIds.add(caption.id())) throw invalid("caption ids must be unique");
            if (caption.end().compareTo(graphDurationUpperBound(graph)) > 0) throw invalid("caption exceeds graph duration");
        }
        var transitionIds = new java.util.HashSet<String>();
        for (Transition transition : graph.transitions()) {
            if (!transitionIds.add(transition.id())) throw invalid("transition ids must be unique");
            Clip left = byId.get(transition.leftClipId());
            Clip right = byId.get(transition.rightClipId());
            if (left == null || right == null || left == right) throw invalid("transition must reference two distinct graph clips");
            if (transition.start().compareTo(left.timelineStart()) < 0 || transition.end().compareTo(left.timelineEnd()) > 0
                    || transition.start().compareTo(right.timelineStart()) < 0 || transition.end().compareTo(right.timelineEnd()) > 0) {
                throw invalid("transition must fit within both participating clip intervals");
            }
        }
    }

    private static Time graphDurationUpperBound(Graph graph) {
        return graph.clips().stream().map(Clip::timelineEnd).max(Time::compareTo).orElseThrow();
    }

    private static String canonicalManifest(Graph graph, Time duration, List<MappedFrame> frames) {
        StringBuilder out = new StringBuilder(512);
        out.append("multitrack-render-manifest-v1\n").append("duration=").append(duration).append('\n')
                .append("output-budget-bytes=").append(graph.declaredOutputBudgetBytes()).append('\n');
        graph.clips().stream().sorted(java.util.Comparator.comparing(Clip::id)).forEach(c -> out.append("clip=")
                .append(c.id()).append('|').append(c.modality()).append('|').append(c.sourceArtifactId()).append('|')
                .append(c.sourceVersion()).append('|').append(c.sourceSha256()).append('|').append(c.timelineStart())
                .append('|').append(c.sourceStart()).append('|').append(c.sourceEnd()).append('\n'));
        frames.stream().sorted(java.util.Comparator.comparing(MappedFrame::clipId).thenComparingInt(MappedFrame::frameIndex))
                .forEach(f -> out.append("frame=").append(f.clipId()).append('|').append(f.frameIndex()).append('|')
                        .append(f.sourcePts()).append('|').append(f.timelinePts()).append('\n'));
        graph.captions().stream().sorted(java.util.Comparator.comparing(Caption::id)).forEach(c -> out.append("caption=")
                .append(c.id()).append('|').append(c.start()).append('|').append(c.end()).append('|')
                .append(java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(c.text().getBytes(StandardCharsets.UTF_8))).append('\n'));
        graph.transitions().stream().sorted(java.util.Comparator.comparing(Transition::id)).forEach(t -> out.append("transition=")
                .append(t.id()).append('|').append(t.leftClipId()).append('|').append(t.rightClipId()).append('|')
                .append(t.kind()).append('|').append(t.start()).append('|').append(t.duration()).append('\n'));
        return out.toString();
    }

    private static String opaque(String value, String name) {
        Objects.requireNonNull(value, name);
        String result = value.trim();
        if (!result.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,254}")) {
            throw invalid(name + " must be non-empty bounded single-line text");
        }
        return result;
    }

    private static boolean hasUnpairedSurrogate(String value) {
        for (int i = 0; i < value.length(); i++) {
            char current = value.charAt(i);
            if (Character.isHighSurrogate(current)) {
                if (i + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(i + 1))) return true;
                i++;
            } else if (Character.isLowSurrogate(current)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Copies caller-owned lists only after checking the advertised bound, and
     * caps iteration as well in case a custom List reports an inaccurate size.
     */
    private static <T> List<T> boundedCopy(List<T> values, int maximum, String name, String limitMessage) {
        Objects.requireNonNull(values, name);
        int reportedSize = values.size();
        if (reportedSize > maximum) throw invalid(limitMessage);
        var copy = new ArrayList<T>(reportedSize);
        Iterator<T> iterator = values.iterator();
        while (iterator.hasNext()) {
            if (copy.size() == maximum) throw invalid(limitMessage);
            copy.add(Objects.requireNonNull(iterator.next(), name + " element"));
        }
        return List.copyOf(copy);
    }

    private static String digest(String value, String name) {
        String result = opaque(value, name).toLowerCase(java.util.Locale.ROOT);
        if (!result.matches("[a-f0-9]{64}")) throw invalid(name + " must be a SHA-256 hex digest");
        return result;
    }

    private static IllegalArgumentException invalid(String message) { return new IllegalArgumentException(message); }
    private static String sha256(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException("SHA-256 is required by the JVM", impossible); }
    }
}
