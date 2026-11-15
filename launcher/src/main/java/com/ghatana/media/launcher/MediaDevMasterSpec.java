package com.ghatana.media.launcher;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Strict, typed parsing of the DEV_ONLY stem-generator and master requests (journey J-17). Every violation is a typed
 * 422 that names the JSON path of the offending field; unknown keys, wrong types and out-of-range numbers are refused
 * before any rights call, artifact lookup, synthesis or encode. Parsed values are canonicalized (defaults filled, fixed
 * key order) so the same request always has the same digest.
 */
final class MediaDevMasterSpec {
    static final String STEM_SCHEMA = "media.dev.stem-generator.v1";
    static final int RATE = 48_000;
    static final int MIN_STEM_MS = 50;
    static final int MAX_STEM_MS = 30_000;
    static final int MAX_PLACEMENTS = 32;
    /** 60 s at 48 kHz. */
    static final int MAX_MASTER_FRAMES = 60 * RATE;
    /** One 400 ms BS.1770 gating block: the shortest programme whose integrated loudness is defined. */
    static final int MIN_MASTER_FRAMES = RATE * 4 / 10;
    static final double MIN_GAIN_DB = -60.0;
    static final double MAX_GAIN_DB = 12.0;

    enum Kind { TONE, CHORD, DRUM, FOLEY }
    enum Drum { KICK, SNARE, HAT }
    enum Foley { FOOTSTEP, WHOOSH, IMPACT }

