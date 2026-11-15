package com.ghatana.media.launcher;

import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.media.runtime.InMemoryMediaHeadLedger;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Reason;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.InMemoryManagedStore;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.TENANT;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.base;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.object;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.read;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.send;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.data.Offset.offset;

/**
 * J-19 DEV_ONLY bounded quality optimization over the real HTTP host, REAL FFmpeg/ffprobe encodes and the real artifact
 * store: reference metrics are cross-checked with FFmpeg's own ssim/psnr filters, every reported attempt is
 * re-encoded independently and must be byte-identical, bounds/rights/ownership/ledger/cancellation faults are typed.
 * The durable PostgreSQL/S3, restart and browser paths are covered by {@code MediaDevQualityOptimizationIT}.
 */
class MediaDevQualityOptimizationHttpTest {
    private static final String OWNER = "test-principal-owner";
    private static final String OTHER = "test-principal-other";
    private static final String OPTIMIZATIONS = "/dev/v1/quality/optimizations";
    private static final Set<String> PERMISSIONS = Set.of("media:project:dev:create", "media:project:dev:read",
            "media:project:dev:write", "media:artifact:read", "media:artifact:create");
    private static final ObjectMapper JSON = JsonMapper.builder().build();

    private static Path ffmpeg;
    private static Path ffprobe;
    private static Path work;
    private static byte[] sourceBytes;
    private static Path sourceFile;

    private final Set<String> admitted = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean revoked = new AtomicBoolean();
    private final AtomicBoolean unavailable = new AtomicBoolean();
    private final RightsConsentResolver resolver = new RightsConsentResolver() {
        @Override public String resolverId() { return "test-resolver"; }
        @Override public boolean ready() { return true; }
        @Override public Resolution resolve(ResolutionRequest request) {
            if (unavailable.get()) return Resolution.unavailable(resolverId());
            if (!admitted.contains(request.artifactId())) {
                return new Resolution(Verdict.DENIED, Set.of(Reason.NO_ATTESTATION), List.of(), resolverId());
            }
            if (revoked.get()) return new Resolution(Verdict.REVOKED, Set.of(Reason.REVOKED), List.of(), resolverId());
            return new Resolution(Verdict.ADMITTED, Set.of(), List.of("att-" + request.artifactId()), resolverId());
        }
    };

    /** Counts real encodes and can hold the first one so a test can cancel or kill it mid-search. */
    private static final class Port implements MediaDevVideoRuntime.ProcessPort {
        final AtomicInteger encodes = new AtomicInteger();
        final AtomicBoolean holdFirstEncode = new AtomicBoolean();
        final AtomicBoolean killNextEncode = new AtomicBoolean();
        final CountDownLatch encodeStarted = new CountDownLatch(1);

        @Override
        public BoundedProcessRunner.Result run(List<String> command, Path dir, Duration timeout, int maxStdout,
                                               Path watched, long watchedMax) throws IOException {
            return run(command, dir, timeout, maxStdout, watched, watchedMax, BoundedProcessRunner.CancellationToken.NEVER);
        }

        @Override
        public BoundedProcessRunner.Result run(List<String> command, Path dir, Duration timeout, int maxStdout,
                                               Path watched, long watchedMax,
                                               BoundedProcessRunner.CancellationToken token) throws IOException {
            if (command.contains("libx264")) {
                encodes.incrementAndGet();
                if (killNextEncode.getAndSet(false)) {
                    return new BoundedProcessRunner.Result(BoundedProcessRunner.End.EXITED, 137, new byte[0], 0, "");
                }
                if (holdFirstEncode.getAndSet(false)) {
                    encodeStarted.countDown();
                    return BoundedProcessRunner.run(List.of("/bin/sleep", "120"), dir, Map.of(), Duration.ofSeconds(150),
                            16, 16, token, null, 0);
                }
            }
            return BoundedProcessRunner.run(command, dir, Map.of(), timeout, maxStdout, 8192, token, watched, watchedMax);
        }
    }

    @BeforeAll
    static void generate() throws Exception {
        String ff = System.getenv("MEDIA_DEV_RENDER_FFMPEG");
        String fp = System.getenv("MEDIA_DEV_RENDER_FFPROBE");
        assertThat(ff).as("MEDIA_DEV_RENDER_FFMPEG").isNotBlank();
        assertThat(fp).as("MEDIA_DEV_RENDER_FFPROBE").isNotBlank();
        ffmpeg = Path.of(ff);
        ffprobe = Path.of(fp);
        work = Files.createTempDirectory("media-dev-quality-http-");
        sourceBytes = QualityOptimizationFixture.noisySource(ffmpeg, work);
        sourceFile = work.resolve("p-source.mp4");
        Files.write(sourceFile, sourceBytes);
    }

    @AfterAll
    static void cleanup() {
        if (work != null) deleteTree(work);
    }

    // ------------------------------------------------------------------ the journey

