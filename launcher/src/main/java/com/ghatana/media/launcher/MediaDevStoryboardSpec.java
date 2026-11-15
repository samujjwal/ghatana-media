package com.ghatana.media.launcher;

import com.ghatana.media.launcher.MediaDevSpeechRuntime.SpeechRefusedException;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * DEV_ONLY storyboard contract ({@code media.dev.storyboard.v1}), owned by journey J-09 (brief to reviewed media).
 *
 * <p>A storyboard version is an immutable authored document: a brief, an output format, an ordered list of scenes and, per
 * scene, an ordered list of shots, plus optional per-scene narration and one optional caption file. Story time is not
 * authored as free timestamps: it is DERIVED, so no two shots can overlap and no gap can exist. Scenes play in array
 * order; the shots of a scene play in array order; a shot starts where the previous one ended. Every duration is a whole
 * number of milliseconds that is also a whole number of output frames (frame aligned), so every cut lands exactly on a
 * frame boundary and nothing is rounded.</p>
 *
 * <p>A shot's source is exactly one of: {@code ANIMATION} (a typed J-12 animation spec whose size, frame rate and frame
 * count are derived from the storyboard format and the shot duration and may not be authored), {@code ASSET} (an exact
 * stored video artifact version, optionally starting at {@code sourceInMs}) or {@code PLACEHOLDER} (an authored intent
 * that can never render). Every refusal names the JSON path of the offending value and is a typed 422.</p>
 */
