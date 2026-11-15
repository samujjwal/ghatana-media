package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRightsConsentContracts.Reason;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.CRC32;

import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.TENANT;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.base;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.object;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.read;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.send;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * J-29 DEV_ONLY live sessions over the real HTTP host, filter and artifact store: ordering, reorder window, duplicates,
 * gaps, backpressure, lease expiry, consent revocation, abort, restart recovery (a second runtime over the same spool)
 * and concurrent clients. The stored WAV is decoded and compared with the sent PCM sample for sample. The durable
 * PostgreSQL/S3 path, a real launcher kill and the browser are covered by {@code MediaDevLiveSessionIT}.
 */
class MediaDevLiveSessionHttpTest {
    private static final String OWNER = "test-principal-owner";
    private static final String OTHER = "test-principal-other";
    private static final Set<String> PERMISSIONS = Set.of("media:project:dev:create", "media:project:dev:read",
            "media:project:dev:write", "media:artifact:read", "media:artifact:create");
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final String SESSIONS = "/dev/v1/live-sessions";
    private static final int SAMPLES = 480;
    private static Path root;

    private final Set<String> admitted = ConcurrentHashMap.newKeySet();
    private final Set<String> revokedIds = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean unavailable = new AtomicBoolean();
    private final RightsConsentResolver resolver = new RightsConsentResolver() {
        @Override public String resolverId() { return "test-resolver"; }
        @Override public boolean ready() { return true; }
        @Override public Resolution resolve(ResolutionRequest request) {
            if (unavailable.get()) return Resolution.unavailable(resolverId());
            if (!admitted.contains(request.artifactId())) return new Resolution(Verdict.DENIED, Set.of(Reason.NO_ATTESTATION), List.of(), resolverId());
            if (revokedIds.contains(request.artifactId())) return new Resolution(Verdict.REVOKED, Set.of(Reason.REVOKED), List.of(), resolverId());
            return new Resolution(Verdict.ADMITTED, Set.of(), List.of("att-" + request.artifactId()), resolverId());
        }
    };
    private final List<AutoCloseable> closers = new ArrayList<>();

    @BeforeAll
    static void directory() throws Exception { root = Files.createTempDirectory("media-dev-live-http-"); }

    @AfterAll
    static void cleanup() { if (root != null) deleteTree(root); }

    @AfterEach
    void close() throws Exception {
        for (AutoCloseable closer : closers) closer.close();
        closers.clear();
    }

    // ---------------------------------------------------------------------------------------------- happy path

    @Test
    void orderedAndReorderedFramesStoreExactPcmWithExactPtsAndDuplicatesAreAbsorbed() throws Exception {
        Rig rig = rig(Duration.ofMillis(100), 16L << 20);
        Map<String, Object> created = rig.open("order-1", rig.consent(), 8, 30, 1_000);
        String id = (String) created.get("sessionId");
        assertThat(created).containsEntry("state", "OPEN").containsEntry("ackedThroughSequence", -1);

        int frames = 40;
        // a shuffle inside windows of 6 frames: every frame is late or early by < 8, the stream is never beyond the window
        List<Integer> order = new ArrayList<>();
        for (int base = 0; base < frames; base += 6) {
            List<Integer> chunk = new ArrayList<>();
            for (int i = base; i < Math.min(frames, base + 6); i++) chunk.add(i);
            Collections.shuffle(chunk, new Random(base));
            order.addAll(chunk);
        }
        long startPts = 1_000;
        HttpResponse<String> response = rig.frames(id, OWNER, order, startPts, 0);
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        Map<String, Object> session = object(read(response.body()).get("session"));
        assertThat(session).containsEntry("ackedThroughSequence", frames - 1).containsEntry("bufferedFrames", 0);
        assertThat(((Number) session.get("reorderedFrames")).longValue()).isGreaterThan(0);

        // resend frames that were acknowledged: absorbed, nothing stored twice
        HttpResponse<String> resent = rig.frames(id, OWNER, List.of(3, 4, 5, 39), startPts, 0);
        assertThat(object(read(resent.body())).get("duplicates")).isEqualTo(4);
        assertThat(object(object(read(resent.body())).get("session"))).containsEntry("framesStored", frames);

        HttpResponse<String> eos = rig.post(id + "/eos", OWNER, "{\"finalSequence\":" + (frames - 1) + "}");
        assertThat(eos.statusCode()).as(eos.body()).isEqualTo(201);
        Map<String, Object> done = read(eos.body());
        assertThat(done).containsEntry("state", "COMPLETED");
        Map<String, Object> outputs = object(done.get("outputs"));
        Map<String, Object> wav = object(outputs.get("wav"));
        byte[] stored = rig.content((String) wav.get("artifactId"));
        MediaDevAudioWav.Pcm pcm = MediaDevAudioWav.parse(stored, true);
        assertThat(pcm.sampleRate()).isEqualTo(48_000);
        assertThat(pcm.samples()).isEqualTo(expectedSamples(frames));
        Map<String, Object> index = read(new String(rig.content((String) object(outputs.get("ptsIndex")).get("artifactId")), StandardCharsets.UTF_8));
        assertThat(index).containsEntry("frameCount", frames).containsEntry("startPtsSamples", (int) startPts)
                .containsEntry("pcmSha256", outputs.get("pcmSha256"));
        @SuppressWarnings("unchecked") List<Map<String, Object>> entries = (List<Map<String, Object>>) index.get("frames");
        for (int i = 0; i < frames; i++) {
            assertThat(entries.get(i)).containsEntry("sequence", i).containsEntry("samples", SAMPLES);
            assertThat(((Number) entries.get(i).get("ptsSamples")).longValue()).isEqualTo(startPts + (long) i * SAMPLES);
        }
        // replay and terminal behaviour
        HttpResponse<String> replay = rig.post(id + "/eos", OWNER, "{\"finalSequence\":" + (frames - 1) + "}");
        assertThat(replay.statusCode()).isEqualTo(200);
        assertThat(object(object(read(replay.body()).get("outputs")).get("wav"))).containsEntry("artifactId", wav.get("artifactId"));
        HttpResponse<String> late = rig.frames(id, OWNER, List.of(40), startPts, 0);
        assertThat(late.statusCode()).isEqualTo(410);
        assertThat(late.body()).contains("SESSION_COMPLETED");
        // the same requestId replays the session; a different request with that id is a conflict
        assertThat(rig.post("", OWNER, rig.openBody("order-1", rig.consent(), 8, 30, 1_000)).statusCode()).isEqualTo(409);
    }