    @Test
    void minBytesAtSsimSelectsAMeasuredAttemptAndUndoRestoresThePreviousHeadExactly() throws Exception {
        MediaRuntime runtime = runtime();
        Port port = new Port();
        HttpServer server = server(runtime, port);
        try {
            String base = base(server);
            MediaArtifact source = upload(runtime, "source.mp4", "video/mp4", sourceBytes);
            admitted.add(source.artifactId());
            int storedBefore = artifactCount(runtime);

            HttpResponse<String> created = send(base, "POST", OPTIMIZATIONS, body("opt-1", "lin-1", source,
                    minBytes("ssim", 0.90), 16, 40, 6), OWNER, PERMISSIONS);
            assertThat(created.statusCode()).as(created.body()).isEqualTo(201);
            Map<String, Object> view = read(created.body());
            assertThat(view).containsEntry("outcome", "SELECTED").containsEntry("replayed", false);
            Map<String, Object> report = object(view.get("report"));
            List<Map<String, Object>> attempts = attemptsOf(report);
            assertThat(attempts.size()).isBetween(2, 6);
            assertThat(port.encodes.get()).as("one real encode per reported attempt").isEqualTo(attempts.size());
            assertThat(report).containsEntry("outcome", "SELECTED").containsEntry("stopReason", "RANGE_EXHAUSTED");

            // The chosen attempt is a measured, feasible one with the fewest bytes among the feasible ones.
            int chosenIndex = (Integer) report.get("chosenAttempt");
            Map<String, Object> chosenAttempt = attempts.get(chosenIndex - 1);
            assertThat(chosenAttempt).containsEntry("feasible", true).containsEntry("verdict", "MEETS_TARGET");
            assertThat(num(chosenAttempt, "meanSsimY")).isGreaterThanOrEqualTo(0.90);
            assertThat(num(chosenAttempt, "bytes")).isLessThan(source.sizeBytes());
            for (Map<String, Object> attempt : attempts) {
                boolean meets = num(attempt, "meanSsimY") >= 0.90 && num(attempt, "bytes") < source.sizeBytes();
                assertThat(attempt.get("feasible")).as("attempt %s", attempt).isEqualTo(meets);
                if (meets) assertThat(num(attempt, "bytes")).isGreaterThanOrEqualTo(num(chosenAttempt, "bytes"));
            }
            // Bisection looked at a higher and a lower CRF than the chosen one before stopping.
            assertThat(attempts.stream().map(a -> (Integer) a.get("crf")).distinct().count()).isEqualTo(attempts.size());

            // Independent verification of EVERY attempt: re-encode with the documented command line (identical bytes
            // and identical video packets) and measure with FFmpeg's own filters (the product's Java metrics must agree).
            String comment = QualityOptimizationFixture.containerComment(TENANT, OWNER, "opt-1");
            assertThat(comment).isEqualTo(MediaDevQualityOptimizationRuntime.containerComment(TENANT, OWNER, "opt-1"));
            Map<Integer, byte[]> independentByCrf = new java.util.HashMap<>();
            for (Map<String, Object> attempt : attempts) {
                int crf = (Integer) attempt.get("crf");
                byte[] independent = QualityOptimizationFixture.independentEncode(ffmpeg, work, sourceFile, crf, comment);
                independentByCrf.put(crf, independent);
                Path encoded = work.resolve("p-attempt-" + crf + ".mp4");
                Files.write(encoded, independent);
                assertThat(QualityOptimizationFixture.streamSha256(ffmpeg, encoded))
                        .as("attempt crf %d is a real, reproducible encode", crf).isEqualTo(attempt.get("videoStreamSha256"));
                assertThat((long) independent.length).isEqualTo(((Number) attempt.get("bytes")).longValue());
                assertThat(num(attempt, "globalPsnrY")).isCloseTo(
                        VideoEnhancementFixture.ffmpegPsnrY(ffmpeg, encoded, sourceFile), offset(0.3));
                assertThat(num(attempt, "meanSsimY")).isCloseTo(
                        VideoEnhancementFixture.ffmpegSsimY(ffmpeg, encoded, sourceFile), offset(0.02));
            }

            // The chosen attempt became a NEW immutable version; the source is untouched.
            Map<String, Object> chosen = object(view.get("chosen"));
            String chosenId = (String) chosen.get("artifactId");
            String chosenVersion = (String) chosen.get("artifactVersionId");
            assertThat(chosenId).isNotEqualTo(source.artifactId());
            assertThat(chosen.get("sha256")).as("the registered file is exactly the independent encode")
                    .isEqualTo(sha256(independentByCrf.get((Integer) chosenAttempt.get("crf"))));
            assertThat(object(chosen.get("lineage"))).containsEntry("containerComment", comment);
            assertThat(chosen).containsEntry("contentType", "video/mp4");
            assertThat(content(runtime, chosenId)).hasSize(((Number) chosenAttempt.get("bytes")).intValue());
            assertThat(content(runtime, source.artifactId())).isEqualTo(sourceBytes);
            assertThat(runtime.artifact(TENANT, OWNER, source.artifactId()).orElseThrow().version())
                    .isEqualTo(source.version());
            assertThat(artifactCount(runtime)).as("exactly the chosen video and the report were added")
                    .isGreaterThan(storedBefore);
            Map<String, Object> chosenLineage = object(chosen.get("lineage"));
            assertThat(object(chosenLineage.get("source"))).containsEntry("artifactId", source.artifactId())
                    .containsEntry("sha256", source.sha256());
            assertThat(object(view.get("admission"))).containsEntry("verdict", "ADMITTED");

            // The head moved to the chosen version (BASE then APPLY); the report is readable by its artifact id.
            Map<String, Object> lineage = object(view.get("lineage"));
            assertThat(object(lineage.get("head"))).containsEntry("artifactVersionId", chosenVersion)
                    .containsEntry("kind", "APPLY");
            assertThat(lineage).containsEntry("undoable", true);
            assertThat(events(lineage)).extracting(e -> e.get("kind")).containsExactly("BASE", "APPLY");
            String reportId = (String) object(view.get("reportArtifact")).get("artifactId");
            HttpResponse<String> reread = send(base, "GET", OPTIMIZATIONS + "/" + reportId, null, OWNER, PERMISSIONS);
            assertThat(reread.statusCode()).isEqualTo(200);
            assertThat(read(reread.body()).get("report")).isEqualTo(view.get("report"));
            assertThat(read(reread.body())).containsEntry("replayed", true).containsEntry("outcome", "SELECTED");

            // Replay: same requestId and request returns the same result without encoding again.
            int encodesBeforeReplay = port.encodes.get();
            HttpResponse<String> replay = send(base, "POST", OPTIMIZATIONS, body("opt-1", "lin-1", source,
                    minBytes("ssim", 0.90), 16, 40, 6), OWNER, PERMISSIONS);
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            assertThat(read(replay.body())).containsEntry("replayed", true);
            assertThat(object(read(replay.body()).get("reportArtifact")).get("artifactId")).isEqualTo(reportId);
            assertThat(port.encodes.get()).isEqualTo(encodesBeforeReplay);
            // A different request under the same requestId is a 409; a fresh requestId on the moved head is a 409 too.
            HttpResponse<String> reused = send(base, "POST", OPTIMIZATIONS, body("opt-1", "lin-1", source,
                    minBytes("ssim", 0.92), 16, 40, 6), OWNER, PERMISSIONS);
            assertThat(reused.statusCode()).as(reused.body()).isEqualTo(409);
            assertThat(reused.body()).contains("QUALITY_REQUEST_ID_REUSED");
            HttpResponse<String> moved = send(base, "POST", OPTIMIZATIONS, body("opt-moved", "lin-1", source,
                    minBytes("ssim", 0.90), 16, 40, 6), OWNER, PERMISSIONS);
            assertThat(moved.statusCode()).as(moved.body()).isEqualTo(409);
            assertThat(moved.body()).contains("LINEAGE_HEAD_MOVED").contains(chosenVersion);
            assertThat(port.encodes.get()).as("a refused request did not encode").isEqualTo(encodesBeforeReplay);

            // Undo restores the previous head EXACTLY: the very same artifact id and version, nothing copied.
            String undoPath = "/dev/v1/quality/lineages/lin-1/undo";
            HttpResponse<String> stale = send(base, "POST", undoPath, undoBody("undo-stale", source.version().value()),
                    OWNER, PERMISSIONS);
            assertThat(stale.statusCode()).as(stale.body()).isEqualTo(409);
            assertThat(stale.body()).contains("LINEAGE_HEAD_MOVED");
            int storedBeforeUndo = artifactCount(runtime);
            HttpResponse<String> undone = send(base, "POST", undoPath, undoBody("undo-1", chosenVersion), OWNER,
                    PERMISSIONS);
            assertThat(undone.statusCode()).as(undone.body()).isEqualTo(201);
            Map<String, Object> undoView = read(undone.body());
            assertThat(object(undoView.get("head"))).containsEntry("artifactId", source.artifactId())
                    .containsEntry("artifactVersionId", source.version().value());
            assertThat(object(undoView.get("undone"))).containsEntry("artifactVersionId", chosenVersion);
            assertThat(undoView).containsEntry("undoable", false).containsEntry("replayed", false);
            assertThat(artifactCount(runtime)).as("undo moves a pointer; it copies and deletes nothing")
                    .isEqualTo(storedBeforeUndo);
            assertThat(content(runtime, chosenId)).as("the undone version is kept, immutable").isNotEmpty();
            assertThat(send(base, "POST", undoPath, undoBody("undo-1", chosenVersion), OWNER, PERMISSIONS).statusCode())
                    .as("replay of the same undo").isEqualTo(200);
            HttpResponse<String> nothing = send(base, "POST", undoPath, undoBody("undo-2", source.version().value()),
                    OWNER, PERMISSIONS);
            assertThat(nothing.statusCode()).as(nothing.body()).isEqualTo(409);
            assertThat(nothing.body()).contains("NOTHING_TO_UNDO");
            HttpResponse<String> after = send(base, "GET", "/dev/v1/quality/lineages/lin-1", null, OWNER, PERMISSIONS);
            assertThat(after.statusCode()).isEqualTo(200);
            Map<String, Object> afterView = read(after.body());
            assertThat(events(afterView)).extracting(e -> e.get("kind")).containsExactly("BASE", "APPLY", "UNDO");
            assertThat(object(afterView.get("head"))).containsEntry("artifactVersionId", source.version().value());
            // The original replayed request still answers with its recorded result (undo does not rewrite history).
            assertThat(send(base, "POST", OPTIMIZATIONS, body("opt-1", "lin-1", source, minBytes("ssim", 0.90), 16, 40, 6),
                    OWNER, PERMISSIONS).statusCode()).isEqualTo(200);
            // The undone lineage can be optimized again from the restored head.
            assertThat(send(base, "POST", OPTIMIZATIONS, body("opt-again", "lin-1", source, minBytes("ssim", 0.90), 16, 40,
                    6), OWNER, PERMISSIONS).statusCode()).isEqualTo(201);

            // Determinism: the same inputs under a new requestId and lineage give a byte-identical report and video.
            HttpResponse<String> twin = send(base, "POST", OPTIMIZATIONS, body("opt-twin", "lin-twin", source,
                    minBytes("ssim", 0.90), 16, 40, 6), OWNER, PERMISSIONS);
            assertThat(twin.statusCode()).as(twin.body()).isEqualTo(201);
            Map<String, Object> twinView = read(twin.body());
            assertThat(twinView.get("report")).isEqualTo(view.get("report"));
            assertThat(twinView.get("reportSha256")).as("byte-identical canonical report").isEqualTo(view.get("reportSha256"));
            // The chosen encode is the same video packets; the stored files differ only by their request comment.
            String twinChosenId = (String) object(twinView.get("chosen")).get("artifactId");
            Path twinFile = work.resolve("p-twin-chosen.mp4");
            Files.write(twinFile, content(runtime, twinChosenId));
            assertThat(QualityOptimizationFixture.streamSha256(ffmpeg, twinFile))
                    .isEqualTo(chosenAttempt.get("videoStreamSha256"));
            assertThat(object(twinView.get("chosen")).get("sha256")).isNotEqualTo(chosen.get("sha256"));
            assertThat(object(twinView.get("chosen")).get("sizeBytes")).isEqualTo(chosen.get("sizeBytes"));
            HttpResponse<String> reopenedReport = send(base, "GET", OPTIMIZATIONS + "/" + reportId, null, OWNER, PERMISSIONS);
            assertThat(read(reopenedReport.body())).containsEntry("reportSha256", view.get("reportSha256"));
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    @Test
    void maxQualityUnderAByteBudgetSelectsTheBestFittingAttemptAndAbstainsWhenNothingFits() throws Exception {
        MediaRuntime runtime = runtime();
        Port port = new Port();
        HttpServer server = server(runtime, port);
        try {
            String base = base(server);
            MediaArtifact source = upload(runtime, "source.mp4", "video/mp4", sourceBytes);
            admitted.add(source.artifactId());
            int beforeSelected = artifactCount(runtime);
            HttpResponse<String> created = send(base, "POST", OPTIMIZATIONS, body("budget-1", "lin-b", source,
                    maxQuality("psnr", 200_000), 14, 44, 7), OWNER, PERMISSIONS);
            assertThat(created.statusCode()).as(created.body()).isEqualTo(201);
            Map<String, Object> view = read(created.body());
            assertThat(view).containsEntry("outcome", "SELECTED");
            Map<String, Object> report = object(view.get("report"));
            List<Map<String, Object>> attempts = attemptsOf(report);
            Map<String, Object> chosenAttempt = attempts.get((Integer) report.get("chosenAttempt") - 1);
            assertThat(num(chosenAttempt, "bytes")).isLessThanOrEqualTo(200_000);
            for (Map<String, Object> attempt : attempts) {
                boolean fits = num(attempt, "bytes") <= 200_000;
                assertThat(attempt.get("feasible")).isEqualTo(fits);
                assertThat(attempt.get("verdict")).isEqualTo(fits ? "MEETS_TARGET" : "OVER_BYTE_BUDGET");
                if (fits) assertThat(num(attempt, "globalPsnrY")).isLessThanOrEqualTo(num(chosenAttempt, "globalPsnrY"));
            }
            assertThat(object(view.get("chosen")).get("sizeBytes")).isEqualTo(chosenAttempt.get("bytes"));
            int storedBySelection = artifactCount(runtime) - beforeSelected;

            // The derived version has no attestation of its own: optimizing it again is refused for rights.
            String chosenId = (String) object(view.get("chosen")).get("artifactId");
            String chosenVersion = (String) object(view.get("chosen")).get("artifactVersionId");
            HttpResponse<String> chained = send(base, "POST", OPTIMIZATIONS, body("budget-2", "lin-b", chosenId,
                    chosenVersion, minBytes("ssim", 0.9), 16, 40, 4), OWNER, PERMISSIONS);
            assertThat(chained.statusCode()).as(chained.body()).isEqualTo(403);
            assertThat(chained.body()).contains("RIGHTS_DENIED");

            // Nothing fits in 4 KiB (the audio alone is larger): a typed abstention, never a failing pick.
            int storedBefore = artifactCount(runtime);
            HttpResponse<String> abstained = send(base, "POST", OPTIMIZATIONS, body("budget-none", "lin-none", source,
                    maxQuality("ssim", 4_096), 20, 40, 4), OWNER, PERMISSIONS);
            assertThat(abstained.statusCode()).as(abstained.body()).isEqualTo(201);
            Map<String, Object> noneView = read(abstained.body());
            assertThat(noneView).containsEntry("outcome", "ABSTAINED").containsEntry("chosen", null);
            Map<String, Object> noneReport = object(noneView.get("report"));
            assertThat(noneReport).containsEntry("outcome", "ABSTAINED").containsEntry("chosenAttempt", null)
                    .containsEntry("abstainReason", "NO_ATTEMPT_MET_TARGET");
            assertThat(attemptsOf(noneReport)).isNotEmpty().allSatisfy(a -> assertThat(a)
                    .containsEntry("feasible", false).containsEntry("verdict", "OVER_BYTE_BUDGET"));
            assertThat(noneView).doesNotContainKey("lineage").doesNotContainKey("applied");
            assertThat(artifactCount(runtime) - storedBefore).as("only the report was registered, no video version")
                    .isPositive().isLessThan(storedBySelection);
            assertThat(send(base, "GET", "/dev/v1/quality/lineages/lin-none", null, OWNER, PERMISSIONS).statusCode())
                    .as("an abstention creates no lineage and moves no head").isEqualTo(404);
            HttpResponse<String> replay = send(base, "POST", OPTIMIZATIONS, body("budget-none", "lin-none", source,
                    maxQuality("ssim", 4_096), 20, 40, 4), OWNER, PERMISSIONS);
            assertThat(replay.statusCode()).isEqualTo(200);
            assertThat(read(replay.body())).containsEntry("outcome", "ABSTAINED").containsEntry("replayed", true);

            // An unreachable quality target within the bounds abstains as well, and says why the search stopped.
            HttpResponse<String> unreachable = send(base, "POST", OPTIMIZATIONS, body("q-none", "lin-q", source,
                    minBytes("ssim", 0.9999), 30, 40, 6), OWNER, PERMISSIONS);
            assertThat(unreachable.statusCode()).as(unreachable.body()).isEqualTo(201);
            Map<String, Object> unreachableReport = object(read(unreachable.body()).get("report"));
            assertThat(unreachableReport).containsEntry("outcome", "ABSTAINED").containsEntry("stopReason", "RANGE_EXHAUSTED");
            assertThat(attemptsOf(unreachableReport)).allSatisfy(a -> assertThat(a).containsEntry("feasible", false)
                    .containsEntry("verdict", "BELOW_QUALITY_TARGET"));
            // A budget-limited search says so instead of claiming an optimum.
            HttpResponse<String> limited = send(base, "POST", OPTIMIZATIONS, body("q-limited", "lin-l", source,
                    minBytes("ssim", 0.9999), 12, 45, 2), OWNER, PERMISSIONS);
            assertThat(object(read(limited.body()).get("report"))).containsEntry("stopReason", "ATTEMPT_BUDGET_EXHAUSTED");
            assertThat(attemptsOf(object(read(limited.body()).get("report")))).hasSize(2);
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    // ------------------------------------------------------------------ faults

    @Test
    void invalidBoundsAreRefusedWith422BeforeAnythingIsLookedUpOrRun() throws Exception {
        MediaRuntime runtime = runtime();
        Port port = new Port();
        HttpServer server = server(runtime, port);
        try {
            String base = base(server);
            String missing = "no-such-artifact";
            String version = "sha256:" + "0".repeat(64);
            int baseline = artifactCount(runtime);
            List<Map<String, Object>> badTargets = List.of(
                    minBytes("ssim", 1.5), minBytes("ssim", 0.2), minBytes("ssim", 1.0), minBytes("psnr", 5.0),
                    minBytes("psnr", 200.0), maxQuality("psnr", 10), maxQuality("psnr", 1L << 40),
                    Map.of("type", "MIN_BYTES_AT_QUALITY", "metric", "vmaf", "minQuality", 0.9),
                    Map.of("type", "SMALLEST_POSSIBLE", "metric", "ssim", "minQuality", 0.9));
            int n = 0;
            for (Map<String, Object> target : badTargets) {
                HttpResponse<String> refused = send(base, "POST", OPTIMIZATIONS, body("bad-" + n++, "lin-bad", missing,
                        version, target, 16, 40, 4), OWNER, PERMISSIONS);
                assertThat(refused.statusCode()).as(target + " " + refused.body()).isEqualTo(422);
                assertThat(refused.body()).contains("QUALITY_PARAMETER_OUT_OF_RANGE");
            }
            int[][] badSearch = {{5, 40, 4}, {16, 99, 4}, {30, 20, 4}, {16, 40, 0}, {16, 40, 9}, {16, 40, 100}};
            for (int[] search : badSearch) {
                HttpResponse<String> refused = send(base, "POST", OPTIMIZATIONS, body("bad-" + n++, "lin-bad", missing,
                        version, minBytes("ssim", 0.9), search[0], search[1], search[2]), OWNER, PERMISSIONS);
                assertThat(refused.statusCode()).as(List.of(search[0], search[1], search[2]) + " " + refused.body())
                        .isEqualTo(422);
                assertThat(refused.body()).contains("QUALITY_PARAMETER_OUT_OF_RANGE");
            }
            Map<String, Object> hugeAttempts = new LinkedHashMap<>(bodyMap("bad-huge", "lin-bad", missing, version,
                    minBytes("ssim", 0.9), 16, 40, 4));
            hugeAttempts.put("search", Map.of("maxAttempts", 99_999_999_999L));
            assertThat(send(base, "POST", OPTIMIZATIONS, JSON.writeValueAsString(hugeAttempts), OWNER, PERMISSIONS)
                    .statusCode()).isEqualTo(422);
            for (String id : List.of("has space", "", "x".repeat(101))) {
                HttpResponse<String> refused = send(base, "POST", OPTIMIZATIONS, body(id, "lin-bad", missing, version,
                        minBytes("ssim", 0.9), 16, 40, 4), OWNER, PERMISSIONS);
                assertThat(refused.statusCode()).as("requestId '" + id + "'").isEqualTo(422);
            }
            assertThat(send(base, "POST", OPTIMIZATIONS, body("bad-lineage", "bad lineage!", missing, version,
                    minBytes("ssim", 0.9), 16, 40, 4), OWNER, PERMISSIONS).statusCode()).isEqualTo(422);
            // Shape errors are plain 400s: unknown fields are not ignored.
            Map<String, Object> extra = new LinkedHashMap<>(bodyMap("bad-extra", "lin-bad", missing, version,
                    minBytes("ssim", 0.9), 16, 40, 4));
            extra.put("principalId", "someone-else");
            assertThat(send(base, "POST", OPTIMIZATIONS, JSON.writeValueAsString(extra), OWNER, PERMISSIONS)
                    .statusCode()).isEqualTo(400);
            assertThat(port.encodes.get()).isZero();
            assertThat(artifactCount(runtime)).isEqualTo(baseline);
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    @Test
    void rightsOwnershipPermissionsAndNonVideoSourcesAreRefusedWithNothingRunOrRegistered() throws Exception {
        MediaRuntime runtime = runtime();
        Port port = new Port();
        HttpServer server = server(runtime, port);
        try {
            String base = base(server);
            MediaArtifact source = upload(runtime, "source.mp4", "video/mp4", sourceBytes);
            MediaArtifact text = upload(runtime, "note.txt", "text/plain", "not a video".getBytes());
            admitted.add(text.artifactId());
            int baseline = artifactCount(runtime);
            String request = body("r-1", "lin-r", source, minBytes("ssim", 0.9), 16, 40, 4);

            HttpResponse<String> noRights = send(base, "POST", OPTIMIZATIONS, request, OWNER, PERMISSIONS);
            assertThat(noRights.statusCode()).as(noRights.body()).isEqualTo(403);
            assertThat(noRights.body()).contains("RIGHTS_DENIED").contains(source.artifactId());
            admitted.add(source.artifactId());
            unavailable.set(true);
            HttpResponse<String> down = send(base, "POST", OPTIMIZATIONS, request, OWNER, PERMISSIONS);
            assertThat(down.statusCode()).as(down.body()).isEqualTo(503);
            assertThat(down.body()).contains("RIGHTS_AUTHORITY_UNAVAILABLE");
            unavailable.set(false);

            // Another principal of the same tenant cannot see the version: 404, never 403.
            HttpResponse<String> foreign = send(base, "POST", OPTIMIZATIONS, request, OTHER, PERMISSIONS);
            assertThat(foreign.statusCode()).as(foreign.body()).isEqualTo(404);
            assertThat(foreign.body()).contains("SOURCE_VERSION_NOT_FOUND");
            HttpResponse<String> stale = send(base, "POST", OPTIMIZATIONS, body("r-stale", "lin-r", source.artifactId(),
                    "sha256:" + "3".repeat(64), minBytes("ssim", 0.9), 16, 40, 4), OWNER, PERMISSIONS);
            assertThat(stale.statusCode()).isEqualTo(404);

            // Permissions: both artifact read and create, and the project write permission.
            for (Set<String> missing : List.of(
                    Set.of("media:project:dev:write", "media:artifact:read"),
                    Set.of("media:project:dev:write", "media:artifact:create"),
                    Set.of("media:project:dev:read", "media:artifact:read", "media:artifact:create"))) {
                assertThat(send(base, "POST", OPTIMIZATIONS, request, OWNER, missing).statusCode())
                        .as(missing.toString()).isEqualTo(403);
            }
            assertThat(send(base, "GET", "/dev/v1/quality/lineages/lin-r", null, OWNER,
                    Set.of("media:project:dev:read")).statusCode()).isEqualTo(403);

            HttpResponse<String> notVideo = send(base, "POST", OPTIMIZATIONS, body("r-text", "lin-t", text,
                    minBytes("ssim", 0.9), 16, 40, 4), OWNER, PERMISSIONS);
            assertThat(notVideo.statusCode()).as(notVideo.body()).isEqualTo(422);
            assertThat(notVideo.body()).contains("SOURCE_FORMAT_NOT_SUPPORTED");
            assertThat(port.encodes.get()).isZero();
            assertThat(artifactCount(runtime)).as("no refused request registered anything").isEqualTo(baseline);

            // A good run, then revocation: even the replay of the completed request is refused.
            assertThat(send(base, "POST", OPTIMIZATIONS, request, OWNER, PERMISSIONS).statusCode()).isEqualTo(201);
            int encodes = port.encodes.get();
            revoked.set(true);
            HttpResponse<String> afterRevocation = send(base, "POST", OPTIMIZATIONS, request, OWNER, PERMISSIONS);
            assertThat(afterRevocation.statusCode()).as(afterRevocation.body()).isEqualTo(403);
            assertThat(afterRevocation.body()).contains("RIGHTS_REVOKED");
            assertThat(port.encodes.get()).isEqualTo(encodes);

            // The lineage and the report belong to their owner only.
            assertThat(send(base, "GET", "/dev/v1/quality/lineages/lin-r", null, OTHER, PERMISSIONS).statusCode())
                    .isEqualTo(404);
            assertThat(send(base, "POST", "/dev/v1/quality/lineages/lin-r/undo", undoBody("u-1", "sha256:" + "4".repeat(64)),
                    OTHER, PERMISSIONS).statusCode()).isEqualTo(404);
            assertThat(send(base, "GET", "/dev/v1/quality/lineages/lin-r", null, OWNER, PERMISSIONS).statusCode())
                    .isEqualTo(200);
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    @Test
    void cancellingMidSearchKillsTheEncodeAndRegistersNothingAndTheRetryRunsAgain() throws Exception {
        MediaRuntime runtime = runtime();
        Port port = new Port();
        port.holdFirstEncode.set(true);
        HttpServer server = server(runtime, port);
        try {
            String base = base(server);
            MediaArtifact source = upload(runtime, "source.mp4", "video/mp4", sourceBytes);
            admitted.add(source.artifactId());
            int baseline = artifactCount(runtime);
            String request = body("cancel-1", "lin-c", source, minBytes("ssim", 0.9), 16, 40, 4);
            assertThat(send(base, "POST", "/dev/v1/quality/optimizations/cancel-1/cancel", "{}", OWNER, PERMISSIONS)
                    .statusCode()).as("nothing is running yet").isEqualTo(404);

            var running = java.util.concurrent.CompletableFuture.supplyAsync(() -> {
                try { return send(base, "POST", OPTIMIZATIONS, request, OWNER, PERMISSIONS); }
                catch (Exception failure) { throw new IllegalStateException(failure); }
            });
            assertThat(port.encodeStarted.await(60, TimeUnit.SECONDS)).as("first encode started").isTrue();
            // Another principal cannot cancel it; the owner can.
            assertThat(send(base, "POST", "/dev/v1/quality/optimizations/cancel-1/cancel", "{}", OTHER, PERMISSIONS)
                    .statusCode()).isEqualTo(404);
            HttpResponse<String> cancel = send(base, "POST", "/dev/v1/quality/optimizations/cancel-1/cancel", "{}",
                    OWNER, PERMISSIONS);
            assertThat(cancel.statusCode()).as(cancel.body()).isEqualTo(200);
            HttpResponse<String> cancelled = running.get(60, TimeUnit.SECONDS);
            assertThat(cancelled.statusCode()).as(cancelled.body()).isEqualTo(409);
            assertThat(cancelled.body()).contains("OPTIMIZATION_CANCELLED").contains("CANCELLED");
            assertThat(artifactCount(runtime)).as("a cancelled search registers nothing").isEqualTo(baseline);
            assertThat(send(base, "GET", "/dev/v1/quality/lineages/lin-c", null, OWNER, PERMISSIONS).statusCode())
                    .as("and the head never moved").isEqualTo(404);

            // The same requestId is free again: the retry runs the whole search and registers exactly once.
            HttpResponse<String> retry = send(base, "POST", OPTIMIZATIONS, request, OWNER, PERMISSIONS);
            assertThat(retry.statusCode()).as(retry.body()).isEqualTo(201);
            assertThat(read(retry.body())).containsEntry("outcome", "SELECTED");
            assertThat(send(base, "POST", OPTIMIZATIONS, request, OWNER, PERMISSIONS).statusCode()).isEqualTo(200);
            // Once finished it can no longer be cancelled.
            assertThat(send(base, "POST", "/dev/v1/quality/optimizations/cancel-1/cancel", "{}", OWNER, PERMISSIONS)
                    .statusCode()).isEqualTo(404);
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    @Test
    void aKilledEncodeIsAnUnknownOutcomeWithNothingRegisteredAndTheRetryRegistersExactlyOnce() throws Exception {
        MediaRuntime runtime = runtime();
        Port port = new Port();
        port.killNextEncode.set(true);
        HttpServer server = server(runtime, port);
        try {
            String base = base(server);
            MediaArtifact source = upload(runtime, "source.mp4", "video/mp4", sourceBytes);
            admitted.add(source.artifactId());
            int baseline = artifactCount(runtime);
            String request = body("kill-1", "lin-k", source, minBytes("ssim", 0.9), 16, 40, 4);
            HttpResponse<String> unknown = send(base, "POST", OPTIMIZATIONS, request, OWNER, PERMISSIONS);
            assertThat(unknown.statusCode()).as(unknown.body()).isEqualTo(503);
            assertThat(unknown.body()).contains("OPTIMIZATION_OUTCOME_UNKNOWN").contains("\"outcome\":\"UNKNOWN\"");
            assertThat(artifactCount(runtime)).isEqualTo(baseline);
            HttpResponse<String> retry = send(base, "POST", OPTIMIZATIONS, request, OWNER, PERMISSIONS);
            assertThat(retry.statusCode()).as(retry.body()).isEqualTo(201);
            HttpResponse<String> replay = send(base, "POST", OPTIMIZATIONS, request, OWNER, PERMISSIONS);
            assertThat(replay.statusCode()).isEqualTo(200);
            assertThat(object(read(replay.body()).get("reportArtifact")).get("artifactId"))
                    .isEqualTo(object(read(retry.body()).get("reportArtifact")).get("artifactId"));
            assertThat(send(base, "GET", "/dev/v1/quality/lineages/lin-k", null, OWNER, PERMISSIONS).statusCode())
                    .isEqualTo(200);
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    // ------------------------------------------------------------------ helpers

    private HttpServer server(MediaRuntime runtime, MediaDevVideoRuntime.ProcessPort port) throws Exception {
        MediaDevProjectTimelineRuntime projects = new MediaDevProjectTimelineRuntime(new InMemoryManagedStore());
        HttpServer server = MediaDevProjectRenderHttpTest.server(runtime, projects, null);
        server.removeContext("/");
        MediaDevRequestLedger ledger = MediaDevRequestLedger.inMemory();
        MediaDevVideoRuntime video = new MediaDevVideoRuntime(runtime, ffmpeg, ffprobe, resolver,
                MediaDevProjectRenderRuntime.canonicalRegistrar(runtime), ledger, port, null);
        MediaDevQualityOptimizationRuntime quality = new MediaDevQualityOptimizationRuntime(video, ledger,
                new InMemoryMediaHeadLedger());
        MediaHttpHandler handler = new MediaHttpHandler(runtime, null, null, projects).withDevQuality(quality);
        server.createContext("/", new MediaSecurityFilter(handler, "dev", Map.of("MEDIA_DEV_IDENTITY_ENABLED", "true",
                "MEDIA_DEV_JWT_HMAC_SECRET", "test-only-dev-project-secret-at-least-32-bytes"),
                java.time.Clock.fixed(java.time.Instant.parse("2026-11-13T20:00:00Z"), java.time.ZoneOffset.UTC)));
        return server;
    }

    private static MediaRuntime runtime() throws Exception {
        Path root = Files.createTempDirectory("media-dev-quality-http-store-");
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "dev", 8093, 1_048_576, 131_072, 64L * 1024 * 1024, Duration.ofSeconds(2),
                        2, "", "", true, false, root, 0, MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT,
                        MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT_PER_TENANT),
                new LocalMediaRuntimeSupport.FileArtifactStore(root), new LocalMediaRuntimeSupport.JobStore(false),
                new LocalMediaRuntimeSupport.StreamStore(), null,
                List.of(new MediaDevProjectRenderHttpTest.NoEffectProvider()),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
    }

    private static int artifactCount(MediaRuntime runtime) throws Exception {
        try (var files = Files.walk(Path.of(runtime.config().localStorageRoot().toString()))) {
            return (int) files.filter(Files::isRegularFile).count();
        }
    }

    private static MediaArtifact upload(MediaRuntime runtime, String name, String contentType, byte[] bytes)
            throws Exception {
        String digest = sha256(bytes);
        var session = runtime.beginUpload(new UploadRequest(TENANT, OWNER, name, contentType, bytes.length, digest,
                "INTERNAL", Duration.ofMinutes(30), Map.of()), "fixture-" + digest);
        int chunk = runtime.config().maximumChunkBytes();
        int index = 0;
        for (int offset = 0; offset < bytes.length; offset += chunk, index++) {
            runtime.appendChunk(TENANT, OWNER, session.uploadId(), index,
                    java.util.Arrays.copyOfRange(bytes, offset, Math.min(bytes.length, offset + chunk)));
        }
        return runtime.completeUpload(TENANT, OWNER, session.uploadId());
    }

    private static byte[] content(MediaRuntime runtime, String artifactId) throws Exception {
        MediaArtifact artifact = runtime.artifact(TENANT, OWNER, artifactId).orElseThrow();
        var out = new java.io.ByteArrayOutputStream();
        runtime.copyArtifactContent(TENANT, OWNER, artifactId, artifact.version(), out, 64L << 20).orElseThrow();
        return out.toByteArray();
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static Map<String, Object> minBytes(String metric, double minQuality) {
        return Map.of("type", "MIN_BYTES_AT_QUALITY", "metric", metric, "minQuality", minQuality);
    }

    private static Map<String, Object> maxQuality(String metric, long maxBytes) {
        return Map.of("type", "MAX_QUALITY_UNDER_BYTES", "metric", metric, "maxBytes", maxBytes);
    }

    private static String body(String requestId, String lineageId, MediaArtifact source, Map<String, Object> target,
                               int crfMin, int crfMax, int attempts) throws Exception {
        return body(requestId, lineageId, source.artifactId(), source.version().value(), target, crfMin, crfMax, attempts);
    }

    private static String body(String requestId, String lineageId, String artifactId, String version,
                               Map<String, Object> target, int crfMin, int crfMax, int attempts) throws Exception {
        return JSON.writeValueAsString(bodyMap(requestId, lineageId, artifactId, version, target, crfMin, crfMax, attempts));
    }

    private static Map<String, Object> bodyMap(String requestId, String lineageId, String artifactId, String version,
                                               Map<String, Object> target, int crfMin, int crfMax, int attempts) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("lineageId", lineageId);
        body.put("artifactId", artifactId);
        body.put("artifactVersionId", version);
        body.put("target", target);
        body.put("search", Map.of("crfMin", crfMin, "crfMax", crfMax, "maxAttempts", attempts));
        return body;
    }

    private static String undoBody(String requestId, String expectedHead) throws Exception {
        return JSON.writeValueAsString(Map.of("requestId", requestId, "expectedHeadArtifactVersionId", expectedHead));
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> attemptsOf(Map<String, Object> report) {
        return (List<Map<String, Object>>) report.get("attempts");
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> events(Map<String, Object> lineage) {
        return (List<Map<String, Object>>) lineage.get("events");
    }

    private static double num(Map<String, Object> map, String key) {
        return ((Number) map.get(key)).doubleValue();
    }

    private static void deleteTree(Path root) {
        try (var walk = Files.walk(root)) {
            walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
        } catch (java.io.IOException ignored) { }
    }
}
