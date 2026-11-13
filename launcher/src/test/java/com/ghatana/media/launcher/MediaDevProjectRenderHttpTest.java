package com.ghatana.media.launcher;

import com.ghatana.media.production.timeline.InMemoryProjectTimelineStore;
import com.ghatana.media.runtime.ManagedProjectTimelineStore;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Clock;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Created;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Project;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectTimelineStore;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.RationalTime;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Revision;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.TimelineSnapshot;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
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
import java.util.Base64;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Project -> exact source version -> render -> registered artifact -> reopen, through the DEV_ONLY HTTP host.
 * Covers duplicate request replay, runtime restart readback, denied access, interrupted/failed registration
 * resume, and typed unsupported inputs. The GIF is decoded independently with ImageIO.
 */
class MediaDevProjectRenderHttpTest {
    private static final String TENANT = "tenant-local";
    private static final String PRINCIPAL = "principal-local";
    private static final String OTHER = "principal-other";
    private static final String SECRET = "test-only-dev-project-secret-at-least-32-bytes";
    private static final String ISSUER = "urn:ghatana:media:dev-only";
    private static final String AUDIENCE = "ghatana-media-dev";
    private static final java.time.Clock CLOCK =
            java.time.Clock.fixed(Instant.parse("2026-11-13T20:00:00Z"), java.time.ZoneOffset.UTC);
    private static final Set<String> RENDER_PERMISSIONS = Set.of(
            "media:project:dev:create", "media:project:dev:read", "media:project:dev:write",
            "media:artifact:read", "media:artifact:create");
    private static final ObjectMapper JSON = JsonMapper.builder()
            .addModules(tools.jackson.databind.cfg.MapperBuilder.findModules()).build();
    private static final int RED = 0xffff0000;
    private static final int BLUE = 0xff0000ff;