    /** A procedural stem. Fields that do not apply to the kind are null/empty and absent from the canonical form. */
    record Stem(Kind kind, int durationMs, int channels, double amplitudeDb, Double frequencyHz,
                List<Double> frequenciesHz, int attackMs, int releaseMs, Drum drum, Foley foley, long seed) {
        int frames() { return durationMs * (RATE / 1000); }

        Map<String, Object> canonical() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("schema", STEM_SCHEMA);
            out.put("kind", kind.name());
            out.put("durationMs", durationMs);
            out.put("channels", channels);
            out.put("amplitudeDb", amplitudeDb);
            switch (kind) {
                case TONE -> {
                    out.put("frequencyHz", frequencyHz);
                    out.put("attackMs", attackMs);
                    out.put("releaseMs", releaseMs);
                }
                case CHORD -> {
                    out.put("frequenciesHz", frequenciesHz);
                    out.put("attackMs", attackMs);
                    out.put("releaseMs", releaseMs);
                }
                case DRUM -> {
                    out.put("drum", drum.name());
                    out.put("seed", seed);
                }
                case FOLEY -> {
                    out.put("foley", foley.name());
                    out.put("seed", seed);
                }
            }
            return out;
        }
    }

    record StemRequest(String requestId, Stem stem) { }

    record Placement(String artifactId, String artifactVersionId, double gainDb, double pan, int startFrame,
                     int fadeInFrames, int fadeOutFrames) { }

    record Master(String requestId, List<Placement> placements, Integer durationFrames, double targetLufs,
                  double truePeakDbtp) {
        Map<String, Object> canonical() {
            Map<String, Object> out = new LinkedHashMap<>();
            List<Map<String, Object>> list = new ArrayList<>();
            for (Placement p : placements) {
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("artifactId", p.artifactId());
                entry.put("artifactVersionId", p.artifactVersionId());
                entry.put("gainDb", p.gainDb());
                entry.put("pan", p.pan());
                entry.put("startFrame", p.startFrame());
                entry.put("fadeInFrames", p.fadeInFrames());
                entry.put("fadeOutFrames", p.fadeOutFrames());
                list.add(entry);
            }
            out.put("stems", list);
            out.put("durationFrames", durationFrames);
            out.put("target", Map.of("integratedLufs", targetLufs, "truePeakDbtp", truePeakDbtp));
            return out;
        }
    }

    private MediaDevMasterSpec() { }

    static MediaDevMasterRuntime.MasterRefusedException invalid(String path, String message) {
        return new MediaDevMasterRuntime.MasterRefusedException(422, "MASTER_PARAMETERS_INVALID", message,
                Map.of("path", path));
    }

    static MediaDevMasterRuntime.MasterRefusedException budget(String path, String limit, long ceiling, long requested) {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("path", path);
        details.put("limit", limit);
        details.put("ceiling", ceiling);
        details.put("requested", requested);
        return new MediaDevMasterRuntime.MasterRefusedException(422, "MASTER_BUDGET_EXCEEDED",
                limit + " exceeds its ceiling; nothing was processed", details);
    }

    // ---- stem generator request ----

    static StemRequest parseStemRequest(Object raw) {
        Map<String, Object> body = object(raw, "$");
        keys(body, "$", Set.of("requestId", "spec"), Set.of());
        return new StemRequest(requestId(body.get("requestId")), parseStem(body.get("spec"), "$.spec"));
    }

    static Stem parseStem(Object raw, String path) {
        Map<String, Object> spec = object(raw, path);
        if (!spec.containsKey("kind")) throw invalid(path + ".kind", "is required");
        Kind kind = enumOf(Kind.class, spec.get("kind"), path + ".kind");
        Set<String> common = Set.of("kind", "durationMs", "channels", "amplitudeDb");
        Set<String> extra = switch (kind) {
            case TONE -> Set.of("frequencyHz", "attackMs", "releaseMs");
            case CHORD -> Set.of("frequenciesHz", "attackMs", "releaseMs");
            case DRUM -> Set.of("drum", "seed");
            case FOLEY -> Set.of("foley", "seed");
        };
        Set<String> allowed = new java.util.HashSet<>(common);
        allowed.addAll(extra);
        if (spec.containsKey("schema") && !STEM_SCHEMA.equals(spec.get("schema"))) {
            throw invalid(path + ".schema", "must be " + STEM_SCHEMA);
        }
        allowed.add("schema");
        keys(spec, path, Set.of("kind", "durationMs"), Set.copyOf(allowed));
        int durationMs = wholeNumber(spec.get("durationMs"), path + ".durationMs");
        if (durationMs < MIN_STEM_MS || durationMs > MAX_STEM_MS) {
            if (durationMs > MAX_STEM_MS) throw budget(path + ".durationMs", "stem duration (ms)", MAX_STEM_MS, durationMs);
            throw invalid(path + ".durationMs", "must be within [" + MIN_STEM_MS + ", " + MAX_STEM_MS + "]");
        }
        int channels = spec.containsKey("channels") ? wholeNumber(spec.get("channels"), path + ".channels") : 1;
        if (channels < 1 || channels > 2) {
            throw new MediaDevMasterRuntime.MasterRefusedException(422, "STEM_FORMAT_NOT_SUPPORTED",
                    "only mono (1) or stereo (2) stems are supported", Map.of("path", path + ".channels"));
        }
        double amplitudeDb = spec.containsKey("amplitudeDb")
                ? range(spec.get("amplitudeDb"), path + ".amplitudeDb", -60.0, 0.0) : -6.0;
        int frames = durationMs * (RATE / 1000);
        Double frequency = null;
        List<Double> frequencies = null;
        int attack = 5;
        int release = 20;
        Drum drum = null;
        Foley foley = null;
        long seed = 1;
        switch (kind) {
            case TONE -> {
                if (!spec.containsKey("frequencyHz")) throw invalid(path + ".frequencyHz", "is required");
                frequency = range(spec.get("frequencyHz"), path + ".frequencyHz", 20.0, 20_000.0);
            }
            case CHORD -> {
                if (!spec.containsKey("frequenciesHz")) throw invalid(path + ".frequenciesHz", "is required");
                if (!(spec.get("frequenciesHz") instanceof List<?> list) || list.isEmpty() || list.size() > 6) {
                    throw invalid(path + ".frequenciesHz", "must be an array of 1 to 6 frequencies");
                }
                frequencies = new ArrayList<>();
                for (int i = 0; i < list.size(); i++) {
                    frequencies.add(range(list.get(i), path + ".frequenciesHz[" + i + "]", 20.0, 20_000.0));
                }
            }
            case DRUM -> {
                if (!spec.containsKey("drum")) throw invalid(path + ".drum", "is required");
                drum = enumOf(Drum.class, spec.get("drum"), path + ".drum");
            }
            case FOLEY -> {
                if (!spec.containsKey("foley")) throw invalid(path + ".foley", "is required");
                foley = enumOf(Foley.class, spec.get("foley"), path + ".foley");
            }
        }
        if (kind == Kind.TONE || kind == Kind.CHORD) {
            if (spec.containsKey("attackMs")) attack = wholeNumber(spec.get("attackMs"), path + ".attackMs");
            if (spec.containsKey("releaseMs")) release = wholeNumber(spec.get("releaseMs"), path + ".releaseMs");
            if (attack < 0) throw invalid(path + ".attackMs", "must not be negative");
            if (release < 0) throw invalid(path + ".releaseMs", "must not be negative");
            if ((long) attack + release > durationMs) {
                throw invalid(path + ".releaseMs", "attackMs + releaseMs must not exceed durationMs");
            }
        } else {
            attack = 0;
            release = 0;
            if (spec.containsKey("seed")) {
                seed = wholeLong(spec.get("seed"), path + ".seed");
                if (seed < 0 || seed > (1L << 53)) throw invalid(path + ".seed", "must be within [0, 2^53]");
            }
        }
        if (frames <= 0) throw invalid(path + ".durationMs", "must produce at least one sample");
        return new Stem(kind, durationMs, channels, amplitudeDb, frequency, frequencies, attack, release, drum, foley, seed);
    }

    // ---- master request ----

    static Master parseMaster(Object raw) {
        Map<String, Object> body = object(raw, "$");
        keys(body, "$", Set.of("requestId", "stems"), Set.of("durationFrames", "target"));
        String requestId = requestId(body.get("requestId"));
        if (!(body.get("stems") instanceof List<?> list)) throw invalid("$.stems", "must be an array");
        if (list.isEmpty()) throw invalid("$.stems", "at least one stem is required");
        if (list.size() > MAX_PLACEMENTS) {
            throw budget("$.stems", "stem placements", MAX_PLACEMENTS, list.size());
        }
        List<Placement> placements = new ArrayList<>();
        for (int i = 0; i < list.size(); i++) {
            String path = "$.stems[" + i + "]";
            Map<String, Object> entry = object(list.get(i), path);
            keys(entry, path, Set.of("artifactId", "artifactVersionId"),
                    Set.of("gainDb", "pan", "startFrame", "fadeInFrames", "fadeOutFrames"));
            double gain = entry.containsKey("gainDb") ? range(entry.get("gainDb"), path + ".gainDb", MIN_GAIN_DB, MAX_GAIN_DB) : 0.0;
            double pan = entry.containsKey("pan") ? range(entry.get("pan"), path + ".pan", -1.0, 1.0) : 0.0;
            int start = entry.containsKey("startFrame") ? frameCount(entry.get("startFrame"), path + ".startFrame") : 0;
            int fadeIn = entry.containsKey("fadeInFrames") ? frameCount(entry.get("fadeInFrames"), path + ".fadeInFrames") : 0;
            int fadeOut = entry.containsKey("fadeOutFrames") ? frameCount(entry.get("fadeOutFrames"), path + ".fadeOutFrames") : 0;
            placements.add(new Placement(id(entry.get("artifactId"), path + ".artifactId"),
                    versionId(entry.get("artifactVersionId"), path + ".artifactVersionId"), gain, pan, start, fadeIn, fadeOut));
        }
        Integer durationFrames = null;
        if (body.get("durationFrames") != null) {
            durationFrames = frameCount(body.get("durationFrames"), "$.durationFrames");
            if (durationFrames < MIN_MASTER_FRAMES) {
                throw new MediaDevMasterRuntime.MasterRefusedException(422, "MASTER_TOO_SHORT_TO_MEASURE",
                        "a master shorter than one 400 ms gating block has no defined integrated loudness",
                        Map.of("path", "$.durationFrames", "minimumFrames", MIN_MASTER_FRAMES));
            }
        }
        double lufs = -16.0;
        double ceiling = -1.0;
        if (body.get("target") != null) {
            Map<String, Object> target = object(body.get("target"), "$.target");
            keys(target, "$.target", Set.of(), Set.of("integratedLufs", "truePeakDbtp"));
            if (target.containsKey("integratedLufs")) lufs = range(target.get("integratedLufs"), "$.target.integratedLufs", -30.0, -9.0);
            if (target.containsKey("truePeakDbtp")) ceiling = range(target.get("truePeakDbtp"), "$.target.truePeakDbtp", -6.0, -0.1);
        }
        return new Master(requestId, List.copyOf(placements), durationFrames, lufs, ceiling);
    }

    // ---- primitives ----

    @SuppressWarnings("unchecked")
    static Map<String, Object> object(Object value, String path) {
        if (!(value instanceof Map<?, ?> map)) throw invalid(path, "must be an object");
        for (Object key : map.keySet()) if (!(key instanceof String)) throw invalid(path, "must have string keys");
        return (Map<String, Object>) map;
    }

    static void keys(Map<String, Object> value, String path, Set<String> required, Set<String> optional) {
        for (String key : required) {
            if (!value.containsKey(key) || value.get(key) == null) throw invalid(path + "." + key, "is required");
        }
        for (String key : value.keySet()) {
            if (!required.contains(key) && !optional.contains(key)) throw invalid(path + "." + key, "is not a known field");
        }
    }

    static String requestId(Object value) {
        if (!(value instanceof String text) || !text.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
            throw invalid("$.requestId", "must be a 1-128 character opaque id");
        }
        return text;
    }

    private static String id(Object value, String path) {
        if (!(value instanceof String text) || !text.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
            throw invalid(path, "must be a 1-128 character opaque id");
        }
        return text;
    }

    private static String versionId(Object value, String path) {
        if (!(value instanceof String text) || text.isBlank() || text.length() > 200) {
            throw invalid(path, "must be an artifact version id");
        }
        return text;
    }

    private static <E extends Enum<E>> E enumOf(Class<E> type, Object value, String path) {
        if (value instanceof String text) {
            for (E constant : type.getEnumConstants()) if (constant.name().equals(text)) return constant;
        }
        throw invalid(path, "must be one of " + java.util.Arrays.toString(type.getEnumConstants()));
    }

    private static double range(Object value, String path, double min, double max) {
        if (!(value instanceof Number number) || value instanceof Boolean) throw invalid(path, "must be a number");
        double v = number.doubleValue();
        if (!Double.isFinite(v) || v < min || v > max) throw invalid(path, "must be within [" + min + ", " + max + "]");
        return v;
    }

    private static int wholeNumber(Object value, String path) {
        long v = wholeLong(value, path);
        if (v < Integer.MIN_VALUE || v > Integer.MAX_VALUE) throw invalid(path, "is out of range");
        return (int) v;
    }

    private static long wholeLong(Object value, String path) {
        if (!(value instanceof Integer || value instanceof Long || value instanceof Short)) {
            throw invalid(path, "must be an integer");
        }
        return ((Number) value).longValue();
    }

    /** A non-negative sample count; counts past the master ceiling are budget refusals, not silent clamps. */
    private static int frameCount(Object value, String path) {
        long v = wholeLong(value, path);
        if (v < 0) throw invalid(path, "must not be negative");
        if (v > MAX_MASTER_FRAMES) throw budget(path, "frames", MAX_MASTER_FRAMES, v);
        return (int) v;
    }
}