    // ---------------------------------------------------------------------------------------------- stream faults

    @Test
    void gapsWindowDuplicatesAndCorruptionAreTypedAndNothingBadIsStored() throws Exception {
        Rig rig = rig(Duration.ofMillis(100), 16L << 20);
        String id = (String) rig.open("faults-1", rig.consent(), 4, 30, 0).get("sessionId");
        assertThat(rig.frames(id, OWNER, List.of(0, 1, 3), 0, 0).statusCode()).isEqualTo(200); // seq 2 missing

        Map<String, Object> state = read(rig.get(id, OWNER).body());
        assertThat(state).containsEntry("ackedThroughSequence", 1).containsEntry("bufferedFrames", 1);
        assertThat(state.get("missingSequences")).isEqualTo(List.of(2));
        HttpResponse<String> gap = rig.post(id + "/eos", OWNER, "{\"finalSequence\":3}");
        assertThat(gap.statusCode()).isEqualTo(409);
        assertThat(gap.body()).contains("EOS_GAP").contains("\"missingSequences\":[2]");
        assertThat(rig.get(id, OWNER).body()).contains("\"state\":\"OPEN\"");

        HttpResponse<String> beyond = rig.frames(id, OWNER, List.of(6), 0, 0); // next expected 2, window 4: 6 is 4 ahead
        assertThat(beyond.statusCode()).isEqualTo(409);
        assertThat(beyond.body()).contains("SEQUENCE_WINDOW_EXCEEDED");
        assertThat(object(read(rig.get(id, OWNER).body())).get("bufferedFrames")).isEqualTo(1);

        // conflicting duplicate of a stored frame and of a held frame
        assertThat(rig.rawFrames(id, OWNER, List.of(rig.record(1, 480L, rig.payload(99), 0, true))).body()).contains("DUPLICATE_SEQUENCE_CONFLICT");
        assertThat(rig.rawFrames(id, OWNER, List.of(rig.record(3, 3L * SAMPLES, rig.payload(98), 0, true))).body()).contains("DUPLICATE_SEQUENCE_CONFLICT");
        // corrupt CRC, wrong PTS, wrong size: refused, not stored
        assertThat(rig.rawFrames(id, OWNER, List.of(rig.record(2, 2L * SAMPLES, rig.payload(2), 1, false))).body()).contains("FRAME_CRC_MISMATCH");
        assertThat(rig.rawFrames(id, OWNER, List.of(rig.record(2, 7, rig.payload(2), 0, true))).body()).contains("PTS_MISMATCH");
        HttpResponse<String> wrongSize = rig.rawFrames(id, OWNER, List.of(rig.record(2, 2L * SAMPLES, new byte[10], 0, true)));
        assertThat(wrongSize.statusCode()).isEqualTo(422);
        assertThat(wrongSize.body()).contains("FRAME_SIZE_INVALID");
        assertThat(object(read(rig.get(id, OWNER).body())).get("ackedThroughSequence")).isEqualTo(1);

        // a request cut inside a frame keeps the complete frames before it and discards the partial one
        byte[] two = concat(rig.record(2, 2L * SAMPLES, rig.payload(2), 0, true), rig.record(4, 4L * SAMPLES, rig.payload(4), 0, true));
        HttpResponse<String> cut = rig.rawBytes(id, OWNER, Arrays.copyOf(two, two.length - 100));
        assertThat(cut.statusCode()).isEqualTo(400);
        assertThat(cut.body()).contains("FRAME_TRUNCATED");
        Map<String, Object> afterCut = read(rig.get(id, OWNER).body());
        assertThat(afterCut).containsEntry("ackedThroughSequence", 3); // 2 written, then 3 drained from the buffer
        assertThat(rig.frames(id, OWNER, List.of(4), 0, 0).statusCode()).isEqualTo(200);
        assertThat(rig.post(id + "/eos", OWNER, "{\"finalSequence\":2}").body()).contains("EOS_BEFORE_RECEIVED_FRAMES");
        assertThat(rig.post(id + "/eos", OWNER, "{\"finalSequence\":4}").statusCode()).isEqualTo(201);
        assertThat(MediaDevAudioWav.parse(rig.content(storedWav(rig, id)), true).samples()).isEqualTo(expectedSamples(5));
    }