final class MediaDevStoryboardSpec {
    static final String SCHEMA = "media.dev.storyboard.v1";
    static final int MAX_SCENES = 24;
    static final int MAX_SHOTS_PER_SCENE = 12;
    static final int MAX_SHOTS = 24;
    static final long MAX_SHOT_MS = 60_000;
    static final int MAX_TITLE = 200;
    static final int MAX_TEXT = 4_000;
    static final int MAX_NOTE = 500;
    static final int DEFAULT_WIDTH = 320, DEFAULT_HEIGHT = 240, DEFAULT_FPS = 25;
    private static final Pattern ID = Pattern.compile("[a-z0-9][a-z0-9-]{0,47}");
    private static final Pattern ARTIFACT_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}");
    private static final Pattern VERSION = Pattern.compile("sha256:[0-9a-f]{64}");
    private static final Set<String> DERIVED_ANIMATION_KEYS = Set.of("width", "height", "fps", "frameCount");

    enum Kind { ANIMATION, ASSET, PLACEHOLDER }

    /** An exact artifact version. */
    record Ref(String artifactId, String artifactVersionId) {
        Map<String, Object> view() {
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("artifactId", artifactId);
            view.put("artifactVersionId", artifactVersionId);
            return view;
        }
    }

    record Shot(String shotId, Kind kind, long durationMs, long startMs, Ref asset, long sourceInMs,
                Map<String, Object> animation, String note, String path) {
        long endMs() { return startMs + durationMs; }
    }

    record Scene(String sceneId, String title, Ref narration, List<Shot> shots, long startMs, long durationMs, String path) {
        long endMs() { return startMs + durationMs; }
    }

    record Storyboard(String title, String text, int width, int height, int fps, Ref captions, List<Scene> scenes) {
        long totalMs() { return scenes.isEmpty() ? 0 : scenes.getLast().endMs(); }
        int shotCount() { return scenes.stream().mapToInt(scene -> scene.shots().size()).sum(); }

        /** The authored document: deterministic key order, so identical content has identical bytes. */
        Map<String, Object> authored() {
            Map<String, Object> doc = new LinkedHashMap<>();
            Map<String, Object> brief = new LinkedHashMap<>();
            brief.put("title", title);
            brief.put("text", text);
            doc.put("brief", brief);
            Map<String, Object> format = new LinkedHashMap<>();
            format.put("width", width);
            format.put("height", height);
            format.put("fps", fps);
            doc.put("format", format);
            doc.put("captions", captions == null ? null : captions.view());
            List<Object> sceneViews = new ArrayList<>();
            for (Scene scene : scenes) {
                Map<String, Object> view = new LinkedHashMap<>();
                view.put("sceneId", scene.sceneId());
                view.put("title", scene.title());
                view.put("narration", scene.narration() == null ? null : scene.narration().view());
                List<Object> shotViews = new ArrayList<>();
                for (Shot shot : scene.shots()) {
                    Map<String, Object> shotView = new LinkedHashMap<>();
                    shotView.put("shotId", shot.shotId());
                    shotView.put("durationMs", shot.durationMs());
                    Map<String, Object> source = new LinkedHashMap<>();
                    source.put("kind", shot.kind().name());
                    switch (shot.kind()) {
                        case ANIMATION -> source.put("spec", shot.animation());
                        case ASSET -> {
                            source.putAll(shot.asset().view());
                            source.put("sourceInMs", shot.sourceInMs());
                        }
                        case PLACEHOLDER -> source.put("note", shot.note());
                    }
                    shotView.put("source", source);
                    shotViews.add(shotView);
                }
                view.put("shots", shotViews);
                sceneViews.add(view);
            }
            doc.put("scenes", sceneViews);
            return doc;
        }

        /** The derived story-time map: scene and shot boundaries in ms and output frames. */
        List<Object> timeline() {
            List<Object> out = new ArrayList<>();
            for (Scene scene : scenes) {
                Map<String, Object> view = new LinkedHashMap<>();
                view.put("sceneId", scene.sceneId());
                view.put("startMs", scene.startMs());
                view.put("endMs", scene.endMs());
                view.put("startFrame", scene.startMs() * fps / 1000);
                view.put("frames", scene.durationMs() * fps / 1000);
                List<Object> shots = new ArrayList<>();
                for (Shot shot : scene.shots()) {
                    Map<String, Object> shotView = new LinkedHashMap<>();
                    shotView.put("shotId", shot.shotId());
                    shotView.put("kind", shot.kind().name());
                    shotView.put("startMs", shot.startMs());
                    shotView.put("endMs", shot.endMs());
                    shotView.put("startFrame", shot.startMs() * fps / 1000);
                    shotView.put("frames", shot.durationMs() * fps / 1000);
                    shots.add(shotView);
                }
                view.put("shots", shots);
                out.add(view);
            }
            return out;
        }
    }

    private MediaDevStoryboardSpec() { }

    static SpeechRefusedException invalid(String path, String message) {
        return new SpeechRefusedException(422, "STORYBOARD_INVALID", message, Map.of("path", path));
    }

    private static SpeechRefusedException invalid(String code, String path, String message) {
        return new SpeechRefusedException(422, code, message, Map.of("path", path));
    }

    // ------------------------------------------------------------------ drafting from a brief

    /** Deterministic scaffold: one scene per brief paragraph, each with one PLACEHOLDER shot that cannot render yet. */
    static Map<String, Object> draftScenes(String briefText) {
        List<Object> scenes = new ArrayList<>();
        int index = 1;
        for (String paragraph : briefText.split("\\R+")) {
            String line = paragraph.strip();
            if (line.isEmpty()) continue;
            if (index > MAX_SCENES) break;
            Map<String, Object> shot = new LinkedHashMap<>();
            shot.put("shotId", "shot-" + index + "-1");
            shot.put("durationMs", 2000);
            Map<String, Object> source = new LinkedHashMap<>();
            source.put("kind", "PLACEHOLDER");
            source.put("note", line.length() > 200 ? line.substring(0, 200) : line);
            shot.put("source", source);
            Map<String, Object> scene = new LinkedHashMap<>();
            scene.put("sceneId", "scene-" + index);
            scene.put("title", line.length() > 60 ? line.substring(0, 60) : line);
            scene.put("shots", new ArrayList<>(List.of(shot)));
            scenes.add(scene);
            index++;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("scenes", scenes);
        return out;
    }

    // ------------------------------------------------------------------ parsing

    /** Strict parse of the authored fields: {@code brief}, {@code format}, {@code captions} and {@code scenes}. */
    static Storyboard parse(Map<String, Object> body) {
        keys(body, "$", Set.of("brief", "scenes"), Set.of("format", "captions"));
        Map<String, Object> brief = object(body.get("brief"), "$.brief");
        keys(brief, "$.brief", Set.of("title", "text"), Set.of());
        String title = text(brief.get("title"), "$.brief.title", 1, MAX_TITLE);
        String text = text(brief.get("text"), "$.brief.text", 1, MAX_TEXT);
        int width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, fps = DEFAULT_FPS;
        if (body.get("format") != null) {
            Map<String, Object> format = object(body.get("format"), "$.format");
            keys(format, "$.format", Set.of("width", "height", "fps"), Set.of());
            width = integer(format.get("width"), "$.format.width");
            height = integer(format.get("height"), "$.format.height");
            fps = integer(format.get("fps"), "$.format.fps");
        }
        if (width < 16 || height < 16 || width > 1280 || height > 720 || width % 2 != 0 || height % 2 != 0) {
            throw invalid("$.format", "width and height must be even and within 16x16 .. 1280x720");
        }
        if (fps < 1 || fps > 60) throw invalid("$.format.fps", "fps must be within [1, 60]");
        Ref captions = body.get("captions") == null ? null : ref(body.get("captions"), "$.captions");

        List<Object> rawScenes = list(body.get("scenes"), "$.scenes");
        if (rawScenes.isEmpty()) throw invalid("$.scenes", "a storyboard needs at least one scene");
        if (rawScenes.size() > MAX_SCENES) {
            throw invalid("STORYBOARD_LIMIT_EXCEEDED", "$.scenes", "at most " + MAX_SCENES + " scenes are supported");
        }
        Set<String> sceneIds = new HashSet<>();
        Set<String> shotIds = new HashSet<>();
        List<Scene> scenes = new ArrayList<>();
        long cursor = 0;
        int totalShots = 0;
        for (int i = 0; i < rawScenes.size(); i++) {
            String path = "$.scenes[" + i + "]";
            Map<String, Object> scene = object(rawScenes.get(i), path);
            keys(scene, path, Set.of("sceneId", "title", "shots"), Set.of("narration"));
            String sceneId = id(scene.get("sceneId"), path + ".sceneId");
            if (!sceneIds.add(sceneId)) throw invalid(path + ".sceneId", "scene ids must be unique");
            String sceneTitle = text(scene.get("title"), path + ".title", 1, MAX_TITLE);
            Ref narration = scene.get("narration") == null ? null : ref(scene.get("narration"), path + ".narration");
            List<Object> rawShots = list(scene.get("shots"), path + ".shots");
            if (rawShots.isEmpty()) throw invalid(path + ".shots", "a scene needs at least one shot");
            if (rawShots.size() > MAX_SHOTS_PER_SCENE) {
                throw invalid("STORYBOARD_LIMIT_EXCEEDED", path + ".shots",
                        "at most " + MAX_SHOTS_PER_SCENE + " shots per scene are supported");
            }
            long sceneStart = cursor;
            List<Shot> shots = new ArrayList<>();
            for (int j = 0; j < rawShots.size(); j++) {
                String shotPath = path + ".shots[" + j + "]";
                Shot shot = shot(rawShots.get(j), shotPath, cursor, width, height, fps);
                if (!shotIds.add(shot.shotId())) throw invalid(shotPath + ".shotId", "shot ids must be unique across the storyboard");
                if (++totalShots > MAX_SHOTS) {
                    throw invalid("STORYBOARD_LIMIT_EXCEEDED", shotPath, "at most " + MAX_SHOTS + " shots are supported");
                }
                shots.add(shot);
                cursor = shot.endMs();
            }
            scenes.add(new Scene(sceneId, sceneTitle, narration, List.copyOf(shots), sceneStart, cursor - sceneStart, path));
        }
        return new Storyboard(title, text, width, height, fps, captions, List.copyOf(scenes));
    }

    private static Shot shot(Object raw, String path, long start, int width, int height, int fps) {
        Map<String, Object> shot = object(raw, path);
        keys(shot, path, Set.of("shotId", "durationMs", "source"), Set.of());
        String shotId = id(shot.get("shotId"), path + ".shotId");
        int durationMs = integer(shot.get("durationMs"), path + ".durationMs");
        if (durationMs < 1 || durationMs > MAX_SHOT_MS) {
            throw invalid(path + ".durationMs", "durationMs must be within [1, " + MAX_SHOT_MS + "]");
        }
        if ((long) durationMs * fps % 1000 != 0) {
            throw invalid("DURATION_NOT_FRAME_ALIGNED", path + ".durationMs",
                    "durationMs must be a whole number of frames at " + fps + " fps (nothing is rounded)");
        }
        Map<String, Object> source = object(shot.get("source"), path + ".source");
        Object kindValue = source.get("kind");
        if (!(kindValue instanceof String kindName)) throw invalid(path + ".source.kind", "kind must be a string");
        Kind kind;
        try {
            kind = Kind.valueOf(kindName);
        } catch (IllegalArgumentException unknown) {
            throw invalid(path + ".source.kind", "kind must be ANIMATION, ASSET or PLACEHOLDER");
        }
        switch (kind) {
            case ANIMATION -> {
                keys(source, path + ".source", Set.of("kind", "spec"), Set.of());
                Map<String, Object> spec = object(source.get("spec"), path + ".source.spec");
                for (String derived : DERIVED_ANIMATION_KEYS) {
                    if (spec.containsKey(derived)) {
                        throw invalid(path + ".source.spec." + derived,
                                derived + " is derived from the storyboard format and the shot duration and cannot be authored");
                    }
                }
                Map<String, Object> full = animationSpec(spec, width, height, fps, durationMs);
                try {
                    MediaDevAnimationSpec.parse(full);
                } catch (MediaDevAnimationRuntime.AnimationRefusedException refused) {
                    Object inner = refused.details().get("path");
                    String suffix = inner instanceof String text && text.startsWith("$") ? text.substring(1) : "";
                    throw invalid(refused.code().equals("ANIMATION_BUDGET_EXCEEDED") ? "STORYBOARD_LIMIT_EXCEEDED"
                            : "STORYBOARD_INVALID", path + ".source.spec" + suffix, refused.getMessage());
                }
                return new Shot(shotId, kind, durationMs, start, null, 0, copy(spec), null, path);
            }
            case ASSET -> {
                keys(source, path + ".source", Set.of("kind", "artifactId", "artifactVersionId"), Set.of("sourceInMs"));
                Ref ref = ref(source, path + ".source");
                long in = 0;
                if (source.get("sourceInMs") != null) {
                    in = integer(source.get("sourceInMs"), path + ".source.sourceInMs");
                    if (in < 0 || (in * fps) % 1000 != 0) {
                        throw invalid("DURATION_NOT_FRAME_ALIGNED", path + ".source.sourceInMs",
                                "sourceInMs must be a non-negative whole number of frames at " + fps + " fps");
                    }
                }
                return new Shot(shotId, kind, durationMs, start, ref, in, null, null, path);
            }
            default -> {
                keys(source, path + ".source", Set.of("kind"), Set.of("note"));
                String note = source.get("note") == null ? "" : text(source.get("note"), path + ".source.note", 0, MAX_NOTE);
                return new Shot(shotId, kind, durationMs, start, null, 0, null, note, path);
            }
        }
    }

    /** The full J-12 spec of an authored animation shot: the format and the exact frame count are derived. */
    static Map<String, Object> animationSpec(Map<String, Object> authored, int width, int height, int fps, long durationMs) {
        Map<String, Object> full = new LinkedHashMap<>(authored);
        full.put("width", width);
        full.put("height", height);
        Map<String, Object> rate = new LinkedHashMap<>();
        rate.put("numerator", fps);
        rate.put("denominator", 1);
        full.put("fps", rate);
        full.put("frameCount", (int) (durationMs * fps / 1000));
        return full;
    }

    // ------------------------------------------------------------------ helpers

    private static Ref ref(Object raw, String path) {
        Map<String, Object> map = object(raw, path);
        if (!map.containsKey("kind")) keys(map, path, Set.of("artifactId", "artifactVersionId"), Set.of());
        Object artifactId = map.get("artifactId");
        Object version = map.get("artifactVersionId");
        if (!(artifactId instanceof String id) || !ARTIFACT_ID.matcher(id).matches()) {
            throw invalid(path + ".artifactId", "artifactId must be an opaque artifact id");
        }
        if (!(version instanceof String versionId) || !VERSION.matcher(versionId).matches()) {
            throw invalid(path + ".artifactVersionId", "artifactVersionId must be an exact sha256:<64 hex> version");
        }
        return new Ref(id, versionId);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> copy(Map<String, Object> value) {
        return (Map<String, Object>) deepCopy(value);
    }

    private static Object deepCopy(Object value) {
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) out.put(String.valueOf(entry.getKey()), deepCopy(entry.getValue()));
            return out;
        }
        if (value instanceof List<?> list) {
            List<Object> out = new ArrayList<>();
            for (Object item : list) out.add(deepCopy(item));
            return out;
        }
        return value;
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> object(Object value, String path) {
        if (!(value instanceof Map<?, ?> map)) throw invalid(path, "must be an object");
        for (Object key : map.keySet()) if (!(key instanceof String)) throw invalid(path, "has a non-string field name");
        return (Map<String, Object>) map;
    }

    @SuppressWarnings("unchecked")
    static List<Object> list(Object value, String path) {
        if (!(value instanceof List<?> list)) throw invalid(path, "must be an array");
        return (List<Object>) list;
    }

    private static void keys(Map<String, Object> value, String path, Set<String> required, Set<String> optional) {
        for (String key : required) {
            if (!value.containsKey(key)) throw invalid(path + "." + key, "is required");
        }
        for (String key : value.keySet()) {
            if (!required.contains(key) && !optional.contains(key)) throw invalid(path + "." + key, "is not a known field");
        }
    }

    private static int integer(Object value, String path) {
        if (!(value instanceof Integer || value instanceof Long || value instanceof Short)) {
            throw invalid(path, "must be an integer");
        }
        long number = ((Number) value).longValue();
        if (number < Integer.MIN_VALUE || number > Integer.MAX_VALUE) throw invalid(path, "is out of range");
        return (int) number;
    }

    private static String text(Object value, String path, int min, int max) {
        if (!(value instanceof String text)) throw invalid(path, "must be a string");
        String stripped = text.strip();
        if (stripped.length() < min || text.length() > max) {
            throw invalid(path, "must be " + (min == 0 ? "at most " + max : "between " + min + " and " + max) + " characters");
        }
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (Character.isISOControl(c) && c != '\n' && c != '\t' && c != '\r') {
                throw invalid(path, "must not contain control characters");
            }
        }
        return text;
    }

    private static String id(Object value, String path) {
        if (!(value instanceof String text) || !ID.matcher(text).matches()) {
            throw invalid(path, "must be 1-48 characters of lowercase letters, digits and hyphens");
        }
        return text;
    }
}
