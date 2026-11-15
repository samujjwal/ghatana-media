package com.ghatana.media.launcher;

import com.ghatana.media.launcher.MediaDevSpeechRuntime.SpeechRefusedException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Clip;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.RationalTime;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.TimelineSnapshot;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Track;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.TrackKind;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * DEV_ONLY pure planning of a multitrack composite render: classifies the clips of one exact timeline snapshot by
 * track kind, proves every time lands on the output frame grid (video, overlay) or the 48 kHz sample grid (audio,
 * captions), applies the overlap and gap rules and the duration budget, and validates the composition parameters
 * (color, overlay placement, audio gain). It performs no I/O; every refusal is a typed 422 that names the offending
 * JSON path. Source-dependent checks (trim range, formats, channel layouts, overlay geometry) happen after the sources
 * are probed in {@link MediaDevCompositeRenderRuntime}.
 *
 * <p>Rules: video clips of all VIDEO tracks form one visual sequence and may not overlap; a gap (including a first
 * clip that starts after zero) is refused unless the gap policy is BLACK; clips are never retimed (the source interval
 * must equal the story duration); audio clips overlap only across different AUDIO tracks; caption clips may never
 * overlap; no clip may end after the video sequence; every composition entry must name a clip of the right track kind.
 */
final class MediaDevCompositePlan {
    static final int AUDIO_RATE = 48_000;
    static final int MAX_FPS = 60;

    enum GapPolicy { REFUSE, BLACK }

    enum CaptionMode {
        NONE, MUX, BURN, BOTH;
        boolean mux() { return this == MUX || this == BOTH; }
        boolean burn() { return this == BURN || this == BOTH; }
    }

    /** Picture grade applied to the program video before graphics and burned captions: eq brightness/contrast/saturation. */
    record Color(double brightness, double contrast, double saturation) {
        static final Color NEUTRAL = new Color(0.0, 1.0, 1.0);
        Color {
            if (!(brightness >= -0.5 && brightness <= 0.5)) throw bad("composition.color.brightness",
                    "brightness must be within [-0.5, 0.5]");
            if (!(contrast >= 0.5 && contrast <= 2.0)) throw bad("composition.color.contrast",
                    "contrast must be within [0.5, 2.0]");
            if (!(saturation >= 0.0 && saturation <= 3.0)) throw bad("composition.color.saturation",
                    "saturation must be within [0, 3]");
        }
        boolean neutral() { return equals(NEUTRAL); }
    }

    /** Placement of one OVERLAY-track PNG clip: top-left pixel and opacity. */
    record Overlay(String clipId, int x, int y, double opacity) {
        Overlay {
            if (x < 0 || y < 0 || x > 8192 || y > 8192) throw bad("composition.overlays", "overlay position is out of range");
            if (!(opacity > 0.0 && opacity <= 1.0)) throw bad("composition.overlays", "overlay opacity must be within (0, 1]");
        }
    }

    /** Gain of one AUDIO-track clip in dB. */
    record Gain(String clipId, double gainDb) {
        Gain {
            if (!(gainDb >= -60.0 && gainDb <= 12.0)) throw bad("composition.audio", "gainDb must be within [-60, 12]");
        }
    }

    /**
     * What happens when the summed AUDIO tracks would exceed the true-peak ceiling: LIMIT caps the sum with the master
     * peak guard before encoding; REFUSE refuses the render with a typed 422 that names the measured true peak.
     */
    enum AudioPeakPolicy { LIMIT, REFUSE }

    static final double DEFAULT_TRUE_PEAK_CEILING_DBTP = -1.0;
    static final double MIN_TRUE_PEAK_CEILING_DBTP = -6.0;
    static final double MAX_TRUE_PEAK_CEILING_DBTP = -0.1;

