package com.ghatana.media.integration;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import tools.jackson.databind.JsonNode;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.sql.DriverManager;
import java.time.Duration;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import com.ghatana.media.integration.MediaDevLiveFixtures.StoredArtifact;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-11 Explorer page "Region edit" against REAL processes: the real launcher (PostgreSQL + S3, request ledger, region edit
 * history), the real Florence-2 sidecar that produces the track of a generated variable-frame-rate video, real FFmpeg, and a
 * real Chromium driving the page (see {@code dev-region-edit-live-browser.mjs}): lineage, a pixelate edit, verified playback
 * with the overlay compared with the manifest and with the browser's own decode of the original, undo, a stale-base conflict
 * from a second browser context, a launcher restart and a rights revocation. This class sequences the host side (restart,
 * revocation) and reads everything back independently from PostgreSQL and S3. TEST identities only; the rights statement is a
 * synthetic test principal's, not a real approval. GPU contention on the shared detector is retried, the track is never faked.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevExplorerRegionEditLiveIT {
    private static final String TRACKS = "/dev/v1/vision/tracks";

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void explorerEditsATrackedRegionUndoesItAndShowsStaleRestartAndRevocationInRealChromium() throws Exception {
        Path home = Path.of(System.getProperty("user.home"));
        Path models = Path.of(System.getenv().getOrDefault("MEDIA_LOCAL_VISION_MODELS_ROOT",
                home.resolve(".local/share/ghatana-media/models").toString()));
        Path python = Path.of(System.getenv().getOrDefault("MEDIA_LOCAL_VISION_PYTHON",
                home.resolve(".local/share/ghatana-media/runtimes/vision-venv/bin/python").toString()));
        Path script = locate("tools/model-runtimes/vision/vision_sidecar.py");
        assertThat(script).as("vision_sidecar.py").isNotNull();
        assertThat(Files.isExecutable(python)).as("sidecar python " + python).isTrue();
        assertThat(models.resolve("florence-2-large/ghatana-model-manifest.json")).as("Florence manifest").exists();
        assertThat(models.resolve("qwen2.5-vl-7b-instruct/ghatana-model-manifest.json")).as("Qwen manifest").exists();
        String ffmpegEnv = System.getenv("MEDIA_DEV_RENDER_FFMPEG");
        String ffprobeEnv = System.getenv("MEDIA_DEV_RENDER_FFPROBE");
        assertThat(ffmpegEnv).as("MEDIA_DEV_RENDER_FFMPEG").isNotBlank();
        assertThat(ffprobeEnv).as("MEDIA_DEV_RENDER_FFPROBE").isNotBlank();
        Path ffmpeg = Path.of(ffmpegEnv);
        Path ffprobe = Path.of(ffprobeEnv);
        Path digestCache = Path.of(System.getenv().getOrDefault("MEDIA_LOCAL_MODEL_DIGEST_CACHE",
                Path.of(System.getProperty("java.io.tmpdir"), "ghatana-media-vision-model-digests.json").toString()));
        Path repoRoot = findMediaRepoRoot();

        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-region-ui-" + run;
        String principal = "media-dev-region-ui-" + run;
        String bucket = "media-dev-region-ui-" + run.substring(0, 12);
        String schema = "media_dev_region_ui_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        int sidecarPort;
        try (var socket = new java.net.ServerSocket(0)) { sidecarPort = socket.getLocalPort(); }
        byte[] tokenBytes = new byte[24];
        new SecureRandom().nextBytes(tokenBytes);
        String sidecarToken = HexFormat.of().formatHex(tokenBytes);
        Path services = Files.createTempDirectory("media-dev-region-ui-services-");
        Path work = Files.createTempDirectory("media-dev-region-ui-work-");
        Path log = Files.createTempFile("media-dev-region-ui-process-", ".log");
        Process sidecar = null;
        Process launcher = null;
        Process browser = null;
        boolean passed = false;
        try {
            try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
            sidecar = startSidecar(python, script, models, home, sidecarPort, sidecarToken, digestCache);
            awaitSidecar(sidecar, sidecarPort, sidecarToken);
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.put("MEDIA_LOCAL_VISION_MODELS_ROOT", models.toString());
            environment.put("MEDIA_LOCAL_VISION_SIDECAR_URL", "http://127.0.0.1:" + sidecarPort);
            environment.put("MEDIA_LOCAL_VISION_SIDECAR_TOKEN", sidecarToken);
            environment.put("MEDIA_LOCAL_VISION_TIMEOUT_SECONDS", "480");
            environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
            environment.put("MEDIA_DEV_REGION_EDIT_ENABLED", "true");
            environment.put("MEDIA_LOCAL_MODEL_DIGEST_CACHE", digestCache.toString());
            environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg.toString());
            environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe.toString());
            String token = issueDevToken(tenant, principal);
            launcher = startLauncher(classpath, environment, log);
            awaitReadyPatiently(launcher, port);

            // ---- real input and the REAL track (contention retried, never faked) ----
            byte[] video = TrackingVideoFixture.generate(ffmpeg, work, true);
            Path videoFile = work.resolve("source.mp4");
            Files.write(videoFile, video);
            TrackingVideoFixture.Probe probe = TrackingVideoFixture.probe(ffprobe, videoFile);
            assertThat(irregular(probe.pts().stream().mapToLong(Long::longValue).toArray())).as("variable frame rate").isTrue();
            String videoId = upload(port, tenant, principal, token, run + "-video", "motion.mp4", "video/mp4", video);
            String version = "sha256:" + sha256(video);
            String attestationId = attest(port, tenant, token, videoId, version, "ui");
            JsonNode tracked = postRetrying(port, tenant, token, TRACKS, Map.of("requestId", "track-" + run, "artifactId", videoId,
                    "artifactVersionId", version, "maxFrames", 12), 201);
            String tracksId = tracked.path("outputId").asString();
            String tracksVersion = tracked.path("artifact").path("artifactVersionId").asString();
            JsonNode tracksDoc = JSON.readTree(new String(s3Bytes(LOCALSTACK, bucket,
                    storedArtifact(POSTGRES, tenant, principal, tracksId)), StandardCharsets.UTF_8));
            String carTrack = carTrackId(tracksDoc, probe);
            assertThat(carTrack).as("a Florence track that follows the car").isNotNull();
            int videosBefore = countArtifacts(tenant, principal, "video/mp4");
            String lineageId = "L-ui-" + run;

            // ---- the browser journey, sequenced with the host side ----
            Path browserScript = repoRoot.resolve("apps/media-experience-explorer/test/dev-region-edit-live-browser.mjs");
            assertThat(browserScript).isRegularFile();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            ProcessBuilder builder = new ProcessBuilder("node", browserScript.toString());
            builder.directory(repoRoot.toFile());
            builder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            Map<String, String> env = builder.environment();
            env.put("MEDIA_DEV_REGION_BROWSER_TOKEN", token);
            env.put("MEDIA_DEV_REGION_VIDEO_ID", videoId);
            env.put("MEDIA_DEV_REGION_VIDEO_VERSION", version);
            env.put("MEDIA_DEV_REGION_TRACKS_ID", tracksId);
            env.put("MEDIA_DEV_REGION_TRACKS_VERSION", tracksVersion);
            env.put("MEDIA_DEV_REGION_TRACK_ID", carTrack);
            env.put("MEDIA_DEV_REGION_LINEAGE_ID", lineageId);
            env.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(port));
            env.put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            env.put("MEDIA_DEV_VITE_VERSION", packageVersion(viteBinary));
            env.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            browser = builder.start();
            JsonNode last;
            try (BufferedReader output = new BufferedReader(new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8));
                 BufferedWriter input = new BufferedWriter(new OutputStreamWriter(browser.getOutputStream(), StandardCharsets.UTF_8))) {
                JsonNode restartEvent = readEvent(browser, output, "ready-for-restart", log, 600);
                assertThat(restartEvent.path("digests")).hasSize(4);
                List<Map<String, Object>> rows = versionRows(tenant, lineageId);
                assertThat(rows).extracting(r -> r.get("kind")).containsExactly("BASE", "EDIT", "UNDO", "EDIT");
                assertThat(rows.get(2)).containsEntry("restores", 1);
                assertThat(countArtifacts(tenant, principal, "video/mp4")).as("two edits registered two videos; the stale request none")
                        .isEqualTo(videosBefore + 2);
                stopLauncher(launcher);
                launcher = startLauncher(classpath, environment, log);
                awaitReadyPatiently(launcher, port);
                token = issueDevToken(tenant, principal);
                input.write("host-restarted " + token + "\n");
                input.flush();

                readEvent(browser, output, "ready-for-revoke", log, 300);
                HttpResponse<String> revoke = send(port, tenant, token, "POST", "/dev/v1/rights/attestations/" + attestationId + "/revoke",
                        JSON.writeValueAsString(Map.of("reason", "TEST: revoked to prove fail-closed")));
                assertThat(revoke.statusCode()).as(revoke.body()).isEqualTo(200);
                input.write("rights-revoked\n");
                input.flush();
                last = readEvent(browser, output, "region-edited", log, 300);
            }
            assertThat(browser.waitFor(120, TimeUnit.SECONDS)).isTrue();
            assertThat(browser.exitValue()).as("live browser script must pass; see " + log).isZero();
            System.out.println("J11_UI_BROWSER_EVENT " + last);
            browser = null;

            // ---- independent readback of what the UI produced ----
            List<Map<String, Object>> rows = versionRows(tenant, lineageId);
            assertThat(rows).extracting(r -> r.get("kind")).as("the denied edit appended nothing").containsExactly("BASE", "EDIT", "UNDO", "EDIT");
            assertThat(countArtifacts(tenant, principal, "video/mp4")).isEqualTo(videosBefore + 2);
            StoredArtifact editedRow = storedArtifact(POSTGRES, tenant, principal, last.path("editedArtifactId").asString());
            byte[] edited = s3Bytes(LOCALSTACK, bucket, editedRow);
            assertThat(sha256(edited)).isEqualTo(last.path("editedSha256").asString()).isEqualTo(editedRow.sha256());
            assertThat(s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, videoId))).as("the original never changed").isEqualTo(video);
            Path editedFile = work.resolve("edited.mp4");
            Files.write(editedFile, edited);
            TrackingVideoFixture.Probe editedProbe = TrackingVideoFixture.probe(ffprobe, editedFile);
            assertThat(editedProbe.pts()).as("every frame's PTS preserved").isEqualTo(probe.pts());
            for (JsonNode p : last.path("probes")) assertThat(p.path("overlayMask").asString()).isEqualTo(p.path("expectedMask").asString());
            passed = true;
        } finally {
            if (browser != null && browser.isAlive()) stopProcessTree(browser);
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            if (sidecar != null) sidecar.destroyForcibly();
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            deleteTree(services);
            deleteTree(work);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("Explorer region edit live failure log retained at " + log);
        }
    }

    private static JsonNode readEvent(Process browser, BufferedReader output, String expectedEvent, Path log, int seconds) throws Exception {
        FutureTask<String> lineTask = new FutureTask<>(output::readLine);
        Thread reader = new Thread(lineTask, "media-dev-region-live-browser-output");
        reader.setDaemon(true);
        reader.start();
        String line;
        try {
            line = lineTask.get(seconds, TimeUnit.SECONDS);
        } catch (java.util.concurrent.TimeoutException timeout) {
            stopProcessTree(browser);
            throw new AssertionError("Timed out waiting for browser event " + expectedEvent + "; log="
                    + (Files.exists(log) ? Files.readString(log) : "<no log>"), timeout);
        }
        assertThat(line).as("browser event " + expectedEvent + "; process=" + (browser.isAlive() ? "running" : "exit=" + browser.exitValue())
                + "; log=" + (Files.exists(log) ? Files.readString(log) : "<no log>")).isNotNull();
        JsonNode event = JSON.readTree(line);
        assertThat(event.path("event").asString()).isEqualTo(expectedEvent);
        return event;
    }

    private static List<Map<String, Object>> versionRows(String tenant, String lineageId) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement("SELECT version_number, kind, restores_version_number "
                     + "FROM media_dev_region_edit_versions WHERE tenant_id=? AND lineage_id=? ORDER BY version_number")) {
            statement.setString(1, tenant);
            statement.setString(2, lineageId);
            List<Map<String, Object>> rows = new java.util.ArrayList<>();
            try (var set = statement.executeQuery()) {
                while (set.next()) {
                    Map<String, Object> row = new java.util.LinkedHashMap<>();
                    row.put("version", set.getInt(1));
                    row.put("kind", set.getString(2));
                    int restores = set.getInt(3);
                    row.put("restores", set.wasNull() ? null : restores);
                    rows.add(row);
                }
            }
            return rows;
        }
    }

    private static boolean irregular(long[] pts) {
        long first = pts[1] - pts[0];
        for (int i = 2; i < pts.length; i++) if (pts[i] - pts[i - 1] != first) return true;
        return false;
    }

    /** The Florence track (car or truck) whose observations best follow the analytic car trajectory. */
    private static String carTrackId(JsonNode document, TrackingVideoFixture.Probe probe) {
        String best = null;
        double bestScore = 0;
        for (JsonNode track : document.path("tracks")) {
            int n = track.path("observations").size();
            if (n < 3) continue;
            double sum = 0;
            for (JsonNode o : track.path("observations")) {
                JsonNode b = o.path("box");
                double seconds = o.path("pts").asLong() * (double) probe.timeBaseNum() / probe.timeBaseDen();
                sum += TrackingVideoFixture.iou(TrackingVideoFixture.carBox(seconds),
                        new double[] {b.path("x").asDouble(), b.path("y").asDouble(), b.path("width").asDouble(),
                                b.path("height").asDouble()});
            }
            double mean = sum / n;
            if (mean >= 0.5 && n * mean > bestScore) {
                bestScore = n * mean;
                best = track.path("trackId").asString();
            }
        }
        return best;
    }

    private static JsonNode trackById(JsonNode document, String trackId) {
        for (JsonNode track : document.path("tracks")) if (trackId.equals(track.path("trackId").asString())) return track;
        throw new AssertionError("no track " + trackId);
    }

    /** The real detector is shared with other work: contention (503/INFERENCE_FAILED) is retried with the same request id. */
    private static JsonNode postRetrying(int port, String tenant, String token, String path, Object body, int status)
            throws Exception {
        HttpResponse<String> response = null;
        for (int attempt = 1; attempt <= 5; attempt++) {
            response = send(port, tenant, token, "POST", path, JSON.writeValueAsString(body));
            if (response.statusCode() == status) return JSON.readTree(response.body());
            System.out.println("J11-IT-RETRY attempt=" + attempt + " status=" + response.statusCode() + " " + response.body());
            Thread.sleep(5_000L * attempt);
        }
        throw new AssertionError(path + " -> " + response.statusCode() + " " + response.body());
    }

    private static String attest(int port, String tenant, String token, String artifactId, String version, String which)
            throws Exception {
        HttpResponse<String> attested = send(port, tenant, token, "POST", "/dev/v1/rights/attestations",
                JSON.writeValueAsString(Map.of("artifactId", artifactId, "artifactVersionId", version,
                        "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                        "basis", "TEST: synthetic video generated by the integration test (" + which + " statement)")));
        assertThat(attested.statusCode()).as(attested.body()).isEqualTo(201);
        return JSON.readTree(attested.body()).path("attestationId").asString();
    }

    private static int countArtifacts(String tenant, String principal, String contentType) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT count(*) FROM media_artifacts WHERE tenant_id=? AND principal_id=? AND content_type=?")) {
            statement.setString(1, tenant);
            statement.setString(2, principal);
            statement.setString(3, contentType);
            try (var row = statement.executeQuery()) {
                row.next();
                return row.getInt(1);
            }
        }
    }

    private static Process startSidecar(Path python, Path script, Path models, Path home, int port, String token,
                                        Path digestCache) throws Exception {
        ProcessBuilder sidecarBuilder = new ProcessBuilder(python.toString(), "-I", script.toString(), "--port",
                Integer.toString(port), "--models-root", models.toString());
        sidecarBuilder.redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD);
        sidecarBuilder.environment().clear();
        sidecarBuilder.environment().putAll(Map.of("GHATANA_VISION_SIDECAR_TOKEN", token,
                "HOME", home.toString(), "PATH", "/usr/bin:/bin", "HF_HUB_OFFLINE", "1", "TRANSFORMERS_OFFLINE", "1",
                "MEDIA_LOCAL_MODEL_DIGEST_CACHE", digestCache.toString()));
        return sidecarBuilder.start();
    }

    /** Launcher composition digest-verifies the model files (first run on a loaded host can take minutes). */
    private static void awaitReadyPatiently(Process process, int port) throws Exception {
        long deadline = System.nanoTime() + Duration.ofMinutes(20).toNanos();
        while (System.nanoTime() < deadline) {
            if (!process.isAlive()) throw new AssertionError("MediaLauncher exited: " + process.exitValue());
            try {
                HttpResponse<String> response = HttpClient.newHttpClient().send(
                        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/health/ready")).GET().build(),
                        HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() == 200) return;
            } catch (java.io.IOException ignored) { }
            Thread.sleep(500);
        }
        throw new AssertionError("MediaLauncher did not become ready within 20 minutes");
    }

    private static void awaitSidecar(Process process, int port, String token) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(120).toNanos();
        while (System.nanoTime() < deadline) {
            if (!process.isAlive()) throw new AssertionError("vision sidecar exited: " + process.exitValue());
            try {
                HttpResponse<String> response = HttpClient.newHttpClient().send(
                        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/v1/health"))
                                .header("Authorization", "Bearer " + token).GET().build(),
                        HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() == 200) return;
            } catch (java.io.IOException ignored) { }
            Thread.sleep(250);
        }
        throw new AssertionError("vision sidecar did not become healthy");
    }

    private static Path locate(String relative) {
        for (Path dir = Path.of("").toAbsolutePath(); dir != null; dir = dir.getParent()) {
            Path candidate = dir.resolve(relative);
            if (Files.isRegularFile(candidate)) return candidate;
        }
        return null;
    }

    private static void stopProcessTree(Process process) throws InterruptedException {
        var descendants = process.toHandle().descendants().toList();
        for (int index = descendants.size() - 1; index >= 0; index--) descendants.get(index).destroy();
        process.destroy();
        if (!process.waitFor(3, TimeUnit.SECONDS)) process.destroyForcibly();
        for (ProcessHandle descendant : descendants) if (descendant.isAlive()) descendant.destroyForcibly();
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
        if (Files.isRegularFile(local)) return local;
        Path pnpm = findPnpmPackageBinary(repoRoot, "vite@", "vite/bin/vite.js");
        if (pnpm != null) return pnpm;
        Path global = globalNodeModules().resolve("vitest/node_modules/vite/bin/vite.js");
        assertThat(Files.isRegularFile(global)).as("a Vite installation is required").isTrue();
        return global;
    }

    private static Path findPlaywrightModule(Path repoRoot) throws Exception {
        for (String candidate : List.of("node_modules/playwright/index.mjs",
                "apps/media-experience-explorer/node_modules/playwright/index.mjs")) {
            Path path = repoRoot.resolve(candidate);
            if (Files.isRegularFile(path)) return path;
        }
        Path pnpm = findPnpmPackageBinary(repoRoot, "playwright@1.63.0", "playwright/index.mjs");
        if (pnpm != null) return pnpm;
        Path global = globalNodeModules().resolve("@playwright/test/index.mjs");
        assertThat(Files.isRegularFile(global)).as("Playwright 1.63.0 is required").isTrue();
        return global;
    }

    private static Path findPnpmPackageBinary(Path repoRoot, String packagePrefix, String relativeBinary) throws Exception {
        Path pnpmStore = repoRoot.resolve("node_modules/.pnpm");
        if (!Files.isDirectory(pnpmStore)) return null;
        try (var entries = Files.list(pnpmStore)) {
            return entries.filter(path -> path.getFileName().toString().startsWith(packagePrefix))
                    .map(path -> path.resolve("node_modules").resolve(relativeBinary))
                    .filter(Files::isRegularFile).findFirst().orElse(null);
        }
    }

    private static String packageVersion(Path executable) throws Exception {
        Path packageJson = executable.toRealPath().getParent().getParent().resolve("package.json");
        return JSON.readTree(Files.readString(packageJson)).path("version").asString();
    }

    private static Path globalNodeModules() throws Exception {
        Process npm = new ProcessBuilder("npm", "root", "-g").redirectErrorStream(true).start();
        byte[] output = npm.getInputStream().readAllBytes();
        assertThat(npm.waitFor(10, TimeUnit.SECONDS)).isTrue();
        return Path.of(new String(output, StandardCharsets.UTF_8).trim());
    }
}