    @Test
    void rendersExactRevisionToDecodableArtifactReplaysDuplicateAndReopensAfterRestart() throws Exception {
        Path root = Files.createTempDirectory("media-dev-render-http-");
        InMemoryManagedStore projectStore = new InMemoryManagedStore();
        MediaRuntime runtime = runtime(root);
        HttpServer server = server(runtime, new MediaDevProjectTimelineRuntime(projectStore), null);
        String projectId;
        String renderId;
        String sha256;
        Map<String, Object> renderBody;
        try {
            String base = base(server);
            Fixture fixture = twoClipProject(base, runtime, "render-project-1");
            projectId = fixture.projectId();

            HttpResponse<String> first = send(base, "POST", "/dev/v1/projects/" + projectId + "/renders",
                    renderRequest("render-1", fixture.revisionId()), PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(first.statusCode()).as(first.body()).isEqualTo(201);
            renderBody = read(first.body());
            assertThat(renderBody).containsEntry("replayed", false).containsEntry("scope", "DEV_ONLY");
            Map<String, Object> artifact = object(renderBody.get("artifact"));
            renderId = (String) renderBody.get("renderId");
            sha256 = (String) artifact.get("sha256");
            assertThat(artifact).containsEntry("contentType", "image/gif")
                    .containsEntry("artifactVersionId", "sha256:" + sha256);
            Map<String, Object> lineage = object(renderBody.get("lineage"));
            assertThat(lineage).containsEntry("projectId", projectId)
                    .containsEntry("revisionId", fixture.revisionId())
                    .containsEntry("timelineId", "timeline-main")
                    .containsEntry("engine", MediaDevProjectRenderRuntime.ENGINE)
                    .containsEntry("frameCount", 20);
            List<?> sources = (List<?>) lineage.get("sources");
            assertThat(sources).hasSize(2);
            assertThat(object(sources.get(0))).containsEntry("artifactId", fixture.redArtifact().artifactId())
                    .containsEntry("artifactVersionId", fixture.redArtifact().version().value())
                    .containsEntry("startFrame", 0).containsEntry("endFrameExclusive", 10);

            // Independent decode of the registered bytes, read back through the canonical artifact store.
            List<BufferedImage> frames = decodeGif(artifactBytes(runtime, renderId));
            assertThat(frames).hasSize(20);
            assertThat(frames.get(0).getWidth()).isEqualTo(32);
            assertThat(frames.get(0).getHeight()).isEqualTo(24);
            assertThat(frames.get(5).getRGB(16, 12)).isEqualTo(RED);
            assertThat(frames.get(15).getRGB(16, 12)).isEqualTo(BLUE);

            HttpResponse<String> duplicate = send(base, "POST", "/dev/v1/projects/" + projectId + "/renders",
                    renderRequest("render-1", fixture.revisionId()), PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(duplicate.statusCode()).as(duplicate.body()).isEqualTo(200);
            assertThat(read(duplicate.body())).containsEntry("renderId", renderId).containsEntry("replayed", true);

            // Same requestId reused for a different revision is a conflict, never a second output.
            HttpResponse<String> reuse = send(base, "POST", "/dev/v1/projects/" + projectId + "/renders",
                    JSON.writeValueAsString(Map.of("requestId", "render-1", "revisionId", fixture.revisionId(),
                            "timelineId", "timeline-main", "width", 16, "height", 12, "framesPerSecond", 10)),
                    PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(reuse.statusCode()).as(reuse.body()).isEqualTo(409);
            HttpResponse<String> noTimeline = send(base, "POST", "/dev/v1/projects/" + projectId + "/renders",
                    renderRequest("render-initial", fixture.initialRevisionId()), PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(noTimeline.statusCode()).isEqualTo(422);
            assertThat(noTimeline.body()).contains("TIMELINE_NOT_FOUND");
        } finally {
            server.stop(0);
            runtime.close();
        }

        // Restart: a fresh runtime over the same durable artifact root reopens the same media.
        MediaRuntime restarted = runtime(root);
        HttpServer again = server(restarted, new MediaDevProjectTimelineRuntime(projectStore), null);
        try {
            String base = base(again);
            HttpResponse<String> reopened = send(base, "GET",
                    "/dev/v1/projects/" + projectId + "/renders/" + renderId, null, PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(reopened.statusCode()).as(reopened.body()).isEqualTo(200);
            Map<String, Object> view = read(reopened.body());
            assertThat(object(view.get("artifact"))).containsEntry("sha256", sha256);
            assertThat(view.get("lineage")).isEqualTo(renderBody.get("lineage"));
            assertThat(decodeGif(artifactBytes(restarted, renderId))).hasSize(20);

            String revisionId = (String) object(renderBody.get("lineage")).get("revisionId");
            HttpResponse<String> retryAfterRestart = send(base, "POST", "/dev/v1/projects/" + projectId + "/renders",
                    renderRequest("render-1", revisionId), PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(retryAfterRestart.statusCode()).as(retryAfterRestart.body()).isEqualTo(200);
            assertThat(read(retryAfterRestart.body())).containsEntry("renderId", renderId);

            // Denied: another principal, missing artifact permissions, and an unrelated artifact id.
            assertThat(send(base, "GET", "/dev/v1/projects/" + projectId + "/renders/" + renderId, null,
                    OTHER, RENDER_PERMISSIONS).statusCode()).isIn(403, 404);
            assertThat(send(base, "POST", "/dev/v1/projects/" + projectId + "/renders",
                    renderRequest("render-other", revisionId), OTHER, RENDER_PERMISSIONS).statusCode()).isIn(403, 404);
            Set<String> projectOnly = Set.of("media:project:dev:read", "media:project:dev:write");
            HttpResponse<String> noArtifactPermission = send(base, "POST", "/dev/v1/projects/" + projectId + "/renders",
                    renderRequest("render-2", revisionId), PRINCIPAL, projectOnly);
            assertThat(noArtifactPermission.statusCode()).isEqualTo(403);
            assertThat(send(base, "GET", "/dev/v1/projects/" + projectId + "/renders/not-a-render", null,
                    PRINCIPAL, RENDER_PERMISSIONS).statusCode()).isEqualTo(404);
        } finally {
            again.stop(0);
            restarted.close();
        }
    }

    @Test
    void interruptedOrFailedRegistrationIsTypedAndResumesToTheSameArtifact() throws Exception {
        Path root = Files.createTempDirectory("media-dev-render-interrupt-");
        InMemoryManagedStore projectStore = new InMemoryManagedStore();
        MediaRuntime runtime = runtime(root);
        MediaDevProjectTimelineRuntime projects = new MediaDevProjectTimelineRuntime(projectStore);
        AtomicInteger attempts = new AtomicInteger();
        MediaDevProjectRenderRuntime.OutputRegistrar crashBeforeComplete = (tenant, principal, request, key, bytes) -> {
            attempts.incrementAndGet();
            var session = runtime.beginUpload(request, key);
            // Same canonical chunk boundary as the real registrar: process loss after durable append.
            runtime.appendChunk(tenant, principal, session.uploadId(), 0, java.util.Arrays.copyOf(bytes,
                    Math.min(bytes.length, runtime.config().maximumChunkBytes())));
            throw new IllegalStateException("simulated process loss before completion");
        };
        HttpServer failing = server(runtime, projects,
                new MediaDevProjectRenderRuntime(runtime, projects, crashBeforeComplete));
        Fixture fixture;
        try {
            fixture = twoClipProject(base(failing), runtime, "render-project-2");
            HttpResponse<String> failed = send(base(failing), "POST",
                    "/dev/v1/projects/" + fixture.projectId() + "/renders",
                    renderRequest("render-resume", fixture.revisionId()), PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(failed.statusCode()).as(failed.body()).isEqualTo(502);
            assertThat(failed.body()).contains("RENDER_REGISTRATION_FAILED");
            assertThat(attempts).hasValue(1);
        } finally {
            failing.stop(0);
        }
        // Canonical registrar on the same runtime resumes the open upload (verified chunk replay) and completes.
        HttpServer healthy = server(runtime, projects, null);
        try {
            HttpResponse<String> resumed = send(base(healthy), "POST",
                    "/dev/v1/projects/" + fixture.projectId() + "/renders",
                    renderRequest("render-resume", fixture.revisionId()), PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(resumed.statusCode()).as(resumed.body()).isEqualTo(201);
            Map<String, Object> body = read(resumed.body());
            assertThat(body).containsEntry("replayed", false);
            assertThat(decodeGif(artifactBytes(runtime, (String) body.get("renderId")))).hasSize(20);
            HttpResponse<String> replay = send(base(healthy), "POST",
                    "/dev/v1/projects/" + fixture.projectId() + "/renders",
                    renderRequest("render-resume", fixture.revisionId()), PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(read(replay.body())).containsEntry("renderId", body.get("renderId"))
                    .containsEntry("replayed", true);
        } finally {
            healthy.stop(0);
            runtime.close();
        }
    }

    @Test
    void unsupportedTracksAndSourcesReturnTypedErrorsWithoutAnOutput() throws Exception {
        Path root = Files.createTempDirectory("media-dev-render-unsupported-");
        MediaRuntime runtime = runtime(root);
        MediaDevProjectTimelineRuntime projects = new MediaDevProjectTimelineRuntime(new InMemoryManagedStore());
        HttpServer server = server(runtime, projects, null);
        try {
            String base = base(server);
            MediaArtifact video = upload(runtime, "clip.mov", "video/quicktime",
                    "not-an-image".getBytes(StandardCharsets.UTF_8), "unsupported-source");
            String projectId = createProject(base, "unsupported-project");
            String head = currentHead(base, projectId);
            head = edit(base, projectId, null, head, List.of(), true);
            head = edit(base, projectId, "timeline-main", head, List.of(
                    Map.of("type", "addScene", "sceneId", "scene-main", "order", 0),
                    Map.of("type", "addTrack", "trackId", "video-main", "sceneId", "scene-main",
                            "trackKind", "VIDEO", "order", 0),
                    Map.of("type", "addTrack", "trackId", "audio-main", "sceneId", "scene-main",
                            "trackKind", "AUDIO", "order", 1)), false);

            HttpResponse<String> empty = send(base, "POST", "/dev/v1/projects/" + projectId + "/renders",
                    renderRequest("empty", head), PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(empty.statusCode()).isEqualTo(422);
            assertThat(empty.body()).contains("RENDER_EMPTY_TIMELINE");

            String withVideo = edit(base, projectId, "timeline-main", head, List.of(
                    putClip("clip-video", "video-main", video, 0, 24)), false);
            HttpResponse<String> notImage = send(base, "POST", "/dev/v1/projects/" + projectId + "/renders",
                    renderRequest("not-image", withVideo), PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(notImage.statusCode()).isEqualTo(422);
            assertThat(notImage.body()).contains("SOURCE_FORMAT_NOT_SUPPORTED");

            MediaArtifact png = upload(runtime, "red.png", "image/png", png(RED), "audio-track-source");
            String withAudio = edit(base, projectId, "timeline-main", withVideo, List.of(
                    Map.of("type", "removeClip", "clipId", "clip-video"),
                    putClip("clip-audio", "audio-main", png, 0, 24)), false);
            HttpResponse<String> audioTrack = send(base, "POST", "/dev/v1/projects/" + projectId + "/renders",
                    renderRequest("audio-track", withAudio), PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(audioTrack.statusCode()).isEqualTo(422);
            assertThat(audioTrack.body()).contains("TRACK_KIND_NOT_SUPPORTED");

            String tooLong = edit(base, projectId, "timeline-main", withAudio, List.of(
                    Map.of("type", "removeClip", "clipId", "clip-audio"),
                    putClip("clip-long", "video-main", png, 0, 24 * 30)), false);
            HttpResponse<String> limit = send(base, "POST", "/dev/v1/projects/" + projectId + "/renders",
                    renderRequest("too-long", tooLong), PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(limit.statusCode()).isEqualTo(422);
            assertThat(limit.body()).contains("RENDER_LIMIT_EXCEEDED");

            HttpResponse<String> badFps = send(base, "POST", "/dev/v1/projects/" + projectId + "/renders",
                    JSON.writeValueAsString(Map.of("requestId", "bad-fps", "revisionId", head,
                            "timelineId", "timeline-main", "width", 32, "height", 24, "framesPerSecond", 30)),
                    PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(badFps.statusCode()).isEqualTo(400);
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    @Test
    void exactFrameMathVisibilityAndDecodeCeilings() throws Exception {
        assertThat(MediaDevProjectRenderRuntime.frameFloor(new RationalTime(24, 24, 1, Clock.STORY), 10)).isEqualTo(10);
        assertThat(MediaDevProjectRenderRuntime.frameCeil(new RationalTime(25, 24, 1, Clock.STORY), 10)).isEqualTo(11);
        // 30 ticks at 30000/1001 ticks per second is exactly 1.001 s.
        assertThat(MediaDevProjectRenderRuntime.frameFloor(new RationalTime(30, 30000, 1001, Clock.STORY), 10))
                .isEqualTo(10);
        assertThat(MediaDevProjectRenderRuntime.frameCeil(new RationalTime(30, 30000, 1001, Clock.STORY), 10))
                .isEqualTo(11);
        var keys = MediaDevProjectRenderRuntime.visibility(10, 20, 30);
        assertThat(keys).extracting(k -> k.frame()).containsExactly(9, 10, 19, 20);
        assertThat(keys).extracting(k -> k.opacity()).containsExactly(0.0, 1.0, 1.0, 0.0);
        assertThat(MediaDevProjectRenderRuntime.visibility(0, 1, 1)).hasSize(1);

        assertThatThrownBy(() -> MediaDevProjectRenderRuntime.boundedDecode(new byte[] {1, 2, 3}))
                .isInstanceOf(MediaDevProjectRenderRuntime.RenderNotSupportedException.class)
                .hasMessageContaining("not decodable");
        BufferedImage wide = new BufferedImage(4_096, 1, BufferedImage.TYPE_INT_ARGB);
        ByteArrayOutputStream encoded = new ByteArrayOutputStream();
        ImageIO.write(wide, "png", encoded);
        assertThatThrownBy(() -> MediaDevProjectRenderRuntime.boundedDecode(encoded.toByteArray()))
                .isInstanceOf(MediaDevProjectRenderRuntime.RenderNotSupportedException.class)
                .hasMessageContaining("decode ceiling");
    }

    private record Fixture(String projectId, String initialRevisionId, String revisionId,
                           MediaArtifact redArtifact, MediaArtifact blueArtifact) { }

    private static Fixture twoClipProject(String base, MediaRuntime runtime, String key) throws Exception {
        MediaArtifact red = upload(runtime, "red.png", "image/png", png(RED), key + "-red");
        MediaArtifact blue = upload(runtime, "blue.png", "image/png", png(BLUE), key + "-blue");
        String projectId = createProject(base, key);
        String initial = currentHead(base, projectId);
        String head = edit(base, projectId, null, initial, List.of(), true);
        head = edit(base, projectId, "timeline-main", head, List.of(
                Map.of("type", "addScene", "sceneId", "scene-main", "order", 0),
                Map.of("type", "addTrack", "trackId", "video-main", "sceneId", "scene-main",
                        "trackKind", "VIDEO", "order", 0)), false);
        head = edit(base, projectId, "timeline-main", head, List.of(
                putClip("clip-red", "video-main", red, 0, 24),
                putClip("clip-blue", "video-main", blue, 24, 24)), false);
        return new Fixture(projectId, initial, head, red, blue);
    }

    private static Map<String, Object> putClip(String clipId, String trackId, MediaArtifact source,
                                               long storyStartTicks, long storyDurationTicks) {
        return Map.of("type", "putClip", "clip", Map.of(
                "clipId", clipId, "sceneId", "scene-main", "trackId", trackId,
                "source", Map.of("artifactId", source.artifactId(), "artifactVersionId", source.version().value()),
                "sourceIn", time(0, "SOURCE_PRESENTATION"), "sourceOut", time(1, "SOURCE_PRESENTATION"),
                "storyStart", time(storyStartTicks, "STORY"), "storyDuration", time(storyDurationTicks, "STORY")));
    }

    private static Map<String, Object> time(long ticks, String clock) {
        return Map.of("ticks", Long.toString(ticks), "rateNumerator", "24", "rateDenominator", "1", "clock", clock);
    }

    private static String createProject(String base, String requestId) throws Exception {
        String workspaceId = (String) read(send(base, "GET", "/dev/v1/context", null, PRINCIPAL,
                RENDER_PERMISSIONS).body()).get("selectedAuthorizedWorkspaceId");
        HttpResponse<String> created = send(base, "POST", "/dev/v1/projects", JSON.writeValueAsString(Map.of(
                "selectedAuthorizedWorkspaceId", workspaceId, "title", "Render " + requestId, "requestId", requestId)),
                PRINCIPAL, RENDER_PERMISSIONS);
        assertThat(created.statusCode()).as(created.body()).isEqualTo(201);
        return (String) object(read(created.body()).get("project")).get("projectId");
    }

    private static String currentHead(String base, String projectId) throws Exception {
        return (String) object(read(send(base, "GET", "/dev/v1/projects/" + projectId, null, PRINCIPAL,
                RENDER_PERMISSIONS).body()).get("currentRevision")).get("revisionId");
    }

    /** Creates timeline-main when createTimeline is true; otherwise applies edits. Returns the new head. */
    private static String edit(String base, String projectId, String timelineId, String head,
                               List<Map<String, Object>> edits, boolean createTimeline) throws Exception {
        HttpResponse<String> response = createTimeline
                ? send(base, "POST", "/dev/v1/projects/" + projectId + "/timelines",
                        JSON.writeValueAsString(Map.of("expectedHeadRevisionId", head, "timelineId", "timeline-main")),
                        PRINCIPAL, RENDER_PERMISSIONS)
                : send(base, "POST", "/dev/v1/projects/" + projectId + "/timelines/" + timelineId + "/edits",
                        JSON.writeValueAsString(Map.of("expectedHeadRevisionId", head, "edits", edits)),
                        PRINCIPAL, RENDER_PERMISSIONS);
        assertThat(response.statusCode()).as(response.body()).isEqualTo(201);
        return (String) object(read(response.body()).get("revision")).get("revisionId");
    }

    private static String renderRequest(String requestId, String revisionId) throws Exception {
        return JSON.writeValueAsString(Map.of("requestId", requestId, "revisionId", revisionId,
                "timelineId", "timeline-main", "width", 32, "height", 24, "framesPerSecond", 10));
    }

    private static MediaArtifact upload(MediaRuntime runtime, String name, String contentType, byte[] bytes,
                                        String key) throws Exception {
        String digest = HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        var session = runtime.beginUpload(new UploadRequest(TENANT, PRINCIPAL, name, contentType, bytes.length,
                digest, "INTERNAL", Duration.ofMinutes(30), Map.of()), key);
        runtime.appendChunk(TENANT, PRINCIPAL, session.uploadId(), 0, bytes);
        return runtime.completeUpload(TENANT, PRINCIPAL, session.uploadId());
    }

    private static byte[] png(int argb) throws Exception {
        BufferedImage image = new BufferedImage(8, 6, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < 6; y++) for (int x = 0; x < 8; x++) image.setRGB(x, y, argb);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    private static byte[] artifactBytes(MediaRuntime runtime, String artifactId) throws Exception {
        MediaArtifact artifact = runtime.artifact(TENANT, PRINCIPAL, artifactId).orElseThrow();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        runtime.copyArtifactContent(TENANT, PRINCIPAL, artifactId, artifact.version(), out, 16 * 1024 * 1024)
                .orElseThrow();
        return out.toByteArray();
    }

    private static List<BufferedImage> decodeGif(byte[] bytes) throws Exception {
        try (ImageInputStream input = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
            ImageReader reader = ImageIO.getImageReadersByFormatName("gif").next();
            reader.setInput(input);
            int count = reader.getNumImages(true);
            java.util.ArrayList<BufferedImage> frames = new java.util.ArrayList<>();
            for (int i = 0; i < count; i++) frames.add(reader.read(i));
            reader.dispose();
            return frames;
        }
    }

    private static MediaRuntime runtime(Path root) {
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "dev", 8093, 1_048_576, 131_072, 1_048_576,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(false),
                new LocalMediaRuntimeSupport.StreamStore(), null,
                List.of(new NoEffectProvider()),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
    }

    private static HttpServer server(MediaRuntime runtime, MediaDevProjectTimelineRuntime projects,
                                     MediaDevProjectRenderRuntime render) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        MediaHttpHandler handler = render == null
                ? new MediaHttpHandler(runtime, null, null, projects)
                : new MediaHttpHandler(runtime, null, null, projects, render);
        server.createContext("/", new MediaSecurityFilter(handler, "dev", devEnvironment(), CLOCK));
        server.start();
        return server;
    }

    private static String base(HttpServer server) { return "http://127.0.0.1:" + server.getAddress().getPort(); }

    private static HttpResponse<String> send(String base, String method, String path, String body,
                                             String principal, Set<String> permissions) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(base + path))
                .header("Authorization", "Bearer " + token(principal, permissions))
                .header("X-Tenant-Id", TENANT);
        if (body != null) request.header("Content-Type", "application/json");
        request.method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private static String token(String principal, Set<String> permissions) throws Exception {
        String header = encode("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        String permissionJson = permissions.stream().sorted().map(permission -> "\"" + permission + "\"")
                .collect(java.util.stream.Collectors.joining(","));
        String payload = "{\"sub\":\"" + principal + "\",\"tenant_id\":\"" + TENANT
                + "\",\"iss\":\"" + ISSUER + "\",\"aud\":\"" + AUDIENCE + "\",\"dev_only\":true,"
                + "\"iat\":" + CLOCK.instant().getEpochSecond() + ",\"exp\":"
                + CLOCK.instant().plusSeconds(120).getEpochSecond() + ",\"permissions\":[" + permissionJson + "]}";
        String signingInput = header + "." + encode(payload);
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return signingInput + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.US_ASCII)));
    }

    private static String encode(String value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static Map<String, String> devEnvironment() {
        return Map.of("MEDIA_DEV_IDENTITY_ENABLED", "true", "MEDIA_DEV_JWT_HMAC_SECRET", SECRET);
    }

    private static Map<String, Object> read(String json) throws Exception {
        return JSON.readValue(json, new TypeReference<Map<String, Object>>() { });
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value) { return (Map<String, Object>) value; }

    private static final class InMemoryManagedStore implements ManagedProjectTimelineStore {
        private final ProjectTimelineStore delegate = new InMemoryProjectTimelineStore();
        @Override public Created create(Actor actor, String workspaceId, String title, String requestId,
                                        String projectId, String initialRevisionId) {
            return delegate.create(actor, workspaceId, title, requestId, projectId, initialRevisionId);
        }
        @Override public Project project(Actor actor, String projectId) { return delegate.project(actor, projectId); }
        @Override public Revision revision(Actor actor, String projectId, String revisionId) {
            return delegate.revision(actor, projectId, revisionId);
        }
        @Override public Revision commit(Actor actor, String projectId, String expectedHeadRevisionId,
                                         String newRevisionId, List<TimelineSnapshot> timelines) {
            return delegate.commit(actor, projectId, expectedHeadRevisionId, newRevisionId, timelines);
        }
        @Override public void close() { }
    }

    private static final class NoEffectProvider implements MediaProcessingProvider {
        @Override public String providerId() { return "dev-render-http-no-effect"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.TRANSCODE); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 0; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            return CompletableFuture.failedFuture(new AssertionError("render routes must not invoke processing"));
        }
    }
}
