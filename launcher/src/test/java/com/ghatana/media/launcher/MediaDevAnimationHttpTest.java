package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRightsConsentContracts.Reason;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.InMemoryManagedStore;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.TENANT;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.base;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.object;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.read;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.send;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * J-12 DEV_ONLY deterministic 2D animation over the real HTTP host, filter and artifact store with REAL FFmpeg/ffprobe.
 * The durable PostgreSQL/S3 path, golden-frame/PSNR measurement, restart and the browser are covered by
 * {@code MediaDevAnimationIT} and the Explorer live test.
 */
class MediaDevAnimationHttpTest {
    private static final String OWNER = "test-principal-owner";
    private static final String OTHER = "test-principal-other";
    private static final Set<String> PERMISSIONS = Set.of("media:project:dev:create", "media:project:dev:read",
            "media:project:dev:write", "media:artifact:read", "media:artifact:create");
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final String RENDERS = "/dev/v1/animations/renders";

    private static Path ffmpeg;
    private static Path ffprobe;
    private static Path root;

    private final Set<String> admitted = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean revoked = new AtomicBoolean();
    private final RightsConsentResolver resolver = new RightsConsentResolver() {
        @Override public String resolverId() { return "test-resolver"; }
        @Override public boolean ready() { return true; }
        @Override public Resolution resolve(ResolutionRequest request) {
            if (!admitted.contains(request.artifactId())) {
                return new Resolution(Verdict.DENIED, Set.of(Reason.NO_ATTESTATION), List.of(), resolverId());
            }
            if (revoked.get()) return new Resolution(Verdict.REVOKED, Set.of(Reason.REVOKED), List.of(), resolverId());
            return new Resolution(Verdict.ADMITTED, Set.of(), List.of("att-" + request.artifactId()), resolverId());
        }
    };

    @BeforeAll
    static void tools() throws Exception {
        String ff = System.getenv("MEDIA_DEV_RENDER_FFMPEG");
        String fp = System.getenv("MEDIA_DEV_RENDER_FFPROBE");
        assertThat(ff).as("MEDIA_DEV_RENDER_FFMPEG").isNotBlank();
        assertThat(fp).as("MEDIA_DEV_RENDER_FFPROBE").isNotBlank();
        ffmpeg = Path.of(ff);
        ffprobe = Path.of(fp);
        root = Files.createTempDirectory("media-dev-animation-http-");
    }

    @AfterAll
    static void cleanup() {
        if (root != null) deleteTree(root);
    }