    record Spec(int width, int height, int fps, GapPolicy gap, CaptionMode captions, Color color,
                List<Overlay> overlays, List<Gain> gains, AudioPeakPolicy audioPeakPolicy, double truePeakCeilingDbtp) {
        Spec {
            overlays = List.copyOf(overlays);
            gains = List.copyOf(gains);
            if (audioPeakPolicy == null) audioPeakPolicy = AudioPeakPolicy.LIMIT;
            if (width < 2 || height < 2 || width > 1920 || height > 1080 || width % 2 != 0 || height % 2 != 0) {
                throw bad("width", "width and height must be even and within 2..1920 x 2..1080");
            }
            if (fps < 1 || fps > MAX_FPS) throw bad("framesPerSecond", "framesPerSecond must be within [1, " + MAX_FPS + "]");
            if (!(truePeakCeilingDbtp >= MIN_TRUE_PEAK_CEILING_DBTP && truePeakCeilingDbtp <= MAX_TRUE_PEAK_CEILING_DBTP)) {
                throw bad("truePeakCeilingDbtp", "AUDIO_PEAK_CEILING_OUT_OF_RANGE",
                        "truePeakCeilingDbtp must be within [-6.0, -0.1] dBTP");
            }
        }

        /** The defaults of the audio peak policy: LIMIT at -1.0 dBTP. */
        Spec(int width, int height, int fps, GapPolicy gap, CaptionMode captions, Color color, List<Overlay> overlays,
             List<Gain> gains) {
            this(width, height, fps, gap, captions, color, overlays, gains, AudioPeakPolicy.LIMIT,
                    DEFAULT_TRUE_PEAK_CEILING_DBTP);
        }
    }

    record Limits(int maxClips, double maxSeconds) { }

    /** One contiguous run of output frames: a conformed source clip, or generated black. */
    record Segment(Clip clip, long startFrame, long frames) {
        boolean black() { return clip == null; }
    }

    record Timed(Clip clip, long startFrame, long frames) {
        long endFrame() { return startFrame + frames; }
    }

    record Planned(List<Segment> video, List<Timed> overlays, List<Clip> audio, List<Clip> captions, long totalFrames) { }

    private MediaDevCompositePlan() { }

