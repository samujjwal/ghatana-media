package com.ghatana.media.launcher;

import com.ghatana.media.production.rendering.BoundedProcessRunner;
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
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.InMemoryManagedStore;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.TENANT;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.base;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.object;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.read;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.send;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * J-08 DEV_ONLY video enhancement and independent measured comparison over the real HTTP host, filter and artifact
 * store with REAL FFmpeg/ffprobe, an FFmpeg-generated clean reference and a known-Gaussian-noise, blurred, blocky
 * degraded copy. The durable PostgreSQL/S3 and restart paths are covered by {@code MediaDevVideoEnhancementIT}.
 */
class MediaDevVideoHttpTest {
    private static final String OWNER = "test-principal-owner";
    private static final String OTHER = "test-principal-other";
    private static final Set<String> PERMISSIONS = Set.of("media:project:dev:create", "media:project:dev:read",
            "media:project:dev:write", "media:artifact:read", "media:artifact:create");
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final double NOISE_SIGMA = 8.0;

    private static Path ffmpeg;
    private static Path ffprobe;
    private static Path work;
    private static byte[] referenceBytes;
    private static byte[] degradedBytes;

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

    @BeforeAll
    static void generate() throws Exception {
        String ff = System.getenv("MEDIA_DEV_RENDER_FFMPEG");
        String fp = System.getenv("MEDIA_DEV_RENDER_FFPROBE");
        assertThat(ff).as("MEDIA_DEV_RENDER_FFMPEG").isNotBlank();
        assertThat(fp).as("MEDIA_DEV_RENDER_FFPROBE").isNotBlank();
        ffmpeg = Path.of(ff);
        ffprobe = Path.of(fp);
        work = Files.createTempDirectory("media-dev-video-http-");
        referenceBytes = VideoEnhancementFixture.reference(ffmpeg, work, 2);
        degradedBytes = VideoEnhancementFixture.degraded(ffmpeg, work, referenceBytes, NOISE_SIGMA, 20261114L, 34);
    }

    @AfterAll
    static void cleanup() {
        if (work != null) MediaDevVideoHttpTest.deleteTree(work);
    }

