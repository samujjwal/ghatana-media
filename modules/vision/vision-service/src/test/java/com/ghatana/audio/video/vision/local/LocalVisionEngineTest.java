package com.ghatana.audio.video.vision.local;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.net.URI;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Engine behaviour against a FIXTURE_ONLY loopback sidecar: normalisation, gating and refusal paths. */
class LocalVisionEngineTest {

    private static final String ANALYZE_RESPONSE = "{\"results\":{\"caption\":\"</s><s>A red square.</s>\","
            + "\"detect\":{\"bboxes\":[[10.04,20,110.06,220]],\"labels\":[\"box\"]},"
            + "\"ocr\":{\"quad_boxes\":[[1,2,3,2,3,4,1,4]],\"labels\":[\"HELLO\"]}},"
            + "\"imageSize\":{\"width\":640,\"height\":480}}";

    @TempDir Path temp;

    private LocalVisionEngine engine(LocalVisionTestFixtures.FakeSidecar sidecar, boolean qwenPresent) throws Exception {
        Path florence = LocalVisionTestFixtures.modelDir(temp, "f", LocalVisionEngine.FLORENCE_MODEL_ID, "VISION", "MIT");
        Path qwen = qwenPresent
                ? LocalVisionTestFixtures.modelDir(temp, "q", LocalVisionEngine.QWEN_MODEL_ID, "MULTIMODAL_QA", "Apache-2.0")
                : temp.resolve("q-absent");
        return new LocalVisionEngine(sidecar.client(), LocalVisionTestFixtures.florence(florence),
                LocalVisionTestFixtures.qwen(qwen), LocalVisionRightsAuthority.unavailable());
    }

    @Test
    void analyzeNormalisesFlorenceOutputAndBindsModelAndInput() throws Exception {
        try (var sidecar = new LocalVisionTestFixtures.FakeSidecar((path, body) -> ANALYZE_RESPONSE)) {
            byte[] png = LocalVisionTestFixtures.testImagePng();
            var out = engine(sidecar, true).analyze(png, LocalVisionTestFixtures.sha256(png),
                    Set.of("caption", "detect", "ocr"));
            assertThat(out).containsEntry("schema", LocalVisionEngine.RESULT_SCHEMA).containsEntry("kind", "IMAGE_ANALYSIS");
            @SuppressWarnings("unchecked") var model = (Map<String, Object>) out.get("model");
            assertThat(model).containsEntry("id", LocalVisionEngine.FLORENCE_MODEL_ID).containsEntry("spdxLicense", "MIT");
            @SuppressWarnings("unchecked") var results = (Map<String, Object>) out.get("results");
            assertThat(results.get("caption")).isEqualTo("A red square.");
            @SuppressWarnings("unchecked") var objects = (List<Map<String, Object>>) results.get("objects");
            assertThat(objects).hasSize(1);
            assertThat(objects.get(0)).containsEntry("label", "box");
            assertThat(objects.get(0).get("boundingBox")).isEqualTo(Map.of("x", 10.0, "y", 20.0, "width", 100.0, "height", 200.0));
            @SuppressWarnings("unchecked") var text = (Map<String, Object>) results.get("sceneText");
            assertThat(text).containsEntry("fullText", "HELLO");
            assertThat(out.toString()).doesNotContain("</s>");
        }
    }

    @Test
    void modelThatIsNotQualifiedIsNeverDispatched() throws Exception {
        try (var sidecar = new LocalVisionTestFixtures.FakeSidecar((path, body) -> "{\"answer\":\"x\",\"imageSize\":{}}")) {
            byte[] png = LocalVisionTestFixtures.testImagePng();
            var engine = engine(sidecar, false);
            assertThatThrownBy(() -> engine.ask(png, "0".repeat(64), "What is this?"))
                    .isInstanceOfSatisfying(LocalVisionEngine.NotAdmittedException.class, refusal -> {
                        assertThat(refusal.modelId()).isEqualTo(LocalVisionEngine.QWEN_MODEL_ID);
                        assertThat(refusal.code()).isEqualTo(LocalModelAdmission.NOT_ADMITTED_MANIFEST_MISSING);
                    });
            assertThat(sidecar.inferenceCalls.get()).isZero();
        }
    }

