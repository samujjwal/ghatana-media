package com.ghatana.media.launcher;

import com.ghatana.audio.video.vision.local.LocalModelAdmission;
import com.ghatana.audio.video.vision.local.LocalOpenModelVisionProvider;
import com.ghatana.audio.video.vision.local.LocalVisionEngine;
import com.ghatana.audio.video.vision.local.LocalVisionRightsAuthority;
import com.ghatana.audio.video.vision.local.LocalVisionSidecarClient;
import com.ghatana.audio.video.vision.local.LocalVisionSidecarProcess;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Reason;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * DEV_ONLY local vision lane through the real HTTP host: Florence-2 analysis and Qwen2.5-VL questions over an
 * exact immutable image (or a video frame) version, registered as a lineage-bound JSON artifact. Runs the real
 * models on this machine; skipped with an explicit reason only when the sidecar runtime or models are absent.
 */
class MediaDevVisionHttpTest {
    private static final String TENANT = "tenant-local";
    private static final String PRINCIPAL = "principal-local";
    private static final String OTHER = "principal-other";
    private static final String SECRET = "test-only-dev-project-secret-at-least-32-bytes";
    private static final java.time.Clock CLOCK =
            java.time.Clock.fixed(Instant.parse("2026-11-13T20:00:00Z"), java.time.ZoneOffset.UTC);
    private static final Set<String> ALL = Set.of("media:project:dev:read", "media:project:dev:write",
            "media:artifact:read", "media:artifact:create");
    private static final ObjectMapper JSON = JsonMapper.builder().build();

    private static LocalVisionSidecarProcess sidecar;
    private static LocalVisionEngine engine;
    private static String skipReason;

