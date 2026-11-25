package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRightsConsentContracts.Reason;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static com.ghatana.media.launcher.MediaDevGroundedEvidence.Box;
import static com.ghatana.media.launcher.MediaDevGroundedEvidence.Frame;
import static com.ghatana.media.launcher.MediaDevGroundedEvidence.Item;
import static com.ghatana.media.launcher.MediaDevGroundedEvidence.Kind;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Grounded-answer lane: clock derivation and binding, evidence prompt and citation validation (pure), and the fault
 * suite through the real HTTP host with the real canonical artifact store, rights port and registrar. The children
 * here are FIXTURE children (declared as such): these tests prove the parent's refusal, binding, validation and
 * no-effect behavior against controlled child results, not model output. The real STT/Vision/Qwen path runs in
 * {@code MediaDevGroundedAnswerRestartIT}.
 */
class MediaDevGroundedAnswerTest {
    private static final String TENANT = "tenant-local";
    private static final String PRINCIPAL = "principal-local";
    private static final String OTHER = "principal-other";
    private static final String SECRET = "test-only-dev-project-secret-at-least-32-bytes";
    private static final java.time.Clock CLOCK =
            java.time.Clock.fixed(Instant.parse("2026-11-13T20:00:00Z"), java.time.ZoneOffset.UTC);
    private static final Set<String> ALL = Set.of("media:project:dev:read", "media:project:dev:write",
            "media:artifact:read", "media:artifact:create");
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final String SHA = "ab".repeat(32);

    /** Real ffprobe output of an MP4 whose audio was delayed by 3 s (AAC priming makes it 2.957 s). */
    private static final String FFPROBE_OFFSET = """
            {"programs":[],"stream_groups":[],"streams":[
            {"index":0,"codec_type":"video","width":320,"height":240,"time_base":"1/10240","start_pts":0,"start_time":"0.000000"},
            {"index":1,"codec_type":"audio","sample_rate":"24000","time_base":"1/24000","start_pts":70968,"start_time":"2.957000"}],
            "format":{"start_time":"0.000000","duration":"4.000000"}}""";

    // ---------------- clock ----------------

    @Test
    void clockIsDerivedFromContainerStartTimeAndExactStreamTimebases() {
        MediaDevGroundedClock clock = MediaDevGroundedClock.parse(FFPROBE_OFFSET.getBytes(StandardCharsets.UTF_8), SHA);
        assertThat(clock.containerStartMicros()).isZero();
        assertThat(clock.containerDurationMicros()).isEqualTo(4_000_000L);
        assertThat(clock.video().timebase()).isEqualTo("1/10240");
        assertThat(clock.audio().timebase()).isEqualTo("1/24000");
        assertThat(clock.audio().startPts()).isEqualTo(70968);
        assertThat(clock.audio().startMicros()).isEqualTo(2_957_000L);
        assertThat(clock.video().width()).isEqualTo(320);
        assertThat(clock.clockId()).startsWith("container-clock:abababababababab:");
        // The same source facts give the same clock id; a different timebase gives a different one.
        assertThat(MediaDevGroundedClock.parse(FFPROBE_OFFSET.getBytes(StandardCharsets.UTF_8), SHA).clockId())
                .isEqualTo(clock.clockId());
        assertThat(MediaDevGroundedClock.parse(FFPROBE_OFFSET.replace("1/24000", "1/48000")
                .getBytes(StandardCharsets.UTF_8), SHA).clockId()).isNotEqualTo(clock.clockId());
    }

    @Test
    void containerStartTimeIsPartOfEveryPublishedTimeAndNeverDefaulted() {
        String shifted = FFPROBE_OFFSET.replace("\"format\":{\"start_time\":\"0.000000\"", "\"format\":{\"start_time\":\"1.400000\"");
        MediaDevGroundedClock clock = MediaDevGroundedClock.parse(shifted.getBytes(StandardCharsets.UTF_8), SHA);
        assertThat(clock.containerStartMicros()).isEqualTo(1_400_000L);
        assertThat(clock.containerEndMicros()).isEqualTo(5_400_000L);
        for (String broken : List.of(
                FFPROBE_OFFSET.replace("\"format\":{\"start_time\":\"0.000000\",", "\"format\":{"),
                FFPROBE_OFFSET.replace("\"duration\":\"4.000000\"", "\"x\":1"),
                FFPROBE_OFFSET.replace("\"time_base\":\"1/10240\"", "\"time_base\":\"0/0\""),
                FFPROBE_OFFSET.replace("\"start_pts\":0,", ""),
                "{\"streams\":[],\"format\":{\"start_time\":\"0\",\"duration\":\"3\"}}", "not json")) {
            assertThatThrownBy(() -> MediaDevGroundedClock.parse(broken.getBytes(StandardCharsets.UTF_8), SHA))
                    .isInstanceOfSatisfying(MediaDevGroundedClock.ClockBindingException.class,
                            e -> assertThat(e.code()).isEqualTo("SOURCE_CLOCK_UNDETERMINED"));
        }
    }

    @Test
    void rationalTickConversionRoundsHalfUpExactly() {
        assertThat(MediaDevGroundedClock.ticksToMicros(70968, 1, 24000)).isEqualTo(2_957_000L);
        assertThat(MediaDevGroundedClock.ticksToMicros(1, 1, 3)).isEqualTo(333_333L);
        assertThat(MediaDevGroundedClock.ticksToMicros(2, 1, 3)).isEqualTo(666_667L);
        assertThat(MediaDevGroundedClock.microsToTicks(2_957_000L, 1, 24000)).isEqualTo(70968L);
        assertThat(MediaDevGroundedClock.microsToTicks(MediaDevGroundedClock.ticksToMicros(5120, 1, 10240), 1, 10240))
                .isEqualTo(5120L);
    }

