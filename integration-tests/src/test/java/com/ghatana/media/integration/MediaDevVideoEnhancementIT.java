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
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
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
 * J-08 `media.dev.outcome-video-enhancement` against REAL processes: the real launcher with the durable PostgreSQL +
 * S3 artifact store and the durable request ledger (Testcontainers), real FFmpeg/ffprobe, an FFmpeg-generated clean
 * reference (moving test pattern and text counter, 640x360, 25 fps, AAC tone) and a degraded copy made by blur,
 * low-bitrate blockiness and known-sigma Gaussian noise. Covers rights missing/revoked, out-of-range parameters,
 * stale versions, corrupt inputs, the enhancement's verified timeline (ffprobe PTS identical to the source, audio
 * packets bit-identical), the independent measured comparison (PSNR/SSIM improvement asserted by measured amounts and
 * cross-checked against FFmpeg's own filters), a real Chromium session on the Explorer page, a launcher restart and
 * readback, and the real FFmpeg process killed mid-run (UNKNOWN, then exactly one registration on retry).
 * Missing runtime prerequisites FAIL the test.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevVideoEnhancementIT {
    private static final String ENHANCEMENTS = "/dev/v1/video/enhancements";
    private static final String COMPARISONS = "/dev/v1/video/comparisons";
    private static final double NOISE_SIGMA = 8.0;

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void realLauncherEnhancesVideoWithVerifiedTimelineAndMeasuresItIndependentlyThroughBrowserRestartRevocationAndKilledFfmpeg()
            throws Exception {
        String ffmpegEnv = System.getenv("MEDIA_DEV_RENDER_FFMPEG");
        String ffprobeEnv = System.getenv("MEDIA_DEV_RENDER_FFPROBE");
        assertThat(ffmpegEnv).as("MEDIA_DEV_RENDER_FFMPEG").isNotBlank();
        assertThat(ffprobeEnv).as("MEDIA_DEV_RENDER_FFPROBE").isNotBlank();
        Path ffmpeg = Path.of(ffmpegEnv);
        Path ffprobe = Path.of(ffprobeEnv);

        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-video-" + run;
        String principal = "media-dev-video-" + run;
        String bucket = "media-dev-video-" + run;
        String schema = "media_dev_video_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        int vitePort;
        try (var socket = new java.net.ServerSocket(0)) { vitePort = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-video-services-");
        Path work = Files.createTempDirectory("media-dev-video-work-");
        Path log = Files.createTempFile("media-dev-video-process-", ".log");
        Process launcher = null;
        Process browser = null;
        boolean passed = false;
        try {
            try (var s3 = s3(LOCALSTACK)) {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
            environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg.toString());
            environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe.toString());
            environment.put("MEDIA_MAX_BODY_BYTES", Integer.toString(16 * 1024 * 1024));
            environment.put("MEDIA_MAX_CHUNK_BYTES", Integer.toString(16 * 1024 * 1024));
            String token = issueDevToken(tenant, principal);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            // ---- real input: FFmpeg-generated clean reference and a degraded copy with known Gaussian noise ----
            byte[] reference = VideoEnhancementFixture.reference(ffmpeg, work, 2);
            byte[] degraded = VideoEnhancementFixture.degraded(ffmpeg, work, reference, NOISE_SIGMA, 20261114L, 34);
            Path referenceFile = work.resolve("p-reference.mp4");
            Path degradedFile = work.resolve("p-degraded.mp4");
            Files.write(referenceFile, reference);
            Files.write(degradedFile, degraded);
            VideoEnhancementFixture.Probe degradedProbe = VideoEnhancementFixture.probe(ffprobe, degradedFile);
            assertThat(degradedProbe.pts()).hasSize(50);
            String referenceId = upload(port, tenant, principal, token, run + "-ref", "reference.mp4", "video/mp4", reference);
            String degradedId = upload(port, tenant, principal, token, run + "-deg", "degraded.mp4", "video/mp4", degraded);
            String referenceVersion = "sha256:" + sha256(reference);
            String degradedVersion = "sha256:" + sha256(degraded);
            // A valid MP4 signature (the canonical upload sniffs it) followed by random bytes: not a decodable video.
            byte[] garbage = new byte[20_000];
            new java.util.Random(7).nextBytes(garbage);
            System.arraycopy(degraded, 0, garbage, 0, 32);
            byte[] truncated = java.util.Arrays.copyOf(degraded, degraded.length / 3);
            String garbageId = upload(port, tenant, principal, token, run + "-garbage", "garbage.mp4", "video/mp4", garbage);
            String truncatedId = upload(port, tenant, principal, token, run + "-trunc", "truncated.mp4", "video/mp4", truncated);
            int uploadedVideos = countArtifacts(tenant, principal, "video/mp4");
            assertThat(uploadedVideos).isEqualTo(4);

            List<Map<String, Object>> chain = List.of(
                    Map.of("type", "denoise", "method", "nlmeans", "strength", 4),
                    Map.of("type", "deblock", "strength", 0.1),
                    Map.of("type", "sharpen", "amount", 0.3));
            String chainGraph = "nlmeans=s=4:p=5:pc=5:r=7:rc=7,deblock=filter=strong:block=8:alpha=0.1:beta=0.05:gamma=0.05:delta=0.05,"
                    + "unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=0.3:chroma_msize_x=3:chroma_msize_y=3:chroma_amount=0";

            // ---- rights missing: refused, nothing read, processed or registered ----
            HttpResponse<String> noRights = send(port, tenant, token, "POST", ENHANCEMENTS,
                    JSON.writeValueAsString(enhancement("enh-" + run, degradedId, degradedVersion, chain)));
            assertThat(noRights.statusCode()).as(noRights.body()).isEqualTo(403);
            assertThat(noRights.body()).contains("RIGHTS_DENIED");
            assertThat(countArtifacts(tenant, principal, "video/mp4")).isEqualTo(uploadedVideos);

            // ---- out-of-range parameters are refused before the source is even looked up ----
            for (List<Map<String, Object>> bad : List.of(
                    List.<Map<String, Object>>of(Map.of("type", "sharpen", "amount", 9.0)),
                    List.<Map<String, Object>>of(Map.of("type", "denoise", "method", "hqdn3d", "strength", 99)),
                    List.<Map<String, Object>>of(Map.of("type", "denoise", "method", "nlmeans", "strength", 0.2)),
                    List.<Map<String, Object>>of(Map.of("type", "deblock", "strength", 5)),
                    List.<Map<String, Object>>of(Map.of("type", "colourCorrection", "brightness", 3.0)),
                    List.<Map<String, Object>>of(Map.of("type", "scale", "width", 4096)),
                    List.<Map<String, Object>>of(Map.of("type", "sharpen", "amount", 0.5), Map.of("type", "sharpen", "amount", 0.6)),
                    List.<Map<String, Object>>of())) {
                HttpResponse<String> refused = send(port, tenant, token, "POST", ENHANCEMENTS, JSON.writeValueAsString(
                        enhancement("bad-" + bad.hashCode(), "no-such-artifact", "sha256:" + "0".repeat(64), bad)));
                assertThat(refused.statusCode()).as(bad + " " + refused.body()).isEqualTo(422);
                assertThat(refused.body()).contains("VIDEO_PARAMETER_OUT_OF_RANGE");
            }
            Map<String, Object> badCrf = new HashMap<>(enhancement("bad-crf-" + run, "x", "sha256:" + "0".repeat(64), chain));
            badCrf.put("encoder", Map.of("crf", 99));
            assertThat(send(port, tenant, token, "POST", ENHANCEMENTS, JSON.writeValueAsString(badCrf)).body())
                    .contains("VIDEO_PARAMETER_OUT_OF_RANGE");
            assertThat(countArtifacts(tenant, principal, "video/mp4")).isEqualTo(uploadedVideos);

            // ---- rights granted for the exact degraded version; stale and foreign requests are refused ----
            String degradedAttestation = attest(port, tenant, token, degradedId, degradedVersion, "degraded");
            HttpResponse<String> stale = send(port, tenant, token, "POST", ENHANCEMENTS, JSON.writeValueAsString(
                    enhancement("stale-" + run, degradedId, "sha256:" + "2".repeat(64), chain)));
            assertThat(stale.statusCode()).as(stale.body()).isEqualTo(404);
            assertThat(stale.body()).contains("SOURCE_VERSION_NOT_FOUND");
            String otherToken = issueDevToken(tenant, "someone-else-" + run);
            assertThat(send(port, tenant, otherToken, "POST", ENHANCEMENTS, JSON.writeValueAsString(
                    enhancement("foreign-" + run, degradedId, degradedVersion, chain))).statusCode()).isEqualTo(404);
            assertThat(countArtifacts(tenant, principal, "video/mp4")).isEqualTo(uploadedVideos);

            // ---- corrupt inputs: a typed refusal, never a partial output ----
            for (String corruptId : List.of(garbageId, truncatedId)) {
                byte[] corruptBytes = corruptId.equals(garbageId) ? garbage : truncated;
                String corruptVersion = "sha256:" + sha256(corruptBytes);
                attest(port, tenant, token, corruptId, corruptVersion, "corrupt");
                HttpResponse<String> corrupt = send(port, tenant, token, "POST", ENHANCEMENTS, JSON.writeValueAsString(
                        enhancement("corrupt-" + corruptId, corruptId, corruptVersion, chain)));
                assertThat(corrupt.statusCode()).as(corrupt.body()).isEqualTo(422);
                assertThat(corrupt.body()).contains("SOURCE_VIDEO_CORRUPT");
            }
            assertThat(countArtifacts(tenant, principal, "video/mp4")).isEqualTo(uploadedVideos);

            // ---- the enhancement: a NEW artifact version with lineage, timeline and audio verified ----
            Map<String, Object> enhanceBody = enhancement("enh-" + run, degradedId, degradedVersion,
                    List.of(chain.get(2), chain.get(0), chain.get(1))); // out of canonical order on purpose
            long started = System.nanoTime();
            JsonNode enhanced = post(port, tenant, token, ENHANCEMENTS, enhanceBody, 201);
            long enhanceMillis = (System.nanoTime() - started) / 1_000_000;
            String enhancedId = enhanced.path("outputId").asString();
            assertThat(enhancedId).isNotEqualTo(degradedId);
            JsonNode lineage = enhanced.path("lineage");
            assertThat(lineage.path("filterGraph").asString()).isEqualTo(chainGraph);
            assertThat(lineage.path("source").path("sha256").asString()).isEqualTo(sha256(degraded));
            assertThat(lineage.path("source").path("artifactVersionId").asString()).isEqualTo(degradedVersion);
            assertThat(lineage.path("encoder").path("videoCodec").asString()).isEqualTo("libx264");
            assertThat(lineage.path("encoder").path("crf").asInt()).isEqualTo(18);
            assertThat(lineage.path("timeline").path("frameCount").asInt()).isEqualTo(50);
            assertThat(lineage.path("timeline").path("ptsEqualInstants").asBoolean()).isTrue();
            assertThat(lineage.path("audio").path("mode").asString()).isEqualTo("STREAM_COPY");
            assertThat(enhanced.path("admission").path("attestationIds").get(0).asString()).isEqualTo(degradedAttestation);
            StoredArtifact enhancedRow = storedArtifact(POSTGRES, tenant, principal, enhancedId);
            assertThat(enhancedRow.contentType()).isEqualTo("video/mp4");
            byte[] enhancedBytes = s3Bytes(LOCALSTACK, bucket, enhancedRow);
            assertThat(sha256(enhancedBytes)).isEqualTo(enhancedRow.sha256())
                    .isEqualTo(enhanced.path("artifact").path("sha256").asString());
            assertThat(s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, degradedId)))
                    .as("the source video is never modified").isEqualTo(degraded);
            Path enhancedFile = work.resolve("p-enhanced.mp4");
            Files.write(enhancedFile, enhancedBytes);
            VideoEnhancementFixture.Probe enhancedProbe = VideoEnhancementFixture.probe(ffprobe, enhancedFile);
            assertThat(enhancedProbe.pts()).as("ffprobe PTS of every frame equals the source").isEqualTo(degradedProbe.pts());
            assertThat(enhancedProbe.timeBaseDen()).isEqualTo(degradedProbe.timeBaseDen());
            assertThat(enhancedProbe.durationSeconds()).isCloseTo(degradedProbe.durationSeconds(),
                    org.assertj.core.data.Offset.offset(0.001));
            assertThat(enhancedProbe.audioStreams()).isEqualTo(1);
            assertThat(VideoEnhancementFixture.audioMd5(ffmpeg, enhancedFile))
                    .as("audio stream copy is bit-identical").isEqualTo(VideoEnhancementFixture.audioMd5(ffmpeg, degradedFile));
            System.out.println("J08-IT-ENHANCE millis=" + enhanceMillis + " bytes=" + enhancedBytes.length
                    + " sourceBytes=" + degraded.length + " frames=" + enhancedProbe.pts().size()
                    + " timeBase=" + enhancedProbe.timeBaseNum() + "/" + enhancedProbe.timeBaseDen());
            JsonNode replay = post(port, tenant, token, ENHANCEMENTS, enhanceBody, 200);
            assertThat(replay.path("replayed").asBoolean()).isTrue();
            assertThat(replay.path("outputId").asString()).isEqualTo(enhancedId);
            assertThat(send(port, tenant, token, "POST", ENHANCEMENTS, JSON.writeValueAsString(
                    enhancement("enh-" + run, degradedId, degradedVersion, List.of(Map.of("type", "sharpen", "amount", 0.2)))))
                    .statusCode()).as("the same requestId with another graph").isEqualTo(409);

            // ---- the independent measured comparison against the clean reference ----
            String referenceAttestation = attest(port, tenant, token, referenceId, referenceVersion, "reference");
            String enhancedVersion = enhanced.path("artifact").path("artifactVersionId").asString();
            HttpResponse<String> unattested = send(port, tenant, token, "POST", COMPARISONS, JSON.writeValueAsString(
                    comparison("cmp-denied-" + run, referenceId, referenceVersion, degradedId, degradedVersion, enhancedId, enhancedVersion)));
            assertThat(unattested.statusCode()).as("the enhanced output needs its own rights").isEqualTo(403);
            String enhancedAttestation = attest(port, tenant, token, enhancedId, enhancedVersion, "enhanced");
            Map<String, Object> compareBody = comparison("cmp-" + run, referenceId, referenceVersion, degradedId,
                    degradedVersion, enhancedId, enhancedVersion);
            JsonNode compared = post(port, tenant, token, COMPARISONS, compareBody, 201);
            String comparisonId = compared.path("outputId").asString();
            StoredArtifact comparisonRow = storedArtifact(POSTGRES, tenant, principal, comparisonId);
            byte[] comparisonBytes = s3Bytes(LOCALSTACK, bucket, comparisonRow);
            assertThat(sha256(comparisonBytes)).isEqualTo(comparisonRow.sha256());
            JsonNode document = JSON.readTree(new String(comparisonBytes, StandardCharsets.UTF_8));
            JsonNode degradedSubject = document.path("subjects").get(0);
            JsonNode enhancedSubject = document.path("subjects").get(1);
            double degradedPsnr = degradedSubject.path("againstReference").path("meanPsnrY").asDouble();
            double enhancedPsnr = enhancedSubject.path("againstReference").path("meanPsnrY").asDouble();
            double degradedSsim = degradedSubject.path("againstReference").path("meanSsimY").asDouble();
            double enhancedSsim = enhancedSubject.path("againstReference").path("meanSsimY").asDouble();
            JsonNode delta = document.path("comparisons").get(0);
            System.out.println("J08-IT-MEASURED degraded psnr=" + degradedPsnr + " ssim=" + degradedSsim
                    + " noiseSigma=" + degradedSubject.path("noReference").path("meanNoiseSigmaY").asDouble()
                    + " lap=" + degradedSubject.path("noReference").path("meanLaplacianVarianceY").asDouble());
            System.out.println("J08-IT-MEASURED enhanced psnr=" + enhancedPsnr + " ssim=" + enhancedSsim
                    + " noiseSigma=" + enhancedSubject.path("noReference").path("meanNoiseSigmaY").asDouble()
                    + " lap=" + enhancedSubject.path("noReference").path("meanLaplacianVarianceY").asDouble());
            System.out.println("J08-IT-DELTA " + delta);
            assertThat(enhancedPsnr - degradedPsnr).as("PSNR gain vs the clean reference (dB)").isGreaterThanOrEqualTo(3.0);
            assertThat(enhancedSsim - degradedSsim).as("SSIM gain vs the clean reference").isGreaterThanOrEqualTo(0.30);
            assertThat(delta.path("verdict").asString()).isEqualTo("IMPROVED");
            assertThat(delta.path("framesPsnrImproved").asInt()).isEqualTo(50);
            assertThat(delta.path("framesPsnrRegressed").asInt()).isZero();
            assertThat(degradedSubject.path("againstReference").path("fullyAligned").asBoolean()).isTrue();
            assertThat(degradedSubject.path("frames").size()).isEqualTo(50);
            for (int i = 0; i < 50; i++) {
                assertThat(degradedSubject.path("frames").get(i).path("pts").asLong()).isEqualTo(degradedProbe.pts().get(i));
                assertThat(enhancedSubject.path("frames").get(i).path("pts").asLong()).isEqualTo(enhancedProbe.pts().get(i));
                assertThat(enhancedSubject.path("frames").get(i).path("psnrY").asDouble())
                        .isGreaterThan(degradedSubject.path("frames").get(i).path("psnrY").asDouble());
            }
            // No-reference estimates agree in direction: less noise, lower Laplacian energy after enhancement.
            assertThat(enhancedSubject.path("noReference").path("meanNoiseSigmaY").asDouble())
                    .isLessThan(degradedSubject.path("noReference").path("meanNoiseSigmaY").asDouble());
            // The Java metrics agree with FFmpeg's own psnr/ssim filters (luma, whole clip).
            double ffDegraded = VideoEnhancementFixture.ffmpegPsnrY(ffmpeg, degradedFile, referenceFile);
            double ffEnhanced = VideoEnhancementFixture.ffmpegPsnrY(ffmpeg, enhancedFile, referenceFile);
            double ffSsimDegraded = VideoEnhancementFixture.ffmpegSsimY(ffmpeg, degradedFile, referenceFile);
            double ffSsimEnhanced = VideoEnhancementFixture.ffmpegSsimY(ffmpeg, enhancedFile, referenceFile);
            System.out.println("J08-IT-FFMPEG degraded psnr=" + ffDegraded + " ssim=" + ffSsimDegraded + " enhanced psnr="
                    + ffEnhanced + " ssim=" + ffSsimEnhanced);
            assertThat(degradedPsnr).isCloseTo(ffDegraded, org.assertj.core.data.Offset.offset(0.25));
            assertThat(enhancedPsnr).isCloseTo(ffEnhanced, org.assertj.core.data.Offset.offset(0.25));
            assertThat(degradedSsim).isCloseTo(ffSsimDegraded, org.assertj.core.data.Offset.offset(0.02));
            assertThat(enhancedSsim).isCloseTo(ffSsimEnhanced, org.assertj.core.data.Offset.offset(0.02));
            // Honest regression: the swapped comparison is reported as REGRESSED, not softened.
            JsonNode swapped = post(port, tenant, token, COMPARISONS, comparison("cmp-swapped-" + run, referenceId,
                    referenceVersion, enhancedId, enhancedVersion, degradedId, degradedVersion), 201);
            JsonNode swappedDelta = JSON.readTree(new String(s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant,
                    principal, swapped.path("outputId").asString())), StandardCharsets.UTF_8)).path("comparisons").get(0);
            assertThat(swappedDelta.path("verdict").asString()).isEqualTo("REGRESSED");
            assertThat(swappedDelta.path("framesPsnrRegressed").asInt()).isEqualTo(50);
            // No-reference comparison.
            JsonNode noReference = post(port, tenant, token, COMPARISONS, Map.of("requestId", "cmp-nr-" + run,
                    "subjects", List.of(subject("degraded", degradedId, degradedVersion), subject("enhanced", enhancedId, enhancedVersion))), 201);
            assertThat(noReference.path("lineage").path("summary").path("comparisons").get(0).path("verdict").asString())
                    .isEqualTo("NO_REFERENCE");
            // A corrupt subject is a typed refusal.
            HttpResponse<String> corruptCompare = send(port, tenant, token, "POST", COMPARISONS, JSON.writeValueAsString(
                    Map.of("requestId", "cmp-corrupt-" + run, "reference", Map.of("artifactId", referenceId, "artifactVersionId", referenceVersion),
                            "subjects", List.of(subject("garbage", garbageId, "sha256:" + sha256(garbage))))));
            assertThat(corruptCompare.statusCode()).as(corruptCompare.body()).isEqualTo(422);
            assertThat(corruptCompare.body()).contains("SOURCE_VIDEO_CORRUPT");
            int mp4sBeforeBrowser = countArtifacts(tenant, principal, "video/mp4");
            int jsonBeforeBrowser = countArtifacts(tenant, principal, "application/json");

            // ---- real Chromium on the Explorer page, launcher restart, reopen, revocation ----
            Path repoRoot = findMediaRepoRoot();
            Path browserScript = repoRoot.resolve("apps/media-experience-explorer/test/dev-video-comparison-live-browser.mjs");
            assertThat(browserScript).exists();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            String viteVersion = packageVersion(viteBinary);
            assertThat(viteVersion).isIn("7.3.1", "8.3.0");
            ProcessBuilder builder = new ProcessBuilder("node", browserScript.toString());
            builder.directory(repoRoot.toFile());
            builder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            Map<String, String> env = builder.environment();
            env.put("MEDIA_DEV_VIDEO_BROWSER_TOKEN", token);
            env.put("MEDIA_DEV_VIDEO_BROWSER_REFERENCE_ID", referenceId);
            env.put("MEDIA_DEV_VIDEO_BROWSER_REFERENCE_SHA256", sha256(reference));
            env.put("MEDIA_DEV_VIDEO_BROWSER_DEGRADED_ID", degradedId);
            env.put("MEDIA_DEV_VIDEO_BROWSER_DEGRADED_SHA256", sha256(degraded));
            env.put("MEDIA_DEV_VIDEO_BROWSER_ENHANCED_ID", enhancedId);
            env.put("MEDIA_DEV_VIDEO_BROWSER_ENHANCED_SHA256", sha256(enhancedBytes));
            env.put("MEDIA_DEV_VIDEO_BROWSER_VITE_PORT", Integer.toString(vitePort));
            env.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(port));
            env.put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            env.put("MEDIA_DEV_VITE_VERSION", viteVersion);
            env.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            browser = builder.start();
            String browserOutputId;
            try (BufferedReader output = new BufferedReader(new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8));
                    BufferedWriter input = new BufferedWriter(new OutputStreamWriter(browser.getOutputStream(), StandardCharsets.UTF_8))) {
                // The page's own numbers go through the same host; skip the diagnostic event the script prints.
                JsonNode created = readBrowserEvent(browser, output, "created", log, 900);
                System.out.println("J08-BROWSER-CREATED " + created);
                browserOutputId = created.path("outputId").asString();
                StoredArtifact browserRow = storedArtifact(POSTGRES, tenant, principal, browserOutputId);
                assertThat(browserRow.sha256()).isEqualTo(created.path("outputSha").asString());
                assertThat(sha256(s3Bytes(LOCALSTACK, bucket, browserRow))).isEqualTo(created.path("outputSha").asString());
                assertThat(created.path("meanPsnr").get(1).asDouble() - created.path("meanPsnr").get(0).asDouble())
                        .isGreaterThanOrEqualTo(3.0);
                assertThat(countArtifacts(tenant, principal, "application/json")).as("the page registered one comparison")
                        .isEqualTo(jsonBeforeBrowser + 1);
                assertThat(countArtifacts(tenant, principal, "video/mp4")).isEqualTo(mp4sBeforeBrowser);

                stopLauncher(launcher);
                launcher = startLauncher(classpath, environment, log);
                awaitReady(launcher, port);
                input.write("host-restarted " + issueDevToken(tenant, principal) + "\n");
                input.flush();
                JsonNode readback = readBrowserEvent(browser, output, "readback", log, 180);
                assertThat(readback.path("outputId").asString()).isEqualTo(browserOutputId);
                assertThat(readback.path("outputSha").asString()).isEqualTo(created.path("outputSha").asString());

                token = issueDevToken(tenant, principal);
                HttpResponse<String> revoked = send(port, tenant, token, "POST",
                        "/dev/v1/rights/attestations/" + enhancedAttestation + "/revoke",
                        JSON.writeValueAsString(Map.of("reason", "TEST: revoked to prove fail-closed")));
                assertThat(revoked.statusCode()).as(revoked.body()).isEqualTo(200);
                input.write("rights-revoked\n");
                input.flush();
                readBrowserEvent(browser, output, "denied", log, 180);
                assertThat(browser.waitFor(120, TimeUnit.SECONDS)).isTrue();
                assertThat(browser.exitValue()).as("live browser script must pass; see " + log).isZero();
                assertThat(countArtifacts(tenant, principal, "application/json"))
                        .as("the denied request registered nothing").isEqualTo(jsonBeforeBrowser + 1);
            }
            browser = null;

            // ---- restart readback of the HTTP-created enhancement and comparison ----
            JsonNode reopened = get(port, tenant, token, ENHANCEMENTS + "/" + enhancedId, 200);
            assertThat(reopened.path("artifact").path("sha256").asString()).isEqualTo(enhancedRow.sha256());
            assertThat(reopened.path("lineage").path("filterGraph").asString()).isEqualTo(chainGraph);
            assertThat(reopened.path("lineage").path("source").path("artifactVersionId").asString()).isEqualTo(degradedVersion);
            assertThat(s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, enhancedId)))
                    .isEqualTo(enhancedBytes);
            assertThat(get(port, tenant, token, COMPARISONS + "/" + comparisonId, 200).path("artifact").path("sha256")
                    .asString()).isEqualTo(comparisonRow.sha256());
            // Revoked enhanced version: even a replay of its comparison is refused (rights are re-resolved every call).
            HttpResponse<String> replayRevoked = send(port, tenant, token, "POST", COMPARISONS, JSON.writeValueAsString(compareBody));
            assertThat(replayRevoked.statusCode()).as(replayRevoked.body()).isEqualTo(403);
            assertThat(replayRevoked.body()).contains("RIGHTS_REVOKED");

            // ---- the real FFmpeg encode process is killed mid-run: UNKNOWN, then exactly one registration on retry ----
            int mp4sBeforeKill = countArtifacts(tenant, principal, "video/mp4");
            Map<String, Object> killBody = enhancement("kill-" + run, degradedId, degradedVersion,
                    List.of(Map.of("type", "denoise", "method", "nlmeans", "strength", 6)));
            final String killToken = token;
            final int killPort = port;
            final String killTenant = tenant;
            final Process killLauncher = launcher;
            CompletableFuture<HttpResponse<String>> inFlight = CompletableFuture.supplyAsync(() -> {
                try {
                    return send(killPort, killTenant, killToken, "POST", ENHANCEMENTS, JSON.writeValueAsString(killBody));
                } catch (Exception failure) {
                    throw new IllegalStateException(failure);
                }
            });
            ProcessHandle encoder = null;
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(90);
            while (encoder == null && System.nanoTime() < deadline) {
                encoder = killLauncher.toHandle().descendants()
                        .filter(handle -> handle.info().arguments().map(args -> List.of(args).contains("libx264")).orElse(false))
                        .findFirst().orElse(null);
                if (encoder == null) Thread.sleep(20);
            }
            assertThat(encoder).as("the FFmpeg encode child of the launcher must be observed running").isNotNull();
            assertThat(inFlight.isDone()).as("the encode must still be running when it is killed").isFalse();
            encoder.destroyForcibly();
            HttpResponse<String> unknown = inFlight.get(10, TimeUnit.MINUTES);
            System.out.println("J08-IT-KILL " + unknown.statusCode() + " " + unknown.body());
            assertThat(unknown.statusCode()).as(unknown.body()).isEqualTo(503);
            assertThat(unknown.body()).contains("VIDEO_OUTCOME_UNKNOWN").contains("\"outcome\":\"UNKNOWN\"");
            assertThat(countArtifacts(tenant, principal, "video/mp4")).as("nothing was registered by the killed run")
                    .isEqualTo(mp4sBeforeKill);
            JsonNode retried = post(port, tenant, token, ENHANCEMENTS, killBody, 201);
            assertThat(retried.path("replayed").asBoolean()).isFalse();
            JsonNode again = post(port, tenant, token, ENHANCEMENTS, killBody, 200);
            assertThat(again.path("replayed").asBoolean()).isTrue();
            assertThat(again.path("outputId").asString()).isEqualTo(retried.path("outputId").asString());
            assertThat(countArtifacts(tenant, principal, "video/mp4"))
                    .as("exactly one new output from the unknown-then-retried request").isEqualTo(mp4sBeforeKill + 1);
            // The retried output obeys the same verification: identical PTS to the source.
            Path retriedFile = work.resolve("p-retried.mp4");
            Files.write(retriedFile, s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal,
                    retried.path("outputId").asString())));
            assertThat(VideoEnhancementFixture.probe(ffprobe, retriedFile).pts()).isEqualTo(degradedProbe.pts());

            // ---- the durable ledger survives a restart: a completed request replays without running FFmpeg again ----
            stopLauncher(launcher);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            token = issueDevToken(tenant, principal);
            long replayStarted = System.nanoTime();
            JsonNode afterRestart = post(port, tenant, token, ENHANCEMENTS, killBody, 200);
            assertThat(afterRestart.path("outputId").asString()).isEqualTo(retried.path("outputId").asString());
            assertThat(afterRestart.path("replayed").asBoolean()).isTrue();
            System.out.println("J08-IT-REPLAY-AFTER-RESTART millis=" + (System.nanoTime() - replayStarted) / 1_000_000);

            // ---- rights revoked on the exact source: a new enhancement and a replay are both refused ----
            HttpResponse<String> revokeSource = send(port, tenant, token, "POST",
                    "/dev/v1/rights/attestations/" + degradedAttestation + "/revoke",
                    JSON.writeValueAsString(Map.of("reason", "TEST: revoked to prove fail-closed")));
            assertThat(revokeSource.statusCode()).as(revokeSource.body()).isEqualTo(200);
            HttpResponse<String> afterRevoke = send(port, tenant, token, "POST", ENHANCEMENTS, JSON.writeValueAsString(
                    enhancement("after-revoke-" + run, degradedId, degradedVersion, chain)));
            assertThat(afterRevoke.statusCode()).as(afterRevoke.body()).isEqualTo(403);
            assertThat(afterRevoke.body()).contains("RIGHTS_REVOKED");
            HttpResponse<String> replayAfterRevoke = send(port, tenant, token, "POST", ENHANCEMENTS, JSON.writeValueAsString(killBody));
            assertThat(replayAfterRevoke.statusCode()).as(replayAfterRevoke.body()).isEqualTo(403);
            assertThat(countArtifacts(tenant, principal, "video/mp4")).isEqualTo(mp4sBeforeKill + 1);
            assertThat(referenceAttestation).isNotBlank();
            passed = true;
        } finally {
            if (browser != null && browser.isAlive()) stopProcessTree(browser);
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            deleteTree(services);
            deleteTree(work);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("Video enhancement live failure log retained at " + log);
        }
    }

    private static Map<String, Object> enhancement(String requestId, String artifactId, String version,
                                                   List<Map<String, Object>> operations) {
        Map<String, Object> body = new HashMap<>();
        body.put("requestId", requestId);
        body.put("artifactId", artifactId);
        body.put("artifactVersionId", version);
        body.put("operations", operations);
        body.put("encoder", Map.of("crf", 18));
        return body;
    }

    private static Map<String, Object> subject(String label, String artifactId, String version) {
        return Map.of("label", label, "artifactId", artifactId, "artifactVersionId", version);
    }

    private static Map<String, Object> comparison(String requestId, String referenceId, String referenceVersion,
                                                  String baselineId, String baselineVersion, String candidateId,
                                                  String candidateVersion) {
        String baselineLabel = baselineId.equals(candidateId) ? "baseline" : "degraded";
        Map<String, Object> body = new HashMap<>();
        body.put("requestId", requestId);
        body.put("reference", Map.of("artifactId", referenceId, "artifactVersionId", referenceVersion));
        body.put("subjects", List.of(subject(baselineLabel, baselineId, baselineVersion),
                subject("enhanced", candidateId, candidateVersion)));
        return body;
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

    private static JsonNode readBrowserEvent(Process browser, BufferedReader output, String expectedEvent, Path log,
                                             int seconds) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        while (true) {
            FutureTask<String> lineTask = new FutureTask<>(output::readLine);
            Thread reader = new Thread(lineTask, "media-dev-video-live-browser-output");
            reader.setDaemon(true);
            reader.start();
            String line;
            try {
                line = lineTask.get(Math.max(1, TimeUnit.NANOSECONDS.toSeconds(deadline - System.nanoTime())), TimeUnit.SECONDS);
            } catch (java.util.concurrent.TimeoutException timeout) {
                stopProcessTree(browser);
                throw new AssertionError("Timed out waiting for browser event " + expectedEvent + "; log="
                        + (Files.exists(log) ? Files.readString(log) : "<no log>"), timeout);
            }
            String state = browser.isAlive() ? "still-running" : "exit=" + browser.exitValue();
            assertThat(line).as("browser event " + expectedEvent + "; process=" + state + "; log="
                    + (Files.exists(log) ? Files.readString(log) : "<no log>")).isNotNull();
            JsonNode event = JSON.readTree(line);
            if ("browser-noise".equals(event.path("event").asString()) && !"browser-noise".equals(expectedEvent)) {
                System.out.println("J08-BROWSER-NOISE " + event);
                continue;
            }
            assertThat(event.path("event").asString()).isEqualTo(expectedEvent);
            return event;
        }
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