    @BeforeAll
    static void startRealModels() throws Exception {
        Path home = Path.of(System.getProperty("user.home"));
        Path models = Path.of(System.getenv().getOrDefault("MEDIA_LOCAL_VISION_MODELS_ROOT",
                home.resolve(".local/share/ghatana-media/models").toString()));
        Path python = Path.of(System.getenv().getOrDefault("MEDIA_LOCAL_VISION_PYTHON",
                home.resolve(".local/share/ghatana-media/runtimes/vision-venv/bin/python").toString()));
        Path script = null;
        for (Path dir = Path.of("").toAbsolutePath(); dir != null && script == null; dir = dir.getParent()) {
            Path candidate = dir.resolve("tools/model-runtimes/vision/vision_sidecar.py");
            if (Files.isRegularFile(candidate)) script = candidate;
        }
        if (script == null) skipReason = "vision_sidecar.py not found";
        else if (!Files.isExecutable(python)) skipReason = "sidecar python runtime absent: " + python;
        else if (!Files.isRegularFile(models.resolve("florence-2-large/ghatana-model-manifest.json"))
                || !Files.isRegularFile(models.resolve("qwen2.5-vl-7b-instruct/ghatana-model-manifest.json"))) {
            skipReason = "model manifests absent under " + models;
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

    @Test
    void analyzeImageRegistersLineageBoundJsonArtifactAndReplaysIdempotently() throws Exception {
        assumeTrue(skipReason == null, () -> "SKIPPED: " + skipReason);
        Path root = Files.createTempDirectory("media-dev-vision-");
        MediaRuntime runtime = runtime(root);
        HttpServer server = server(runtime, null);
        try {
            byte[] png = testImage();
            MediaArtifact source = upload(runtime, "scene.png", "image/png", png);

            Map<String, Object> body = Map.of("requestId", "analysis-1", "artifactId", source.artifactId(),
                    "artifactVersionId", source.version().value(), "tasks", List.of("caption", "detect", "ocr"));
            HttpResponse<byte[]> created = post(server, "/dev/v1/vision/analyses", PRINCIPAL, ALL, body);
            assertThat(created.statusCode()).as(new String(created.body())).isEqualTo(201);
            Map<String, Object> view = map(created);
            assertThat(view).containsEntry("scope", "DEV_ONLY").containsEntry("replayed", false);
            @SuppressWarnings("unchecked") var artifactView = (Map<String, Object>) view.get("artifact");
            assertThat(artifactView).containsEntry("contentType", "application/json");
            @SuppressWarnings("unchecked") var lineage = (Map<String, Object>) view.get("lineage");
            @SuppressWarnings("unchecked") var src = (Map<String, Object>) lineage.get("source");
            assertThat(src).containsEntry("artifactId", source.artifactId())
                    .containsEntry("artifactVersionId", source.version().value())
                    .containsEntry("sha256", source.sha256());
            @SuppressWarnings("unchecked") var rightsDecision = (Map<String, Object>) lineage.get("rightsDecision");
            assertThat(rightsDecision).containsEntry("kind", "RIGHTS_CONSENT_ATTESTATION")
                    .containsEntry("scope", "PROCESSING").containsEntry("verdict", "ADMITTED")
                    .containsEntry("productionGrant", false);
            assertThat(map(created).get("admission").toString()).contains("fixture-attestation-1");

            // The registered artifact's own bytes hold the structured result.
            MediaArtifact output = runtime.artifact(TENANT, PRINCIPAL, (String) view.get("outputId")).orElseThrow();
            ByteArrayOutputStream content = new ByteArrayOutputStream();
            runtime.copyArtifactContent(TENANT, PRINCIPAL, output.artifactId(), output.version(), content, 1 << 20)
                    .orElseThrow();
            Map<String, Object> document = JSON.readValue(content.toByteArray(), new TypeReference<>() { });
            System.out.println("DEV-VISION-ANALYSIS-ARTIFACT " + new String(content.toByteArray(), StandardCharsets.UTF_8));
            @SuppressWarnings("unchecked") var inference = (Map<String, Object>) document.get("inference");
            @SuppressWarnings("unchecked") var results = (Map<String, Object>) inference.get("results");
            @SuppressWarnings("unchecked") var sceneText = (Map<String, Object>) results.get("sceneText");
            assertThat(((String) sceneText.get("fullText")).toUpperCase()).contains("GHATANA");
            assertThat(HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                    .digest(content.toByteArray()))).isEqualTo(output.sha256());

            // Replay with the same requestId re-derives identical bytes: 200, replayed, same artifact.
            HttpResponse<byte[]> replay = post(server, "/dev/v1/vision/analyses", PRINCIPAL, ALL, body);
            assertThat(replay.statusCode()).as(new String(replay.body())).isEqualTo(200);
            assertThat(map(replay)).containsEntry("replayed", true).containsEntry("outputId", view.get("outputId"));

            // Reopen by id for the owner; foreign owners see nothing.
            HttpResponse<byte[]> reopened = get(server, "/dev/v1/vision/outputs/" + view.get("outputId"), PRINCIPAL, ALL);
            assertThat(reopened.statusCode()).isEqualTo(200);
            assertThat(get(server, "/dev/v1/vision/outputs/" + view.get("outputId"), OTHER, ALL).statusCode()).isEqualTo(404);

            // Reusing the requestId for a different request is refused.
            Map<String, Object> different = Map.of("requestId", "analysis-1", "artifactId", source.artifactId(),
                    "artifactVersionId", source.version().value(), "tasks", List.of("caption"));
            assertThat(post(server, "/dev/v1/vision/analyses", PRINCIPAL, ALL, different).statusCode()).isEqualTo(409);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void questionsAboutImageAndVideoFrameAreAnsweredByQwenWithExactLineage() throws Exception {
        assumeTrue(skipReason == null, () -> "SKIPPED: " + skipReason);
        String ffmpeg = System.getenv("MEDIA_DEV_RENDER_FFMPEG");
        Path root = Files.createTempDirectory("media-dev-vision-q-");
        MediaRuntime runtime = runtime(root);
        LocalOpenModelVisionProvider.FrameExtractor frames = ffmpeg == null || ffmpeg.isBlank() ? null
                : new MediaDevFfmpegFrameExtractor(Path.of(ffmpeg), Duration.ofSeconds(60));
        HttpServer server = server(runtime, frames);
        try {
            byte[] png = testImage();
            MediaArtifact source = upload(runtime, "scene2.png", "image/png", png);
            HttpResponse<byte[]> answered = post(server, "/dev/v1/vision/questions", PRINCIPAL, ALL, Map.of(
                    "requestId", "question-1", "artifactId", source.artifactId(),
                    "artifactVersionId", source.version().value(),
                    "question", "What color is the circle on the right side of the image?"));
            assertThat(answered.statusCode()).as(new String(answered.body())).isEqualTo(201);
            String id = (String) map(answered).get("outputId");
            MediaArtifact output = runtime.artifact(TENANT, PRINCIPAL, id).orElseThrow();
            ByteArrayOutputStream content = new ByteArrayOutputStream();
            runtime.copyArtifactContent(TENANT, PRINCIPAL, id, output.version(), content, 1 << 20).orElseThrow();
            System.out.println("DEV-VISION-QUESTION-ARTIFACT " + new String(content.toByteArray(), StandardCharsets.UTF_8));
            @SuppressWarnings("unchecked") var inference = (Map<String, Object>) JSON.readValue(content.toByteArray(),
                    new TypeReference<Map<String, Object>>() { }).get("inference");
            assertThat(((String) inference.get("answer")).toLowerCase()).contains("blue");

            assumeTrue(frames != null, "SKIPPED video part: MEDIA_DEV_RENDER_FFMPEG not configured");
            Path pngFile = root.resolve("frame.png");
            Files.write(pngFile, png);
            Path mp4 = root.resolve("clip.mp4");
            Process process = new ProcessBuilder(ffmpeg, "-nostdin", "-v", "error", "-loop", "1", "-i", pngFile.toString(),
                    "-t", "2", "-r", "10", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-y", mp4.toString())
                    .redirectErrorStream(true).start();
            process.getInputStream().readAllBytes();
            assumeTrue(process.waitFor() == 0 && Files.size(mp4) > 0, "SKIPPED video part: ffmpeg could not encode");
            MediaArtifact video = upload(runtime, "clip.mp4", "video/mp4", Files.readAllBytes(mp4));
            HttpResponse<byte[]> frameAnswer = post(server, "/dev/v1/vision/questions", PRINCIPAL, ALL, Map.of(
                    "requestId", "question-video-1", "artifactId", video.artifactId(),
                    "artifactVersionId", video.version().value(), "frameTimeMs", 1000,
                    "question", "What color is the square?"));
            assertThat(frameAnswer.statusCode()).as(new String(frameAnswer.body())).isEqualTo(201);
            @SuppressWarnings("unchecked") var lineage = (Map<String, Object>) map(frameAnswer).get("lineage");
            @SuppressWarnings("unchecked") var frame = (Map<String, Object>) lineage.get("frame");
            assertThat(frame).containsEntry("timeMillis", 1000);
            assertThat((String) frame.get("frameSha256")).matches("[0-9a-f]{64}");
            @SuppressWarnings("unchecked") var videoSource = (Map<String, Object>) lineage.get("source");
            assertThat(videoSource).containsEntry("artifactVersionId", video.version().value())
                    .containsEntry("contentType", "video/mp4");
        } finally {
            server.stop(0);
        }
    }

    @Test
    void staleVersionForeignOwnerWrongPermissionAndBadShapeAreTypedRefusals() throws Exception {
        assumeTrue(skipReason == null, () -> "SKIPPED: " + skipReason);
        Path root = Files.createTempDirectory("media-dev-vision-deny-");
        MediaRuntime runtime = runtime(root);
        HttpServer server = server(runtime, null);
        try {
            MediaArtifact source = upload(runtime, "scene3.png", "image/png", testImage());
            Map<String, Object> ok = Map.of("requestId", "deny-1", "artifactId", source.artifactId(),
                    "artifactVersionId", source.version().value(), "tasks", List.of("caption"));
            Map<String, Object> stale = Map.of("requestId", "deny-2", "artifactId", source.artifactId(),
                    "artifactVersionId", "sha256:" + "0".repeat(64), "tasks", List.of("caption"));
            assertThat(post(server, "/dev/v1/vision/analyses", PRINCIPAL, ALL, stale).statusCode()).isEqualTo(404);
            assertThat(post(server, "/dev/v1/vision/analyses", OTHER, ALL, ok).statusCode()).isEqualTo(404);
            assertThat(post(server, "/dev/v1/vision/analyses", PRINCIPAL,
                    Set.of("media:project:dev:write", "media:artifact:read"), ok).statusCode()).isEqualTo(403);
            assertThat(post(server, "/dev/v1/vision/analyses", PRINCIPAL, Set.of("media:artifact:read"), ok).statusCode())
                    .isEqualTo(403);
            assertThat(post(server, "/dev/v1/vision/analyses", PRINCIPAL, ALL, Map.of("requestId", "deny-3",
                    "artifactId", source.artifactId(), "artifactVersionId", source.version().value(),
                    "tasks", List.of("segment"))).statusCode()).isEqualTo(400);
            assertThat(post(server, "/dev/v1/vision/analyses", PRINCIPAL, ALL, Map.of("requestId", "deny-4",
                    "artifactId", source.artifactId(), "artifactVersionId", source.version().value(),
                    "tasks", List.of("caption"), "extra", 1)).statusCode()).isEqualTo(400);
            // Non-image, non-video source.
            MediaArtifact text = upload(runtime, "note.txt", "text/plain", "hello".getBytes(StandardCharsets.UTF_8));
            HttpResponse<byte[]> unsupported = post(server, "/dev/v1/vision/analyses", PRINCIPAL, ALL, Map.of(
                    "requestId", "deny-5", "artifactId", text.artifactId(), "artifactVersionId", text.version().value(),
                    "tasks", List.of("caption")));
            assertThat(unsupported.statusCode()).isEqualTo(422);
            assertThat(map(unsupported).toString()).contains("SOURCE_FORMAT_NOT_SUPPORTED");
            // Status route reports admission truthfully.
            Map<String, Object> status = map(get(server, "/dev/v1/vision/status", PRINCIPAL, ALL));
            assertThat(status.toString()).contains("QUALIFIED").contains("fixture-only-rights-resolver");
        } finally {
            server.stop(0);
        }
    }

    @Test
    void notQualifiedModelIsRefusedWithTypedErrorAndNothingIsRegistered() throws Exception {
        // Does not need real models: the manifest points at an empty directory.
        Path root = Files.createTempDirectory("media-dev-vision-notadmitted-");
        Path emptyModels = Files.createTempDirectory("media-dev-vision-empty-models-");
        MediaRuntime runtime = runtime(root);
        var unadmitted = new LocalVisionEngine(
                new LocalVisionSidecarClient(URI.create("http://127.0.0.1:9"), "fixture-only-token-0123456789abcdef",
                        Duration.ofSeconds(1)),
                new LocalModelAdmission(emptyModels.resolve("florence-2-large"), LocalVisionEngine.FLORENCE_MODEL_ID,
                        "VISION", "MIT"),
                new LocalModelAdmission(emptyModels.resolve("qwen2.5-vl-7b-instruct"), LocalVisionEngine.QWEN_MODEL_ID,
                        "MULTIMODAL_QA", "Apache-2.0"),
                LocalVisionRightsAuthority.unavailable());
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", new MediaSecurityFilter(new MediaHttpHandler(runtime, null, null, null,
                (MediaDevReviewRuntime) null).withDevVision(new MediaDevVisionRuntime(runtime, unadmitted, null,
                fixtureResolver(Verdict.ADMITTED))), "dev",
                Map.of("MEDIA_DEV_IDENTITY_ENABLED", "true", "MEDIA_DEV_JWT_HMAC_SECRET", SECRET), CLOCK));
        server.start();
        try {
            MediaArtifact source = upload(runtime, "scene4.png", "image/png", testImage());
            HttpResponse<byte[]> refused = post(server, "/dev/v1/vision/questions", PRINCIPAL, ALL, Map.of(
                    "requestId", "na-1", "artifactId", source.artifactId(),
                    "artifactVersionId", source.version().value(), "question", "What is shown?"));
            assertThat(refused.statusCode()).isEqualTo(503);
            assertThat(map(refused).toString()).contains("LOCAL_MODEL_NOT_ADMITTED").contains("MODEL_MANIFEST_MISSING_OR_INVALID");
            Map<String, Object> status = map(get(server, "/dev/v1/vision/status", PRINCIPAL, ALL));
            assertThat(status.toString()).contains("NOT_ADMITTED");
        } finally {
            server.stop(0);
        }
    }

    @Test
    void rightsNotAdmittedRefusesBeforeAnyReadOrInference() throws Exception {
        Path root = Files.createTempDirectory("media-dev-vision-rights-");
        MediaRuntime runtime = runtime(root);
        var unadmitted = new LocalVisionEngine(
                new LocalVisionSidecarClient(URI.create("http://127.0.0.1:9"), "fixture-only-token-0123456789abcdef",
                        Duration.ofSeconds(1)),
                new LocalModelAdmission(root.resolve("f"), LocalVisionEngine.FLORENCE_MODEL_ID, "VISION", "MIT"),
                new LocalModelAdmission(root.resolve("q"), LocalVisionEngine.QWEN_MODEL_ID, "MULTIMODAL_QA", "Apache-2.0"),
                LocalVisionRightsAuthority.unavailable());
        MediaArtifact source = upload(runtime, "r.png", "image/png", testImage());
        Map<String, Object> body = Map.of("requestId", "rights-1", "artifactId", source.artifactId(),
                "artifactVersionId", source.version().value(), "tasks", List.of("caption"));
        for (var entry : Map.of(Verdict.UNAVAILABLE, 503, Verdict.DENIED, 403, Verdict.REVOKED, 403,
                Verdict.STALE, 403, Verdict.MISMATCH, 403).entrySet()) {
            HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", new MediaSecurityFilter(new MediaHttpHandler(runtime, null, null, null,
                    (MediaDevReviewRuntime) null).withDevVision(new MediaDevVisionRuntime(runtime, unadmitted, null,
                    fixtureResolver(entry.getKey()))), "dev",
                    Map.of("MEDIA_DEV_IDENTITY_ENABLED", "true", "MEDIA_DEV_JWT_HMAC_SECRET", SECRET), CLOCK));
            server.start();
            try {
                HttpResponse<byte[]> refused = post(server, "/dev/v1/vision/analyses", PRINCIPAL, ALL, body);
                assertThat(refused.statusCode()).as(entry.getKey().name()).isEqualTo(entry.getValue());
                String code = entry.getKey() == Verdict.UNAVAILABLE ? "RIGHTS_AUTHORITY_UNAVAILABLE"
                        : "RIGHTS_" + entry.getKey().name();
                assertThat(map(refused).toString()).contains(code);
            } finally {
                server.stop(0);
            }
        }
        // No resolver at all is the same fail-closed default.
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", new MediaSecurityFilter(new MediaHttpHandler(runtime, null, null, null,
                (MediaDevReviewRuntime) null).withDevVision(new MediaDevVisionRuntime(runtime, unadmitted, null, null)),
                "dev", Map.of("MEDIA_DEV_IDENTITY_ENABLED", "true", "MEDIA_DEV_JWT_HMAC_SECRET", SECRET), CLOCK));
        server.start();
        try {
            assertThat(post(server, "/dev/v1/vision/analyses", PRINCIPAL, ALL, body).statusCode()).isEqualTo(503);
        } finally {
            server.stop(0);
        }
    }

    // ---- helpers ----

    /** FIXTURE_ONLY resolver returning one fixed verdict for PROCESSING; admits only with a fixture attestation id. */
    private static RightsConsentResolver fixtureResolver(Verdict verdict) {
        return new RightsConsentResolver() {
            @Override public String resolverId() { return "fixture-only-rights-resolver"; }
            @Override public boolean ready() { return true; }
            @Override public Resolution resolve(com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest r) {
                assertThat(r.scope()).isEqualTo(Scope.PROCESSING);
                return verdict == Verdict.ADMITTED
                        ? new Resolution(verdict, java.util.Set.of(), List.of("fixture-attestation-1"), resolverId())
                        : new Resolution(verdict, java.util.Set.of(Reason.NO_ATTESTATION), List.of(), resolverId());
            }
        };
    }

    private static byte[] testImage() throws Exception {
        BufferedImage image = new BufferedImage(640, 480, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = image.createGraphics();
        try {
            g.setColor(Color.WHITE);
            g.fillRect(0, 0, 640, 480);
            g.setColor(new Color(220, 30, 30));
            g.fillRect(40, 160, 240, 240);
            g.setColor(new Color(30, 60, 220));
            g.fillOval(340, 180, 240, 240);
            g.setColor(Color.BLACK);
            g.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 56));
            g.drawString("HELLO GHATANA", 60, 95);
        } finally {
            g.dispose();
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    private static MediaArtifact upload(MediaRuntime runtime, String name, String contentType, byte[] bytes)
            throws Exception {
        String digest = HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        var session = runtime.beginUpload(new UploadRequest(TENANT, PRINCIPAL, name, contentType, bytes.length,
                digest, "INTERNAL", Duration.ofMinutes(30), Map.of()), "key-" + name + bytes.length);
        int chunk = runtime.config().maximumChunkBytes();
        for (int offset = 0, index = 0; offset < bytes.length; offset += chunk, index++) {
            runtime.appendChunk(TENANT, PRINCIPAL, session.uploadId(), index,
                    Arrays.copyOfRange(bytes, offset, Math.min(bytes.length, offset + chunk)));
        }
        return runtime.completeUpload(TENANT, PRINCIPAL, session.uploadId());
    }

    private static MediaRuntime runtime(Path root) {
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "dev", 8093, 8_388_608, 1_048_576, 8_388_608,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(false),
                new LocalMediaRuntimeSupport.StreamStore(), null,
                List.of(new NoEffectProvider()), List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
    }

    private static HttpServer server(MediaRuntime runtime, LocalOpenModelVisionProvider.FrameExtractor frames)
            throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        MediaHttpHandler handler = new MediaHttpHandler(runtime, null, null, null, (MediaDevReviewRuntime) null)
                .withDevVision(new MediaDevVisionRuntime(runtime, engine, frames, fixtureResolver(Verdict.ADMITTED)));
        server.createContext("/", new MediaSecurityFilter(handler, "dev",
                Map.of("MEDIA_DEV_IDENTITY_ENABLED", "true", "MEDIA_DEV_JWT_HMAC_SECRET", SECRET), CLOCK));
        server.start();
        return server;
    }

    private static Map<String, Object> map(HttpResponse<byte[]> response) throws Exception {
        return JSON.readValue(response.body(), new TypeReference<>() { });
    }

    private static HttpResponse<byte[]> get(HttpServer server, String path, String principal, Set<String> permissions)
            throws Exception {
        return HttpClient.newHttpClient().send(HttpRequest.newBuilder(
                        URI.create("http://127.0.0.1:" + server.getAddress().getPort() + path))
                .header("Authorization", "Bearer " + token(principal, permissions)).header("X-Tenant-Id", TENANT)
                .GET().build(), HttpResponse.BodyHandlers.ofByteArray());
    }

    private static HttpResponse<byte[]> post(HttpServer server, String path, String principal, Set<String> permissions,
                                             Map<String, Object> body) throws Exception {
        return HttpClient.newHttpClient().send(HttpRequest.newBuilder(
                        URI.create("http://127.0.0.1:" + server.getAddress().getPort() + path))
                .timeout(Duration.ofMinutes(10))
                .header("Authorization", "Bearer " + token(principal, permissions)).header("X-Tenant-Id", TENANT)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofByteArray(JSON.writeValueAsBytes(body))).build(),
                HttpResponse.BodyHandlers.ofByteArray());
    }

    private static String token(String principal, Set<String> permissions) throws Exception {
        String permissionJson = permissions.stream().sorted().map(p -> "\"" + p + "\"")
                .collect(java.util.stream.Collectors.joining(","));
        String payload = "{\"sub\":\"" + principal + "\",\"tenant_id\":\"" + TENANT
                + "\",\"iss\":\"urn:ghatana:media:dev-only\",\"aud\":\"ghatana-media-dev\",\"dev_only\":true,"
                + "\"iat\":" + CLOCK.instant().getEpochSecond() + ",\"exp\":"
                + CLOCK.instant().plusSeconds(120).getEpochSecond() + ",\"permissions\":[" + permissionJson + "]}";
        String signingInput = encode("{\"alg\":\"HS256\",\"typ\":\"JWT\"}") + "." + encode(payload);
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return signingInput + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.US_ASCII)));
    }

    private static String encode(String value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static final class NoEffectProvider implements MediaProcessingProvider {
        @Override public String providerId() { return "dev-vision-http-no-effect"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.TRANSCODE); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 0; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public java.util.concurrent.CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            return java.util.concurrent.CompletableFuture.failedFuture(new AssertionError("vision lane must not use jobs"));
        }
    }
}