    @Test
    void emptyStreamUnknownFieldsAndForeignPrincipalsAreRefused() throws Exception {
        Rig rig = rig(Duration.ofMillis(100), 16L << 20);
        String id = (String) rig.open("misc-1", rig.consent(), 4, 30, 0).get("sessionId");
        assertThat(rig.post(id + "/eos", OWNER, "{\"finalSequence\":0}").body()).contains("EOS_GAP");
        assertThat(rig.post(id + "/eos", OWNER, "{\"finalSequence\":0,\"extra\":1}").statusCode()).isEqualTo(422);
        assertThat(rig.post("", OWNER, "{\"requestId\":\"x\",\"consent\":{\"artifactId\":\"a\"}}").statusCode()).isEqualTo(422);
        assertThat(rig.get(id, OTHER).statusCode()).as("another principal of the tenant").isEqualTo(404);
        assertThat(rig.frames(id, OTHER, List.of(0), 0, 0).statusCode()).isEqualTo(404);
        assertThat(rig.post(id + "/abort", OTHER, "").statusCode()).isEqualTo(404);
        HttpResponse<String> noPermission = send(rig.base, "GET", SESSIONS + "/" + id, null, OWNER, Set.of("media:project:dev:read"));
        assertThat(noPermission.statusCode()).isEqualTo(403);
        assertThat(rig.get("ls-doesnotexist", OWNER).statusCode()).isEqualTo(404);
    }

    // ---------------------------------------------------------------------------------------------- consent

    @Test
    void consentIsRequiredAndRevokingItStopsTheSessionWithinTheBoundAndStoresNothing() throws Exception {
        Rig rig = rig(Duration.ofMillis(100), 16L << 20);
        MediaArtifact unattested = rig.upload("noconsent.txt", "text/plain", "x".getBytes(StandardCharsets.UTF_8));
        HttpResponse<String> denied = rig.post("", OWNER, rig.openBody("denied-1", unattested, 4, 30, 0));
        assertThat(denied.statusCode()).isEqualTo(403);
        assertThat(denied.body()).contains("RIGHTS_NOT_ADMITTED");
        MediaArtifact consent = rig.consent();
        unavailable.set(true);
        assertThat(rig.post("", OWNER, rig.openBody("unavailable-1", consent, 4, 30, 0)).statusCode()).isEqualTo(503);
        unavailable.set(false);

        String id = (String) rig.open("revoke-1", consent, 4, 30, 0).get("sessionId");
        assertThat(rig.frames(id, OWNER, List.of(0, 1, 2), 0, 0).statusCode()).isEqualTo(200);
        int artifactsBefore = artifactCount(rig.runtime);
        long started = System.nanoTime();
        revokedIds.add(consent.artifactId());
        // no request is made: the watcher alone observes the revocation
        Map<String, Object> state = Map.of();
        while (System.nanoTime() - started < Duration.ofSeconds(5).toNanos()) {
            state = read(rig.get(id, OWNER).body());
            if ("REVOKED".equals(state.get("state"))) break;
            Thread.sleep(10);
        }
        long millis = (System.nanoTime() - started) / 1_000_000;
        System.out.printf("J29-UNIT revocation observed after %d ms (poll 100 ms)%n", millis);
        assertThat(state).containsEntry("state", "REVOKED").containsEntry("terminalCode", "CONSENT_REVOKED");
        assertThat(millis).isLessThan(1_000);
        HttpResponse<String> afterwards = rig.frames(id, OWNER, List.of(3), 0, 0);
        assertThat(afterwards.statusCode()).isEqualTo(410);
        assertThat(afterwards.body()).contains("SESSION_REVOKED");
        assertThat(rig.post(id + "/eos", OWNER, "{\"finalSequence\":2}").statusCode()).isEqualTo(410);
        assertThat(artifactCount(rig.runtime)).as("nothing after (or before) revocation is persisted").isEqualTo(artifactsBefore);
        assertThat(Files.exists(rig.dir.resolve(id).resolve("frames.spool"))).as("the received media was destroyed").isFalse();
        // a session whose subject is revoked cannot be opened again
        assertThat(rig.post("", OWNER, rig.openBody("revoke-2", consent, 4, 30, 0)).statusCode()).isEqualTo(403);
    }

