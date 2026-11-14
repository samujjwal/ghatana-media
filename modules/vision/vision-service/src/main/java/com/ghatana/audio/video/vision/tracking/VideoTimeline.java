package com.ghatana.audio.video.vision.tracking;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The real frame timeline of one video stream as reported by {@code ffprobe -show_frames}: the stream's rational
 * time base, the displayed raster size and every decoded frame's integer PTS in presentation (PTS) order. The
 * {@code frameIndex} of a frame is its ordinal in that PTS order, which is what FFmpeg's {@code select=eq(n,..)}
 * addresses after decoding, so variable-frame-rate sources are handled without assuming a constant rate.
 *
 * <p>Parsing is strict and fail-closed: a missing time base, non-positive geometry, a frame with no timestamp, or
 * two frames with the same PTS (an ambiguous selection) is rejected with {@link TimelineException}.
 *
 * @doc.type class
 * @doc.purpose Exact source PTS timeline of a video stream
 * @doc.layer product
 * @doc.pattern Value Object
 */
public record VideoTimeline(int width, int height, long timeBaseNum, long timeBaseDen, List<FrameTime> frames,
                            boolean variableFrameRate) {
    /** Hard ceiling on frames considered, bounding memory and probe time. */
    public static final int MAX_FRAMES = 200_000;
    private static final ObjectMapper JSON = JsonMapper.builder().build();

    /** One decoded frame: its ordinal in PTS order and its exact integer PTS in time-base ticks. */
    public record FrameTime(int frameIndex, long pts) { }

    /** The probe output cannot be turned into a trustworthy timeline. */
    public static final class TimelineException extends RuntimeException {
        public TimelineException(String message) { super(message); }
    }

    public VideoTimeline {
        if (width < 1 || height < 1) throw new TimelineException("video geometry must be positive");
        if (timeBaseNum < 1 || timeBaseDen < 1) throw new TimelineException("time base must be a positive rational");
        frames = List.copyOf(frames);
    }

    /** PTS of a frame in whole microseconds, rounded toward negative infinity (derived, for display only). */
    public long ptsMicros(long pts) {
        return Math.floorDiv(Math.multiplyExact(pts, timeBaseNum * 1_000_000L), timeBaseDen);
    }

    /** Parses {@code ffprobe -of json -show_entries frame=pts,best_effort_timestamp:stream=width,height,time_base}. */
    public static VideoTimeline parse(String ffprobeJson) {
        final JsonNode root;
        try {
            root = JSON.readTree(ffprobeJson);
        } catch (RuntimeException malformed) {
            throw new TimelineException("ffprobe output is not JSON");
        }
        JsonNode streams = root.path("streams");
        if (!streams.isArray() || streams.isEmpty()) throw new TimelineException("no video stream");
        JsonNode stream = streams.get(0);
        long[] base = parseTimeBase(stream.path("time_base").asString(""));
        int width = stream.path("width").asInt(0);
        int height = stream.path("height").asInt(0);
        // ffmpeg applies the display-matrix rotation when decoding, so frames come out in displayed orientation.
        long rotation = 0;
        for (JsonNode side : stream.path("side_data_list")) {
            if (side.has("rotation")) rotation = Math.round(side.path("rotation").asDouble(0));
        }
        if (Math.floorMod(rotation, 180L) == 90) {
            int swap = width;
            width = height;
            height = swap;
        }
        JsonNode frameNodes = root.path("frames");
        if (!frameNodes.isArray() || frameNodes.isEmpty()) throw new TimelineException("no decoded frames");
        if (frameNodes.size() > MAX_FRAMES) throw new TimelineException("too many frames");
        List<Long> stamps = new ArrayList<>();
        for (JsonNode frame : frameNodes) {
            JsonNode pts = frame.has("pts") && frame.path("pts").isNumber() ? frame.get("pts")
                    : frame.has("best_effort_timestamp") && frame.path("best_effort_timestamp").isNumber()
                    ? frame.get("best_effort_timestamp") : null;
            if (pts == null) throw new TimelineException("a frame has no presentation timestamp");
            stamps.add(pts.asLong());
        }
        stamps.sort(Comparator.naturalOrder());
        Set<Long> unique = new HashSet<>(stamps);
        if (unique.size() != stamps.size()) throw new TimelineException("two frames share one presentation timestamp");
        List<FrameTime> frames = new ArrayList<>(stamps.size());
        for (int i = 0; i < stamps.size(); i++) frames.add(new FrameTime(i, stamps.get(i)));
        boolean variable = false;
        if (stamps.size() > 2) {
            long first = stamps.get(1) - stamps.get(0);
            for (int i = 2; i < stamps.size() && !variable; i++) variable = stamps.get(i) - stamps.get(i - 1) != first;
        }
        return new VideoTimeline(width, height, base[0], base[1], frames, variable);
    }

    private static long[] parseTimeBase(String text) {
        String[] parts = text.split("/");
        try {
            if (parts.length == 2) return new long[] {Long.parseLong(parts[0]), Long.parseLong(parts[1])};
        } catch (NumberFormatException ignored) {
            // fall through to the typed failure
        }
        throw new TimelineException("stream time base is missing or malformed");
    }

    /**
     * Deterministic uniform sample of at most {@code maxFrames} frame indices: the first frame, then every
     * {@code stride}-th frame in PTS order, where {@code stride = ceil(frameCount / maxFrames)} unless an explicit
     * {@code strideFrames} (&gt;= 1) is given. The result is strictly increasing.
     */
    public List<Integer> sample(int maxFrames, int strideFrames) {
        if (maxFrames < 1) throw new IllegalArgumentException("maxFrames must be positive");
        int count = frames.size();
        int stride = strideFrames > 0 ? strideFrames : (int) Math.ceil(count / (double) maxFrames);
        stride = Math.max(1, stride);
        List<Integer> out = new ArrayList<>();
        for (int index = 0; index < count && out.size() < maxFrames; index += stride) out.add(index);
        return out;
    }
}