    static Planned plan(TimelineSnapshot timeline, Spec spec, Limits limits) {
        Map<String, Track> tracks = new LinkedHashMap<>();
        for (Track track : timeline.graph().tracks()) tracks.put(track.trackId(), track);
        List<Clip> clips = timeline.graph().clips();
        if (clips.isEmpty()) throw bad("timeline.clips", "RENDER_EMPTY_TIMELINE", "timeline has no clips to render");
        if (clips.size() > limits.maxClips()) {
            throw bad("timeline.clips", "RENDER_LIMIT_EXCEEDED", "timeline exceeds the clip ceiling");
        }
        List<Clip> video = new ArrayList<>();
        List<Clip> overlay = new ArrayList<>();
        List<Clip> audio = new ArrayList<>();
        List<Clip> caption = new ArrayList<>();
        for (Clip clip : clips) {
            switch (tracks.get(clip.trackId()).kind()) {
                case VIDEO -> video.add(clip);
                case OVERLAY -> overlay.add(clip);
                case AUDIO -> audio.add(clip);
                case CAPTION -> caption.add(clip);
            }
        }
        if (video.isEmpty()) {
            throw bad("timeline.clips", "TIMELINE_NO_VIDEO", "a composite render needs at least one VIDEO clip");
        }
        for (Clip clip : clips) {
            if (!sameSpan(clip)) {
                throw bad(path(clip, "sourceOut"), "RETIMING_NOT_SUPPORTED",
                        "clips must not be retimed: the source interval must equal the story duration");
            }
        }
        // ---- visual sequence ----
        List<Timed> placed = new ArrayList<>();
        for (Clip clip : video) {
            placed.add(new Timed(clip, frames(clip.storyStart(), spec.fps(), path(clip, "storyStart")),
                    frames(clip.storyDuration(), spec.fps(), path(clip, "storyDuration"))));
        }
        placed.sort(Comparator.comparingLong(Timed::startFrame).thenComparing(timed -> timed.clip().clipId()));
        List<Segment> segments = new ArrayList<>();
        long cursor = 0;
        for (Timed timed : placed) {
            if (timed.startFrame() < cursor) {
                throw bad(path(timed.clip(), "storyStart"), "TIMELINE_OVERLAP",
                        "video clips overlap; the visual sequence must be one clip at a time");
            }
            if (timed.startFrame() > cursor) {
                if (spec.gap() == GapPolicy.REFUSE) {
                    throw bad(path(timed.clip(), "storyStart"), "TIMELINE_GAP",
                            "the visual sequence has a gap before this clip; set gapPolicy BLACK to fill it with black");
                }
                segments.add(new Segment(null, cursor, timed.startFrame() - cursor));
            }
            segments.add(new Segment(timed.clip(), timed.startFrame(), timed.frames()));
            cursor = timed.endFrame();
        }
        long total = cursor;
        if ((double) total / spec.fps() > limits.maxSeconds()) {
            throw bad("timeline", "RENDER_DURATION_BUDGET",
                    "the timeline is longer than the " + limits.maxSeconds() + " s duration budget");
        }
        // ---- overlays (frame-grid, same-track overlap refused) ----
        List<Timed> overlays = new ArrayList<>();
        for (Clip clip : overlay) {
            overlays.add(new Timed(clip, frames(clip.storyStart(), spec.fps(), path(clip, "storyStart")),
                    frames(clip.storyDuration(), spec.fps(), path(clip, "storyDuration"))));
        }
        for (Timed timed : overlays) {
            if (timed.endFrame() > total) {
                throw bad(path(timed.clip(), "storyDuration"), "CLIP_PAST_TIMELINE_END",
                        "the overlay clip ends after the visual sequence");
            }
        }
        sameTrackOverlap(overlays.stream().map(t -> new Object[] {t.clip(), BigInteger.valueOf(t.startFrame()),
                BigInteger.valueOf(t.endFrame())}).toList());
        // ---- audio and captions (sample grid; captions never overlap) ----
        BigInteger end = BigInteger.valueOf(total).multiply(BigInteger.valueOf(AUDIO_RATE))
                .divide(BigInteger.valueOf(spec.fps()));
        List<Object[]> audioSpans = new ArrayList<>();
        for (Clip clip : audio) {
            BigInteger start = samples(clip.storyStart(), path(clip, "storyStart"));
            BigInteger length = samples(clip.storyDuration(), path(clip, "storyDuration"));
            if (start.add(length).compareTo(end) > 0) {
                throw bad(path(clip, "storyDuration"), "CLIP_PAST_TIMELINE_END", "the audio clip ends after the visual sequence");
            }
            audioSpans.add(new Object[] {clip, start, start.add(length)});
        }
        sameTrackOverlap(audioSpans);
        List<Object[]> captionSpans = new ArrayList<>();
        for (Clip clip : caption) {
            BigInteger start = samples(clip.storyStart(), path(clip, "storyStart"));
            BigInteger stop = start.add(samples(clip.storyDuration(), path(clip, "storyDuration")));
            if (stop.compareTo(end) > 0) {
                throw bad(path(clip, "storyDuration"), "CLIP_PAST_TIMELINE_END", "the caption clip ends after the visual sequence");
            }
            for (Object[] other : captionSpans) {
                if (start.compareTo((BigInteger) other[2]) < 0 && ((BigInteger) other[1]).compareTo(stop) < 0) {
                    throw bad(path(clip, "storyStart"), "CAPTION_CLIPS_OVERLAP", "overlapping caption clips are not supported");
                }
            }
            captionSpans.add(new Object[] {clip, start, stop});
        }
        if (spec.captions() == CaptionMode.NONE && !caption.isEmpty()) {
            throw bad("composition.captions", "CAPTION_MODE_REQUIRED",
                    "the timeline has caption clips; captions must be MUX, BURN or BOTH (a caption clip is never silently dropped)");
        }
        // ---- composition parameters must name clips of the right kind ----
        Set<String> overlayIds = ids(overlay);
        Set<String> audioIds = ids(audio);
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < spec.overlays().size(); i++) {
            Overlay entry = spec.overlays().get(i);
            if (!overlayIds.contains(entry.clipId())) {
                throw bad("composition.overlays[" + i + "].clipId", "COMPOSITION_CLIP_UNKNOWN",
                        "the clip is not an OVERLAY-track clip of this timeline");
            }
            if (!seen.add(entry.clipId())) {
                throw bad("composition.overlays[" + i + "].clipId", "COMPOSITION_CLIP_DUPLICATE", "overlay clip is placed twice");
            }
        }
        for (Clip clip : overlay) {
            if (!seen.contains(clip.clipId())) {
                throw bad("composition.overlays", "OVERLAY_PLACEMENT_REQUIRED",
                        "overlay clip " + clip.clipId() + " has no placement (x, y, opacity)");
            }
        }
        seen.clear();
        for (int i = 0; i < spec.gains().size(); i++) {
            Gain entry = spec.gains().get(i);
            if (!audioIds.contains(entry.clipId())) {
                throw bad("composition.audio[" + i + "].clipId", "COMPOSITION_CLIP_UNKNOWN",
                        "the clip is not an AUDIO-track clip of this timeline");
            }
            if (!seen.add(entry.clipId())) {
                throw bad("composition.audio[" + i + "].clipId", "COMPOSITION_CLIP_DUPLICATE", "audio clip has two gains");
            }
        }
        return new Planned(segments, overlays, audio, caption, total);
    }

    // ---- helpers shared with the runtime ----

    static String path(Clip clip, String field) {
        return "timeline.clips[" + clip.clipId() + "]." + field;
    }

    /** Exact seconds of a rational time as a reduced pair. */
    static BigInteger[] fraction(RationalTime time) {
        BigInteger numerator = BigInteger.valueOf(time.ticks()).multiply(BigInteger.valueOf(time.rateDenominator()));
        BigInteger denominator = BigInteger.valueOf(time.rateNumerator());
        BigInteger gcd = numerator.gcd(denominator);
        if (gcd.signum() == 0) return new BigInteger[] {BigInteger.ZERO, BigInteger.ONE};
        return new BigInteger[] {numerator.divide(gcd), denominator.divide(gcd)};
    }

    /** True when (sourceOut - sourceIn) equals the story duration exactly, so no retiming is implied. */
    private static boolean sameSpan(Clip clip) {
        BigInteger[] in = fraction(clip.sourceIn());
        BigInteger[] out = fraction(clip.sourceOut());
        BigInteger[] story = fraction(clip.storyDuration());
        BigInteger spanNumerator = out[0].multiply(in[1]).subtract(in[0].multiply(out[1]));
        BigInteger spanDenominator = out[1].multiply(in[1]);
        return spanNumerator.multiply(story[1]).equals(story[0].multiply(spanDenominator));
    }

    /** Seconds with nine fractional digits, for FFmpeg trim parameters. */
    static String decimalSeconds(RationalTime time) {
        BigInteger[] fraction = fraction(time);
        return new BigDecimal(fraction[0]).divide(new BigDecimal(fraction[1]), 9, RoundingMode.HALF_EVEN).toPlainString();
    }

    static double doubleSeconds(RationalTime time) {
        BigInteger[] fraction = fraction(time);
        return new BigDecimal(fraction[0]).divide(new BigDecimal(fraction[1]), 12, RoundingMode.HALF_EVEN).doubleValue();
    }

    /** Whole output frames of {@code time}; anything between frames is refused, never rounded. */
    static long frames(RationalTime time, int fps, String path) {
        BigInteger[] fraction = fraction(time);
        BigInteger scaled = fraction[0].multiply(BigInteger.valueOf(fps));
        BigInteger[] division = scaled.divideAndRemainder(fraction[1]);
        if (division[1].signum() != 0 || division[0].bitLength() > 31) {
            throw bad(path, "TIME_NOT_FRAME_ALIGNED", "the time is not a whole number of frames at " + fps + " fps");
        }
        return division[0].longValueExact();
    }

    /** Whole 48 kHz samples of {@code time}. */
    static BigInteger samples(RationalTime time, String path) {
        BigInteger[] fraction = fraction(time);
        BigInteger[] division = fraction[0].multiply(BigInteger.valueOf(AUDIO_RATE)).divideAndRemainder(fraction[1]);
        if (division[1].signum() != 0 || division[0].bitLength() > 40) {
            throw bad(path, "TIME_NOT_SAMPLE_ALIGNED", "the time is not a whole number of samples at 48 kHz");
        }
        return division[0];
    }

    private static Set<String> ids(List<Clip> clips) {
        Set<String> ids = new HashSet<>();
        for (Clip clip : clips) ids.add(clip.clipId());
        return ids;
    }

    private static void sameTrackOverlap(List<Object[]> spans) {
        for (int i = 0; i < spans.size(); i++) {
            for (int j = 0; j < i; j++) {
                Clip a = (Clip) spans.get(i)[0];
                Clip b = (Clip) spans.get(j)[0];
                if (!a.trackId().equals(b.trackId())) continue;
                BigInteger aStart = (BigInteger) spans.get(i)[1], aEnd = (BigInteger) spans.get(i)[2];
                BigInteger bStart = (BigInteger) spans.get(j)[1], bEnd = (BigInteger) spans.get(j)[2];
                if (aStart.compareTo(bEnd) < 0 && bStart.compareTo(aEnd) < 0) {
                    throw bad(path(a, "storyStart"), "TIMELINE_OVERLAP", "clips on one track overlap");
                }
            }
        }
    }

    static SpeechRefusedException bad(String path, String message) {
        return bad(path, "COMPOSITION_INVALID", message);
    }

    static SpeechRefusedException bad(String path, String code, String message) {
        return new SpeechRefusedException(422, code, message, Map.of("path", path));
    }

    static boolean isVisual(TrackKind kind) { return kind == TrackKind.VIDEO || kind == TrackKind.OVERLAY; }
}
