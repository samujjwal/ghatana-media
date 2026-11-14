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

/**
 * Real launcher process + PostgreSQL + S3: DEV_ONLY versioned review records open on an exact project revision and an
 * exact render artifact version, survive a launcher restart, and an earlier ACCEPT turns STALE after a project edit.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevReviewRestartIT {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String DEV_SECRET = "media-dev-project-timeline-restart-secret";

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void reviewCommentsAndDecisionsSurviveRestartAndGoStaleWhenTheProjectChanges() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-review-" + run;
        String principal = "media-dev-owner-" + run;
        String bucket = "media-dev-review-" + run;
        String schema = "media_dev_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-review-services-");
        Path log = Files.createTempFile("media-dev-review-process-", ".log");
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
            String token = issueDevToken(tenant, principal, true);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            byte[] red = solidPng(0xffff0000);
            String redId = uploadOwnedImageArtifact(port, tenant, principal, token, run + "-red", red);
            String workspaceId = JSON.readTree(send(port, tenant, token, "GET", "/dev/v1/context", null).body())
                    .path("selectedAuthorizedWorkspaceId").asString();
            HttpResponse<String> created = send(port, tenant, token, "POST", "/dev/v1/projects",
                    JSON.writeValueAsString(Map.of("selectedAuthorizedWorkspaceId", workspaceId,
                            "title", "Review restart project", "requestId", "review-project-" + run)));
            assertThat(created.statusCode()).as(created.body()).isEqualTo(201);
            JsonNode createdBody = JSON.readTree(created.body());
            String projectId = createdBody.path("project").path("projectId").asString();
            String head = createdBody.path("initialRevision").path("revisionId").asString();
            HttpResponse<String> timeline = send(port, tenant, token, "POST",
                    "/dev/v1/projects/" + projectId + "/timelines",
                    JSON.writeValueAsString(Map.of("expectedHeadRevisionId", head, "timelineId", "timeline-main")));
            head = JSON.readTree(timeline.body()).path("revision").path("revisionId").asString();
            String editPath = "/dev/v1/projects/" + projectId + "/timelines/timeline-main/edits";
            HttpResponse<String> edited = send(port, tenant, token, "POST", editPath, JSON.writeValueAsString(Map.of(
                    "expectedHeadRevisionId", head, "edits", List.of(
                            Map.of("type", "addScene", "sceneId", "scene-main", "order", 0),
                            Map.of("type", "addTrack", "trackId", "video-main", "sceneId", "scene-main",
                                    "trackKind", "VIDEO", "order", 0),
                            renderClip("clip-red", redId, sha256(red), 0)))));
            assertThat(edited.statusCode()).as(edited.body()).isEqualTo(201);
            String revisionId = JSON.readTree(edited.body()).path("revision").path("revisionId").asString();

            HttpResponse<String> rendered = send(port, tenant, token, "POST",
                    "/dev/v1/projects/" + projectId + "/renders", JSON.writeValueAsString(Map.of(
                            "requestId", "render-" + run, "revisionId", revisionId, "timelineId", "timeline-main",
                            "width", 16, "height", 12, "framesPerSecond", 10)));
            assertThat(rendered.statusCode()).as(rendered.body()).isEqualTo(201);
            JsonNode artifact = JSON.readTree(rendered.body()).path("artifact");
            String renderId = artifact.path("artifactId").asString();
            String renderVersion = artifact.path("artifactVersionId").asString();

            // Open both exact subjects, record a comment and an ACCEPT on the project revision.
            HttpResponse<String> projectCase = send(port, tenant, token, "POST", "/dev/v1/reviews",
                    JSON.writeValueAsString(Map.of("subject", Map.of("kind", "PROJECT_REVISION",
                            "projectId", projectId, "revisionId", revisionId))));
            assertThat(projectCase.statusCode()).as(projectCase.body()).isEqualTo(201);
            String projectCaseId = JSON.readTree(projectCase.body()).path("reviewCaseId").asString();
            HttpResponse<String> artifactCase = send(port, tenant, token, "POST", "/dev/v1/reviews",
                    JSON.writeValueAsString(Map.of("subject", Map.of("kind", "ARTIFACT_VERSION",
                            "artifactId", renderId, "artifactVersionId", renderVersion))));
            assertThat(artifactCase.statusCode()).as(artifactCase.body()).isEqualTo(201);
            String artifactCaseId = JSON.readTree(artifactCase.body()).path("reviewCaseId").asString();

            String commentBody = JSON.writeValueAsString(Map.of("requestId", "c-" + run,
                    "expectedCaseRevision", 0, "text", "Trim the first frame", "disposition", "OPEN",
                    "annotation", Map.of("roi", Map.of("x", 0.1, "y", 0.1, "width", 0.5, "height", 0.5))));
            HttpResponse<String> comment = send(port, tenant, token, "POST",
                    "/dev/v1/reviews/" + projectCaseId + "/comments", commentBody);
            assertThat(comment.statusCode()).as(comment.body()).isEqualTo(201);
            // Owner may comment but not decide: assign a different reviewer principal (explicit scope + expiry).
            String reviewerToken = issueDevToken(tenant, principal + "-reviewer", true);
            String expires = java.time.Instant.now().plus(Duration.ofMinutes(20)).toString();
            for (var assigned : List.of(Map.entry(projectCaseId, 1), Map.entry(artifactCaseId, 0))) {
                HttpResponse<String> assignment = send(port, tenant, token, "POST",
                        "/dev/v1/reviews/" + assigned.getKey() + "/assignments", JSON.writeValueAsString(Map.of(
                                "requestId", "assign-" + assigned.getKey() + run,
                                "expectedCaseRevision", assigned.getValue(),
                                "reviewerPrincipalId", principal + "-reviewer", "scopes", List.of("QUALITY"),
                                "expiresAt", expires)));
                assertThat(assignment.statusCode()).as(assignment.body()).isEqualTo(201);
            }
            HttpResponse<String> ownerDecision = send(port, tenant, token, "POST",
                    "/dev/v1/reviews/" + projectCaseId + "/decisions", JSON.writeValueAsString(Map.of(
                            "requestId", "d-owner-" + run, "expectedCaseRevision", 1, "decision", "ACCEPT",
                            "reason", "owner may not decide", "scope", "QUALITY", "confirmed", true)));
            assertThat(ownerDecision.statusCode()).isEqualTo(403);
            HttpResponse<String> decision = send(port, tenant, reviewerToken, "POST",
                    "/dev/v1/reviews/" + projectCaseId + "/decisions", JSON.writeValueAsString(Map.of(
                            "requestId", "d-" + run, "expectedCaseRevision", 1, "decision", "ACCEPT",
                            "reason", "DEV_ONLY check", "scope", "QUALITY", "confirmed", true)));
            assertThat(decision.statusCode()).as(decision.body()).isEqualTo(201);
            assertThat(JSON.readTree(decision.body()).path("establishesApproval").asBoolean()).isFalse();
            HttpResponse<String> artifactDecision = send(port, tenant, reviewerToken, "POST",
                    "/dev/v1/reviews/" + artifactCaseId + "/decisions", JSON.writeValueAsString(Map.of(
                            "requestId", "ad-" + run, "expectedCaseRevision", 0, "decision", "REQUEST_CHANGES",
                            "reason", "Colour is off", "scope", "QUALITY", "confirmed", true)));
            assertThat(artifactDecision.statusCode()).as(artifactDecision.body()).isEqualTo(201);

            // A material project edit: the head moves, so the ACCEPT on the earlier revision must go stale.
            HttpResponse<String> changed = send(port, tenant, token, "POST", editPath, JSON.writeValueAsString(Map.of(
                    "expectedHeadRevisionId", revisionId, "edits", List.of(
                            Map.of("type", "addScene", "sceneId", "scene-two", "order", 1)))));
            assertThat(changed.statusCode()).as(changed.body()).isEqualTo(201);

            stopLauncher(launcher);
            launcher = null;
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            token = issueDevToken(tenant, principal, true);
            reviewerToken = issueDevToken(tenant, principal + "-reviewer", true);

            JsonNode project = JSON.readTree(send(port, tenant, token, "GET", "/dev/v1/reviews/" + projectCaseId, null).body());
            assertThat(project.path("caseRevision").asLong()).isEqualTo(2);
            assertThat(project.path("currentness").asString()).isEqualTo("STALE");
            assertThat(project.path("reviewState").path("status").asString()).isEqualTo("DEV_ASSIGNED_REVIEWER_ACCEPT_STALE");
            assertThat(project.path("reviewState").path("establishesApproval").asBoolean()).isFalse();
            assertThat(project.path("records").get(0).path("text").asString()).isEqualTo("Trim the first frame");
            assertThat(project.path("records").get(0).path("annotation").path("roi").path("width").asDouble())
                    .isEqualTo(0.5);
            assertThat(project.path("subject").path("revisionId").asString()).isEqualTo(revisionId);

            JsonNode art = JSON.readTree(send(port, tenant, token, "GET", "/dev/v1/reviews/" + artifactCaseId, null).body());
            assertThat(art.path("currentness").asString()).isEqualTo("CURRENT");
            assertThat(art.path("reviewState").path("status").asString()).isEqualTo("DEV_ASSIGNED_REVIEWER_REQUEST_CHANGES_CURRENT");
            assertThat(art.path("subject").path("artifactVersionId").asString()).isEqualTo(renderVersion);

            // Idempotent replay after restart returns the original record; a new decision on the stale revision is refused.
            HttpResponse<String> replay = send(port, tenant, token, "POST",
                    "/dev/v1/reviews/" + projectCaseId + "/comments", commentBody);
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            assertThat(JSON.readTree(replay.body()).path("replayed").asBoolean()).isTrue();
            HttpResponse<String> late = send(port, tenant, reviewerToken, "POST",
                    "/dev/v1/reviews/" + projectCaseId + "/decisions", JSON.writeValueAsString(Map.of(
                            "requestId", "late-" + run, "expectedCaseRevision", 2, "decision", "ACCEPT",
                            "reason", "again", "scope", "QUALITY", "confirmed", true)));
            assertThat(late.statusCode()).as(late.body()).isEqualTo(409);
            assertThat(late.body()).contains("REVIEW_SUBJECT_STALE");

            // Durable rows live in the isolated DEV_ONLY schema, not the canonical one.
            try (var connection = DriverManager.getConnection(
                         POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                    var statement = connection.prepareStatement(
                            "SELECT count(*) FROM \"" + schema + "\".media_review_records WHERE tenant_id=?")) {
                statement.setString(1, tenant);
                try (var row = statement.executeQuery()) {
                    assertThat(row.next()).isTrue();
                    assertThat(row.getLong(1)).isEqualTo(3);
                }
            }

            String otherToken = issueDevToken(tenant, "media-dev-review-other-" + run, true);
            HttpResponse<String> foreign = send(port, tenant, otherToken, "GET", "/dev/v1/reviews/" + projectCaseId, null);
            assertThat(foreign.statusCode()).as(foreign.body()).isEqualTo(404);
            assertThat(foreign.body()).doesNotContain("Trim the first frame");
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
        env.put("MEDIA_DEV_REVIEW_ENABLED", "true");
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

    private static String sha256(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder hex = new StringBuilder(digest.length * 2);
        for (byte value : digest) hex.append(String.format("%02x", value & 0xff));
        return hex.toString();
    }

}