    @Test
    void childPinMustRepeatTheParentsVersionClockTimebaseAndContainerStart() {
        MediaDevGroundedClock clock = fixtureClock();
        var parent = clock.pin("sha256:" + SHA, SHA);
        clock.requireBound(parent, parent, "STT");
        for (var bad : Map.of(
                "SOURCE_CLOCK_MISMATCH", List.of(
                        new MediaDevGroundedClock.Pin(parent.sourceArtifactVersionId(), SHA, "other-clock",
                                parent.containerStartMicros(), 1, 1_000_000L),
                        new MediaDevGroundedClock.Pin(parent.sourceArtifactVersionId(), SHA, parent.clockId(),
                                parent.containerStartMicros() + 1, 1, 1_000_000L),
                        new MediaDevGroundedClock.Pin(parent.sourceArtifactVersionId(), SHA, parent.clockId(),
                                parent.containerStartMicros(), 1, 90_000L)),
                "STALE_CHILD_SOURCE_VERSION", List.of(
                        new MediaDevGroundedClock.Pin("sha256:" + "cd".repeat(32), SHA, parent.clockId(),
                                parent.containerStartMicros(), 1, 1_000_000L),
                        new MediaDevGroundedClock.Pin(parent.sourceArtifactVersionId(), "cd".repeat(32),
                                parent.clockId(), parent.containerStartMicros(), 1, 1_000_000L))).entrySet()) {
            for (var pin : bad.getValue()) {
                assertThatThrownBy(() -> clock.requireBound(parent, pin, "VISION"))
                        .isInstanceOfSatisfying(MediaDevGroundedClock.ClockBindingException.class,
                                e -> assertThat(e.code()).isEqualTo(bad.getKey()));
            }
        }
        assertThatThrownBy(() -> clock.requireBound(parent, null, "VISION"))
                .isInstanceOf(MediaDevGroundedClock.ClockBindingException.class);
    }

    // ---------------- prompt and validation ----------------

    @Test
    void promptStaysWithinTheBudgetAndNamesOnlyTheOfferedIds() {
        List<Item> items = new ArrayList<>();
        for (int i = 0; i < 40; i++) items.add(transcript("T" + i, 1_000_000L + i * 100_000L, "word ".repeat(20)));
        var prompt = MediaDevGroundedEvidence.prompt("What is said?", items);
        assertThat(prompt.text().length()).isLessThanOrEqualTo(MediaDevGroundedEvidence.PROMPT_BUDGET);
        assertThat(prompt.omitted()).isPositive();
        assertThat(prompt.offeredIds().size() + prompt.omitted()).isEqualTo(40);
        for (String id : prompt.offeredIds()) assertThat(prompt.text()).contains(id + " [");
    }

    @Test
    void validatorGroundsOnlyClaimsWhoseCitationsExistWereOfferedAndAreInRange() {
        MediaDevGroundedClock clock = fixtureClock();
        List<Item> all = List.of(transcript("T0", 1_000_000L, "hello"),
                new Item("F0.S0", Kind.FRAME_TEXT, 0, 0, new Frame(0, "1/90000", 640, 360, 0),
                        new Box(10, 10, 100, 40), "GHATANA", "fixture"),
                new Item("F0.O9", Kind.FRAME_OBJECT, 0, 0, new Frame(0, "1/90000", 640, 360, 0),
                        new Box(600, 10, 100, 40), "box that leaves the frame", "fixture"),
                transcript("T7", 99_000_000L, "after the end"));
        List<String> offered = List.of("T0", "F0.S0", "F0.O9", "T7");
        String reply = "Sure: {\"claims\":["
                + "{\"text\":\"Someone says hello\",\"evidence\":[\"T0\"]},"
                + "{\"text\":\"The screen reads GHATANA\",\"evidence\":[\"F0.S0\",\"T0\"]},"
                + "{\"text\":\"No citation at all\",\"evidence\":[]},"
                + "{\"text\":\"Invented id\",\"evidence\":[\"T99\"]},"
                + "{\"text\":\"Not offered\",\"evidence\":[\"F7\"]},"
                + "{\"text\":\"Box outside the frame\",\"evidence\":[\"F0.O9\"]},"
                + "{\"text\":\"Time outside the clock\",\"evidence\":[\"T7\"]},"
                + "{\"text\":\"Bad id type\",\"evidence\":[7]}]}";
        var answer = MediaDevGroundedEvidence.validate(reply, all, offered, clock);
        assertThat(answer.status()).isEqualTo("PARTIALLY_GROUNDED");
        assertThat(answer.claims()).extracting(MediaDevGroundedEvidence.Claim::text)
                .containsExactly("Someone says hello", "The screen reads GHATANA");
        assertThat(answer.flagged()).hasSize(6);
        assertThat(answer.flagged().get(0).flags()).containsExactly("UNCITED");
        assertThat(answer.flagged().get(1).flags()).containsExactly("UNKNOWN_EVIDENCE_ID:T99");
        assertThat(answer.flagged().get(2).flags()).containsExactly("UNKNOWN_EVIDENCE_ID:F7");
        // F7 does not exist at all; an existing item that was not offered is flagged separately.
        var notOffered = MediaDevGroundedEvidence.validate(
                "{\"claims\":[{\"text\":\"x\",\"evidence\":[\"T7\"]}]}", all, List.of("T0"), clock);
        assertThat(notOffered.flagged().get(0).flags()).containsExactly("EVIDENCE_NOT_OFFERED:T7");
        assertThat(answer.flagged().get(3).flags()).containsExactly("EVIDENCE_OUT_OF_RANGE:F0.O9");
        assertThat(answer.flagged().get(4).flags()).containsExactly("EVIDENCE_OUT_OF_RANGE:T7");
        assertThat(answer.flagged().get(5).flags()).containsExactly("MALFORMED_CITATION");
    }