    @Test
    void invalidSpecsAreTypedWithThePathOfTheOffendingValueAndRegisterNothing() throws Exception {
        MediaRuntime runtime = runtime();
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            int before = artifactCount(runtime);
            Map<String, String> cases = new LinkedHashMap<>();
            cases.put("$.width", mutate(spec -> spec.put("width", 321)));
            cases.put("$.height", mutate(spec -> spec.put("height", 8)));
            cases.put("$.background", mutate(spec -> spec.put("background", "red")));
            cases.put("$.fps.denominator", mutate(spec -> spec.put("fps", Map.of("numerator", 24, "denominator", 0))));
            cases.put("$.frameCount", mutate(spec -> spec.put("frameCount", 0)));
            cases.put("$.frameCount ", mutate(spec -> spec.put("frameCount", "ten")));
            cases.put("$.colour", mutate(spec -> spec.put("colour", "x")));
            cases.put("$.shapes[1].primitive", mutate(spec -> shape(spec, 1).put("primitive", "TRIANGLE")));
            cases.put("$.shapes[1].color", mutate(spec -> shape(spec, 1).put("color", "#12345")));
            cases.put("$.shapes[0].keyframes[1].easing", mutate(spec -> key(spec, 0, 1).put("easing", "BOUNCE")));
            cases.put("$.shapes[0].keyframes[1].frame", mutate(spec -> key(spec, 0, 1).put("frame", 0)));
            cases.put("$.shapes[0].keyframes[1].opacity", mutate(spec -> key(spec, 0, 1).put("opacity", 2.5)));
            cases.put("$.shapes[1].id", mutate(spec -> shape(spec, 1).put("id", "box")));
            cases.put("$.shapes[1].assetId", mutate(spec -> shape(spec, 1).put("assetId", "nope")));
            cases.put("$.shapes[0].keyframes[1].x", mutate(spec -> key(spec, 0, 1).put("x", "far")));
            for (Map.Entry<String, String> entry : cases.entrySet()) {
                HttpResponse<String> response = send(base, "POST", RENDERS, entry.getValue(), OWNER, PERMISSIONS);
                assertThat(response.statusCode()).as(entry.getKey() + " " + response.body()).isEqualTo(422);
                Map<String, Object> error = object(read(response.body()).get("error"));
                assertThat(error).containsEntry("code", "ANIMATION_SPEC_INVALID");
                assertThat(object(error.get("details")).get("path").toString().trim()).as(response.body())
                        .isEqualTo(entry.getKey().trim());
            }
            assertThat(artifactCount(runtime)).as("no refusal registered anything").isEqualTo(before);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void overBudgetFramesSizeAndDrawsAreTypedBudgetRefusalsBeforeAnyRender() throws Exception {
        MediaRuntime runtime = runtime();
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            int before = artifactCount(runtime);
            Map<String, String> cases = new LinkedHashMap<>();
            cases.put("$.frameCount", mutate(spec -> spec.put("frameCount", 241)));
            cases.put("$.width", mutate(spec -> spec.put("width", 1282)));
            cases.put("$.height", mutate(spec -> spec.put("height", 722)));
            cases.put("$.fps", mutate(spec -> spec.put("fps", Map.of("numerator", 61, "denominator", 1))));
            cases.put("$", mutate(spec -> { spec.put("width", 1280); spec.put("height", 720); spec.put("frameCount", 60); }));
            cases.put("$.particleFields[0].count", mutate(spec -> spec.put("particleFields", List.of(particles(10_001)))));
            cases.put("$.particleFields", mutate(spec -> {
                spec.put("frameCount", 200);
                spec.put("particleFields", List.of(particles(9_000), particles2(9_000)));
            }));
            for (Map.Entry<String, String> entry : cases.entrySet()) {
                HttpResponse<String> response = send(base, "POST", RENDERS, entry.getValue(), OWNER, PERMISSIONS);
                assertThat(response.statusCode()).as(entry.getKey() + " " + response.body()).isEqualTo(422);
                Map<String, Object> error = object(read(response.body()).get("error"));
                assertThat(error).containsEntry("code", "ANIMATION_BUDGET_EXCEEDED");
                Map<String, Object> details = object(error.get("details"));
                assertThat(details).containsEntry("path", entry.getKey());
                assertThat(details).containsKeys("limit", "ceiling", "requested");
            }
            assertThat(artifactCount(runtime)).isEqualTo(before);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void rendersDeterministicFramesVerifiedMp4ReplaysIdempotentlyAndRefusesAChangedBody() throws Exception {
        MediaRuntime runtime = runtime();
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            HttpResponse<String> first = send(base, "POST", RENDERS, body("anim-1", baseSpec(), 14), OWNER, PERMISSIONS);
            assertThat(first.statusCode()).as(first.body()).isEqualTo(201);
            Map<String, Object> view = read(first.body());
            Map<String, Object> manifest = object(view.get("manifest"));
            List<?> frames = (List<?>) manifest.get("frames");
            assertThat(frames).hasSize(12);
            assertThat(object(manifest.get("verification"))).containsEntry("ptsExact", true).containsEntry("frameCount", 12)
                    .containsEntry("codec", "h264").containsEntry("pixelFormat", "yuv420p");
            assertThat(object(view.get("video"))).containsEntry("contentType", "video/mp4");
            String videoId = (String) object(view.get("video")).get("artifactId");
            byte[] mp4 = content(runtime, videoId);
            assertThat(mp4).hasSize(((Number) object(view.get("video")).get("sizeBytes")).intValue());

            // Independent ffprobe: exact frame count and rational frame rate.
            Path file = root.resolve("a1.mp4");
            Files.write(file, mp4);
            String probe = run(ffprobe.toString(), "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
                    "stream=nb_read_frames,avg_frame_rate,width,height,codec_name", "-of", "default=nw=1", file.toString());
            assertThat(probe).contains("nb_read_frames=12").contains("avg_frame_rate=24/1").contains("width=320")
                    .contains("height=180").contains("codec_name=h264");

            // Same spec under a new requestId: identical frame digests before encoding; MP4 bytes differ (request id in container).
            HttpResponse<String> second = send(base, "POST", RENDERS, body("anim-2", baseSpec(), 14), OWNER, PERMISSIONS);
            assertThat(second.statusCode()).as(second.body()).isEqualTo(201);
            Map<String, Object> secondManifest = object(read(second.body()).get("manifest"));
            assertThat(secondManifest.get("frameSetSha256")).isEqualTo(manifest.get("frameSetSha256"));
            assertThat(secondManifest.get("frames")).isEqualTo(manifest.get("frames"));
            assertThat(object(read(second.body()).get("video")).get("sha256")).isNotEqualTo(object(view.get("video")).get("sha256"));

            // Replay: same requestId and body returns the stored output without a new registration.
            int count = artifactCount(runtime);
            HttpResponse<String> replay = send(base, "POST", RENDERS, body("anim-1", baseSpec(), 14), OWNER, PERMISSIONS);
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            Map<String, Object> replayed = read(replay.body());
            assertThat(replayed).containsEntry("replayed", true).containsEntry("renderId", view.get("renderId"));
            assertThat(object(replayed.get("video"))).isEqualTo(view.get("video"));
            assertThat(artifactCount(runtime)).isEqualTo(count);

            // A different body under the same requestId is a typed 409; nothing new is registered.
            Map<String, Object> changed = baseSpec();
            ((Map<String, Object>) ((List<?>) changed.get("shapes")).getFirst()).put("color", "#00FF00");
            HttpResponse<String> reused = send(base, "POST", RENDERS, body("anim-1", changed, 14), OWNER, PERMISSIONS);
            assertThat(reused.statusCode()).as(reused.body()).isEqualTo(409);
            assertThat(reused.body()).contains("ANIMATION_REQUEST_ID_REUSED");
            assertThat(send(base, "POST", RENDERS, body("anim-1", baseSpec(), 20), OWNER, PERMISSIONS).statusCode()).isEqualTo(409);
            assertThat(artifactCount(runtime)).isEqualTo(count);

            // Reopen by render id; another principal sees nothing.
            HttpResponse<String> reopened = send(base, "GET", RENDERS + "/" + view.get("renderId"), null, OWNER, PERMISSIONS);
            assertThat(reopened.statusCode()).isEqualTo(200);
            assertThat(object(read(reopened.body()).get("manifest")).get("frameSetSha256")).isEqualTo(manifest.get("frameSetSha256"));
            assertThat(send(base, "GET", RENDERS + "/" + view.get("renderId"), null, OTHER, PERMISSIONS).statusCode()).isEqualTo(404);
            assertThat(send(base, "GET", "/dev/v1/animations/status", null, OWNER, PERMISSIONS).statusCode()).isEqualTo(200);
            assertThat(send(base, "POST", RENDERS, body("anim-3", baseSpec(), 14), OWNER, Set.of("media:project:dev:write"))
                    .statusCode()).as("artifact permissions are required").isEqualTo(403);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void imageAssetNeedsAdmittedProcessingRightsOnEveryCallAndIsOwnerScoped() throws Exception {
        MediaRuntime runtime = runtime();
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            MediaArtifact asset = upload(runtime, "sticker.png", "image/png", png(16, 16));
            MediaArtifact notImage = upload(runtime, "notes.txt", "text/plain", "not an image".getBytes());
            Map<String, Object> spec = withAsset(asset);
            int before = artifactCount(runtime);

            HttpResponse<String> missing = send(base, "POST", RENDERS, body("asset-1", spec, 14), OWNER, PERMISSIONS);
            assertThat(missing.statusCode()).as(missing.body()).isEqualTo(403);
            Map<String, Object> error = object(read(missing.body()).get("error"));
            assertThat(error).containsEntry("code", "RIGHTS_NOT_ADMITTED");
            assertThat(object(error.get("details"))).containsEntry("verdict", "DENIED").containsEntry("path", "$.assets[0]")
                    .containsEntry("artifactId", asset.artifactId());
            assertThat(artifactCount(runtime)).as("no render and no registration without rights").isEqualTo(before);

            admitted.add(asset.artifactId());
            HttpResponse<String> ok = send(base, "POST", RENDERS, body("asset-1", spec, 14), OWNER, PERMISSIONS);
            assertThat(ok.statusCode()).as(ok.body()).isEqualTo(201);
            Map<String, Object> view = read(ok.body());
            Map<String, Object> lineage = object(view.get("videoLineage"));
            assertThat(((List<?>) lineage.get("sources"))).hasSize(1);
            assertThat(object(lineage.get("parent"))).containsEntry("artifactId", asset.artifactId());
            assertThat(((List<?>) object(view.get("manifest")).get("assets"))).hasSize(1);

            // Another principal cannot name the asset: the exact version is not visible.
            HttpResponse<String> foreign = send(base, "POST", RENDERS, body("asset-2", spec, 14), OTHER, PERMISSIONS);
            assertThat(foreign.statusCode()).as(foreign.body()).isEqualTo(404);
            assertThat(foreign.body()).contains("SOURCE_VERSION_NOT_FOUND");

            // Rights are re-checked on a replay: revocation refuses even the stored render.
            revoked.set(true);
            HttpResponse<String> afterRevoke = send(base, "POST", RENDERS, body("asset-1", spec, 14), OWNER, PERMISSIONS);
            assertThat(afterRevoke.statusCode()).as(afterRevoke.body()).isEqualTo(403);
            assertThat(afterRevoke.body()).contains("RIGHTS_NOT_ADMITTED").contains("REVOKED");
            revoked.set(false);

            // A non-image artifact is a typed asset refusal (after its own rights check).
            admitted.add(notImage.artifactId());
            HttpResponse<String> text = send(base, "POST", RENDERS, body("asset-3", withAsset(notImage), 14), OWNER, PERMISSIONS);
            assertThat(text.statusCode()).as(text.body()).isEqualTo(422);
            assertThat(text.body()).contains("ASSET_NOT_SUPPORTED");
            // A corrupt PNG signature body is not decodable.
            byte[] corrupt = png(16, 16);
            for (int i = 40; i < corrupt.length - 20; i++) corrupt[i] = (byte) 0x5a;
            MediaArtifact broken = upload(runtime, "broken.png", "image/png", corrupt);
            admitted.add(broken.artifactId());
            HttpResponse<String> undecodable = send(base, "POST", RENDERS, body("asset-4", withAsset(broken), 14), OWNER, PERMISSIONS);
            assertThat(undecodable.statusCode()).as(undecodable.body()).isEqualTo(422);
            assertThat(undecodable.body()).contains("ASSET_NOT_SUPPORTED");
        } finally {
            server.stop(0);
        }
    }

    // ---- spec builders ----

    @SuppressWarnings("unchecked")
    private static Map<String, Object> shape(Map<String, Object> spec, int index) {
        return (Map<String, Object>) ((List<?>) spec.get("shapes")).get(index);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> key(Map<String, Object> spec, int shape, int key) {
        return (Map<String, Object>) ((List<?>) shape(spec, shape).get("keyframes")).get(key);
    }

    private static Map<String, Object> baseSpec() {
        Map<String, Object> spec = new LinkedHashMap<>();
        spec.put("width", 320);
        spec.put("height", 180);
        spec.put("background", "#101828");
        spec.put("fps", new LinkedHashMap<>(Map.of("numerator", 24, "denominator", 1)));
        spec.put("frameCount", 12);
        List<Object> shapes = new ArrayList<>();
        shapes.add(new LinkedHashMap<>(Map.of("id", "box", "primitive", "RECTANGLE", "x", 20, "y", 60, "width", 40, "height", 40,
                "color", "#FF4040", "keyframes", new ArrayList<>(List.of(
                        new LinkedHashMap<>(Map.of("frame", 0, "x", 0, "easing", "EASE_IN_OUT")),
                        new LinkedHashMap<>(Map.of("frame", 11, "x", 200)))))));
        shapes.add(new LinkedHashMap<>(Map.of("id", "ball", "primitive", "ELLIPSE", "x", 250, "y", 20, "width", 30, "height", 30,
                "color", "#40FF80")));
        spec.put("shapes", shapes);
        return spec;
    }

    private static Map<String, Object> withAsset(MediaArtifact asset) {
        Map<String, Object> spec = baseSpec();
        spec.put("assets", new ArrayList<>(List.of(new LinkedHashMap<>(Map.of("id", "sticker",
                "artifactId", asset.artifactId(), "artifactVersionId", asset.version().value())))));
        ((List<Object>) spec.get("shapes")).add(new LinkedHashMap<>(Map.of("id", "pic", "primitive", "RASTER_ASSET",
                "assetId", "sticker", "x", 100, "y", 100, "width", 32, "height", 32)));
        return spec;
    }

    private static Map<String, Object> particles(int count) {
        return new LinkedHashMap<>(Map.of("id", "sparks", "seed", 7, "count", count, "x", 0, "y", 0, "width", 100, "height", 100,
                "radius", 2, "color", "#FFFFFF"));
    }

    private static Map<String, Object> particles2(int count) {
        Map<String, Object> field = particles(count);
        field.put("id", "sparks2");
        return field;
    }

    private static String mutate(java.util.function.Consumer<Map<String, Object>> change) throws Exception {
        Map<String, Object> spec = baseSpec();
        change.accept(spec);
        return body("req-" + Math.abs(spec.hashCode()), spec, 14);
    }

    private static String body(String requestId, Map<String, Object> spec, int crf) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("spec", spec);
        body.put("encoder", Map.of("crf", crf));
        return JSON.writeValueAsString(body);
    }

    private static byte[] png(int width, int height) throws Exception {
        var image = new java.awt.image.BufferedImage(width, height, java.awt.image.BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) image.setRGB(x, y, ((x / 4 + y / 4) % 2 == 0) ? 0xFFFFD000 : 0xFF2060FF);
        }
        var out = new java.io.ByteArrayOutputStream();
        javax.imageio.ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    // ---- host builders ----

    private HttpServer server(MediaRuntime runtime) throws Exception {
        MediaDevProjectTimelineRuntime projects = new MediaDevProjectTimelineRuntime(new InMemoryManagedStore());
        HttpServer server = MediaDevProjectRenderHttpTest.server(runtime, projects, null);
        server.removeContext("/");
        MediaDevAnimationRuntime animation = new MediaDevAnimationRuntime(runtime, ffmpeg, ffprobe, resolver,
                MediaDevProjectRenderRuntime.canonicalRegistrar(runtime), MediaDevRequestLedger.inMemory());
        MediaHttpHandler handler = new MediaHttpHandler(runtime, null, null, projects).withDevAnimation(animation);
        server.createContext("/", new MediaSecurityFilter(handler, "dev", Map.of("MEDIA_DEV_IDENTITY_ENABLED", "true",
                "MEDIA_DEV_JWT_HMAC_SECRET", "test-only-dev-project-secret-at-least-32-bytes"),
                java.time.Clock.fixed(java.time.Instant.parse("2026-11-13T20:00:00Z"), java.time.ZoneOffset.UTC)));
        return server;
    }

    private static MediaRuntime runtime() throws Exception {
        Path store = Files.createTempDirectory(root, "store-");
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "dev", 8093, 1_048_576, 131_072, 64L * 1024 * 1024, Duration.ofSeconds(2),
                        2, "", "", true, false, store, 0, MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT,
                        MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT_PER_TENANT),
                new LocalMediaRuntimeSupport.FileArtifactStore(store), new LocalMediaRuntimeSupport.JobStore(false),
                new LocalMediaRuntimeSupport.StreamStore(), null,
                List.of(new MediaDevProjectRenderHttpTest.NoEffectProvider()),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
    }

    private static int artifactCount(MediaRuntime runtime) throws Exception {
        try (var files = Files.walk(Path.of(runtime.config().localStorageRoot().toString()))) {
            return (int) files.filter(Files::isRegularFile).count();
        }
    }

    private static MediaArtifact upload(MediaRuntime runtime, String name, String contentType, byte[] bytes) throws Exception {
        String digest = HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        var session = runtime.beginUpload(new UploadRequest(TENANT, OWNER, name, contentType, bytes.length, digest,
                "INTERNAL", Duration.ofMinutes(30), Map.of()), "fixture-" + digest);
        int chunk = runtime.config().maximumChunkBytes();
        int index = 0;
        for (int offset = 0; offset < bytes.length; offset += chunk, index++) {
            runtime.appendChunk(TENANT, OWNER, session.uploadId(), index,
                    java.util.Arrays.copyOfRange(bytes, offset, Math.min(bytes.length, offset + chunk)));
        }
        return runtime.completeUpload(TENANT, OWNER, session.uploadId());
    }

    private static byte[] content(MediaRuntime runtime, String artifactId) throws Exception {
        MediaArtifact artifact = runtime.artifact(TENANT, OWNER, artifactId).orElseThrow();
        var out = new java.io.ByteArrayOutputStream();
        runtime.copyArtifactContent(TENANT, OWNER, artifactId, artifact.version(), out, 64L << 20).orElseThrow();
        return out.toByteArray();
    }

    private static String run(String... command) throws Exception {
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        String output = new String(process.getInputStream().readAllBytes());
        assertThat(process.waitFor(60, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        assertThat(process.exitValue()).as(output).isZero();
        return output;
    }

    private static void deleteTree(Path path) {
        try (var walk = Files.walk(path)) {
            walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
        } catch (java.io.IOException ignored) { }
    }
}
