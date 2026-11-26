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
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import com.ghatana.media.integration.MediaDevLiveFixtures.StoredArtifact;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-05 `media.dev.outcome-vision-detection-and-tracking` against REAL processes: the real launcher with the durable
 * PostgreSQL + S3 artifact store (Testcontainers), the real loopback Florence-2 sidecar, real FFmpeg/ffprobe and a
 * generated video with known motion. Covers rights missing/granted/revoked, the exact-PTS tracks compared with the
 * analytic ground truth and ffprobe, independent PostgreSQL row and S3 byte readback, malformed/out-of-frame ROI over
 * HTTP, a real Chromium session on the Explorer page (overlay synced to PTS and to the video content, launcher
 * restart, reopen, rights revocation), the real sidecar killed mid-run (UNKNOWN, then idempotent retry), and replay
 * after restart. Nothing here is a mock model. Missing runtime prerequisites FAIL the test.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevVisionTrackingLiveIT {
    private static final String TRACKS = "/dev/v1/vision/tracks";
    private static final String ROI = "/dev/v1/vision/roi-analyses";

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void realLauncherTracksExactPtsAgainstGroundTruthThroughBrowserRestartRevocationAndSidecarKill() throws Exception {
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
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-vision-track-" + run;
        String principal = "media-dev-vision-track-" + run;
        String bucket = "media-dev-vision-track-" + run;
        String schema = "media_dev_vision_track_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        int sidecarPort;
        try (var socket = new java.net.ServerSocket(0)) { sidecarPort = socket.getLocalPort(); }
        byte[] tokenBytes = new byte[24];
        new SecureRandom().nextBytes(tokenBytes);
        String sidecarToken = HexFormat.of().formatHex(tokenBytes);
        Path services = Files.createTempDirectory("media-dev-vision-track-services-");
        Path work = Files.createTempDirectory("media-dev-vision-track-work-");
        Path log = Files.createTempFile("media-dev-vision-track-process-", ".log");
        Process sidecar = null;
        Process launcher = null;
        Process browser = null;
        boolean passed = false;
        try {
            try (var s3 = s3(LOCALSTACK)) {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
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
            // Composition verifies the multi-GB model digests; the opt-in stat-keyed digest cache makes restarts fast.
            environment.put("MEDIA_LOCAL_MODEL_DIGEST_CACHE", digestCache.toString());
            environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg.toString());
            environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe.toString());
            String token = issueDevToken(tenant, principal);
            launcher = startLauncher(classpath, environment, log);
            awaitReadyPatiently(launcher, port);

            // ---- real input: FFmpeg-generated video with known motion, uploaded over HTTP ----
            byte[] video = TrackingVideoFixture.generate(ffmpeg, work, false);
            Path videoFile = work.resolve("probe.mp4");
            Files.write(videoFile, video);
            TrackingVideoFixture.Probe probe = TrackingVideoFixture.probe(ffprobe, videoFile);
            String videoId = upload(port, tenant, principal, token, run + "-video", "motion.mp4", "video/mp4", video);
            String version = "sha256:" + sha256(video);

            JsonNode status = get(port, tenant, token, "/dev/v1/vision/status", 200);
            assertThat(status.path("florence").path("state").asString()).isEqualTo("QUALIFIED");
            assertThat(status.path("videoTrackingAvailable").asBoolean()).isTrue();

            // ---- rights missing: refused, nothing read, inferred or registered ----
            Map<String, Object> trackBody = Map.of("requestId", "track-" + run, "artifactId", videoId,
                    "artifactVersionId", version, "maxFrames", 16);
            HttpResponse<String> noRights = send(port, tenant, token, "POST", TRACKS, JSON.writeValueAsString(trackBody));
            assertThat(noRights.statusCode()).as(noRights.body()).isEqualTo(403);
            assertThat(noRights.body()).contains("RIGHTS_DENIED");
            assertThat(countArtifacts(tenant, principal, "application/json")).isZero();

            String attestationId = attest(port, tenant, token, videoId, version, "first");

            // ---- stale version, foreign principal, malformed/out-of-frame ROI: typed refusals ----
            HttpResponse<String> stale = send(port, tenant, token, "POST", TRACKS, JSON.writeValueAsString(Map.of(
                    "requestId", "stale-" + run, "artifactId", videoId, "artifactVersionId", "sha256:" + "2".repeat(64))));
            assertThat(stale.statusCode()).isEqualTo(404);
            assertThat(stale.body()).contains("SOURCE_VERSION_NOT_FOUND");
            String otherToken = issueDevToken(tenant, "someone-else-" + run);
            assertThat(send(port, tenant, otherToken, "POST", TRACKS, JSON.writeValueAsString(trackBody)).statusCode())
                    .isEqualTo(404);
            for (var bad : List.of(roi(-1, 0, 10, 10), roi(0, 0, 0, 10), roi(0, 0, 10, -1), roi(630, 0, 20, 20),
                    roi(0, 350, 20, 20))) {
                HttpResponse<String> refused = send(port, tenant, token, "POST", ROI, JSON.writeValueAsString(Map.of(
                        "requestId", "roi-bad-" + bad.hashCode(), "artifactId", videoId, "artifactVersionId", version,
                        "tasks", List.of("detect"), "roi", bad)));
                assertThat(refused.statusCode()).as(bad + " " + refused.body()).isEqualTo(422);
                assertThat(refused.body()).containsPattern("ROI_(NEGATIVE|ZERO_SIZE|OUT_OF_FRAME)");
            }
            assertThat(countArtifacts(tenant, principal, "application/json")).isZero();

            // ---- tracks against ground truth, exact PTS equal to ffprobe ----
            JsonNode tracked = post(port, tenant, token, TRACKS, trackBody, 201);
            String outputId = tracked.path("outputId").asString();
            assertThat(tracked.path("admission").path("attestationIds").get(0).asString()).isEqualTo(attestationId);
            assertThat(tracked.path("lineage").path("source").path("sha256").asString()).isEqualTo(sha256(video));
            StoredArtifact row = storedArtifact(POSTGRES, tenant, principal, outputId);
            assertThat(row.contentType()).isEqualTo("application/json");
            byte[] stored = s3Bytes(LOCALSTACK, bucket, row);
            assertThat(sha256(stored)).isEqualTo(row.sha256()).isEqualTo(tracked.path("artifact").path("sha256").asString());
            JsonNode document = JSON.readTree(new String(stored, StandardCharsets.UTF_8));
            System.out.println("J05-IT-TRACKS " + new String(stored, StandardCharsets.UTF_8));
            assertThat(document.path("model").path("id").asString()).isEqualTo("florence-community/Florence-2-large");
            assertThat(document.path("video").path("timeBase").path("den").asLong()).isEqualTo(probe.timeBaseDen());
            double minCarIou = 1;
            double minPersonIou = 1;
            int carObs = 0;
            int personObs = 0;
            for (JsonNode frame : document.path("frames")) {
                assertThat(frame.path("pts").asLong()).isEqualTo(probe.pts().get(frame.path("frameIndex").asInt()));
            }
            for (JsonNode track : document.path("tracks")) {
                boolean carLike = "car".equals(track.path("label").asString()) || "truck".equals(track.path("label").asString());
                boolean person = "person".equals(track.path("label").asString());
                for (JsonNode observation : track.path("observations")) {
                    double seconds = observation.path("pts").asLong() * (double) probe.timeBaseNum() / probe.timeBaseDen();
                    JsonNode b = observation.path("box");
                    double[] actual = {b.path("x").asDouble(), b.path("y").asDouble(), b.path("width").asDouble(),
                            b.path("height").asDouble()};
                    assertThat(actual[0] + actual[2]).isLessThanOrEqualTo(640);
                    assertThat(actual[1] + actual[3]).isLessThanOrEqualTo(360);
                    if (carLike && track.path("observations").size() > 2) {
                        minCarIou = Math.min(minCarIou, TrackingVideoFixture.iou(TrackingVideoFixture.carBox(seconds), actual));
                        carObs++;
                    } else if (person && track.path("observations").size() > 2) {
                        minPersonIou = Math.min(minPersonIou, TrackingVideoFixture.iou(TrackingVideoFixture.personBox(seconds), actual));
                        personObs++;
                    }
                }
            }
            System.out.println("J05-IT-ACCURACY carObs=" + carObs + " minIoU=" + minCarIou + " personObs=" + personObs
                    + " minIoU=" + minPersonIou);
            assertThat(carObs).isGreaterThanOrEqualTo(document.path("frames").size() - 1);
            assertThat(personObs).isGreaterThanOrEqualTo(document.path("frames").size() - 1);
            assertThat(minCarIou).isGreaterThanOrEqualTo(0.75);
            assertThat(minPersonIou).isGreaterThanOrEqualTo(0.75);
            assertThat(s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, videoId)))
                    .as("the source video is never modified").isEqualTo(video);

            // ---- Generic OCR is owned by Document Intelligence and has no Media local fallback. ----
            HttpResponse<String> roiOcr = send(port, tenant, token, "POST", ROI, JSON.writeValueAsString(Map.of(
                    "requestId", "roi-ocr-" + run, "artifactId", videoId, "artifactVersionId", version,
                    "tasks", List.of("ocr"), "frameIndex", 0, "roi", roi(0, 0, 320, 100))));
            assertThat(roiOcr.statusCode()).as(roiOcr.body()).isEqualTo(422);
            assertThat(roiOcr.body()).contains("DOCUMENT_INTELLIGENCE_NOT_ADMITTED").contains("NOT_ADMITTED");

            // ---- real Chromium on the Explorer page, launcher restart, reopen, revocation ----
            Path repoRoot = findMediaRepoRoot();
            Path browserScript = repoRoot.resolve("apps/media-experience-explorer/test/dev-vision-tracks-live-browser.mjs");
            assertThat(browserScript).exists();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            String viteVersion = packageVersion(viteBinary);
            assertThat(viteVersion).isIn("7.3.1", "8.3.0");
            ProcessBuilder builder = new ProcessBuilder("node", browserScript.toString());
            builder.directory(repoRoot.toFile());
            builder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            Map<String, String> env = builder.environment();
            env.put("MEDIA_DEV_VISION_BROWSER_TOKEN", token);
            env.put("MEDIA_DEV_VISION_BROWSER_VIDEO_ID", videoId);
            env.put("MEDIA_DEV_VISION_BROWSER_VIDEO_SHA256", sha256(video));
            env.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(port));
            env.put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            env.put("MEDIA_DEV_VITE_VERSION", viteVersion);
            env.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            browser = builder.start();
            try (BufferedReader output = new BufferedReader(new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8));
                    BufferedWriter input = new BufferedWriter(new OutputStreamWriter(browser.getOutputStream(), StandardCharsets.UTF_8))) {
                JsonNode created = readBrowserEvent(browser, output, "created", log, 700);
                System.out.println("J05-BROWSER-CREATED " + created);
                String browserOutputId = created.path("outputId").asString();
                String browserSha = created.path("outputSha").asString();
                StoredArtifact browserRow = storedArtifact(POSTGRES, tenant, principal, browserOutputId);
                assertThat(browserRow.sha256()).isEqualTo(browserSha);
                assertThat(sha256(s3Bytes(LOCALSTACK, bucket, browserRow))).isEqualTo(browserSha);
                // The browser used a different request than the HTTP run above: two tracks outputs plus one ROI.
                assertThat(countArtifacts(tenant, principal, "application/json")).isEqualTo(3);

                stopLauncher(launcher);
                launcher = startLauncher(classpath, environment, log);
                awaitReadyPatiently(launcher, port);
                input.write("host-restarted " + issueDevToken(tenant, principal) + "\n");
                input.flush();
                JsonNode readback = readBrowserEvent(browser, output, "readback", log, 120);
                assertThat(readback.path("outputId").asString()).isEqualTo(browserOutputId);
                assertThat(readback.path("outputSha").asString()).isEqualTo(browserSha);

                // Revoke rights for the exact version, then the page's next request must be denied.
                token = issueDevToken(tenant, principal);
                HttpResponse<String> revoked = send(port, tenant, token, "POST",
                        "/dev/v1/rights/attestations/" + attestationId + "/revoke",
                        JSON.writeValueAsString(Map.of("reason", "TEST: revoked to prove fail-closed")));
                assertThat(revoked.statusCode()).as(revoked.body()).isEqualTo(200);
                input.write("rights-revoked\n");
                input.flush();
                readBrowserEvent(browser, output, "denied", log, 120);
                assertThat(browser.waitFor(120, TimeUnit.SECONDS)).isTrue();
                assertThat(browser.exitValue()).as("live browser script must pass; see " + log).isZero();
                assertThat(countArtifacts(tenant, principal, "application/json"))
                        .as("the denied request registered nothing").isEqualTo(3);
            }
            browser = null;

            // ---- restart readback of the HTTP-created output (new launcher already running) ----
            JsonNode reopened = get(port, tenant, token, "/dev/v1/vision/outputs/" + outputId, 200);
            assertThat(reopened.path("artifact").path("sha256").asString()).isEqualTo(row.sha256());
            assertThat(reopened.path("lineage").path("source").path("artifactVersionId").asString()).isEqualTo(version);
            assertThat(reopened.path("lineage").path("tracking").path("algorithm").asString()).isEqualTo("GREEDY_IOU_LABEL_V1");
            assertThat(reopened.path("lineage").path("models").get(0).path("spdxLicense").asString()).isEqualTo("MIT");
            // Revoked: even a replay of the earlier request is refused (rights are re-resolved on every dispatch).
            HttpResponse<String> replayRevoked = send(port, tenant, token, "POST", TRACKS, JSON.writeValueAsString(trackBody));
            assertThat(replayRevoked.statusCode()).as(replayRevoked.body()).isEqualTo(403);
            assertThat(replayRevoked.body()).contains("RIGHTS_REVOKED");

            // ---- the real sidecar is killed mid-run: UNKNOWN, never success; retry is idempotent by requestId ----
            attest(port, tenant, token, videoId, version, "second");
            Map<String, Object> killBody = Map.of("requestId", "kill-" + run, "artifactId", videoId,
                    "artifactVersionId", version, "maxFrames", 30);
            final String killToken = token;
            final int killPort = port;
            final String killTenant = tenant;
            CompletableFuture<HttpResponse<String>> inFlight = CompletableFuture.supplyAsync(() -> {
                try {
                    return send(killPort, killTenant, killToken, "POST", TRACKS, JSON.writeValueAsString(killBody));
                } catch (Exception failure) {
                    throw new IllegalStateException(failure);
                }
            });
            Thread.sleep(9_000);
            assertThat(inFlight.isDone()).as("30 frames must still be running when the sidecar is killed").isFalse();
            sidecar.toHandle().descendants().forEach(ProcessHandle::destroyForcibly);
            sidecar.destroyForcibly();
            sidecar.waitFor(15, TimeUnit.SECONDS);
            HttpResponse<String> unknown = inFlight.get(10, TimeUnit.MINUTES);
            System.out.println("J05-IT-KILL " + unknown.statusCode() + " " + unknown.body());
            assertThat(unknown.statusCode()).as(unknown.body()).isEqualTo(503);
            assertThat(unknown.body()).contains("VISION_OUTCOME_UNKNOWN").contains("\"outcome\":\"UNKNOWN\"");
            int jsonBefore = countArtifacts(tenant, principal, "application/json");
            assertThat(jsonBefore).as("nothing was registered by the killed run").isEqualTo(3);
            HttpResponse<String> stillDown = send(port, tenant, token, "POST", TRACKS, JSON.writeValueAsString(killBody));
            assertThat(stillDown.statusCode()).isEqualTo(503);
            assertThat(stillDown.body()).contains("VISION_OUTCOME_UNKNOWN");

            sidecar = startSidecar(python, script, models, home, sidecarPort, sidecarToken, digestCache);
            awaitSidecar(sidecar, sidecarPort, sidecarToken);
            JsonNode retried = post(port, tenant, token, TRACKS, killBody, 201);
            assertThat(retried.path("replayed").asBoolean()).isFalse();
            JsonNode again = post(port, tenant, token, TRACKS, killBody, 200);
            assertThat(again.path("replayed").asBoolean()).isTrue();
            assertThat(again.path("outputId").asString()).isEqualTo(retried.path("outputId").asString());
            assertThat(countArtifacts(tenant, principal, "application/json"))
                    .as("exactly one new output from the unknown-then-retried request").isEqualTo(4);
            passed = true;
        } finally {
            if (browser != null && browser.isAlive()) stopProcessTree(browser);
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            if (sidecar != null) {
                sidecar.toHandle().descendants().forEach(ProcessHandle::destroyForcibly);
                sidecar.destroyForcibly();
                sidecar.waitFor(10, TimeUnit.SECONDS);
            }
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            deleteTree(services);
            deleteTree(work);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("Vision tracking live failure log retained at " + log);
        }
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

    private static Map<String, Object> roi(int x, int y, int width, int height) {
        Map<String, Object> roi = new java.util.LinkedHashMap<>();
        roi.put("x", x);
        roi.put("y", y);
        roi.put("width", width);
        roi.put("height", height);
        return roi;
    }

    private static int countArtifacts(String tenant, String principal, String contentType) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
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
        long deadline = System.nanoTime() + java.time.Duration.ofMinutes(20).toNanos();
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

    private static Path locate(String relative) {
        for (Path dir = Path.of("").toAbsolutePath(); dir != null; dir = dir.getParent()) {
            Path candidate = dir.resolve(relative);
            if (Files.isRegularFile(candidate)) return candidate;
        }
        return null;
    }

    private static void awaitSidecar(Process process, int port, String token) throws Exception {
        long deadline = System.nanoTime() + java.time.Duration.ofSeconds(120).toNanos();
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

    private static JsonNode readBrowserEvent(Process browser, BufferedReader output, String expectedEvent, Path log,
                                             int seconds) throws Exception {
        FutureTask<String> lineTask = new FutureTask<>(output::readLine);
        Thread reader = new Thread(lineTask, "media-dev-vision-live-browser-output");
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
        String state = browser.isAlive() ? "still-running" : "exit=" + browser.exitValue();
        assertThat(line).as("browser event " + expectedEvent + "; process=" + state + "; log="
                + (Files.exists(log) ? Files.readString(log) : "<no log>")).isNotNull();
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
        Path localPnpm = findPnpmPackageBinary(repoRoot, "vite@7.3.1", "vite/bin/vite.js");
        if (localPnpm != null) return localPnpm;
        Path globalVite = globalNodeModules().resolve("vitest/node_modules/vite/bin/vite.js");
        assertThat(Files.isRegularFile(globalVite)).as("a Vite installation is required").isTrue();
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