    @Test
    void anAnswerWithOnlyInvalidClaimsIsUngroundedAndUnparseableRepliesCarryNoClaims() {
        MediaDevGroundedClock clock = fixtureClock();
        List<Item> all = List.of(transcript("T0", 1_000_000L, "hello"));
        var invented = MediaDevGroundedEvidence.validate("{\"claims\":[{\"text\":\"a\",\"evidence\":[\"X1\"]}]}", all,
                List.of("T0"), clock);
        assertThat(invented.status()).isEqualTo("UNGROUNDED");
        assertThat(invented.claims()).isEmpty();
        assertThat(MediaDevGroundedEvidence.validate("{\"claims\":[]}", all, List.of("T0"), clock).status())
                .isEqualTo("UNGROUNDED");
        for (String bad : List.of("", "no json here", "{\"claims\":\"x\"}", "{\"claims\":[", "{ not json }")) {
            var unparseable = MediaDevGroundedEvidence.validate(bad, all, List.of("T0"), clock);
            assertThat(unparseable.status()).as(bad).isEqualTo("ANSWER_UNPARSEABLE");
            assertThat(unparseable.claims()).isEmpty();
        }
        StringBuilder many = new StringBuilder("{\"claims\":[");
        for (int i = 0; i < 12; i++) many.append(i > 0 ? "," : "").append("{\"text\":\"c").append(i)
                .append("\",\"evidence\":[\"T0\"]}");
        var capped = MediaDevGroundedEvidence.validate(many.append("]}").toString(), all, List.of("T0"), clock);
        assertThat(capped.claims()).hasSize(MediaDevGroundedEvidence.MAX_CLAIMS);
        assertThat(capped.flagged().get(0).flags()).containsExactly("TOO_MANY_CLAIMS");
    }

    // ---------------- through the HTTP host ----------------

    @Test
    void groundedAnswerRegistersValidatedCitationsReadsBackAndReplays() throws Exception {
        Fixture f = new Fixture(Verdict.ADMITTED);
        try {
            HttpResponse<byte[]> created = f.ask("req-1", false);
            assertThat(created.statusCode()).as(new String(created.body())).isEqualTo(201);
            Map<String, Object> view = map(created);
            assertThat(view).containsEntry("scope", "DEV_ONLY").containsEntry("replayed", false);
            assertStagedSourceWasRemoved(f);
            Map<String, Object> document = castMap(view.get("document"));
            assertThat(castMap(document.get("answer"))).containsEntry("status", "GROUNDED");
            List<Map<String, Object>> claims = castList(castMap(document.get("answer")).get("claims"));
            assertThat(claims).hasSize(2);
            assertThat(claims.get(0).get("evidenceIds")).isEqualTo(List.of("T0"));
            List<Map<String, Object>> evidence = castList(document.get("evidence"));
            Map<String, Object> t0 = evidence.stream().filter(e -> "T0".equals(e.get("evidenceId"))).findFirst()
                    .orElseThrow();
            // Transcript time is on the container clock: audio stream start (3 s) + segment time (0.5 s).
            assertThat(t0).containsEntry("startMicros", 3_500_000).containsEntry("kind", "TRANSCRIPT_SEGMENT");
            Map<String, Object> sourceClock = castMap(document.get("sourceClock"));
            assertThat(sourceClock).containsEntry("containerStartMicros", 0);
            assertThat(castMap(sourceClock.get("audio"))).containsEntry("timebase", "1/48000");
            assertThat(castList(document.get("children")).stream().map(c -> c.get("kind")).toList())
                    .containsExactly("STT", "VISION", "DOCUMENT_INTELLIGENCE");
            assertThat(castList(document.get("children")).get(2)).containsEntry("status", "UNAVAILABLE");
            assertThat(castMap(view.get("lineage"))).containsEntry("answerStatus", "GROUNDED")
                    .containsEntry("sourceClockId", sourceClock.get("clockId"));
            assertThat(f.registrations.get()).isEqualTo(1);

            // The registered artifact's own bytes carry the document; reopen reads it back.
            String outputId = (String) view.get("outputId");
            Map<String, Object> reopened = map(f.get("/dev/v1/grounded-answers/" + outputId, PRINCIPAL));
            assertThat(castMap(reopened.get("document"))).isEqualTo(document);
            assertThat(f.get("/dev/v1/grounded-answers/" + outputId, OTHER).statusCode()).isEqualTo(404);

            // Replay with the same requestId re-derives identical bytes: 200, same artifact.
            HttpResponse<byte[]> replay = f.ask("req-1", false);
            assertThat(replay.statusCode()).isEqualTo(200);
            assertThat(map(replay)).containsEntry("replayed", true).containsEntry("outputId", outputId);
            // A different question under the same requestId is refused, not silently replayed.
            f.question.set("a different question?");
            assertThat(f.ask("req-1", false).statusCode()).isEqualTo(409);
            // A foreign principal cannot use the source at all.
            assertThat(f.askAs(OTHER, "req-foreign", false).statusCode()).isEqualTo(404);
            assertThat(f.children.speechCalls.get()).isGreaterThanOrEqualTo(1);
        } finally {
            f.close();
        }
    }

    @Test
    void stagedSourceIsDeletedWhenClockProbeFails() throws Exception {
        Fixture f = new Fixture(Verdict.ADMITTED);
        try {
            f.probeFailure = new IllegalStateException("fixture probe failure");
            HttpResponse<byte[]> failed = f.ask("probe-failure", false);
            assertThat(failed.statusCode()).isEqualTo(422);
            assertThat(new String(failed.body(), StandardCharsets.UTF_8)).contains("SOURCE_CLOCK_UNDETERMINED");
            assertStagedSourceWasRemoved(f);
        } finally {
            f.close();
        }
    }

