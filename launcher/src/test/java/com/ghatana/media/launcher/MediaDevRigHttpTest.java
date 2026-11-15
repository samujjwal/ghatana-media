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
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
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
import static com.ghatana.media.launcher.MediaDevRigSpecTest.arm;
import static com.ghatana.media.launcher.MediaDevRigSpecTest.key;
import static com.ghatana.media.launcher.MediaDevRigSpecTest.list;
import static com.ghatana.media.launcher.MediaDevRigSpecTest.map;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * J-13 DEV_ONLY deterministic 3D rig render over the real HTTP host, filter and artifact store with REAL FFmpeg/ffprobe.
 * The durable PostgreSQL/S3 path, the independent FK/GLB/pixel verification, restart and kill faults and the browser are
 * covered by {@code MediaDevRigRenderIT} and the Explorer live test.
 */
class MediaDevRigHttpTest {
    private static final String OWNER = "test-principal-owner";
    private static final String OTHER = "test-principal-other";
    private static final Set<String> PERMISSIONS = Set.of("media:project:dev:create", "media:project:dev:read",
            "media:project:dev:write", "media:artifact:read", "media:artifact:create");
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final String RENDERS = "/dev/v1/rigs/renders";

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
        root = Files.createTempDirectory("media-dev-rig-http-");
    }

    @AfterAll
    static void cleanup() {
        if (root != null) deleteTree(root);
    }

    @Test
    @SuppressWarnings("unchecked")
    void invalidJointLimitAndCoordinateAndBudgetRefusalsAreTypedWithPathsAndRegisterNothing() throws Exception {
        MediaRuntime runtime = runtime();
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            int before = artifactCount(runtime);
            Map<String, String[]> cases = new LinkedHashMap<>();
            cases.put("badKey", new String[] {"RIG_SPEC_INVALID", "$.shaders", spec(s -> s.put("shaders", 1))});
            cases.put("badRotation", new String[] {"RIG_SPEC_INVALID", "$.bones[0].keyframes[1].rotation.degrees",
                    spec(s -> bone(s, 0).put("keyframes", list(key(0, 0), map("frame", 5, "rotation",
                            map("axis", list(0, 0, 1), "degrees", "ninety")))))});
            cases.put("limit", new String[] {"JOINT_LIMIT_EXCEEDED", "$.bones[0].keyframes[1].rotation",
                    spec(s -> bone(s, 0).put("keyframes", list(key(0, 0), key(23, 121))))});
            cases.put("leftHanded", new String[] {"COORDINATE_PROFILE_UNSUPPORTED", "$.coordinateFrame.handedness",
                    spec(s -> ((Map<String, Object>) s.get("coordinateFrame")).put("handedness", "LEFT_HANDED"))});
            cases.put("zUp", new String[] {"COORDINATE_PROFILE_UNSUPPORTED", "$.coordinateFrame.upAxis",
                    spec(s -> ((Map<String, Object>) s.get("coordinateFrame")).put("upAxis", "Z"))});
            cases.put("frames", new String[] {"RIG_BUDGET_EXCEEDED", "$.frameCount", spec(s -> s.put("frameCount", 241))});
            cases.put("size", new String[] {"RIG_BUDGET_EXCEEDED", "$", spec(s -> {
                s.put("width", 960); s.put("height", 540); s.put("frameCount", 100); })});
            int n = 0;
            for (Map.Entry<String, String[]> entry : cases.entrySet()) {
                String[] expected = entry.getValue();
                HttpResponse<String> response = send(base, "POST", RENDERS, body("bad-" + n++, expected[2], 14), OWNER, PERMISSIONS);
                assertThat(response.statusCode()).as(entry.getKey() + " " + response.body()).isEqualTo(422);
                Map<String, Object> error = object(read(response.body()).get("error"));
                assertThat(error).as(entry.getKey()).containsEntry("code", expected[0]);
                assertThat(object(error.get("details"))).as(entry.getKey()).containsEntry("path", expected[1]);
            }
            assertThat(artifactCount(runtime)).as("no refusal registered anything").isEqualTo(before);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void rendersVerifiedMp4GlbAndManifestReplaysIdempotentlyAndIsOwnerScoped() throws Exception {
        MediaRuntime runtime = runtime();
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            HttpResponse<String> first = send(base, "POST", RENDERS, body("rig-1", spec(s -> { }), 14), OWNER, PERMISSIONS);
            assertThat(first.statusCode()).as(first.body()).isEqualTo(201);
            Map<String, Object> view = read(first.body());
            Map<String, Object> manifest = object(view.get("manifest"));
            List<?> frames = (List<?>) manifest.get("frames");
            assertThat(frames).hasSize(24);
            assertThat(object(manifest.get("verification"))).containsEntry("ptsExact", true).containsEntry("frameCount", 24)
                    .containsEntry("codec", "h264");
            assertThat(((Number) object(manifest.get("quality")).get("minPsnrDb")).doubleValue()).isGreaterThan(28.0);
            Map<String, Object> frame23 = object(frames.get(23));
            assertThat(((Number) object(frame23.get("jointAnglesDegrees")).get("shoulder")).doubleValue())
                    .isEqualTo(90.0, org.assertj.core.data.Offset.offset(1e-6));
            assertThat(((Number) object(frame23.get("jointAnglesDegrees")).get("elbow")).doubleValue())
                    .isEqualTo(100.0, org.assertj.core.data.Offset.offset(1e-6));
            assertThat(object(view.get("video"))).containsEntry("contentType", "video/mp4");
            assertThat(object(view.get("glb"))).containsEntry("contentType", "model/gltf-binary");

            byte[] glb = content(runtime, (String) object(view.get("glb")).get("artifactId"));
            ByteBuffer header = ByteBuffer.wrap(glb).order(ByteOrder.LITTLE_ENDIAN);
            assertThat(header.getInt(0)).isEqualTo(0x46546c67);
            assertThat(header.getInt(8)).isEqualTo(glb.length);
            byte[] mp4 = content(runtime, (String) object(view.get("video")).get("artifactId"));
            Path file = root.resolve("rig1.mp4");
            Files.write(file, mp4);
            String probe = run(ffprobe.toString(), "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
                    "stream=nb_read_frames,avg_frame_rate,width,height,codec_name", "-of", "default=nw=1", file.toString());
            assertThat(probe).contains("nb_read_frames=24").contains("avg_frame_rate=24/1").contains("width=320")
                    .contains("height=240").contains("codec_name=h264");

            // Same spec under a new requestId: identical pre-encode frame digests and per-frame kinematics.
            HttpResponse<String> second = send(base, "POST", RENDERS, body("rig-2", spec(s -> { }), 14), OWNER, PERMISSIONS);
            assertThat(second.statusCode()).as(second.body()).isEqualTo(201);
            Map<String, Object> secondManifest = object(read(second.body()).get("manifest"));
            assertThat(secondManifest.get("frameSetSha256")).isEqualTo(manifest.get("frameSetSha256"));
            for (int i = 0; i < 24; i++) {
                assertThat(object(((List<?>) secondManifest.get("frames")).get(i)).get("pixelSha256"))
                        .isEqualTo(object(frames.get(i)).get("pixelSha256"));
                assertThat(object(((List<?>) secondManifest.get("frames")).get(i)).get("endEffector"))
                        .isEqualTo(object(frames.get(i)).get("endEffector"));
            }
            assertThat(object(read(second.body()).get("glb")).get("sha256")).as("GLB binds the request id")
                    .isNotEqualTo(object(view.get("glb")).get("sha256"));

            int count = artifactCount(runtime);
            HttpResponse<String> replay = send(base, "POST", RENDERS, body("rig-1", spec(s -> { }), 14), OWNER, PERMISSIONS);
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            assertThat(read(replay.body())).containsEntry("replayed", true).containsEntry("renderId", view.get("renderId"));
            assertThat(artifactCount(runtime)).isEqualTo(count);
            HttpResponse<String> reused = send(base, "POST", RENDERS, body("rig-1", spec(s -> s.put("background", "#000000")), 14),
                    OWNER, PERMISSIONS);
            assertThat(reused.statusCode()).as(reused.body()).isEqualTo(409);
            assertThat(reused.body()).contains("RIG_REQUEST_ID_REUSED");
            assertThat(send(base, "POST", RENDERS, body("rig-1", spec(s -> { }), 20), OWNER, PERMISSIONS).statusCode()).isEqualTo(409);
            assertThat(artifactCount(runtime)).isEqualTo(count);

            HttpResponse<String> reopened = send(base, "GET", RENDERS + "/" + view.get("renderId"), null, OWNER, PERMISSIONS);
            assertThat(reopened.statusCode()).isEqualTo(200);
            assertThat(object(read(reopened.body()).get("manifest")).get("frameSetSha256")).isEqualTo(manifest.get("frameSetSha256"));
            assertThat(send(base, "GET", RENDERS + "/" + view.get("renderId"), null, OTHER, PERMISSIONS).statusCode()).isEqualTo(404);
            assertThat(send(base, "GET", "/dev/v1/rigs/status", null, OWNER, PERMISSIONS).statusCode()).isEqualTo(200);
            assertThat(send(base, "POST", RENDERS, body("rig-3", spec(s -> { }), 14), OWNER, Set.of("media:project:dev:write"))
                    .statusCode()).as("artifact permissions are required").isEqualTo(403);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void floorTextureNeedsAdmittedProcessingRightsOnEveryCallAndIsOwnerScoped() throws Exception {
        MediaRuntime runtime = runtime();
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            MediaArtifact texture = upload(runtime, "floor.png", "image/png", png());
            Map<String, Object> textured = textured(texture);
            int before = artifactCount(runtime);
            HttpResponse<String> missing = send(base, "POST", RENDERS, body("tex-1", textured, 14), OWNER, PERMISSIONS);
            assertThat(missing.statusCode()).as(missing.body()).isEqualTo(403);
            Map<String, Object> error = object(read(missing.body()).get("error"));
            assertThat(error).containsEntry("code", "RIGHTS_NOT_ADMITTED");
            assertThat(object(error.get("details"))).containsEntry("verdict", "DENIED").containsEntry("path", "$.assets[0]");
            assertThat(artifactCount(runtime)).isEqualTo(before);

            admitted.add(texture.artifactId());
            HttpResponse<String> ok = send(base, "POST", RENDERS, body("tex-1", textured, 14), OWNER, PERMISSIONS);
            assertThat(ok.statusCode()).as(ok.body()).isEqualTo(201);
            Map<String, Object> view = read(ok.body());
            assertThat(object(view.get("videoLineage")).get("sources")).asList().hasSize(1);
            assertThat(object(object(view.get("glbLineage")).get("glb")).get("sourceVersions")).asList().hasSize(2);

            HttpResponse<String> foreign = send(base, "POST", RENDERS, body("tex-2", textured, 14), OTHER, PERMISSIONS);
            assertThat(foreign.statusCode()).as(foreign.body()).isEqualTo(404);
            assertThat(foreign.body()).contains("SOURCE_VERSION_NOT_FOUND");

            revoked.set(true);
            HttpResponse<String> afterRevoke = send(base, "POST", RENDERS, body("tex-1", textured, 14), OWNER, PERMISSIONS);
            assertThat(afterRevoke.statusCode()).as(afterRevoke.body()).isEqualTo(403);
            assertThat(afterRevoke.body()).contains("RIGHTS_NOT_ADMITTED").contains("REVOKED");
            revoked.set(false);

            MediaArtifact notImage = upload(runtime, "notes.txt", "text/plain", "not an image".getBytes());
            admitted.add(notImage.artifactId());
            HttpResponse<String> text = send(base, "POST", RENDERS, body("tex-3", textured(notImage), 14), OWNER, PERMISSIONS);
            assertThat(text.statusCode()).as(text.body()).isEqualTo(422);
            assertThat(text.body()).contains("ASSET_NOT_SUPPORTED");
        } finally {
            server.stop(0);
        }
    }

    // ---- spec builders ----

    @SuppressWarnings("unchecked")
    private static Map<String, Object> bone(Map<String, Object> spec, int index) {
        return (Map<String, Object>) ((List<?>) spec.get("bones")).get(index);
    }

    private static String spec(java.util.function.Consumer<Map<String, Object>> change) throws Exception {
        Map<String, Object> spec = arm();
        change.accept(spec);
        return JSON.writeValueAsString(spec);
    }

    private static Map<String, Object> textured(MediaArtifact texture) {
        Map<String, Object> spec = arm();
        spec.put("floor", map("y", -0.4, "halfExtent", 2.0, "tiles", 4, "colorA", "#808080", "colorB", "#404040",
                "textureAssetId", "tex"));
        spec.put("assets", new ArrayList<>(List.of(map("id", "tex", "artifactId", texture.artifactId(),
                "artifactVersionId", texture.version().value()))));
        return spec;
    }

    private static String body(String requestId, Object spec, int crf) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("spec", spec instanceof String text ? JSON.readValue(text, Map.class) : spec);
        body.put("encoder", Map.of("crf", crf));
        return JSON.writeValueAsString(body);
    }

    private static byte[] png() throws Exception {
        var image = new java.awt.image.BufferedImage(16, 16, java.awt.image.BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < 16; y++) {
            for (int x = 0; x < 16; x++) image.setRGB(x, y, ((x / 4 + y / 4) % 2 == 0) ? 0xFFFFD000 : 0xFF2060FF);
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
        MediaDevRigRuntime rig = new MediaDevRigRuntime(runtime, ffmpeg, ffprobe, resolver,
                MediaDevProjectRenderRuntime.canonicalRegistrar(runtime), MediaDevRequestLedger.inMemory());
        MediaHttpHandler handler = new MediaHttpHandler(runtime, null, null, projects).withDevRig(rig);
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
