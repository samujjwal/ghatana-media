package com.ghatana.media.launcher;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Source clock of one exact container version, derived from ffprobe: the container {@code start_time} and, per
 * stream, the exact {@code time_base}, {@code start_pts} and {@code start_time}. Every time the grounded-answer lane
 * publishes is expressed in container microseconds on this clock (container {@code start_time} included), so a child
 * result that declares a different clock id, timebase or source version cannot be merged.
 *
 * @doc.type class
 * @doc.purpose container start_time/timebase source clock and child clock binding for grounded answers
 * @doc.layer product
 * @doc.pattern ValueObject
 */
public record MediaDevGroundedClock(String clockId, long containerStartMicros, long containerDurationMicros,
                                    Stream video, Stream audio) {
    public static final long MICROS_PER_SECOND = 1_000_000L;
    private static final ObjectMapper JSON = JsonMapper.builder().build();

    /** One timed stream; {@code index < 0} means absent. */
    public record Stream(int index, long timebaseNum, long timebaseDen, long startPts, long startMicros,
                         int width, int height, int sampleRate) {
        public Stream {
            if (index >= 0 && (timebaseNum <= 0 || timebaseDen <= 0)) {
                throw new IllegalArgumentException("stream timebase must be positive");
            }
        }
        public static Stream absent() { return new Stream(-1, 1, 1, 0, 0, 0, 0, 0); }
        public boolean present() { return index >= 0; }
        public String timebase() { return timebaseNum + "/" + timebaseDen; }
    }

    /** Typed clock/version binding refusal. {@code code} is surfaced to the caller; no content is carried. */
    public static final class ClockBindingException extends RuntimeException {
        private final String code;
        ClockBindingException(String code, String message) {
            super(message, null, false, false);
            this.code = code;
        }
        public String code() { return code; }
    }

    public MediaDevGroundedClock {
        Objects.requireNonNull(clockId, "clockId");
        Objects.requireNonNull(video, "video");
        Objects.requireNonNull(audio, "audio");
        if (containerDurationMicros <= 0) throw new IllegalArgumentException("duration must be positive");
    }

    /**
     * Parses the JSON of {@code ffprobe -of json -show_entries
     * format=start_time,duration:stream=index,codec_type,start_time,start_pts,time_base,width,height,sample_rate}.
     * A missing container start_time, a missing or non-positive timebase, or a missing duration is refused rather
     * than defaulted: an assumed zero would silently shift every published time.
     */
    public static MediaDevGroundedClock parse(byte[] ffprobeJson, String sourceSha256) {
        final JsonNode root;
        try {
            root = JSON.readTree(ffprobeJson);
        } catch (RuntimeException invalid) {
            throw new ClockBindingException("SOURCE_CLOCK_UNDETERMINED", "ffprobe output is not valid JSON");
        }
        JsonNode format = root.path("format");
        long containerStart = micros(format.path("start_time"), "container start_time");
        long duration = micros(format.path("duration"), "container duration");
        if (duration <= 0) throw new ClockBindingException("SOURCE_CLOCK_UNDETERMINED", "container duration missing");
        Stream video = Stream.absent();
        Stream audio = Stream.absent();
        for (JsonNode stream : root.path("streams")) {
            String type = stream.path("codec_type").asString("");
            if (!(type.equals("video") || type.equals("audio"))) continue;
            Stream parsed = stream(stream);
            if (type.equals("video") && !video.present()) video = parsed;
            if (type.equals("audio") && !audio.present()) audio = parsed;
        }
        if (!video.present() && !audio.present()) {
            throw new ClockBindingException("SOURCE_CLOCK_UNDETERMINED", "the source has no timed audio or video stream");
        }
        String id = "container-clock:" + sourceSha256.substring(0, Math.min(16, sourceSha256.length())) + ":" + digest(
                sourceSha256 + "|" + containerStart + "|" + duration + "|" + video + "|" + audio).substring(0, 16);
        return new MediaDevGroundedClock(id, containerStart, duration, video, audio);
    }

    private static Stream stream(JsonNode stream) {
        String[] timebase = stream.path("time_base").asString("").split("/");
        long num;
        long den;
        try {
            num = Long.parseLong(timebase[0]);
            den = Long.parseLong(timebase[1]);
        } catch (RuntimeException invalid) {
            throw new ClockBindingException("SOURCE_CLOCK_UNDETERMINED", "stream time_base missing or malformed");
        }
        if (num <= 0 || den <= 0 || !stream.path("start_pts").isIntegralNumber()) {
            throw new ClockBindingException("SOURCE_CLOCK_UNDETERMINED", "stream timebase or start_pts missing");
        }
        long startPts = stream.path("start_pts").asLong();
        long startMicros = ticksToMicros(startPts, num, den);
        return new Stream(stream.path("index").asInt(-1), num, den, startPts, startMicros,
                stream.path("width").asInt(0), stream.path("height").asInt(0),
                Integer.parseInt(stream.path("sample_rate").asString("0")));
    }

    private static long micros(JsonNode node, String what) {
        if (!node.isString()) throw new ClockBindingException("SOURCE_CLOCK_UNDETERMINED", what + " missing");
        try {
            return new BigDecimal(node.asString()).multiply(BigDecimal.valueOf(MICROS_PER_SECOND))
                    .setScale(0, RoundingMode.HALF_UP).longValueExact();
        } catch (RuntimeException invalid) {
            throw new ClockBindingException("SOURCE_CLOCK_UNDETERMINED", what + " is not a number");
        }
    }

    /** Exact rational conversion, rounded half up, to container microseconds. */
    public static long ticksToMicros(long ticks, long timebaseNum, long timebaseDen) {
        BigInteger scaled = BigInteger.valueOf(ticks).multiply(BigInteger.valueOf(timebaseNum))
                .multiply(BigInteger.valueOf(MICROS_PER_SECOND));
        BigInteger[] qr = scaled.multiply(BigInteger.TWO).add(BigInteger.valueOf(timebaseDen))
                .divideAndRemainder(BigInteger.valueOf(timebaseDen).multiply(BigInteger.TWO));
        return qr[0].longValueExact();
    }

    public static long microsToTicks(long micros, long timebaseNum, long timebaseDen) {
        BigInteger scaled = BigInteger.valueOf(micros).multiply(BigInteger.valueOf(timebaseDen));
        BigInteger divisor = BigInteger.valueOf(timebaseNum).multiply(BigInteger.valueOf(MICROS_PER_SECOND));
        return scaled.multiply(BigInteger.TWO).add(divisor).divide(divisor.multiply(BigInteger.TWO)).longValueExact();
    }

    public long containerEndMicros() { return containerStartMicros + containerDurationMicros; }

    /** The pin every child envelope must repeat exactly. */
    public Pin pin(String sourceArtifactVersionId, String sourceSha256) {
        return new Pin(sourceArtifactVersionId, sourceSha256, clockId, containerStartMicros, 1, MICROS_PER_SECOND);
    }

    /**
     * What a child declares about the clock and exact source version its evidence is on. Times inside evidence are
     * container microseconds, so the declared unit is 1/1_000_000.
     */
    public record Pin(String sourceArtifactVersionId, String sourceSha256, String clockId, long containerStartMicros,
                      long unitNum, long unitDen) { }

    /** Refuses a child whose pin disagrees with the parent's about the version, the clock, its start or its unit. */
    public void requireBound(Pin parent, Pin child, String childKind) {
        if (child == null) {
            throw new ClockBindingException("SOURCE_CLOCK_MISMATCH",
                    childKind + " child result declares no source clock or version");
        }
        if (!parent.sourceArtifactVersionId().equals(child.sourceArtifactVersionId())
                || !parent.sourceSha256().equals(child.sourceSha256())) {
            throw new ClockBindingException("STALE_CHILD_SOURCE_VERSION",
                    childKind + " child result is bound to a different source version");
        }
        if (!parent.clockId().equals(child.clockId())) {
            throw new ClockBindingException("SOURCE_CLOCK_MISMATCH",
                    childKind + " child result declares a different source clock");
        }
        if (parent.unitNum() != child.unitNum() || parent.unitDen() != child.unitDen()
                || parent.containerStartMicros() != child.containerStartMicros()) {
            throw new ClockBindingException("SOURCE_CLOCK_MISMATCH",
                    childKind + " child result declares a different timebase or container start_time");
        }
    }

    public Map<String, Object> view() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("clockId", clockId);
        out.put("unit", "container microseconds (container start_time included)");
        out.put("containerStartMicros", containerStartMicros);
        out.put("containerDurationMicros", containerDurationMicros);
        out.put("video", streamView(video));
        out.put("audio", streamView(audio));
        return out;
    }

    private static Map<String, Object> streamView(Stream stream) {
        if (!stream.present()) return Map.of("present", false);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("present", true);
        out.put("index", stream.index());
        out.put("timebase", stream.timebase());
        out.put("startPts", stream.startPts());
        out.put("startMicros", stream.startMicros());
        if (stream.width() > 0) {
            out.put("width", stream.width());
            out.put("height", stream.height());
        }
        if (stream.sampleRate() > 0) out.put("sampleRate", stream.sampleRate());
        return out;
    }

    static String digest(String text) {
        try {
            return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                    .digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }
}