    @Test
    void aRetryAfterSuccessReplaysTheStoredAnswerWithoutRunningTheModelsAndRightsAreRecheckedOnReplay() throws Exception {
        Fixture f = new Fixture(Verdict.ADMITTED);
        try {
            HttpResponse<byte[]> created = f.ask("replay-1", false);
            assertThat(created.statusCode()).as(new String(created.body())).isEqualTo(201);
            String outputId = (String) map(created).get("outputId");
            int speech = f.children.speechCalls.get();
            int vision = f.children.visionCalls.get();
            int answers = f.children.answerCalls.get();

            // The answering model is nondeterministic: a re-run would now produce different bytes. The ledger
            // replays the first registered answer instead of re-running anything.
            f.children.reply = "{\"claims\":[{\"text\":\"A different wording\",\"evidence\":[\"T0\"]}]}";
            HttpResponse<byte[]> replay = f.ask("replay-1", false);
            assertThat(replay.statusCode()).as(new String(replay.body())).isEqualTo(200);
            assertThat(map(replay)).containsEntry("replayed", true).containsEntry("outputId", outputId);
            assertThat(castMap(castMap(map(replay).get("document")).get("answer")).get("claims").toString())
                    .doesNotContain("A different wording");
            assertThat(f.children.speechCalls.get()).isEqualTo(speech);
            assertThat(f.children.visionCalls.get()).isEqualTo(vision);
            assertThat(f.children.answerCalls.get()).isEqualTo(answers);
            assertThat(f.registrations.get()).isEqualTo(1);

            // A different request under the same requestId is a conflict; nothing runs.
            f.question.set("a different question?");
            HttpResponse<byte[]> reused = f.ask("replay-1", false);
            assertThat(reused.statusCode()).isEqualTo(409);
            assertThat(new String(reused.body())).contains("GROUNDED_REQUEST_ID_REUSED");
            assertThat(f.children.answerCalls.get()).isEqualTo(answers);
            f.question.set("What does the speaker say and what is on screen?");

            // Rights are re-resolved on every call: a revoked source refuses even a replay.
            f.verdict.set(Verdict.REVOKED);
            HttpResponse<byte[]> revoked = f.ask("replay-1", false);
            assertThat(revoked.statusCode()).isEqualTo(403);
            assertThat(new String(revoked.body())).contains("RIGHTS_REVOKED");
            assertThat(f.children.answerCalls.get()).isEqualTo(answers);
        } finally {
            f.close();
        }
    }

    @Test
    void rightsMissingRevokedOrUnavailableRefuseBeforeAnyChildRunsOrAnythingIsRegistered() throws Exception {
        for (var entry : Map.of(Verdict.UNAVAILABLE, 503, Verdict.DENIED, 403, Verdict.REVOKED, 403,
                Verdict.STALE, 403, Verdict.MISMATCH, 403).entrySet()) {
            Fixture f = new Fixture(entry.getKey());
            try {
                HttpResponse<byte[]> refused = f.ask("rights-" + entry.getKey(), false);
                assertThat(refused.statusCode()).as(entry.getKey().name()).isEqualTo(entry.getValue());
                assertThat(new String(refused.body())).contains(entry.getKey() == Verdict.UNAVAILABLE
                        ? "RIGHTS_AUTHORITY_UNAVAILABLE" : "RIGHTS_" + entry.getKey().name());
                assertThat(f.children.speechCalls.get() + f.children.visionCalls.get() + f.children.answerCalls.get())
                        .isZero();
                assertThat(f.registrations.get()).isZero();
            } finally {
                f.close();
            }
        }
    }

    @Test
    void rightsRevokedWhileTheChildrenRanLeavesNoRegisteredEffect() throws Exception {
        Fixture f = new Fixture(Verdict.ADMITTED);
        try {
            f.children.afterVision = () -> f.verdict.set(Verdict.REVOKED);
            HttpResponse<byte[]> refused = f.ask("revoked-mid", false);
            assertThat(refused.statusCode()).isEqualTo(403);
            assertThat(new String(refused.body())).contains("RIGHTS_REVOKED");
            assertThat(f.children.answerCalls.get()).isEqualTo(1);
            assertThat(f.registrations.get()).isZero();
        } finally {
            f.close();
        }
    }

    @Test
    void aWrongClockOrStaleVersionChildIsRefusedWithoutAnyRegisteredAnswer() throws Exception {
        record Case(String name, java.util.function.BiConsumer<FixtureChildren, MediaDevGroundedClock.Pin> setup,
                    String code) { }
        List<Case> cases = List.of(
                new Case("stt-wrong-clock", (c, p) -> c.overrideStt(new MediaDevGroundedClock.Pin(
                        p.sourceArtifactVersionId(), p.sourceSha256(), "container-clock:someone-else",
                        p.containerStartMicros(), 1, 1_000_000L)), "SOURCE_CLOCK_MISMATCH"),
                new Case("vision-wrong-timebase", (c, p) -> c.overrideVision(new MediaDevGroundedClock.Pin(
                        p.sourceArtifactVersionId(), p.sourceSha256(), p.clockId(), p.containerStartMicros(), 1,
                        90_000L)), "SOURCE_CLOCK_MISMATCH"),
                new Case("stt-container-start-dropped", (c, p) -> c.overrideStt(new MediaDevGroundedClock.Pin(
                        p.sourceArtifactVersionId(), p.sourceSha256(), p.clockId(), p.containerStartMicros() + 40_000,
                        1, 1_000_000L)), "SOURCE_CLOCK_MISMATCH"),
                new Case("vision-stale-version", (c, p) -> c.overrideVision(new MediaDevGroundedClock.Pin(
                        "sha256:" + "cd".repeat(32), p.sourceSha256(), p.clockId(), p.containerStartMicros(), 1,
                        1_000_000L)), "STALE_CHILD_SOURCE_VERSION"),
                new Case("stt-no-pin", (c, p) -> c.overrideStt(null), "SOURCE_CLOCK_MISMATCH"),
                new Case("stt-time-outside-the-clock", (c, p) -> c.sttSegmentStartMicros = 500_000_000L,
                        "SOURCE_CLOCK_MISMATCH"));
        for (Case scenario : cases) {
            Fixture f = new Fixture(Verdict.ADMITTED);
            try {
                scenario.setup().accept(f.children, fixtureClock().pin(f.source.version().value(), f.source.sha256()));
                HttpResponse<byte[]> refused = f.ask("clock-" + scenario.name(), false);
                assertThat(refused.statusCode()).as(scenario.name() + new String(refused.body())).isEqualTo(409);
                assertThat(new String(refused.body())).contains(scenario.code());
                assertThat(f.registrations.get()).as(scenario.name()).isZero();
                assertThat(f.children.answerCalls.get()).as("no model is asked once binding fails").isZero();
            } finally {
                f.close();
            }
        }
    }