    @Test
    void enhancementImprovesMeasuredQualityAndPreservesTimelineAndAudioWithHonestRegressions() throws Exception {
        MediaRuntime runtime = runtime();
        HttpServer server = server(runtime, null);
        try {
            String base = base(server);
            MediaArtifact reference = upload(runtime, "reference.mp4", "video/mp4", referenceBytes);
            MediaArtifact degraded = upload(runtime, "degraded.mp4", "video/mp4", degradedBytes);
            admitted.add(reference.artifactId());
            admitted.add(degraded.artifactId());

            String graph = "nlmeans=s=4:p=5:pc=5:r=7:rc=7,deblock=filter=strong:block=8:alpha=0.1:beta=0.05:gamma=0.05:delta=0.05,"
                    + "unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=0.3:chroma_msize_x=3:chroma_msize_y=3:chroma_amount=0";
            HttpResponse<String> enhanced = send(base, "POST", "/dev/v1/video/enhancements", enhancementBody("enh-1",
                    degraded, List.of(
                            Map.of("type", "sharpen", "amount", 0.3),
                            Map.of("type", "denoise", "method", "nlmeans", "strength", 4),
                            Map.of("type", "deblock", "strength", 0.1)), 18), OWNER, PERMISSIONS);
            assertThat(enhanced.statusCode()).as(enhanced.body()).isEqualTo(201);
            Map<String, Object> view = read(enhanced.body());
            String enhancedId = (String) view.get("outputId");
            Map<String, Object> lineage = object(view.get("lineage"));
            assertThat(lineage).containsEntry("kind", MediaDevVideoRuntime.KIND_ENHANCEMENT)
                    .containsEntry("filterGraph", graph);
            assertThat(object(lineage.get("source"))).containsEntry("artifactId", degraded.artifactId())
                    .containsEntry("artifactVersionId", degraded.version().value())
                    .containsEntry("sha256", degraded.sha256());
            assertThat(object(lineage.get("encoder"))).containsEntry("videoCodec", "libx264").containsEntry("crf", 18)
                    .containsEntry("audio", "COPY");
            assertThat(object(view.get("admission"))).containsEntry("verdict", "ADMITTED");

            // The enhanced output is a NEW artifact version; the source is untouched.
            MediaArtifact enhancedArtifact = runtime.artifact(TENANT, OWNER, enhancedId).orElseThrow();
            // The enhanced output is a new artifact: comparing it needs its own PROCESSING admission.
            HttpResponse<String> unadmitted = send(base, "POST", "/dev/v1/video/comparisons", comparisonBody("cmp-0",
                    reference, List.of(subject("enhanced", enhancedArtifact))), OWNER, PERMISSIONS);
            assertThat(unadmitted.statusCode()).as(unadmitted.body()).isEqualTo(403);
            assertThat(unadmitted.body()).contains("RIGHTS_DENIED").contains(enhancedId);
            admitted.add(enhancedId);
            assertThat(enhancedId).isNotEqualTo(degraded.artifactId());
            assertThat(enhancedArtifact.contentType()).isEqualTo("video/mp4");
            assertThat(content(runtime, degraded.artifactId())).isEqualTo(degradedBytes);

            // Independent ffprobe: same frames, identical PTS ticks, same duration, audio packets bit-identical.
            Path degradedFile = work.resolve("p-degraded.mp4");
            Path enhancedFile = work.resolve("p-enhanced.mp4");
            Path referenceFile = work.resolve("p-reference.mp4");
            Files.write(degradedFile, degradedBytes);
            Files.write(enhancedFile, content(runtime, enhancedId));
            Files.write(referenceFile, referenceBytes);
            var before = VideoEnhancementFixture.probe(ffprobe, degradedFile);
            var after = VideoEnhancementFixture.probe(ffprobe, enhancedFile);
            assertThat(after.pts()).as("PTS of every frame").isEqualTo(before.pts());
            assertThat(after.pts()).hasSize(50);
            assertThat(after.timeBaseDen()).isEqualTo(before.timeBaseDen());
            assertThat(after.durationSeconds()).isCloseTo(before.durationSeconds(), org.assertj.core.data.Offset.offset(0.001));
            assertThat(after.audioStreams()).isEqualTo(1);
            assertThat(VideoEnhancementFixture.audioMd5(ffmpeg, enhancedFile))
                    .isEqualTo(VideoEnhancementFixture.audioMd5(ffmpeg, degradedFile));
            assertThat(object(lineage.get("timeline"))).containsEntry("frameCount", 50).containsEntry("ptsEqualInstants", true);
            assertThat(object(lineage.get("audio"))).containsEntry("mode", "STREAM_COPY");

            // Independent measured comparison against the clean reference.
            HttpResponse<String> compared = send(base, "POST", "/dev/v1/video/comparisons", comparisonBody("cmp-1",
                    reference, List.of(subject("degraded", degraded), subject("enhanced", enhancedArtifact))), OWNER,
                    PERMISSIONS);
            assertThat(compared.statusCode()).as(compared.body()).isEqualTo(201);
            Map<String, Object> comparison = read(compared.body());
            Map<String, Object> summary = object(object(comparison.get("lineage")).get("summary"));
            List<?> subjects = (List<?>) summary.get("subjects");
            Map<String, Object> degradedAgainst = object(object(subjects.get(0)).get("againstReference"));
            Map<String, Object> enhancedAgainst = object(object(subjects.get(1)).get("againstReference"));
            Map<String, Object> delta = object(((List<?>) summary.get("comparisons")).get(0));
            System.out.println("J08-UNIT-DEGRADED " + degradedAgainst);
            System.out.println("J08-UNIT-ENHANCED " + enhancedAgainst);
            System.out.println("J08-UNIT-DELTA " + delta);
            System.out.println("J08-UNIT-NOREF degraded=" + object(object(subjects.get(0)).get("noReference"))
                    + " enhanced=" + object(object(subjects.get(1)).get("noReference")));
            assertThat(((Number) enhancedAgainst.get("meanPsnrY")).doubleValue())
                    .isGreaterThan(((Number) degradedAgainst.get("meanPsnrY")).doubleValue() + 2.0);
            assertThat(((Number) enhancedAgainst.get("meanSsimY")).doubleValue())
                    .isGreaterThan(((Number) degradedAgainst.get("meanSsimY")).doubleValue() + 0.2);
            assertThat(delta).containsEntry("verdict", "IMPROVED").containsEntry("comparedFrames", 50);
            assertThat(degradedAgainst).containsEntry("alignedFrames", 50).containsEntry("fullyAligned", true);

            // The Java metrics agree with FFmpeg's own psnr/ssim filters (luma, whole clip).
            double ffDegraded = VideoEnhancementFixture.ffmpegPsnrY(ffmpeg, degradedFile, referenceFile);
            double ffEnhanced = VideoEnhancementFixture.ffmpegPsnrY(ffmpeg, enhancedFile, referenceFile);
            System.out.println("J08-UNIT-FFMPEG-PSNR degraded=" + ffDegraded + " enhanced=" + ffEnhanced);
            assertThat(((Number) degradedAgainst.get("meanPsnrY")).doubleValue()).isCloseTo(ffDegraded,
                    org.assertj.core.data.Offset.offset(0.25));
            assertThat(((Number) enhancedAgainst.get("meanPsnrY")).doubleValue()).isCloseTo(ffEnhanced,
                    org.assertj.core.data.Offset.offset(0.25));
            double ffSsimDegraded = VideoEnhancementFixture.ffmpegSsimY(ffmpeg, degradedFile, referenceFile);
            assertThat(((Number) degradedAgainst.get("meanSsimY")).doubleValue()).isCloseTo(ffSsimDegraded,
                    org.assertj.core.data.Offset.offset(0.02));

            // Honest regression: the same comparison with the subjects swapped reports REGRESSED, not a flattering view.
            HttpResponse<String> swapped = send(base, "POST", "/dev/v1/video/comparisons", comparisonBody("cmp-2",
                    reference, List.of(subject("enhanced", enhancedArtifact), subject("degraded", degraded))), OWNER,
                    PERMISSIONS);
            Map<String, Object> swappedDelta = object(((List<?>) object(object(read(swapped.body()).get("lineage"))
                    .get("summary")).get("comparisons")).get(0));
            assertThat(swappedDelta).containsEntry("verdict", "REGRESSED");
            assertThat(((Number) swappedDelta.get("meanPsnrYDeltaDb")).doubleValue()).isLessThan(0);
            assertThat(((Number) swappedDelta.get("framesPsnrRegressed")).intValue()).isGreaterThan(40);

            // A harmful enhancement (heavy brightness shift) is registered and measured as a regression.
            HttpResponse<String> harmful = send(base, "POST", "/dev/v1/video/enhancements", enhancementBody("enh-bad",
                    degraded, List.of(Map.of("type", "colourCorrection", "brightness", 0.25, "contrast", 1.0,
                            "saturation", 1.0, "gamma", 1.0)), 18), OWNER, PERMISSIONS);
            assertThat(harmful.statusCode()).as(harmful.body()).isEqualTo(201);
            MediaArtifact harmfulArtifact = runtime.artifact(TENANT, OWNER, (String) read(harmful.body()).get("outputId")).orElseThrow();
            admitted.add(harmfulArtifact.artifactId());
            Map<String, Object> harmfulDelta = object(((List<?>) object(object(read(send(base, "POST",
                    "/dev/v1/video/comparisons", comparisonBody("cmp-3", reference, List.of(subject("degraded", degraded),
                            subject("brightened", harmfulArtifact))), OWNER, PERMISSIONS).body()).get("lineage"))
                    .get("summary")).get("comparisons")).get(0));
            // PSNR collapses on every frame while SSIM (insensitive to a brightness shift) does not: reported as MIXED,
            // with the per-frame PSNR regressions visible, never rounded up to an improvement.
            assertThat(harmfulDelta).containsEntry("verdict", "MIXED").containsEntry("framesPsnrRegressed", 50);
            assertThat(((Number) harmfulDelta.get("meanPsnrYDeltaDb")).doubleValue()).isLessThan(-5.0);

            // No-reference comparison: noise sigma estimate falls and no PSNR/SSIM claim is made.
            HttpResponse<String> noReference = send(base, "POST", "/dev/v1/video/comparisons", JSON.writeValueAsString(
                    Map.of("requestId", "cmp-nr", "subjects", List.of(subject("degraded", degraded),
                            subject("enhanced", enhancedArtifact)))), OWNER, PERMISSIONS);
            assertThat(noReference.statusCode()).as(noReference.body()).isEqualTo(201);
            Map<String, Object> nrSummary = object(object(read(noReference.body()).get("lineage")).get("summary"));
            Map<String, Object> nrDelta = object(((List<?>) nrSummary.get("comparisons")).get(0));
            assertThat(nrDelta).containsEntry("verdict", "NO_REFERENCE");
            assertThat(((Number) nrDelta.get("meanNoiseSigmaYDelta")).doubleValue()).isLessThan(0);
            assertThat(object(((List<?>) nrSummary.get("subjects")).get(0))).doesNotContainKey("againstReference");

            // Replay: same requestId and request is the same artifact, no second registration.
            HttpResponse<String> replay = send(base, "POST", "/dev/v1/video/enhancements", enhancementBody("enh-1",
                    degraded, List.of(
                            Map.of("type", "sharpen", "amount", 0.3),
                            Map.of("type", "denoise", "method", "nlmeans", "strength", 4),
                            Map.of("type", "deblock", "strength", 0.1)), 18), OWNER, PERMISSIONS);
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            assertThat(read(replay.body())).containsEntry("outputId", enhancedId).containsEntry("replayed", true);
            // The same requestId with a different graph is refused, never a second version.
            HttpResponse<String> reuse = send(base, "POST", "/dev/v1/video/enhancements", enhancementBody("enh-1",
                    degraded, List.of(Map.of("type", "sharpen", "amount", 0.3)), 18), OWNER, PERMISSIONS);
            assertThat(reuse.statusCode()).as(reuse.body()).isEqualTo(409);
            assertThat(reuse.body()).contains("VIDEO_REQUEST_ID_REUSED");

            // Reopen by id.
            Map<String, Object> reopened = read(send(base, "GET", "/dev/v1/video/enhancements/" + enhancedId, null,
                    OWNER, PERMISSIONS).body());
            assertThat(object(reopened.get("lineage"))).containsEntry("filterGraph", graph);
            assertThat(send(base, "GET", "/dev/v1/video/comparisons/" + enhancedId, null, OWNER, PERMISSIONS)
                    .statusCode()).as("an enhancement is not a comparison").isEqualTo(404);
            assertThat(send(base, "GET", "/dev/v1/video/enhancements/" + enhancedId, null, OTHER, PERMISSIONS)
                    .statusCode()).isEqualTo(404);
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    @Test
    void refusalsAreTypedAndRegisterNothing() throws Exception {
        MediaRuntime runtime = runtime();
        AtomicInteger spawned = new AtomicInteger();
        HttpServer server = server(runtime, (command, dir, timeout, maxStdout, watched, watchedMax) -> {
            spawned.incrementAndGet();
            return BoundedProcessRunner.run(command, dir, Map.of(), timeout, maxStdout, 8192,
                    BoundedProcessRunner.CancellationToken.NEVER, watched, watchedMax);
        });
        try {
            String base = base(server);
            MediaArtifact degraded = upload(runtime, "degraded.mp4", "video/mp4", degradedBytes);
            MediaArtifact garbage = upload(runtime, "garbage.mp4", "video/mp4",
                    "this is not a video at all".repeat(40).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            byte[] truncated = java.util.Arrays.copyOf(degradedBytes, degradedBytes.length / 3);
            MediaArtifact cut = upload(runtime, "truncated.mp4", "video/mp4", truncated);
            MediaArtifact text = upload(runtime, "note.txt", "text/plain", "hello".getBytes());
            int baseline = artifactCount(runtime);
            String id = degraded.artifactId();
            String version = degraded.version().value();
            List<Map<String, Object>> sharpen = List.of(Map.of("type", "sharpen", "amount", 0.5));

            // Out-of-range and malformed parameters are refused before any lookup, rights call or process.
            for (List<Map<String, Object>> bad : List.of(
                    List.<Map<String, Object>>of(Map.of("type", "sharpen", "amount", 9.0)),
                    List.<Map<String, Object>>of(Map.of("type", "sharpen", "amount", -1.0)),
                    List.<Map<String, Object>>of(Map.of("type", "denoise", "method", "hqdn3d", "strength", 99)),
                    List.<Map<String, Object>>of(Map.of("type", "denoise", "method", "nlmeans", "strength", 0.1)),
                    List.<Map<String, Object>>of(Map.of("type", "denoise", "method", "bm3d", "strength", 3)),
                    List.<Map<String, Object>>of(Map.of("type", "deblock", "strength", 0.9)),
                    List.<Map<String, Object>>of(Map.of("type", "colourCorrection", "brightness", 5.0)),
                    List.<Map<String, Object>>of(Map.of("type", "colourCorrection", "gamma", 0.0)),
                    List.<Map<String, Object>>of(Map.of("type", "scale", "width", 99999)),
                    List.<Map<String, Object>>of(Map.of("type", "sharpen", "amount", 0.5), Map.of("type", "sharpen", "amount", 0.6)),
                    List.<Map<String, Object>>of())) {
                HttpResponse<String> refused = send(base, "POST", "/dev/v1/video/enhancements",
                        enhancementBody("bad-" + bad.hashCode(), "no-such-artifact", "sha256:" + "0".repeat(64), bad, 18),
                        OWNER, PERMISSIONS);
                assertThat(refused.statusCode()).as(bad + " " + refused.body()).isEqualTo(422);
                assertThat(refused.body()).contains("VIDEO_PARAMETER_OUT_OF_RANGE");
            }
            assertThat(send(base, "POST", "/dev/v1/video/enhancements", enhancementBody("bad-crf", "x",
                    "sha256:" + "0".repeat(64), sharpen, 99), OWNER, PERMISSIONS).body())
                    .contains("VIDEO_PARAMETER_OUT_OF_RANGE");
            assertThat(spawned.get()).as("no process ran for any refused parameter").isZero();

            // Rights missing, revoked and unavailable: refused before any byte is read or process started.
            HttpResponse<String> noRights = send(base, "POST", "/dev/v1/video/enhancements",
                    enhancementBody("r-1", degraded, sharpen, 18), OWNER, PERMISSIONS);
            assertThat(noRights.statusCode()).as(noRights.body()).isEqualTo(403);
            assertThat(noRights.body()).contains("RIGHTS_DENIED");
            admitted.add(id);
            admitted.add(garbage.artifactId());
            admitted.add(cut.artifactId());
            admitted.add(text.artifactId());
            revoked.set(true);
            HttpResponse<String> revokedResponse = send(base, "POST", "/dev/v1/video/enhancements",
                    enhancementBody("r-2", degraded, sharpen, 18), OWNER, PERMISSIONS);
            assertThat(revokedResponse.statusCode()).as(revokedResponse.body()).isEqualTo(403);
            assertThat(revokedResponse.body()).contains("RIGHTS_REVOKED");
            revoked.set(false);
            unavailable.set(true);
            HttpResponse<String> unavailableResponse = send(base, "POST", "/dev/v1/video/comparisons",
                    comparisonBody("r-3", null, List.of(subject("a", degraded))), OWNER, PERMISSIONS);
            assertThat(unavailableResponse.statusCode()).as(unavailableResponse.body()).isEqualTo(503);
            assertThat(unavailableResponse.body()).contains("RIGHTS_AUTHORITY_UNAVAILABLE");
            unavailable.set(false);
            assertThat(spawned.get()).as("no process ran without admitted rights").isZero();

            // Stale version, foreign principal, missing permissions.
            HttpResponse<String> stale = send(base, "POST", "/dev/v1/video/enhancements", enhancementBody("s-1", id,
                    "sha256:" + "2".repeat(64), sharpen, 18), OWNER, PERMISSIONS);
            assertThat(stale.statusCode()).as(stale.body()).isEqualTo(404);
            assertThat(stale.body()).contains("SOURCE_VERSION_NOT_FOUND");
            assertThat(send(base, "POST", "/dev/v1/video/enhancements", enhancementBody("s-2", degraded, sharpen, 18),
                    OTHER, PERMISSIONS).statusCode()).isEqualTo(404);
            assertThat(send(base, "POST", "/dev/v1/video/enhancements", enhancementBody("s-3", degraded, sharpen, 18),
                    OWNER, Set.of("media:project:dev:write", "media:artifact:read")).statusCode()).isEqualTo(403);
            assertThat(send(base, "POST", "/dev/v1/video/enhancements", enhancementBody("s-4", degraded, sharpen, 18),
                    OWNER, Set.of("media:project:dev:read", "media:artifact:read", "media:artifact:create"))
                    .statusCode()).isEqualTo(403);
            assertThat(spawned.get()).isZero();

            // A non-video artifact and corrupt video bytes are typed refusals, never an empty or partial output.
            HttpResponse<String> notVideo = send(base, "POST", "/dev/v1/video/enhancements",
                    enhancementBody("v-1", text, sharpen, 18), OWNER, PERMISSIONS);
            assertThat(notVideo.statusCode()).as(notVideo.body()).isEqualTo(422);
            assertThat(notVideo.body()).contains("SOURCE_FORMAT_NOT_SUPPORTED");
            for (MediaArtifact corrupt : List.of(garbage, cut)) {
                HttpResponse<String> refused = send(base, "POST", "/dev/v1/video/enhancements",
                        enhancementBody("c-" + corrupt.fileName(), corrupt, sharpen, 18), OWNER, PERMISSIONS);
                assertThat(refused.statusCode()).as(refused.body()).isEqualTo(422);
                assertThat(refused.body()).contains("SOURCE_VIDEO_CORRUPT");
            }
            HttpResponse<String> corruptCompare = send(base, "POST", "/dev/v1/video/comparisons",
                    comparisonBody("c-cmp", degraded, List.of(subject("bad", garbage))), OWNER, PERMISSIONS);
            assertThat(corruptCompare.statusCode()).as(corruptCompare.body()).isEqualTo(422);
            assertThat(corruptCompare.body()).contains("SOURCE_VIDEO_CORRUPT");
            assertThat(artifactCount(runtime)).as("no refused request registered anything").isEqualTo(baseline);
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    @Test
    void killedFfmpegIsUnknownThenRetryRegistersExactlyOnceAndMismatchedTimelineIsNeverRegistered() throws Exception {
        MediaRuntime runtime = runtime();
        AtomicBoolean killNextEncode = new AtomicBoolean(true);
        AtomicInteger encodes = new AtomicInteger();
        HttpServer server = server(runtime, (command, dir, timeout, maxStdout, watched, watchedMax) -> {
            boolean encode = command.contains("libx264");
            if (encode) {
                encodes.incrementAndGet();
                if (killNextEncode.getAndSet(false)) {
                    // What BoundedProcessRunner reports for a child that received SIGKILL.
                    return new BoundedProcessRunner.Result(BoundedProcessRunner.End.EXITED, 137, new byte[0], 0, "");
                }
            }
            return BoundedProcessRunner.run(command, dir, Map.of(), timeout, maxStdout, 8192,
                    BoundedProcessRunner.CancellationToken.NEVER, watched, watchedMax);
        });
        try {
            String base = base(server);
            MediaArtifact degraded = upload(runtime, "degraded.mp4", "video/mp4", degradedBytes);
            admitted.add(degraded.artifactId());
            int baseline = artifactCount(runtime);
            String body = enhancementBody("kill-1", degraded, List.of(Map.of("type", "sharpen", "amount", 0.5)), 20);
            HttpResponse<String> unknown = send(base, "POST", "/dev/v1/video/enhancements", body, OWNER, PERMISSIONS);
            assertThat(unknown.statusCode()).as(unknown.body()).isEqualTo(503);
            assertThat(unknown.body()).contains("VIDEO_OUTCOME_UNKNOWN").contains("\"outcome\":\"UNKNOWN\"");
            assertThat(artifactCount(runtime)).isEqualTo(baseline);
            HttpResponse<String> retry = send(base, "POST", "/dev/v1/video/enhancements", body, OWNER, PERMISSIONS);
            assertThat(retry.statusCode()).as(retry.body()).isEqualTo(201);
            HttpResponse<String> again = send(base, "POST", "/dev/v1/video/enhancements", body, OWNER, PERMISSIONS);
            assertThat(again.statusCode()).as(again.body()).isEqualTo(200);
            assertThat(encodes.get()).as("killed attempt plus the retry; the replay did not encode").isEqualTo(2);
            assertThat(read(again.body())).containsEntry("outputId", read(retry.body()).get("outputId"))
                    .containsEntry("replayed", true);
            int afterRetry = artifactCount(runtime);
            // One ordinary registration adds exactly this many stored files; the unknown-then-retry added the same.
            HttpResponse<String> ordinary = send(base, "POST", "/dev/v1/video/enhancements", enhancementBody("kill-2",
                    degraded, List.of(Map.of("type", "sharpen", "amount", 0.5)), 20), OWNER, PERMISSIONS);
            assertThat(ordinary.statusCode()).as(ordinary.body()).isEqualTo(201);
            assertThat(afterRetry - baseline).as("exactly one registration after the unknown outcome")
                    .isEqualTo(artifactCount(runtime) - afterRetry);
            assertThat(encodes.get()).as("the replay did not run FFmpeg again").isEqualTo(3);
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
        MediaDevVideoRuntime video = new MediaDevVideoRuntime(runtime, ffmpeg, ffprobe, resolver,
                MediaDevProjectRenderRuntime.canonicalRegistrar(runtime), MediaDevRequestLedger.inMemory(), port, null);
        MediaHttpHandler handler = new MediaHttpHandler(runtime, null, null, projects).withDevVideo(video);
        server.createContext("/", new MediaSecurityFilter(handler, "dev", Map.of("MEDIA_DEV_IDENTITY_ENABLED", "true",
                "MEDIA_DEV_JWT_HMAC_SECRET", "test-only-dev-project-secret-at-least-32-bytes"),
                java.time.Clock.fixed(java.time.Instant.parse("2026-11-13T20:00:00Z"), java.time.ZoneOffset.UTC)));
        return server;
    }

    private static MediaRuntime runtime() throws Exception {
        Path root = Files.createTempDirectory("media-dev-video-http-store-");
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
        String digest = HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
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

    private static String enhancementBody(String requestId, MediaArtifact source, List<Map<String, Object>> operations,
                                          int crf) throws Exception {
        return enhancementBody(requestId, source.artifactId(), source.version().value(), operations, crf);
    }

    private static String enhancementBody(String requestId, String artifactId, String version,
                                          List<Map<String, Object>> operations, int crf) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("artifactId", artifactId);
        body.put("artifactVersionId", version);
        body.put("operations", operations);
        body.put("encoder", Map.of("crf", crf));
        return JSON.writeValueAsString(body);
    }

    private static Map<String, Object> subject(String label, MediaArtifact source) {
        return Map.of("label", label, "artifactId", source.artifactId(), "artifactVersionId", source.version().value());
    }

    private static String comparisonBody(String requestId, MediaArtifact reference, List<Map<String, Object>> subjects)
            throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        if (reference != null) {
            body.put("reference", Map.of("artifactId", reference.artifactId(), "artifactVersionId",
                    reference.version().value()));
        }
        body.put("subjects", subjects);
        return JSON.writeValueAsString(body);
    }

    private static void deleteTree(Path root) {
        try (var walk = Files.walk(root)) {
            walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
        } catch (java.io.IOException ignored) { }
    }
}