    @Test
    void revocationBetweenTheLastFrameAndEndOfStreamIsCaughtByTheFreshDecision() throws Exception {
        Rig rig = rig(Duration.ofSeconds(30), 16L << 20); // the poll is too slow to matter: only the EOS decision can catch it
        MediaArtifact consent = rig.consent();
        String id = (String) rig.open("late-revoke", consent, 4, 30, 0).get("sessionId");
        assertThat(rig.frames(id, OWNER, List.of(0, 1, 2), 0, 0).statusCode()).isEqualTo(200);
        int artifactsBefore = artifactCount(rig.runtime);
        revokedIds.add(consent.artifactId());
        HttpResponse<String> eos = rig.post(id + "/eos", OWNER, "{\"finalSequence\":2}");
        assertThat(eos.statusCode()).isEqualTo(410);
        assertThat(eos.body()).contains("SESSION_REVOKED");
        assertThat(artifactCount(rig.runtime)).isEqualTo(artifactsBefore);
    }

    @Test
    void anUnreachableConsentAuthorityFailsClosedWithoutDestroyingTheSession() throws Exception {
        Rig rig = rig(Duration.ofMillis(60), 16L << 20);
        String id = (String) rig.open("unavail-1", rig.consent(), 4, 30, 0).get("sessionId");
        assertThat(rig.frames(id, OWNER, List.of(0), 0, 0).statusCode()).isEqualTo(200);
        unavailable.set(true);
        Thread.sleep(250);
        HttpResponse<String> refused = rig.frames(id, OWNER, List.of(1), 0, 0);
        assertThat(refused.statusCode()).isEqualTo(503);
        assertThat(refused.body()).contains("RIGHTS_AUTHORITY_UNAVAILABLE");
        assertThat(rig.post(id + "/eos", OWNER, "{\"finalSequence\":0}").statusCode()).isEqualTo(503);
        unavailable.set(false);
        Thread.sleep(250);
        assertThat(rig.frames(id, OWNER, List.of(1), 0, 0).statusCode()).as("recovers once consent is confirmable again").isEqualTo(200);
        assertThat(rig.post(id + "/eos", OWNER, "{\"finalSequence\":1}").statusCode()).isEqualTo(201);
    }

    // ---------------------------------------------------------------------------------------------- lease, abort

    @Test
    void anExpiredLeaseEndsTheSessionTypedAndAnAbortDiscardsEverything() throws Exception {
        Rig rig = rig(Duration.ofMillis(100), 16L << 20);
        MediaArtifact consent = rig.consent();
        String id = (String) rig.open("lease-1", consent, 4, 1, 0).get("sessionId");
        assertThat(rig.frames(id, OWNER, List.of(0, 1), 0, 0).statusCode()).isEqualTo(200);
        int artifactsBefore = artifactCount(rig.runtime);
        Thread.sleep(300);
        assertThat(rig.frames(id, OWNER, List.of(2), 0, 0).statusCode()).as("the lease is renewed by activity").isEqualTo(200);
        Thread.sleep(1_700);
        Map<String, Object> state = read(rig.get(id, OWNER).body());
        assertThat(state).containsEntry("state", "EXPIRED").containsEntry("terminalCode", "LEASE_EXPIRED");
        HttpResponse<String> late = rig.frames(id, OWNER, List.of(3), 0, 0);
        assertThat(late.statusCode()).isEqualTo(410);
        assertThat(late.body()).contains("SESSION_EXPIRED");
        assertThat(rig.post(id + "/eos", OWNER, "{\"finalSequence\":2}").statusCode()).isEqualTo(410);
        assertThat(artifactCount(rig.runtime)).isEqualTo(artifactsBefore);

        String abortId = (String) rig.open("abort-1", consent, 4, 30, 0).get("sessionId");
        assertThat(rig.frames(abortId, OWNER, List.of(0, 1), 0, 0).statusCode()).isEqualTo(200);
        HttpResponse<String> aborted = rig.post(abortId + "/abort", OWNER, "");
        assertThat(aborted.statusCode()).isEqualTo(200);
        assertThat(read(aborted.body())).containsEntry("state", "ABORTED");
        assertThat(rig.post(abortId + "/abort", OWNER, "").statusCode()).as("idempotent").isEqualTo(200);
        assertThat(rig.post(abortId + "/eos", OWNER, "{\"finalSequence\":1}").statusCode()).isEqualTo(410);
        assertThat(Files.exists(rig.dir.resolve(abortId).resolve("frames.spool"))).isFalse();
        assertThat(artifactCount(rig.runtime)).isEqualTo(artifactsBefore);
    }

