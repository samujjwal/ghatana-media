package com.ghatana.media.integration;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.DriverManager;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.FutureTask;

import static com.ghatana.media.integration.MediaLauncherProcessFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** Exercises the DEV_ONLY project/timeline routes through a real launcher restart. */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevProjectTimelineRestartIT {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String DEV_SECRET = "media-dev-project-timeline-restart-secret";

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void ownerProjectTimelineCanBeReopenedAfterLauncherRestart() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-project-" + run;
        String principal = "media-dev-owner-" + run;
        String bucket = "media-dev-project-" + run;
        String schema = "media_dev_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-project-services-");
        Path log = Files.createTempFile("media-dev-project-process-", ".log");
        Process launcher = null;
        try {
            try (S3Client s3 = s3()) {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = environment(bucket, port, schema);
            String token = issueDevToken(tenant, principal);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            HttpResponse<String> context = send(port, tenant, token, "GET", "/dev/v1/context", null);
            assertThat(context.statusCode()).as(context.body()).isEqualTo(200);
            JsonNode contextBody = JSON.readTree(context.body());
            assertThat(contextBody.path("scope").asString()).isEqualTo("DEV_ONLY");
            assertThat(contextBody.path("authority").asString())
                    .contains("no Shared membership or production authority");
            String workspaceId = contextBody.path("selectedAuthorizedWorkspaceId").asString();
            assertThat(workspaceId).startsWith("dev-workspace.");

            String requestId = "dev-project-create-" + run;
            HttpResponse<String> created = send(port, tenant, token, "POST", "/dev/v1/projects",
                    JSON.writeValueAsString(Map.of("selectedAuthorizedWorkspaceId", workspaceId,
                            "title", "Restart-persisted project", "requestId", requestId)));
            assertThat(created.statusCode()).as(created.body()).isEqualTo(201);
            JsonNode createdBody = JSON.readTree(created.body());
            String projectId = createdBody.path("project").path("projectId").asString();
            String initialRevisionId = createdBody.path("initialRevision").path("revisionId").asString();
            assertThat(projectId).isNotBlank();
            assertThat(initialRevisionId).isNotBlank();
            assertThat(createdBody.path("initialRevision").path("timelines").isEmpty()).isTrue();

            HttpResponse<String> timeline = send(port, tenant, token, "POST",
                    "/dev/v1/projects/" + projectId + "/timelines",
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", initialRevisionId,
                            "timelineId", "timeline-main")));
            assertThat(timeline.statusCode()).as(timeline.body()).isEqualTo(201);
            JsonNode timelineRevision = JSON.readTree(timeline.body()).path("revision");
            String timelineRevisionId = timelineRevision.path("revisionId").asString();
            assertThat(timelineRevision.path("parentRevisionId").asString()).isEqualTo(initialRevisionId);
            assertThat(timelineRevision.path("timelines").get(0).path("graph").path("timelineId").asString())
                    .isEqualTo("timeline-main");
            assertThat(timelineRevision.path("timelines").get(0).path("semanticVersionId").asString())
                    .isNotBlank();

            stopLauncher(launcher);
            launcher = null;
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            HttpResponse<String> reopened = send(port, tenant, token, "GET",
                    "/dev/v1/projects/" + projectId, null);
            assertThat(reopened.statusCode()).as(reopened.body()).isEqualTo(200);
            JsonNode reopenedBody = JSON.readTree(reopened.body());
            assertThat(reopenedBody.path("currentRevision").path("revisionId").asString())
                    .isEqualTo(timelineRevisionId);
            assertThat(reopenedBody.path("currentRevision").path("timelines").get(0)
                    .path("graph").path("timelineId").asString()).isEqualTo("timeline-main");

            HttpResponse<String> exactInitial = send(port, tenant, token, "GET",
                    "/dev/v1/projects/" + projectId + "/revisions/" + initialRevisionId, null);
            assertThat(exactInitial.statusCode()).as(exactInitial.body()).isEqualTo(200);
            assertThat(JSON.readTree(exactInitial.body()).path("revision").path("timelines").isEmpty()).isTrue();

            HttpResponse<String> replay = send(port, tenant, token, "POST", "/dev/v1/projects",
                    JSON.writeValueAsString(Map.of("selectedAuthorizedWorkspaceId", workspaceId,
                            "title", "Restart-persisted project", "requestId", requestId)));
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            assertThat(JSON.readTree(replay.body()).path("createdNow").asBoolean()).isFalse();
            assertThat(JSON.readTree(replay.body()).path("project").path("projectId").asString())
                    .isEqualTo(projectId);

            String otherOwnerToken = issueDevToken(tenant, "media-dev-other-" + run);
            HttpResponse<String> wrongOwner = send(port, tenant, otherOwnerToken, "GET",
                    "/dev/v1/projects/" + projectId, null);
            assertThat(wrongOwner.statusCode()).as(wrongOwner.body()).isEqualTo(403);
            assertProjectAccessDeniedWithoutDisclosure(wrongOwner, projectId, initialRevisionId,
                    timelineRevisionId, "Restart-persisted project");

            String otherTenant = "tenant-dev-other-" + run;
            String otherTenantToken = issueDevToken(otherTenant, principal);
            HttpResponse<String> wrongTenant = send(port, otherTenant, otherTenantToken, "GET",
                    "/dev/v1/projects/" + projectId, null);
            assertThat(wrongTenant.statusCode()).as(wrongTenant.body()).isEqualTo(404);
            assertProjectAccessDeniedWithoutDisclosure(wrongTenant, projectId, initialRevisionId,
                    timelineRevisionId, "Restart-persisted project");
        } finally {
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(schema);
            deleteBucket(bucket);
            Files.deleteIfExists(log);
            if (Files.exists(services)) try (var paths = Files.walk(services)) {
                paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                    try { Files.deleteIfExists(path); } catch (Exception ignored) { }
                });
            }
        }
    }

    @Test
    void projectRevisionRendersRegisteredArtifactThatReopensAfterLauncherRestart() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-render-" + run;
        String principal = "media-dev-render-" + run;
        String bucket = "media-dev-render-" + run;
        String schema = "media_dev_render_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-render-services-");
        Path log = Files.createTempFile("media-dev-render-process-", ".log");
        Process launcher = null;
        try {
            try (S3Client s3 = s3()) {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = new HashMap<>(environment(bucket, port, schema));
            String ffmpeg = System.getenv("GHATANA_MEDIA_FFMPEG");
            String ffprobe = System.getenv("GHATANA_MEDIA_FFPROBE");
            boolean mp4 = ffmpeg != null && !ffmpeg.isBlank() && ffprobe != null && !ffprobe.isBlank();
            if (mp4) {
                environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg);
                environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe);
            }
            String token = issueDevToken(tenant, principal, true);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            byte[] red = solidPng(0xffff0000);
            byte[] blue = solidPng(0xff0000ff);
            String redId = uploadOwnedImageArtifact(port, tenant, principal, token, run + "-red", red);
            String blueId = uploadOwnedImageArtifact(port, tenant, principal, token, run + "-blue", blue);

            String workspaceId = JSON.readTree(send(port, tenant, token, "GET", "/dev/v1/context", null).body())
                    .path("selectedAuthorizedWorkspaceId").asString();
            HttpResponse<String> created = send(port, tenant, token, "POST", "/dev/v1/projects",
                    JSON.writeValueAsString(Map.of("selectedAuthorizedWorkspaceId", workspaceId,
                            "title", "Render restart project", "requestId", "render-project-" + run)));
            assertThat(created.statusCode()).as(created.body()).isEqualTo(201);
            JsonNode createdBody = JSON.readTree(created.body());
            String projectId = createdBody.path("project").path("projectId").asString();
            String head = createdBody.path("initialRevision").path("revisionId").asString();
            HttpResponse<String> timeline = send(port, tenant, token, "POST",
                    "/dev/v1/projects/" + projectId + "/timelines",
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", head, "timelineId", "timeline-main")));
            assertThat(timeline.statusCode()).as(timeline.body()).isEqualTo(201);
            head = JSON.readTree(timeline.body()).path("revision").path("revisionId").asString();
            String editPath = "/dev/v1/projects/" + projectId + "/timelines/timeline-main/edits";
            HttpResponse<String> edited = send(port, tenant, token, "POST", editPath, JSON.writeValueAsString(Map.of(
                    "expectedHeadRevisionId", head, "edits", List.of(
                            Map.of("type", "addScene", "sceneId", "scene-main", "order", 0),
                            Map.of("type", "addTrack", "trackId", "video-main", "sceneId", "scene-main",
                                    "trackKind", "VIDEO", "order", 0),
                            renderClip("clip-red", redId, sha256(red), 0),
                            renderClip("clip-blue", blueId, sha256(blue), 24)))));
            assertThat(edited.statusCode()).as(edited.body()).isEqualTo(201);
            String revisionId = JSON.readTree(edited.body()).path("revision").path("revisionId").asString();

            String renderBody = JSON.writeValueAsString(Map.of("requestId", "render-" + run,
                    "revisionId", revisionId, "timelineId", "timeline-main",
                    "width", 32, "height", 24, "framesPerSecond", 10));
            HttpResponse<String> rendered = send(port, tenant, token, "POST",
                    "/dev/v1/projects/" + projectId + "/renders", renderBody);
            assertThat(rendered.statusCode()).as(rendered.body()).isEqualTo(201);
            JsonNode render = JSON.readTree(rendered.body());
            String renderId = render.path("renderId").asString();
            String renderSha = render.path("artifact").path("sha256").asString();
            assertThat(render.path("lineage").path("revisionId").asString()).isEqualTo(revisionId);
            assertThat(render.path("lineage").path("sources").get(0).path("artifactVersionId").asString())
                    .isEqualTo("sha256:" + sha256(red));

            String mp4Id = null;
            String mp4Sha = null;
            if (mp4) {
                HttpResponse<String> mp4Rendered = send(port, tenant, token, "POST",
                        "/dev/v1/projects/" + projectId + "/renders", JSON.writeValueAsString(Map.of(
                                "requestId", "render-mp4-" + run, "revisionId", revisionId,
                                "timelineId", "timeline-main", "width", 32, "height", 24,
                                "framesPerSecond", 10, "format", "mp4")));
                assertThat(mp4Rendered.statusCode()).as(mp4Rendered.body()).isEqualTo(201);
                JsonNode mp4Body = JSON.readTree(mp4Rendered.body());
                mp4Id = mp4Body.path("renderId").asString();
                mp4Sha = mp4Body.path("artifact").path("sha256").asString();
                assertThat(mp4Body.path("artifact").path("contentType").asString()).isEqualTo("video/mp4");
                assertThat(mp4Body.path("lineage").path("encoding").path("videoCodec").asString()).isEqualTo("h264");
                assertThat(mp4Body.path("lineage").path("encoding").path("videoPtsExact").asBoolean()).isTrue();
            }

            // Kill and restart the real launcher process; the same media reopens from PostgreSQL + S3.
            stopLauncher(launcher);
            launcher = null;
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            HttpResponse<String> reopened = send(port, tenant, token, "GET",
                    "/dev/v1/projects/" + projectId + "/renders/" + renderId, null);
            assertThat(reopened.statusCode()).as(reopened.body()).isEqualTo(200);
            JsonNode reopenedBody = JSON.readTree(reopened.body());
            assertThat(reopenedBody.path("artifact").path("sha256").asString()).isEqualTo(renderSha);
            assertThat(reopenedBody.path("lineage")).isEqualTo(render.path("lineage"));

            HttpResponse<String> replay = send(port, tenant, token, "POST",
                    "/dev/v1/projects/" + projectId + "/renders", renderBody);
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            assertThat(JSON.readTree(replay.body()).path("renderId").asString()).isEqualTo(renderId);
            assertThat(JSON.readTree(replay.body()).path("replayed").asBoolean()).isTrue();

            // Independent decode of the durable object bytes.
            String objectReference;
            try (var connection = DriverManager.getConnection(
                         POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                    var statement = connection.prepareStatement(
                            "SELECT object_reference, content_type, sha256 FROM media_artifacts "
                                    + "WHERE tenant_id=? AND artifact_id=? AND principal_id=?")) {
                statement.setString(1, tenant);
                statement.setString(2, renderId);
                statement.setString(3, principal);
                try (var row = statement.executeQuery()) {
                    assertThat(row.next()).isTrue();
                    assertThat(row.getString("content_type")).isEqualTo("image/gif");
                    assertThat(row.getString("sha256")).isEqualTo(renderSha);
                    objectReference = row.getString("object_reference");
                    assertThat(row.next()).as("exactly one durable render artifact").isFalse();
                }
            }
            String key = objectReference.substring(("s3://" + bucket + "/").length());
            byte[] gif;
            try (S3Client s3 = s3()) {
                gif = s3.getObjectAsBytes(software.amazon.awssdk.services.s3.model.GetObjectRequest.builder()
                        .bucket(bucket).key(key).build()).asByteArray();
            }
            assertThat(sha256(gif)).isEqualTo(renderSha);
            try (var input = javax.imageio.ImageIO.createImageInputStream(new java.io.ByteArrayInputStream(gif))) {
                var reader = javax.imageio.ImageIO.getImageReadersByFormatName("gif").next();
                reader.setInput(input);
                assertThat(reader.getNumImages(true)).isEqualTo(20);
                assertThat(reader.read(5).getRGB(16, 12)).isEqualTo(0xffff0000);
                assertThat(reader.read(15).getRGB(16, 12)).isEqualTo(0xff0000ff);
                reader.dispose();
            }

            String otherToken = issueDevToken(tenant, "media-dev-render-other-" + run, true);
            HttpResponse<String> foreign = send(port, tenant, otherToken, "GET",
                    "/dev/v1/projects/" + projectId + "/renders/" + renderId, null);
            assertThat(foreign.statusCode()).as(foreign.body()).isIn(403, 404);
            assertThat(foreign.body()).doesNotContain(renderSha);
            if (mp4) {
                HttpResponse<String> mp4Reopened = send(port, tenant, token, "GET",
                        "/dev/v1/projects/" + projectId + "/renders/" + mp4Id, null);
                assertThat(mp4Reopened.statusCode()).as(mp4Reopened.body()).isEqualTo(200);
                assertThat(JSON.readTree(mp4Reopened.body()).path("artifact").path("sha256").asString())
                        .isEqualTo(mp4Sha);
            }
        } finally {
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(schema);
            deleteBucket(bucket);
            Files.deleteIfExists(log);
            if (Files.exists(services)) try (var paths = Files.walk(services)) {
                paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                    try { Files.deleteIfExists(path); } catch (Exception ignored) { }
                });
            }
        }
    }

    private static Map<String, Object> renderClip(String clipId, String artifactId, String digest, long startTicks) {
        Map<String, Object> time0 = Map.of("ticks", "0", "rateNumerator", "24", "rateDenominator", "1",
                "clock", "SOURCE_PRESENTATION");
        Map<String, Object> time1 = Map.of("ticks", "1", "rateNumerator", "24", "rateDenominator", "1",
                "clock", "SOURCE_PRESENTATION");
        return Map.of("type", "putClip", "clip", Map.of(
                "clipId", clipId, "sceneId", "scene-main", "trackId", "video-main",
                "source", Map.of("artifactId", artifactId, "artifactVersionId", "sha256:" + digest),
                "sourceIn", time0, "sourceOut", time1,
                "storyStart", Map.of("ticks", Long.toString(startTicks), "rateNumerator", "24",
                        "rateDenominator", "1", "clock", "STORY"),
                "storyDuration", Map.of("ticks", "24", "rateNumerator", "24", "rateDenominator", "1",
                        "clock", "STORY")));
    }

    private static byte[] solidPng(int argb) throws Exception {
        var image = new java.awt.image.BufferedImage(8, 6, java.awt.image.BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < 6; y++) for (int x = 0; x < 8; x++) image.setRGB(x, y, argb);
        var out = new java.io.ByteArrayOutputStream();
        javax.imageio.ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    private static String uploadOwnedImageArtifact(int port, String tenant, String principal, String token,
            String key, byte[] bytes) throws Exception {
        Map<String, Object> requestBody = Map.of(
                "tenantId", tenant, "principalId", principal, "fileName", "frame-" + key + ".png",
                "contentType", "image/png", "expectedSizeBytes", bytes.length, "expectedSha256", sha256(bytes),
                "classification", "INTERNAL", "retention", "P30D",
                "metadata", Map.of("scope", "DEV_ONLY", "fixture", "synthetic-render-source"));
        HttpResponse<String> begun = HttpClient.newHttpClient().send(HttpRequest.newBuilder(
                        URI.create("http://127.0.0.1:" + port + "/api/v1/artifacts/uploads"))
                .header("Authorization", "Bearer " + token).header("X-Tenant-Id", tenant)
                .header("Idempotency-Key", "render-source-" + key).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(requestBody), StandardCharsets.UTF_8))
                .build(), HttpResponse.BodyHandlers.ofString());
        assertThat(begun.statusCode()).as(begun.body()).isEqualTo(201);
        String uploadId = JSON.readTree(begun.body()).path("uploadId").asString();
        HttpResponse<String> chunk = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create(
                        "http://127.0.0.1:" + port + "/api/v1/artifacts/uploads/" + uploadId + "/chunks/0"))
                .header("Authorization", "Bearer " + token).header("X-Tenant-Id", tenant)
                .header("Content-Type", "application/octet-stream")
                .PUT(HttpRequest.BodyPublishers.ofByteArray(bytes)).build(), HttpResponse.BodyHandlers.ofString());
        assertThat(chunk.statusCode()).as(chunk.body()).isEqualTo(200);
        HttpResponse<String> completed = send(port, tenant, token, "POST",
                "/api/v1/artifacts/uploads/" + uploadId + "/complete", "");
        assertThat(completed.statusCode()).as(completed.body()).isEqualTo(201);
        return JSON.readTree(completed.body()).path("artifactId").asString();
    }

    @Test
    void realExplorerBrowserCreatesReplaysAndReopensExactTimelineAcrossLauncherRestart() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-browser-" + run;
        String principal = "media-dev-owner-" + run;
        String bucket = "media-dev-browser-" + run;
        String schema = "media_dev_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-browser-services-");
        Path log = Files.createTempFile("media-dev-browser-process-", ".log");
        Process launcher = null;
        Process browser = null;
        try {
            try (S3Client s3 = s3()) {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = environment(bucket, port, schema);
            String token = issueDevToken(tenant, principal, true);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            byte[] clipArtifactBytes = deterministicClipArtifactBytes();
            String clipArtifactSha256 = sha256(clipArtifactBytes);
            String clipArtifactId = uploadOwnedClipArtifact(port, tenant, principal, token, run,
                    clipArtifactBytes, clipArtifactSha256);

            Path repoRoot = findMediaRepoRoot();
            Path liveBrowserScript = repoRoot.resolve(
                    "apps/media-experience-explorer/test/dev-project-timeline-live-browser.mjs");
            assertThat(Files.isRegularFile(liveBrowserScript)).isTrue();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            String viteVersion = packageVersion(viteBinary);
            assertThat(viteVersion).as("Vite must resolve to the source pin or recorded host fallback")
                    .isIn("7.3.1", "8.3.0");
            ProcessBuilder browserBuilder = new ProcessBuilder("node", liveBrowserScript.toString());
            browserBuilder.directory(repoRoot.toFile());
            browserBuilder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            browserBuilder.environment().put("MEDIA_DEV_PROJECT_TIMELINE_BROWSER_TOKEN", token);
            browserBuilder.environment().put("MEDIA_DEV_PROJECT_TIMELINE_BROWSER_TENANT", tenant);
            browserBuilder.environment().put("MEDIA_DEV_PROJECT_TIMELINE_BROWSER_PRINCIPAL", principal);
            browserBuilder.environment().put("MEDIA_DEV_PROJECT_TIMELINE_BROWSER_ARTIFACT_ID", clipArtifactId);
            browserBuilder.environment().put("MEDIA_DEV_PROJECT_TIMELINE_BROWSER_ARTIFACT_SHA256", clipArtifactSha256);
            browserBuilder.environment().put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(port));
            browserBuilder.environment().put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            browserBuilder.environment().put("MEDIA_DEV_VITE_VERSION", viteVersion);
            browserBuilder.environment().put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            browser = browserBuilder.start();
            try (BufferedReader browserOutput = new BufferedReader(
                    new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8));
                    BufferedWriter browserInput = new BufferedWriter(
                            new OutputStreamWriter(browser.getOutputStream(), StandardCharsets.UTF_8))) {
                JsonNode created = readBrowserEvent(browser, browserOutput, "created", log);
                String projectId = created.path("projectId").asString();
                String initialRevisionId = created.path("initialRevisionId").asString();
                String timelineId = created.path("timelineId").asString();
                String timelineRevisionId = created.path("timelineRevisionId").asString();
                String sceneRevisionId = created.path("sceneRevisionId").asString();
                String trackRevisionId = created.path("trackRevisionId").asString();
                String clipRevisionId = created.path("clipRevisionId").asString();
                String removeClipRevisionId = created.path("removeClipRevisionId").asString();
                String removeTrackRevisionId = created.path("removeTrackRevisionId").asString();
                String removeSceneRevisionId = created.path("removeSceneRevisionId").asString();
                String undoRevisionId = created.path("undoRevisionId").asString();
                String redoRevisionId = created.path("redoRevisionId").asString();
                String sceneId = created.path("sceneId").asString();
                String trackId = created.path("trackId").asString();
                assertThat(projectId).isNotBlank();
                assertThat(initialRevisionId).isNotBlank();
                assertThat(timelineId).startsWith("browser-");
                assertThat(timelineRevisionId).isNotBlank();
                assertThat(sceneRevisionId).isNotBlank();
                assertThat(trackRevisionId).isNotBlank();
                assertThat(clipRevisionId).isNotBlank();
                assertThat(removeClipRevisionId).isNotBlank();
                assertThat(created.path("artifactId").asString()).isEqualTo(clipArtifactId);
                assertThat(created.path("artifactSha256").asString()).isEqualTo(clipArtifactSha256);
                assertThat(removeTrackRevisionId).isNotBlank();
                assertThat(removeSceneRevisionId).isNotBlank();
                assertThat(undoRevisionId).isNotBlank();
                assertThat(redoRevisionId).isEqualTo(timelineRevisionId);
                assertThat(sceneId).startsWith("scene-");
                assertThat(trackId).startsWith("track-");

                stopLauncher(launcher);
                launcher = null;
                launcher = startLauncher(classpath, environment, log);
                awaitReady(launcher, port);
                browserInput.write("host-restarted\n");
                browserInput.flush();

                JsonNode readback = readBrowserEvent(browser, browserOutput, "readback", log);
                assertThat(readback.path("projectId").asString()).isEqualTo(projectId);
                assertThat(readback.path("timelineRevisionId").asString()).isEqualTo(timelineRevisionId);
                assertThat(readback.path("removeTrackRevisionId").asString()).isEqualTo(removeTrackRevisionId);
                assertThat(readback.path("removeSceneRevisionId").asString()).isEqualTo(removeSceneRevisionId);
                assertThat(readback.path("undoRevisionId").asString()).isEqualTo(undoRevisionId);
                assertThat(readback.path("redoRevisionId").asString()).isEqualTo(redoRevisionId);
                assertThat(readback.path("timelineId").asString()).isEqualTo(timelineId);
                assertThat(readback.path("sceneId").asString()).isEqualTo(sceneId);
                assertThat(readback.path("trackId").asString()).isEqualTo(trackId);
                assertThat(readback.path("clipRevisionId").asString()).isEqualTo(clipRevisionId);
                assertThat(readback.path("removeClipRevisionId").asString()).isEqualTo(removeClipRevisionId);
                assertThat(readback.path("artifactId").asString()).isEqualTo(clipArtifactId);
                assertThat(readback.path("artifactSha256").asString()).isEqualTo(clipArtifactSha256);
                HttpResponse<String> reopenedHead = send(port, tenant, token, "GET",
                        "/dev/v1/projects/" + projectId, null);
                assertThat(reopenedHead.statusCode()).as(reopenedHead.body()).isEqualTo(200);
                JsonNode persistedHead = JSON.readTree(reopenedHead.body()).path("currentRevision");
                assertThat(persistedHead.path("revisionId").asString()).isEqualTo(redoRevisionId);
                assertThat(persistedHead.path("parentRevisionId").asString()).isEqualTo(undoRevisionId);
                assertThat(persistedHead.path("timelines").get(0).path("graph").path("scenes").isEmpty()).isTrue();
                assertThat(persistedHead.path("timelines").get(0).path("graph").path("tracks").isEmpty()).isTrue();
                HttpResponse<String> exactSceneRevision = send(port, tenant, token, "GET",
                        "/dev/v1/projects/" + projectId + "/revisions/" + sceneRevisionId, null);
                assertThat(exactSceneRevision.statusCode()).as(exactSceneRevision.body()).isEqualTo(200);
                assertThat(JSON.readTree(exactSceneRevision.body()).path("revision").path("timelines").get(0)
                        .path("graph").path("tracks").isEmpty()).isTrue();
                HttpResponse<String> exactTrackRevision = send(port, tenant, token, "GET",
                        "/dev/v1/projects/" + projectId + "/revisions/" + trackRevisionId, null);
                assertThat(exactTrackRevision.statusCode()).as(exactTrackRevision.body()).isEqualTo(200);
                JsonNode historicalTrack = JSON.readTree(exactTrackRevision.body()).path("revision");
                assertThat(historicalTrack.path("parentRevisionId").asString()).isEqualTo(sceneRevisionId);
                assertThat(historicalTrack.path("timelines").get(0).path("graph").path("tracks").get(0)
                        .path("trackId").asString()).isEqualTo(trackId);
                HttpResponse<String> exactClipRevision = send(port, tenant, token, "GET",
                        "/dev/v1/projects/" + projectId + "/revisions/" + clipRevisionId, null);
                assertThat(exactClipRevision.statusCode()).as(exactClipRevision.body()).isEqualTo(200);
                JsonNode historicalClip = JSON.readTree(exactClipRevision.body()).path("revision");
                assertThat(historicalClip.path("parentRevisionId").asString()).isEqualTo(trackRevisionId);
                JsonNode persistedClip = historicalClip.path("timelines").get(0).path("graph").path("clips").get(0);
                assertThat(persistedClip.path("source").path("artifactId").asString()).isEqualTo(clipArtifactId);
                assertThat(persistedClip.path("source").path("artifactVersionId").asString())
                        .isEqualTo("sha256:" + clipArtifactSha256);
                assertThat(persistedClip.path("sourceIn").path("ticks").asString())
                        .isEqualTo("9007199254740993");
                assertThat(persistedClip.path("sourceIn").path("rateNumerator").asString()).isEqualTo("8000");
                assertThat(persistedClip.path("sourceIn").path("rateDenominator").asString()).isEqualTo("1");
                assertThat(persistedClip.path("sourceIn").path("clock").asString()).isEqualTo("SOURCE_PRESENTATION");
                assertThat(persistedClip.path("sourceOut").path("ticks").asString())
                        .isEqualTo("9007199254748993");
                assertThat(persistedClip.path("sourceOut").path("rateNumerator").asString()).isEqualTo("8000");
                assertThat(persistedClip.path("sourceOut").path("rateDenominator").asString()).isEqualTo("1");
                assertThat(persistedClip.path("sourceOut").path("clock").asString())
                        .isEqualTo("SOURCE_PRESENTATION");
                assertThat(persistedClip.path("storyStart").path("ticks").asString()).isEqualTo("0");
                assertThat(persistedClip.path("storyDuration").path("ticks").asString()).isEqualTo("24");
                HttpResponse<String> exactRemoveTrackRevision = send(port, tenant, token, "GET",
                        "/dev/v1/projects/" + projectId + "/revisions/" + removeTrackRevisionId, null);
                assertThat(exactRemoveTrackRevision.statusCode()).as(exactRemoveTrackRevision.body()).isEqualTo(200);
                JsonNode historicalRemoveTrack = JSON.readTree(exactRemoveTrackRevision.body()).path("revision");
                assertThat(historicalRemoveTrack.path("parentRevisionId").asString()).isEqualTo(removeClipRevisionId);
                assertThat(historicalRemoveTrack.path("timelines").get(0).path("graph").path("scenes").size())
                        .isEqualTo(1);
                assertThat(historicalRemoveTrack.path("timelines").get(0).path("graph").path("tracks").isEmpty())
                        .isTrue();
                HttpResponse<String> exactRemoveSceneRevision = send(port, tenant, token, "GET",
                        "/dev/v1/projects/" + projectId + "/revisions/" + removeSceneRevisionId, null);
                assertThat(exactRemoveSceneRevision.statusCode()).as(exactRemoveSceneRevision.body()).isEqualTo(200);
                JsonNode historicalRemoveScene = JSON.readTree(exactRemoveSceneRevision.body()).path("revision");
                assertThat(historicalRemoveScene.path("parentRevisionId").asString()).isEqualTo(removeTrackRevisionId);
                assertThat(historicalRemoveScene.path("timelines").get(0).path("graph").path("scenes").isEmpty())
                        .isTrue();
                HttpResponse<String> exactUndoRevision = send(port, tenant, token, "GET",
                        "/dev/v1/projects/" + projectId + "/revisions/" + undoRevisionId, null);
                assertThat(exactUndoRevision.statusCode()).as(exactUndoRevision.body()).isEqualTo(200);
                JsonNode historicalUndo = JSON.readTree(exactUndoRevision.body()).path("revision");
                assertThat(historicalUndo.path("parentRevisionId").asString()).isEqualTo(removeSceneRevisionId);
                assertThat(historicalUndo.path("timelines").get(0).path("graph").path("tracks").get(0)
                        .path("trackId").asString()).isEqualTo(trackId);
                HttpResponse<String> exactRedoRevision = send(port, tenant, token, "GET",
                        "/dev/v1/projects/" + projectId + "/revisions/" + redoRevisionId, null);
                assertThat(exactRedoRevision.statusCode()).as(exactRedoRevision.body()).isEqualTo(200);
                JsonNode historicalRedo = JSON.readTree(exactRedoRevision.body()).path("revision");
                assertThat(historicalRedo.path("parentRevisionId").asString()).isEqualTo(undoRevisionId);
                assertThat(historicalRedo.path("timelines").get(0).path("graph").path("scenes").isEmpty()).isTrue();
                assertThat(historicalRedo.path("timelines").get(0).path("graph").path("tracks").isEmpty()).isTrue();
                assertThat(browser.waitFor(90, TimeUnit.SECONDS))
                        .as("live Media Explorer browser interaction exit").isTrue();
                assertThat(browser.exitValue()).as("live browser must complete without errors; see " + log).isZero();
            }
        } finally {
            if (browser != null && browser.isAlive()) stopProcessTree(browser);
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(schema);
            deleteBucket(bucket);
            Files.deleteIfExists(log);
            if (Files.exists(services)) try (var paths = Files.walk(services)) {
                paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                    try { Files.deleteIfExists(path); } catch (Exception ignored) { }
                });
            }
        }
    }

    @Test
    void realExplorerUploadKeepsProductInspectionNotAdmittedAcrossLauncherRestart() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-artifact-browser-" + run;
        String principal = "media-dev-owner-" + run;
        String bucket = "media-dev-artifact-" + run;
        String schema = "media_dev_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-artifact-services-");
        Path log = Files.createTempFile("media-dev-artifact-process-", ".log");
        Process launcher = null;
        Process browser = null;
        String artifactId = null;
        String expectedObjectReference = null;
        byte[] expectedBytes = deterministicBrowserUploadBytes();
        String expectedSha256 = sha256(expectedBytes);
        String expectedFileName = "dev-browser-source-" + run + ".wav";
        String expectedClassification = "INTERNAL";
        boolean journeyPassed = false;
        try {
            try (S3Client s3 = s3()) {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = environment(bucket, port, schema);
            String token = issueDevToken(tenant, principal, true);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            HttpResponse<String> contextResponse = send(port, tenant, token, "GET", "/dev/v1/context", null);
            assertThat(contextResponse.statusCode()).as(contextResponse.body()).isEqualTo(200);
            JsonNode context = JSON.readTree(contextResponse.body());
            assertThat(context.path("capabilities").path("artifactUpload").asBoolean()).isTrue();
            assertThat(context.path("capabilities").path("artifactRead").asBoolean()).isTrue();

            Path repoRoot = findMediaRepoRoot();
            Path browserScript = repoRoot.resolve("integration-tests/src/test/resources/media-dev-artifact-intake-live-browser.mjs");
            assertThat(Files.isRegularFile(browserScript)).isTrue();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            String viteVersion = packageVersion(viteBinary);
            assertThat(viteVersion).as("Vite must resolve to the source pin or recorded host fallback")
                    .isIn("7.3.1", "8.3.0");
            ProcessBuilder browserBuilder = new ProcessBuilder("node", browserScript.toString());
            browserBuilder.directory(repoRoot.toFile());
            browserBuilder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            browserBuilder.environment().put("MEDIA_DEV_ARTIFACT_BROWSER_TOKEN", token);
            browserBuilder.environment().put("MEDIA_DEV_ARTIFACT_BROWSER_TENANT", tenant);
            browserBuilder.environment().put("MEDIA_DEV_ARTIFACT_BROWSER_PRINCIPAL", principal);
            browserBuilder.environment().put("MEDIA_DEV_ARTIFACT_PROXY_PORT", Integer.toString(port));
            browserBuilder.environment().put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            browserBuilder.environment().put("MEDIA_DEV_VITE_VERSION", viteVersion);
            browserBuilder.environment().put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            browserBuilder.environment().put("MEDIA_DEV_ARTIFACT_FILE_NAME", expectedFileName);
            browserBuilder.environment().put("MEDIA_DEV_ARTIFACT_EXPECTED_SIZE", Integer.toString(expectedBytes.length));
            browserBuilder.environment().put("MEDIA_DEV_ARTIFACT_EXPECTED_SHA256", expectedSha256);
            browser = browserBuilder.start();

            try (BufferedReader browserOutput = new BufferedReader(
                    new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8));
                    BufferedWriter browserInput = new BufferedWriter(
                            new OutputStreamWriter(browser.getOutputStream(), StandardCharsets.UTF_8))) {
                JsonNode completed = readBrowserEvent(browser, browserOutput, "completed", log);
                artifactId = completed.path("artifactId").asString();
                assertThat(artifactId).isNotBlank();
                assertThat(completed.path("fileName").asString()).isEqualTo(expectedFileName);
                assertThat(completed.path("contentType").asString()).isEqualTo("audio/wav");
                assertThat(completed.path("sizeBytes").asLong()).isEqualTo(expectedBytes.length);
                assertThat(completed.path("sha256").asString()).isEqualTo(expectedSha256);
                assertThat(completed.path("classification").asString()).isEqualTo(expectedClassification);
                assertThat(completed.path("inspectionDisposition").asString()).isEqualTo("NOT_ADMITTED");

                stopLauncher(launcher);
                launcher = null;
                launcher = startLauncher(classpath, environment, log);
                awaitReady(launcher, port);
                browserInput.write("host-restarted\n");
                browserInput.flush();

                JsonNode reopened = readBrowserEvent(browser, browserOutput, "readback", log);
                assertThat(reopened.path("artifactId").asString()).isEqualTo(artifactId);
                assertThat(reopened.path("fileName").asString()).isEqualTo(expectedFileName);
                assertThat(reopened.path("sizeBytes").asLong()).isEqualTo(expectedBytes.length);
                assertThat(reopened.path("sha256").asString()).isEqualTo(expectedSha256);
                assertThat(reopened.path("inspectionDisposition").asString()).isEqualTo("NOT_ADMITTED");
                assertThat(browser.waitFor(90, TimeUnit.SECONDS))
                        .as("live Media Explorer artifact browser interaction exit").isTrue();
                assertThat(browser.exitValue()).as("live artifact browser must complete without errors; see " + log).isZero();
            }

            expectedObjectReference = assertArtifactRowAndObject(tenant, principal, artifactId, expectedFileName,
                    expectedClassification, expectedBytes, expectedSha256, null, bucket);
            assertThat(expectedObjectReference).startsWith("s3://" + bucket + "/");
            journeyPassed = true;
        } finally {
            if (browser != null && browser.isAlive()) stopProcessTree(browser);
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(schema);
            deleteBucket(bucket);
            if (journeyPassed) Files.deleteIfExists(log);
            else System.err.println("Live artifact browser failure log retained at " + log);
            if (Files.exists(services)) try (var paths = Files.walk(services)) {
                paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                    try { Files.deleteIfExists(path); } catch (Exception ignored) { }
                });
            }
        }
    }

    @Test
    void realExplorerUploadsThenLinksExactArtifactVersionAcrossLauncherRestart() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-artifact-timeline-" + run;
        String principal = "media-dev-owner-" + run;
        String bucket = "media-dev-artifact-timeline-" + run;
        String schema = "media_dev_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-artifact-timeline-services-");
        Path log = Files.createTempFile("media-dev-artifact-timeline-process-", ".log");
        Process launcher = null;
        Process artifactBrowser = null;
        Process timelineBrowser = null;
        byte[] expectedBytes = deterministicBrowserUploadBytes();
        String expectedSha256 = sha256(expectedBytes);
        String expectedFileName = "dev-artifact-timeline-source-" + run + ".wav";
        String expectedObjectReference = null;
        String artifactId = null;
        boolean journeyPassed = false;
        try {
            try (S3Client s3 = s3()) {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = environment(bucket, port, schema);
            String token = issueDevToken(tenant, principal, true);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            HttpResponse<String> contextResponse = send(port, tenant, token, "GET", "/dev/v1/context", null);
            assertThat(contextResponse.statusCode()).as(contextResponse.body()).isEqualTo(200);
            JsonNode context = JSON.readTree(contextResponse.body());
            assertThat(context.path("capabilities").path("artifactUpload").asBoolean()).isTrue();
            assertThat(context.path("capabilities").path("artifactRead").asBoolean()).isTrue();

            Path repoRoot = findMediaRepoRoot();
            Path artifactBrowserScript = repoRoot.resolve(
                    "integration-tests/src/test/resources/media-dev-artifact-intake-live-browser.mjs");
            Path timelineBrowserScript = repoRoot.resolve(
                    "apps/media-experience-explorer/test/dev-project-timeline-live-browser.mjs");
            assertThat(Files.isRegularFile(artifactBrowserScript)).isTrue();
            assertThat(Files.isRegularFile(timelineBrowserScript)).isTrue();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            String viteVersion = packageVersion(viteBinary);
            assertThat(viteVersion).as("Vite must resolve to the source pin or recorded host fallback")
                    .isIn("7.3.1", "8.3.0");

            ProcessBuilder artifactBrowserBuilder = new ProcessBuilder("node", artifactBrowserScript.toString());
            artifactBrowserBuilder.directory(repoRoot.toFile());
            artifactBrowserBuilder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            artifactBrowserBuilder.environment().put("MEDIA_DEV_ARTIFACT_BROWSER_TOKEN", token);
            artifactBrowserBuilder.environment().put("MEDIA_DEV_ARTIFACT_BROWSER_TENANT", tenant);
            artifactBrowserBuilder.environment().put("MEDIA_DEV_ARTIFACT_BROWSER_PRINCIPAL", principal);
            artifactBrowserBuilder.environment().put("MEDIA_DEV_ARTIFACT_PROXY_PORT", Integer.toString(port));
            artifactBrowserBuilder.environment().put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            artifactBrowserBuilder.environment().put("MEDIA_DEV_VITE_VERSION", viteVersion);
            artifactBrowserBuilder.environment().put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            artifactBrowserBuilder.environment().put("MEDIA_DEV_ARTIFACT_FILE_NAME", expectedFileName);
            artifactBrowserBuilder.environment().put("MEDIA_DEV_ARTIFACT_EXPECTED_SIZE", Integer.toString(expectedBytes.length));
            artifactBrowserBuilder.environment().put("MEDIA_DEV_ARTIFACT_EXPECTED_SHA256", expectedSha256);
            artifactBrowser = artifactBrowserBuilder.start();

            try (BufferedReader browserOutput = new BufferedReader(
                    new InputStreamReader(artifactBrowser.getInputStream(), StandardCharsets.UTF_8));
                    BufferedWriter browserInput = new BufferedWriter(
                            new OutputStreamWriter(artifactBrowser.getOutputStream(), StandardCharsets.UTF_8))) {
                JsonNode completed = readBrowserEvent(artifactBrowser, browserOutput, "completed", log);
                artifactId = completed.path("artifactId").asString();
                assertThat(artifactId).isNotBlank();
                assertThat(completed.path("fileName").asString()).isEqualTo(expectedFileName);
                assertThat(completed.path("contentType").asString()).isEqualTo("audio/wav");
                assertThat(completed.path("sizeBytes").asLong()).isEqualTo(expectedBytes.length);
                assertThat(completed.path("sha256").asString()).isEqualTo(expectedSha256);
                assertThat(completed.path("classification").asString()).isEqualTo("INTERNAL");
                expectedObjectReference = assertArtifactRowAndObject(tenant, principal, artifactId, expectedFileName,
                        "INTERNAL", expectedBytes, expectedSha256, null, bucket);

                stopLauncher(launcher);
                launcher = null;
                launcher = startLauncher(classpath, environment, log);
                awaitReady(launcher, port);
                browserInput.write("host-restarted\n");
                browserInput.flush();

                JsonNode uploadReadback = readBrowserEvent(artifactBrowser, browserOutput, "readback", log);
                assertThat(uploadReadback.path("artifactId").asString()).isEqualTo(artifactId);
                assertThat(uploadReadback.path("fileName").asString()).isEqualTo(expectedFileName);
                assertThat(uploadReadback.path("sizeBytes").asLong()).isEqualTo(expectedBytes.length);
                assertThat(uploadReadback.path("sha256").asString()).isEqualTo(expectedSha256);
                assertThat(uploadReadback.has("objectReference"))
                        .as("the product upload view must not expose canonical storage inspection")
                        .isFalse();
                assertThat(artifactBrowser.waitFor(90, TimeUnit.SECONDS))
                        .as("live artifact intake browser must finish before the timeline browser starts").isTrue();
                assertThat(artifactBrowser.exitValue()).as("artifact browser must complete without errors; see " + log)
                        .isZero();
            }
            artifactBrowser = null;

            ProcessBuilder timelineBrowserBuilder = new ProcessBuilder("node", timelineBrowserScript.toString());
            timelineBrowserBuilder.directory(repoRoot.toFile());
            timelineBrowserBuilder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            timelineBrowserBuilder.environment().put("MEDIA_DEV_PROJECT_TIMELINE_BROWSER_TOKEN", token);
            timelineBrowserBuilder.environment().put("MEDIA_DEV_PROJECT_TIMELINE_BROWSER_TENANT", tenant);
            timelineBrowserBuilder.environment().put("MEDIA_DEV_PROJECT_TIMELINE_BROWSER_PRINCIPAL", principal);
            timelineBrowserBuilder.environment().put("MEDIA_DEV_PROJECT_TIMELINE_BROWSER_ARTIFACT_ID", artifactId);
            timelineBrowserBuilder.environment().put("MEDIA_DEV_PROJECT_TIMELINE_BROWSER_ARTIFACT_SHA256", expectedSha256);
            timelineBrowserBuilder.environment().put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(port));
            timelineBrowserBuilder.environment().put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            timelineBrowserBuilder.environment().put("MEDIA_DEV_VITE_VERSION", viteVersion);
            timelineBrowserBuilder.environment().put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            timelineBrowser = timelineBrowserBuilder.start();

            try (BufferedReader browserOutput = new BufferedReader(
                    new InputStreamReader(timelineBrowser.getInputStream(), StandardCharsets.UTF_8));
                    BufferedWriter browserInput = new BufferedWriter(
                            new OutputStreamWriter(timelineBrowser.getOutputStream(), StandardCharsets.UTF_8))) {
                JsonNode created = readBrowserEvent(timelineBrowser, browserOutput, "created", log);
                String projectId = created.path("projectId").asString();
                String timelineId = created.path("timelineId").asString();
                String clipRevisionId = created.path("clipRevisionId").asString();
                String trackRevisionId = created.path("trackRevisionId").asString();
                String timelineRevisionId = created.path("timelineRevisionId").asString();
                assertThat(projectId).isNotBlank();
                assertThat(timelineId).isNotBlank();
                assertThat(clipRevisionId).isNotBlank();
                assertThat(trackRevisionId).isNotBlank();
                assertThat(timelineRevisionId).isNotBlank();
                assertThat(created.path("artifactId").asString()).isEqualTo(artifactId);
                assertThat(created.path("artifactSha256").asString()).isEqualTo(expectedSha256);

                stopLauncher(launcher);
                launcher = null;
                launcher = startLauncher(classpath, environment, log);
                awaitReady(launcher, port);
                browserInput.write("host-restarted\n");
                browserInput.flush();

                JsonNode timelineReadback = readBrowserEvent(timelineBrowser, browserOutput, "readback", log);
                assertThat(timelineReadback.path("projectId").asString()).isEqualTo(projectId);
                assertThat(timelineReadback.path("timelineId").asString()).isEqualTo(timelineId);
                assertThat(timelineReadback.path("clipRevisionId").asString()).isEqualTo(clipRevisionId);
                assertThat(timelineReadback.path("timelineRevisionId").asString()).isEqualTo(timelineRevisionId);
                assertThat(timelineReadback.path("artifactId").asString()).isEqualTo(artifactId);
                assertThat(timelineReadback.path("artifactSha256").asString()).isEqualTo(expectedSha256);

                HttpResponse<String> artifactResponse = send(port, tenant, token, "GET",
                        "/api/v1/artifacts/" + artifactId, null);
                assertThat(artifactResponse.statusCode()).as(artifactResponse.body()).isEqualTo(200);
                JsonNode durableArtifact = JSON.readTree(artifactResponse.body());
                assertThat(durableArtifact.path("artifactId").asString()).isEqualTo(artifactId);
                assertThat(durableArtifact.path("sha256").asString()).isEqualTo(expectedSha256);
                assertThat(durableArtifact.path("sizeBytes").asLong()).isEqualTo(expectedBytes.length);
                assertThat(durableArtifact.path("objectReference").asString()).isEqualTo(expectedObjectReference);

                HttpResponse<String> exactClipResponse = send(port, tenant, token, "GET",
                        "/dev/v1/projects/" + projectId + "/revisions/" + clipRevisionId, null);
                assertThat(exactClipResponse.statusCode()).as(exactClipResponse.body()).isEqualTo(200);
                JsonNode exactClipRevision = JSON.readTree(exactClipResponse.body()).path("revision");
                assertThat(exactClipRevision.path("revisionId").asString()).isEqualTo(clipRevisionId);
                assertThat(exactClipRevision.path("parentRevisionId").asString()).isEqualTo(trackRevisionId);
                JsonNode persistedClip = exactClipRevision.path("timelines").get(0).path("graph").path("clips").get(0);
                assertThat(persistedClip.path("source").path("artifactId").asString()).isEqualTo(artifactId);
                assertThat(persistedClip.path("source").path("artifactVersionId").asString())
                        .isEqualTo("sha256:" + expectedSha256);
                assertThat(timelineBrowser.waitFor(90, TimeUnit.SECONDS))
                        .as("live project timeline browser interaction exit").isTrue();
                assertThat(timelineBrowser.exitValue()).as("timeline browser must complete without errors; see " + log)
                        .isZero();
            }
            timelineBrowser = null;

            assertArtifactRowAndObject(tenant, principal, artifactId, expectedFileName,
                    "INTERNAL", expectedBytes, expectedSha256,
                    java.util.Objects.requireNonNull(expectedObjectReference), bucket);
            journeyPassed = true;
        } finally {
            if (artifactBrowser != null && artifactBrowser.isAlive()) stopProcessTree(artifactBrowser);
            if (timelineBrowser != null && timelineBrowser.isAlive()) stopProcessTree(timelineBrowser);
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(schema);
            deleteBucket(bucket);
            if (journeyPassed) Files.deleteIfExists(log);
            else System.err.println("Live artifact-to-timeline browser failure log retained at " + log);
            if (Files.exists(services)) try (var paths = Files.walk(services)) {
                paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                    try { Files.deleteIfExists(path); } catch (Exception ignored) { }
                });
            }
        }
    }

    @Test
    void realExplorerResumesUploadAfterReloadAndLauncherRestart() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-upload-recovery-" + run;
        String principal = "media-dev-owner-" + run;
        String bucket = "media-dev-recovery-" + run;
        String schema = "media_dev_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-recovery-services-");
        Path log = Files.createTempFile("media-dev-recovery-process-", ".log");
        Process launcher = null;
        Process browser = null;
        String token = null;
        byte[] expectedBytes = deterministicBrowserUploadBytes();
        String expectedSha256 = sha256(expectedBytes);
        String expectedFileName = "dev-recovery-source-" + run + ".wav";
        boolean journeyPassed = false;
        try {
            try (S3Client s3 = s3()) {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = environment(bucket, port, schema);
            token = issueDevToken(tenant, principal, true);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            Path repoRoot = findMediaRepoRoot();
            Path browserScript = repoRoot.resolve(
                    "integration-tests/src/test/resources/media-dev-artifact-upload-recovery-live-browser.mjs");
            assertThat(Files.isRegularFile(browserScript)).isTrue();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            int browserPort;
            try (var browserSocket = new java.net.ServerSocket(0)) { browserPort = browserSocket.getLocalPort(); }
            String viteVersion = packageVersion(viteBinary);
            assertThat(viteVersion).as("Vite must resolve to the source pin or recorded host fallback")
                    .isIn("7.3.1", "8.3.0");
            ProcessBuilder browserBuilder = new ProcessBuilder("node", browserScript.toString());
            browserBuilder.directory(repoRoot.toFile());
            browserBuilder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            browserBuilder.environment().put("MEDIA_DEV_RECOVERY_BROWSER_TOKEN", token);
            browserBuilder.environment().put("MEDIA_DEV_RECOVERY_BROWSER_TENANT", tenant);
            browserBuilder.environment().put("MEDIA_DEV_RECOVERY_BROWSER_PRINCIPAL", principal);
            browserBuilder.environment().put("MEDIA_DEV_RECOVERY_PROXY_PORT", Integer.toString(port));
            browserBuilder.environment().put("MEDIA_DEV_RECOVERY_VITE_PORT", Integer.toString(browserPort));
            browserBuilder.environment().put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            browserBuilder.environment().put("MEDIA_DEV_VITE_VERSION", viteVersion);
            browserBuilder.environment().put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            browserBuilder.environment().put("MEDIA_DEV_RECOVERY_FILE_NAME", expectedFileName);
            browserBuilder.environment().put("MEDIA_DEV_RECOVERY_EXPECTED_SIZE", Integer.toString(expectedBytes.length));
            browserBuilder.environment().put("MEDIA_DEV_RECOVERY_EXPECTED_SHA256", expectedSha256);
            browser = browserBuilder.start();

            try (BufferedReader browserOutput = new BufferedReader(
                    new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8));
                    BufferedWriter browserInput = new BufferedWriter(
                            new OutputStreamWriter(browser.getOutputStream(), StandardCharsets.UTF_8))) {
                JsonNode partial = readRecoveryBrowserEvent(browser, browserOutput, "partial", log, token);
                String uploadId = partial.path("uploadId").asString();
                assertThat(uploadId).isNotBlank();
                assertThat(partial.path("firstAcknowledgedBytes").asLong()).isEqualTo(4L * 1024 * 1024);
                assertThat(partial.path("lostAckStatus").asInt()).isEqualTo(200);
                assertThat(partial.path("bytesReceived").asLong()).isEqualTo(8L * 1024 * 1024);
                assertThat(partial.path("nextChunkIndex").asInt()).isEqualTo(2);
                assertThat(partial.path("lostAckBytesReceived").asLong()).isEqualTo(8L * 1024 * 1024);
                assertThat(partial.path("lostAckNextChunkIndex").asInt()).isEqualTo(2);
                assertThat(partial.path("sha256").asString()).isEqualTo(expectedSha256);
                assertThat(partial.path("fileName").asString()).isEqualTo(expectedFileName);
                assertThat(partial.path("tenantId").asString()).isEqualTo(tenant);
                assertThat(partial.path("principalId").asString()).isEqualTo(principal);
                assertThat(partial.path("classification").asString()).isEqualTo("INTERNAL");
                assertThat(Duration.parse(partial.path("retention").asString())).isEqualTo(Duration.ofDays(30));

                stopLauncher(launcher);
                launcher = null;
                launcher = startLauncher(classpath, environment, log);
                awaitReady(launcher, port);
                browserInput.write("host-restarted\n");
                browserInput.flush();

                JsonNode completed = readRecoveryBrowserEvent(browser, browserOutput, "completed", log, token);
                String artifactId = completed.path("artifactId").asString();
                assertThat(artifactId).isNotBlank();
                assertThat(completed.path("uploadId").asString()).isEqualTo(uploadId);
                assertThat(completed.path("fileName").asString()).isEqualTo(expectedFileName);
                assertThat(completed.path("contentType").asString()).isEqualTo("audio/wav");
                assertThat(completed.path("sizeBytes").asLong()).isEqualTo(expectedBytes.length);
                assertThat(completed.path("sha256").asString()).isEqualTo(expectedSha256);
                assertThat(completed.path("classification").asString()).isEqualTo("INTERNAL");
                assertThat(browser.waitFor(90, TimeUnit.SECONDS))
                        .as("live Media Explorer upload recovery interaction exit").isTrue();
                assertThat(browser.exitValue()).as("live recovery browser must complete without errors; see " + log)
                        .isZero();

                assertArtifactRowAndObject(tenant, principal, artifactId, expectedFileName,
                        "INTERNAL", expectedBytes, expectedSha256, null, bucket);
                journeyPassed = true;
            }
        } finally {
            try {
                if (browser != null && browser.isAlive()) stopProcessTree(browser);
                if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            } finally {
                if (browser != null && browser.isAlive()) browser.destroyForcibly();
                if (launcher != null && launcher.isAlive()) launcher.destroyForcibly();
                dropSchema(schema);
                deleteBucket(bucket);
                if (journeyPassed) Files.deleteIfExists(log);
                else {
                    try {
                        String contents = Files.readString(log);
                        if (token != null && !token.isBlank()) contents = contents.replace(token, "[redacted-token]");
                        Files.writeString(log, contents, StandardCharsets.UTF_8);
                        if (token != null && !token.isBlank() && Files.readString(log).contains(token)) {
                            Files.deleteIfExists(log);
                            if (Files.exists(log)) throw new AssertionError("Unable to remove an unredacted recovery failure log");
                        }
                        if (Files.exists(log)) System.err.println("Sanitized live artifact recovery failure log retained at " + log);
                    } catch (Exception sanitizationFailure) {
                        Files.deleteIfExists(log);
                        if (Files.exists(log)) throw new AssertionError("Unable to safely remove recovery failure log", sanitizationFailure);
                    }
                }
                if (Files.exists(services)) try (var paths = Files.walk(services)) {
                    paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                        try { Files.deleteIfExists(path); } catch (Exception ignored) { }
                    });
                }
            }
        }
    }

    private static JsonNode readBrowserEvent(Process browser, BufferedReader output, String expectedEvent, Path log)
            throws Exception {
        FutureTask<String> lineTask = new FutureTask<>(output::readLine);
        Thread reader = new Thread(lineTask, "media-dev-live-browser-output");
        reader.setDaemon(true);
        reader.start();
        String line;
        try {
            line = lineTask.get(130, TimeUnit.SECONDS);
        } catch (java.util.concurrent.TimeoutException timeout) {
            stopProcessTree(browser);
            String processState = browser.isAlive() ? "still-running" : "exit=" + browser.exitValue();
            String diagnostics = Files.exists(log) ? Files.readString(log) : "<no browser log>";
            throw new AssertionError("Timed out waiting for browser event " + expectedEvent
                    + "; process=" + processState + "; log=" + diagnostics, timeout);
        }
        String processState = browser.isAlive() ? "still-running" : "exit=" + browser.exitValue();
        String diagnostics = Files.exists(log) ? Files.readString(log) : "<no browser log>";
        assertThat(line).as("browser event " + expectedEvent + "; process=" + processState + "; log=" + diagnostics)
                .isNotNull();
        JsonNode event = JSON.readTree(line);
        assertThat(event.path("event").asString()).isEqualTo(expectedEvent);
        return event;
    }

    private static JsonNode readRecoveryBrowserEvent(
            Process browser, BufferedReader output, String expectedEvent, Path log, String token) throws Exception {
        FutureTask<String> lineTask = new FutureTask<>(output::readLine);
        Thread reader = new Thread(lineTask, "media-dev-upload-recovery-browser-output");
        reader.setDaemon(true);
        reader.start();
        String line;
        try {
            line = lineTask.get(130, TimeUnit.SECONDS);
        } catch (java.util.concurrent.TimeoutException timeout) {
            stopProcessTree(browser);
            String processState = browser.isAlive() ? "still-running" : "exit=" + browser.exitValue();
            throw new AssertionError("Timed out waiting for browser event " + expectedEvent
                    + "; process=" + processState + "; sanitized log=" + sanitizedRecoveryLog(log, token), timeout);
        }
        String processState = browser.isAlive() ? "still-running" : "exit=" + browser.exitValue();
        assertThat(line).as("recovery browser event " + expectedEvent + "; process=" + processState
                + "; sanitized log=" + sanitizedRecoveryLog(log, token)).isNotNull();
        String safeLine = token == null || token.isBlank() ? line : line.replace(token, "[redacted-token]");
        JsonNode event = JSON.readTree(safeLine);
        assertThat(event.path("event").asString()).isEqualTo(expectedEvent);
        return event;
    }

    private static String sanitizedRecoveryLog(Path log, String token) {
        try {
            String contents = Files.exists(log) ? Files.readString(log) : "<no browser log>";
            if (token != null && !token.isBlank()) contents = contents.replace(token, "[redacted-token]");
            if (token != null && !token.isBlank() && contents.contains(token)) {
                return "<log omitted because token redaction could not be verified>";
            }
            return contents;
        } catch (Exception readFailure) {
            return "<recovery log unavailable>";
        }
    }

    private static void stopProcessTree(Process process) throws InterruptedException {
        if (process == null) return;
        var descendants = process.toHandle().descendants().toList();
        for (int index = descendants.size() - 1; index >= 0; index--) {
            descendants.get(index).destroy();
        }
        process.destroy();
        if (!process.waitFor(3, TimeUnit.SECONDS)) process.destroyForcibly();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        for (ProcessHandle descendant : descendants) {
            if (!descendant.isAlive()) continue;
            descendant.destroyForcibly();
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0) break;
            try {
                descendant.onExit().get(remaining, TimeUnit.NANOSECONDS);
            } catch (java.util.concurrent.TimeoutException ignored) {
                break;
            } catch (java.util.concurrent.ExecutionException ignored) {
                // The descendant already exited; continue cleaning up siblings.
            }
        }
    }

    private static Path findMediaRepoRoot() {
        Path repoRoot = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (!Files.isRegularFile(repoRoot.resolve("scripts/media-dev-identity-token.mjs"))) {
            repoRoot = repoRoot.getParent();
            if (repoRoot == null) throw new AssertionError("Could not locate the Media repository root");
        }
        return repoRoot;
    }

    private static Path findViteBinary(Path repoRoot) throws Exception {
        Path local = repoRoot.resolve("apps/media-experience-explorer/node_modules/vite/bin/vite.js");
        if (Files.isRegularFile(local)) {
            assertThat(packageVersion(local)).as("workspace Vite pin").isEqualTo("7.3.1");
            return local;
        }
        Path localPnpm = findPnpmPackageBinary(repoRoot, "vite@7.3.1", "vite/bin/vite.js");
        if (localPnpm != null) {
            assertThat(packageVersion(localPnpm)).as("workspace Vite pin").isEqualTo("7.3.1");
            return localPnpm;
        }
        Path globalRoot = globalNodeModules();
        Path globalVite = globalRoot.resolve("vitest/node_modules/vite/bin/vite.js");
        assertThat(Files.isRegularFile(globalVite))
                .as("Vite 8.3.0 from the documented global Vitest toolchain is required when the workspace link is absent")
                .isTrue();
        assertThat(packageVersion(globalVite)).as("documented host Vite fallback pin").isEqualTo("8.3.0");
        return globalVite;
    }

    private static Path findPlaywrightModule(Path repoRoot) throws Exception {
        Path local = repoRoot.resolve("node_modules/playwright/index.mjs");
        if (Files.isRegularFile(local)) return local;
        Path appLocal = repoRoot.resolve("apps/media-experience-explorer/node_modules/playwright/index.mjs");
        if (Files.isRegularFile(appLocal)) return appLocal;
        Path localPnpm = findPnpmPackageBinary(repoRoot, "playwright@1.63.0", "playwright/index.mjs");
        if (localPnpm != null) return localPnpm;
        Path global = globalNodeModules().resolve("@playwright/test/index.mjs");
        assertThat(Files.isRegularFile(global))
                .as("Playwright 1.63.0 global runner is required when the workspace package link is absent").isTrue();
        return global;
    }

    private static Path findPnpmPackageBinary(Path repoRoot, String packagePrefix, String relativeBinary)
            throws Exception {
        Path pnpmStore = repoRoot.resolve("node_modules/.pnpm");
        if (!Files.isDirectory(pnpmStore)) return null;
        try (var entries = Files.list(pnpmStore)) {
            return entries.filter(path -> path.getFileName().toString().startsWith(packagePrefix))
                    .map(path -> path.resolve("node_modules").resolve(relativeBinary))
                    .filter(Files::isRegularFile)
                    .findFirst().orElse(null);
        }
    }

    private static String packageVersion(Path executable) throws Exception {
        Path resolved = executable.toRealPath();
        Path packageJson = resolved.getParent().getParent().resolve("package.json");
        return JSON.readTree(Files.readString(packageJson)).path("version").asString();
    }

    private static Path globalNodeModules() throws Exception {
        Process npm = new ProcessBuilder("npm", "root", "-g").redirectErrorStream(true).start();
        byte[] output = npm.getInputStream().readAllBytes();
        assertThat(npm.waitFor(10, TimeUnit.SECONDS)).as("npm root -g must finish").isTrue();
        assertThat(npm.exitValue()).as("npm root -g output: " + new String(output, StandardCharsets.UTF_8)).isZero();
        return Path.of(new String(output, StandardCharsets.UTF_8).trim());
    }

    private static String issueDevToken(String tenant, String principal) throws Exception {
        return issueDevToken(tenant, principal, false);
    }

    private static String issueDevToken(String tenant, String principal, boolean artifactCapabilities) throws Exception {
        Path repoRoot = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (!Files.isRegularFile(repoRoot.resolve("scripts/media-dev-identity-token.mjs"))) {
            repoRoot = repoRoot.getParent();
            if (repoRoot == null) throw new AssertionError("Could not locate the Media DEV_ONLY token issuer");
        }
        ProcessBuilder builder = new ProcessBuilder("node", "scripts/media-dev-identity-token.mjs",
                "--tenant", tenant, "--subject", principal,
                "--permission", "media:project:dev:create",
                "--permission", "media:project:dev:read",
                "--permission", "media:project:dev:write",
                "--expires-in", "300");
        if (artifactCapabilities) {
            builder.command().add("--permission"); builder.command().add("media:artifact:create");
            builder.command().add("--permission"); builder.command().add("media:artifact:write");
            builder.command().add("--permission"); builder.command().add("media:artifact:read");
        }
        builder.directory(repoRoot.toFile());
        builder.redirectErrorStream(true);
        builder.environment().put("MEDIA_PROFILE", "dev");
        builder.environment().put("MEDIA_RUNTIME_ENVIRONMENT", "dev");
        builder.environment().put("MEDIA_DEV_IDENTITY_ENABLED", "true");
        builder.environment().put("MEDIA_DEV_JWT_HMAC_SECRET", DEV_SECRET);
        Process issuer = builder.start();
        byte[] outputBytes = issuer.getInputStream().readAllBytes();
        if (!issuer.waitFor(10, TimeUnit.SECONDS)) {
            issuer.destroyForcibly();
            throw new AssertionError("DEV_ONLY issuer did not exit");
        }
        String output = new String(outputBytes, StandardCharsets.US_ASCII).trim();
        assertThat(issuer.exitValue()).as("DEV_ONLY issuer output: " + output).isZero();
        return output;
    }

    private static Map<String, String> environment(String bucket, int port, String schema) {
        Map<String, String> env = new HashMap<>();
        env.put("MEDIA_RUNTIME_ENABLED", "true");
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "dev");
        env.put("MEDIA_PROFILE", "dev");
        env.put("MEDIA_DEV_IDENTITY_ENABLED", "true");
        env.put("MEDIA_DEV_JWT_HMAC_SECRET", DEV_SECRET);
        env.put("MEDIA_HTTP_PORT", Integer.toString(port));
        env.put("MEDIA_LOCAL_PROVIDER_ENABLED", "true");
        env.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        env.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_LAUNCHER_DB_PASSWORD");
        env.put("MEDIA_LAUNCHER_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        env.put("MEDIA_S3_BUCKET", bucket);
        env.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        env.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_LAUNCHER_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_LAUNCHER_SECRET");
        env.put("MEDIA_LAUNCHER_ACCESS", LOCALSTACK.getAccessKey());
        env.put("MEDIA_LAUNCHER_SECRET", LOCALSTACK.getSecretKey());
        env.put("MEDIA_PROJECT_TIMELINE_DEV_ENABLED", "true");
        env.put("MEDIA_PROJECT_TIMELINE_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        env.put("MEDIA_PROJECT_TIMELINE_SCHEMA", schema);
        env.put("MEDIA_PROJECT_TIMELINE_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_PROJECT_TIMELINE_POSTGRES_PASSWORD_REFERENCE",
                "secret:env:MEDIA_PROJECT_TIMELINE_DB_PASSWORD");
        env.put("MEDIA_PROJECT_TIMELINE_DB_PASSWORD", POSTGRES.getPassword());
        return env;
    }

    private static void installDescriptors(Path root) throws Exception {
        Path services = root.resolve("META-INF/services");
        Files.createDirectories(services);
        Files.writeString(services.resolve("com.ghatana.governance.PolicyEngine"),
                MediaLauncherProcessFixtures.Policy.class.getName() + "\n");
        Files.writeString(services.resolve(
                "com.ghatana.media.runtime.MediaRuntimeContracts$MediaProcessingProvider"),
                MediaLauncherProcessFixtures.Stt.class.getName() + "\n");
    }

    private static S3Client s3() {
        return S3Client.builder().endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(
                        AwsBasicCredentials.create(LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build();
    }

    private static Process startLauncher(String classpath, Map<String, String> env, Path log) throws Exception {
        String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        ProcessBuilder builder = new ProcessBuilder(java, "-cp", classpath,
                "com.ghatana.media.launcher.MediaLauncher");
        builder.environment().putAll(env);
        builder.redirectErrorStream(true);
        builder.redirectOutput(log.toFile());
        return builder.start();
    }

    private static void awaitReady(Process process, int port) throws Exception {
        long deadline = System.nanoTime() + Duration.ofMinutes(2).toNanos();
        while (System.nanoTime() < deadline) {
            if (!process.isAlive()) throw new AssertionError("MediaLauncher exited: " + process.exitValue());
            try {
                HttpResponse<String> response = HttpClient.newHttpClient().send(
                        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/health/ready"))
                                .GET().build(), HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() == 200) return;
            } catch (java.io.IOException ignored) { }
            Thread.sleep(200);
        }
        throw new AssertionError("MediaLauncher did not become ready");
    }

    private static HttpResponse<String> send(int port, String tenant, String token,
            String method, String path, String body) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .header("Authorization", "Bearer " + token)
                .header("X-Tenant-Id", tenant);
        if (body != null) request.header("Content-Type", "application/json");
        request.method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static void assertProjectAccessDeniedWithoutDisclosure(HttpResponse<String> response,
            String projectId, String initialRevisionId, String currentRevisionId, String title) throws Exception {
        JsonNode body = JSON.readTree(response.body());
        assertThat(body.path("error").path("code").asString())
                .isIn("PROJECT_ACCESS_DENIED", "PROJECT_NOT_FOUND");
        assertThat(response.body()).doesNotContain(projectId, initialRevisionId, currentRevisionId, title);
        assertThat(body.has("project")).isFalse();
        assertThat(body.has("currentRevision")).isFalse();
        assertThat(body.has("initialRevision")).isFalse();
    }

    private static void stopLauncher(Process process) throws Exception {
        process.destroy();
        if (!process.waitFor(15, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            assertThat(process.waitFor(10, TimeUnit.SECONDS)).isTrue();
        }
    }

    private static void dropSchema(String schema) {
        if (schema == null || !schema.matches("media_dev_[a-z0-9_]{1,48}")) return;
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()); var statement = connection.createStatement()) {
            statement.execute("DROP SCHEMA IF EXISTS \"" + schema + "\" CASCADE");
        } catch (Exception ignored) { }
    }

    private static void deleteBucket(String bucket) {
        try (S3Client s3 = s3()) {
            s3.listObjectsV2(builder -> builder.bucket(bucket)).contents().forEach(object ->
                    s3.deleteObject(builder -> builder.bucket(bucket).key(object.key())));
            s3.deleteBucket(builder -> builder.bucket(bucket));
        } catch (Exception ignored) { }
    }

    private static byte[] deterministicBrowserUploadBytes() {
        byte[] bytes = new byte[10 * 1024 * 1024 + 256];
        for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) ((i * 31 + 17) & 0xff);
        ByteBuffer header = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        header.put("RIFF".getBytes(StandardCharsets.US_ASCII));
        header.putInt(bytes.length - 8);
        header.put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII));
        header.putInt(16);
        header.putShort((short) 1);
        header.putShort((short) 1);
        header.putInt(8_000);
        header.putInt(16_000);
        header.putShort((short) 2);
        header.putShort((short) 16);
        header.put("data".getBytes(StandardCharsets.US_ASCII));
        header.putInt(bytes.length - 44);
        return bytes;
    }

    private static byte[] deterministicClipArtifactBytes() {
        byte[] bytes = new byte[44 + 8_000 * 2];
        ByteBuffer header = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        header.put("RIFF".getBytes(StandardCharsets.US_ASCII));
        header.putInt(bytes.length - 8);
        header.put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII));
        header.putInt(16);
        header.putShort((short) 1);
        header.putShort((short) 1);
        header.putInt(8_000);
        header.putInt(16_000);
        header.putShort((short) 2);
        header.putShort((short) 16);
        header.put("data".getBytes(StandardCharsets.US_ASCII));
        header.putInt(bytes.length - 44);
        for (int i = 44; i < bytes.length; i++) bytes[i] = (byte) ((i * 31 + 17) & 0xff);
        return bytes;
    }

    private static String uploadOwnedClipArtifact(int port, String tenant, String principal, String token,
            String run, byte[] bytes, String digest) throws Exception {
        String fileName = "timeline-clip-source-" + run + ".wav";
        Map<String, Object> requestBody = Map.of(
                "tenantId", tenant,
                "principalId", principal,
                "fileName", fileName,
                "contentType", "audio/wav",
                "expectedSizeBytes", bytes.length,
                "expectedSha256", digest,
                "classification", "INTERNAL",
                "retention", "P30D",
                "metadata", Map.of("scope", "DEV_ONLY", "fixture", "synthetic-timeline-clip"));
        HttpRequest begin = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/v1/artifacts/uploads"))
                .header("Authorization", "Bearer " + token)
                .header("X-Tenant-Id", tenant)
                .header("Idempotency-Key", "timeline-clip-artifact-" + run)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(requestBody), StandardCharsets.UTF_8))
                .build();
        HttpResponse<String> begun = HttpClient.newHttpClient().send(begin, HttpResponse.BodyHandlers.ofString());
        assertThat(begun.statusCode()).as(begun.body()).isEqualTo(201);
        String uploadId = JSON.readTree(begun.body()).path("uploadId").asString();
        assertThat(uploadId).isNotBlank();

        HttpRequest chunk = HttpRequest.newBuilder(URI.create(
                        "http://127.0.0.1:" + port + "/api/v1/artifacts/uploads/" + uploadId + "/chunks/0"))
                .header("Authorization", "Bearer " + token)
                .header("X-Tenant-Id", tenant)
                .header("Content-Type", "application/octet-stream")
                .PUT(HttpRequest.BodyPublishers.ofByteArray(bytes))
                .build();
        HttpResponse<String> acknowledged = HttpClient.newHttpClient().send(chunk, HttpResponse.BodyHandlers.ofString());
        assertThat(acknowledged.statusCode()).as(acknowledged.body()).isEqualTo(200);
        assertThat(JSON.readTree(acknowledged.body()).path("bytesReceived").asLong()).isEqualTo(bytes.length);

        HttpResponse<String> completed = send(port, tenant, token, "POST",
                "/api/v1/artifacts/uploads/" + uploadId + "/complete", "");
        assertThat(completed.statusCode()).as(completed.body()).isEqualTo(201);
        JsonNode artifact = JSON.readTree(completed.body());
        String artifactId = artifact.path("artifactId").asString();
        assertThat(artifactId).isNotBlank();
        assertThat(artifact.path("tenantId").asString()).isEqualTo(tenant);
        assertThat(artifact.path("principalId").asString()).isEqualTo(principal);
        assertThat(artifact.path("fileName").asString()).isEqualTo(fileName);
        assertThat(artifact.path("sha256").asString()).isEqualTo(digest);
        assertThat("sha256:" + artifact.path("sha256").asString()).isEqualTo("sha256:" + digest);
        return artifactId;
    }

    private static String sha256(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder hex = new StringBuilder(digest.length * 2);
        for (byte value : digest) hex.append(String.format("%02x", value & 0xff));
        return hex.toString();
    }

    private static String assertArtifactRowAndObject(String tenant, String principal, String artifactId,
            String fileName, String classification, byte[] expectedBytes, String expectedSha256,
            String expectedObjectReference, String bucket)
            throws Exception {
        String objectReference;
        try (var connection = DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                var statement = connection.prepareStatement(
                        "SELECT file_name,content_type,size_bytes,sha256,object_reference,classification,"
                                + "metadata_json,created_at,expires_at FROM media_artifacts "
                                + "WHERE tenant_id=? AND artifact_id=? AND principal_id=?")) {
            statement.setString(1, tenant);
            statement.setString(2, artifactId);
            statement.setString(3, principal);
            try (var row = statement.executeQuery()) {
                assertThat(row.next()).as("one durable owner-scoped artifact row").isTrue();
                assertThat(row.getString("file_name")).isEqualTo(fileName);
                assertThat(row.getString("content_type")).isEqualTo("audio/wav");
                assertThat(row.getLong("size_bytes")).isEqualTo(expectedBytes.length);
                assertThat(row.getString("sha256")).isEqualTo(expectedSha256);
                assertThat(row.getString("classification")).isEqualTo(classification);
                long createdAt = row.getLong("created_at");
                long expiresAt = row.getLong("expires_at");
                assertThat(createdAt).isPositive();
                assertThat(expiresAt - createdAt).isEqualTo(Duration.ofDays(30).toMillis());
                JsonNode metadata = JSON.readTree(row.getString("metadata_json"));
                assertThat(metadata.path("classification").asString()).isEqualTo(classification);
                assertThat(metadata.path("retention").asString()).isEqualTo("P30D");
                assertThat(metadata.path("scope").asString()).isEqualTo("DEV_ONLY");
                objectReference = row.getString("object_reference");
                if (expectedObjectReference != null) assertThat(objectReference).isEqualTo(expectedObjectReference);
                assertThat(row.next()).as("no duplicate durable artifact row").isFalse();
            }
        }
        String bucketPrefix = "s3://" + bucket + "/";
        assertThat(objectReference).startsWith(bucketPrefix);
        String key = objectReference.substring(bucketPrefix.length());
        assertThat(key).isNotBlank();
        try (S3Client s3 = s3()) {
            byte[] stored = s3.getObjectAsBytes(
                    software.amazon.awssdk.services.s3.model.GetObjectRequest.builder()
                            .bucket(bucket).key(key).build()).asByteArray();
            assertThat(stored).containsExactly(expectedBytes);
            assertThat(sha256(stored)).isEqualTo(expectedSha256);
        }
        return objectReference;
    }
}
