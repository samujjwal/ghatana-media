package com.ghatana.media.integration;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectRequest;
import software.amazon.awssdk.services.s3.model.NoSuchKeyException;
import tools.jackson.databind.JsonNode;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-26 through the hosted Explorer: a real Chromium (Playwright 1.63) drives {@code dev-erasure.html} against a real
 * launcher (PostgreSQL + S3, FFmpeg). The tree is an uploaded PNG and the real MP4 render of it. The browser reviews
 * the tree, places a legal hold (the erase control is disabled; the erase API refuses with LEGAL_HOLD_ACTIVE), releases
 * it, confirms by keyboard and typed id, and reads the receipt. This test then reads every surface directly (S3 GET,
 * PostgreSQL rows, HTTP) and restarts the host; the browser reopens the receipt. Test principals are synthetic.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevExplorerErasureLiveIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void explorerReviewsHoldsReleasesConfirmsAndErasesARealRenderTreeAndReadsTheReceiptAcrossARestart() throws Exception {
        String ffmpeg = firstEnv("MEDIA_DEV_RENDER_FFMPEG", "GHATANA_MEDIA_FFMPEG", "MEDIA_FFMPEG");
        String ffprobe = firstEnv("MEDIA_DEV_RENDER_FFPROBE", "GHATANA_MEDIA_FFPROBE", "MEDIA_FFPROBE");
        assumeTrue(ffmpeg != null && ffprobe != null, "runnable FFmpeg/FFprobe are required for the MP4 render");
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-j26-ui-" + run;
        String owner = "test-principal-owner-" + run;
        String bucket = "media-dev-j26-ui-" + run;
        String schema = "media_dev_j26_ui_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-j26-ui-services-");
        Path spool = Files.createTempDirectory("media-dev-j26-ui-spool-");
        Path log = Files.createTempFile("media-dev-j26-ui-process-", ".log");
        Process launcher = null;
        Process browser = null;
        boolean passed = false;
        try {
            try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.put("MEDIA_DEV_ERASURE_ENABLED", "true");
            environment.put("MEDIA_DEV_SPEECH_SPOOL_DIR", spool.toString());
            environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg);
            environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            // A real tree: an uploaded PNG and the real FFmpeg MP4 rendered from it.
            String token = issueDevToken(tenant, owner);
            byte[] png = solidPng(0xff204080);
            String pngId = upload(port, tenant, owner, token, run + "-still", "still.png", "image/png", png);
            String pngVersion = "sha256:" + sha256(png);
            String workspaceId = get(port, tenant, token, "/dev/v1/context", 200).path("selectedAuthorizedWorkspaceId").asString();
            JsonNode project = post(port, tenant, token, "/dev/v1/projects", Map.of("selectedAuthorizedWorkspaceId", workspaceId,
                    "title", "J-26 UI " + run, "requestId", "j26-ui-project-" + run), 201);
            String projectId = project.path("project").path("projectId").asString();
            String head = project.path("initialRevision").path("revisionId").asString();
            head = post(port, tenant, token, "/dev/v1/projects/" + projectId + "/timelines", Map.of("expectedHeadRevisionId", head,
                    "timelineId", "timeline-main"), 201).path("revision").path("revisionId").asString();
            Map<String, Object> time0 = Map.of("ticks", "0", "rateNumerator", "24", "rateDenominator", "1", "clock", "SOURCE_PRESENTATION");
            Map<String, Object> clip = Map.of("clipId", "clip-still", "sceneId", "scene-main", "trackId", "video-main",
                    "source", Map.of("artifactId", pngId, "artifactVersionId", pngVersion), "sourceIn", time0,
                    "sourceOut", Map.of("ticks", "24", "rateNumerator", "24", "rateDenominator", "1", "clock", "SOURCE_PRESENTATION"),
                    "storyStart", Map.of("ticks", "0", "rateNumerator", "24", "rateDenominator", "1", "clock", "STORY"),
                    "storyDuration", Map.of("ticks", "24", "rateNumerator", "24", "rateDenominator", "1", "clock", "STORY"));
            head = post(port, tenant, token, "/dev/v1/projects/" + projectId + "/timelines/timeline-main/edits", Map.of(
                    "expectedHeadRevisionId", head, "edits", List.of(
                    Map.of("type", "addScene", "sceneId", "scene-main", "order", 0),
                    Map.of("type", "addTrack", "trackId", "video-main", "sceneId", "scene-main", "trackKind", "VIDEO", "order", 0),
                    Map.of("type", "putClip", "clip", clip))), 201).path("revision").path("revisionId").asString();
            JsonNode render = post(port, tenant, token, "/dev/v1/projects/" + projectId + "/renders", Map.of(
                    "requestId", "render-ui-" + run, "revisionId", head, "timelineId", "timeline-main", "width", 320,
                    "height", 180, "framesPerSecond", 10, "format", "mp4"), 201);
            String renderId = render.path("renderId").asString();
            assertThat(render.path("artifact").path("contentType").asString()).isEqualTo("video/mp4");
            List<String> tree = List.of(pngId, renderId);
            Map<String, String> keys = objectKeys(tenant, owner, bucket, tree);
            for (String key : keys.values()) assertThat(s3Exists(bucket, key)).isTrue();

            Path repoRoot = findMediaRepoRoot();
            Path script = repoRoot.resolve("apps/media-experience-explorer/test/dev-erasure-live-browser.mjs");
            assertThat(Files.isRegularFile(script)).isTrue();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            String viteVersion = packageVersion(viteBinary);
            assertThat(viteVersion).isIn("7.3.1", "8.3.0");
            ProcessBuilder builder = new ProcessBuilder("node", script.toString());
            builder.directory(repoRoot.toFile());
            builder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            Map<String, String> env = builder.environment();
            env.put("MEDIA_DEV_ERASURE_BROWSER_TOKEN", issueDevToken(tenant, owner));
            env.put("MEDIA_DEV_ERASURE_BROWSER_ROOT_ID", pngId);
            env.put("MEDIA_DEV_ERASURE_BROWSER_CHILD_ID", renderId);
            env.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(port));
            env.put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            env.put("MEDIA_DEV_VITE_VERSION", viteVersion);
            env.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            browser = builder.start();

            try (BufferedReader output = new BufferedReader(new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8));
                 BufferedWriter input = new BufferedWriter(new OutputStreamWriter(browser.getOutputStream(), StandardCharsets.UTF_8))) {
                // The browser placed a legal hold through the UI: the host records it and refuses the erase API.
                readBrowserEvent(browser, output, "held", log);
                JsonNode holds = get(port, tenant, issueDevToken(tenant, owner), "/dev/v1/legal-holds?artifactId=" + pngId, 200);
                assertThat(holds.path("holds")).hasSize(1);
                assertThat(holds.path("holds").get(0).path("state").asString()).isEqualTo("ACTIVE");
                assertThat(holds.path("holds").get(0).path("placedBy").asString()).isEqualTo(owner);
                assertThat(holds.path("holds").get(0).path("reason").asString()).isEqualTo("TEST legal hold placed from the Explorer");
                HttpResponse<String> refused = send(port, tenant, issueDevToken(tenant, owner), "POST", "/dev/v1/erasures",
                        JSON.writeValueAsString(Map.of("erasureId", "api-under-hold-" + run, "artifactId", pngId, "confirm", true)));
                assertThat(refused.statusCode()).as(refused.body()).isEqualTo(409);
                assertThat(refused.body()).contains("LEGAL_HOLD_ACTIVE");
                for (String key : keys.values()) assertThat(s3Exists(bucket, key)).as("held: " + key).isTrue();
                input.write("hold-verified\n");
                input.flush();

                // The browser released the hold, confirmed by keyboard and typed id, and erased.
                JsonNode erased = readBrowserEvent(browser, output, "erased", log);
                String erasureId = erased.path("erasureId").asString();
                JsonNode hold = get(port, tenant, issueDevToken(tenant, owner), "/dev/v1/legal-holds?artifactId=" + pngId, 200).path("holds").get(0);
                assertThat(hold.path("state").asString()).isEqualTo("RELEASED");
                assertThat(hold.path("releasedBy").asString()).isEqualTo(owner);
                assertThat(hold.path("releaseReason").asString()).isEqualTo("TEST matter closed from the Explorer");
                assertNothingDisclosed(port, tenant, owner, bucket, schema, tree, keys, png, erasureId);

                stopLauncher(launcher);
                launcher = startLauncher(classpath, environment, log);
                awaitReady(launcher, port);
                input.write("host-restarted\n");
                input.flush();
                JsonNode finished = readBrowserEvent(browser, output, "erasure-browser", log);
                assertThat(finished.path("erasureId").asString()).isEqualTo(erasureId);
                assertThat(browser.waitFor(90, TimeUnit.SECONDS)).isTrue();
                assertThat(browser.exitValue()).as("live browser script must pass; see " + log).isZero();
                assertNothingDisclosed(port, tenant, owner, bucket, schema, tree, keys, png, erasureId);
            }
            browser = null;
            passed = true;
        } finally {
            if (browser != null && browser.isAlive()) stopProcessTree(browser);
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("Erasure live failure log retained at " + log);
            deleteTree(services);
            deleteTree(spool);
        }
    }

    private static void assertNothingDisclosed(int port, String tenant, String owner, String bucket, String schema,
                                               List<String> tree, Map<String, String> keys, byte[] png, String erasureId)
            throws Exception {
        for (Map.Entry<String, String> key : keys.entrySet()) {
            assertThat(s3Exists(bucket, key.getValue())).as("S3 object of " + key.getKey()).isFalse();
        }
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement("SELECT count(*) FROM media_artifacts WHERE tenant_id=? AND principal_id=?")) {
            statement.setString(1, tenant);
            statement.setString(2, owner);
            try (var rows = statement.executeQuery()) {
                rows.next();
                assertThat(rows.getInt(1)).as("no artifact row of the owner survives").isZero();
            }
        }
        String token = issueDevToken(tenant, owner);
        for (String id : tree) {
            HttpResponse<String> content = send(port, tenant, token, "GET", "/dev/v1/artifacts/" + id + "/content", null);
            // The content route needs the exact version; an erased id answers a typed 410 before any version check.
            assertThat(content.statusCode()).as(content.body()).isEqualTo(410);
            assertThat(content.body()).contains("ARTIFACT_ERASED");
        }
        assertThat(send(port, tenant, token, "GET", "/api/v1/artifacts/" + tree.getFirst(), null).statusCode()).isEqualTo(404);
        JsonNode receipt = get(port, tenant, token, "/dev/v1/erasures/" + erasureId, 200);
        assertThat(receipt.path("complete").asBoolean()).isTrue();
        assertThat(receipt.path("contentDisclosed").asString()).isEqualTo("none");
        assertThat(receipt.toString()).doesNotContain(java.util.HexFormat.of().formatHex(png).substring(0, 32));
    }

    private static Map<String, String> objectKeys(String tenant, String owner, String bucket, List<String> ids) throws Exception {
        Map<String, String> keys = new java.util.LinkedHashMap<>();
        for (String id : ids) {
            StoredArtifact stored = storedArtifact(POSTGRES, tenant, owner, id);
            keys.put(id, stored.objectReference().substring(("s3://" + bucket + "/").length()));
        }
        return keys;
    }

    private static boolean s3Exists(String bucket, String key) {
        try (var s3 = s3(LOCALSTACK)) {
            s3.headObject(HeadObjectRequest.builder().bucket(bucket).key(key).build());
            return true;
        } catch (NoSuchKeyException absent) {
            return false;
        }
    }

    private static String firstEnv(String... names) {
        for (String name : names) {
            String value = System.getenv(name);
            if (value != null && !value.isBlank()) return value;
        }
        return null;
    }

    private static JsonNode readBrowserEvent(Process browser, BufferedReader output, String expectedEvent, Path log) throws Exception {
        FutureTask<String> lineTask = new FutureTask<>(output::readLine);
        Thread reader = new Thread(lineTask, "media-dev-j26-browser-output");
        reader.setDaemon(true);
        reader.start();
        String line;
        try {
            line = lineTask.get(170, TimeUnit.SECONDS);
        } catch (java.util.concurrent.TimeoutException timeout) {
            stopProcessTree(browser);
            throw new AssertionError("Timed out waiting for browser event " + expectedEvent + "; log="
                    + (Files.exists(log) ? Files.readString(log) : "<none>"), timeout);
        }
        String state = browser.isAlive() ? "still-running" : "exit=" + browser.exitValue();
        assertThat(line).as("browser event " + expectedEvent + "; process=" + state + "; log="
                + (Files.exists(log) ? Files.readString(log) : "<none>")).isNotNull();
        JsonNode event = JSON.readTree(line);
        assertThat(event.path("event").asString()).isEqualTo(expectedEvent);
        return event;
    }

    private static void stopProcessTree(Process process) throws InterruptedException {
        if (process == null) return;
        var descendants = process.toHandle().descendants().toList();
        for (int index = descendants.size() - 1; index >= 0; index--) descendants.get(index).destroy();
        process.destroy();
        if (!process.waitFor(3, TimeUnit.SECONDS)) process.destroyForcibly();
        for (ProcessHandle descendant : descendants) {
            if (descendant.isAlive()) descendant.destroyForcibly();
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
        Path globalVite = globalNodeModules().resolve("vitest/node_modules/vite/bin/vite.js");
        assertThat(Files.isRegularFile(globalVite)).as("a pinned Vite is required").isTrue();
        assertThat(packageVersion(globalVite)).isEqualTo("8.3.0");
        return globalVite;
    }

    private static Path findPlaywrightModule(Path repoRoot) throws Exception {
        for (String candidate : List.of("node_modules/playwright/index.mjs",
                "apps/media-experience-explorer/node_modules/playwright/index.mjs")) {
            Path local = repoRoot.resolve(candidate);
            if (Files.isRegularFile(local)) return local;
        }
        Path global = globalNodeModules().resolve("@playwright/test/index.mjs");
        assertThat(Files.isRegularFile(global)).as("Playwright 1.63.0 is required").isTrue();
        return global;
    }

    private static String packageVersion(Path executable) throws Exception {
        Path resolved = executable.toRealPath();
        Path packageJson = resolved.getParent().getParent().resolve("package.json");
        return JSON.readTree(Files.readString(packageJson)).path("version").asString();
    }

    private static Path globalNodeModules() throws Exception {
        Process npm = new ProcessBuilder("npm", "root", "-g").redirectErrorStream(true).start();
        byte[] output = npm.getInputStream().readAllBytes();
        assertThat(npm.waitFor(10, TimeUnit.SECONDS)).isTrue();
        return Path.of(new String(output, StandardCharsets.UTF_8).trim());
    }
}
