package com.ghatana.media.integration;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import tools.jackson.databind.JsonNode;

import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import com.ghatana.media.integration.MediaDevLiveFixtures.StoredArtifact;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * One real launcher process with PostgreSQL + S3 and every DEV_ONLY lane enabled: upload, project, timeline, exact
 * revision render, review of the render, export to a read-back local destination, restart and reopen, then a material
 * edit that makes the earlier revision review STALE while the immutable render stays current.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevProductionJourneyIT {
    private static final String DESTINATION = "dev-local-directory";

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void uploadProjectRenderReviewExportSurvivesRestartAndGoesStaleAfterAnEdit() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-journey-" + run;
        String principal = "media-dev-journey-" + run;
        String bucket = "media-dev-journey-" + run;
        String schema = "media_dev_journey_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-journey-services-");
        Path destination = Files.createTempDirectory("media-dev-journey-destination-").toRealPath();
        Path log = Files.createTempFile("media-dev-journey-process-", ".log");
        Process launcher = null;
        try {
            try (S3Client s3 = s3(LOCALSTACK)) {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.put("MEDIA_DEV_REVIEW_ENABLED", "true");
            environment.put("MEDIA_DELIVERY_DEV_ENABLED", "true");
            environment.put("MEDIA_DELIVERY_DEV_DESTINATION_DIR", destination.toString());
            String ffmpeg = System.getenv("GHATANA_MEDIA_FFMPEG");
            String ffprobe = System.getenv("GHATANA_MEDIA_FFPROBE");
            boolean mp4 = ffmpeg != null && !ffmpeg.isBlank() && ffprobe != null && !ffprobe.isBlank();
            if (mp4) {
                environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg);
                environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe);
            }
            String contentType = mp4 ? "video/mp4" : "image/gif";
            String token = issueDevToken(tenant, principal, "media:delivery:dev:export", "media:delivery:dev:read");
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            // 1. Upload sources (two stills, plus narration for MP4).
            byte[] red = solidPng(0xffff0000);
            byte[] blue = solidPng(0xff0000ff);
            byte[] green = solidPng(0xff00ff00);
            String redId = upload(port, tenant, principal, token, run + "-red", "red.png", "image/png", red);
            String blueId = upload(port, tenant, principal, token, run + "-blue", "blue.png", "image/png", blue);
            String greenId = upload(port, tenant, principal, token, run + "-green", "green.png", "image/png", green);
            byte[] narration = toneWav(48_000, 2);
            String narrationId = mp4
                    ? upload(port, tenant, principal, token, run + "-wav", "narration.wav", "audio/wav", narration)
                    : null;
            // text/vtt must pass the durable store's format verification (signature + UTF-8 without NUL).
            byte[] captions = ("WEBVTT\n\n00:00.250 --> 00:00.750\nHello caption\n\n"
                    + "00:01.000 --> 00:01.500\nSecond cue\n").getBytes(StandardCharsets.UTF_8);
            String captionsId = mp4
                    ? upload(port, tenant, principal, token, run + "-vtt", "captions.vtt", "text/vtt", captions)
                    : null;

            // 2. Project, timeline, scene, tracks, clips.
            String workspaceId = get(port, tenant, token, "/dev/v1/context", 200)
                    .path("selectedAuthorizedWorkspaceId").asString();
            JsonNode created = post(port, tenant, token, "/dev/v1/projects", Map.of(
                    "selectedAuthorizedWorkspaceId", workspaceId, "title", "Production journey " + run,
                    "requestId", "journey-project-" + run), 201);
            String projectId = created.path("project").path("projectId").asString();
            String head = created.path("initialRevision").path("revisionId").asString();
            head = post(port, tenant, token, "/dev/v1/projects/" + projectId + "/timelines", Map.of(
                    "expectedHeadRevisionId", head, "timelineId", "timeline-main"), 201)
                    .path("revision").path("revisionId").asString();
            String editPath = "/dev/v1/projects/" + projectId + "/timelines/timeline-main/edits";
            List<Object> edits = new java.util.ArrayList<>(List.of(
                    Map.of("type", "addScene", "sceneId", "scene-main", "order", 0),
                    Map.of("type", "addTrack", "trackId", "video-main", "sceneId", "scene-main",
                            "trackKind", "VIDEO", "order", 0),
                    stillClip("clip-red", redId, red, 0),
                    stillClip("clip-blue", blueId, blue, 24)));
            if (mp4) {
                edits.add(Map.of("type", "addTrack", "trackId", "audio-main", "sceneId", "scene-main",
                        "trackKind", "AUDIO", "order", 1));
                edits.add(Map.of("type", "putClip", "clip", Map.of(
                        "clipId", "clip-narration", "sceneId", "scene-main", "trackId", "audio-main",
                        "source", Map.of("artifactId", narrationId, "artifactVersionId", "sha256:" + sha256(narration)),
                        "sourceIn", time(0, "SOURCE_PRESENTATION"), "sourceOut", time(48, "SOURCE_PRESENTATION"),
                        "storyStart", time(0, "STORY"), "storyDuration", time(48, "STORY"))));
                edits.add(Map.of("type", "addTrack", "trackId", "caption-main", "sceneId", "scene-main",
                        "trackKind", "CAPTION", "order", 2));
                edits.add(Map.of("type", "putClip", "clip", Map.of(
                        "clipId", "clip-captions", "sceneId", "scene-main", "trackId", "caption-main",
                        "source", Map.of("artifactId", captionsId, "artifactVersionId", "sha256:" + sha256(captions)),
                        "sourceIn", time(0, "SOURCE_PRESENTATION"), "sourceOut", time(48, "SOURCE_PRESENTATION"),
                        "storyStart", time(0, "STORY"), "storyDuration", time(48, "STORY"))));
            }
            String revisionId = post(port, tenant, token, editPath, Map.of(
                    "expectedHeadRevisionId", head, "edits", edits), 201)
                    .path("revision").path("revisionId").asString();

            // 3. Render the exact revision.
            Map<String, Object> renderRequest = new HashMap<>(Map.of("requestId", "journey-render-" + run,
                    "revisionId", revisionId, "timelineId", "timeline-main",
                    "width", 32, "height", 24, "framesPerSecond", 10));
            if (mp4) renderRequest.put("format", "mp4");
            JsonNode render = post(port, tenant, token, "/dev/v1/projects/" + projectId + "/renders",
                    renderRequest, 201);
            String renderId = render.path("renderId").asString();
            String renderVersion = render.path("artifact").path("artifactVersionId").asString();
            String renderSha = render.path("artifact").path("sha256").asString();
            assertThat(render.path("artifact").path("contentType").asString()).isEqualTo(contentType);
            assertThat(render.path("lineage").path("revisionId").asString()).isEqualTo(revisionId);
            if (mp4) {
                JsonNode captionSource = null;
                for (JsonNode source : render.path("lineage").path("sources")) {
                    if ("CAPTION".equals(source.path("trackKind").asString())) captionSource = source;
                }
                assertThat(captionSource).as("caption clip lineage").isNotNull();
                assertThat(captionSource.path("artifactId").asString()).isEqualTo(captionsId);
                assertThat(captionSource.path("artifactVersionId").asString()).isEqualTo("sha256:" + sha256(captions));
                assertThat(captionSource.path("cueCount").asInt()).isEqualTo(2);
            }

            // 4. Review: a case on the project revision and one on the render artifact version.
            String revisionCase = post(port, tenant, token, "/dev/v1/reviews", Map.of("subject", Map.of(
                    "kind", "PROJECT_REVISION", "projectId", projectId, "revisionId", revisionId)), 201)
                    .path("reviewCaseId").asString();
            String renderCase = post(port, tenant, token, "/dev/v1/reviews", Map.of("subject", Map.of(
                    "kind", "ARTIFACT_VERSION", "artifactId", renderId, "artifactVersionId", renderVersion)), 201)
                    .path("reviewCaseId").asString();
            post(port, tenant, token, "/dev/v1/reviews/" + renderCase + "/comments", Map.of(
                    "requestId", "journey-comment-" + run, "expectedCaseRevision", 0,
                    "text", "Journey render looks right", "disposition", "OPEN"), 201);
            // The owner may comment but not decide: an explicitly assigned DEV_ONLY reviewer decides.
            String reviewerToken = issueDevToken(tenant, principal + "-reviewer");
            String expires = java.time.Instant.now().plus(java.time.Duration.ofMinutes(20)).toString();
            for (String assignedCase : List.of(renderCase, revisionCase)) {
                post(port, tenant, token, "/dev/v1/reviews/" + assignedCase + "/assignments", Map.of(
                        "requestId", "journey-assign-" + assignedCase + "-" + run,
                        "expectedCaseRevision", assignedCase.equals(renderCase) ? 1 : 0,
                        "reviewerPrincipalId", principal + "-reviewer", "scopes", List.of("QUALITY"),
                        "expiresAt", expires), 201);
            }
            JsonNode decision = post(port, tenant, reviewerToken, "/dev/v1/reviews/" + renderCase + "/decisions", Map.of(
                    "requestId", "journey-decision-" + run, "expectedCaseRevision", 1, "decision", "ACCEPT",
                    "reason", "DEV_ONLY journey", "scope", "QUALITY", "confirmed", true), 201);
            assertThat(decision.path("establishesApproval").asBoolean()).isFalse();
            JsonNode revisionDecision = post(port, tenant, reviewerToken,
                    "/dev/v1/reviews/" + revisionCase + "/decisions", Map.of(
                    "requestId", "journey-rev-decision-" + run, "expectedCaseRevision", 0, "decision", "ACCEPT",
                    "reason", "DEV_ONLY revision accept", "scope", "QUALITY", "confirmed", true), 201);
            assertThat(revisionDecision.path("establishesApproval").asBoolean()).isFalse();

            // 5. Export the render artifact version to the read-back local destination.
            String exportRequestId = "journey-export-" + run;
            Map<String, Object> exportBody = Map.of("requestId", exportRequestId, "artifactId", renderId,
                    "artifactVersionId", renderVersion, "destinationId", DESTINATION);
            JsonNode exported = post(port, tenant, token, "/dev/v1/exports", exportBody, 201);
            assertThat(exported.path("status").asString()).isEqualTo("DESTINATION_CONFIRMED");
            assertThat(exported.path("destinationConfirmed").asBoolean()).isTrue();
            assertThat(exported.path("artifactDigest").asString()).endsWith(renderSha);
            String receipt = exported.path("destinationReceiptRef").asString();
            assertThat(receipt).startsWith("dev-local-directory-receipt:").endsWith(":" + renderSha.substring(0, 16));
            Path object = destination.resolve(objectName(tenant, principal, exportRequestId) + ".bin");
            StoredArtifact stored = storedArtifact(POSTGRES, tenant, principal, renderId);
            assertThat(stored.contentType()).isEqualTo(contentType);
            assertThat(stored.sha256()).isEqualTo(renderSha);
            byte[] s3Bytes = s3Bytes(LOCALSTACK, bucket, stored);
            assertThat(sha256(s3Bytes)).isEqualTo(renderSha);
            byte[] exportedBytes = Files.readAllBytes(object);
            assertThat(exportedBytes).as("destination bytes equal the S3 object bytes").isEqualTo(s3Bytes);
            assertThat(sha256(exportedBytes)).isEqualTo(renderSha);
            BasicFileAttributes before = Files.readAttributes(object, BasicFileAttributes.class);
            Object inodeBefore = Files.getAttribute(object, "unix:ino");

            // 6. Restart the real launcher and reopen everything.
            stopLauncher(launcher);
            launcher = null;
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            token = issueDevToken(tenant, principal, "media:delivery:dev:export", "media:delivery:dev:read"); // fresh short-lived token after the restart

            JsonNode reopenedRender = get(port, tenant, token,
                    "/dev/v1/projects/" + projectId + "/renders/" + renderId, 200);
            assertThat(reopenedRender.path("artifact").path("sha256").asString()).isEqualTo(renderSha);
            assertThat(reopenedRender.path("lineage")).isEqualTo(render.path("lineage"));

            JsonNode reopenedCase = get(port, tenant, token, "/dev/v1/reviews/" + renderCase, 200);
            assertThat(reopenedCase.path("currentness").asString()).isEqualTo("CURRENT");
            assertThat(reopenedCase.path("caseRevision").asLong()).isEqualTo(2);
            assertThat(reopenedCase.path("records")).hasSize(2);
            assertThat(reopenedCase.path("records").get(0).path("text").asString())
                    .isEqualTo("Journey render looks right");
            assertThat(reopenedCase.path("reviewState").path("establishesApproval").asBoolean()).isFalse();
            assertThat(reopenedCase.path("subject").path("artifactVersionId").asString()).isEqualTo(renderVersion);
            assertThat(get(port, tenant, token, "/dev/v1/reviews/" + revisionCase, 200)
                    .path("currentness").asString()).isEqualTo("CURRENT");

            JsonNode reopenedExport = get(port, tenant, token, "/dev/v1/exports/" + exportRequestId, 200);
            assertThat(reopenedExport.path("status").asString()).isEqualTo("DESTINATION_CONFIRMED");
            assertThat(reopenedExport.path("destinationReceiptRef").asString()).isEqualTo(receipt);
            assertThat(reopenedExport.path("artifactDigest").asString()).endsWith(renderSha);
            JsonNode replay = post(port, tenant, token, "/dev/v1/exports", exportBody, 200);
            assertThat(replay.path("replayed").asBoolean()).isTrue();
            BasicFileAttributes after = Files.readAttributes(object, BasicFileAttributes.class);
            assertThat(after.lastModifiedTime()).isEqualTo(before.lastModifiedTime());
            assertThat(Files.getAttribute(object, "unix:ino")).isEqualTo(inodeBefore);
            assertThat(Files.readAllBytes(object)).isEqualTo(exportedBytes);

            // 7. Foreign principal in the same tenant sees none of it.
            String otherToken = issueDevToken(tenant, principal + "-other",
                    "media:delivery:dev:export", "media:delivery:dev:read");
            for (String path : List.of("/dev/v1/projects/" + projectId + "/renders/" + renderId,
                    "/dev/v1/reviews/" + renderCase, "/dev/v1/reviews/" + revisionCase,
                    "/dev/v1/exports/" + exportRequestId)) {
                HttpResponse<String> foreign = send(port, tenant, otherToken, "GET", path, null);
                assertThat(foreign.statusCode()).as(path + " -> " + foreign.body()).isIn(403, 404);
                assertThat(foreign.body()).doesNotContain(renderSha).doesNotContain("Journey render looks right");
            }
            HttpResponse<String> foreignExport = send(port, tenant, otherToken, "POST", "/dev/v1/exports",
                    JSON.writeValueAsString(Map.of("requestId", "foreign-" + run, "artifactId", renderId,
                            "artifactVersionId", renderVersion, "destinationId", DESTINATION)));
            assertThat(foreignExport.statusCode()).as(foreignExport.body()).isIn(403, 404);
            assertThat(foreignExport.body()).doesNotContain(renderSha);
            assertThat(destination.resolve(objectName(tenant, principal + "-other", "foreign-" + run) + ".bin"))
                    .doesNotExist();

            // 8. Material edit: the revision review goes STALE; the immutable render and its review stay CURRENT.
            String newHead = post(port, tenant, token, editPath, Map.of("expectedHeadRevisionId", revisionId,
                    "edits", List.of(stillClip("clip-green", greenId, green, 48))), 201)
                    .path("revision").path("revisionId").asString();
            assertThat(newHead).isNotEqualTo(revisionId);
            JsonNode staleCase = get(port, tenant, token, "/dev/v1/reviews/" + revisionCase, 200);
            assertThat(staleCase.path("currentness").asString()).isEqualTo("STALE");
            assertThat(staleCase.path("reviewState").path("status").asString()).isEqualTo("DEV_ASSIGNED_REVIEWER_ACCEPT_STALE");
            assertThat(get(port, tenant, token, "/dev/v1/reviews/" + renderCase, 200)
                    .path("currentness").asString()).isEqualTo("CURRENT");

            Map<String, Object> secondRequest = new HashMap<>(renderRequest);
            secondRequest.put("requestId", "journey-render-2-" + run);
            secondRequest.put("revisionId", newHead);
            JsonNode secondRender = post(port, tenant, token, "/dev/v1/projects/" + projectId + "/renders",
                    secondRequest, 201);
            assertThat(secondRender.path("renderId").asString()).isNotEqualTo(renderId);
            assertThat(secondRender.path("artifact").path("sha256").asString()).isNotEqualTo(renderSha);
            assertThat(secondRender.path("lineage").path("revisionId").asString()).isEqualTo(newHead);
            // The first render is untouched.
            assertThat(get(port, tenant, token, "/dev/v1/projects/" + projectId + "/renders/" + renderId, 200)
                    .path("artifact").path("sha256").asString()).isEqualTo(renderSha);
        } finally {
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            Files.deleteIfExists(log);
            deleteTree(services);
            deleteTree(destination);
        }
    }

    private static Map<String, Object> time(long ticks, String clock) {
        return Map.of("ticks", Long.toString(ticks), "rateNumerator", "24", "rateDenominator", "1", "clock", clock);
    }

    private static Map<String, Object> stillClip(String clipId, String artifactId, byte[] bytes, long startTicks)
            throws Exception {
        return Map.of("type", "putClip", "clip", Map.of(
                "clipId", clipId, "sceneId", "scene-main", "trackId", "video-main",
                "source", Map.of("artifactId", artifactId, "artifactVersionId", "sha256:" + sha256(bytes)),
                "sourceIn", time(0, "SOURCE_PRESENTATION"), "sourceOut", time(1, "SOURCE_PRESENTATION"),
                "storyStart", time(startTicks, "STORY"), "storyDuration", time(24, "STORY")));
    }

    private static String objectName(String tenant, String principal, String requestId) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(
                (tenant + "\u0000" + principal + "\u0000" + requestId).getBytes(StandardCharsets.UTF_8)));
    }

    /** Mono 16-bit 440 Hz tone. */
    private static byte[] toneWav(int sampleRate, int seconds) {
        int samples = sampleRate * seconds;
        ByteBuffer wav = ByteBuffer.allocate(44 + samples * 2).order(ByteOrder.LITTLE_ENDIAN);
        wav.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + samples * 2)
                .put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1)
                .putInt(sampleRate).putInt(sampleRate * 2).putShort((short) 2).putShort((short) 16)
                .put("data".getBytes(StandardCharsets.US_ASCII)).putInt(samples * 2);
        for (int i = 0; i < samples; i++) {
            wav.putShort((short) Math.round(8_000 * Math.sin(2 * Math.PI * 440 * i / (double) sampleRate)));
        }
        return wav.array();
    }
}
