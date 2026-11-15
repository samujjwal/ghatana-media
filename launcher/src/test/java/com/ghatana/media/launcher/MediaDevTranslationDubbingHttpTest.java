package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRightsConsentContracts.Reason;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.InMemoryManagedStore;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.TENANT;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.base;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.object;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.read;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.runtime;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.send;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * DEV_ONLY translation and dubbing over the real HTTP host, filter, request ledger and artifact store with a programmable
 * rights resolver and deterministic stand-ins for the two model engines (the real Qwen/Kokoro/Whisper path is covered by
 * {@code MediaDevTranslatedDubbedVideoIT}). The fake synthesizer's duration is 100 ms per character of text, so every
 * fit, tempo and overflow case below is exact.
 */
class MediaDevTranslationDubbingHttpTest {
    private static final String OWNER = "test-principal-owner";
    private static final String OTHER = "test-principal-other";
    private static final Set<String> PERMISSIONS = Set.of("media:project:dev:create", "media:project:dev:read",
            "media:project:dev:write", "media:artifact:read", "media:artifact:create");
    private static final Set<String> READ_ONLY = Set.of("media:project:dev:read", "media:artifact:read");
    private static final ObjectMapper JSON = JsonMapper.builder().build();

    private final ConcurrentHashMap<String, Resolution> overrides = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Verdict> verdicts = new ConcurrentHashMap<>();
    /** New (non-replayed) outputs registered through the lane's registrar. */
    private final AtomicInteger registrations = new AtomicInteger();
    private final AtomicInteger translateCalls = new AtomicInteger();
    private final AtomicInteger synthCalls = new AtomicInteger();
    private final AtomicInteger unknownSynthCalls = new AtomicInteger();
    private final RightsConsentResolver resolver = new RightsConsentResolver() {
        @Override public String resolverId() { return "test-resolver"; }
        @Override public boolean ready() { return true; }
        @Override public Resolution resolve(ResolutionRequest request) {
            Resolution override = overrides.get(request.artifactId());
            if (override != null) return override;
            Verdict verdict = verdicts.getOrDefault(request.artifactId(), Verdict.UNAVAILABLE);
            return switch (verdict) {
                case ADMITTED -> new Resolution(Verdict.ADMITTED, Set.of(), List.of("att-" + request.artifactId()), resolverId());
                case REVOKED -> new Resolution(Verdict.REVOKED, Set.of(Reason.REVOKED), List.of(), resolverId());
                default -> Resolution.unavailable(resolverId());
            };
        }
    };

    private final MediaDevTranslationRuntime.TranslationEngine engine = new MediaDevTranslationRuntime.TranslationEngine() {
        @Override public Set<String> pairs() { return Set.of("en>es"); }
        @Override public boolean ready() { return true; }
        @Override public Map<String, Object> model() { return Map.of("modelId", "test/fake-translator", "mode", "TEXT_ONLY"); }
        @Override public String translate(String text, String source, String target) {
            translateCalls.incrementAndGet();
            // Deterministic stand-in: "hello" -> "hola", anything else keeps its length (so durations stay exact).
            return text.equals("Hello there everyone") ? "Hola a todos ustedes" : "x".repeat(text.length());
        }
    };

    private final MediaDevDubbingRuntime.Synthesizer synthesizer = new MediaDevDubbingRuntime.Synthesizer() {
        @Override public Set<String> voices() { return Set.of("af_heart", "ef_dora", "em_alex"); }
        @Override public Set<String> verifiedLanguages() { return Set.of("en", "es"); }
        @Override public boolean ready() { return true; }
        @Override public Map<String, Object> model() { return Map.of("modelId", "test/fake-tts", "weightsSha256", "0".repeat(64)); }
        @Override public Map<String, Object> runtime() { return Map.of("name", "fake"); }
        @Override public String engine() { return "fake-kokoro"; }
        @Override public MediaDevDubbingRuntime.Synthesized synthesize(String text, String voice) {
            synthCalls.incrementAndGet();
            if (text.contains("BOOM") && unknownSynthCalls.getAndIncrement() == 0) throw MediaDevDubbingRuntime.unknown();
            return new MediaDevDubbingRuntime.Synthesized(MediaDevDubTimingTest.tone(text.length() * 100L, (short) 3000),
                    "0".repeat(64));
        }
    };

    private final MediaDevDubTiming.TempoAdjuster tempo = new MediaDevDubTimingTest.DroppingAdjuster();