    // ---------------------------------------------------------------------------------------------- backpressure

    @Test
    void theSharedReorderBufferIsBoundedAndAFullBufferIsATypedRetryableOutcome() throws Exception {
        Rig rig = rig(Duration.ofMillis(100), 64L * 1024);
        String id = (String) rig.open("bp-1", rig.consent(), 64, 30, 0).get("sessionId"); // frame = 960 bytes
        // seq 0 withheld: frames 1..63 are held; 63 * 960 = 60 KB fits; a second session fills the rest of the 64 KiB
        String other = (String) rig.open("bp-2", rig.consent(), 64, 30, 0).get("sessionId");
        List<Integer> held = new ArrayList<>();
        for (int i = 1; i < 64; i++) held.add(i);
        assertThat(rig.frames(id, OWNER, held, 0, 0).statusCode()).isEqualTo(200);
        HttpResponse<String> full = rig.frames(other, OWNER, held, 0, 0);
        assertThat(full.statusCode()).isEqualTo(429);
        assertThat(full.body()).contains("BACKPRESSURE_SLOW_CONSUMER").contains("retryAfterMillis");
        Map<String, Object> view = errorSession(full.body());
        assertThat(((Number) view.get("backpressureRefusals")).intValue()).isEqualTo(1);
        int heldInOther = ((Number) view.get("bufferedFrames")).intValue();
        assertThat(heldInOther).isLessThan(63);
        // memory is bounded: the buffered bytes never exceed the budget
        Map<String, Object> status = read(send(rig.base, "GET", SESSIONS + "/status", null, OWNER, PERMISSIONS).body());
        assertThat(((Number) status.get("reorderBufferBytesInUse")).longValue()).isLessThanOrEqualTo(64L * 1024);
        // filling the gap drains the first session and frees the budget; the retry then succeeds
        assertThat(rig.frames(id, OWNER, List.of(0), 0, 0).statusCode()).isEqualTo(200);
        assertThat(object(read(rig.get(id, OWNER).body())).get("ackedThroughSequence")).isEqualTo(63);
        assertThat(rig.frames(other, OWNER, List.of(0), 0, 0).statusCode()).isEqualTo(200);
        List<Integer> rest = new ArrayList<>();
        for (int i = heldInOther + 1; i < 64; i++) rest.add(i);
        assertThat(rig.frames(other, OWNER, rest, 0, 0).statusCode()).isEqualTo(200);
        assertThat(object(read(rig.get(other, OWNER).body())).get("ackedThroughSequence")).isEqualTo(63);
        assertThat(((Number) read(send(rig.base, "GET", SESSIONS + "/status", null, OWNER, PERMISSIONS).body())
                .get("reorderBufferBytesInUse")).longValue()).isZero();
    }

