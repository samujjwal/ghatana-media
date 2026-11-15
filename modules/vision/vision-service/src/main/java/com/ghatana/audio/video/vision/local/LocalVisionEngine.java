package com.ghatana.audio.video.vision.local;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Admission-gated local inference: Florence-2 (MIT) for caption / object detection / scene text, and
 * Qwen2.5-VL-7B-Instruct (Apache-2.0) for visual question answering. Every call first re-evaluates the
 * model's digest-bound {@link LocalModelAdmission}; a model that is not QUALIFIED is never dispatched
 * and the call fails with {@link NotAdmittedException}. Results are deterministic JSON-able maps
 * (no timestamps or latencies) bound to the exact input digest and the exact model identity, so an
 * identical request re-derives identical bytes.
 *
 * <p>Scene text is produced by Florence-2's own OCR task and is labelled as such; it is not the
 * Document Intelligence OCR gateway and makes no accuracy claim.
 *
 * @doc.type class
 * @doc.purpose Admission-gated Florence-2 and Qwen2.5-VL inference over the loopback sidecar
 * @doc.layer product
 * @doc.pattern Facade
 */
public final class LocalVisionEngine {

    public static final String FLORENCE_MODEL_ID = "florence-community/Florence-2-large";
    public static final String QWEN_MODEL_ID = "Qwen/Qwen2.5-VL-7B-Instruct";
    public static final String RESULT_SCHEMA = "media.vision.local-result.v1";
    public static final Set<String> FLORENCE_TASKS = Set.of("caption", "detect", "ocr");
    public static final int MAX_QUESTION_CHARS = 1000;
    /** Language pairs the text-only translation lane admits (owner decision 2026-11-15: English to Spanish). */
    public static final Set<String> TRANSLATION_PAIRS = Set.of("en>es");
    public static final int MAX_TRANSLATION_CHARS = 1000;
    private static final int MAX_IMAGE_BYTES = 32 * 1024 * 1024;

    /** The required model is not digest-qualified; nothing was dispatched. */
    public static final class NotAdmittedException extends RuntimeException {
        private final String modelId;
        private final String code;
        public NotAdmittedException(String modelId, String code) {
            super("local model is not admitted: " + modelId + " (" + code + ")");
            this.modelId = modelId;
            this.code = code;
        }
        public String modelId() { return modelId; }
        public String code() { return code; }
    }

    private final LocalVisionSidecarClient client;
    private final LocalModelAdmission florence;
    private final LocalModelAdmission qwen;
    private final LocalVisionRightsAuthority rights;

    public LocalVisionEngine(LocalVisionSidecarClient client, LocalModelAdmission florence,
                             LocalModelAdmission qwen, LocalVisionRightsAuthority rights) {
        this.client = Objects.requireNonNull(client, "client");
        this.florence = Objects.requireNonNull(florence, "florence");
        this.qwen = Objects.requireNonNull(qwen, "qwen");
        this.rights = Objects.requireNonNull(rights, "rights");
    }

    public LocalModelAdmission.Admission florenceAdmission() { return florence.evaluate(); }

    public LocalModelAdmission.Admission qwenAdmission() { return qwen.evaluate(); }

    public LocalVisionRightsAuthority rights() { return rights; }

    /**
     * Loads the models in the sidecar ahead of the first real request: verifies each model's digest manifest (filling the
     * shared digest cache), then runs one tiny generated image through Florence-2 and, when {@code includeQwen}, one
     * question through Qwen2.5-VL. The outputs are discarded and are never evidence. A model that is not admitted is
     * skipped, never dispatched. The future completes with the elapsed milliseconds, or -1 when nothing could be
     * warmed (no admitted model or the sidecar failed); it never completes exceptionally.
     */
    public java.util.concurrent.CompletableFuture<Long> warmUp(boolean includeQwen) {
        return java.util.concurrent.CompletableFuture.supplyAsync(() -> {
            long started = System.nanoTime();
            boolean warmed = false;
            try {
                byte[] png = warmUpImage();
                String sha = java.util.HexFormat.of().formatHex(
                        java.security.MessageDigest.getInstance("SHA-256").digest(png));
                if (florence.evaluate().qualified()) {
                    analyze(png, sha, Set.of("caption"));
                    warmed = true;
                }
                if (includeQwen && qwen.evaluate().qualified()) {
                    ask(png, sha, "What is in this image?");
                    warmed = true;
                }
            } catch (Exception | LinkageError failure) {
                return -1L;
            }
            return warmed ? java.time.Duration.ofNanos(System.nanoTime() - started).toMillis() : -1L;
        }, task -> {
            Thread thread = new Thread(task, "media-vision-warmup");
            thread.setDaemon(true);
            thread.start();
        });
    }