    @Test
    void translationKeepsSegmentIdsAndTimesAndIsIdempotentAndRightsBound() throws Exception {
        Path root = Files.createTempDirectory("media-dev-translation-http-");
        MediaRuntime runtime = runtime(root, MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT,
                MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT_PER_TENANT);
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            Fixture fixture = fixture(runtime, List.of(new Cue(0, 2000, "Hello there everyone"),
                    new Cue(2500, 5000, "Second sentence here")));

            // Capabilities: es is admitted, de is not.
            Map<String, Object> capabilities = read(send(base, "GET", "/dev/v1/translations/capabilities", null, OWNER,
                    READ_ONLY).body());
            Map<String, Object> translation = object(capabilities.get("translation"));
            assertThat(object(translation.get("admittedTargets")).get("en")).isEqualTo(List.of("es"));
            assertThat(object(capabilities.get("dubbing"))).containsEntry("voiceCloning", "NOT_SUPPORTED");

            // No rights statement at all: typed denial, nothing registered, the engine is never called.
            int artifactsBefore = registrations.get();
            HttpResponse<String> unattested = translate(base, "tr-1", fixture.transcript, "en", "es");
            assertCode(unattested, 422, "RIGHTS_AUTHORITY_UNAVAILABLE");
            assertThat(translateCalls.get()).isZero();
            assertThat(registrations.get()).isEqualTo(artifactsBefore);

            // The transcript is attested but its original source is not: the chain is refused at the source.
            verdicts.put(fixture.transcript.artifactId(), Verdict.ADMITTED);
            HttpResponse<String> noSource = translate(base, "tr-1", fixture.transcript, "en", "es");
            assertCode(noSource, 422, "RIGHTS_AUTHORITY_UNAVAILABLE");
            assertThat(noSource.body()).contains(fixture.source.artifactId());
            assertThat(translateCalls.get()).isZero();

            verdicts.put(fixture.source.artifactId(), Verdict.ADMITTED);
            HttpResponse<String> created = translate(base, "tr-1", fixture.transcript, "en", "es");
            assertThat(created.statusCode()).as(created.body()).isEqualTo(201);
            Map<String, Object> body = read(created.body());
            assertThat(body).containsEntry("scope", "DEV_ONLY").containsEntry("replayed", false)
                    .containsEntry("targetLanguage", "es").containsEntry("sourceLanguage", "en");
            List<?> segments = (List<?>) body.get("segments");
            assertThat(segments).hasSize(2);
            assertThat(object(segments.get(0))).containsEntry("segmentId", "seg-0001").containsEntry("startMillis", 0)
                    .containsEntry("endMillis", 2000).containsEntry("sourceText", "Hello there everyone")
                    .containsEntry("text", "Hola a todos ustedes");
            assertThat(object(segments.get(1))).containsEntry("segmentId", "seg-0002").containsEntry("startMillis", 2500)
                    .containsEntry("endMillis", 5000);
            Map<String, Object> lineage = object(object(body.get("translation")).get("lineage"));
            assertThat(lineage).containsEntry("kind", MediaDevTranslationRuntime.KIND_TRANSLATED)
                    .containsEntry("targetLanguage", "es").containsEntry("segmentCount", 2);
            assertThat(object(lineage.get("sourceTranscript"))).containsEntry("artifactId", fixture.transcript.artifactId())
                    .containsEntry("artifactVersionId", fixture.transcript.version().value());
            assertThat(object(lineage.get("source"))).containsEntry("artifactId", fixture.source.artifactId());
            assertThat(String.valueOf(lineage.get("rightsDecision"))).contains("att-" + fixture.transcript.artifactId())
                    .contains("att-" + fixture.source.artifactId());
            assertThat(lineage.toString()).as("lineage carries digests, never the text").doesNotContain("Hola a todos");
            assertThat(translateCalls.get()).isEqualTo(2);

            // A second request (new requestId) over the same transcript yields identical text and must register its own output.
            HttpResponse<String> second = translate(base, "tr-again", fixture.transcript, "en", "es");
            assertThat(second.statusCode()).as(second.body()).isEqualTo(201);
            assertThat(read(second.body()).get("translationId")).isNotEqualTo(body.get("translationId"));
            assertThat(translateCalls.get()).isEqualTo(4);
            translateCalls.addAndGet(-2);

            // The same request replays the registered output and never calls the engine again.
            HttpResponse<String> replay = translate(base, "tr-1", fixture.transcript, "en", "es");
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            assertThat(read(replay.body())).containsEntry("replayed", true)
                    .containsEntry("translationId", body.get("translationId"));
            assertThat(translateCalls.get()).isEqualTo(2);
            // A different request under the same requestId is refused.
            assertCode(translate(base, "tr-1", fixture.transcript, "en", "es", "fr"), 422, "LANGUAGE_NOT_ADMITTED");

            // Unadmitted target languages: typed denial before any model or rights lookup.
            HttpResponse<String> german = translate(base, "tr-de", fixture.transcript, "en", "de");
            assertCode(german, 422, "LANGUAGE_NOT_ADMITTED");
            assertThat(german.body()).contains("\"admittedTargets\":[\"es\"]");
            assertCode(translate(base, "tr-en", fixture.transcript, "en", "en"), 422, "LANGUAGE_NOT_ADMITTED");
            assertThat(translateCalls.get()).isEqualTo(2);

            // Revocation at the source refuses even a replay of an earlier success.
            verdicts.put(fixture.source.artifactId(), Verdict.REVOKED);
            HttpResponse<String> revoked = translate(base, "tr-1", fixture.transcript, "en", "es");
            assertCode(revoked, 403, "RIGHTS_DECISION_REVOKED");
            assertThat(revoked.body()).contains(fixture.source.artifactId());
            verdicts.put(fixture.source.artifactId(), Verdict.ADMITTED);

            // Readback, owner scope and permission.
            String translationId = (String) body.get("translationId");
            Map<String, Object> reopened = read(send(base, "GET", "/dev/v1/translations/" + translationId, null, OWNER,
                    READ_ONLY).body());
            assertThat(reopened.get("segments")).isEqualTo(body.get("segments"));
            assertThat(send(base, "GET", "/dev/v1/translations/" + translationId, null, OTHER, READ_ONLY).statusCode())
                    .isEqualTo(404);
            assertThat(send(base, "GET", "/dev/v1/translations/missing", null, OWNER, READ_ONLY).statusCode()).isEqualTo(404);
            assertThat(send(base, "POST", "/dev/v1/translations", translateBody("tr-ro", fixture.transcript, "en", "es"),
                    OWNER, READ_ONLY).statusCode()).as("write permission is required").isEqualTo(403);
            // The route itself also needs artifact create: project write alone is not enough.
            assertCode(send(base, "POST", "/dev/v1/translations", translateBody("tr-nocreate", fixture.transcript, "en", "es"),
                    OWNER, Set.of("media:project:dev:write", "media:artifact:read")), 403, "ARTIFACT_PERMISSION_REQUIRED");
            // Another principal cannot translate an artifact it does not own.
            assertThat(send(base, "POST", "/dev/v1/translations", translateBody("tr-other", fixture.transcript, "en", "es"),
                    OTHER, PERMISSIONS).statusCode()).isEqualTo(404);
            // Strict shapes.
            assertThat(send(base, "POST", "/dev/v1/translations", "{\"requestId\":\"tr-bad\"}", OWNER, PERMISSIONS)
                    .statusCode()).isEqualTo(400);
            // A non-transcript artifact is refused.
            assertCode(translate(base, "tr-src", fixture.source, "en", "es"), 422, "SOURCE_NOT_A_TRANSCRIPT");
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    @Test
    void aHumanRevisionIsANewVersionWithLineageAndNeverChangesIdsOrTimes() throws Exception {
        Path root = Files.createTempDirectory("media-dev-translation-revise-");
        MediaRuntime runtime = runtime(root, MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT,
                MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT_PER_TENANT);
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            Fixture fixture = fixture(runtime, List.of(new Cue(0, 2000, "Hello there everyone"),
                    new Cue(2500, 5000, "Second sentence here")));
            verdicts.put(fixture.transcript.artifactId(), Verdict.ADMITTED);
            verdicts.put(fixture.source.artifactId(), Verdict.ADMITTED);
            Map<String, Object> created = read(translate(base, "tr-1", fixture.transcript, "en", "es").body());
            Map<String, Object> artifact = object(object(created.get("translation")).get("artifact"));
            String id = (String) artifact.get("artifactId");
            String version = (String) artifact.get("artifactVersionId");

            // Wrong set / order, empty text and an unchanged revision are refused with nothing registered.
            int before = registrations.get();
            assertCode(revise(base, "rev-a", id, version, List.of(seg("seg-0001", "Hola"))), 422, "SEGMENT_SET_MISMATCH");
            assertCode(revise(base, "rev-b", id, version, List.of(seg("seg-0002", "a"), seg("seg-0001", "b"))), 422,
                    "SEGMENT_SET_MISMATCH");
            assertCode(revise(base, "rev-c", id, version, List.of(seg("seg-0001", "  "), seg("seg-0002", "b"))), 422,
                    "TRANSLATION_TEXT_INVALID");
            assertCode(revise(base, "rev-d", id, version, List.of(seg("seg-0001", "Hola a todos ustedes"),
                    seg("seg-0002", "xxxxxxxxxxxxxxxxxxxx"))), 422, "TRANSLATION_NOT_CHANGED");
            assertThat(registrations.get()).isEqualTo(before);

            HttpResponse<String> revised = revise(base, "rev-1", id, version,
                    List.of(seg("seg-0001", "Hola a todos"), seg("seg-0002", "Segunda frase")));
            assertThat(revised.statusCode()).as(revised.body()).isEqualTo(201);
            Map<String, Object> body = read(revised.body());
            assertThat(body.get("translationId")).isNotEqualTo(id);
            List<?> segments = (List<?>) body.get("segments");
            assertThat(object(segments.get(0))).containsEntry("segmentId", "seg-0001").containsEntry("endMillis", 2000)
                    .containsEntry("sourceText", "Hello there everyone").containsEntry("text", "Hola a todos");
            Map<String, Object> lineage = object(object(body.get("translation")).get("lineage"));
            assertThat(lineage).containsEntry("kind", MediaDevTranslationRuntime.KIND_REVISED)
                    .containsEntry("editedByPrincipalId", OWNER);
            assertThat(object(lineage.get("parent"))).containsEntry("artifactId", id).containsEntry("artifactVersionId", version);
            assertThat(object(lineage.get("edit"))).containsEntry("changedSegments", 2);
            // The base version is unchanged and the same request replays.
            Map<String, Object> baseAgain = read(send(base, "GET", "/dev/v1/translations/" + id, null, OWNER, READ_ONLY).body());
            assertThat(object(((List<?>) baseAgain.get("segments")).get(0))).containsEntry("text", "Hola a todos ustedes");
            assertThat(revise(base, "rev-1", id, version, List.of(seg("seg-0001", "Hola a todos"),
                    seg("seg-0002", "Segunda frase"))).statusCode()).isEqualTo(200);
            // A revoked original source refuses a revision.
            verdicts.put(fixture.source.artifactId(), Verdict.REVOKED);
            assertCode(revise(base, "rev-2", id, version, List.of(seg("seg-0001", "Hola de nuevo"),
                    seg("seg-0002", "Segunda frase"))), 403, "RIGHTS_DECISION_REVOKED");
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    @Test
    void dubbingFitsEachSegmentToItsWindowReportsOverflowAndNeverTruncatesOrClones() throws Exception {
        Path root = Files.createTempDirectory("media-dev-dub-http-");
        MediaRuntime runtime = runtime(root, MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT,
                MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT_PER_TENANT);
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            // Windows: 4000 ms (fits: 10 chars = 1000 ms), 2000 ms (24 chars = 2400 ms: tempo), then a window we vary.
            Fixture fixture = fixture(runtime, List.of(new Cue(0, 4000, "aaaaaaaaaa"), new Cue(5000, 7000, "bbbbbbbbbbbbbbbbbbbbbbbb"),
                    new Cue(8000, 10000, "cc")));
            verdicts.put(fixture.transcript.artifactId(), Verdict.ADMITTED);
            verdicts.put(fixture.source.artifactId(), Verdict.ADMITTED);
            Map<String, Object> translated = read(translate(base, "tr-1", fixture.transcript, "en", "es").body());
            Map<String, Object> translationArtifact = object(object(translated.get("translation")).get("artifact"));
            String tid = (String) translationArtifact.get("artifactId");
            String tversion = (String) translationArtifact.get("artifactVersionId");

            // Fit + tempo: 1000 ms in 4000, 2400 ms in 2000 (tempo about 1.2), 200 ms in 2000.
            HttpResponse<String> created = dub(base, "dub-1", tid, tversion, null, null);
            assertThat(created.statusCode()).as(created.body()).isEqualTo(201);
            Map<String, Object> body = read(created.body());
            assertThat(body).containsEntry("scope", "DEV_ONLY").containsEntry("replayed", false);
            Map<String, Object> timing = object(body.get("timing"));
            List<?> segments = (List<?>) timing.get("segments");
            assertThat(object(segments.get(0))).containsEntry("fit", "FITS").containsEntry("naturalDurationMillis", 1000)
                    .containsEntry("placedStartMillis", 0).containsEntry("overflow", false);
            Map<String, Object> adjusted = object(segments.get(1));
            assertThat(adjusted).containsEntry("fit", "TEMPO_ADJUSTED").containsEntry("naturalDurationMillis", 2400)
                    .containsEntry("sourceStartMillis", 5000).containsEntry("sourceEndMillis", 7000)
                    .containsEntry("windowMillis", 2000).containsEntry("overflow", false);
            assertThat(((Number) adjusted.get("tempoFactor")).doubleValue()).isBetween(1.19, 1.25);
            assertThat(((Number) adjusted.get("dubDurationMillis")).longValue()).isLessThanOrEqualTo(2000);
            assertThat(object(segments.get(2))).containsEntry("fit", "FITS");
            assertThat(object(timing.get("totals"))).containsEntry("segmentCount", 3).containsEntry("tempoAdjustedCount", 1)
                    .containsEntry("overflowCount", 0);
            assertThat(object(timing.get("lipTiming"))).containsEntry("status", "SOURCE_WINDOWS_ONLY");
            assertThat(timing.get("voice")).isEqualTo("ef_dora");

            // The registered audio is the timing-aligned track: tone at each window start, silence in the gaps.
            Map<String, Object> outputs = object(body.get("outputs"));
            String audioId = (String) object(object(outputs.get("audio")).get("artifact")).get("artifactId");
            short[] track = MediaDevDubTiming.decodeWav(content(runtime, audioId));
            assertThat(track[MediaDevDubTiming.samplesFor(100)]).isEqualTo((short) 3000);
            assertThat(track[MediaDevDubTiming.samplesFor(4500)]).as("gap between windows").isZero();
            assertThat(track[MediaDevDubTiming.samplesFor(5100)]).isEqualTo((short) 3000);
            assertThat(track[MediaDevDubTiming.samplesFor(7500)]).as("gap after the tempo-adjusted segment").isZero();
            assertThat(track[MediaDevDubTiming.samplesFor(8050)]).isEqualTo((short) 3000);
            assertThat(MediaDevDubTiming.millis(track.length)).isBetween(10_000L, 10_001L);
            Map<String, Object> audioLineage = object(object(outputs.get("audio")).get("lineage"));
            assertThat(audioLineage).containsEntry("kind", MediaDevDubbingRuntime.KIND_AUDIO)
                    .containsEntry("voice", "ef_dora").containsEntry("voiceCloning", "NOT_SUPPORTED");
            assertThat(object(audioLineage.get("translatedTranscript"))).containsEntry("artifactId", tid);
            assertThat(object(audioLineage.get("source"))).containsEntry("artifactId", fixture.source.artifactId());
            String captionsId = (String) object(object(outputs.get("captions")).get("artifact")).get("artifactId");
            String vtt = new String(content(runtime, captionsId), StandardCharsets.UTF_8);
            assertThat(vtt).startsWith("WEBVTT").contains("00:00:00.000 --> 00:00:04.000").contains("00:00:05.000 --> 00:00:07.000");

            // Readback by dubId, replay without synthesizing again, owner scope.
            int synthBefore = synthCalls.get();
            String dubId = (String) body.get("dubId");
            Map<String, Object> reopened = read(send(base, "GET", "/dev/v1/dubs/" + dubId, null, OWNER, READ_ONLY).body());
            assertThat(reopened.get("timing")).isEqualTo(body.get("timing"));
            assertThat(reopened.get("dubId")).isEqualTo(dubId);
            HttpResponse<String> replay = dub(base, "dub-1", tid, tversion, null, null);
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            assertThat(read(replay.body())).containsEntry("replayed", true).containsEntry("dubId", dubId);
            assertThat(synthCalls.get()).isEqualTo(synthBefore);
            assertThat(send(base, "GET", "/dev/v1/dubs/" + dubId, null, OTHER, READ_ONLY).statusCode()).isEqualTo(404);
            assertCode(dub(base, "dub-1", tid, tversion, "em_alex", null), 409, "REQUEST_ID_REUSED");

            // Voice rules: a stock voice of the wrong language, an unknown voice and a clone reference.
            assertCode(dub(base, "dub-v1", tid, tversion, "af_heart", null), 422, "VOICE_LOCALE_MISMATCH");
            assertCode(dub(base, "dub-v2", tid, tversion, "ef_unknown", null), 422, "VOICE_NOT_ADMITTED");
            HttpResponse<String> clone = send(base, "POST", "/dev/v1/dubs", JSON.writeValueAsString(Map.of("requestId", "dub-clone",
                    "translatedArtifactId", tid, "translatedArtifactVersionId", tversion, "voiceReference",
                    Map.of("artifactId", fixture.source.artifactId(), "artifactVersionId", fixture.source.version().value()))),
                    OWNER, PERMISSIONS);
            assertThat(clone.statusCode()).as(clone.body()).isIn(403, 422);
            assertThat(clone.body()).containsAnyOf("RIGHTS_AUTHORITY_UNAVAILABLE", "RIGHTS_DECISION_", "VOICE_CLONING_NOT_SUPPORTED");
            // An unknown field (an embedding, a sample) is rejected outright.
            assertThat(send(base, "POST", "/dev/v1/dubs", JSON.writeValueAsString(Map.of("requestId", "dub-f",
                    "translatedArtifactId", tid, "translatedArtifactVersionId", tversion, "voiceSample", "AAAA")), OWNER,
                    PERMISSIONS).statusCode()).isEqualTo(400);

            // Overflow: a 40-char segment (4000 ms) in a 2000 ms window exceeds the 1.25 bound.
            int registered = registrations.get();
            Map<String, Object> longRevision = read(revise(base, "rev-long", tid, tversion, List.of(seg("seg-0001", "a".repeat(10)),
                    seg("seg-0002", "b".repeat(40)), seg("seg-0003", "cc"))).body());
            Map<String, Object> longArtifact = object(object(longRevision.get("translation")).get("artifact"));
            String lid = (String) longArtifact.get("artifactId");
            String lversion = (String) longArtifact.get("artifactVersionId");
            int afterRevision = registrations.get();
            assertThat(afterRevision).isEqualTo(registered + 1);
            HttpResponse<String> overflow = dub(base, "dub-over", lid, lversion, null, null);
            assertCode(overflow, 422, "DUB_TIMING_OVERFLOW");
            Map<String, Object> details = object(object(read(overflow.body()).get("error")).get("details"));
            assertThat(object(((List<?>) details.get("overflowSegments")).get(0))).containsEntry("segmentId", "seg-0002")
                    .containsEntry("reason", "EXCEEDS_WINDOW_AT_MAX_TEMPO").containsEntry("windowMillis", 2000)
                    .containsEntry("naturalDurationMillis", 4000);
            assertThat(((List<?>) details.get("segments"))).hasSize(3);
            assertThat(registrations.get()).as("a refused dub registers nothing").isEqualTo(afterRevision);

            // Spill: the 3200 ms of audio from 5000 ms ends at 8200 ms, after seg-0003 starts at 8000 ms: collision.
            assertCode(dub(base, "dub-spill", lid, lversion, null, "ALLOW_SPILL"), 422, "DUB_TIMING_OVERFLOW");
            // With the next window pushed out, the spill is kept whole and flagged.
            Fixture roomy = fixture(runtime, List.of(new Cue(0, 4000, "aaaaaaaaaa"), new Cue(5000, 7000, "bbbbbbbbbbbbbbbbbbbbbbbb"),
                    new Cue(9000, 10000, "cc")), "roomy");
            verdicts.put(roomy.transcript.artifactId(), Verdict.ADMITTED);
            verdicts.put(roomy.source.artifactId(), Verdict.ADMITTED);
            Map<String, Object> roomyTr = read(translate(base, "tr-roomy", roomy.transcript, "en", "es").body());
            Map<String, Object> roomyArtifact = object(object(roomyTr.get("translation")).get("artifact"));
            String rid = (String) roomyArtifact.get("artifactId");
            String rversion = (String) roomyArtifact.get("artifactVersionId");
            Map<String, Object> roomyLong = read(revise(base, "rev-roomy", rid, rversion, List.of(seg("seg-0001", "a".repeat(10)),
                    seg("seg-0002", "b".repeat(40)), seg("seg-0003", "cc"))).body());
            Map<String, Object> roomyLongArtifact = object(object(roomyLong.get("translation")).get("artifact"));
            HttpResponse<String> spilled = dub(base, "dub-spill-ok", (String) roomyLongArtifact.get("artifactId"),
                    (String) roomyLongArtifact.get("artifactVersionId"), null, "ALLOW_SPILL");
            assertThat(spilled.statusCode()).as(spilled.body()).isEqualTo(201);
            Map<String, Object> spilledSegment = object(((List<?>) object(read(spilled.body()).get("timing")).get("segments")).get(1));
            assertThat(spilledSegment).containsEntry("fit", "OVERFLOW").containsEntry("overflow", true)
                    .containsEntry("tempoFactor", 1.25).containsEntry("dubDurationMillis", 3200)
                    .containsEntry("overflowMillis", 1200).containsEntry("windowMillis", 2000);
            assertThat(object(object(read(spilled.body()).get("timing")).get("totals"))).containsEntry("overflowCount", 1);
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    @Test
    void dubbingRightsAreRecheckedOnEveryCallAndAKilledWorkerIsUnknownThenRegistersOnce() throws Exception {
        Path root = Files.createTempDirectory("media-dev-dub-faults-");
        MediaRuntime runtime = runtime(root, MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT,
                MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT_PER_TENANT);
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            Fixture fixture = fixture(runtime, List.of(new Cue(0, 4000, "aaaaaaaaaa"), new Cue(5000, 9000, "BOOM")));
            verdicts.put(fixture.transcript.artifactId(), Verdict.ADMITTED);
            verdicts.put(fixture.source.artifactId(), Verdict.ADMITTED);
            Map<String, Object> translated = read(translate(base, "tr-1", fixture.transcript, "en", "es").body());
            Map<String, Object> artifact = object(object(translated.get("translation")).get("artifact"));
            String tid = (String) artifact.get("artifactId");
            String tversion = (String) artifact.get("artifactVersionId");
            // The fake translator maps both segments to 'x' runs; revise the second one to the sentinel text.
            Map<String, Object> revision = read(revise(base, "rev-boom", tid, tversion,
                    List.of(seg("seg-0001", "x".repeat(10)), seg("seg-0002", "BOOM"))).body());
            Map<String, Object> boomArtifact = object(object(revision.get("translation")).get("artifact"));
            String bid = (String) boomArtifact.get("artifactId");
            String bversion = (String) boomArtifact.get("artifactVersionId");

            // The first synthesis of the sentinel text ends abnormally: UNKNOWN, nothing registered, retry-safe.
            int before = registrations.get();
            HttpResponse<String> unknown = dub(base, "dub-k", bid, bversion, null, null);
            assertCode(unknown, 503, "DUB_OUTCOME_UNKNOWN");
            assertThat(unknown.body()).contains("\"retrySafe\":true").contains("\"registered\":false");
            assertThat(registrations.get()).isEqualTo(before);
            // The retry with the same requestId registers exactly one dub (audio, captions, timing).
            HttpResponse<String> retried = dub(base, "dub-k", bid, bversion, null, null);
            assertThat(retried.statusCode()).as(retried.body()).isEqualTo(201);
            assertThat(registrations.get()).isEqualTo(before + 3);
            HttpResponse<String> again = dub(base, "dub-k", bid, bversion, null, null);
            assertThat(again.statusCode()).isEqualTo(200);
            assertThat(registrations.get()).isEqualTo(before + 3);

            // Revocation at the original source refuses even the replay, and a revoked translation chain refuses a new dub.
            verdicts.put(fixture.source.artifactId(), Verdict.REVOKED);
            HttpResponse<String> revoked = dub(base, "dub-k", bid, bversion, null, null);
            assertCode(revoked, 403, "RIGHTS_DECISION_REVOKED");
            assertThat(revoked.body()).doesNotContain("\"outputs\"");
            assertCode(dub(base, "dub-new", bid, bversion, null, null), 403, "RIGHTS_DECISION_REVOKED");
            verdicts.remove(fixture.source.artifactId());
            assertCode(dub(base, "dub-new2", bid, bversion, null, null), 422, "RIGHTS_AUTHORITY_UNAVAILABLE");
            assertThat(registrations.get()).isEqualTo(before + 3);
            // A target language the synthesizer does not verify cannot be dubbed (a tampered/other-language document).
            assertCode(send(base, "POST", "/dev/v1/dubs", JSON.writeValueAsString(Map.of("requestId", "dub-nothing",
                    "translatedArtifactId", fixture.source.artifactId(), "translatedArtifactVersionId",
                    fixture.source.version().value())), OWNER, PERMISSIONS), 422, "SOURCE_NOT_A_TRANSLATION");
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    @Test
    void aDerivativeInheritsRightsFromItsAttestedRootOnlyWhenItHasNoStatementOfItsOwn() throws Exception {
        Path root = Files.createTempDirectory("media-dev-derivative-rights-");
        MediaRuntime runtime = runtime(root, MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT,
                MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT_PER_TENANT);
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            Fixture fixture = fixture(runtime, List.of(new Cue(0, 2000, "Hello there everyone")));
            String transcript = fixture.transcript.artifactId();
            verdicts.put(fixture.source.artifactId(), Verdict.ADMITTED);
            // 1. No statement at all on the derivative (the DEV authority answers DENIED/NO_ATTESTATION), attested root: admitted.
            overrides.put(transcript, new Resolution(Verdict.DENIED, Set.of(Reason.NO_ATTESTATION), List.of(), "test-resolver"));
            assertThat(translate(base, "dr-1", fixture.transcript, "en", "es").statusCode()).isEqualTo(201);
            // 2. The derivative's own statement does not cover PROCESSING: refused.
            overrides.put(transcript, new Resolution(Verdict.DENIED, Set.of(Reason.SCOPE_NOT_COVERED), List.of(), "test-resolver"));
            assertCode(translate(base, "dr-2", fixture.transcript, "en", "es"), 403, "RIGHTS_DECISION_DENIED");
            overrides.put(transcript, new Resolution(Verdict.DENIED, Set.of(Reason.NO_ATTESTATION, Reason.NOT_CONFIRMED),
                    List.of(), "test-resolver"));
            assertCode(translate(base, "dr-2b", fixture.transcript, "en", "es"), 403, "RIGHTS_DECISION_DENIED");
            // 3. The derivative is revoked, stale or mismatching: refused.
            for (Verdict verdict : List.of(Verdict.REVOKED, Verdict.STALE, Verdict.MISMATCH)) {
                overrides.put(transcript, new Resolution(verdict, Set.of(Reason.REVOKED), List.of(), "test-resolver"));
                assertCode(translate(base, "dr-3-" + verdict, fixture.transcript, "en", "es"), 403, "RIGHTS_DECISION_" + verdict);
            }
            // 4. A revoked root refuses even a derivative with no statement.
            overrides.put(transcript, new Resolution(Verdict.DENIED, Set.of(Reason.NO_ATTESTATION), List.of(), "test-resolver"));
            verdicts.put(fixture.source.artifactId(), Verdict.REVOKED);
            assertCode(translate(base, "dr-4", fixture.transcript, "en", "es"), 403, "RIGHTS_DECISION_REVOKED");
            // 5. An unavailable resolver refuses.
            verdicts.put(fixture.source.artifactId(), Verdict.UNAVAILABLE);
            assertCode(translate(base, "dr-5", fixture.transcript, "en", "es"), 422, "RIGHTS_AUTHORITY_UNAVAILABLE");
            // An unattested root (DENIED) is refused even though the derivative alone would be inherited.
            verdicts.put(fixture.source.artifactId(), Verdict.DENIED);
            assertThat(translate(base, "dr-6", fixture.transcript, "en", "es").statusCode()).isIn(403, 422);
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    // ---- helpers ----

    private record Cue(long start, long end, String text) { }

    private record Fixture(MediaArtifact source, MediaArtifact transcript) { }

    private HttpServer server(MediaRuntime runtime) throws Exception {
        MediaDevProjectTimelineRuntime projects = new MediaDevProjectTimelineRuntime(new InMemoryManagedStore());
        HttpServer server = MediaDevProjectRenderHttpTest.server(runtime, projects, null);
        server.removeContext("/");
        MediaDevRequestLedger ledger = MediaDevRequestLedger.inMemory();
        MediaDevProjectRenderRuntime.OutputRegistrar canonical = MediaDevProjectRenderRuntime.canonicalRegistrar(runtime);
        MediaDevProjectRenderRuntime.OutputRegistrar counting = (tenant, principal, request, key, bytes) -> {
            var registered = canonical.register(tenant, principal, request, key, bytes);
            if (!registered.replayed()) registrations.incrementAndGet();
            return registered;
        };
        MediaDevDubSupport support = new MediaDevDubSupport(runtime, counting, resolver);
        MediaDevTranslationRuntime translations = new MediaDevTranslationRuntime(runtime, support, engine,
                () -> Set.of("en", "es"), ledger);
        MediaDevSpeechRuntime speech = new MediaDevSpeechRuntime(runtime,
                MediaDevProjectRenderRuntime.canonicalRegistrar(runtime), null, null,
                MediaDevSpeechRuntime.SpeechRightsGate.unavailable(), MediaDevSpeechRuntime.SpeechRightsGate.unavailable());
        MediaDevDubbingRuntime dubbing = new MediaDevDubbingRuntime(runtime, support, translations, speech, synthesizer, tempo,
                (tenant, principal, operation, source) -> new MediaDevSpeechRuntime.SpeechRightsGate.Decision(
                        MediaDevSpeechRuntime.SpeechRightsGate.Outcome.ALLOWED, "", "dev-lane:test"), ledger);
        MediaHttpHandler handler = new MediaHttpHandler(runtime, null, null, projects)
                .withDevDub(new MediaDevDubRoutes(translations, dubbing, runtime));
        server.createContext("/", new MediaSecurityFilter(handler, "dev", Map.of("MEDIA_DEV_IDENTITY_ENABLED", "true",
                "MEDIA_DEV_JWT_HMAC_SECRET", "test-only-dev-project-secret-at-least-32-bytes"),
                java.time.Clock.fixed(java.time.Instant.parse("2026-11-13T20:00:00Z"), java.time.ZoneOffset.UTC)));
        return server;
    }

    private Fixture fixture(MediaRuntime runtime, List<Cue> cues) throws Exception {
        return fixture(runtime, cues, "main");
    }

    /** A source audio artifact and the STT transcript artifact the speech lane would have written for it. */
    private Fixture fixture(MediaRuntime runtime, List<Cue> cues, String name) throws Exception {
        MediaArtifact source = upload(runtime, "source-" + name + ".wav", "audio/wav",
                MediaDevDubTiming.encodeWav(MediaDevDubTimingTest.tone(500, (short) 100)), Map.of());
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("speechSchema", MediaDevSpeechRuntime.SCHEMA);
        metadata.put("scope", "DEV_ONLY");
        metadata.put("kind", MediaDevSpeechRuntime.KIND_TRANSCRIPT);
        metadata.put("requestId", "stt-fixture-" + name);
        metadata.put("language", "en");
        metadata.put("source", Map.of("artifactId", source.artifactId(), "artifactVersionId", source.version().value(),
                "sha256", source.sha256(), "contentType", "audio/wav"));
        Map<String, Object> document = new LinkedHashMap<>();
        document.put("schema", "media.dev.speech-transcript.v1");
        document.put("language", "en");
        document.put("text", String.join(" ", cues.stream().map(Cue::text).toList()));
        document.put("segments", cues.stream().map(cue -> Map.of("startMillis", cue.start(), "endMillis", cue.end(),
                "text", cue.text())).toList());
        MediaArtifact transcript = upload(runtime, "transcript-" + name + ".json", "application/json",
                JSON.writeValueAsBytes(document), metadata);
        return new Fixture(source, transcript);
    }

    private static MediaArtifact upload(MediaRuntime runtime, String name, String contentType, byte[] bytes,
                                        Map<String, Object> metadata) throws Exception {
        String digest = HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        var session = runtime.beginUpload(new UploadRequest(TENANT, OWNER, name, contentType, bytes.length, digest,
                "INTERNAL", Duration.ofMinutes(30), metadata), "fixture-" + name + "-" + digest);
        runtime.appendChunk(TENANT, OWNER, session.uploadId(), 0, bytes);
        return runtime.completeUpload(TENANT, OWNER, session.uploadId());
    }

    private static byte[] content(MediaRuntime runtime, String artifactId) throws Exception {
        MediaArtifact artifact = runtime.artifact(TENANT, OWNER, artifactId).orElseThrow();
        var out = new java.io.ByteArrayOutputStream();
        runtime.copyArtifactContent(TENANT, OWNER, artifactId, artifact.version(), out, 8 << 20).orElseThrow();
        return out.toByteArray();
    }

    private static Map<String, Object> seg(String id, String text) {
        return Map.of("segmentId", id, "text", text);
    }

    private static String translateBody(String requestId, MediaArtifact transcript, String source, String target) throws Exception {
        return JSON.writeValueAsString(Map.of("requestId", requestId, "transcriptArtifactId", transcript.artifactId(),
                "transcriptArtifactVersionId", transcript.version().value(), "sourceLanguage", source,
                "targetLanguage", target));
    }

    private HttpResponse<String> translate(String base, String requestId, MediaArtifact transcript, String source,
                                           String target) throws Exception {
        return send(base, "POST", "/dev/v1/translations", translateBody(requestId, transcript, source, target), OWNER,
                PERMISSIONS);
    }

    private HttpResponse<String> translate(String base, String requestId, MediaArtifact transcript, String source,
                                           String target, String differentTarget) throws Exception {
        return send(base, "POST", "/dev/v1/translations", translateBody(requestId, transcript, source, differentTarget),
                OWNER, PERMISSIONS);
    }

    private HttpResponse<String> revise(String base, String requestId, String id, String version,
                                        List<Map<String, Object>> segments) throws Exception {
        return send(base, "POST", "/dev/v1/translations/revisions", JSON.writeValueAsString(Map.of("requestId", requestId,
                "baseArtifactId", id, "baseArtifactVersionId", version, "segments", segments)), OWNER, PERMISSIONS);
    }

    private HttpResponse<String> dub(String base, String requestId, String id, String version, String voice,
                                     String policy) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("translatedArtifactId", id);
        body.put("translatedArtifactVersionId", version);
        if (voice != null) body.put("voice", voice);
        if (policy != null) body.put("overflowPolicy", policy);
        return send(base, "POST", "/dev/v1/dubs", JSON.writeValueAsString(body), OWNER, PERMISSIONS);
    }

    private static void assertCode(HttpResponse<String> response, int status, String code) {
        assertThat(response.statusCode()).as(response.body()).isEqualTo(status);
        assertThat(response.body()).contains(code);
    }
}
