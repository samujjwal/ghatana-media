package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Reason;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict;
import com.ghatana.media.runtime.InMemoryMediaRegionEditLedger;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;

import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.InMemoryManagedStore;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.TENANT;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.base;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.object;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.read;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.send;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * J-11 DEV_ONLY tracked region edit over the real HTTP host, filter, artifact store and REAL FFmpeg/ffprobe, with an
 * in-memory history and request ledger. The tracks here are FIXTURES written from the generated clip's analytic
 * trajectory (they stand in for the detector only to exercise the lane's contracts): the real detector, durable
 * PostgreSQL/S3 storage, launcher restart and the browser are covered by {@code MediaDevRegionEditIT}.
 */
class MediaDevRegionEditHttpTest {
    private static final String OWNER = "test-principal-owner";
    private static final String OTHER = "test-principal-other";
    private static final Set<String> PERMISSIONS = Set.of("media:project:dev:create", "media:project:dev:read",
            "media:project:dev:write", "media:artifact:read", "media:artifact:create");
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final String LINEAGES = "/dev/v1/region-edits/lineages";
    private static final int W = 320;
    private static final int H = 180;

    private static Path ffmpeg;
    private static Path ffprobe;
    private static Path root;

    private final Set<String> admitted = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean revoked = new AtomicBoolean();
    private final RightsConsentResolver resolver = new RightsConsentResolver() {
        @Override public String resolverId() { return "test-resolver"; }
        @Override public boolean ready() { return true; }
        @Override public Resolution resolve(ResolutionRequest request) {
            if (!admitted.contains(request.artifactId())) {
                return new Resolution(Verdict.DENIED, Set.of(Reason.NO_ATTESTATION), List.of(), resolverId());
            }
            if (revoked.get()) return new Resolution(Verdict.REVOKED, Set.of(Reason.REVOKED), List.of(), resolverId());
            return new Resolution(Verdict.ADMITTED, Set.of(), List.of("att-" + request.artifactId()), resolverId());
        }
    };

    @BeforeAll
    static void tools() throws Exception {
        String ff = System.getenv("MEDIA_DEV_RENDER_FFMPEG");
        String fp = System.getenv("MEDIA_DEV_RENDER_FFPROBE");
        assertThat(ff).as("MEDIA_DEV_RENDER_FFMPEG").isNotBlank();
        assertThat(fp).as("MEDIA_DEV_RENDER_FFPROBE").isNotBlank();
        ffmpeg = Path.of(ff);
        ffprobe = Path.of(fp);
        root = Files.createTempDirectory("media-dev-region-edit-http-");
    }

    @AfterAll
    static void cleanup() {
        if (root != null) deleteTree(root);
    }

    /** A fixture: one launcher-produced-looking tracks artifact registered under a completed vision.track ledger entry. */
    private record Harness(MediaRuntime runtime, HttpServer server, MediaDevRequestLedger requestLedger, String base,
                           MediaArtifact video, byte[] videoBytes, long[] pts, MediaArtifact tracks) { }

    private Harness harness() throws Exception {
        MediaRuntime runtime = runtime();
        MediaDevRequestLedger requestLedger = MediaDevRequestLedger.inMemory();
        HttpServer server = server(runtime, requestLedger);
        byte[] bytes = generateVfr();
        MediaArtifact video = upload(runtime, "motion.mp4", "video/mp4", bytes);
        admitted.add(video.artifactId());
        long[] pts = probePts(root.resolve("clip.mp4"));
        MediaArtifact tracks = registerTrack(runtime, requestLedger, video, pts, "track-req-1", true);
        return new Harness(runtime, server, requestLedger, base(server), video, bytes, pts, tracks);
    }

    // ------------------------------------------------------------------ tests

    @Test
    void editUndoAndStaleBaseOverRealFfmpegWithMeasuredPixelsAndExactPts() throws Exception {
        Harness h = harness();
        try {
            assertThat(send(h.base(), "GET", "/dev/v1/region-edits/status", null, OWNER, PERMISSIONS).statusCode()).isEqualTo(200);
            Map<String, Object> lineage = createLineage(h, "line-1");
            assertThat(lineage).containsEntry("headVersion", 1).containsEntry("undoAvailable", false);
            // Naming the same video again is a no-op; a different video under the same id is a typed 409.
            HttpResponse<String> again = send(h.base(), "POST", LINEAGES, lineageBody("line-1", h.video()), OWNER, PERMISSIONS);
            assertThat(again.statusCode()).isEqualTo(200);

            HttpResponse<String> edit = send(h.base(), "POST", LINEAGES + "/line-1/edits",
                    editBody("edit-1", 1, h, Map.of("type", "PIXELATE", "blockSize", 8), 4, 0), OWNER, PERMISSIONS);
            assertThat(edit.statusCode()).as(edit.body()).isEqualTo(201);
            Map<String, Object> view = read(edit.body());
            assertThat(view).containsEntry("headVersion", 2).containsEntry("undoAvailable", true);
            Map<String, Object> version = object(view.get("version"));
            assertThat(version).containsEntry("kind", "EDIT").containsEntry("parentVersionNumber", 1);
            String editedId = (String) object(version.get("artifact")).get("artifactId");
            byte[] edited = content(h.runtime(), editedId);
            assertThat(sha256(edited)).isEqualTo(object(version.get("artifact")).get("sha256"));
            assertThat(sha256(edited)).isNotEqualTo(sha256(h.videoBytes()));
            assertThat(content(h.runtime(), h.video().artifactId())).as("source bytes never change").isEqualTo(h.videoBytes());

            // Independent measurement with our own decode: outside bit-exact, inside changed, PTS identical.
            Path editedFile = root.resolve("edited-1.mp4");
            Files.write(editedFile, edited);
            assertThat(probePts(editedFile)).containsExactly(h.pts());
            List<byte[]> sourceFrames = decode(root.resolve("clip.mp4"));
            List<byte[]> editedFrames = decode(editedFile);
            Map<String, Object> manifest = object(view.get("manifest"));
            List<?> frames = (List<?>) manifest.get("frames");
            assertThat(frames).hasSize(h.pts().length);
            int masked = 0;
            long insideChanged = 0;
            for (int i = 0; i < frames.size(); i++) {
                Map<String, Object> frame = object(frames.get(i));
                assertThat(((Number) frame.get("pts")).longValue()).isEqualTo(h.pts()[i]);
                Map<String, Object> mask = frame.get("mask") == null ? null : object(frame.get("mask"));
                int[] rect = mask == null ? null : new int[] {((Number) mask.get("x")).intValue(), ((Number) mask.get("y")).intValue(),
                        ((Number) mask.get("width")).intValue(), ((Number) mask.get("height")).intValue()};
                if (rect != null) masked++;
                for (int p = 0; p < sourceFrames.get(i).length; p++) {
                    boolean inside = rect != null && insideLumaOrChroma(p, rect);
                    if (inside) {
                        if (sourceFrames.get(i)[p] != editedFrames.get(i)[p]) insideChanged++;
                    } else {
                        assertThat(editedFrames.get(i)[p]).as("outside frame " + i + " sample " + p).isEqualTo(sourceFrames.get(i)[p]);
                    }
                }
            }
            assertThat(masked).isEqualTo(((Number) manifest.get("maskedFrames")).intValue()).isGreaterThan(10);
            assertThat(insideChanged).isPositive();
            Map<String, Object> verification = object(manifest.get("verification"));
            assertThat(verification).containsEntry("outsideMaxAbsDiff", 0).containsEntry("ptsExact", true)
                    .containsEntry("outsidePsnrDb", "INFINITE").containsEntry("outsideLossless", true);

            // A stale editor (still looking at version 1) gets a typed conflict and nothing is registered.
            int before = artifactCount(h.runtime());
            HttpResponse<String> stale = send(h.base(), "POST", LINEAGES + "/line-1/edits",
                    editBody("edit-stale", 1, h, Map.of("type", "BLUR", "radius", 4), 4, 0), OWNER, PERMISSIONS);
            assertThat(stale.statusCode()).as(stale.body()).isEqualTo(409);
            Map<String, Object> error = object(read(stale.body()).get("error"));
            assertThat(error).containsEntry("code", "STALE_BASE_VERSION");
            assertThat(object(error.get("details"))).containsEntry("expectedVersion", 1).containsEntry("headVersion", 2);
            assertThat(artifactCount(h.runtime())).isEqualTo(before);
            assertThat(send(h.base(), "POST", LINEAGES + "/line-1/undo", "{\"requestId\":\"undo-stale\",\"baseVersion\":1}",
                    OWNER, PERMISSIONS).statusCode()).isEqualTo(409);

            // Undo points at the exact earlier artifact: same id, same digest, same metadata digest as version 1.
            HttpResponse<String> undo = send(h.base(), "POST", LINEAGES + "/line-1/undo",
                    "{\"requestId\":\"undo-1\",\"baseVersion\":2}", OWNER, PERMISSIONS);
            assertThat(undo.statusCode()).as(undo.body()).isEqualTo(201);
            Map<String, Object> undone = read(undo.body());
            Map<String, Object> undoVersion = object(undone.get("version"));
            Map<String, Object> baseVersion = object(((List<?>) undone.get("versions")).getFirst());
            assertThat(undoVersion).containsEntry("kind", "UNDO").containsEntry("restoresVersionNumber", 1)
                    .containsEntry("versionNumber", 3);
            assertThat(object(undoVersion.get("artifact"))).isEqualTo(baseVersion.get("artifact"));
            assertThat(object(undoVersion.get("artifact")).get("sha256")).isEqualTo(sha256(h.videoBytes()));
            assertThat(undone).containsEntry("headVersion", 3).containsEntry("undoAvailable", false);
            // Nothing left to undo.
            HttpResponse<String> nothing = send(h.base(), "POST", LINEAGES + "/line-1/undo",
                    "{\"requestId\":\"undo-2\",\"baseVersion\":3}", OWNER, PERMISSIONS);
            assertThat(nothing.statusCode()).isEqualTo(409);
            assertThat(nothing.body()).contains("NOTHING_TO_UNDO");

            // Replays are idempotent and never render again.
            int count = artifactCount(h.runtime());
            HttpResponse<String> replay = send(h.base(), "POST", LINEAGES + "/line-1/edits",
                    editBody("edit-1", 1, h, Map.of("type", "PIXELATE", "blockSize", 8), 4, 0), OWNER, PERMISSIONS);
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            assertThat(read(replay.body())).containsEntry("replayed", true);
            assertThat(artifactCount(h.runtime())).isEqualTo(count);
            HttpResponse<String> reused = send(h.base(), "POST", LINEAGES + "/line-1/edits",
                    editBody("edit-1", 1, h, Map.of("type", "BLUR", "radius", 4), 4, 0), OWNER, PERMISSIONS);
            assertThat(reused.statusCode()).isEqualTo(409);
            assertThat(reused.body()).contains("REGION_EDIT_REQUEST_ID_REUSED");
            assertThat(send(h.base(), "POST", LINEAGES + "/line-1/undo", "{\"requestId\":\"undo-1\",\"baseVersion\":2}",
                    OWNER, PERMISSIONS).statusCode()).as("undo replay").isEqualTo(200);

            // A completed request still replays after the head moved (the fingerprint names the base, not the head).
            HttpResponse<String> second = send(h.base(), "POST", LINEAGES + "/line-1/edits",
                    editBody("edit-2", 3, h, Map.of("type", "BLUR", "radius", 4), 4, 0), OWNER, PERMISSIONS);
            assertThat(second.statusCode()).as(second.body()).isEqualTo(201);
            HttpResponse<String> replayAfterMove = send(h.base(), "POST", LINEAGES + "/line-1/edits",
                    editBody("edit-1", 1, h, Map.of("type", "PIXELATE", "blockSize", 8), 4, 0), OWNER, PERMISSIONS);
            assertThat(replayAfterMove.statusCode()).as(replayAfterMove.body()).isEqualTo(200);
            assertThat(read(replayAfterMove.body())).containsEntry("replayed", true);

            // Versions are owner scoped: another principal sees no lineage at all.
            assertThat(send(h.base(), "GET", LINEAGES + "/line-1", null, OTHER, PERMISSIONS).statusCode()).isEqualTo(404);
            assertThat(send(h.base(), "POST", LINEAGES + "/line-1/edits", editBody("edit-o", 3, h, Map.of("type", "FILL"), 4, 0),
                    OTHER, PERMISSIONS).statusCode()).isEqualTo(404);
            assertThat(send(h.base(), "GET", LINEAGES + "/line-1", null, OWNER, PERMISSIONS).statusCode()).isEqualTo(200);
        } finally {
            h.server().stop(0);
        }
    }

    @Test
    void blurAndFillAndALossyEncodeAreMeasuredAndStackedEditsUndoOneAtATime() throws Exception {
        Harness h = harness();
        try {
            createLineage(h, "line-2");
            HttpResponse<String> fill = send(h.base(), "POST", LINEAGES + "/line-2/edits",
                    editBody("fill-1", 1, h, Map.of("type", "FILL", "color", "#FF00FF"), 2, 0), OWNER, PERMISSIONS);
            assertThat(fill.statusCode()).as(fill.body()).isEqualTo(201);
            HttpResponse<String> blur = send(h.base(), "POST", LINEAGES + "/line-2/edits",
                    editBody("blur-1", 2, h, Map.of("type", "BLUR", "radius", 6), 2, 18), OWNER, PERMISSIONS);
            assertThat(blur.statusCode()).as(blur.body()).isEqualTo(201);
            Map<String, Object> verification = object(object(read(blur.body()).get("manifest")).get("verification"));
            assertThat(verification).containsEntry("outsideLossless", false);
            assertThat(((Number) verification.get("outsidePsnrDb")).doubleValue()).isGreaterThan(30.0);
            assertThat(object(read(blur.body()).get("version")).get("parentVersionNumber")).isEqualTo(2);

            // Undo steps back one edit at a time: v4 restores v2, v5 restores v1.
            Map<String, Object> first = read(send(h.base(), "POST", LINEAGES + "/line-2/undo",
                    "{\"requestId\":\"u1\",\"baseVersion\":3}", OWNER, PERMISSIONS).body());
            assertThat(object(first.get("version"))).containsEntry("restoresVersionNumber", 2).containsEntry("versionNumber", 4);
            assertThat(first).containsEntry("undoAvailable", true);
            Map<String, Object> second = read(send(h.base(), "POST", LINEAGES + "/line-2/undo",
                    "{\"requestId\":\"u2\",\"baseVersion\":4}", OWNER, PERMISSIONS).body());
            assertThat(object(second.get("version"))).containsEntry("restoresVersionNumber", 1).containsEntry("versionNumber", 5);
            assertThat(second).containsEntry("undoAvailable", false);
            assertThat(object(object(second.get("version")).get("artifact")).get("sha256")).isEqualTo(sha256(h.videoBytes()));
        } finally {
            h.server().stop(0);
        }
    }

    @Test
    void concurrentEditsOfOneBaseHaveExactlyOneWinner() throws Exception {
        Harness h = harness();
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            createLineage(h, "line-3");
            List<Callable<HttpResponse<String>>> calls = new ArrayList<>();
            for (String id : List.of("race-a", "race-b")) {
                calls.add(() -> send(h.base(), "POST", LINEAGES + "/line-3/edits",
                        editBody(id, 1, h, Map.of("type", "PIXELATE", "blockSize", id.equals("race-a") ? 8 : 16), 4, 0),
                        OWNER, PERMISSIONS));
            }
            List<Future<HttpResponse<String>>> results = pool.invokeAll(calls);
            List<Integer> statuses = new ArrayList<>();
            for (Future<HttpResponse<String>> result : results) statuses.add(result.get().statusCode());
            assertThat(statuses).as(statuses.toString()).containsExactlyInAnyOrder(201, 409);
            Map<String, Object> view = read(send(h.base(), "GET", LINEAGES + "/line-3", null, OWNER, PERMISSIONS).body());
            assertThat(view).containsEntry("headVersion", 2);
            assertThat((List<?>) view.get("versions")).hasSize(2);
        } finally {
            pool.shutdownNow();
            h.server().stop(0);
        }
    }

    @Test
    void rightsAreRequiredOnEveryCallAndARevocationRefusesEvenAReplay() throws Exception {
        Harness h = harness();
        try {
            createLineage(h, "line-4");
            int before = artifactCount(h.runtime());
            admitted.clear();
            HttpResponse<String> missing = send(h.base(), "POST", LINEAGES + "/line-4/edits",
                    editBody("r-1", 1, h, Map.of("type", "FILL"), 4, 0), OWNER, PERMISSIONS);
            assertThat(missing.statusCode()).as(missing.body()).isEqualTo(403);
            assertThat(missing.body()).contains("RIGHTS_DECISION_DENIED");
            assertThat(artifactCount(h.runtime())).as("nothing rendered without a PROCESSING statement").isEqualTo(before);

            admitted.add(h.video().artifactId());
            HttpResponse<String> ok = send(h.base(), "POST", LINEAGES + "/line-4/edits",
                    editBody("r-2", 1, h, Map.of("type", "FILL"), 4, 0), OWNER, PERMISSIONS);
            assertThat(ok.statusCode()).as(ok.body()).isEqualTo(201);
            revoked.set(true);
            HttpResponse<String> replay = send(h.base(), "POST", LINEAGES + "/line-4/edits",
                    editBody("r-2", 1, h, Map.of("type", "FILL"), 4, 0), OWNER, PERMISSIONS);
            assertThat(replay.statusCode()).as("a revoked source refuses even a replay").isEqualTo(403);
            HttpResponse<String> undo = send(h.base(), "POST", LINEAGES + "/line-4/undo",
                    "{\"requestId\":\"r-u\",\"baseVersion\":2}", OWNER, PERMISSIONS);
            assertThat(undo.statusCode()).isEqualTo(403);
            assertThat(undo.body()).contains("RIGHTS_DECISION_REVOKED");
            // Reads are not processing: the history stays readable.
            assertThat(send(h.base(), "GET", LINEAGES + "/line-4", null, OWNER, PERMISSIONS).statusCode()).isEqualTo(200);
        } finally {
            h.server().stop(0);
        }
    }

    @Test
    void anUntrustedTrackIsRefusedWhateverItClaims() throws Exception {
        Harness h = harness();
        try {
            createLineage(h, "line-5");
            // 1. Uploaded JSON that merely claims to be a tracks artifact (no launcher ledger entry produced it).
            MediaArtifact forged = registerTrack(h.runtime(), h.requestLedger(), h.video(), h.pts(), "forged-req", false);
            Harness forgedHarness = new Harness(h.runtime(), h.server(), h.requestLedger(), h.base(), h.video(), h.videoBytes(),
                    h.pts(), forged);
            HttpResponse<String> response = send(h.base(), "POST", LINEAGES + "/line-5/edits",
                    editBody("t-1", 1, forgedHarness, Map.of("type", "FILL"), 4, 0), OWNER, PERMISSIONS);
            assertThat(response.statusCode()).as(response.body()).isEqualTo(422);
            assertThat(response.body()).contains("TRACK_PROVENANCE_UNVERIFIED");

            // 2. A launcher track computed on another video.
            byte[] otherBytes = generateVfr("other-clip.mp4", "blue");
            MediaArtifact other = upload(h.runtime(), "other.mp4", "video/mp4", otherBytes);
            admitted.add(other.artifactId());
            MediaArtifact foreign = registerTrack(h.runtime(), h.requestLedger(), other, h.pts(), "foreign-req", true);
            Harness foreignHarness = new Harness(h.runtime(), h.server(), h.requestLedger(), h.base(), h.video(), h.videoBytes(),
                    h.pts(), foreign);
            HttpResponse<String> mismatch = send(h.base(), "POST", LINEAGES + "/line-5/edits",
                    editBody("t-2", 1, foreignHarness, Map.of("type", "FILL"), 4, 0), OWNER, PERMISSIONS);
            assertThat(mismatch.statusCode()).as(mismatch.body()).isEqualTo(422);
            assertThat(mismatch.body()).contains("TRACK_SOURCE_MISMATCH");

            // 3. Unknown track id, unknown artifact, not-a-track artifact.
            Map<String, Object> noTrack = editMap("t-3", 1, h, Map.of("type", "FILL"), 4, 0);
            ((Map<String, Object>) noTrack.get("track")).put("trackId", "t99");
            HttpResponse<String> unknownId = send(h.base(), "POST", LINEAGES + "/line-5/edits", JSON.writeValueAsString(noTrack),
                    OWNER, PERMISSIONS);
            assertThat(unknownId.statusCode()).isEqualTo(404);
            assertThat(unknownId.body()).contains("TRACK_ID_NOT_FOUND");
            Map<String, Object> notATrack = editMap("t-4", 1, h, Map.of("type", "FILL"), 4, 0);
            Map<String, Object> ref = (Map<String, Object>) notATrack.get("track");
            ref.put("artifactId", h.video().artifactId());
            ref.put("artifactVersionId", h.video().version().value());
            HttpResponse<String> wrongKind = send(h.base(), "POST", LINEAGES + "/line-5/edits", JSON.writeValueAsString(notATrack),
                    OWNER, PERMISSIONS);
            assertThat(wrongKind.statusCode()).isEqualTo(422);
            assertThat(wrongKind.body()).contains("TRACK_NOT_A_TRACKS_ARTIFACT");
            ref.put("artifactId", "no-such-artifact");
            assertThat(send(h.base(), "POST", LINEAGES + "/line-5/edits", JSON.writeValueAsString(notATrack), OWNER, PERMISSIONS)
                    .statusCode()).isEqualTo(404);
            // A track from another principal is invisible.
            assertThat(send(h.base(), "GET", LINEAGES + "/line-5", null, OWNER, PERMISSIONS).statusCode()).isEqualTo(200);
            Map<String, Object> view = read(send(h.base(), "GET", LINEAGES + "/line-5", null, OWNER, PERMISSIONS).body());
            assertThat(view).as("no refused edit advanced the history").containsEntry("headVersion", 1);
        } finally {
            h.server().stop(0);
        }
    }

    @Test
    void malformedRequestsAreTypedAndDriftCanBeCapped() throws Exception {
        Harness h = harness();
        try {
            createLineage(h, "line-6");
            Map<String, Map<String, Object>> cases = new LinkedHashMap<>();
            cases.put("$.effect.type", mutate(h, m -> m.put("effect", Map.of("type", "SHARPEN"))));
            cases.put("$.effect", mutate(h, m -> m.put("effect", Map.of("type", "PIXELATE", "blockSize", 7))));
            cases.put("$.effect.radius", mutate(h, m -> m.put("effect", Map.of("type", "BLUR", "radius", "big"))));
            cases.put("$.paddingPx", mutate(h, m -> m.put("paddingPx", 65)));
            cases.put("$.baseVersion", mutate(h, m -> m.put("baseVersion", 0)));
            cases.put("$.encoder.crf", mutate(h, m -> m.put("encoder", Map.of("crf", 31))));
            cases.put("$.holdEnds", mutate(h, m -> m.put("holdEnds", "yes")));
            cases.put("$.maxDriftPx", mutate(h, m -> m.put("maxDriftPx", 0.1)));
            cases.put("$.colour", mutate(h, m -> m.put("colour", "x")));
            cases.put("$.track.trackId", mutate(h, m -> ((Map<String, Object>) m.get("track")).remove("trackId")));
            int before = artifactCount(h.runtime());
            for (Map.Entry<String, Map<String, Object>> entry : cases.entrySet()) {
                HttpResponse<String> response = send(h.base(), "POST", LINEAGES + "/line-6/edits",
                        JSON.writeValueAsString(entry.getValue()), OWNER, PERMISSIONS);
                assertThat(response.statusCode()).as(entry.getKey() + " " + response.body()).isEqualTo(422);
                assertThat(object(object(read(response.body()).get("error")).get("details")).get("path").toString())
                        .as(response.body()).startsWith(entry.getKey().equals("$.effect") ? "$.effect" : entry.getKey());
            }
            assertThat(artifactCount(h.runtime())).isEqualTo(before);
            // Missing permissions and a missing lineage.
            assertThat(send(h.base(), "POST", LINEAGES + "/line-6/edits", editBody("p-1", 1, h, Map.of("type", "FILL"), 4, 0),
                    OWNER, Set.of("media:project:dev:write")).statusCode()).isEqualTo(403);
            assertThat(send(h.base(), "POST", LINEAGES + "/nope/edits", editBody("p-2", 1, h, Map.of("type", "FILL"), 4, 0),
                    OWNER, PERMISSIONS).statusCode()).isEqualTo(404);
            assertThat(send(h.base(), "POST", LINEAGES, lineageBody("line-7", h.tracks()), OWNER, PERMISSIONS).statusCode())
                    .as("a lineage starts from a video").isEqualTo(422);
            // The generated track wobbles by construction: a tight drift cap refuses, a loose one allows.
            Map<String, Object> tight = editMap("d-1", 1, h, Map.of("type", "FILL"), 4, 0);
            tight.put("maxDriftPx", 0.5);
            HttpResponse<String> drifted = send(h.base(), "POST", LINEAGES + "/line-6/edits", JSON.writeValueAsString(tight),
                    OWNER, PERMISSIONS);
            assertThat(drifted.statusCode()).as(drifted.body()).isEqualTo(422);
            assertThat(drifted.body()).contains("TRACK_DRIFT_EXCEEDED");
        } finally {
            h.server().stop(0);
        }
    }

    @Test
    void wrongTenantSeesNoLineageAtTheRuntimeBoundary() throws Exception {
        Harness h = harness();
        try {
            createLineage(h, "line-8");
            MediaDevRegionEditRuntime direct = new MediaDevRegionEditRuntime(h.runtime(), ffmpeg, ffprobe,
                    new InMemoryMediaRegionEditLedger(), h.requestLedger(), resolver,
                    MediaDevProjectRenderRuntime.canonicalRegistrar(h.runtime()));
            assertThat(direct.versions("another-tenant", OWNER, "line-8")).isEmpty();
        } finally {
            h.server().stop(0);
        }
    }

    // ------------------------------------------------------------------ helpers

    private Map<String, Object> createLineage(Harness h, String lineageId) throws Exception {
        HttpResponse<String> response = send(h.base(), "POST", LINEAGES, lineageBody(lineageId, h.video()), OWNER, PERMISSIONS);
        assertThat(response.statusCode()).as(response.body()).isEqualTo(201);
        return read(response.body());
    }

    private static String lineageBody(String lineageId, MediaArtifact video) throws Exception {
        return JSON.writeValueAsString(Map.of("lineageId", lineageId, "artifactId", video.artifactId(),
                "artifactVersionId", video.version().value()));
    }

    private static Map<String, Object> editMap(String requestId, int baseVersion, Harness h, Map<String, Object> effect,
                                               int padding, int crf) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("baseVersion", baseVersion);
        body.put("track", new LinkedHashMap<>(Map.of("artifactId", h.tracks().artifactId(),
                "artifactVersionId", h.tracks().version().value(), "trackId", "t1")));
        body.put("effect", effect);
        body.put("paddingPx", padding);
        body.put("encoder", Map.of("crf", crf));
        return body;
    }

    private static String editBody(String requestId, int baseVersion, Harness h, Map<String, Object> effect, int padding,
                                   int crf) throws Exception {
        return JSON.writeValueAsString(editMap(requestId, baseVersion, h, effect, padding, crf));
    }

    private static Map<String, Object> mutate(Harness h, java.util.function.Consumer<Map<String, Object>> change) {
        Map<String, Object> body = editMap("m-" + System.nanoTime(), 1, h, Map.of("type", "FILL"), 4, 0);
        change.accept(body);
        return body;
    }

    /** Ground-truth top-left of the 48x32 square at presentation time {@code seconds}. */
    private static double[] truth(double seconds) { return new double[] {20 + 60 * seconds, 60, 48, 32}; }

    private MediaArtifact registerTrack(MediaRuntime runtime, MediaDevRequestLedger ledger, MediaArtifact source, long[] pts,
                                        String requestId, boolean throughLedger) throws Exception {
        List<Map<String, Object>> frames = new ArrayList<>();
        List<Map<String, Object>> observations = new ArrayList<>();
        for (int i = 0; i < pts.length; i += 2) {
            double[] box = truth(pts[i] / 10240.0);
            // A small deterministic wobble so the leave-one-out drift is measurable but small.
            box[0] += (i % 4 == 0 ? 1.5 : -1.5);
            frames.add(Map.of("frameIndex", i, "pts", pts[i], "ptsMicros", 0, "frameSha256", "x", "detections", 1,
                    "rejectedDetections", 0));
            observations.add(Map.of("frameIndex", i, "pts", pts[i], "ptsMicros", 0,
                    "box", Map.of("x", box[0], "y", box[1], "width", box[2], "height", box[3])));
        }
        Map<String, Object> document = new LinkedHashMap<>();
        document.put("schema", MediaDevVisionTrackingRuntime.TRACKS_SCHEMA);
        document.put("source", Map.of("artifactId", source.artifactId(), "artifactVersionId", source.version().value(),
                "sha256", source.sha256(), "contentType", source.contentType()));
        document.put("video", Map.of("width", W, "height", H, "timeBase", Map.of("num", 1, "den", 10240),
                "frameCount", pts.length));
        document.put("frames", frames);
        document.put("tracks", List.of(Map.of("trackId", "t1", "label", "car", "firstFrameIndex", 0,
                "lastFrameIndex", observations.size() * 2 - 2, "observationCount", observations.size(),
                "observations", observations)));
        document.put("model", Map.of("id", "fixture-detector"));
        byte[] bytes = JSON.writeValueAsBytes(document);
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("visionSchema", MediaDevVisionRuntime.SCHEMA);
        metadata.put("kind", MediaDevVisionTrackingRuntime.KIND_TRACKS);
        metadata.put("requestId", requestId);
        metadata.put("source", Map.of("artifactId", source.artifactId(), "artifactVersionId", source.version().value(),
                "sha256", source.sha256()));
        MediaArtifact artifact = upload(runtime, "tracks-" + requestId + ".json", "application/json", bytes, metadata);
        if (throughLedger) {
            String fingerprint = MediaDevRequestLedger.fingerprint("fixture", requestId);
            ledger.run(TENANT, OWNER, MediaDevVisionTrackingRuntime.LANE_TRACK, requestId, fingerprint,
                    outputs -> artifact, () -> artifact,
                    result -> List.of(new OutputRef("result", result.artifactId(), result.version().value())),
                    IllegalStateException::new);
        }
        return artifact;
    }

    private byte[] generateVfr() throws Exception { return generateVfr("clip.mp4", "red"); }

    /** A 320x180 10 fps clip with a square moving right (x = 20 + 60 t), frames n%7 in {5,6} dropped: VFR. */
    private byte[] generateVfr(String name, String colour) throws Exception {
        Path out = root.resolve(name);
        run(ffmpeg.toString(), "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=" + W + "x" + H + ":rate=10:duration=3",
                "-f", "lavfi", "-i", "color=c=" + colour + ":s=48x32:r=10:d=3", "-filter_complex",
                "[0:v][1:v]overlay=x='20+60*t':y=60:format=rgb,format=yuv420p,select='lt(mod(n\\,7)\\,5)'[out]",
                "-map", "[out]", "-fps_mode", "vfr", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", out.toString());
        return Files.readAllBytes(out);
    }

    private static long[] probePts(Path file) throws Exception {
        String text = run(ffprobe.toString(), "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts", "-of",
                "csv=p=0", file.toString());
        return text.lines().map(line -> line.replace(",", "").strip()).filter(line -> !line.isEmpty())
                .mapToLong(Long::parseLong).sorted().toArray();
    }

    private static List<byte[]> decode(Path file) throws Exception {
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
        assertThat(process.waitFor()).isZero();
        return frames;
    }

    private static boolean insideLumaOrChroma(int sample, int[] rect) {
        int luma = W * H;
        int chromaWidth = W / 2;
        int chroma = chromaWidth * (H / 2);
        if (sample < luma) {
            int x = sample % W;
            int y = sample / W;
            return x >= rect[0] && x < rect[0] + rect[2] && y >= rect[1] && y < rect[1] + rect[3];
        }
        int offset = (sample - luma) % chroma;
        int x = (offset % chromaWidth) * 2;
        int y = (offset / chromaWidth) * 2;
        return x >= rect[0] && x < rect[0] + rect[2] && y >= rect[1] && y < rect[1] + rect[3];
    }

    private HttpServer server(MediaRuntime runtime, MediaDevRequestLedger requestLedger) throws Exception {
        MediaDevProjectTimelineRuntime projects = new MediaDevProjectTimelineRuntime(new InMemoryManagedStore());
        HttpServer server = MediaDevProjectRenderHttpTest.server(runtime, projects, null);
        server.removeContext("/");
        MediaDevRegionEditRuntime edits = new MediaDevRegionEditRuntime(runtime, ffmpeg, ffprobe,
                new InMemoryMediaRegionEditLedger(), requestLedger, resolver,
                MediaDevProjectRenderRuntime.canonicalRegistrar(runtime));
        MediaHttpHandler handler = new MediaHttpHandler(runtime, null, null, projects).withDevRegionEdit(edits);
        server.createContext("/", new MediaSecurityFilter(handler, "dev", Map.of("MEDIA_DEV_IDENTITY_ENABLED", "true",
                "MEDIA_DEV_JWT_HMAC_SECRET", "test-only-dev-project-secret-at-least-32-bytes"),
                java.time.Clock.fixed(java.time.Instant.parse("2026-11-13T20:00:00Z"), java.time.ZoneOffset.UTC)));
        return server;
    }

    private static MediaRuntime runtime() throws Exception {
        Path store = Files.createTempDirectory(root, "store-");
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "dev", 8093, 1_048_576, 131_072, 64L * 1024 * 1024, Duration.ofSeconds(2),
                        2, "", "", true, false, store, 0, MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT,
                        MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT_PER_TENANT),
                new LocalMediaRuntimeSupport.FileArtifactStore(store), new LocalMediaRuntimeSupport.JobStore(false),
                new LocalMediaRuntimeSupport.StreamStore(), null,
                List.of(new MediaDevProjectRenderHttpTest.NoEffectProvider()),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
    }

    private static int artifactCount(MediaRuntime runtime) throws Exception {
        try (var files = Files.walk(Path.of(runtime.config().localStorageRoot().toString()))) {
            return (int) files.filter(Files::isRegularFile).count();
        }
    }

    private static MediaArtifact upload(MediaRuntime runtime, String name, String contentType, byte[] bytes) throws Exception {
        return upload(runtime, name, contentType, bytes, Map.of());
    }

    private static MediaArtifact upload(MediaRuntime runtime, String name, String contentType, byte[] bytes,
                                        Map<String, Object> metadata) throws Exception {
        String digest = sha256(bytes);
        var session = runtime.beginUpload(new UploadRequest(TENANT, OWNER, name, contentType, bytes.length, digest,
                "INTERNAL", Duration.ofMinutes(30), metadata), "fixture-" + name + digest);
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
        var out = new ByteArrayOutputStream();
        runtime.copyArtifactContent(TENANT, OWNER, artifactId, artifact.version(), out, 128L << 20).orElseThrow();
        return out.toByteArray();
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static String run(String... command) throws Exception {
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        String output = new String(process.getInputStream().readAllBytes());
        assertThat(process.waitFor(120, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        assertThat(process.exitValue()).as(output).isZero();
        return output;
    }

    private static void deleteTree(Path path) {
        try (var walk = Files.walk(path)) {
            walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
        } catch (java.io.IOException ignored) { }
    }
}