    private static byte[] warmUpImage() throws java.io.IOException {
        java.awt.image.BufferedImage image = new java.awt.image.BufferedImage(96, 96,
                java.awt.image.BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < 96; y++) for (int x = 0; x < 96; x++) image.setRGB(x, y, (x / 12 + y / 12) % 2 == 0 ? 0xDDDDDD : 0x335577);
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        javax.imageio.ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    public boolean sidecarHealthy() { return client.healthy(); }

    /** One bounded sidecar health probe with reachability class, latency and the sidecar's own report. */
    public LocalVisionSidecarClient.Health sidecarHealth(java.time.Duration timeout) { return client.health(timeout); }

    /** Florence-2 caption, detection and scene-text in one bound result. */
    public Map<String, Object> analyze(byte[] image, String imageSha256, Set<String> tasks) {
        requireImage(image);
        if (tasks == null || tasks.isEmpty() || !FLORENCE_TASKS.containsAll(tasks)) {
            throw new IllegalArgumentException("tasks must be a non-empty subset of " + FLORENCE_TASKS);
        }
        LocalModelAdmission.Admission admission = florence.evaluate();
        if (!admission.qualified()) throw new NotAdmittedException(FLORENCE_MODEL_ID, admission.reasonCode());
        List<String> ordered = new ArrayList<>();
        for (String task : List.of("caption", "detect", "ocr")) if (tasks.contains(task)) ordered.add(task);
        LocalVisionSidecarClient.AnalyzeResponse response = client.analyze(image, ordered, 256);
        Map<String, Object> out = base("IMAGE_ANALYSIS", admission, imageSha256, response.width(), response.height());
        Map<String, Object> results = new LinkedHashMap<>();
        if (ordered.contains("caption")) {
            results.put("caption", clean(String.valueOf(response.results().get("caption"))));
        }
        if (ordered.contains("detect")) {
            results.put("objects", detections(response.results().get("detect")));
        }
        if (ordered.contains("ocr")) {
            results.put("sceneText", sceneText(response.results().get("ocr")));
        }
        out.put("results", results);
        return out;
    }

    /** Qwen2.5-VL answer to one question about one image. */
    public Map<String, Object> ask(byte[] image, String imageSha256, String question) {
        requireImage(image);
        if (question == null || question.isBlank() || question.length() > MAX_QUESTION_CHARS
                || question.chars().anyMatch(c -> c < 0x20 && c != '\n' && c != '\t')) {
            throw new IllegalArgumentException("question must be 1-" + MAX_QUESTION_CHARS + " printable characters");
        }
        LocalModelAdmission.Admission admission = qwen.evaluate();
        if (!admission.qualified()) throw new NotAdmittedException(QWEN_MODEL_ID, admission.reasonCode());
        LocalVisionSidecarClient.AskResponse response = client.ask(image, question, 256);
        Map<String, Object> out = base("IMAGE_QUESTION", admission, imageSha256, response.width(), response.height());
        out.put("question", question);
        out.put("answer", clean(response.answer()));
        return out;
    }

    /**
     * Qwen2.5-VL-7B-Instruct text-only machine translation of one text. No image is involved. The result carries the
     * exact digest-qualified model identity; it makes no quality claim.
     */
    public Map<String, Object> translate(String text, String sourceLanguage, String targetLanguage) {
        if (text == null || text.isBlank() || text.length() > MAX_TRANSLATION_CHARS
                || text.chars().anyMatch(c -> c < 0x20 && c != '\n' && c != '\t')) {
            throw new IllegalArgumentException("text must be 1-" + MAX_TRANSLATION_CHARS + " printable characters");
        }
        if (!TRANSLATION_PAIRS.contains(sourceLanguage + ">" + targetLanguage)) {
            throw new IllegalArgumentException("language pair is not admitted");
        }
        LocalModelAdmission.Admission admission = qwen.evaluate();
        if (!admission.qualified()) throw new NotAdmittedException(QWEN_MODEL_ID, admission.reasonCode());
        String translation = clean(client.translate(text, sourceLanguage, targetLanguage, 256).translation());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("schema", RESULT_SCHEMA);
        out.put("kind", "TEXT_TRANSLATION");
        com.ghatana.media.runtime.localmodel.LocalModelManifest m = admission.manifest();
        Map<String, Object> model = new LinkedHashMap<>();
        model.put("id", m.modelId());
        model.put("revision", m.source().revision());
        model.put("spdxLicense", m.license().spdx());
        model.put("fileSetSha256", m.fileSetSha256());
        model.put("runtime", m.runtime().name() + "/" + m.runtime().version());
        out.put("model", model);
        out.put("sourceLanguage", sourceLanguage);
        out.put("targetLanguage", targetLanguage);
        out.put("translation", translation);
        return out;
    }

    private static Map<String, Object> base(String kind, LocalModelAdmission.Admission admission, String sha,
                                            int width, int height) {
        com.ghatana.media.runtime.localmodel.LocalModelManifest m = admission.manifest();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("schema", RESULT_SCHEMA);
        out.put("kind", kind);
        Map<String, Object> model = new LinkedHashMap<>();
        model.put("id", m.modelId());
        model.put("revision", m.source().revision());
        model.put("spdxLicense", m.license().spdx());
        model.put("fileSetSha256", m.fileSetSha256());
        model.put("runtime", m.runtime().name() + "/" + m.runtime().version());
        out.put("model", model);
        Map<String, Object> input = new LinkedHashMap<>();
        input.put("sha256", sha);
        input.put("width", width);
        input.put("height", height);
        out.put("input", input);
        // Insertion-ordered maps only: the registered JSON bytes must be identical across JVM runs.
        Map<String, Object> claims = new LinkedHashMap<>();
        claims.put("quality", "NONE");
        claims.put("note", "Local open-model output; no accuracy, rights or production claim.");
        out.put("claims", claims);
        return out;
    }

    static boolean looksLikeImage(byte[] b) {
        if (b == null || b.length < 12) return false;
        boolean png = (b[0] & 0xFF) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G';
        boolean jpeg = (b[0] & 0xFF) == 0xFF && (b[1] & 0xFF) == 0xD8 && (b[2] & 0xFF) == 0xFF;
        boolean gif = b[0] == 'G' && b[1] == 'I' && b[2] == 'F' && b[3] == '8';
        boolean webp = b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E'
                && b[10] == 'B' && b[11] == 'P';
        boolean bmp = b[0] == 'B' && b[1] == 'M';
        return png || jpeg || gif || webp || bmp;
    }

    private static void requireImage(byte[] image) {
        if (image == null || image.length == 0 || image.length > MAX_IMAGE_BYTES || !looksLikeImage(image)) {
            throw new IllegalArgumentException("source is not a supported image (png, jpeg, gif, webp, bmp)");
        }
    }

    private static String clean(String text) {
        return text.replace("</s>", "").replace("<s>", "").replace("<pad>", "").strip();
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> detections(Object raw) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (!(raw instanceof Map<?, ?> map)) return out;
        List<Object> boxes = (List<Object>) map.get("bboxes");
        List<Object> labels = (List<Object>) map.get("labels");
        if (boxes == null || labels == null) return out;
        for (int i = 0; i < Math.min(Math.min(boxes.size(), labels.size()), 200); i++) {
            List<Object> b = (List<Object>) boxes.get(i);
            double x1 = ((Number) b.get(0)).doubleValue(), y1 = ((Number) b.get(1)).doubleValue();
            double x2 = ((Number) b.get(2)).doubleValue(), y2 = ((Number) b.get(3)).doubleValue();
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("label", clean(String.valueOf(labels.get(i))));
            Map<String, Object> box = new LinkedHashMap<>();
            box.put("x", round(x1));
            box.put("y", round(y1));
            box.put("width", round(x2 - x1));
            box.put("height", round(y2 - y1));
            entry.put("boundingBox", box);
            out.add(entry);
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> sceneText(Object raw) {
        List<Map<String, Object>> regions = new ArrayList<>();
        Set<String> words = new LinkedHashSet<>();
        if (raw instanceof Map<?, ?> map && map.get("quad_boxes") instanceof List<?> quads
                && map.get("labels") instanceof List<?> labels) {
            for (int i = 0; i < Math.min(Math.min(quads.size(), labels.size()), 500); i++) {
                String text = clean(String.valueOf(labels.get(i)));
                if (text.isBlank()) continue;
                List<Double> quad = new ArrayList<>();
                for (Object n : (List<Object>) quads.get(i)) quad.add(round(((Number) n).doubleValue()));
                Map<String, Object> region = new LinkedHashMap<>();
                region.put("text", text);
                region.put("quad", quad);
                regions.add(region);
                words.add(text);
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("engine", "Florence-2 <OCR_WITH_REGION>");
        out.put("regions", regions);
        out.put("fullText", String.join(" ", words));
        return out;
    }

    private static double round(double v) { return Math.round(v * 10.0) / 10.0; }
}
