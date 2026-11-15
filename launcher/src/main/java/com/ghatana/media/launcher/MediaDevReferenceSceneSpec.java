package com.ghatana.media.launcher;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Parsing and validation of the authored-template reference scene request (J-10). Every refusal is a typed 422 whose
 * details name the JSON path of the offending value; nothing is rendered, read or rights-checked before the whole
 * request is valid. The parsed form is canonical: a fixed key order and normalised numbers, so identical requests have
 * identical canonical documents (and therefore identical fingerprints and provenance).
 */
final class MediaDevReferenceSceneSpec {
    static final String SCHEMA = "media.dev.reference-scene-spec.v1";
    static final String STAGE = "reference-stage";
    static final String SPOTLIGHT = "product-spotlight";
    static final int TEMPLATE_VERSION = 1;
    static final int MIN_WIDTH = 160;
    static final int MAX_WIDTH = 640;
    static final int MIN_HEIGHT = 90;
    static final int MAX_HEIGHT = 360;
    static final int MAX_SCENES = 8;
    static final int MAX_SLOTS = 3;
    static final int MAX_SPARKLES = 64;
    static final int MAX_DRIFT = 16;
    static final int MIN_PALETTE = 2;
    static final int MAX_PALETTE = 6;

    private MediaDevReferenceSceneSpec() { }

    record Slot(String referenceId, double x, double height, int tintRgb, int tintPermille) {
        boolean tinted() { return tintPermille > 0; }
    }