    @Test
    void aSlowSpoolIsATypedSlowConsumerOutcomeForAConcurrentRequest() throws Exception {
        Rig rig = rig(Duration.ofMillis(100), 16L << 20);
        String id = (String) rig.open("slow-1", rig.consent(), 4, 30, 0).get("sessionId");
        AtomicBoolean slow = new AtomicBoolean(true);
        java.util.concurrent.CountDownLatch inside = new java.util.concurrent.CountDownLatch(1);
        rig.live.beforeSpoolWrite = () -> {
            if (slow.compareAndSet(true, false)) {
                inside.countDown();
                try { Thread.sleep(3_500); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            }
        };
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<HttpResponse<String>> first = pool.submit(() -> rig.frames(id, OWNER, List.of(0), 0, 0));
            assertThat(inside.await(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            HttpResponse<String> second = rig.frames(id, OWNER, List.of(1), 0, 0);
            assertThat(second.statusCode()).isEqualTo(503);
            assertThat(second.body()).contains("BACKPRESSURE_SLOW_CONSUMER");
            assertThat(second.headers().firstValue("Retry-After")).isPresent();
            assertThat(first.get().statusCode()).isEqualTo(200);
        } finally { pool.shutdownNow(); }
        assertThat(rig.frames(id, OWNER, List.of(1), 0, 0).statusCode()).isEqualTo(200);
        assertThat(object(read(rig.get(id, OWNER).body())).get("ackedThroughSequence")).isEqualTo(1);
    }

    // ---------------------------------------------------------------------------------------------- restart

    @Test
    void aRestartResumesFromTheAcknowledgedPrefixWithoutDuplicatesAndCutsATornTail() throws Exception {
        Rig rig = rig(Duration.ofMillis(100), 16L << 20);
        MediaArtifact consent = rig.consent();
        String id = (String) rig.open("restart-1", consent, 8, 30, 480).get("sessionId");
        assertThat(rig.frames(id, OWNER, List.of(0, 1, 2, 3, 4, 5, 7), 480, 0).statusCode()).isEqualTo(200); // 6 missing, 7 held
        Path spool = rig.dir.resolve(id).resolve("frames.spool");
        rig.stop(); // the launcher goes away; a half-written record is left at the end of the spool
        Files.write(spool, new byte[] {0, 0, 0, 0, 0, 0, 0, 6, 1, 2, 3, 4, 5}, java.nio.file.StandardOpenOption.APPEND);

        Rig again = rig(Duration.ofMillis(100), 16L << 20, rig.dir, rig.runtime);
        Map<String, Object> state = read(again.get(id, OWNER).body());
        assertThat(state).containsEntry("state", "OPEN").containsEntry("recovered", true).containsEntry("ackedThroughSequence", 5)
                .containsEntry("bufferedFrames", 0);
        assertThat(((Number) state.get("recoveries")).intValue()).isEqualTo(1);
        assertThat(again.frames(id, OWNER, List.of(3, 4, 5, 6, 7, 8, 9), 480, 0).statusCode()).isEqualTo(200); // 3..5 are duplicates
        assertThat(again.post(id + "/eos", OWNER, "{\"finalSequence\":9}").statusCode()).isEqualTo(201);
        MediaDevAudioWav.Pcm pcm = MediaDevAudioWav.parse(again.content(storedWav(again, id)), true);
        assertThat(pcm.samples()).as("no duplicate or missing frame across the restart").isEqualTo(expectedSamples(10));
        // the same requestId after the restart replays the session; an unknown or destroyed session is a typed 404
        assertThat(again.post("", OWNER, again.openBody("restart-1", consent, 8, 30, 480)).statusCode()).isEqualTo(200);
        assertThat(again.get("ls-neverexisted", OWNER).statusCode()).isEqualTo(404);
    }

    @Test
    void aRestartDuringFinalizationIsFinalizingNotCompletedAndRepeatingEndOfStreamCompletesItOnce() throws Exception {
        Rig rig = rig(Duration.ofMillis(100), 16L << 20);
        String id = (String) rig.open("fin-1", rig.consent(), 8, 30, 0).get("sessionId");
        assertThat(rig.frames(id, OWNER, List.of(0, 1, 2, 3), 0, 0).statusCode()).isEqualTo(200);
        // registration fails once: the session stays FINALIZING and is never reported completed
        rig.failRegistrations.set(true);
        HttpResponse<String> failed = rig.post(id + "/eos", OWNER, "{\"finalSequence\":3}");
        assertThat(failed.statusCode()).isEqualTo(502);
        assertThat(failed.body()).contains("LIVE_OUTPUT_REGISTRATION_FAILED");
        assertThat(read(rig.get(id, OWNER).body())).containsEntry("state", "FINALIZING");
        assertThat(rig.frames(id, OWNER, List.of(4), 0, 0).statusCode()).isEqualTo(409);
        rig.stop();
        Rig again = rig(Duration.ofMillis(100), 16L << 20, rig.dir, rig.runtime);
        assertThat(read(again.get(id, OWNER).body())).containsEntry("state", "FINALIZING").containsEntry("recovered", true);
        int before = artifactCount(again.runtime);
        HttpResponse<String> completed = again.post(id + "/eos", OWNER, "{\"finalSequence\":3}");
        assertThat(completed.statusCode()).as(completed.body()).isEqualTo(201);
        assertThat(artifactCount(again.runtime) - before).as("exactly one WAV and one index (two store files each)").isEqualTo(4);
        assertThat(again.post(id + "/eos", OWNER, "{\"finalSequence\":3}").statusCode()).isEqualTo(200);
        assertThat(artifactCount(again.runtime) - before).isEqualTo(4);
    }

    // ---------------------------------------------------------------------------------------------- concurrency

    @Test
    void sixteenConcurrentClientsEachStoreTheirOwnExactStream() throws Exception {
        Rig rig = rig(Duration.ofMillis(100), 16L << 20);
        int clients = 16;
        int frames = 100;
        ExecutorService pool = Executors.newFixedThreadPool(clients);
        try {
            List<Future<String>> results = new ArrayList<>();
            for (int c = 0; c < clients; c++) {
                final int client = c;
                results.add(pool.submit(() -> {
                    String principal = "test-principal-c" + client;
                    MediaArtifact consent = rig.consentFor(principal);
                    String id = (String) read(rig.post("", principal, rig.openBody("conc-" + client, consent, 8, 30, 0)).body()).get("sessionId");
                    for (int base = 0; base < frames; base += 20) {
                        List<Integer> chunk = new ArrayList<>();
                        for (int i = base; i < base + 20; i++) chunk.add(i);
                        Collections.shuffle(chunk.subList(0, 4), new Random(client * 1000L + base));
                        HttpResponse<String> response = rig.frames(id, principal, chunk, 0, client);
                        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
                    }
                    HttpResponse<String> eos = rig.post(id + "/eos", principal, "{\"finalSequence\":" + (frames - 1) + "}");
                    assertThat(eos.statusCode()).as(eos.body()).isEqualTo(201);
                    Map<String, Object> wav = object(object(read(eos.body()).get("outputs")).get("wav"));
                    MediaDevAudioWav.Pcm pcm = MediaDevAudioWav.parse(rig.contentAs(principal, (String) wav.get("artifactId")), true);
                    assertThat(pcm.samples()).isEqualTo(expectedSamples(frames, client));
                    return (String) wav.get("sha256");
                }));
            }
            Set<String> digests = new java.util.HashSet<>();
            for (Future<String> result : results) digests.add(result.get());
            assertThat(digests).as("each client has its own distinct stored stream").hasSize(clients);
        } finally { pool.shutdownNow(); }
    }

    // ---------------------------------------------------------------------------------------------- rig

    private static Map<String, Object> errorSession(String body) throws Exception {
        return object(object(object(read(body).get("error")).get("details")).get("session"));
    }

    private static short[] expectedSamples(int frames) { return expectedSamples(frames, 0); }

    private static short[] expectedSamples(int frames, int client) {
        short[] out = new short[frames * SAMPLES];
        for (int f = 0; f < frames; f++) {
            ByteBuffer bytes = ByteBuffer.wrap(payload(f, client)).order(ByteOrder.LITTLE_ENDIAN);
            for (int i = 0; i < SAMPLES; i++) out[f * SAMPLES + i] = bytes.getShort();
        }
        return out;
    }

    /** Deterministic PCM16LE for (client, frame): a frame-specific tone so a swapped or repeated frame is visible. */
    static byte[] payload(int frame, int client) {
        ByteBuffer out = ByteBuffer.allocate(SAMPLES * 2).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < SAMPLES; i++) {
            double t = (double) frame * SAMPLES + i;
            out.putShort((short) Math.round(12000 * Math.sin(2 * Math.PI * (220 + 20 * client) * t / 48_000.0 + frame * 0.1)));
        }
        return out.array();
    }

    private static byte[] concat(byte[]... parts) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] part : parts) out.writeBytes(part);
        return out.toByteArray();
    }

    private String storedWav(Rig rig, String id) throws Exception {
        return (String) object(object(read(rig.get(id, OWNER).body()).get("outputs")).get("wav")).get("artifactId");
    }

    private Rig rig(Duration poll, long budget) throws Exception {
        return rig(poll, budget, Files.createTempDirectory(root, "live-"), null);
    }

    private Rig rig(Duration poll, long budget, Path dir, MediaRuntime existing) throws Exception {
        Path store = existing == null ? Files.createTempDirectory(root, "store-") : null;
        MediaRuntime runtime = existing != null ? existing : MediaDevProjectRenderHttpTest.runtime(store, 4, 4);
        AtomicBoolean failRegistrations = new AtomicBoolean();
        var delegate = MediaDevProjectRenderRuntime.canonicalRegistrar(runtime);
        MediaDevProjectRenderRuntime.OutputRegistrar registrar = (tenant, principal, request, key, bytes) -> {
            if (failRegistrations.get() && key.startsWith("dev-live:")) throw new IllegalStateException("injected registration failure");
            return delegate.register(tenant, principal, request, key, bytes);
        };
        MediaDevLiveSessionRuntime live = new MediaDevLiveSessionRuntime(runtime, resolver, registrar,
                new MediaDevLiveSessionRuntime.Config(dir, budget, poll.toMillis(), 256, 16L << 20), Clock.systemUTC());
        MediaDevProjectTimelineRuntime projects = new MediaDevProjectTimelineRuntime(new MediaDevProjectRenderHttpTest.InMemoryManagedStore());
        HttpServer server = MediaDevProjectRenderHttpTest.server(runtime, projects, null);
        server.removeContext("/");
        MediaHttpHandler handler = new MediaHttpHandler(runtime, null, null, projects).withDevLiveSessions(live);
        server.createContext("/", new MediaSecurityFilter(handler, "dev", Map.of("MEDIA_DEV_IDENTITY_ENABLED", "true",
                "MEDIA_DEV_JWT_HMAC_SECRET", "test-only-dev-project-secret-at-least-32-bytes"),
                Clock.fixed(java.time.Instant.parse("2026-11-13T20:00:00Z"), java.time.ZoneOffset.UTC)));
        Rig rig = new Rig(runtime, live, server, dir, failRegistrations);
        closers.add(rig::stop);
        return rig;
    }

    private static int artifactCount(MediaRuntime runtime) throws Exception {
        try (var files = Files.walk(Path.of(runtime.config().localStorageRoot().toString()))) {
            return (int) files.filter(Files::isRegularFile).count();
        }
    }

    private final class Rig {
        final MediaRuntime runtime;
        final MediaDevLiveSessionRuntime live;
        final HttpServer server;
        final String base;
        final Path dir;
        final AtomicBoolean failRegistrations;
        private boolean stopped;

        Rig(MediaRuntime runtime, MediaDevLiveSessionRuntime live, HttpServer server, Path dir, AtomicBoolean fail) {
            this.runtime = runtime; this.live = live; this.server = server; this.base = base(server); this.dir = dir; this.failRegistrations = fail;
        }

        void stop() {
            if (stopped) return;
            stopped = true;
            server.stop(0);
            live.close();
        }

        MediaArtifact consent() throws Exception { return consentFor(OWNER); }

        MediaArtifact consentFor(String principal) throws Exception {
            byte[] bytes = ("consent subject for " + principal + " " + java.util.UUID.randomUUID()).getBytes(StandardCharsets.UTF_8);
            MediaArtifact artifact = upload(principal, "consent.txt", "text/plain", bytes);
            admitted.add(artifact.artifactId());
            return artifact;
        }

        MediaArtifact upload(String name, String contentType, byte[] bytes) throws Exception { return upload(OWNER, name, contentType, bytes); }

        MediaArtifact upload(String principal, String name, String contentType, byte[] bytes) throws Exception {
            String digest = HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
            var session = runtime.beginUpload(new UploadRequest(TENANT, principal, name, contentType, bytes.length, digest,
                    "INTERNAL", Duration.ofMinutes(30), Map.of()), "fixture-" + principal + digest);
            runtime.appendChunk(TENANT, principal, session.uploadId(), 0, bytes);
            return runtime.completeUpload(TENANT, principal, session.uploadId());
        }

        String openBody(String requestId, MediaArtifact consent, int window, int lease, long startPts) throws Exception {
            return JSON.writeValueAsString(Map.of("requestId", requestId, "consent", Map.of("artifactId", consent.artifactId(),
                    "artifactVersionId", consent.version().value(), "scope", "PROCESSING"),
                    "format", Map.of("sampleRate", 48_000, "channels", 1, "samplesPerFrame", SAMPLES),
                    "startPtsSamples", startPts, "reorderWindowFrames", window, "leaseSeconds", lease));
        }

        Map<String, Object> open(String requestId, MediaArtifact consent, int window, int lease, long startPts) throws Exception {
            HttpResponse<String> response = post("", OWNER, openBody(requestId, consent, window, lease, startPts));
            assertThat(response.statusCode()).as(response.body()).isEqualTo(201);
            return read(response.body());
        }

        HttpResponse<String> post(String suffix, String principal, String body) throws Exception {
            return send(base, "POST", suffix.isEmpty() ? SESSIONS : SESSIONS + "/" + suffix, body == null || body.isEmpty() ? null : body, principal, PERMISSIONS);
        }

        HttpResponse<String> get(String id, String principal) throws Exception {
            return send(base, "GET", SESSIONS + "/" + id, null, principal, PERMISSIONS);
        }

        byte[] record(long sequence, long pts, byte[] payload, int crcOverride, boolean computeCrc) {
            CRC32 crc = new CRC32();
            crc.update(payload);
            ByteBuffer out = ByteBuffer.allocate(24 + payload.length).order(ByteOrder.BIG_ENDIAN);
            out.putLong(sequence).putLong(pts).putInt(payload.length).putInt(computeCrc ? (int) crc.getValue() : crcOverride).put(payload);
            return out.array();
        }

        byte[] payload(int frame) { return MediaDevLiveSessionHttpTest.payload(frame, 0); }

        HttpResponse<String> frames(String id, String principal, List<Integer> sequences, long startPts, int client) throws Exception {
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            for (int seq : sequences) body.writeBytes(record(seq, startPts + (long) seq * SAMPLES, MediaDevLiveSessionHttpTest.payload(seq, client), 0, true));
            return rawBytes(id, principal, body.toByteArray());
        }

        HttpResponse<String> rawFrames(String id, String principal, List<byte[]> records) throws Exception {
            return rawBytes(id, principal, concat(records.toArray(new byte[0][])));
        }

        HttpResponse<String> rawBytes(String id, String principal, byte[] body) throws Exception {
            HttpRequest request = HttpRequest.newBuilder(URI.create(base + SESSIONS + "/" + id + "/frames"))
                    .header("Authorization", "Bearer " + MediaDevProjectRenderHttpTest.token(principal, PERMISSIONS))
                    .header("X-Tenant-Id", TENANT).header("Content-Type", "application/octet-stream")
                    .POST(HttpRequest.BodyPublishers.ofByteArray(body)).build();
            return HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        }

        byte[] content(String artifactId) throws Exception { return contentAs(OWNER, artifactId); }

        byte[] contentAs(String principal, String artifactId) throws Exception {
            MediaArtifact artifact = runtime.artifact(TENANT, principal, artifactId).orElseThrow();
            var out = new ByteArrayOutputStream();
            runtime.copyArtifactContent(TENANT, principal, artifactId, artifact.version(), out, 64L << 20).orElseThrow();
            return out.toByteArray();
        }
    }

    private static void deleteTree(Path path) {
        try (var walk = Files.walk(path)) {
            walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
        } catch (java.io.IOException ignored) { }
    }
}