    @Test
    void aFailedChildGivesATypedFailureByDefaultAndAPartialAnswerOnlyOnExplicitRequest() throws Exception {
        Fixture f = new Fixture(Verdict.ADMITTED);
        try {
            f.children.sttStatus = MediaDevGroundedAnswerRuntime.ChildStatus.FAILED;
            HttpResponse<byte[]> failed = f.ask("child-failed", false);
            assertThat(failed.statusCode()).isEqualTo(502);
            Map<String, Object> error = map(failed);
            assertThat(error.toString()).contains("GROUNDED_CHILD_FAILED", "STT", "FAILED", "DOCUMENT_INTELLIGENCE");
            assertThat(f.registrations.get()).isZero();
            assertThat(f.children.answerCalls.get()).isZero();

            HttpResponse<byte[]> partial = f.ask("child-partial", true);
            assertThat(partial.statusCode()).as(new String(partial.body())).isEqualTo(201);
            Map<String, Object> document = castMap(map(partial).get("document"));
            assertThat(document).containsEntry("evidenceCompleteness", "PARTIAL");
            assertThat(castList(document.get("children")).get(0)).containsEntry("status", "FAILED")
                    .containsEntry("evidenceCount", 0);
            // The failed child's evidence is never invented: no transcript evidence exists.
            assertThat(castList(document.get("evidence")).stream().map(e -> e.get("kind")))
                    .doesNotContain("TRANSCRIPT_SEGMENT");

            // Vision failing leaves nothing to answer from: even a partial request gets a typed refusal.
            f.children.sttStatus = MediaDevGroundedAnswerRuntime.ChildStatus.COMPLETED;
            f.children.visionStatus = MediaDevGroundedAnswerRuntime.ChildStatus.UNAVAILABLE;
            HttpResponse<byte[]> noVision = f.ask("child-no-vision", true);
            assertThat(noVision.statusCode()).isEqualTo(422);
            assertThat(new String(noVision.body())).contains("GROUNDED_NO_EVIDENCE");
        } finally {
            f.close();
        }
    }

    @Test
    void anUnavailableOrTimedOutChildIsATypedOutageNeverAFailureOrSuccessAndTheRetryRunsOnce() throws Exception {
        Fixture f = new Fixture(Verdict.ADMITTED);
        try {
            // Nothing ran for the speech child: UNAVAILABLE (503), not a generic 502 failure.
            f.children.sttStatus = MediaDevGroundedAnswerRuntime.ChildStatus.UNAVAILABLE;
            HttpResponse<byte[]> unavailable = f.ask("outage-unavailable", false);
            assertThat(unavailable.statusCode()).as(new String(unavailable.body())).isEqualTo(503);
            assertThat(new String(unavailable.body())).contains("GROUNDED_UNAVAILABLE", "\"outcome\":\"UNAVAILABLE\"",
                    "\"fallback\":\"NONE\"");
            assertThat(f.registrations.get()).isZero();
            assertThat(f.children.answerCalls.get()).as("no model is asked once an evidence child is down").isZero();

            // A child that exceeded its deadline: TIMEOUT (504) with nothing registered.
            f.children.sttStatus = MediaDevGroundedAnswerRuntime.ChildStatus.TIMED_OUT;
            HttpResponse<byte[]> timedOut = f.ask("outage-timeout", false);
            assertThat(timedOut.statusCode()).as(new String(timedOut.body())).isEqualTo(504);
            assertThat(new String(timedOut.body())).contains("GROUNDED_TIMEOUT", "\"outcome\":\"TIMEOUT\"");
            assertThat(f.registrations.get()).isZero();

            // Recovery: the same requestIds now run exactly once each, and a repeat replays instead of re-running.
            f.children.sttStatus = MediaDevGroundedAnswerRuntime.ChildStatus.COMPLETED;
            HttpResponse<byte[]> recovered = f.ask("outage-unavailable", false);
            assertThat(recovered.statusCode()).as(new String(recovered.body())).isEqualTo(201);
            int speechCalls = f.children.speechCalls.get();
            HttpResponse<byte[]> replay = f.ask("outage-unavailable", false);
            assertThat(replay.statusCode()).isEqualTo(200);
            assertThat(f.children.speechCalls.get()).as("a replay does not run the children again").isEqualTo(speechCalls);
            assertThat(f.registrations.get()).isEqualTo(1);
        } finally {
            f.close();
        }
    }