    record Thresholds(double maxHistogramDistance, double minSsim, int maxHashDistance, double minPaletteAdherence,
                      double maxCrossSceneHistogramDistance) {
        static final Thresholds DEFAULT = new Thresholds(0.35, 0.50, 16, 0.98, 0.30);

        Map<String, Object> view() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("maxHistogramDistance", maxHistogramDistance);
            out.put("minSsim", minSsim);
            out.put("maxHashDistance", maxHashDistance);
            out.put("minPaletteAdherence", minPaletteAdherence);
            out.put("maxCrossSceneHistogramDistance", maxCrossSceneHistogramDistance);
            return out;
        }
    }

    record Parsed(String templateId, int templateVersion, long seed, int sceneCount, int width, int height,
                  List<Integer> palette, List<Slot> slots, int drift, double pushStart, double pushEnd, int sparkles,
                  Thresholds thresholds, Map<String, Object> canonical) {
        boolean spotlight() { return SPOTLIGHT.equals(templateId); }
    }

    static MediaDevReferenceSceneRuntime.RefSceneRefusedException invalid(String path, String message) {
        return new MediaDevReferenceSceneRuntime.RefSceneRefusedException(422, "REFERENCE_SCENE_SPEC_INVALID", message,
                Map.of("path", path));
    }

    static List<Map<String, Object>> catalog() {
        List<Map<String, Object>> out = new ArrayList<>();
        out.add(templateView(STAGE, "Up to three reference images placed on a floor line over a palette background, one "
                + "layout per scene with seeded drift and a scale push; optional per-slot recolour and seeded sparkles",
                List.of("canvas", "palette", "slots", "drift", "push", "sparkles")));
        out.add(templateView(SPOTLIGHT, "One reference image centred in a palette ring over a floor line; optional "
                + "recolour, seeded drift, scale push and sparkles",
                List.of("canvas", "palette", "subject", "drift", "push", "sparkles")));
        return out;
    }

    private static Map<String, Object> templateView(String id, String description, List<String> parameters) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", id);
        view.put("version", TEMPLATE_VERSION);
        view.put("description", description);
        view.put("parameters", parameters);
        return view;
    }

    /** {@code template}, {@code seed}, {@code sceneCount}, {@code parameters} and {@code continuity} of a run request. */
    static Parsed parse(Object template, Object seed, Object sceneCount, Object parameters, Object continuity) {
        if (!(template instanceof Map<?, ?> templateMap)) throw invalid("$.template", "template must be an object");
        requireKeys(templateMap, Set.of("id", "version"), Set.of(), "$.template");
        if (!(templateMap.get("id") instanceof String id) || !(STAGE.equals(id) || SPOTLIGHT.equals(id))) {
            throw invalid("$.template.id", "template id must be one of " + STAGE + ", " + SPOTLIGHT);
        }
        if (!(integral(templateMap.get("version")) && ((Number) templateMap.get("version")).longValue() == TEMPLATE_VERSION)) {
            throw invalid("$.template.version", "only template version " + TEMPLATE_VERSION + " exists");
        }
        if (!integral(seed)) throw invalid("$.seed", "seed must be an integer");
        long seedValue = ((Number) seed).longValue();
        if (!integral(sceneCount) || ((Number) sceneCount).longValue() < 1 || ((Number) sceneCount).longValue() > MAX_SCENES) {
            throw invalid("$.sceneCount", "sceneCount must be an integer within [1, " + MAX_SCENES + "]");
        }
        int scenes = ((Number) sceneCount).intValue();
        if (!(parameters instanceof Map<?, ?> params)) throw invalid("$.parameters", "parameters must be an object");
        boolean spotlight = SPOTLIGHT.equals(id);
        requireKeys(params, Set.of("palette", spotlight ? "subject" : "slots"),
                Set.of("canvas", "drift", "push", "sparkles"), "$.parameters");

        int width = 320;
        int height = 180;
        if (params.containsKey("canvas")) {
            if (!(params.get("canvas") instanceof Map<?, ?> canvas)) throw invalid("$.parameters.canvas", "canvas must be an object");
            requireKeys(canvas, Set.of("width", "height"), Set.of(), "$.parameters.canvas");
            width = integer(canvas.get("width"), "$.parameters.canvas.width", MIN_WIDTH, MAX_WIDTH);
            height = integer(canvas.get("height"), "$.parameters.canvas.height", MIN_HEIGHT, MAX_HEIGHT);
        }
        if (!(params.get("palette") instanceof List<?> paletteList) || paletteList.size() < MIN_PALETTE
                || paletteList.size() > MAX_PALETTE) {
            throw invalid("$.parameters.palette", "palette must be a list of " + MIN_PALETTE + " to " + MAX_PALETTE
                    + " #RRGGBB colours");
        }
        List<Integer> palette = new ArrayList<>();
        for (int i = 0; i < paletteList.size(); i++) {
            palette.add(colour(paletteList.get(i), "$.parameters.palette[" + i + "]"));
        }
        List<Slot> slots = new ArrayList<>();
        if (spotlight) {
            slots.add(slot(params.get("subject"), "$.parameters.subject", false));
        } else {
            if (!(params.get("slots") instanceof List<?> slotList) || slotList.isEmpty() || slotList.size() > MAX_SLOTS) {
                throw invalid("$.parameters.slots", "slots must be a list of 1 to " + MAX_SLOTS + " reference slots");
            }
            for (int i = 0; i < slotList.size(); i++) slots.add(slot(slotList.get(i), "$.parameters.slots[" + i + "]", true));
            for (int i = 0; i < slots.size(); i++) {
                for (int j = i + 1; j < slots.size(); j++) {
                    if (Math.abs(slots.get(i).x() - slots.get(j).x()) < 0.2) {
                        throw invalid("$.parameters.slots[" + j + "].x", "slot centres must be at least 0.2 of the canvas apart");
                    }
                }
            }
        }
        int drift = params.containsKey("drift") ? integer(params.get("drift"), "$.parameters.drift", 0, MAX_DRIFT) : 4;
        double pushStart = 1.0;
        double pushEnd = 1.0;
        if (params.containsKey("push")) {
            if (!(params.get("push") instanceof Map<?, ?> push)) throw invalid("$.parameters.push", "push must be an object");
            requireKeys(push, Set.of("start", "end"), Set.of(), "$.parameters.push");
            pushStart = number(push.get("start"), "$.parameters.push.start", 0.6, 1.6);
            pushEnd = number(push.get("end"), "$.parameters.push.end", 0.6, 1.6);
        }
        int sparkles = params.containsKey("sparkles") ? integer(params.get("sparkles"), "$.parameters.sparkles", 0, MAX_SPARKLES) : 0;

        Thresholds thresholds = Thresholds.DEFAULT;
        if (continuity != null) {
            if (!(continuity instanceof Map<?, ?> map)) throw invalid("$.continuity", "continuity must be an object");
            requireKeys(map, Set.of(), Set.of("maxHistogramDistance", "minSsim", "maxHashDistance", "minPaletteAdherence",
                    "maxCrossSceneHistogramDistance"), "$.continuity");
            Thresholds d = Thresholds.DEFAULT;
            thresholds = new Thresholds(
                    map.containsKey("maxHistogramDistance") ? number(map.get("maxHistogramDistance"), "$.continuity.maxHistogramDistance", 0, 1) : d.maxHistogramDistance(),
                    map.containsKey("minSsim") ? number(map.get("minSsim"), "$.continuity.minSsim", -1, 1) : d.minSsim(),
                    map.containsKey("maxHashDistance") ? integer(map.get("maxHashDistance"), "$.continuity.maxHashDistance", 0, 64) : d.maxHashDistance(),
                    map.containsKey("minPaletteAdherence") ? number(map.get("minPaletteAdherence"), "$.continuity.minPaletteAdherence", 0, 1) : d.minPaletteAdherence(),
                    map.containsKey("maxCrossSceneHistogramDistance") ? number(map.get("maxCrossSceneHistogramDistance"), "$.continuity.maxCrossSceneHistogramDistance", 0, 1) : d.maxCrossSceneHistogramDistance());
        }

        Map<String, Object> canonical = new LinkedHashMap<>();
        canonical.put("schema", SCHEMA);
        canonical.put("template", ordered("id", id, "version", TEMPLATE_VERSION));
        canonical.put("seed", seedValue);
        canonical.put("sceneCount", scenes);
        Map<String, Object> canonicalParams = new LinkedHashMap<>();
        canonicalParams.put("canvas", ordered("width", width, "height", height));
        List<String> paletteText = new ArrayList<>();
        for (int rgb : palette) paletteText.add(String.format("#%06X", rgb));
        canonicalParams.put("palette", paletteText);
        List<Map<String, Object>> slotViews = new ArrayList<>();
        for (Slot slot : slots) {
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("referenceId", slot.referenceId());
            view.put("x", slot.x());
            view.put("height", slot.height());
            if (slot.tinted()) view.put("tint", ordered("color", String.format("#%06X", slot.tintRgb()),
                    "strength", slot.tintPermille() / 1000.0));
            slotViews.add(view);
        }
        if (spotlight) canonicalParams.put("subject", slotViews.getFirst()); else canonicalParams.put("slots", slotViews);
        canonicalParams.put("drift", drift);
        canonicalParams.put("push", ordered("start", pushStart, "end", pushEnd));
        canonicalParams.put("sparkles", sparkles);
        canonical.put("parameters", canonicalParams);
        canonical.put("continuity", thresholds.view());
        return new Parsed(id, TEMPLATE_VERSION, seedValue, scenes, width, height, List.copyOf(palette), List.copyOf(slots),
                drift, pushStart, pushEnd, sparkles, thresholds, canonical);
    }

    /** Insertion-ordered map: {@code Map.of} iterates in a per-process random order, which would change the digests. */
    private static Map<String, Object> ordered(Object... keyValues) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (int i = 0; i < keyValues.length; i += 2) out.put((String) keyValues[i], keyValues[i + 1]);
        return out;
    }

    private static Slot slot(Object value, String path, boolean needsX) {
        if (!(value instanceof Map<?, ?> map)) throw invalid(path, "a reference slot must be an object");
        requireKeys(map, Set.of("referenceId", "height"), Set.of("x", "tint"), path);
        if (needsX && !map.containsKey("x")) throw invalid(path + ".x", "is required");
        if (!(map.get("referenceId") instanceof String referenceId)
                || !referenceId.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
            throw invalid(path + ".referenceId", "referenceId must be a 1-128 character opaque id");
        }
        double x = map.containsKey("x") ? number(map.get("x"), path + ".x", 0.1, 0.9) : 0.5;
        double height = number(map.get("height"), path + ".height", 0.1, 0.8);
        int tintRgb = 0;
        int permille = 0;
        if (map.containsKey("tint")) {
            if (!(map.get("tint") instanceof Map<?, ?> tint)) throw invalid(path + ".tint", "tint must be an object");
            requireKeys(tint, Set.of("color", "strength"), Set.of(), path + ".tint");
            tintRgb = colour(tint.get("color"), path + ".tint.color");
            permille = (int) Math.round(number(tint.get("strength"), path + ".tint.strength", 0, 1) * 1000);
        }
        return new Slot(referenceId, x, height, tintRgb, permille);
    }

    private static void requireKeys(Map<?, ?> value, Set<String> required, Set<String> optional, String path) {
        for (String key : required) {
            if (!value.containsKey(key)) throw invalid(path + "." + key, "is required");
        }
        for (Object key : value.keySet()) {
            if (!required.contains(key) && !optional.contains(key)) throw invalid(path + "." + key, "is not a known field");
        }
    }

    private static boolean integral(Object value) {
        return value instanceof Integer || value instanceof Long;
    }

    private static int integer(Object value, String path, int min, int max) {
        if (!integral(value) || ((Number) value).longValue() < min || ((Number) value).longValue() > max) {
            throw invalid(path, "must be an integer within [" + min + ", " + max + "]");
        }
        return ((Number) value).intValue();
    }

    private static double number(Object value, String path, double min, double max) {
        if (!(value instanceof Number number) || !Double.isFinite(number.doubleValue())
                || number.doubleValue() < min || number.doubleValue() > max) {
            throw invalid(path, "must be a number within [" + min + ", " + max + "]");
        }
        return Math.round(number.doubleValue() * 1_000_000d) / 1_000_000d;
    }

    private static int colour(Object value, String path) {
        if (!(value instanceof String text) || !text.matches("#[0-9A-Fa-f]{6}")) {
            throw invalid(path, "must be a #RRGGBB colour");
        }
        return Integer.parseInt(text.substring(1), 16);
    }
}
