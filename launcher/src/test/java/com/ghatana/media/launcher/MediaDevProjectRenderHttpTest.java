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
    static final String TENANT = "tenant-local";
    private static final String PRINCIPAL = "principal-local";
    private static final String OTHER = "principal-other";
    private static final String SECRET = "test-only-dev-project-secret-at-least-32-bytes";
    private static final String ISSUER = "urn:ghatana:media:dev-only";
    private static final String AUDIENCE = "ghatana-media-dev";
    private static final java.time.Clock CLOCK =
            java.time.Clock.fixed(Instant.parse("2026-11-13T20:00:00Z"), java.time.ZoneOffset.UTC);
    static final Set<String> RENDER_PERMISSIONS = Set.of(
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
    void mp4RenderMuxesStillsAndNarrationVerifiesWithFfprobeAndReplaysDeterministically() throws Exception {
        String ffmpeg = tool("GHATANA_MEDIA_FFMPEG");
        String ffprobe = tool("GHATANA_MEDIA_FFPROBE");
        org.junit.jupiter.api.Assumptions.assumeTrue(ffmpeg != null && ffprobe != null,
                "set GHATANA_MEDIA_FFMPEG and GHATANA_MEDIA_FFPROBE to runnable absolute tool paths");
        Path root = Files.createTempDirectory("media-dev-render-mp4-");
        MediaRuntime runtime = runtime(root);
        MediaDevProjectTimelineRuntime projects = new MediaDevProjectTimelineRuntime(new InMemoryManagedStore());
        var renderer = MediaDevProjectRenderRuntime.mp4RendererFrom(Map.of(
                MediaDevProjectRenderRuntime.FFMPEG_ENV, ffmpeg, MediaDevProjectRenderRuntime.FFPROBE_ENV, ffprobe));
        HttpServer server = server(runtime, projects, new MediaDevProjectRenderRuntime(runtime, projects,
                MediaDevProjectRenderRuntime.canonicalRegistrar(runtime), renderer));
        try {
            String base = base(server);
            Fixture fixture = twoClipProject(base, runtime, "mp4-project");
            MediaArtifact narration = upload(runtime, "narration.wav", "audio/wav", toneWav(48_000, 2), "mp4-narration");
            String head = edit(base, fixture.projectId(), "timeline-main", fixture.revisionId(), List.of(
                    Map.of("type", "addTrack", "trackId", "audio-main", "sceneId", "scene-main",
                            "trackKind", "AUDIO", "order", 1),
                    Map.of("type", "putClip", "clip", Map.of(
                            "clipId", "clip-narration", "sceneId", "scene-main", "trackId", "audio-main",
                            "source", Map.of("artifactId", narration.artifactId(),
                                    "artifactVersionId", narration.version().value()),
                            "sourceIn", time(0, "SOURCE_PRESENTATION"), "sourceOut", time(48, "SOURCE_PRESENTATION"),
                            "storyStart", time(0, "STORY"), "storyDuration", time(48, "STORY")))), false);
            String body = JSON.writeValueAsString(Map.of("requestId", "mp4-1", "revisionId", head,
                    "timelineId", "timeline-main", "width", 32, "height", 24, "framesPerSecond", 10, "format", "mp4"));
            HttpResponse<String> rendered = send(base, "POST", "/dev/v1/projects/" + fixture.projectId() + "/renders",
                    body, PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(rendered.statusCode()).as(rendered.body()).isEqualTo(201);
            Map<String, Object> view = read(rendered.body());
            assertThat(object(view.get("artifact"))).containsEntry("contentType", "video/mp4");
            Map<String, Object> lineage = object(view.get("lineage"));
            assertThat(lineage).containsEntry("format", "mp4")
                    .containsEntry("engine", MediaDevProjectRenderRuntime.MP4_ENGINE);
            assertThat(object(lineage.get("encoding"))).containsEntry("videoCodec", "h264")
                    .containsEntry("audioCodec", "aac").containsEntry("videoPtsExact", true);
            assertThat((List<?>) lineage.get("sources")).hasSize(3);

            // Independent verification of the registered bytes with ffprobe/ffmpeg.
            String renderId = (String) view.get("renderId");
            Path mp4 = Files.createTempFile(root, "render-", ".mp4");
            Files.write(mp4, artifactBytes(runtime, renderId));
            String probe = run(ffprobe, "-v", "error", "-show_entries", "stream=codec_name:format=duration",
                    "-of", "default=nw=1", mp4.toString());
            assertThat(probe).contains("codec_name=h264", "codec_name=aac");
            double duration = Double.parseDouble(probe.lines().filter(l -> l.startsWith("duration="))
                    .findFirst().orElseThrow().substring("duration=".length()));
            assertThat(duration).isBetween(1.9, 2.1);
            // Each still is exactly one held frame: PTS 0 (red) then PTS 1 s (blue).
            String pts = run(ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time",
                    "-of", "csv=p=0", mp4.toString());
            assertThat(pts.lines().map(l -> l.strip().replaceAll(",+$", "")).filter(l -> !l.isEmpty()).map(Double::parseDouble).toList())
                    .containsExactly(0.0, 1.0);
            assertThat(decodedFrameColors(ffmpeg, mp4, root)).containsExactly("red", "blue");

            HttpResponse<String> replay = send(base, "POST", "/dev/v1/projects/" + fixture.projectId() + "/renders",
                    body, PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            assertThat(read(replay.body())).containsEntry("renderId", renderId).containsEntry("replayed", true);

            HttpResponse<String> odd = send(base, "POST", "/dev/v1/projects/" + fixture.projectId() + "/renders",
                    JSON.writeValueAsString(Map.of("requestId", "mp4-odd", "revisionId", head,
                            "timelineId", "timeline-main", "width", 33, "height", 24, "framesPerSecond", 10,
                            "format", "mp4")), PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(odd.statusCode()).isEqualTo(422);
            assertThat(odd.body()).contains("RENDER_UNSUPPORTED_FRAME_GEOMETRY");
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    @Test
    void mp4WithoutConfiguredCodecIsTypedUnavailableAndUnknownFormatIsRejected() throws Exception {
        Path root = Files.createTempDirectory("media-dev-render-mp4-off-");
        MediaRuntime runtime = runtime(root);
        MediaDevProjectTimelineRuntime projects = new MediaDevProjectTimelineRuntime(new InMemoryManagedStore());
        HttpServer server = server(runtime, projects, new MediaDevProjectRenderRuntime(runtime, projects,
                MediaDevProjectRenderRuntime.canonicalRegistrar(runtime), null));
        try {
            String base = base(server);
            Fixture fixture = twoClipProject(base, runtime, "mp4-off-project");
            HttpResponse<String> unavailable = send(base, "POST", "/dev/v1/projects/" + fixture.projectId() + "/renders",
                    JSON.writeValueAsString(Map.of("requestId", "mp4-off", "revisionId", fixture.revisionId(),
                            "timelineId", "timeline-main", "width", 32, "height", 24, "framesPerSecond", 10,
                            "format", "mp4")), PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(unavailable.statusCode()).as(unavailable.body()).isEqualTo(503);
            assertThat(unavailable.body()).contains("RENDER_CODEC_UNAVAILABLE");
            HttpResponse<String> unknown = send(base, "POST", "/dev/v1/projects/" + fixture.projectId() + "/renders",
                    JSON.writeValueAsString(Map.of("requestId", "webm", "revisionId", fixture.revisionId(),
                            "timelineId", "timeline-main", "width", 32, "height", 24, "framesPerSecond", 10,
                            "format", "webm")), PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(unknown.statusCode()).isEqualTo(400);
            assertThatThrownBy(() -> MediaDevProjectRenderRuntime.mp4RendererFrom(Map.of(
                    MediaDevProjectRenderRuntime.FFMPEG_ENV, "ffmpeg", MediaDevProjectRenderRuntime.FFPROBE_ENV, "ffprobe")))
                    .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("absolute");
            assertThat(MediaDevProjectRenderRuntime.mp4RendererFrom(Map.of())).isNull();
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    private static Map<String, Object> audioClip(String clipId, String trackId, MediaArtifact artifact,
                                                 long sourceTicks, long startTicks, long durationTicks) {
        return Map.of("type", "putClip", "clip", Map.of(
                "clipId", clipId, "sceneId", "scene-main", "trackId", trackId,
                "source", Map.of("artifactId", artifact.artifactId(), "artifactVersionId", artifact.version().value()),
                "sourceIn", time(0, "SOURCE_PRESENTATION"), "sourceOut", time(sourceTicks, "SOURCE_PRESENTATION"),
                "storyStart", time(startTicks, "STORY"), "storyDuration", time(durationTicks, "STORY")));
    }

    private static byte[] pcmWav(int sampleRate, int channels, double seconds, double hz) {
        int frames = (int) Math.round(sampleRate * seconds);
        java.nio.ByteBuffer wav = java.nio.ByteBuffer.allocate(44 + frames * channels * 2)
                .order(java.nio.ByteOrder.LITTLE_ENDIAN);
        wav.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + frames * channels * 2)
                .put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1)
                .putShort((short) channels).putInt(sampleRate).putInt(sampleRate * channels * 2)
                .putShort((short) (channels * 2)).putShort((short) 16)
                .put("data".getBytes(StandardCharsets.US_ASCII)).putInt(frames * channels * 2);
        for (int i = 0; i < frames; i++) {
            short v = (short) Math.round(8_000 * Math.sin(2 * Math.PI * hz * i / sampleRate));
            for (int c = 0; c < channels; c++) wav.putShort(v);
        }
        return wav.array();
    }

    /** Decodes the MP4 audio with FFmpeg to mono 48 kHz s16le and returns the samples. */
    private static short[] decodedAudio(String ffmpeg, Path mp4) throws Exception {
        Process p = new ProcessBuilder(ffmpeg, "-v", "error", "-i", mp4.toString(), "-map", "0:a:0", "-f", "s16le",
                "-ac", "1", "-ar", "48000", "-").start();
        byte[] pcm = p.getInputStream().readAllBytes();
        assertThat(p.waitFor()).isZero();
        short[] out = new short[pcm.length / 2];
        java.nio.ByteBuffer.wrap(pcm).order(java.nio.ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(out);
        return out;
    }

    private static double rms(short[] pcm, double from, double to) {
        int a = (int) (from * 48_000), z = Math.min((int) (to * 48_000), pcm.length);
        double sum = 0;
        for (int i = a; i < z; i++) sum += (double) pcm[i] * pcm[i];
        return Math.sqrt(sum / Math.max(1, z - a));
    }

    /** Goertzel amplitude of one frequency in [from, to) seconds (peak-equivalent sample units). */
    private static double toneAmplitude(short[] pcm, double from, double to, double hz) {
        int a = (int) (from * 48_000), z = Math.min((int) (to * 48_000), pcm.length);
        double re = 0, im = 0;
        for (int i = a; i < z; i++) {
            double ph = 2 * Math.PI * hz * (i - a) / 48_000.0;
            re += pcm[i] * Math.cos(ph);
            im -= pcm[i] * Math.sin(ph);
        }
        return 2 * Math.sqrt(re * re + im * im) / Math.max(1, z - a);
    }

    private String mp4Head(String base, Fixture fixture, List<Map<String, Object>> clipEdits, int audioTracks)
            throws Exception {
        List<Map<String, Object>> edits = new java.util.ArrayList<>();
        for (int i = 0; i < audioTracks; i++) {
            edits.add(Map.of("type", "addTrack", "trackId", "audio-" + i, "sceneId", "scene-main",
                    "trackKind", "AUDIO", "order", i + 1));
        }
        String head = edit(base, fixture.projectId(), "timeline-main", fixture.revisionId(), edits, false);
        return edit(base, fixture.projectId(), "timeline-main", head, clipEdits, false);
    }

    private static String mp4Body(String requestId, String head) throws Exception {
        return JSON.writeValueAsString(Map.of("requestId", requestId, "revisionId", head,
                "timelineId", "timeline-main", "width", 32, "height", 24, "framesPerSecond", 10, "format", "mp4"));
    }

    @Test
    void mp4MixesSeveralAudioClipsWithExactPlacementAndRecordsLineage() throws Exception {
        String ffmpeg = tool("GHATANA_MEDIA_FFMPEG");
        String ffprobe = tool("GHATANA_MEDIA_FFPROBE");
        org.junit.jupiter.api.Assumptions.assumeTrue(ffmpeg != null && ffprobe != null,
                "set GHATANA_MEDIA_FFMPEG and GHATANA_MEDIA_FFPROBE to runnable absolute tool paths");
        Path root = Files.createTempDirectory("media-dev-render-mix-");
        MediaRuntime runtime = runtime(root);
        MediaDevProjectTimelineRuntime projects = new MediaDevProjectTimelineRuntime(new InMemoryManagedStore());
        var renderer = MediaDevProjectRenderRuntime.mp4RendererFrom(Map.of(
                MediaDevProjectRenderRuntime.FFMPEG_ENV, ffmpeg, MediaDevProjectRenderRuntime.FFPROBE_ENV, ffprobe));
        HttpServer server = server(runtime, projects, new MediaDevProjectRenderRuntime(runtime, projects,
                MediaDevProjectRenderRuntime.canonicalRegistrar(runtime), renderer));
        try {
            String base = base(server);
            Fixture fixture = twoClipProject(base, runtime, "mix-project");
            MediaArtifact a = upload(runtime, "a.wav", "audio/wav", pcmWav(48_000, 2, 1.0, 440), "mix-a");
            MediaArtifact b = upload(runtime, "b.wav", "audio/wav", pcmWav(48_000, 2, 0.5, 1_000), "mix-b");
            MediaArtifact c = upload(runtime, "c.wav", "audio/wav", pcmWav(48_000, 2, 0.5, 2_000), "mix-c");
            // timeline 2 s: A 440 Hz [0,1.0); B 1 kHz [0.5,1.0) overlapping A on another track; C 2 kHz [1.5,2.0)
            String head = mp4Head(base, fixture, List.of(
                    audioClip("clip-a", "audio-0", a, 24, 0, 24),
                    audioClip("clip-b", "audio-1", b, 12, 12, 12),
                    audioClip("clip-c", "audio-1", c, 12, 36, 12)), 2);
            // clip-b starts at story tick 12 = 0.5 s; adjust expectation accordingly below
            String body = mp4Body("mix-1", head);
            HttpResponse<String> rendered = send(base, "POST", "/dev/v1/projects/" + fixture.projectId() + "/renders",
                    body, PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(rendered.statusCode()).as(rendered.body()).isEqualTo(201);
            Map<String, Object> view = read(rendered.body());
            Map<String, Object> lineage = object(view.get("lineage"));
            assertThat((List<?>) lineage.get("sources")).hasSize(5);
            assertThat(object(lineage.get("encoding"))).containsEntry("audioCodec", "aac")
                    .containsEntry("videoPtsExact", true);
            Map<String, Object> mix = object(lineage.get("audioMix"));
            assertThat(mix).containsEntry("engine", "production.audio.PcmStemMixer")
                    .containsEntry("sampleRate", 48_000).containsEntry("channels", 2)
                    .containsEntry("frameCount", 96_000).containsEntry("timelineDurationSeconds", "2/1");
            assertThat((String) mix.get("mixedWavSha256")).matches("[0-9a-f]{64}");
            assertThat(object(mix.get("rightsDecision"))).containsEntry("productionGrant", false);
            List<Map<String, Object>> mixClips = new java.util.ArrayList<>();
            for (Object entry : (List<?>) mix.get("clips")) mixClips.add(object(entry));
            assertThat(mixClips).hasSize(3);
            assertThat(mixClips.get(0)).containsEntry("clipId", "clip-a").containsEntry("artifactId", a.artifactId())
                    .containsEntry("artifactVersionId", a.version().value()).containsEntry("storyOffsetSeconds", "0/1")
                    .containsEntry("storyOffsetFrames", 0).containsEntry("gain", 1.0);
            assertThat(mixClips.get(1)).containsEntry("artifactVersionId", b.version().value())
                    .containsEntry("storyOffsetSeconds", "1/2").containsEntry("storyOffsetFrames", 24_000);
            assertThat(mixClips.get(2)).containsEntry("artifactVersionId", c.version().value())
                    .containsEntry("storyOffsetSeconds", "3/2").containsEntry("storyOffsetFrames", 72_000);

            Path mp4 = Files.createTempFile(root, "mix-", ".mp4");
            Files.write(mp4, artifactBytes(runtime, (String) view.get("renderId")));
            short[] pcm = decodedAudio(ffmpeg, mp4);
            assertThat(pcm.length / 48_000.0).isBetween(1.9, 2.1);
            // window 0.1-0.4: only A; 0.6-0.9: A and B; 1.1-1.4: silence; 1.6-1.9: only C
            assertThat(toneAmplitude(pcm, 0.1, 0.4, 440)).isBetween(6_000.0, 10_000.0);
            assertThat(toneAmplitude(pcm, 0.1, 0.4, 1_000)).isLessThan(500.0);
            assertThat(toneAmplitude(pcm, 0.6, 0.9, 440)).isBetween(5_500.0, 10_500.0);
            assertThat(toneAmplitude(pcm, 0.6, 0.9, 1_000)).isBetween(5_500.0, 10_500.0);
            assertThat(toneAmplitude(pcm, 0.6, 0.9, 2_000)).isLessThan(500.0);
            assertThat(rms(pcm, 1.1, 1.4)).isLessThan(150.0);
            assertThat(toneAmplitude(pcm, 1.6, 1.9, 2_000)).isBetween(6_000.0, 10_000.0);
            assertThat(toneAmplitude(pcm, 1.6, 1.9, 440)).isLessThan(500.0);

            HttpResponse<String> replay = send(base, "POST", "/dev/v1/projects/" + fixture.projectId() + "/renders",
                    body, PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            assertThat(read(replay.body())).containsEntry("renderId", view.get("renderId"));
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    @Test
    void mp4AudioMixInputsThatDoNotFitAreTyped422WithoutResampling() throws Exception {
        String ffmpeg = tool("GHATANA_MEDIA_FFMPEG");
        String ffprobe = tool("GHATANA_MEDIA_FFPROBE");
        org.junit.jupiter.api.Assumptions.assumeTrue(ffmpeg != null && ffprobe != null,
                "set GHATANA_MEDIA_FFMPEG and GHATANA_MEDIA_FFPROBE to runnable absolute tool paths");
        Path root = Files.createTempDirectory("media-dev-render-mix-422-");
        MediaRuntime runtime = runtime(root);
        MediaDevProjectTimelineRuntime projects = new MediaDevProjectTimelineRuntime(new InMemoryManagedStore());
        var renderer = MediaDevProjectRenderRuntime.mp4RendererFrom(Map.of(
                MediaDevProjectRenderRuntime.FFMPEG_ENV, ffmpeg, MediaDevProjectRenderRuntime.FFPROBE_ENV, ffprobe));
        HttpServer server = server(runtime, projects, new MediaDevProjectRenderRuntime(runtime, projects,
                MediaDevProjectRenderRuntime.canonicalRegistrar(runtime), renderer));
        try {
            String base = base(server);
            Fixture mono = twoClipProject(base, runtime, "mix-mono");
            MediaArtifact m1 = upload(runtime, "m1.wav", "audio/wav", pcmWav(48_000, 1, 0.5, 440), "mix-m1");
            MediaArtifact m2 = upload(runtime, "m2.wav", "audio/wav", pcmWav(48_000, 1, 0.5, 880), "mix-m2");
            String monoHead = mp4Head(base, mono, List.of(
                    audioClip("m-1", "audio-0", m1, 12, 0, 12), audioClip("m-2", "audio-1", m2, 12, 24, 12)), 2);
            HttpResponse<String> monoResponse = send(base, "POST", "/dev/v1/projects/" + mono.projectId() + "/renders",
                    mp4Body("mono", monoHead), PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(monoResponse.statusCode()).as(monoResponse.body()).isEqualTo(422);
            assertThat(monoResponse.body()).contains("RENDER_UNSUPPORTED_AUDIO_LAYOUT");

            Fixture mixedRates = twoClipProject(base, runtime, "mix-rates");
            MediaArtifact r48 = upload(runtime, "r48.wav", "audio/wav", pcmWav(48_000, 2, 0.5, 440), "mix-r48");
            MediaArtifact r44 = upload(runtime, "r44.wav", "audio/wav", pcmWav(44_100, 2, 0.5, 440), "mix-r44");
            String ratesHead = mp4Head(base, mixedRates, List.of(
                    audioClip("r-1", "audio-0", r48, 12, 0, 12), audioClip("r-2", "audio-1", r44, 12, 24, 12)), 2);
            HttpResponse<String> ratesResponse = send(base, "POST",
                    "/dev/v1/projects/" + mixedRates.projectId() + "/renders", mp4Body("rates", ratesHead),
                    PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(ratesResponse.statusCode()).as(ratesResponse.body()).isEqualTo(422);
            assertThat(ratesResponse.body()).contains("RENDER_UNSUPPORTED_AUDIO_FORMAT");

            Fixture fractional = twoClipProject(base, runtime, "mix-frac");
            MediaArtifact f1 = upload(runtime, "f1.wav", "audio/wav", pcmWav(44_100, 2, 0.5, 440), "mix-f1");
            MediaArtifact f2 = upload(runtime, "f2.wav", "audio/wav", pcmWav(44_100, 2, 0.5, 880), "mix-f2");
            // 44.1 kHz at 24 ticks/s: story tick 1 is 1837.5 samples, not a whole sample
            String fracHead = mp4Head(base, fractional, List.of(
                    audioClip("f-1", "audio-0", f1, 12, 0, 12), audioClip("f-2", "audio-1", f2, 12, 25, 12)), 2);
            HttpResponse<String> fracResponse = send(base, "POST",
                    "/dev/v1/projects/" + fractional.projectId() + "/renders", mp4Body("frac", fracHead),
                    PRINCIPAL, RENDER_PERMISSIONS);
            assertThat(fracResponse.statusCode()).as(fracResponse.body()).isEqualTo(422);
            assertThat(fracResponse.body()).contains("RENDER_UNSUPPORTED_AUDIO_FORMAT");
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    private static String tool(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) value = System.getProperty(name.toLowerCase(java.util.Locale.ROOT)
                .replace('_', '.'));
        if (value == null || value.isBlank() || !Path.of(value).isAbsolute() || !Files.isExecutable(Path.of(value))) {
            return null;
        }
        try {
            new ProcessBuilder(value, "-version").redirectErrorStream(true).start().waitFor();
            Process check = new ProcessBuilder(value, "-version").redirectErrorStream(true).start();
            check.getInputStream().readAllBytes();
            return check.waitFor() == 0 ? value : null;
        } catch (Exception unavailable) {
            return null;
        }
    }

    private static String run(String... command) throws Exception {
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(process.waitFor()).as(output).isZero();
        return output;
    }

    private static List<String> decodedFrameColors(String ffmpeg, Path mp4, Path root) throws Exception {
        Path frames = Files.createDirectories(root.resolve("frames"));
        run(ffmpeg, "-v", "error", "-y", "-i", mp4.toString(), "-fps_mode", "passthrough",
                frames.resolve("f-%03d.png").toString());
        try (var files = Files.list(frames)) {
            return files.sorted().map(path -> {
                try {
                    BufferedImage frame = ImageIO.read(path.toFile());
                    int rgb = frame.getRGB(frame.getWidth() / 2, frame.getHeight() / 2);
                    int r = (rgb >> 16) & 0xff, g = (rgb >> 8) & 0xff, b = rgb & 0xff;
                    if (r > 180 && g < 80 && b < 80) return "red";
                    if (b > 180 && r < 80 && g < 80) return "blue";
                    return String.format("rgb(%d,%d,%d)", r, g, b);
                } catch (java.io.IOException failure) {
                    throw new java.io.UncheckedIOException(failure);
                }
            }).toList();
        }
    }

    private static byte[] toneWav(int sampleRate, int seconds) {
        int samples = sampleRate * seconds;
        java.nio.ByteBuffer wav = java.nio.ByteBuffer.allocate(44 + samples * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        wav.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + samples * 2)
                .put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1)
                .putInt(sampleRate).putInt(sampleRate * 2).putShort((short) 2).putShort((short) 16)
                .put("data".getBytes(StandardCharsets.US_ASCII)).putInt(samples * 2);
        for (int i = 0; i < samples; i++) {
            wav.putShort((short) Math.round(8_000 * Math.sin(2 * Math.PI * 440 * i / (double) sampleRate)));
        }
        return wav.array();
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

    record Fixture(String projectId, String initialRevisionId, String revisionId,
                           MediaArtifact redArtifact, MediaArtifact blueArtifact) { }

    static Fixture twoClipProject(String base, MediaRuntime runtime, String key) throws Exception {
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

    static String renderRequest(String requestId, String revisionId) throws Exception {
        return JSON.writeValueAsString(Map.of("requestId", requestId, "revisionId", revisionId,
                "timelineId", "timeline-main", "width", 32, "height", 24, "framesPerSecond", 10));
    }

    private static MediaArtifact upload(MediaRuntime runtime, String name, String contentType, byte[] bytes,
                                        String key) throws Exception {
        String digest = HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        var session = runtime.beginUpload(new UploadRequest(TENANT, PRINCIPAL, name, contentType, bytes.length,
                digest, "INTERNAL", Duration.ofMinutes(30), Map.of()), key);
        int chunk = runtime.config().maximumChunkBytes();
        for (int offset = 0, index = 0; offset < bytes.length; offset += chunk, index++) {
            runtime.appendChunk(TENANT, PRINCIPAL, session.uploadId(), index,
                    java.util.Arrays.copyOfRange(bytes, offset, Math.min(bytes.length, offset + chunk)));
        }
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
        return runtime(root, MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT,
                MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT_PER_TENANT);
    }

    static MediaRuntime runtime(Path root, int renderGlobal, int renderPerTenant) {
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "dev", 8093, 1_048_576, 131_072, 1_048_576,
                        Duration.ofSeconds(2), 2, "", "", true, false, root, 0, renderGlobal, renderPerTenant),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(false),
                new LocalMediaRuntimeSupport.StreamStore(), null,
                List.of(new NoEffectProvider()),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
    }

    static HttpServer server(MediaRuntime runtime, MediaDevProjectTimelineRuntime projects,
                                     MediaDevProjectRenderRuntime render) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        MediaHttpHandler handler = render == null
                ? new MediaHttpHandler(runtime, null, null, projects)
                : new MediaHttpHandler(runtime, null, null, projects, render);
        server.createContext("/", new MediaSecurityFilter(handler, "dev", devEnvironment(), CLOCK));
        // Concurrent handling is required by the admission-control tests; other tests are unaffected.
        server.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
        server.start();
        return server;
    }

    static String base(HttpServer server) { return "http://127.0.0.1:" + server.getAddress().getPort(); }

    static HttpResponse<String> send(String base, String method, String path, String body,
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

    static Map<String, Object> read(String json) throws Exception {
        return JSON.readValue(json, new TypeReference<Map<String, Object>>() { });
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> object(Object value) { return (Map<String, Object>) value; }

    static final class InMemoryManagedStore implements ManagedProjectTimelineStore {
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

    static final class NoEffectProvider implements MediaProcessingProvider {
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