    @Test
    void anUnknownChildOutcomeOrALostAnswererIsOutcomeUnknownWithNothingRegisteredAndRetryResumes() throws Exception {
        Fixture f = new Fixture(Verdict.ADMITTED);
        try {
            f.children.visionStatus = MediaDevGroundedAnswerRuntime.ChildStatus.OUTCOME_UNKNOWN;
            HttpResponse<byte[]> unknownChild = f.ask("unknown-1", true);
            assertThat(unknownChild.statusCode()).isEqualTo(503);
            assertThat(new String(unknownChild.body())).contains("GROUNDED_OUTCOME_UNKNOWN");
            f.children.visionStatus = MediaDevGroundedAnswerRuntime.ChildStatus.COMPLETED;

            f.children.answerFailure = new MediaDevGroundedAnswerRuntime.GroundedRefusedException(503,
                    "GROUNDED_OUTCOME_UNKNOWN", "sidecar lost");
            HttpResponse<byte[]> lost = f.ask("unknown-2", false);
            assertThat(lost.statusCode()).isEqualTo(503);
            assertThat(new String(lost.body())).contains("GROUNDED_OUTCOME_UNKNOWN");
            assertThat(f.registrations.get()).isZero();

            // The sidecar is back: the same requestId resumes and registers exactly once.
            f.children.answerFailure = null;
            assertThat(f.ask("unknown-2", false).statusCode()).isEqualTo(201);
            assertThat(f.registrations.get()).isEqualTo(1);
        } finally {
            f.close();
        }
    }

    @Test
    void aHallucinatedCitationIsFlaggedAndNeverPresentedAsGrounded() throws Exception {
        Fixture f = new Fixture(Verdict.ADMITTED);
        try {
            f.children.reply = "{\"claims\":[{\"text\":\"The speaker is the CEO\",\"evidence\":[\"T42\"]},"
                    + "{\"text\":\"Uncited statement\",\"evidence\":[]}]}";
            HttpResponse<byte[]> created = f.ask("halluc-1", false);
            assertThat(created.statusCode()).isEqualTo(201);
            Map<String, Object> answer = castMap(castMap(map(created).get("document")).get("answer"));
            assertThat(answer).containsEntry("status", "UNGROUNDED");
            assertThat(castList(answer.get("claims"))).isEmpty();
            List<Map<String, Object>> flagged = castList(answer.get("flaggedClaims"));
            assertThat(flagged).hasSize(2);
            assertThat(flagged.get(0)).containsEntry("status", "NOT_GROUNDED");
            assertThat(flagged.get(0).get("flags").toString()).contains("UNKNOWN_EVIDENCE_ID:T42");
            assertThat(flagged.get(1).get("flags").toString()).contains("UNCITED");
            assertThat(castMap(map(created).get("lineage"))).containsEntry("answerStatus", "UNGROUNDED");
        } finally {
            f.close();
        }
    }

    @Test
    void invalidSourcesAndFieldsAreTypedRefusals() throws Exception {
        Fixture f = new Fixture(Verdict.ADMITTED);
        try {
            MediaArtifact image = f.upload("scene.png", "image/png", new byte[] {1, 2, 3, 4});
            HttpResponse<byte[]> format = f.post(Map.of("requestId", "fmt-1", "artifactId", image.artifactId(),
                    "artifactVersionId", image.version().value(), "question", "What?"), PRINCIPAL);
            assertThat(format.statusCode()).isEqualTo(422);
            assertThat(new String(format.body())).contains("SOURCE_FORMAT_NOT_SUPPORTED");
            f.probeFailure = new MediaDevGroundedClock.ClockBindingException("SOURCE_CLOCK_UNDETERMINED", "x");
            HttpResponse<byte[]> clock = f.ask("clk-1", false);
            assertThat(clock.statusCode()).isEqualTo(422);
            assertThat(new String(clock.body())).contains("SOURCE_CLOCK_UNDETERMINED");
            assertThat(f.post(Map.of("requestId", "x1", "artifactId", f.source.artifactId(),
                    "artifactVersionId", f.source.version().value(), "question", "q", "extra", 1), PRINCIPAL)
                    .statusCode()).isEqualTo(400);
            assertThat(f.post(Map.of("requestId", "x2", "artifactId", f.source.artifactId(),
                    "artifactVersionId", "sha256:" + "00".repeat(32), "question", "q"), PRINCIPAL).statusCode())
                    .isEqualTo(404);
            assertThat(f.children.speechCalls.get()).isZero();
            assertThat(f.registrations.get()).isZero();
        } finally {
            f.close();
        }
    }

    @Test
    void aFailingRegistrarSurfacesATypedFailureAndRetryResumes() throws Exception {
        Fixture f = new Fixture(Verdict.ADMITTED);
        try {
            f.failRegistration.set(true);
            HttpResponse<byte[]> failed = f.ask("reg-1", false);
            assertThat(failed.statusCode()).isEqualTo(502);
            assertThat(new String(failed.body())).contains("GROUNDED_OUTPUT_REGISTRATION_FAILED");
            f.failRegistration.set(false);
            assertThat(f.ask("reg-1", false).statusCode()).isEqualTo(201);
        } finally {
            f.close();
        }
    }

    @Test
    void routeAndPermissionContractIsDevOnlyAndNotInTheCanonicalManifest() {
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("POST", "/dev/v1/grounded-answers"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_WRITE);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/grounded-answers/abc"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("GET", "/dev/v1/grounded-answers/status"))
                .isEqualTo(MediaDevOnlyRoutePermissions.PROJECT_READ);
        assertThat(MediaDevOnlyRoutePermissions.requiredPermission("DELETE", "/dev/v1/grounded-answers/abc")).isNull();
    }

    // ---------------- fixtures ----------------

    private static MediaDevGroundedClock fixtureClock() {
        return new MediaDevGroundedClock("container-clock:fixture", 0L, 10_000_000L,
                new MediaDevGroundedClock.Stream(0, 1, 90_000, 0, 0, 640, 360, 0),
                new MediaDevGroundedClock.Stream(1, 1, 48_000, 144_000, 3_000_000L, 0, 0, 48_000));
    }

    private static Item transcript(String id, long startMicros, String text) {
        return new Item(id, Kind.TRANSCRIPT_SEGMENT, startMicros, startMicros + 500_000L, null, null, text, "fixture");
    }

