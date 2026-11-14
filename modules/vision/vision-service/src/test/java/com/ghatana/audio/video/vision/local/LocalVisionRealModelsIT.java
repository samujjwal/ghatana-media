package com.ghatana.audio.video.vision.local;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Runs the real Florence-2 and Qwen2.5-VL-7B-Instruct models on this machine through the real loopback sidecar
 * over a Java2D-rendered image (text plus a red square and a blue circle). Skipped with an explicit reason
 * only when the runtime, models or manifests are absent. This proves the code path and that the licensed,
 * digest-qualified models answer; it makes no accuracy or quality claim.
 */
class LocalVisionRealModelsIT {

    private static LocalVisionSidecarProcess sidecar;
    private static LocalVisionEngine engine;
    private static String skipReason;

    @BeforeAll
    static void start() throws Exception {
        Path home = Path.of(System.getProperty("user.home"));
        Path models = Path.of(System.getenv().getOrDefault("MEDIA_LOCAL_VISION_MODELS_ROOT",
                home.resolve(".local/share/ghatana-media/models").toString()));
        Path python = Path.of(System.getenv().getOrDefault("MEDIA_LOCAL_VISION_PYTHON",
                home.resolve(".local/share/ghatana-media/runtimes/vision-venv/bin/python").toString()));
        Path script = locateScript();
        if (script == null) skipReason = "tools/model-runtimes/vision/vision_sidecar.py not found";
        else if (!Files.isExecutable(python)) skipReason = "sidecar python runtime absent: " + python;
        else if (!Files.isRegularFile(models.resolve("florence-2-large/ghatana-model-manifest.json"))
                || !Files.isRegularFile(models.resolve("qwen2.5-vl-7b-instruct/ghatana-model-manifest.json"))) {
            skipReason = "model directories with manifests absent under " + models;
        }
        if (skipReason != null) return;
        sidecar = LocalVisionSidecarProcess.start(python, script, models, Duration.ofSeconds(90));
        engine = new LocalVisionEngine(sidecar.client(Duration.ofMinutes(8)),
                new LocalModelAdmission(models.resolve("florence-2-large"), LocalVisionEngine.FLORENCE_MODEL_ID,
                        "VISION", "MIT"),
                new LocalModelAdmission(models.resolve("qwen2.5-vl-7b-instruct"), LocalVisionEngine.QWEN_MODEL_ID,
                        "MULTIMODAL_QA", "Apache-2.0"),
                LocalVisionRightsAuthority.unavailable());
    }

    @AfterAll
    static void stop() {
        if (sidecar != null) sidecar.close();
    }

    static Path locateScript() {
        for (Path dir = Path.of("").toAbsolutePath(); dir != null; dir = dir.getParent()) {
            Path candidate = dir.resolve("tools/model-runtimes/vision/vision_sidecar.py");
            if (Files.isRegularFile(candidate)) return candidate;
        }
        return null;
    }

    @Test
    void realModelsAreDigestQualifiedWithTheOwnerSelectedLicences() {
        assumeTrue(skipReason == null, () -> "SKIPPED: " + skipReason);
        var florence = engine.florenceAdmission();
        var qwen = engine.qwenAdmission();
        assertThat(florence.qualified()).as(florence.reasonCode()).isTrue();
        assertThat(qwen.qualified()).as(qwen.reasonCode()).isTrue();
        assertThat(florence.manifest().spdxLicense()).isEqualTo("MIT");
        assertThat(qwen.manifest().spdxLicense()).isEqualTo("Apache-2.0");
    }

    @Test
    void florenceReadsTheTextAndSeesTheScene() throws Exception {
        assumeTrue(skipReason == null, () -> "SKIPPED: " + skipReason);
        byte[] png = LocalVisionTestFixtures.testImagePng();
        Map<String, Object> out = engine.analyze(png, LocalVisionTestFixtures.sha256(png),
                Set.of("caption", "detect", "ocr"));
        System.out.println("FLORENCE-REAL-OUTPUT " + out.get("results"));
        @SuppressWarnings("unchecked") var results = (Map<String, Object>) out.get("results");
        @SuppressWarnings("unchecked") var text = (Map<String, Object>) results.get("sceneText");
        assertThat(((String) text.get("fullText")).toUpperCase()).contains("GHATANA");
        assertThat(((String) results.get("caption")).toLowerCase()).containsAnyOf("red", "blue", "circle", "square");
        assertThat((List<?>) results.get("objects")).isNotNull();
    }

    @Test
    void qwenAnswersQuestionsAboutTheImage() throws Exception {
        assumeTrue(skipReason == null, () -> "SKIPPED: " + skipReason);
        byte[] png = LocalVisionTestFixtures.testImagePng();
        Map<String, Object> color = engine.ask(png, LocalVisionTestFixtures.sha256(png),
                "What color is the square on the left side of the image?");
        System.out.println("QWEN-REAL-OUTPUT " + color.get("answer"));
        assertThat(((String) color.get("answer")).toLowerCase()).contains("red");
        Map<String, Object> text = engine.ask(png, LocalVisionTestFixtures.sha256(png),
                "What words are written at the top of the image?");
        System.out.println("QWEN-REAL-OUTPUT " + text.get("answer"));
        assertThat(((String) text.get("answer")).toUpperCase()).contains("GHATANA");
    }

    @Test
    void identicalRequestsReDeriveIdenticalResultsSoReplayIsIdempotent() throws Exception {
        assumeTrue(skipReason == null, () -> "SKIPPED: " + skipReason);
        byte[] png = LocalVisionTestFixtures.testImagePng();
        String sha = LocalVisionTestFixtures.sha256(png);
        assertThat(engine.analyze(png, sha, Set.of("caption", "ocr"))).isEqualTo(engine.analyze(png, sha, Set.of("caption", "ocr")));
        assertThat(engine.ask(png, sha, "How many shapes are there?")).isEqualTo(engine.ask(png, sha, "How many shapes are there?"));
    }
}