    @Test
    void invalidInputsAreRejectedBeforeTheSidecar() throws Exception {
        try (var sidecar = new LocalVisionTestFixtures.FakeSidecar((path, body) -> ANALYZE_RESPONSE)) {
            var engine = engine(sidecar, true);
            byte[] png = LocalVisionTestFixtures.testImagePng();
            assertThatThrownBy(() -> engine.analyze("not an image at all".getBytes(), "0".repeat(64), Set.of("caption")))
                    .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> engine.analyze(png, "0".repeat(64), Set.of("segment")))
                    .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> engine.ask(png, "0".repeat(64), " "))
                    .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> engine.ask(png, "0".repeat(64), "x".repeat(LocalVisionEngine.MAX_QUESTION_CHARS + 1)))
                    .isInstanceOf(IllegalArgumentException.class);
            assertThat(sidecar.inferenceCalls.get()).isZero();
        }
    }

    @Test
    void sidecarDefiniteRejectionAndOutageAreTypedDifferently() throws Exception {
        byte[] png = LocalVisionTestFixtures.testImagePng();
        LocalVisionEngine rejecting;
        try (var sidecar = new LocalVisionTestFixtures.FakeSidecar(
                (path, body) -> "HTTP400 {\"error\":\"INVALID_REQUEST\"}")) {
            rejecting = engine(sidecar, true);
            assertThatThrownBy(() -> rejecting.analyze(png, "0".repeat(64), Set.of("caption")))
                    .isInstanceOfSatisfying(LocalVisionSidecarClient.SidecarRejectedException.class,
                            e -> assertThat(e.code()).isEqualTo("INVALID_REQUEST"));
        }
        // Server is now stopped: the effect is unprovable, which is a different, ambiguous failure type.
        assertThatThrownBy(() -> rejecting.analyze(png, "0".repeat(64), Set.of("caption")))
                .isInstanceOf(LocalVisionSidecarClient.SidecarUnavailableException.class);
    }

    @Test
    void clientRefusesNonLoopbackAndWeakTokens() {
        for (String url : List.of("http://example.com:8080", "http://192.168.1.10:8080", "https://127.0.0.1:8080",
                "http://10.0.0.1")) {
            assertThatThrownBy(() -> new LocalVisionSidecarClient(URI.create(url), LocalVisionTestFixtures.FIXTURE_TOKEN,
                    Duration.ofSeconds(1))).as(url).isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> new LocalVisionSidecarClient(URI.create("http://127.0.0.1:1"), "short", Duration.ofSeconds(1)))
                .isInstanceOf(IllegalArgumentException.class);
        new LocalVisionSidecarClient(URI.create("http://127.0.0.1:1"), LocalVisionTestFixtures.FIXTURE_TOKEN, Duration.ofSeconds(1));
        new LocalVisionSidecarClient(URI.create("http://localhost:1"), LocalVisionTestFixtures.FIXTURE_TOKEN, Duration.ofSeconds(1));
    }

    @Test
    void wrongBearerTokenIsRefusedBySidecarAndNeverReportsHealthy() throws Exception {
        try (var sidecar = new LocalVisionTestFixtures.FakeSidecar((path, body) -> ANALYZE_RESPONSE)) {
            var wrong = new LocalVisionSidecarClient(URI.create("http://127.0.0.1:" + sidecar.server.getAddress().getPort()),
                    "a-different-token-0123456789abcdef", Duration.ofSeconds(2));
            assertThat(wrong.healthy()).isFalse();
            assertThat(sidecar.client().healthy()).isTrue();
        }
    }
}