    /** FIXTURE children: controlled child results; the real path is covered by the real-process IT. */
    private static final class FixtureChildren implements MediaDevGroundedAnswerRuntime.Children {
        final AtomicInteger speechCalls = new AtomicInteger();
        final AtomicInteger visionCalls = new AtomicInteger();
        final AtomicInteger answerCalls = new AtomicInteger();
        MediaDevGroundedAnswerRuntime.ChildStatus sttStatus = MediaDevGroundedAnswerRuntime.ChildStatus.COMPLETED;
        MediaDevGroundedAnswerRuntime.ChildStatus visionStatus = MediaDevGroundedAnswerRuntime.ChildStatus.COMPLETED;
        MediaDevGroundedClock.Pin sttPin;
        MediaDevGroundedClock.Pin visionPin;
        boolean sttOverridden;
        boolean visionOverridden;
        void overrideStt(MediaDevGroundedClock.Pin pin) { sttPin = pin; sttOverridden = true; }
        void overrideVision(MediaDevGroundedClock.Pin pin) { visionPin = pin; visionOverridden = true; }
        long sttSegmentStartMicros = 3_500_000L;
        Runnable afterVision = () -> { };
        RuntimeException answerFailure;
        String reply = "{\"claims\":[{\"text\":\"The speaker greets the viewer\",\"evidence\":[\"T0\"]},"
                + "{\"text\":\"The screen shows GHATANA\",\"evidence\":[\"F0.S0\",\"F0\"]}]}";

        @Override public MediaDevGroundedAnswerRuntime.ChildResult speech(MediaDevGroundedAnswerRuntime.Source source,
                MediaDevGroundedClock clock, MediaDevGroundedClock.Pin pin, String language) {
            speechCalls.incrementAndGet();
            if (!sttOverridden) sttPin = pin;
            if (sttStatus != MediaDevGroundedAnswerRuntime.ChildStatus.COMPLETED) {
                return MediaDevGroundedAnswerRuntime.ChildResult.failed("STT", sttStatus, "FIXTURE_" + sttStatus);
            }
            return new MediaDevGroundedAnswerRuntime.ChildResult("STT", sttStatus, sttPin,
                    List.of(new Item("T0", Kind.TRANSCRIPT_SEGMENT, sttSegmentStartMicros, sttSegmentStartMicros + 1_000_000L,
                            null, null, "hello and welcome", "fixture-stt")), Map.of("id", "fixture-stt"), "", 0, null);
        }

        @Override public MediaDevGroundedAnswerRuntime.ChildResult vision(MediaDevGroundedAnswerRuntime.Source source,
                MediaDevGroundedClock clock, MediaDevGroundedClock.Pin pin) {
            visionCalls.incrementAndGet();
            if (!visionOverridden) visionPin = pin;
            try {
                if (visionStatus != MediaDevGroundedAnswerRuntime.ChildStatus.COMPLETED) {
                    return MediaDevGroundedAnswerRuntime.ChildResult.failed("VISION", visionStatus,
                            "FIXTURE_" + visionStatus);
                }
                Frame frame = new Frame(0, "1/90000", 640, 360, 0);
                return new MediaDevGroundedAnswerRuntime.ChildResult("VISION", visionStatus, visionPin, List.of(
                        new Item("F0", Kind.FRAME, 0, 0, frame, null, "a title card", "fixture-vision"),
                        new Item("F0.S0", Kind.FRAME_TEXT, 0, 0, frame, new Box(40, 120, 300, 90), "GHATANA",
                                "fixture-vision"),
                        new Item("F0.O0", Kind.FRAME_OBJECT, 0, 0, frame, new Box(500, 300, 400, 100),
                                "a box that leaves the frame", "fixture-vision")),
                        Map.of("id", "fixture-vision"), "", 0, new byte[] {1});
            } finally {
                afterVision.run();
            }
        }

        @Override public MediaDevGroundedAnswerRuntime.Answered answer(byte[] framePng, String prompt) {
            answerCalls.incrementAndGet();
            if (answerFailure != null) throw answerFailure;
            return new MediaDevGroundedAnswerRuntime.Answered(reply, Map.of("id", "fixture-qwen"));
        }

        @Override public Map<String, Object> status() { return Map.of("fixture", true); }
    }

    private static final class Fixture {
        final MediaRuntime runtime;
        final HttpServer server;
        final FixtureChildren children = new FixtureChildren();
        final AtomicReference<Verdict> verdict;
        final AtomicInteger registrations = new AtomicInteger();
        final java.util.concurrent.atomic.AtomicBoolean failRegistration = new java.util.concurrent.atomic.AtomicBoolean();
        final AtomicReference<String> question = new AtomicReference<>("What does the speaker say and what is on screen?");
        final AtomicReference<Path> stagedSourceFile = new AtomicReference<>();
        final AtomicReference<byte[]> observedSourceBytes = new AtomicReference<>();
        volatile RuntimeException probeFailure;
        final MediaArtifact source;

