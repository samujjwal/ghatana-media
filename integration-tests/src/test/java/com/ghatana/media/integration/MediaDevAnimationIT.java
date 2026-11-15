package com.ghatana.media.integration;

import com.ghatana.media.production.AnimationSpecCompiler;
import com.ghatana.media.production.animation.AnimationRenderer;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import tools.jackson.databind.JsonNode;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.DriverManager;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffmpeg;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffprobe;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-12 {@code media.dev.outcome-two-dimensional-animation} against REAL processes: the real launcher with the durable
 * PostgreSQL + S3 artifact store and request ledger (Testcontainers) and real FFmpeg/ffprobe.
 *
 * <p>A keyframed scene (rectangle, ellipse, fading rectangle and an uploaded image asset with a PROCESSING rights
 * statement) is rendered through {@code POST /dev/v1/animations/renders}. The stored MP4 is then verified independently
 * of the launcher: ffprobe (exact frame count, rational frame rate, per-frame PTS ticks), a full FFmpeg decode compared
 * with golden frames rasterized by this test from its own easing math (measured PSNR), motion-curve positions measured
 * in the decoded frames against the easing math, and the manifest's per-frame digests compared with the same scene
 * rendered in-process by the renderer (so determinism is shown across processes and across a launcher restart).
 * Fault suite: invalid spec, over budget, missing and revoked asset rights, wrong tenant, idempotent replay, a changed
 * body under the same requestId, the real encoder killed mid-render, and the launcher killed mid-render.
 * Missing runtime prerequisites FAIL the test.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevAnimationIT {
    private static final String RENDERS = "/dev/v1/animations/renders";
    private static final int W = 320;
    private static final int H = 180;
    private static final int FRAMES = 48;
    private static final int BG = 0xFF101828;

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void realLauncherRendersDecodableMp4WithGoldenFramesAndCurvesAndSurvivesTheFaultSuite() throws Exception {
        assertThat(ffmpeg()).as("MEDIA_DEV_RENDER_FFMPEG").isNotBlank();
        assertThat(ffprobe()).as("MEDIA_DEV_RENDER_FFPROBE").isNotBlank();
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-anim-" + run;
        String otherTenant = "tenant-dev-anim-other-" + run;
        String principal = "media-dev-anim-" + run;
        String bucket = "media-dev-anim-" + run.substring(0, 16);
        String schema = "media_dev_anim_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-anim-services-");
        Path work = Files.createTempDirectory("media-dev-anim-work-");
        Path log = Files.createTempFile("media-dev-anim-process-", ".log");
        Process launcher = null;
        boolean passed = false;
        try {
            try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            // The launcher gets a wrapper that execs the real FFmpeg unless a mode file asks for a fault on an encode.
            MediaDevFaultInjector.ModeScript wrapper = MediaDevFaultInjector.ModeScript.ffmpeg(work, Path.of(ffmpeg()));
            Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
            environment.put("MEDIA_DEV_RENDER_FFMPEG", wrapper.path().toString());
            environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe());
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            String token = issueDevToken(tenant, principal);

            JsonNode status = get(port, tenant, token, "/dev/v1/animations/status", 200);
            assertThat(status.path("ready").asBoolean()).isTrue();
            assertThat(status.path("limits").path("maxFrames").asInt()).isEqualTo(240);
            assertThat(status.path("text").asString()).isEqualTo("NOT_SUPPORTED");

            // ---- inputs: two lawful-image candidates; A is attested, B is not ----
            byte[] stickerA = sticker(0xFFFFD000, 0xFF2060FF);
            byte[] stickerB = sticker(0xFFFF00FF, 0xFF00FFFF);
            String assetA = upload(port, tenant, principal, token, run + "-a", "sticker-a.png", "image/png", stickerA);
            String assetB = upload(port, tenant, principal, token, run + "-b", "sticker-b.png", "image/png", stickerB);
            String versionA = "sha256:" + sha256(stickerA);
            String versionB = "sha256:" + sha256(stickerB);
            int videosAtStart = rows(tenant, principal, "video/mp4");
            assertThat(videosAtStart).isZero();

            // ---- fault: invalid spec (typed 422 with the JSON path) and over budget; nothing registered ----
            Map<String, Object> invalid = goldenSpec(assetA, versionA);
            ((Map<String, Object>) ((List<?>) invalid.get("shapes")).get(1)).put("primitive", "TRIANGLE");
            JsonNode invalidError = expect(port, tenant, token, request("bad-" + run, invalid, 14), 422, "ANIMATION_SPEC_INVALID");
            assertThat(invalidError.path("error").path("details").path("path").asString()).isEqualTo("$.shapes[1].primitive");
            Map<String, Object> badKey = goldenSpec(assetA, versionA);
            ((Map<String, Object>) ((List<?>) ((Map<String, Object>) ((List<?>) badKey.get("shapes")).get(0)).get("keyframes")).get(1))
                    .put("frame", 0);
            assertThat(expect(port, tenant, token, request("bad2-" + run, badKey, 14), 422, "ANIMATION_SPEC_INVALID")
                    .path("error").path("details").path("path").asString()).isEqualTo("$.shapes[0].keyframes[1].frame");
            Map<String, Object> tooMany = goldenSpec(assetA, versionA);
            tooMany.put("frameCount", 241);
            JsonNode budget = expect(port, tenant, token, request("budget-" + run, tooMany, 14), 422, "ANIMATION_BUDGET_EXCEEDED");
            assertThat(budget.path("error").path("details").path("requested").asInt()).isEqualTo(241);
            Map<String, Object> tooBig = goldenSpec(assetA, versionA);
            tooBig.put("width", 1280);
            tooBig.put("height", 720);
            tooBig.put("frameCount", 60);
            assertThat(expect(port, tenant, token, request("budget2-" + run, tooBig, 14), 422, "ANIMATION_BUDGET_EXCEEDED")
                    .path("error").path("details").path("limit").asString()).contains("total animation pixels");
            assertThat(rows(tenant, principal, "video/mp4")).isZero();
            assertThat(rows(tenant, principal, "application/json")).isZero();

            // ---- fault: image asset without a rights statement is a typed 403; no render, nothing registered ----
            Map<String, Object> goldenWithA = goldenSpec(assetA, versionA);
            JsonNode denied = expect(port, tenant, token, request("golden-" + run, goldenWithA, 14), 403, "RIGHTS_NOT_ADMITTED");
            assertThat(denied.path("error").path("details").path("verdict").asString()).isEqualTo("DENIED");
            assertThat(denied.path("error").path("details").path("artifactId").asString()).isEqualTo(assetA);
            assertThat(rows(tenant, principal, "video/mp4")).isZero();

            String attestationA = attest(port, tenant, token, assetA, versionA, "A");

            // ---- the render: stored MP4 + manifest ----
            long started = System.nanoTime();
            JsonNode created = render(port, tenant, token, request("golden-" + run, goldenWithA, 14), 201);
            long renderMillis = (System.nanoTime() - started) / 1_000_000;
            assertThat(created.path("replayed").asBoolean()).isFalse();
            String renderId = created.path("renderId").asString();
            String videoId = created.path("video").path("artifactId").asString();
            assertThat(created.path("video").path("contentType").asString()).isEqualTo("video/mp4");
            assertThat(rows(tenant, principal, "video/mp4")).isEqualTo(1);
            JsonNode manifest = created.path("manifest");
            assertThat(manifest.path("frames")).hasSize(FRAMES);
            assertThat(manifest.path("assets")).hasSize(1);
            assertThat(manifest.path("assets").path(0).path("rights").path("verdict").asString()).isEqualTo("ADMITTED");
            assertThat(created.path("videoLineage").path("parent").path("artifactId").asString()).isEqualTo(assetA);

            // ---- independent verification of the STORED bytes ----
            byte[] mp4 = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, videoId));
            assertThat(sha256(mp4)).isEqualTo(created.path("video").path("sha256").asString());
            Path file = work.resolve("render.mp4");
            Files.write(file, mp4);
            Probe probe = probe(file);
            assertThat(probe.codec).isEqualTo("h264");
            assertThat(probe.pixFmt).isEqualTo("yuv420p");
            assertThat(probe.width).isEqualTo(W);
            assertThat(probe.height).isEqualTo(H);
            assertThat(probe.avgFrameRate).isEqualTo("24/1");
            assertThat(probe.timeBase).isEqualTo("1/12816");
            assertThat(probe.pts).as("exact frame count and PTS ticks (534 ticks of 1/12816 s = 1/24 s)").hasSize(FRAMES);
            for (int i = 0; i < FRAMES; i++) assertThat(probe.pts.get(i)).isEqualTo(i * 534L);
            assertThat(probe.readFrames).as("decoder-counted frames").isEqualTo(FRAMES);
            System.out.printf("J12-IT-ENCODE renderMillis=%d mp4Bytes=%d codec=%s fps=%s frames=%d lastPtsSeconds=%d/24 profile=%s%n",
                    renderMillis, mp4.length, probe.codec, probe.avgFrameRate, probe.pts.size(), FRAMES - 1, probe.profile);

            byte[] decoded = decodeRgb(file);
            assertThat(decoded).hasSize(FRAMES * W * H * 3);

            // golden frames from this test's own curve math and rasterizer (no renderer code)
            byte[] sticker = decodeSticker(stickerA);
            double minPsnr = Double.MAX_VALUE;
            double sumPsnr = 0;
            int worstFrame = -1;
            for (int f = 0; f < FRAMES; f++) {
                byte[] golden = goldenFrame(f, sticker);
                double psnr = psnr(golden, 0, decoded, f * W * H * 3, W * H * 3);
                sumPsnr += psnr;
                if (psnr < minPsnr) { minPsnr = psnr; worstFrame = f; }
            }
            System.out.printf("J12-IT-PSNR golden-vs-decoded frames=%d minPsnrDb=%.2f (frame %d) meanPsnrDb=%.2f%n",
                    FRAMES, minPsnr, worstFrame, sumPsnr / FRAMES);
            assertThat(minPsnr).as("YUV420 H.264 CRF 14 keeps every frame close to the golden frame").isGreaterThan(30.0);

            // motion curves measured in the DECODED frames against the easing math
            double maxBoxError = 0;
            double maxBallError = 0;
            StringBuilder table = new StringBuilder();
            for (int f : new int[] {0, 6, 12, 18, 24, 30, 36, 42, 47}) {
                double[] box = at(BOX_KEYS, f);
                int expectedLeft = (int) Math.ceil(20 + box[0] - 0.5);
                int measuredLeft = leftmost(decoded, f);
                double ballExpected = 92 + at(BALL_KEYS, f)[1];
                double ballMeasured = centroidY(decoded, f);
                maxBoxError = Math.max(maxBoxError, Math.abs(measuredLeft - expectedLeft));
                maxBallError = Math.max(maxBallError, Math.abs(ballMeasured - ballExpected));
                table.append(String.format("f%d(t=%.4fs):boxLeft exp=%d got=%d,ballCenterY exp=%.2f got=%.2f; ",
                        f, f / 24.0, expectedLeft, measuredLeft, ballExpected, ballMeasured));
            }
            System.out.println("J12-IT-CURVES " + table);
            System.out.printf("J12-IT-CURVES maxBoxLeftErrorPx=%.2f maxBallCenterYErrorPx=%.2f%n", maxBoxError, maxBallError);
            assertThat(maxBoxError).isLessThanOrEqualTo(1.0);
            assertThat(maxBallError).isLessThanOrEqualTo(1.0);

            // pre-encode frames: this test renders the same scene in-process; digests must equal the launcher's manifest
            List<AnimationRenderer.Frame> local = new AnimationRenderer().render(localSpec(), goldenScene(stickerA),
                    new AnimationRenderer.Profile(24, 1, FRAMES)).frames();
            assertThat(local).hasSize(FRAMES);
            int pngMatches = 0;
            long goldenMismatchPixels = 0;
            for (int f = 0; f < FRAMES; f++) {
                JsonNode entry = manifest.path("frames").path(f);
                assertThat(entry.path("index").asInt()).isEqualTo(f);
                assertThat(entry.path("pixelSha256").asString()).as("frame " + f + " pre-encode pixel digest")
                        .isEqualTo(pixelDigest(local.get(f).png()));
                if (entry.path("pngSha256").asString().equals(sha256(local.get(f).png()))) pngMatches++;
                assertThat(entry.path("ptsNumerator").asString() + "/" + entry.path("ptsDenominator").asString())
                        .isEqualTo(local.get(f).ptsNumerator() + "/" + local.get(f).ptsDenominator());
                assertThat(entry.path("ptsTicks").asLong()).isEqualTo(f * 534L);
                // the renderer's own frame vs this test's independent golden rasterization
                BufferedImage image = ImageIO.read(new ByteArrayInputStream(local.get(f).png()));
                byte[] golden = goldenFrame(f, sticker);
                for (int y = 0; y < H; y++) {
                    for (int x = 0; x < W; x++) {
                        int argb = image.getRGB(x, y);
                        int i = (y * W + x) * 3;
                        int d = Math.max(Math.abs(((argb >> 16) & 0xff) - (golden[i] & 0xff)),
                                Math.max(Math.abs(((argb >> 8) & 0xff) - (golden[i + 1] & 0xff)),
                                        Math.abs((argb & 0xff) - (golden[i + 2] & 0xff))));
                        if (d > 3) goldenMismatchPixels++;
                    }
                }
            }
            System.out.printf("J12-IT-GOLDEN renderer-vs-independent-golden mismatchedPixels(>3 levels)=%d of %d (%.4f%%); "
                    + "launcher-vs-local pixel digests equal for %d/%d frames, PNG bytes equal for %d/%d%n",
                    goldenMismatchPixels, (long) FRAMES * W * H, 100.0 * goldenMismatchPixels / ((long) FRAMES * W * H),
                    FRAMES, FRAMES, pngMatches, FRAMES);
            assertThat(goldenMismatchPixels).as("independent golden raster agrees with the renderer except edge pixels")
                    .isLessThan((long) FRAMES * W * H / 200);

            // ---- determinism: the same spec under a new requestId has an identical pre-encode frame set ----
            JsonNode second = render(port, tenant, token, request("golden-b-" + run, goldenWithA, 14), 201);
            assertThat(second.path("manifest").path("frameSetSha256").asString()).isEqualTo(manifest.path("frameSetSha256").asString());
            assertThat(second.path("manifest").path("frames").toString()).isEqualTo(manifest.path("frames").toString());
            assertThat(second.path("video").path("sha256").asString()).as("the container comment carries the request id")
                    .isNotEqualTo(created.path("video").path("sha256").asString());

            // ---- idempotent replay and a changed body under the same requestId ----
            int rowsBefore = rows(tenant, principal, "video/mp4");
            JsonNode replay = render(port, tenant, token, request("golden-" + run, goldenWithA, 14), 200);
            assertThat(replay.path("replayed").asBoolean()).isTrue();
            assertThat(replay.path("renderId").asString()).isEqualTo(renderId);
            assertThat(replay.path("video").path("sha256").asString()).isEqualTo(created.path("video").path("sha256").asString());
            Map<String, Object> changed = goldenSpec(assetA, versionA);
            ((Map<String, Object>) ((List<?>) changed.get("shapes")).get(0)).put("color", "#00FF00");
            expect(port, tenant, token, request("golden-" + run, changed, 14), 409, "ANIMATION_REQUEST_ID_REUSED");
            expect(port, tenant, token, request("golden-" + run, goldenWithA, 20), 409, "ANIMATION_REQUEST_ID_REUSED");
            assertThat(rows(tenant, principal, "video/mp4")).isEqualTo(rowsBefore);

            // ---- wrong tenant: the exact asset and the render are invisible; nothing is registered there ----
            String otherToken = issueDevToken(otherTenant, principal);
            expect(port, otherTenant, otherToken, request("foreign-" + run, goldenWithA, 14), 404,
                    "SOURCE_VERSION_NOT_FOUND");
            assertThat(send(port, otherTenant, otherToken, "GET", RENDERS + "/" + renderId, null).statusCode()).isEqualTo(404);
            assertThat(rows(otherTenant, principal, "video/mp4")).isZero();
            String otherPrincipalToken = issueDevToken(tenant, "someone-else-" + run);
            assertThat(send(port, tenant, otherPrincipalToken, "GET", RENDERS + "/" + renderId, null).statusCode()).isEqualTo(404);

            // ---- revoked rights: a NEW request and a REPLAY of the stored render are both refused ----
            JsonNode revokedAttestation = post(port, tenant, token, "/dev/v1/rights/attestations/" + attestationA + "/revoke",
                    Map.of("reason", "TEST: revoked to prove fail-closed"), 200);
            assertThat(revokedAttestation.path("status").asString()).isEqualTo("REVOKED");
            JsonNode afterRevoke = expect(port, tenant, token, request("golden2-" + run, goldenWithA, 14), 403, "RIGHTS_NOT_ADMITTED");
            assertThat(afterRevoke.path("error").path("details").path("verdict").asString()).isEqualTo("REVOKED");
            expect(port, tenant, token, request("golden-" + run, goldenWithA, 14), 403, "RIGHTS_NOT_ADMITTED");
            assertThat(rows(tenant, principal, "video/mp4")).isEqualTo(rowsBefore);
            // B has its own statement; re-admit the scene through B to continue the journey
            String attestationB = attest(port, tenant, token, assetB, versionB, "B");
            Map<String, Object> goldenWithB = goldenSpec(assetB, versionB);

            // ---- the real encoder killed mid-render: UNKNOWN, nothing registered, then exactly one registration on retry ----
            Map<String, Object> killSpec = goldenSpec(assetB, versionB);
            wrapper.mode("hang");
            String killBody = request("kill-encoder-" + run, killSpec, 14);
            CompletableFuture<HttpResponse<String>> inFlight = sendAsync(port, tenant, token, killBody);
            ProcessHandle encoder = MediaDevFaultInjector.awaitDescendant(launcher, "sleep 3600", Duration.ofSeconds(120));
            assertThat(inFlight.isDone()).isFalse();
            MediaDevFaultInjector.signal(encoder, "KILL");
            HttpResponse<String> unknown = inFlight.get(2, TimeUnit.MINUTES);
            assertThat(unknown.statusCode()).as(unknown.body()).isEqualTo(503);
            assertThat(unknown.body()).contains("ANIMATION_OUTCOME_UNKNOWN").contains("\"outcome\":\"UNKNOWN\"");
            assertThat(rows(tenant, principal, "kill-encoder-" + run)).as("the killed run registered nothing").isZero();
            wrapper.mode("ok");
            JsonNode retried = render(port, tenant, token, killBody, 201);
            assertThat(retried.path("replayed").asBoolean()).isFalse();
            assertThat(render(port, tenant, token, killBody, 200).path("renderId").asString())
                    .isEqualTo(retried.path("renderId").asString());
            assertThat(rows(tenant, principal, "kill-encoder-" + run)).as("one video and one manifest").isEqualTo(2);

            // ---- the launcher killed mid-render: restart, retry the same requestId, exactly one registration ----
            wrapper.mode("hang");
            String crashBody = request("kill-launcher-" + run, killSpec, 14);
            CompletableFuture<HttpResponse<String>> doomed = sendAsync(port, tenant, token, crashBody);
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
            assertThat(rows(tenant, principal, "kill-launcher-" + run)).as("nothing registered by the killed launcher").isZero();
            wrapper.mode("ok");
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            token = issueDevToken(tenant, principal);
            JsonNode afterCrash = render(port, tenant, token, crashBody, 201);
            assertThat(afterCrash.path("replayed").asBoolean()).isFalse();
            assertThat(render(port, tenant, token, crashBody, 200).path("renderId").asString())
                    .isEqualTo(afterCrash.path("renderId").asString());
            assertThat(rows(tenant, principal, "kill-launcher-" + run)).as("exactly one video and one manifest").isEqualTo(2);

            // ---- restart: replay of the first render and determinism across the restart ----
            JsonNode replayAfterRestart = render(port, tenant, token, request("kill-encoder-" + run, killSpec, 14), 200);
            assertThat(replayAfterRestart.path("renderId").asString()).isEqualTo(retried.path("renderId").asString());
            // A's rights are revoked; the unchanged golden spec over B is the same scene with a different asset digest.
            JsonNode again = render(port, tenant, token, request("golden-restart-" + run, goldenWithB, 14), 201);
            JsonNode afterWithB = render(port, tenant, token, request("golden-restart-2-" + run, goldenWithB, 14), 201);
            assertThat(afterWithB.path("manifest").path("frameSetSha256").asString())
                    .as("same spec, new requestId, after a restart: identical pre-encode frame set")
                    .isEqualTo(again.path("manifest").path("frameSetSha256").asString())
                    .isEqualTo(retried.path("manifest").path("frameSetSha256").asString());
            assertThat(afterWithB.path("video").path("sha256").asString()).as("container comment carries the request id")
                    .isNotEqualTo(again.path("video").path("sha256").asString());
            assertThat(afterWithB.path("manifest").path("frames").toString())
                    .isEqualTo(again.path("manifest").path("frames").toString());

            // revoke B: replay of its stored render is refused too, and a reopen by id still reads the registered manifest
            post(port, tenant, token, "/dev/v1/rights/attestations/" + attestationB + "/revoke", Map.of("reason", "TEST: revoke B"), 200);
            expect(port, tenant, token, request("golden-restart-" + run, goldenWithB, 14), 403, "RIGHTS_NOT_ADMITTED");
            JsonNode reopened = get(port, tenant, token, RENDERS + "/" + renderId, 200);
            assertThat(reopened.path("manifest").path("frameSetSha256").asString())
                    .isEqualTo(manifest.path("frameSetSha256").asString());
            System.out.println("J12-IT-DETERMINISM frameSetSha256=" + manifest.path("frameSetSha256").asString()
                    + " (asset A) identical across two requests and the in-process renderer; asset B's frame set identical across "
                    + "three requests and a launcher kill+restart");
            passed = true;
        } finally {
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("J-12 animation IT failure log retained at " + log);
            deleteTree(services);
            deleteTree(work);
        }
    }

    // ------------------------------------------------------------------------------------------ spec and curves

    private record K(int frame, double x, double y, double sx, double sy, double opacity, String easing) { }

    private static final List<K> BOX_KEYS = List.of(
            new K(0, 0, 0, 1, 1, 1, "EASE_IN_OUT"), new K(24, 200, 0, 1, 1, 1, "EASE_OUT"), new K(47, 100, 0, 1, 1, 1, "LINEAR"));
    private static final List<K> BALL_KEYS = List.of(
            new K(0, 0, 0, 1, 1, 1, "EASE_IN"), new K(30, 0, 60, 1.5, 1.5, 1, "LINEAR"), new K(47, 0, 60, 1.5, 1.5, 1, "LINEAR"));
    private static final List<K> FADE_KEYS = List.of(
            new K(0, 0, 0, 1, 1, 0, "LINEAR"), new K(47, 0, 0, 1, 1, 1, "LINEAR"));

    private static Map<String, Object> keyJson(K key) {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("frame", key.frame());
        json.put("x", key.x());
        json.put("y", key.y());
        json.put("scaleX", key.sx());
        json.put("scaleY", key.sy());
        json.put("opacity", key.opacity());
        json.put("easing", key.easing());
        return json;
    }

    private static Map<String, Object> shapeJson(String id, String primitive, int x, int y, int w, int h, String color, List<K> keys) {
        Map<String, Object> shape = new LinkedHashMap<>();
        shape.put("id", id);
        shape.put("primitive", primitive);
        shape.put("x", x);
        shape.put("y", y);
        shape.put("width", w);
        shape.put("height", h);
        if (color != null) shape.put("color", color);
        List<Object> list = new ArrayList<>();
        for (K key : keys) list.add(keyJson(key));
        shape.put("keyframes", list);
        return shape;
    }

    /** Box (ease in-out, ease out), ball (ease in, scale up), fading rectangle, and the uploaded sticker at 2x. */
    private static Map<String, Object> goldenSpec(String assetId, String assetVersion) {
        Map<String, Object> spec = new LinkedHashMap<>();
        spec.put("width", W);
        spec.put("height", H);
        spec.put("background", "#101828");
        spec.put("fps", new LinkedHashMap<>(Map.of("numerator", 24, "denominator", 1)));
        spec.put("frameCount", FRAMES);
        List<Object> shapes = new ArrayList<>();
        shapes.add(shapeJson("box", "RECTANGLE", 20, 20, 40, 40, "#FF4040", BOX_KEYS));
        shapes.add(shapeJson("ball", "ELLIPSE", 140, 80, 24, 24, "#40FF80", BALL_KEYS));
        shapes.add(shapeJson("fade", "RECTANGLE", 240, 110, 60, 40, "#FFFFFF", FADE_KEYS));
        Map<String, Object> pic = shapeJson("pic", "RASTER_ASSET", 24, 110, 32, 32, null, List.of());
        pic.put("assetId", "sticker");
        shapes.add(pic);
        spec.put("shapes", shapes);
        spec.put("assets", new ArrayList<>(List.of(new LinkedHashMap<>(Map.of("id", "sticker", "artifactId", assetId,
                "artifactVersionId", assetVersion)))));
        return spec;
    }

    private static String request(String requestId, Map<String, Object> spec, int crf) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("spec", spec);
        body.put("encoder", Map.of("crf", crf));
        return JSON.writeValueAsString(body);
    }

    private static AnimationRenderer.Scene goldenScene(byte[] stickerRgbaPixelsPng) throws Exception {
        BufferedImage image = ImageIO.read(new ByteArrayInputStream(stickerRgbaPixelsPng));
        int[] argb = image.getRGB(0, 0, image.getWidth(), image.getHeight(), null, 0, image.getWidth());
        List<AnimationRenderer.Shape> shapes = List.of(
                shape("box", AnimationRenderer.Primitive.RECTANGLE, 20, 20, 40, 40, 0xFFFF4040, BOX_KEYS, null),
                shape("ball", AnimationRenderer.Primitive.ELLIPSE, 140, 80, 24, 24, 0xFF40FF80, BALL_KEYS, null),
                shape("fade", AnimationRenderer.Primitive.RECTANGLE, 240, 110, 60, 40, 0xFFFFFFFF, FADE_KEYS, null),
                shape("pic", AnimationRenderer.Primitive.RASTER_ASSET, 24, 110, 32, 32, 0xFFFFFFFF, List.of(), "sticker"));
        return new AnimationRenderer.Scene(W, H, BG, shapes, List.of(),
                List.of(new AnimationRenderer.RasterAsset("sticker", image.getWidth(), image.getHeight(), argb)));
    }

    private static AnimationRenderer.Shape shape(String id, AnimationRenderer.Primitive primitive, int x, int y, int w, int h,
                                                 int argb, List<K> keys, String assetId) {
        List<AnimationRenderer.Keyframe> frames = new ArrayList<>();
        for (K key : keys) {
            frames.add(new AnimationRenderer.Keyframe(key.frame(), key.x(), key.y(), key.sx(), key.sy(), 0, key.opacity(),
                    AnimationRenderer.Easing.valueOf(key.easing())));
        }
        return new AnimationRenderer.Shape(id, primitive, x, y, w, h, 0, argb, frames, assetId);
    }

    private static AnimationSpecCompiler.AnimationSpec localSpec() {
        return new AnimationSpecCompiler.AnimationSpec("media.declarative.value.animation-spec.v1", "scene:x", "animation:x",
                "operators:none", "assets:1", List.of("curve:a"),
                new AnimationSpecCompiler.StoryTime("story", "dev-animation", "main", "origin:start", "0",
                        new AnimationSpecCompiler.PositiveRational("1", "1000")), "rendering:x");
    }

    // ---- the test's own easing math and rasterizer (independent of the renderer) ----

    private static double ease(String easing, double t) {
        return switch (easing) {
            case "EASE_IN" -> t * t;
            case "EASE_OUT" -> 1 - (1 - t) * (1 - t);
            case "EASE_IN_OUT" -> t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            default -> t;
        };
    }

    /** {x, y, scaleX, scaleY, opacity} of the curve at a frame. */
    private static double[] at(List<K> keys, int frame) {
        K left = keys.getFirst();
        if (frame <= left.frame()) return new double[] {left.x(), left.y(), left.sx(), left.sy(), left.opacity()};
        for (int i = 1; i < keys.size(); i++) {
            K right = keys.get(i);
            if (frame <= right.frame()) {
                double t = ease(left.easing(), (double) (frame - left.frame()) / (right.frame() - left.frame()));
                return new double[] {left.x() + (right.x() - left.x()) * t, left.y() + (right.y() - left.y()) * t,
                        left.sx() + (right.sx() - left.sx()) * t, left.sy() + (right.sy() - left.sy()) * t,
                        left.opacity() + (right.opacity() - left.opacity()) * t};
            }
            left = right;
        }
        return new double[] {left.x(), left.y(), left.sx(), left.sy(), left.opacity()};
    }

    private static byte[] goldenFrame(int frame, byte[] sticker) {
        byte[] out = new byte[W * H * 3];
        for (int i = 0; i < W * H; i++) {
            out[i * 3] = (byte) ((BG >> 16) & 0xff);
            out[i * 3 + 1] = (byte) ((BG >> 8) & 0xff);
            out[i * 3 + 2] = (byte) (BG & 0xff);
        }
        double[] box = at(BOX_KEYS, frame);
        fill(out, 20, 20, 40, 40, box, false, 0xFF4040);
        double[] ball = at(BALL_KEYS, frame);
        fill(out, 140, 80, 24, 24, ball, true, 0x40FF80);
        double[] fade = at(FADE_KEYS, frame);
        fill(out, 240, 110, 60, 40, fade, false, 0xFFFFFF);
        // asset at integer position, 2x nearest-neighbour
        for (int y = 110; y < 142; y++) {
            for (int x = 24; x < 56; x++) {
                int s = ((y - 110) / 2 * 16 + (x - 24) / 2) * 3;
                int i = (y * W + x) * 3;
                out[i] = sticker[s];
                out[i + 1] = sticker[s + 1];
                out[i + 2] = sticker[s + 2];
            }
        }
        return out;
    }

    /** Pixel-centre rule; opacity blends over the destination with alpha rounded to 8 bits like the renderer. */
    private static void fill(byte[] out, int x, int y, int w, int h, double[] curve, boolean ellipse, int rgb) {
        double cx = x + w / 2.0 + curve[0];
        double cy = y + h / 2.0 + curve[1];
        double hw = w / 2.0 * curve[2];
        double hh = h / 2.0 * curve[3];
        int alpha = (int) Math.round(255 * curve[4]);
        if (alpha == 0 || hw == 0 || hh == 0) return;
        for (int py = Math.max(0, (int) Math.floor(cy - hh) - 1); py < Math.min(H, (int) Math.ceil(cy + hh) + 1); py++) {
            for (int px = Math.max(0, (int) Math.floor(cx - hw) - 1); px < Math.min(W, (int) Math.ceil(cx + hw) + 1); px++) {
                double dx = px + 0.5 - cx;
                double dy = py + 0.5 - cy;
                boolean inside = ellipse ? (dx * dx) / (hw * hw) + (dy * dy) / (hh * hh) <= 1.0
                        : dx >= -hw && dx < hw && dy >= -hh && dy < hh;
                if (!inside) continue;
                int i = (py * W + px) * 3;
                int[] src = {(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff};
                for (int c = 0; c < 3; c++) {
                    out[i + c] = (byte) Math.round((src[c] * alpha + (out[i + c] & 0xff) * (255.0 - alpha)) / 255.0);
                }
            }
        }
    }

    private static byte[] decodeSticker(byte[] png) throws Exception {
        BufferedImage image = ImageIO.read(new ByteArrayInputStream(png));
        byte[] rgb = new byte[16 * 16 * 3];
        for (int y = 0; y < 16; y++) {
            for (int x = 0; x < 16; x++) {
                int argb = image.getRGB(x, y);
                int i = (y * 16 + x) * 3;
                rgb[i] = (byte) (argb >> 16);
                rgb[i + 1] = (byte) (argb >> 8);
                rgb[i + 2] = (byte) argb;
            }
        }
        return rgb;
    }

    private static byte[] sticker(int first, int second) throws Exception {
        BufferedImage image = new BufferedImage(16, 16, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < 16; y++) {
            for (int x = 0; x < 16; x++) image.setRGB(x, y, ((x / 4 + y / 4) % 2 == 0) ? first : second);
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    // ---- measurements on decoded frames ----

    private static double psnr(byte[] a, int aOffset, byte[] b, int bOffset, int length) {
        double sum = 0;
        for (int i = 0; i < length; i++) {
            double d = (a[aOffset + i] & 0xff) - (b[bOffset + i] & 0xff);
            sum += d * d;
        }
        double mse = sum / length;
        return mse == 0 ? 99.0 : 10 * Math.log10(255.0 * 255.0 / mse);
    }

    /** Leftmost pixel of the red box (r high, g and b low) in a band of rows 20..60. */
    private static int leftmost(byte[] rgb, int frame) {
        for (int x = 0; x < W; x++) {
            int hits = 0;
            for (int y = 20; y < 60; y++) {
                int i = frame * W * H * 3 + (y * W + x) * 3;
                if ((rgb[i] & 0xff) > 170 && (rgb[i + 1] & 0xff) < 120 && (rgb[i + 2] & 0xff) < 120) hits++;
            }
            if (hits >= 20) return x;
        }
        return -1;
    }

    /** Mean row of green ball pixels (low red, high green) below the box band. */
    private static double centroidY(byte[] rgb, int frame) {
        double sum = 0;
        int count = 0;
        for (int y = 64; y < H; y++) {
            for (int x = 100; x < 220; x++) {
                int i = frame * W * H * 3 + (y * W + x) * 3;
                if ((rgb[i] & 0xff) < 140 && (rgb[i + 1] & 0xff) > 170 && (rgb[i + 2] & 0xff) < 190) {
                    sum += y + 0.5;
                    count++;
                }
            }
        }
        return count == 0 ? -1 : sum / count;
    }

    private static String pixelDigest(byte[] png) throws Exception {
        BufferedImage image = ImageIO.read(new ByteArrayInputStream(png));
        int[] argb = image.getRGB(0, 0, image.getWidth(), image.getHeight(), null, 0, image.getWidth());
        ByteBuffer buffer = ByteBuffer.allocate(argb.length * 4);
        for (int value : argb) buffer.putInt(value);
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(buffer.array()));
    }

    // ---- ffprobe / ffmpeg ----

    private record Probe(String codec, String profile, String pixFmt, int width, int height, String avgFrameRate,
                         String timeBase, List<Long> pts, int readFrames) { }

    private static Probe probe(Path file) throws Exception {
        String streams = exec(List.of(ffprobe(), "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
                "stream=codec_name,profile,pix_fmt,width,height,avg_frame_rate,time_base,nb_read_frames", "-of", "json", file.toString()));
        JsonNode stream = JSON.readTree(streams).path("streams").path(0);
        String frames = exec(List.of(ffprobe(), "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts", "-of", "csv=p=0",
                file.toString()));
        List<Long> pts = new ArrayList<>();
        for (String line : frames.strip().split("\n")) if (!line.isBlank()) pts.add(Long.parseLong(line.strip().split(",")[0]));
        return new Probe(stream.path("codec_name").asString(), stream.path("profile").asString(), stream.path("pix_fmt").asString(),
                stream.path("width").asInt(), stream.path("height").asInt(), stream.path("avg_frame_rate").asString(),
                stream.path("time_base").asString(), pts, Integer.parseInt(stream.path("nb_read_frames").asString()));
    }

    private static byte[] decodeRgb(Path file) throws Exception {
        Process process = new ProcessBuilder(ffmpeg(), "-nostdin", "-v", "error", "-i", file.toString(), "-f", "rawvideo",
                "-pix_fmt", "rgb24", "-").redirectErrorStream(false).start();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        process.getInputStream().transferTo(out);
        byte[] err = process.getErrorStream().readAllBytes();
        assertThat(process.waitFor(2, TimeUnit.MINUTES)).isTrue();
        assertThat(process.exitValue()).as(new String(err)).isZero();
        return out.toByteArray();
    }

    private static String exec(List<String> command) throws Exception {
        Process process = new ProcessBuilder(command).redirectErrorStream(false).start();
        byte[] out = process.getInputStream().readAllBytes();
        byte[] err = process.getErrorStream().readAllBytes();
        assertThat(process.waitFor(2, TimeUnit.MINUTES)).isTrue();
        assertThat(process.exitValue()).as(new String(err)).isZero();
        return new String(out);
    }

    // ---- HTTP and database helpers ----

    private static JsonNode expect(int port, String tenant, String token, String body, int status, String code) throws Exception {
        HttpResponse<String> response = send(port, tenant, token, "POST", RENDERS, body);
        assertThat(response.statusCode()).as(response.body()).isEqualTo(status);
        JsonNode parsed = JSON.readTree(response.body());
        assertThat(parsed.path("error").path("code").asString()).as(response.body()).isEqualTo(code);
        return parsed;
    }

    private static JsonNode render(int port, String tenant, String token, String body, int status) throws Exception {
        HttpResponse<String> response = send(port, tenant, token, "POST", RENDERS, body);
        assertThat(response.statusCode()).as(response.body()).isEqualTo(status);
        return JSON.readTree(response.body());
    }

    private static CompletableFuture<HttpResponse<String>> sendAsync(int port, String tenant, String token, String body) {
        return CompletableFuture.supplyAsync(() -> {
            try {
                return send(port, tenant, token, "POST", RENDERS, body);
            } catch (Exception failure) {
                throw new IllegalStateException(failure);
            }
        });
    }

    private static String attest(int port, String tenant, String token, String artifactId, String version, String label) throws Exception {
        JsonNode attested = post(port, tenant, token, "/dev/v1/rights/attestations", Map.of("artifactId", artifactId,
                "artifactVersionId", version, "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                "basis", "TEST: sticker " + label + " is a synthetic image generated inside an automated test; a statement by a "
                        + "synthetic test principal, not a legal determination"), 201);
        return attested.path("attestationId").asString();
    }

    /** Durable artifact rows of the principal whose content type or metadata mentions {@code needle}. */
    private static int rows(String tenant, String principal, String needle) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement("SELECT count(*) FROM media_artifacts WHERE tenant_id=? AND principal_id=? "
                     + "AND (content_type=? OR metadata_json LIKE ?)")) {
            statement.setString(1, tenant);
            statement.setString(2, principal);
            statement.setString(3, needle);
            statement.setString(4, "%" + needle + "%");
            try (var row = statement.executeQuery()) {
                row.next();
                return row.getInt(1);
            }
        }
    }
}
