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
import static org.assertj.core.data.Offset.offset;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-19 `media.dev.outcome-bounded-quality-improvement` against REAL processes: the real launcher with the durable
 * PostgreSQL + S3 artifact store, the durable request ledger and the V041 head ledger (Testcontainers), real FFmpeg
 * encodes of an FFmpeg-generated noisy video, real Chromium on the Explorer page. Covers: every reported attempt
 * re-encoded independently (byte-identical) and measured with FFmpeg's own ssim/psnr filters, a deterministic report
 * and chosen video that are byte-identical across two runs AND a launcher restart, a typed abstention, undo that
 * restores the previous head across a restart, wrong tenant/principal 404, missing and revoked rights 403 (replay
 * included), invalid bounds 422, a concurrent duplicate request, cancellation of the real FFmpeg child mid-search, a
 * SIGKILLed encode (UNKNOWN, then exactly one registration), and the durable head rows read back from PostgreSQL.
 * Missing runtime prerequisites FAIL the test.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevQualityOptimizationIT {
    private static final String OPTIMIZATIONS = "/dev/v1/quality/optimizations";
    private static final String LINEAGES = "/dev/v1/quality/lineages/";

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void realLauncherSearchesQualityBoundsDeterministicallyAndUndoesAcrossRestartWithBrowserCancellationAndKilledEncode()
            throws Exception {
        String ffmpegEnv = System.getenv("MEDIA_DEV_RENDER_FFMPEG");
        String ffprobeEnv = System.getenv("MEDIA_DEV_RENDER_FFPROBE");
        assertThat(ffmpegEnv).as("MEDIA_DEV_RENDER_FFMPEG").isNotBlank();
        assertThat(ffprobeEnv).as("MEDIA_DEV_RENDER_FFPROBE").isNotBlank();
        Path ffmpeg = Path.of(ffmpegEnv);
        Path ffprobe = Path.of(ffprobeEnv);

        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-quality-" + run;
        String principal = "media-dev-quality-" + run;
        String bucket = "media-dev-quality-" + run;
        String schema = "media_dev_quality_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        int vitePort;
        try (var socket = new java.net.ServerSocket(0)) { vitePort = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-quality-services-");
        Path work = Files.createTempDirectory("media-dev-quality-work-");
        Path log = Files.createTempFile("media-dev-quality-process-", ".log");
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
            environment.put("MEDIA_DEV_ERASURE_ENABLED", "true");
            environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg.toString());
            environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe.toString());
            environment.put("MEDIA_MAX_BODY_BYTES", Integer.toString(16 * 1024 * 1024));
            environment.put("MEDIA_MAX_CHUNK_BYTES", Integer.toString(16 * 1024 * 1024));
            String token = issueDevToken(tenant, principal);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            // ---- real input: an FFmpeg-generated noisy source so CRF changes quality and size a lot ----
            byte[] source = QualityOptimizationFixture.noisySource(ffmpeg, work);
            Path sourceFile = work.resolve("p-source.mp4");
            Files.write(sourceFile, source);
            String sourceId = upload(port, tenant, principal, token, run + "-src", "source.mp4", "video/mp4", source);
            String sourceVersion = "sha256:" + sha256(source);
            int uploadedVideos = countArtifacts(tenant, principal, "video/mp4");
            assertThat(uploadedVideos).isEqualTo(1);

            // ---- rights missing: refused, nothing read, encoded or registered ----
            Map<String, Object> request = request("opt-" + run, "lin-" + run, sourceId, sourceVersion,
                    minBytes("ssim", 0.90), 16, 40, 6);
            HttpResponse<String> noRights = send(port, tenant, token, "POST", OPTIMIZATIONS, JSON.writeValueAsString(request));
            assertThat(noRights.statusCode()).as(noRights.body()).isEqualTo(403);
            assertThat(noRights.body()).contains("RIGHTS_DENIED");
            assertThat(countArtifacts(tenant, principal, "video/mp4")).isEqualTo(uploadedVideos);

            // ---- invalid bounds: 422 before the source is even looked up ----
            List<Map<String, Object>> invalid = List.of(
                    request("bad-1", "lin-bad", "x", sourceVersion, minBytes("ssim", 1.5), 16, 40, 6),
                    request("bad-2", "lin-bad", "x", sourceVersion, minBytes("psnr", 5.0), 16, 40, 6),
                    request("bad-3", "lin-bad", "x", sourceVersion, maxBytes("psnr", 10), 16, 40, 6),
                    request("bad-4", "lin-bad", "x", sourceVersion, minBytes("ssim", 0.9), 5, 40, 6),
                    request("bad-5", "lin-bad", "x", sourceVersion, minBytes("ssim", 0.9), 30, 20, 6),
                    request("bad-6", "lin-bad", "x", sourceVersion, minBytes("ssim", 0.9), 16, 40, 0),
                    request("bad-7", "lin-bad", "x", sourceVersion, minBytes("ssim", 0.9), 16, 40, 9),
                    request("bad-8", "lin bad", "x", sourceVersion, minBytes("ssim", 0.9), 16, 40, 6));
            for (Map<String, Object> bad : invalid) {
                HttpResponse<String> refused = send(port, tenant, token, "POST", OPTIMIZATIONS, JSON.writeValueAsString(bad));
                assertThat(refused.statusCode()).as(bad + " " + refused.body()).isEqualTo(422);
                assertThat(refused.body()).contains("QUALITY_PARAMETER_OUT_OF_RANGE");
            }

            // ---- rights granted for the exact version; stale, foreign principal and foreign tenant are 404 ----
            String attestation = attest(port, tenant, token, sourceId, sourceVersion);
            HttpResponse<String> stale = send(port, tenant, token, "POST", OPTIMIZATIONS, JSON.writeValueAsString(
                    request("stale-" + run, "lin-stale", sourceId, "sha256:" + "2".repeat(64), minBytes("ssim", 0.9), 16, 40, 4)));
            assertThat(stale.statusCode()).as(stale.body()).isEqualTo(404);
            assertThat(stale.body()).contains("SOURCE_VERSION_NOT_FOUND");
            String otherPrincipalToken = issueDevToken(tenant, "someone-else-" + run);
            assertThat(send(port, tenant, otherPrincipalToken, "POST", OPTIMIZATIONS, JSON.writeValueAsString(request)).statusCode())
                    .isEqualTo(404);
            String otherTenant = tenant + "-other";
            String otherTenantToken = issueDevToken(otherTenant, principal);
            HttpResponse<String> foreignTenant = send(port, otherTenant, otherTenantToken, "POST", OPTIMIZATIONS,
                    JSON.writeValueAsString(request));
            assertThat(foreignTenant.statusCode()).as(foreignTenant.body()).isEqualTo(404);
            assertThat(foreignTenant.body()).contains("SOURCE_VERSION_NOT_FOUND");
            assertThat(send(port, otherTenant, otherTenantToken, "GET", LINEAGES + "lin-" + run, null).statusCode()).isEqualTo(404);
            assertThat(countArtifacts(tenant, principal, "video/mp4")).isEqualTo(uploadedVideos);

            // ---- the optimization: real encodes, measured, a NEW immutable version, source untouched ----
            long started = System.nanoTime();
            JsonNode created = post(port, tenant, token, OPTIMIZATIONS, request, 201);
            long searchMillis = (System.nanoTime() - started) / 1_000_000;
            System.out.println("J19-IT-SEARCH millis=" + searchMillis + " attempts=" + created.path("report").path("attempts").size());
            assertThat(created.path("outcome").asString()).isEqualTo("SELECTED");
            JsonNode report = created.path("report");
            JsonNode attempts = report.path("attempts");
            assertThat(attempts.size()).isBetween(2, 6);
            int chosenIndex = report.path("chosenAttempt").asInt();
            JsonNode chosenAttempt = attempts.get(chosenIndex - 1);
            assertThat(chosenAttempt.path("feasible").asBoolean()).isTrue();
            assertThat(chosenAttempt.path("meanSsimY").asDouble()).isGreaterThanOrEqualTo(0.90);
            assertThat(chosenAttempt.path("bytes").asLong()).isLessThan(source.length);
            for (JsonNode attempt : attempts) {
                if (attempt.path("feasible").asBoolean()) {
                    assertThat(attempt.path("bytes").asLong()).isGreaterThanOrEqualTo(chosenAttempt.path("bytes").asLong());
                } else {
                    assertThat(attempt.path("meanSsimY").asDouble() < 0.90 || attempt.path("bytes").asLong() >= source.length).isTrue();
                }
            }
            // Independent verification of every attempt against the real encoder and FFmpeg's own metrics.
            String comment = QualityOptimizationFixture.containerComment(tenant, principal, "opt-" + run);
            Map<Integer, byte[]> independentByCrf = new HashMap<>();
            for (JsonNode attempt : attempts) {
                int crf = attempt.path("crf").asInt();
                byte[] independent = QualityOptimizationFixture.independentEncode(ffmpeg, work, sourceFile, crf, comment);
                independentByCrf.put(crf, independent);
                Path encoded = work.resolve("p-attempt-" + crf + ".mp4");
                Files.write(encoded, independent);
                assertThat(QualityOptimizationFixture.streamSha256(ffmpeg, encoded))
                        .as("attempt crf %d is a real reproducible encode", crf).isEqualTo(attempt.path("videoStreamSha256").asString());
                assertThat((long) independent.length).isEqualTo(attempt.path("bytes").asLong());
                assertThat(attempt.path("globalPsnrY").asDouble()).isCloseTo(
                        VideoEnhancementFixture.ffmpegPsnrY(ffmpeg, encoded, sourceFile), offset(0.3));
                assertThat(attempt.path("meanSsimY").asDouble()).isCloseTo(
                        VideoEnhancementFixture.ffmpegSsimY(ffmpeg, encoded, sourceFile), offset(0.02));
            }
            String chosenId = created.path("chosen").path("artifactId").asString();
            String chosenVersion = created.path("chosen").path("artifactVersionId").asString();
            String reportId = created.path("reportArtifact").path("artifactId").asString();
            String reportSha = created.path("reportSha256").asString();
            String chosenSha = created.path("chosen").path("sha256").asString();
            String chosenStream = chosenAttempt.path("videoStreamSha256").asString();
            assertThat(chosenSha).as("the registered file is exactly the independent encode")
                    .isEqualTo(sha256(independentByCrf.get(chosenAttempt.path("crf").asInt())));
            assertThat(chosenId).isNotEqualTo(sourceId);
            StoredArtifact chosenRow = storedArtifact(POSTGRES, tenant, principal, chosenId);
            assertThat(chosenRow.contentType()).isEqualTo("video/mp4");
            assertThat(sha256(s3Bytes(LOCALSTACK, bucket, chosenRow))).isEqualTo(chosenSha);
            Path storedChosen = work.resolve("p-stored-chosen.mp4");
            Files.write(storedChosen, s3Bytes(LOCALSTACK, bucket, chosenRow));
            assertThat(QualityOptimizationFixture.streamSha256(ffmpeg, storedChosen))
                    .as("the stored bytes carry exactly the measured video packets").isEqualTo(chosenStream);
            assertThat(s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, sourceId)))
                    .as("the source is untouched").isEqualTo(source);
            // The registered report record carries exactly the report in the response and its canonical digest.
            JsonNode record = JSON.readTree(s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, reportId)));
            assertThat(record.path("report")).isEqualTo(report);
            assertThat(record.path("reportSha256").asString()).isEqualTo(reportSha);
            assertThat(sha256(JSON.writeValueAsBytes(report))).as("the digest is of the canonical report bytes").isEqualTo(reportSha);
            assertThat(record.path("requestId").asString()).isEqualTo("opt-" + run);
            assertThat(headKinds(tenant, "lin-" + run)).containsExactly("BASE", "APPLY");
            assertThat(created.path("lineage").path("head").path("artifactVersionId").asString()).isEqualTo(chosenVersion);

            // ---- replay and conflict ----
            JsonNode replay = post(port, tenant, token, OPTIMIZATIONS, request, 200);
            assertThat(replay.path("replayed").asBoolean()).isTrue();
            assertThat(replay.path("reportArtifact").path("artifactId").asString()).isEqualTo(reportId);
            assertThat(replay.path("report")).isEqualTo(report);
            Map<String, Object> reused = new HashMap<>(request);
            reused.put("target", minBytes("ssim", 0.92));
            HttpResponse<String> reusedResponse = send(port, tenant, token, "POST", OPTIMIZATIONS, JSON.writeValueAsString(reused));
            assertThat(reusedResponse.statusCode()).as(reusedResponse.body()).isEqualTo(409);
            assertThat(reusedResponse.body()).contains("QUALITY_REQUEST_ID_REUSED");
            HttpResponse<String> moved = send(port, tenant, token, "POST", OPTIMIZATIONS, JSON.writeValueAsString(
                    request("moved-" + run, "lin-" + run, sourceId, sourceVersion, minBytes("ssim", 0.90), 16, 40, 6)));
            assertThat(moved.statusCode()).as(moved.body()).isEqualTo(409);
            assertThat(moved.body()).contains("LINEAGE_HEAD_MOVED").contains(chosenVersion);

            // ---- a concurrent duplicate: exactly one search registers, the other replays or waits ----
            Map<String, Object> dup = request("dup-" + run, "lin-dup-" + run, sourceId, sourceVersion,
                    minBytes("ssim", 0.90), 16, 40, 4);
            int mp4sBeforeDup = countArtifacts(tenant, principal, "video/mp4");
            final String dupToken = token;
            final int dupPort = port;
            List<CompletableFuture<HttpResponse<String>>> pair = new ArrayList<>();
            for (int i = 0; i < 2; i++) {
                pair.add(CompletableFuture.supplyAsync(() -> {
                    try { return send(dupPort, tenant, dupToken, "POST", OPTIMIZATIONS, JSON.writeValueAsString(dup)); }
                    catch (Exception failure) { throw new IllegalStateException(failure); }
                }));
            }
            List<Integer> statuses = new ArrayList<>();
            for (var future : pair) {
                HttpResponse<String> response = future.get(10, TimeUnit.MINUTES);
                statuses.add(response.statusCode());
                assertThat(response.statusCode()).as(response.body()).isIn(200, 201, 409);
                if (response.statusCode() == 409) assertThat(response.body()).contains("REQUEST_IN_PROGRESS");
            }
            assertThat(statuses).contains(201);
            assertThat(countArtifacts(tenant, principal, "video/mp4")).as("one chosen video for the duplicated request")
                    .isEqualTo(mp4sBeforeDup + 1);
            assertThat(headKinds(tenant, "lin-dup-" + run)).containsExactly("BASE", "APPLY");
            JsonNode dupReplay = post(port, tenant, token, OPTIMIZATIONS, dup, 200);
            assertThat(dupReplay.path("replayed").asBoolean()).isTrue();

            // ---- undo restores the exact previous head ----
            Map<String, Object> staleUndo = Map.of("requestId", "undo-stale-" + run, "expectedHeadArtifactVersionId", sourceVersion);
            HttpResponse<String> staleUndoResponse = send(port, tenant, token, "POST", LINEAGES + "lin-" + run + "/undo",
                    JSON.writeValueAsString(staleUndo));
            assertThat(staleUndoResponse.statusCode()).as(staleUndoResponse.body()).isEqualTo(409);
            JsonNode undone = post(port, tenant, token, LINEAGES + "lin-" + run + "/undo",
                    Map.of("requestId", "undo-" + run, "expectedHeadArtifactVersionId", chosenVersion), 201);
            assertThat(undone.path("head").path("artifactId").asString()).isEqualTo(sourceId);
            assertThat(undone.path("head").path("artifactVersionId").asString()).isEqualTo(sourceVersion);
            assertThat(headKinds(tenant, "lin-" + run)).containsExactly("BASE", "APPLY", "UNDO");
            assertThat(s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, chosenId)))
                    .as("the undone version is kept, immutable").hasSize(chosenAttempt.path("bytes").asInt());

            // ---- abstention: a typed outcome, no chosen version, no lineage ----
            int mp4sBeforeAbstain = countArtifacts(tenant, principal, "video/mp4");
            JsonNode abstained = post(port, tenant, token, OPTIMIZATIONS, request("abstain-" + run, "lin-abstain-" + run,
                    sourceId, sourceVersion, minBytes("ssim", 0.9999), 30, 40, 6), 201);
            assertThat(abstained.path("outcome").asString()).isEqualTo("ABSTAINED");
            assertThat(abstained.path("chosen").isNull()).isTrue();
            assertThat(abstained.path("report").path("abstainReason").asString()).isEqualTo("NO_ATTEMPT_MET_TARGET");
            for (JsonNode attempt : abstained.path("report").path("attempts")) {
                assertThat(attempt.path("feasible").asBoolean()).isFalse();
            }
            assertThat(countArtifacts(tenant, principal, "video/mp4")).as("an abstention registers no video").isEqualTo(mp4sBeforeAbstain);
            assertThat(headKinds(tenant, "lin-abstain-" + run)).isEmpty();
            assertThat(send(port, tenant, token, "GET", LINEAGES + "lin-abstain-" + run, null).statusCode()).isEqualTo(404);

            // ---- cancellation mid-search: the real FFmpeg child is killed, nothing registered ----
            int mp4sBeforeCancel = countArtifacts(tenant, principal, "video/mp4");
            int jsonBeforeCancel = countArtifacts(tenant, principal, "application/json");
            Map<String, Object> cancelRequest = request("cancel-" + run, "lin-cancel-" + run, sourceId, sourceVersion,
                    minBytes("ssim", 0.90), 16, 40, 6);
            CompletableFuture<HttpResponse<String>> inFlight = background(port, tenant, token, cancelRequest);
            ProcessHandle encoder = awaitEncoder(launcher);
            assertThat(encoder).as("the FFmpeg encode child of the launcher must be observed running").isNotNull();
            assertThat(inFlight.isDone()).isFalse();
            HttpResponse<String> cancel = send(port, tenant, token, "POST", OPTIMIZATIONS + "/cancel-" + run + "/cancel", "{}");
            assertThat(cancel.statusCode()).as(cancel.body()).isEqualTo(200);
            HttpResponse<String> cancelled = inFlight.get(2, TimeUnit.MINUTES);
            assertThat(cancelled.statusCode()).as(cancelled.body()).isEqualTo(409);
            assertThat(cancelled.body()).contains("OPTIMIZATION_CANCELLED");
            Thread.sleep(300);
            assertThat(encoder.isAlive()).as("the cancelled encode process is gone").isFalse();
            assertThat(countArtifacts(tenant, principal, "video/mp4")).isEqualTo(mp4sBeforeCancel);
            assertThat(countArtifacts(tenant, principal, "application/json")).isEqualTo(jsonBeforeCancel);
            assertThat(headKinds(tenant, "lin-cancel-" + run)).isEmpty();
            JsonNode afterCancel = post(port, tenant, token, OPTIMIZATIONS, cancelRequest, 201);
            assertThat(afterCancel.path("outcome").asString()).isEqualTo("SELECTED");
            assertThat(countArtifacts(tenant, principal, "video/mp4")).isEqualTo(mp4sBeforeCancel + 1);

            // ---- the encode is SIGKILLed: UNKNOWN, nothing registered, one registration on retry ----
            int mp4sBeforeKill = countArtifacts(tenant, principal, "video/mp4");
            Map<String, Object> killRequest = request("kill-" + run, "lin-kill-" + run, sourceId, sourceVersion,
                    minBytes("ssim", 0.90), 16, 40, 4);
            inFlight = background(port, tenant, token, killRequest);
            ProcessHandle victim = awaitEncoder(launcher);
            assertThat(victim).isNotNull();
            victim.destroyForcibly();
            HttpResponse<String> unknown = inFlight.get(2, TimeUnit.MINUTES);
            assertThat(unknown.statusCode()).as(unknown.body()).isEqualTo(503);
            assertThat(unknown.body()).contains("OPTIMIZATION_OUTCOME_UNKNOWN").contains("\"outcome\":\"UNKNOWN\"");
            assertThat(countArtifacts(tenant, principal, "video/mp4")).isEqualTo(mp4sBeforeKill);
            assertThat(headKinds(tenant, "lin-kill-" + run)).isEmpty();
            assertThat(post(port, tenant, token, OPTIMIZATIONS, killRequest, 201).path("outcome").asString()).isEqualTo("SELECTED");
            assertThat(post(port, tenant, token, OPTIMIZATIONS, killRequest, 200).path("replayed").asBoolean()).isTrue();
            assertThat(countArtifacts(tenant, principal, "video/mp4")).isEqualTo(mp4sBeforeKill + 1);

            // ---- restart #1: replay without running FFmpeg, the undo survived, and a twin run is byte-identical ----
            stopLauncher(launcher);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            token = issueDevToken(tenant, principal);
            long replayStarted = System.nanoTime();
            JsonNode afterRestart = post(port, tenant, token, OPTIMIZATIONS, request, 200);
            System.out.println("J19-IT-REPLAY-AFTER-RESTART millis=" + (System.nanoTime() - replayStarted) / 1_000_000);
            assertThat(afterRestart.path("replayed").asBoolean()).isTrue();
            assertThat(afterRestart.path("reportSha256").asString()).isEqualTo(reportSha);
            assertThat(afterRestart.path("report")).isEqualTo(report);
            JsonNode lineageAfter = get(port, tenant, token, LINEAGES + "lin-" + run, 200);
            assertThat(lineageAfter.path("head").path("artifactVersionId").asString()).isEqualTo(sourceVersion);
            assertThat(lineageAfter.path("events").size()).isEqualTo(3);
            assertThat(get(port, tenant, token, OPTIMIZATIONS + "/" + reportId, 200).path("report")).isEqualTo(report);
            JsonNode twin = post(port, tenant, token, OPTIMIZATIONS, request("twin-" + run, "lin-twin-" + run, sourceId,
                    sourceVersion, minBytes("ssim", 0.90), 16, 40, 6), 201);
            assertThat(twin.path("report")).isEqualTo(report);
            assertThat(twin.path("reportSha256").asString())
                    .as("the report is byte-identical across two runs and a restart").isEqualTo(reportSha);
            assertThat(sha256(JSON.writeValueAsBytes(twin.path("report")))).isEqualTo(reportSha);
            Path twinChosen = work.resolve("p-twin-chosen.mp4");
            Files.write(twinChosen, s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal,
                    twin.path("chosen").path("artifactId").asString())));
            assertThat(QualityOptimizationFixture.streamSha256(ffmpeg, twinChosen))
                    .as("the chosen video packets are byte-identical too").isEqualTo(chosenStream);
            assertThat(twin.path("chosen").path("sha256").asString()).as("distinct stored file, same packets")
                    .isNotEqualTo(chosenSha);
            assertThat(twin.path("reportArtifact").path("artifactId").asString()).isNotEqualTo(reportId);

            // ---- real Chromium on the Explorer page, with a launcher restart in the middle ----
            Path repoRoot = findMediaRepoRoot();
            Path browserScript = repoRoot.resolve("apps/media-experience-explorer/test/dev-quality-optimization-live-browser.mjs");
            assertThat(browserScript).exists();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            String viteVersion = packageVersion(viteBinary);
            assertThat(viteVersion).isIn("7.3.1", "8.3.0");
            ProcessBuilder builder = new ProcessBuilder("node", browserScript.toString());
            builder.directory(repoRoot.toFile());
            builder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            Map<String, String> env = builder.environment();
            env.put("MEDIA_DEV_QUALITY_BROWSER_TOKEN", token);
            env.put("MEDIA_DEV_QUALITY_BROWSER_SOURCE_ID", sourceId);
            env.put("MEDIA_DEV_QUALITY_BROWSER_SOURCE_VERSION", sourceVersion);
            env.put("MEDIA_DEV_QUALITY_BROWSER_VITE_PORT", Integer.toString(vitePort));
            env.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(port));
            env.put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            env.put("MEDIA_DEV_VITE_VERSION", viteVersion);
            env.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            int mp4sBeforeBrowser = countArtifacts(tenant, principal, "video/mp4");
            browser = builder.start();
            String browserLineage;
            try (BufferedReader output = new BufferedReader(new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8));
                    BufferedWriter input = new BufferedWriter(new OutputStreamWriter(browser.getOutputStream(), StandardCharsets.UTF_8))) {
                JsonNode optimized = readBrowserEvent(browser, output, "optimized", log, 900);
                System.out.println("J19-BROWSER-OPTIMIZED " + optimized);
                browserLineage = optimized.path("lineageId").asString();
                assertThat(optimized.path("reportSha").asString()).as("the page ran the same deterministic search").isEqualTo(reportSha);
                assertThat(optimized.path("chosenAttempt").asInt()).isEqualTo(chosenIndex);
                assertThat(headKinds(tenant, browserLineage)).containsExactly("BASE", "APPLY");
                StoredArtifact browserChosen = storedArtifact(POSTGRES, tenant, principal, optimized.path("chosenArtifactId").asString());
                Path browserFile = work.resolve("p-browser-chosen.mp4");
                Files.write(browserFile, s3Bytes(LOCALSTACK, bucket, browserChosen));
                assertThat(QualityOptimizationFixture.streamSha256(ffmpeg, browserFile)).isEqualTo(chosenStream);
                readBrowserEvent(browser, output, "undone", log, 120);
                assertThat(headKinds(tenant, browserLineage)).containsExactly("BASE", "APPLY", "UNDO");
                JsonNode abstainedByPage = readBrowserEvent(browser, output, "abstained", log, 900);
                assertThat(abstainedByPage.path("attempts").asInt()).isPositive();
                JsonNode cancelledByPage = readBrowserEvent(browser, output, "cancelled", log, 900);
                assertThat(headKinds(tenant, cancelledByPage.path("lineageId").asString())).isEmpty();
                assertThat(countArtifacts(tenant, principal, "video/mp4")).as("only the page's chosen video was added")
                        .isEqualTo(mp4sBeforeBrowser + 1);

                stopLauncher(launcher);
                launcher = startLauncher(classpath, environment, log);
                awaitReady(launcher, port);
                input.write("host-restarted " + issueDevToken(tenant, principal) + "\n");
                input.flush();
                readBrowserEvent(browser, output, "readback", log, 180);
                assertThat(browser.waitFor(120, TimeUnit.SECONDS)).isTrue();
                assertThat(browser.exitValue()).as("live browser script must pass; see " + log).isZero();
            }
            browser = null;

            // ---- rights revoked on the exact source: a new search and a replay are both refused ----
            token = issueDevToken(tenant, principal);
            HttpResponse<String> revoke = send(port, tenant, token, "POST", "/dev/v1/rights/attestations/" + attestation + "/revoke",
                    JSON.writeValueAsString(Map.of("reason", "TEST: revoked to prove fail-closed")));
            assertThat(revoke.statusCode()).as(revoke.body()).isEqualTo(200);
            HttpResponse<String> afterRevoke = send(port, tenant, token, "POST", OPTIMIZATIONS, JSON.writeValueAsString(
                    request("after-revoke-" + run, "lin-revoked-" + run, sourceId, sourceVersion, minBytes("ssim", 0.9), 16, 40, 4)));
            assertThat(afterRevoke.statusCode()).as(afterRevoke.body()).isEqualTo(403);
            assertThat(afterRevoke.body()).contains("RIGHTS_REVOKED");
            HttpResponse<String> replayRevoked = send(port, tenant, token, "POST", OPTIMIZATIONS, JSON.writeValueAsString(request));
            assertThat(replayRevoked.statusCode()).as(replayRevoked.body()).isEqualTo(403);
            // Reading the recorded lineage and undoing are not processing: they stay available to the owner.
            assertThat(get(port, tenant, token, LINEAGES + browserLineage, 200).path("head").path("artifactVersionId").asString())
                    .isEqualTo(sourceVersion);

            // ---- erasure of the source drops every derived version, report and head lineage with it ----
            JsonNode plan = get(port, tenant, token, "/dev/v1/erasure-plans/" + sourceId, 200);
            assertThat(plan.path("erasable").asBoolean()).isTrue();
            int treeSize = plan.path("artifacts").size();
            assertThat(treeSize).as("the source plus every chosen video and report").isGreaterThan(8);
            assertThat(headKinds(tenant, "lin-" + run)).isNotEmpty();
            assertThat(headKinds(tenant, browserLineage)).isNotEmpty();
            post(port, tenant, token, "/dev/v1/erasures", Map.of("erasureId", "erase-" + run, "artifactId", sourceId,
                    "confirm", true, "expectedArtifactCount", treeSize), 201);
            for (String lineage : List.of("lin-" + run, "lin-twin-" + run, "lin-dup-" + run, "lin-cancel-" + run,
                    "lin-kill-" + run, browserLineage)) {
                assertThat(headKinds(tenant, lineage)).as("head log of %s is erased with its artifacts", lineage).isEmpty();
                assertThat(send(port, tenant, token, "GET", LINEAGES + lineage, null).statusCode()).isEqualTo(404);
            }
            assertThat(get(port, tenant, token, OPTIMIZATIONS + "/" + reportId, 404).path("error").path("code").asString())
                    .isNotEmpty();
            passed = true;
        } finally {
            if (browser != null && browser.isAlive()) stopProcessTree(browser);
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            deleteTree(services);
            deleteTree(work);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("Quality optimization live failure log retained at " + log);
        }
    }

    private static CompletableFuture<HttpResponse<String>> background(int port, String tenant, String token,
                                                                      Map<String, Object> body) {
        return CompletableFuture.supplyAsync(() -> {
            try {
                return send(port, tenant, token, "POST", OPTIMIZATIONS, JSON.writeValueAsString(body));
            } catch (Exception failure) {
                throw new IllegalStateException(failure);
            }
        });
    }

    /** The libx264 encode child of the launcher, once observed running (the search runs encodes strictly one at a time). */
    private static ProcessHandle awaitEncoder(Process launcher) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(90);
        while (System.nanoTime() < deadline) {
            ProcessHandle encoder = launcher.toHandle().descendants()
                    .filter(handle -> handle.info().arguments().map(args -> List.of(args).contains("libx264")).orElse(false))
                    .findFirst().orElse(null);
            if (encoder != null) return encoder;
            Thread.sleep(20);
        }
        return null;
    }

    private static Map<String, Object> minBytes(String metric, double minQuality) {
        return Map.of("type", "MIN_BYTES_AT_QUALITY", "metric", metric, "minQuality", minQuality);
    }

    private static Map<String, Object> maxBytes(String metric, long maxBytes) {
        return Map.of("type", "MAX_QUALITY_UNDER_BYTES", "metric", metric, "maxBytes", maxBytes);
    }

    private static Map<String, Object> request(String requestId, String lineageId, String artifactId, String version,
                                               Map<String, Object> target, int crfMin, int crfMax, int attempts) {
        Map<String, Object> body = new HashMap<>();
        body.put("requestId", requestId);
        body.put("lineageId", lineageId);
        body.put("artifactId", artifactId);
        body.put("artifactVersionId", version);
        body.put("target", target);
        body.put("search", Map.of("crfMin", crfMin, "crfMax", crfMax, "maxAttempts", attempts));
        return body;
    }

    private static String attest(int port, String tenant, String token, String artifactId, String version) throws Exception {
        HttpResponse<String> attested = send(port, tenant, token, "POST", "/dev/v1/rights/attestations",
                JSON.writeValueAsString(Map.of("artifactId", artifactId, "artifactVersionId", version,
                        "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                        "basis", "TEST: synthetic video generated by the integration test (a statement by a synthetic test principal)")));
        assertThat(attested.statusCode()).as(attested.body()).isEqualTo(201);
        return JSON.readTree(attested.body()).path("attestationId").asString();
    }

    private static List<String> headKinds(String tenant, String lineage) throws Exception {
        List<String> kinds = new ArrayList<>();
        try (var connection = java.sql.DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                var statement = connection.prepareStatement(
                        "SELECT kind FROM media_dev_head_events WHERE tenant_id=? AND lineage_id=? ORDER BY seq")) {
            statement.setString(1, tenant);
            statement.setString(2, lineage);
            try (var rows = statement.executeQuery()) {
                while (rows.next()) kinds.add(rows.getString(1));
            }
        }
        return kinds;
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
            Thread reader = new Thread(lineTask, "media-dev-quality-live-browser-output");
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
                System.out.println("J19-BROWSER-NOISE " + event);
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