        Fixture(Verdict initial) throws Exception {
            Path root = Files.createTempDirectory("media-dev-grounded-");
            runtime = new MediaRuntime(new MediaRuntimeConfig(true, "dev", 8093, 8_388_608, 1_048_576, 8_388_608,
                    Duration.ofSeconds(2), 2, "", "", true, false, root),
                    new LocalMediaRuntimeSupport.FileArtifactStore(root), new LocalMediaRuntimeSupport.JobStore(false),
                    new LocalMediaRuntimeSupport.StreamStore(), null,
                    List.of(new NoEffectProvider()), List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
            verdict = new AtomicReference<>(initial);
            source = upload("talk.mp4", "video/mp4", "fixture mp4 bytes".getBytes(StandardCharsets.UTF_8));
            var canonical = MediaDevProjectRenderRuntime.canonicalRegistrar(runtime);
            MediaDevProjectRenderRuntime.OutputRegistrar registrar = (tenant, principal, upload, key, bytes) -> {
                if (failRegistration.get()) throw new IllegalStateException("fixture registration failure");
                registrations.incrementAndGet();
                return canonical.register(tenant, principal, upload, key, bytes);
            };
            MediaDevGroundedAnswerRuntime.Probe probe = s -> {
                stagedSourceFile.set(s.file());
                observedSourceBytes.set(Files.readAllBytes(s.file()));
                if (probeFailure != null) throw probeFailure;
                return fixtureClock();
            };
            // A replay registers the same idempotent request again: count only first registrations.
            MediaDevProjectRenderRuntime.OutputRegistrar counting = (tenant, principal, upload, key, bytes) -> {
                var result = registrar.register(tenant, principal, upload, key, bytes);
                if (result.replayed()) registrations.decrementAndGet();
                return result;
            };
            var grounded = new MediaDevGroundedAnswerRuntime(runtime, probe, children, resolver(), counting);
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            MediaHttpHandler handler = new MediaHttpHandler(runtime, null, null, null, (MediaDevReviewRuntime) null)
                    .withDevGrounded(grounded);
            server.createContext("/", new MediaSecurityFilter(handler, "dev",
                    Map.of("MEDIA_DEV_IDENTITY_ENABLED", "true", "MEDIA_DEV_JWT_HMAC_SECRET", SECRET), CLOCK));
            server.start();
        }

        RightsConsentResolver resolver() {
            return new RightsConsentResolver() {
                @Override public String resolverId() { return "fixture-only-rights-resolver"; }
                @Override public boolean ready() { return true; }
                @Override public Resolution resolve(com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest r) {
                    Verdict current = verdict.get();
                    return current == Verdict.ADMITTED
                            ? new Resolution(current, Set.of(), List.of("fixture-attestation-1"), resolverId())
                            : new Resolution(current, Set.of(Reason.NO_ATTESTATION), List.of(), resolverId());
                }
            };
        }

        MediaArtifact upload(String name, String contentType, byte[] bytes) throws Exception {
            String digest = HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
            var session = runtime.beginUpload(new UploadRequest(TENANT, PRINCIPAL, name, contentType, bytes.length,
                    digest, "INTERNAL", Duration.ofMinutes(30), Map.of()), "key-" + name + bytes.length);
            runtime.appendChunk(TENANT, PRINCIPAL, session.uploadId(), 0, bytes);
            return runtime.completeUpload(TENANT, PRINCIPAL, session.uploadId());
        }

        HttpResponse<byte[]> ask(String requestId, boolean allowPartial) throws Exception {
            return askAs(PRINCIPAL, requestId, allowPartial);
        }

        HttpResponse<byte[]> askAs(String principal, String requestId, boolean allowPartial) throws Exception {
            Map<String, Object> body = new java.util.LinkedHashMap<>(Map.of("requestId", requestId,
                    "artifactId", source.artifactId(), "artifactVersionId", source.version().value(),
                    "question", question.get()));
            if (allowPartial) body.put("allowPartial", true);
            return post(body, principal);
        }

        HttpResponse<byte[]> post(Map<String, Object> body, String principal) throws Exception {
            return HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create(base() + "/dev/v1/grounded-answers"))
                    .timeout(Duration.ofSeconds(30))
                    .header("Authorization", "Bearer " + token(principal)).header("X-Tenant-Id", TENANT)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofByteArray(JSON.writeValueAsBytes(body))).build(),
                    HttpResponse.BodyHandlers.ofByteArray());
        }

        HttpResponse<byte[]> get(String path, String principal) throws Exception {
            return HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create(base() + path))
                    .header("Authorization", "Bearer " + token(principal)).header("X-Tenant-Id", TENANT).GET().build(),
                    HttpResponse.BodyHandlers.ofByteArray());
        }

        String base() { return "http://127.0.0.1:" + server.getAddress().getPort(); }

        void close() { server.stop(0); }
    }

    private static Map<String, Object> map(HttpResponse<byte[]> response) throws Exception {
        return JSON.readValue(response.body(), new TypeReference<>() { });
    }

    private static void assertStagedSourceWasRemoved(Fixture fixture) {
        Path stagedFile = fixture.stagedSourceFile.get();
        assertThat(stagedFile).isNotNull();
        assertThat(fixture.observedSourceBytes.get())
                .containsExactly("fixture mp4 bytes".getBytes(StandardCharsets.UTF_8));
        assertThat(Files.exists(stagedFile)).isFalse();
        assertThat(Files.exists(stagedFile.getParent())).isFalse();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) { return (Map<String, Object>) value; }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> castList(Object value) { return (List<Map<String, Object>>) value; }

    private static String token(String principal) throws Exception {
        String permissionJson = ALL.stream().sorted().map(p -> "\"" + p + "\"")
                .collect(java.util.stream.Collectors.joining(","));
        String payload = "{\"sub\":\"" + principal + "\",\"tenant_id\":\"" + TENANT
                + "\",\"iss\":\"urn:ghatana:media:dev-only\",\"aud\":\"ghatana-media-dev\",\"dev_only\":true,"
                + "\"iat\":" + CLOCK.instant().getEpochSecond() + ",\"exp\":"
                + CLOCK.instant().plusSeconds(120).getEpochSecond() + ",\"permissions\":[" + permissionJson + "]}";
        String signingInput = encode("{\"alg\":\"HS256\",\"typ\":\"JWT\"}") + "." + encode(payload);
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return signingInput + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.US_ASCII)));
    }

    private static String encode(String value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static final class NoEffectProvider implements MediaProcessingProvider {
        @Override public String providerId() { return "dev-grounded-http-no-effect"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.TRANSCODE); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 0; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public java.util.concurrent.CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            return java.util.concurrent.CompletableFuture.failedFuture(new AssertionError("grounded lane must not use jobs"));
        }
    }
}
