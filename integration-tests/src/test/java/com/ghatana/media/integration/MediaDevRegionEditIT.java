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

import java.io.InputStream;
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
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import com.ghatana.media.integration.MediaDevLiveFixtures.StoredArtifact;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-11 {@code media.dev.outcome-reversible-tracked-edit} against REAL processes: the real launcher with the durable
 * PostgreSQL + S3 artifact store, request ledger and region edit history (Testcontainers), the real loopback Florence-2
 * detector sidecar, real FFmpeg/ffprobe and a generated VARIABLE-frame-rate video of a moving car with an analytic
 * ground-truth trajectory.
 *
 * <p>The user's video is tracked by the real vision lane (the track is never faked: contention on the shared GPU is
 * retried, nothing else), then edited (pixelate, blur, fill) as new immutable versions. Everything is measured on frames
 * DECODED by this test, independently of the launcher: samples outside the mask are bit-identical (lossless) or within a
 * reported PSNR (lossy), samples inside changed, the per-frame mask is compared with the analytic ground truth (IoU,
 * centre error, coverage), every frame's PTS equals the source's, the source bytes in S3 never change, and undo returns
 * the exact earlier artifact (bytes, digest and metadata). Fault suite: a stale base is a typed 409, two concurrent
 * editors have exactly one winner, a forged track is refused, missing and revoked rights are 403 (a replay included),
 * another tenant and another principal see 404, the ledger replays and refuses a reused request id, the real encoder
 * killed mid-render is UNKNOWN then exactly once, and the launcher killed mid-render recovers exactly once after
 * restart. Missing runtime prerequisites FAIL the test.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevRegionEditIT {
    private static final String TRACKS = "/dev/v1/vision/tracks";
    private static final String LINEAGES = "/dev/v1/region-edits/lineages";
    private static final int W = TrackingVideoFixture.WIDTH;
    private static final int H = TrackingVideoFixture.HEIGHT;

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void realLauncherEditsATrackedRegionAsNewVersionsWithMeasuredPixelsCasUndoAndFaults() throws Exception {
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
        String tenant = "tenant-dev-region-" + run;
        String principal = "media-dev-region-" + run;
        String bucket = "media-dev-region-" + run;
        String schema = "media_dev_region_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        int sidecarPort;
        try (var socket = new java.net.ServerSocket(0)) { sidecarPort = socket.getLocalPort(); }
        byte[] tokenBytes = new byte[24];
        new SecureRandom().nextBytes(tokenBytes);
        String sidecarToken = HexFormat.of().formatHex(tokenBytes);
        Path services = Files.createTempDirectory("media-dev-region-services-");
        Path work = Files.createTempDirectory("media-dev-region-work-");
        Path log = Files.createTempFile("media-dev-region-process-", ".log");
        Process sidecar = null;
        Process launcher = null;
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
            // The launcher gets a wrapper that execs the real FFmpeg unless a mode file asks for a fault on an encode.
            MediaDevFaultInjector.ModeScript wrapper = MediaDevFaultInjector.ModeScript.ffmpeg(work, ffmpeg);
            Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.put("MEDIA_LOCAL_VISION_MODELS_ROOT", models.toString());
            environment.put("MEDIA_LOCAL_VISION_SIDECAR_URL", "http://127.0.0.1:" + sidecarPort);
            environment.put("MEDIA_LOCAL_VISION_SIDECAR_TOKEN", sidecarToken);
            environment.put("MEDIA_LOCAL_VISION_TIMEOUT_SECONDS", "480");
            environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
            environment.put("MEDIA_DEV_REGION_EDIT_ENABLED", "true");
            environment.put("MEDIA_LOCAL_MODEL_DIGEST_CACHE", digestCache.toString());
            environment.put("MEDIA_DEV_RENDER_FFMPEG", wrapper.path().toString());
            environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe.toString());
            String token = issueDevToken(tenant, principal);
            launcher = startLauncher(classpath, environment, log);
            awaitReadyPatiently(launcher, port);

            // ---- real input: a VFR video of a moving car (analytic ground truth) uploaded over HTTP ----
            byte[] video = TrackingVideoFixture.generate(ffmpeg, work, true);
            Path videoFile = work.resolve("source.mp4");
            Files.write(videoFile, video);
            TrackingVideoFixture.Probe probe = TrackingVideoFixture.probe(ffprobe, videoFile);
            long[] sourcePts = probe.pts().stream().mapToLong(Long::longValue).toArray();
            assertThat(irregular(sourcePts)).as("the clip is genuinely variable frame rate").isTrue();
            String videoId = upload(port, tenant, principal, token, run + "-video", "motion.mp4", "video/mp4", video);
            String version = "sha256:" + sha256(video);
            String otherVideoId = upload(port, tenant, principal, token, run + "-other", "other.mp4", "video/mp4",
                    TrackingVideoFixture.generate(ffmpeg, Files.createDirectory(work.resolve("other")), false));

            JsonNode status = get(port, tenant, token, "/dev/v1/region-edits/status", 200);
            assertThat(status.path("ready").asBoolean()).isTrue();
            assertThat(status.path("history").path("ledgerId").asString()).isEqualTo("postgresql-media-region-edit-ledger");

            // ---- rights: no PROCESSING statement, nothing runs (the lineage can still name the video) ----
            post(port, tenant, token, LINEAGES, lineage("L-norights-" + run, otherVideoId, otherVersion(port, tenant, token, otherVideoId)), 201);
            String attestationId = attest(port, tenant, token, videoId, version, "first");

            // ---- the REAL vision lane produces the track; GPU contention is retried, the track is never faked ----
            Map<String, Object> trackBody = Map.of("requestId", "track-" + run, "artifactId", videoId,
                    "artifactVersionId", version, "maxFrames", 12);
            JsonNode tracked = postRetrying(port, tenant, token, TRACKS, trackBody, 201);
            String tracksId = tracked.path("outputId").asString();
            String tracksVersion = tracked.path("artifact").path("artifactVersionId").asString();
            StoredArtifact tracksRow = storedArtifact(POSTGRES, tenant, principal, tracksId);
            JsonNode tracksDoc = JSON.readTree(new String(s3Bytes(LOCALSTACK, bucket, tracksRow), StandardCharsets.UTF_8));
            System.out.println("J11-IT-TRACKS " + tracksDoc);
            String carTrack = carTrackId(tracksDoc, probe);
            assertThat(carTrack).as("a Florence track that follows the car").isNotNull();
            JsonNode carObservations = trackById(tracksDoc, carTrack).path("observations");
            assertThat(carObservations.size()).isGreaterThanOrEqualTo(5);

            // ---- the lineage names the user's video as version 1 ----
            JsonNode created = post(port, tenant, token, LINEAGES, lineage("L1-" + run, videoId, version), 201);
            assertThat(created.path("headVersion").asInt()).isEqualTo(1);
            assertThat(created.path("undoAvailable").asBoolean()).isFalse();
            String lineage1 = "L1-" + run;

            // ---- 1. lossless PIXELATE: a NEW immutable version, measured on independently decoded frames ----
            Map<String, Object> pixelate = edit("pix-" + run, 1, tracksId, tracksVersion, carTrack,
                    Map.of("type", "PIXELATE", "blockSize", 8), 6, 0);
            pixelate.put("maxDriftPx", 80);
            JsonNode v2 = post(port, tenant, token, LINEAGES + "/" + lineage1 + "/edits", pixelate, 201);
            System.out.println("J11-IT-EDIT-1 " + v2.path("manifest").path("drift") + " "
                    + v2.path("manifest").path("verification"));
            assertThat(v2.path("headVersion").asInt()).isEqualTo(2);
            JsonNode version2 = v2.path("version");
            assertThat(version2.path("kind").asString()).isEqualTo("EDIT");
            String editedId = version2.path("artifact").path("artifactId").asString();
            StoredArtifact editedRow = storedArtifact(POSTGRES, tenant, principal, editedId);
            byte[] edited = s3Bytes(LOCALSTACK, bucket, editedRow);
            assertThat(editedRow.contentType()).isEqualTo("video/mp4");
            assertThat(sha256(edited)).isEqualTo(editedRow.sha256()).isEqualTo(version2.path("artifact").path("sha256").asString());
            assertThat(sha256(edited)).isNotEqualTo(sha256(video));
            assertThat(s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, videoId)))
                    .as("the source bytes in S3 never change").isEqualTo(video);
            Measured m1 = measure("pixelate", ffmpeg, ffprobe, work, video, edited, v2.path("manifest"), sourcePts, true);
            assertThat(m1.outsideMaxAbsDiff).as("lossless: outside the mask is bit-identical").isZero();
            assertThat(m1.insideChanged).isPositive();
            assertThat(m1.ptsEqual).isTrue();
            assertThat(m1.maskedFrames).isGreaterThanOrEqualTo(carObservations.size());
            assertThat(m1.minCoverage).as("ground-truth car box covered by the mask").isGreaterThanOrEqualTo(0.80);
            assertThat(m1.maxCenterErrorPx).as("mask centre vs ground truth centre (px)").isLessThanOrEqualTo(30.0);
            // Pixelation leaves flat areas of the flat-coloured sprite unchanged, so only a part of its luma samples change.
            assertThat(m1.truthChangedFraction).as("fraction of ground-truth car pixels that changed").isGreaterThan(0.3);
            assertThat(m1.manifestVerificationOutsideMax).isZero();

            // ---- PostgreSQL holds the version rows (read independently) ----
            List<Map<String, Object>> rows = versionRows(tenant, lineage1);
            assertThat(rows).extracting(r -> r.get("kind")).containsExactly("BASE", "EDIT");
            assertThat(rows.get(1)).containsEntry("parent", 1).containsEntry("artifact_id", editedId);
            assertThat(rows.get(0)).containsEntry("artifact_id", videoId);

            // ---- 2. stale editor: typed 409, nothing registered; another principal sees nothing (404) ----
            int artifactsBefore = countArtifacts(tenant, principal, "video/mp4");
            HttpResponse<String> stale = send(port, tenant, token, "POST", LINEAGES + "/" + lineage1 + "/edits",
                    JSON.writeValueAsString(edit("stale-" + run, 1, tracksId, tracksVersion, carTrack,
                            Map.of("type", "BLUR", "radius", 4), 6, 0)));
            assertThat(stale.statusCode()).as(stale.body()).isEqualTo(409);
            JsonNode staleError = JSON.readTree(stale.body()).path("error");
            assertThat(staleError.path("code").asString()).isEqualTo("STALE_BASE_VERSION");
            assertThat(staleError.path("details").path("expectedVersion").asInt()).isEqualTo(1);
            assertThat(staleError.path("details").path("headVersion").asInt()).isEqualTo(2);
            assertThat(countArtifacts(tenant, principal, "video/mp4")).isEqualTo(artifactsBefore);
            String otherPrincipalToken = issueDevToken(tenant, "someone-else-" + run);
            assertThat(send(port, tenant, otherPrincipalToken, "GET", LINEAGES + "/" + lineage1, null).statusCode()).isEqualTo(404);
            assertThat(send(port, tenant, otherPrincipalToken, "POST", LINEAGES + "/" + lineage1 + "/edits",
                    JSON.writeValueAsString(edit("x-" + run, 2, tracksId, tracksVersion, carTrack, Map.of("type", "FILL"), 6, 0)))
                    .statusCode()).isEqualTo(404);
            String otherTenant = tenant + "-b";
            String otherTenantToken = issueDevToken(otherTenant, principal);
            assertThat(send(port, otherTenant, otherTenantToken, "GET", LINEAGES + "/" + lineage1, null).statusCode())
                    .as("wrong tenant").isEqualTo(404);
            assertThat(send(port, otherTenant, otherTenantToken, "POST", LINEAGES + "/" + lineage1 + "/undo",
                    "{\"requestId\":\"wt-" + run + "\",\"baseVersion\":2}").statusCode()).isEqualTo(404);

            // ---- 3. ledger: an identical retry replays (no render), a changed body under the same id is 409 ----
            int beforeReplay = countArtifacts(tenant, principal, "video/mp4");
            HttpResponse<String> replay = send(port, tenant, token, "POST", LINEAGES + "/" + lineage1 + "/edits",
                    JSON.writeValueAsString(pixelate));
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            assertThat(JSON.readTree(replay.body()).path("replayed").asBoolean()).isTrue();
            assertThat(JSON.readTree(replay.body()).path("version").path("artifact").path("sha256").asString()).isEqualTo(sha256(edited));
            assertThat(countArtifacts(tenant, principal, "video/mp4")).isEqualTo(beforeReplay);
            Map<String, Object> changed = new LinkedHashMap<>(pixelate);
            changed.put("effect", Map.of("type", "BLUR", "radius", 4));
            HttpResponse<String> reused = send(port, tenant, token, "POST", LINEAGES + "/" + lineage1 + "/edits",
                    JSON.writeValueAsString(changed));
            assertThat(reused.statusCode()).isEqualTo(409);
            assertThat(reused.body()).contains("REGION_EDIT_REQUEST_ID_REUSED");

            // ---- 4. forged track: JSON uploaded through the canonical route that merely claims to be launcher output ----
            // The store refuses a second artifact with identical bytes, so the forger adds a trailing newline to the real document.
            byte[] forgedDoc = (new String(s3Bytes(LOCALSTACK, bucket, tracksRow), StandardCharsets.UTF_8) + "\n")
                    .getBytes(StandardCharsets.UTF_8);
            String forgedId = uploadWithMetadata(port, tenant, principal, token, run + "-forged", "forged-tracks.json",
                    "application/json", forgedDoc, Map.of("visionSchema", "media.dev.vision-output.v1",
                            "kind", "LOCAL_VISION_TRACKS", "requestId", "track-" + run,
                            "source", Map.of("artifactId", videoId, "artifactVersionId", version, "sha256", sha256(video))));
            String forgedVersion = "sha256:" + sha256(forgedDoc);
            HttpResponse<String> forged = send(port, tenant, token, "POST", LINEAGES + "/" + lineage1 + "/edits",
                    JSON.writeValueAsString(edit("forged-" + run, 2, forgedId, forgedVersion, carTrack, Map.of("type", "FILL"), 6, 0)));
            assertThat(forged.statusCode()).as(forged.body()).isEqualTo(422);
            assertThat(forged.body()).contains("TRACK_PROVENANCE_UNVERIFIED");
            // A real track of this principal but another lineage's video: no PROCESSING statement => rights come first.
            HttpResponse<String> noRights = send(port, tenant, token, "POST", LINEAGES + "/L-norights-" + run + "/edits",
                    JSON.writeValueAsString(edit("norights-" + run, 1, tracksId, tracksVersion, carTrack, Map.of("type", "FILL"), 6, 0)));
            assertThat(noRights.statusCode()).as(noRights.body()).isEqualTo(403);
            assertThat(noRights.body()).contains("RIGHTS_DECISION_DENIED");

            // ---- 5. concurrent editors of the same head: exactly one wins ----
            String metaBeforeUndo = artifactRecordMetadata(port, tenant, token, editedId);
            Map<String, Object> raceA = edit("race-a-" + run, 2, tracksId, tracksVersion, carTrack, Map.of("type", "BLUR", "radius", 6), 6, 0);
            Map<String, Object> raceB = edit("race-b-" + run, 2, tracksId, tracksVersion, carTrack, Map.of("type", "FILL", "color", "#00AA00"), 6, 0);
            ExecutorService pool = Executors.newFixedThreadPool(2);
            try {
                List<Callable<HttpResponse<String>>> calls = new ArrayList<>();
                final String raceToken = token;
                final int racePort = port;
                final String raceTenant = tenant;
                for (Map<String, Object> body : List.of(raceA, raceB)) {
                    calls.add(() -> send(racePort, raceTenant, raceToken, "POST", LINEAGES + "/" + lineage1 + "/edits",
                            JSON.writeValueAsString(body)));
                }
                List<Integer> statuses = new ArrayList<>();
                String winnerBody = null;
                for (Future<HttpResponse<String>> result : pool.invokeAll(calls)) {
                    HttpResponse<String> response = result.get();
                    statuses.add(response.statusCode());
                    if (response.statusCode() == 201) winnerBody = response.body();
                    else assertThat(response.body()).contains("STALE_BASE_VERSION");
                }
                assertThat(statuses).as(statuses.toString()).containsExactlyInAnyOrder(201, 409);
                assertThat(JSON.readTree(winnerBody).path("headVersion").asInt()).isEqualTo(3);
            } finally {
                pool.shutdownNow();
            }
            rows = versionRows(tenant, lineage1);
            assertThat(rows).extracting(r -> r.get("kind")).containsExactly("BASE", "EDIT", "EDIT");
            JsonNode lineageView = get(port, tenant, token, LINEAGES + "/" + lineage1, 200);
            assertThat(lineageView.path("headVersion").asInt()).isEqualTo(3);
            String winnerSha = lineageView.path("versions").get(2).path("artifact").path("sha256").asString();

            // ---- 6. undo steps back ONE edit at a time and restores the EXACT earlier artifact ----
            JsonNode undo1 = post(port, tenant, token, LINEAGES + "/" + lineage1 + "/undo",
                    Map.of("requestId", "undo-1-" + run, "baseVersion", 3), 201);
            assertThat(undo1.path("version").path("kind").asString()).isEqualTo("UNDO");
            assertThat(undo1.path("version").path("restoresVersionNumber").asInt()).isEqualTo(2);
            assertThat(undo1.path("headVersion").asInt()).isEqualTo(4);
            assertThat(undo1.path("version").path("artifact")).isEqualTo(lineageView.path("versions").get(1).path("artifact"));
            String restoredId = undo1.path("version").path("artifact").path("artifactId").asString();
            assertThat(restoredId).isEqualTo(editedId);
            byte[] restoredBytes = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, restoredId));
            assertThat(sha256(restoredBytes)).as("undo returns the exact previous version bytes").isEqualTo(sha256(edited));
            assertThat(restoredBytes).isEqualTo(edited);
            assertThat(artifactRecordMetadata(port, tenant, token, restoredId)).as("and the exact metadata").isEqualTo(metaBeforeUndo);
            assertThat(winnerSha).isNotEqualTo(sha256(edited));
            JsonNode undo2 = post(port, tenant, token, LINEAGES + "/" + lineage1 + "/undo",
                    Map.of("requestId", "undo-2-" + run, "baseVersion", 4), 201);
            assertThat(undo2.path("version").path("restoresVersionNumber").asInt()).isEqualTo(1);
            assertThat(undo2.path("version").path("artifact").path("artifactId").asString()).isEqualTo(videoId);
            assertThat(undo2.path("version").path("artifact").path("sha256").asString()).isEqualTo(sha256(video));
            assertThat(undo2.path("undoAvailable").asBoolean()).isFalse();
            assertThat(s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal,
                    undo2.path("version").path("artifact").path("artifactId").asString()))).isEqualTo(video);
            HttpResponse<String> nothing = send(port, tenant, token, "POST", LINEAGES + "/" + lineage1 + "/undo",
                    "{\"requestId\":\"undo-3-" + run + "\",\"baseVersion\":5}");
            assertThat(nothing.statusCode()).isEqualTo(409);
            assertThat(nothing.body()).contains("NOTHING_TO_UNDO");
            assertThat(send(port, tenant, token, "POST", LINEAGES + "/" + lineage1 + "/undo",
                    "{\"requestId\":\"undo-late-" + run + "\",\"baseVersion\":3}").statusCode()).as("stale undo").isEqualTo(409);
            rows = versionRows(tenant, lineage1);
            assertThat(rows).extracting(r -> r.get("kind")).containsExactly("BASE", "EDIT", "EDIT", "UNDO", "UNDO");

            // ---- 7. a lossy FILL on a fresh head: outside the mask within a reported PSNR ----
            Map<String, Object> fillBody = edit("fill-" + run, 5, tracksId, tracksVersion, carTrack,
                    Map.of("type", "FILL", "color", "#FF00FF"), 4, 18);
            fillBody.put("holdEnds", true); // the track ends one frame before the clip: hold the last box over it
            JsonNode v6 = post(port, tenant, token, LINEAGES + "/" + lineage1 + "/edits", fillBody, 201);
            assertThat(v6.path("manifest").path("maskedFrames").asInt()).as("held ends cover every frame").isEqualTo(sourcePts.length);
            assertThat(v6.path("manifest").path("frames").get(sourcePts.length - 1).path("source").asString()).isEqualTo("HELD");
            byte[] filled = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal,
                    v6.path("version").path("artifact").path("artifactId").asString()));
            Measured m2 = measure("fill-lossy", ffmpeg, ffprobe, work, video, filled, v6.path("manifest"), sourcePts, false);
            System.out.println("J11-IT-LOSSY outsidePsnr=" + m2.outsidePsnrDb + " outsideMax=" + m2.outsideMaxAbsDiff);
            assertThat(m2.outsidePsnrDb).isGreaterThan(30.0);
            assertThat(m2.ptsEqual).isTrue();
            assertThat(m2.truthChangedFraction).isGreaterThan(0.6);

            // ---- 8. restart: the history and the bytes are durable ----
            stopLauncher(launcher);
            launcher = startLauncher(classpath, environment, log);
            awaitReadyPatiently(launcher, port);
            token = issueDevToken(tenant, principal);
            JsonNode afterRestart = get(port, tenant, token, LINEAGES + "/" + lineage1, 200);
            assertThat(afterRestart.path("headVersion").asInt()).isEqualTo(6);
            assertThat(afterRestart.path("versions").get(1).path("artifact").path("sha256").asString()).isEqualTo(sha256(edited));
            HttpResponse<String> replayAfterRestart = send(port, tenant, token, "POST", LINEAGES + "/" + lineage1 + "/edits",
                    JSON.writeValueAsString(pixelate));
            assertThat(replayAfterRestart.statusCode()).isEqualTo(200);
            assertThat(JSON.readTree(replayAfterRestart.body()).path("version").path("artifact").path("sha256").asString())
                    .isEqualTo(sha256(edited));
            assertThat(send(port, tenant, token, "POST", LINEAGES + "/" + lineage1 + "/undo",
                    "{\"requestId\":\"undo-1-" + run + "\",\"baseVersion\":3}").statusCode()).as("undo replay").isEqualTo(200);

            // ---- 9. the real encoder killed mid-render: UNKNOWN, nothing appended, then exactly once ----
            Map<String, Object> killEdit = edit("kill-encoder-" + run, 6, tracksId, tracksVersion, carTrack,
                    Map.of("type", "BLUR", "radius", 5), 6, 0);
            int videosBeforeKill = countArtifacts(tenant, principal, "video/mp4");
            wrapper.mode("hang");
            CompletableFuture<HttpResponse<String>> inFlight = sendAsync(port, tenant, token, LINEAGES + "/" + lineage1 + "/edits", killEdit);
            ProcessHandle encoder = MediaDevFaultInjector.awaitDescendant(launcher, "sleep 3600", Duration.ofSeconds(120));
            assertThat(inFlight.isDone()).isFalse();
            MediaDevFaultInjector.signal(encoder, "KILL");
            HttpResponse<String> unknown = inFlight.get(2, TimeUnit.MINUTES);
            assertThat(unknown.statusCode()).as(unknown.body()).isEqualTo(503);
            assertThat(unknown.body()).contains("REGION_EDIT_OUTCOME_UNKNOWN").contains("\"outcome\":\"UNKNOWN\"");
            assertThat(countArtifacts(tenant, principal, "video/mp4")).as("the killed run registered nothing").isEqualTo(videosBeforeKill);
            assertThat(versionRows(tenant, lineage1)).hasSize(6);
            wrapper.mode("ok");
            JsonNode retried = post(port, tenant, token, LINEAGES + "/" + lineage1 + "/edits", killEdit, 201);
            assertThat(retried.path("headVersion").asInt()).isEqualTo(7);
            assertThat(versionRows(tenant, lineage1)).hasSize(7);

            // ---- 10. the launcher killed mid-render: restart, retry the same request, exactly one version ----
            Map<String, Object> crashEdit = edit("kill-launcher-" + run, 7, tracksId, tracksVersion, carTrack,
                    Map.of("type", "PIXELATE", "blockSize", 12), 6, 0);
            int videosBeforeCrash = countArtifacts(tenant, principal, "video/mp4");
            wrapper.mode("hang");
            CompletableFuture<HttpResponse<String>> doomed = sendAsync(port, tenant, token, LINEAGES + "/" + lineage1 + "/edits", crashEdit);
            MediaDevFaultInjector.awaitDescendant(launcher, "sleep 3600", Duration.ofSeconds(120));
            List<ProcessHandle> orphans = MediaDevFaultInjector.descendants(launcher);
            launcher.destroyForcibly();
            for (ProcessHandle orphan : orphans) orphan.destroyForcibly();
            assertThat(launcher.waitFor(30, TimeUnit.SECONDS)).isTrue();
            try {
                doomed.get(1, TimeUnit.MINUTES);
                throw new AssertionError("the in-flight request of a killed launcher cannot complete");
            } catch (java.util.concurrent.ExecutionException expected) {
                // the connection died with the launcher
            }
            assertThat(countArtifacts(tenant, principal, "video/mp4")).as("nothing registered by the killed launcher")
                    .isEqualTo(videosBeforeCrash);
            wrapper.mode("ok");
            launcher = startLauncher(classpath, environment, log);
            awaitReadyPatiently(launcher, port);
            token = issueDevToken(tenant, principal);
            assertThat(versionRows(tenant, lineage1)).as("the killed render appended nothing").hasSize(7);
            JsonNode afterCrash = post(port, tenant, token, LINEAGES + "/" + lineage1 + "/edits", crashEdit, 201);
            assertThat(afterCrash.path("replayed").asBoolean()).isFalse();
            assertThat(afterCrash.path("headVersion").asInt()).isEqualTo(8);
            assertThat(send(port, tenant, token, "POST", LINEAGES + "/" + lineage1 + "/edits", JSON.writeValueAsString(crashEdit))
                    .statusCode()).isEqualTo(200);
            assertThat(versionRows(tenant, lineage1)).as("exactly one new version").hasSize(8);
            assertThat(countArtifacts(tenant, principal, "video/mp4")).as("exactly one new video").isEqualTo(videosBeforeCrash + 1);

            // ---- 11. revocation: a new request, a replay and an undo are all refused (403); reads stay readable ----
            HttpResponse<String> revoke = send(port, tenant, token, "POST", "/dev/v1/rights/attestations/" + attestationId + "/revoke",
                    JSON.writeValueAsString(Map.of("reason", "TEST: revoked to prove fail-closed")));
            assertThat(revoke.statusCode()).as(revoke.body()).isEqualTo(200);
            int videosBeforeRevoked = countArtifacts(tenant, principal, "video/mp4");
            HttpResponse<String> revokedEdit = send(port, tenant, token, "POST", LINEAGES + "/" + lineage1 + "/edits",
                    JSON.writeValueAsString(edit("revoked-" + run, 8, tracksId, tracksVersion, carTrack, Map.of("type", "FILL"), 6, 0)));
            assertThat(revokedEdit.statusCode()).as(revokedEdit.body()).isEqualTo(403);
            assertThat(revokedEdit.body()).contains("RIGHTS_DECISION_REVOKED");
            assertThat(send(port, tenant, token, "POST", LINEAGES + "/" + lineage1 + "/edits", JSON.writeValueAsString(crashEdit))
                    .statusCode()).as("a revoked source refuses even a replay").isEqualTo(403);
            assertThat(send(port, tenant, token, "POST", LINEAGES + "/" + lineage1 + "/undo",
                    "{\"requestId\":\"undo-revoked-" + run + "\",\"baseVersion\":8}").statusCode()).isEqualTo(403);
            assertThat(countArtifacts(tenant, principal, "video/mp4")).isEqualTo(videosBeforeRevoked);
            assertThat(get(port, tenant, token, LINEAGES + "/" + lineage1, 200).path("headVersion").asInt()).isEqualTo(8);
            passed = true;
        } finally {
            if (launcher != null) stopLauncher(launcher);
            if (sidecar != null) sidecar.destroyForcibly();
            deleteBucket(LOCALSTACK, bucket);
            dropSchema(POSTGRES, schema);
            deleteTree(services);
            deleteTree(work);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("Region edit live failure log retained at " + log);
        }
    }

    // ------------------------------------------------------------------ measurement (independent of the launcher)

    private static final class Measured {
        int maskedFrames;
        long insideChanged;
        int outsideMaxAbsDiff;
        Double outsidePsnrDb;
        boolean ptsEqual;
        double minCoverage = 1;
        double minIou = 1;
        double meanIou;
        double maxCenterErrorPx;
        double truthChangedFraction;
        int manifestVerificationOutsideMax;
    }

    /**
     * Decodes the source and the edited bytes with THIS test's own FFmpeg and compares them sample by sample against the
     * per-frame masks of the manifest, then compares the masks with the analytic ground-truth car box at each frame's PTS.
     */
    private static Measured measure(String label, Path ffmpeg, Path ffprobe, Path work, byte[] source, byte[] edited,
                                    JsonNode manifest, long[] sourcePts, boolean lossless) throws Exception {
        Path sourceFile = work.resolve("m-source-" + label + ".mp4");
        Path editedFile = work.resolve("m-edited-" + label + ".mp4");
        Files.write(sourceFile, source);
        Files.write(editedFile, edited);
        Measured m = new Measured();
        TrackingVideoFixture.Probe editedProbe = TrackingVideoFixture.probe(ffprobe, editedFile);
        m.ptsEqual = editedProbe.pts().stream().mapToLong(Long::longValue).boxed().toList()
                .equals(java.util.Arrays.stream(sourcePts).boxed().toList());
        assertThat(editedProbe.timeBaseDen()).isEqualTo(TrackingVideoFixture.probe(ffprobe, sourceFile).timeBaseDen());
        List<byte[]> src = decode(ffmpeg, sourceFile);
        List<byte[]> out = decode(ffmpeg, editedFile);
        JsonNode frames = manifest.path("frames");
        assertThat(src).hasSize(sourcePts.length);
        assertThat(out).hasSize(sourcePts.length);
        assertThat(frames.size()).isEqualTo(sourcePts.length);
        double den = TrackingVideoFixture.probe(ffprobe, sourceFile).timeBaseDen();
        long outsideSq = 0;
        long outsideN = 0;
        double iouSum = 0;
        long truthPixels = 0;
        long truthChanged = 0;
        for (int i = 0; i < frames.size(); i++) {
            JsonNode frame = frames.get(i);
            assertThat(frame.path("pts").asLong()).isEqualTo(sourcePts[i]);
            JsonNode mask = frame.path("mask");
            int[] rect = mask.isNull() ? null : new int[] {mask.path("x").asInt(), mask.path("y").asInt(),
                    mask.path("width").asInt(), mask.path("height").asInt()};
            byte[] a = src.get(i);
            byte[] b = out.get(i);
            for (int p = 0; p < a.length; p++) {
                boolean inside = rect != null && inside(p, rect);
                int diff = Math.abs((a[p] & 0xFF) - (b[p] & 0xFF));
                if (inside) {
                    if (diff != 0) m.insideChanged++;
                } else {
                    outsideN++;
                    outsideSq += (long) diff * diff;
                    m.outsideMaxAbsDiff = Math.max(m.outsideMaxAbsDiff, diff);
                }
            }
            if (rect != null) {
                m.maskedFrames++;
                double[] truth = TrackingVideoFixture.carBox(sourcePts[i] / den);
                double[] box = {rect[0], rect[1], rect[2], rect[3]};
                double iou = TrackingVideoFixture.iou(truth, box);
                m.minIou = Math.min(m.minIou, iou);
                iouSum += iou;
                m.maxCenterErrorPx = Math.max(m.maxCenterErrorPx, TrackingVideoFixture.centerError(truth, box));
                double ix = Math.max(0, Math.min(truth[0] + truth[2], box[0] + box[2]) - Math.max(truth[0], box[0]));
                double iy = Math.max(0, Math.min(truth[1] + truth[3], box[1] + box[3]) - Math.max(truth[1], box[1]));
                m.minCoverage = Math.min(m.minCoverage, ix * iy / (truth[2] * truth[3]));
                // luma samples of the ground-truth car box (inside the frame) that changed
                for (int y = (int) Math.max(0, Math.ceil(truth[1])); y < Math.min(H, truth[1] + truth[3]); y++) {
                    for (int x = (int) Math.max(0, Math.ceil(truth[0])); x < Math.min(W, truth[0] + truth[2]); x++) {
                        truthPixels++;
                        if (a[y * W + x] != b[y * W + x]) truthChanged++;
                    }
                }
            }
        }
        m.meanIou = m.maskedFrames == 0 ? 0 : iouSum / m.maskedFrames;
        m.outsidePsnrDb = outsideSq == 0 ? null : 10 * Math.log10(255.0 * 255.0 / ((double) outsideSq / outsideN));
        m.truthChangedFraction = truthPixels == 0 ? 0 : (double) truthChanged / truthPixels;
        m.manifestVerificationOutsideMax = manifest.path("verification").path("outsideMaxAbsDiff").asInt(-1);
        System.out.println("J11-IT-MEASURED " + label + " maskedFrames=" + m.maskedFrames + " outsideMax=" + m.outsideMaxAbsDiff
                + " outsidePsnr=" + m.outsidePsnrDb + " insideChanged=" + m.insideChanged + " ptsEqual=" + m.ptsEqual
                + " minIou=" + m.minIou + " meanIou=" + m.meanIou + " minCoverage=" + m.minCoverage
                + " maxCenterErrorPx=" + m.maxCenterErrorPx + " truthChangedFraction=" + m.truthChangedFraction
                + " drift=" + manifest.path("drift"));
        if (lossless) assertThat(manifest.path("verification").path("outsideLossless").asBoolean()).isTrue();
        return m;
    }

    private static boolean inside(int sample, int[] rect) {
        int luma = W * H;
        int cw = W / 2;
        int chroma = cw * (H / 2);
        int x;
        int y;
        if (sample < luma) {
            x = sample % W;
            y = sample / W;
        } else {
            int offset = (sample - luma) % chroma;
            x = (offset % cw) * 2;
            y = (offset / cw) * 2;
        }
        return x >= rect[0] && x < rect[0] + rect[2] && y >= rect[1] && y < rect[1] + rect[3];
    }

    private static List<byte[]> decode(Path ffmpeg, Path file) throws Exception {
        Process process = new ProcessBuilder(ffmpeg.toString(), "-nostdin", "-v", "error", "-i", file.toString(), "-an",
                "-map", "0:v:0", "-fps_mode", "passthrough", "-pix_fmt", "yuv420p", "-f", "rawvideo", "pipe:1")
                .redirectError(ProcessBuilder.Redirect.DISCARD).start();
        int size = W * H * 3 / 2;
        List<byte[]> frames = new ArrayList<>();
        try (InputStream in = process.getInputStream()) {
            while (true) {
                byte[] frame = in.readNBytes(size);
                if (frame.length == 0) break;
                assertThat(frame).hasSize(size);
                frames.add(frame);
            }
        }
        assertThat(process.waitFor(60, TimeUnit.SECONDS)).isTrue();
        assertThat(process.exitValue()).isZero();
        return frames;
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

    // ------------------------------------------------------------------ requests

    private static Map<String, Object> lineage(String lineageId, String artifactId, String artifactVersionId) {
        return new LinkedHashMap<>(Map.of("lineageId", lineageId, "artifactId", artifactId, "artifactVersionId", artifactVersionId));
    }

    private static Map<String, Object> edit(String requestId, int baseVersion, String tracksId, String tracksVersion,
                                            String trackId, Map<String, Object> effect, int padding, int crf) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("baseVersion", baseVersion);
        body.put("track", new LinkedHashMap<>(Map.of("artifactId", tracksId, "artifactVersionId", tracksVersion, "trackId", trackId)));
        body.put("effect", effect);
        body.put("paddingPx", padding);
        body.put("encoder", Map.of("crf", crf));
        return body;
    }

    private static String otherVersion(int port, String tenant, String token, String artifactId) throws Exception {
        JsonNode artifact = get(port, tenant, token, "/api/v1/artifacts/" + artifactId, 200);
        String sha = artifact.path("sha256").asString();
        return "sha256:" + sha;
    }

    /** The artifact record's metadata exactly as the canonical artifact route returns it. */
    private static String artifactRecordMetadata(int port, String tenant, String token, String artifactId) throws Exception {
        JsonNode artifact = get(port, tenant, token, "/api/v1/artifacts/" + artifactId, 200);
        assertThat(artifact.has("metadata")).as("artifact record carries metadata: " + artifact).isTrue();
        return artifact.path("metadata").toString();
    }

    private static CompletableFuture<HttpResponse<String>> sendAsync(int port, String tenant, String token, String path,
                                                                     Map<String, Object> body) {
        return CompletableFuture.supplyAsync(() -> {
            try {
                return send(port, tenant, token, "POST", path, JSON.writeValueAsString(body));
            } catch (Exception failure) {
                throw new IllegalStateException(failure);
            }
        });
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

    /** Uploads through the canonical route with caller-chosen metadata (what a forger would send). */
    private static String uploadWithMetadata(int port, String tenant, String principal, String token, String key,
                                             String fileName, String contentType, byte[] bytes,
                                             Map<String, Object> metadata) throws Exception {
        Map<String, Object> requestBody = Map.of("tenantId", tenant, "principalId", principal, "fileName", fileName,
                "contentType", contentType, "expectedSizeBytes", bytes.length, "expectedSha256", sha256(bytes),
                "classification", "INTERNAL", "retention", "P30D", "metadata", metadata);
        HttpResponse<String> begun = HttpClient.newHttpClient().send(HttpRequest.newBuilder(
                        URI.create("http://127.0.0.1:" + port + "/api/v1/artifacts/uploads"))
                .header("Authorization", "Bearer " + token).header("X-Tenant-Id", tenant)
                .header("Idempotency-Key", "forged-" + key).header("Content-Type", "application/json")
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

    // ------------------------------------------------------------------ durable readback

    private static List<Map<String, Object>> versionRows(String tenant, String lineageId) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement("SELECT version_number, kind, artifact_id, parent_version_number, "
                     + "restores_version_number, request_id FROM media_dev_region_edit_versions WHERE tenant_id=? AND lineage_id=? "
                     + "ORDER BY version_number")) {
            statement.setString(1, tenant);
            statement.setString(2, lineageId);
            List<Map<String, Object>> rows = new ArrayList<>();
            try (var set = statement.executeQuery()) {
                while (set.next()) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("version", set.getInt(1));
                    row.put("kind", set.getString(2));
                    row.put("artifact_id", set.getString(3));
                    int parent = set.getInt(4);
                    row.put("parent", set.wasNull() ? null : parent);
                    int restores = set.getInt(5);
                    row.put("restores", set.wasNull() ? null : restores);
                    row.put("request_id", set.getString(6));
                    rows.add(row);
                }
            }
            for (int i = 0; i < rows.size(); i++) assertThat(rows.get(i).get("version")).isEqualTo(i + 1);
            return rows;
        }
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

    // ------------------------------------------------------------------ processes

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
}
