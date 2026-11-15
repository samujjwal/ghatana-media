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
import java.security.SecureRandom;
import java.sql.DriverManager;
import java.text.Normalizer;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.Decoded;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.decode;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffmpeg;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffprobe;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.kokoroEnvironment;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.modelRoot;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.probe;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.stream;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-16 outcome journey {@code media.dev.outcome-translated-dubbed-video}, end to end against REAL processes: a real
 * launcher (PostgreSQL + S3), real Kokoro-82M (persistent GPU worker, English narration and Spanish dub), real Whisper
 * large-v3-turbo (English transcription of the source and Spanish recognition of the dub), real Qwen2.5-VL-7B-Instruct
 * (text-only machine translation through the loopback vision sidecar), real FFmpeg (muxing, tempo, render) and a real
 * rights authority. Principals are clearly synthetic test principals; the rights statements are statements by those test
 * principals about a generated source, not a legal determination, and nothing here is a human approval.
 *
 * <p>Journey: Kokoro-English-narrated MP4 with on-screen content -> rights attestation of the extracted narration audio
 * -> Whisper English transcript -> Qwen English-to-Spanish translation (segment ids and source-clock times kept) -> a
 * human revision of one segment as a new version -> Spanish dub with a Spanish stock voice fitted to the source windows
 * (timing metadata) -> Whisper Spanish on the dub (WER against the translation) and independent onset measurement -> the
 * dub, its captions and the source frame rendered to a dubbed MP4 through the existing timeline render path -> launcher
 * restart readback. Faults: unadmitted target language, an overflowing translation (typed, nothing registered, nothing
 * truncated), a voice-clone reference, rights missing (a second unattested source), the sidecar killed (UNKNOWN, one
 * registration on retry), the Kokoro worker killed mid-dub (UNKNOWN, one registration on retry), and rights revoked
 * (translation and dub refused, a replay included, and across a restart).</p>
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevTranslatedDubbedVideoIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private static final List<String> NARRATION = List.of(
            "Welcome to our quarterly report presentation.",
            "Revenue grew by twelve percent this year, driven by strong demand in Europe.",
            "Thank you for watching, and see you next time.");
    /** Independent human-authored Spanish reference for the narration (informational comparison only). */
    private static final List<String> REFERENCE_ES = List.of(
            "Bienvenidos a nuestra presentación del informe trimestral.",
            "Los ingresos crecieron un doce por ciento este año, impulsados por la fuerte demanda en Europa.",
            "Gracias por ver, y nos vemos la próxima vez.");
    private static final String PROVENANCE = "TEST: narration generated by Kokoro-82M inside an automated test and muxed "
            + "with a generated frame; a statement by a synthetic test principal, not a legal determination";
    private static final double DUB_WER_MAX = 0.30;

    @Test
    void englishNarratedVideoBecomesTranslatedAndDubbedSpanishVideoAndTheFaultSuiteHolds() throws Exception {
        try (Live live = Live.start()) {
            // ---- real input: Kokoro English narration over generated on-screen content, muxed to MP4 ----
            Source source = live.buildSource();
            String narrationId = live.upload("narration-en.wav", "audio/wav", source.wav);
            String narrationVersion = "sha256:" + sha256(source.wav);
            String videoId = live.upload("source-en.mp4", "video/mp4", source.mp4);
            System.out.println("J16_SOURCE mp4Bytes=" + source.mp4.length + " wavBytes=" + source.wav.length
                    + " narration=" + NARRATION);

            JsonNode capabilities = live.ownerGet("/dev/v1/translations/capabilities", 200);
            assertThat(capabilities.path("translation").path("admittedTargets").path("en")).extracting(JsonNode::asString)
                    .containsExactly("es");
            assertThat(capabilities.path("translation").path("ready").asBoolean()).isTrue();
            assertThat(capabilities.path("dubbing").path("ready").asBoolean()).isTrue();
            assertThat(capabilities.path("dubbing").path("voices").propertyNames()).contains("ef_dora", "em_alex", "em_santa");
            assertThat(capabilities.path("dubbing").path("voiceCloning").asString()).isEqualTo("NOT_SUPPORTED");
            assertThat(capabilities.path("dubbing").path("tempo").path("available").asBoolean()).isTrue();

            // ---- rights missing: an unattested source is refused with nothing registered ----
            Map<String, Object> sttBody = Map.of("requestId", "stt-" + live.run, "artifactId", narrationId,
                    "artifactVersionId", narrationVersion, "language", "en");
            HttpResponse<String> unattested = live.owner("POST", "/dev/v1/speech/transcriptions", sttBody);
            assertThat(unattested.statusCode()).as(unattested.body()).isEqualTo(403);
            assertThat(live.rows("LOCAL_STT_TRANSCRIPT")).as("an unattested source registered no transcript").isZero();

            // ---- Whisper English transcript of the exact narration version ----
            String attestationId = live.attest(narrationId, narrationVersion);
            live.attest(videoId, "sha256:" + sha256(source.mp4));
            JsonNode stt = live.ownerPost("/dev/v1/speech/transcriptions", sttBody, 201);
            String transcriptId = stt.path("transcript").path("artifact").path("artifactId").asString();
            String transcriptVersion = stt.path("transcript").path("artifact").path("artifactVersionId").asString();
            String englishText = normalize(stt.path("text").asString());
            System.out.println("J16_WHISPER_EN text=\"" + stt.path("text").asString() + "\" cues=" + stt.path("cueCount").asInt());
            assertThat(englishText).contains("welcome").contains("revenue").containsAnyOf("twelve", "12").contains("thank you");

            // ---- unadmitted target language: typed denial, no model run, nothing registered ----
            int translationRows = live.rows("translationSchema");
            for (String language : List.of("de", "fr", "ne")) {
                HttpResponse<String> denied = live.owner("POST", "/dev/v1/translations", translateBody(
                        "tr-" + language + "-" + live.run, transcriptId, transcriptVersion, "en", language));
                assertThat(denied.statusCode()).as(denied.body()).isEqualTo(422);
                assertThat(denied.body()).contains("LANGUAGE_NOT_ADMITTED").contains("\"admittedTargets\":[\"es\"]");
            }
            assertThat(live.rows("translationSchema")).isEqualTo(translationRows);

            // ---- real Qwen English-to-Spanish translation, segment by segment ----
            long started = System.nanoTime();
            JsonNode translation = live.ownerPost("/dev/v1/translations", translateBody("tr-" + live.run, transcriptId,
                    transcriptVersion, "en", "es"), 201);
            long translationMillis = (System.nanoTime() - started) / 1_000_000;
            String translationId = translation.path("translationId").asString();
            String translationVersion = translation.path("translation").path("artifact").path("artifactVersionId").asString();
            JsonNode sttCues = live.ownerGet("/dev/v1/speech/outputs/" + transcriptId, 200);
            List<String> machineText = new ArrayList<>();
            for (JsonNode segment : translation.path("segments")) machineText.add(segment.path("text").asString());
            System.out.println("J16_TRANSLATION_ES millis=" + translationMillis + " segments=" + translation.path("segments"));
            assertThat(translation.path("segments").size()).isGreaterThanOrEqualTo(2);
            assertThat(translation.path("targetLanguage").asString()).isEqualTo("es");
            JsonNode translationLineage = translation.path("translation").path("lineage");
            assertThat(translationLineage.path("kind").asString()).isEqualTo("LOCAL_TRANSLATED_TRANSCRIPT");
            assertThat(translationLineage.path("sourceTranscript").path("artifactId").asString()).isEqualTo(transcriptId);
            assertThat(translationLineage.path("sourceTranscript").path("artifactVersionId").asString()).isEqualTo(transcriptVersion);
            assertThat(translationLineage.path("source").path("artifactId").asString()).isEqualTo(narrationId);
            assertThat(translationLineage.path("model").path("modelId").asString()).isEqualTo("Qwen/Qwen2.5-VL-7B-Instruct");
            assertThat(translationLineage.path("model").path("mode").asString()).isEqualTo("TEXT_ONLY");
            assertThat(translationLineage.path("rightsDecision").asString()).contains(attestationId);
            // Segment ids and times are exactly the transcript's (read back independently from the stored transcript).
            JsonNode storedTranscript = JSON.readTree(s3Bytes(LOCALSTACK, live.bucket, storedArtifact(POSTGRES, live.tenant,
                    live.owner, transcriptId)));
            assertThat(translation.path("segments").size()).isEqualTo(storedTranscript.path("segments").size());
            for (int i = 0; i < translation.path("segments").size(); i++) {
                JsonNode out = translation.path("segments").get(i);
                JsonNode in = storedTranscript.path("segments").get(i);
                assertThat(out.path("segmentId").asString()).isEqualTo(String.format("seg-%04d", i + 1));
                assertThat(out.path("startMillis").asLong()).isEqualTo(in.path("startMillis").asLong());
                assertThat(out.path("endMillis").asLong()).isEqualTo(in.path("endMillis").asLong());
                assertThat(out.path("sourceText").asString()).isEqualTo(in.path("text").asString().strip());
                assertThat(out.path("text").asString()).isNotBlank().isNotEqualTo(out.path("sourceText").asString());
            }
            String spanish = normalize(String.join(" ", machineText));
            assertThat(spanish).as("the translation is Spanish").containsAnyOf(" de ", " la ", " el ", " los ", " a ", " por ", " para ");
            System.out.println("J16_TRANSLATION_VS_REFERENCE_WER=" + wer(String.join(" ", REFERENCE_ES), String.join(" ", machineText))
                    + " (informational: machine translation against an independent human-authored reference)");
            assertThat(sttCues.path("artifact").path("artifactId").asString()).isEqualTo(transcriptId);

            // Idempotent: the same request replays and runs no model.
            JsonNode replayed = live.ownerPost("/dev/v1/translations", translateBody("tr-" + live.run, transcriptId,
                    transcriptVersion, "en", "es"), 200);
            assertThat(replayed.path("replayed").asBoolean()).isTrue();
            assertThat(replayed.path("translationId").asString()).isEqualTo(translationId);
            assertThat(live.rows("translationSchema")).isEqualTo(translationRows + 1);

            // ---- a human revision of segment 1 as a NEW version (editable before dubbing) ----
            List<Map<String, Object>> revision = new ArrayList<>();
            for (int i = 0; i < translation.path("segments").size(); i++) {
                String text = translation.path("segments").get(i).path("text").asString();
                // Human edits: a wording change for segment 1 and the reviewer's own phrasing for segment 2.
                if (i == 0) text = "Bienvenidos a todos a nuestra presentación del informe trimestral.";
                if (i == 1) text = REFERENCE_ES.get(1);
                revision.add(Map.of("segmentId", String.format("seg-%04d", i + 1), "text", text));
            }
            JsonNode revised = live.ownerPost("/dev/v1/translations/revisions", Map.of("requestId", "rev-" + live.run,
                    "baseArtifactId", translationId, "baseArtifactVersionId", translationVersion, "segments", revision), 201);
            String revisedId = revised.path("translationId").asString();
            String revisedVersion = revised.path("translation").path("artifact").path("artifactVersionId").asString();
            assertThat(revisedId).isNotEqualTo(translationId);
            assertThat(revised.path("translation").path("lineage").path("parent").path("artifactVersionId").asString())
                    .isEqualTo(translationVersion);
            assertThat(live.ownerGet("/dev/v1/translations/" + translationId, 200).path("segments"))
                    .as("the machine version is unchanged").isEqualTo(translation.path("segments"));
            List<String> finalText = new ArrayList<>();
            for (JsonNode segment : revised.path("segments")) finalText.add(segment.path("text").asString());

            // ---- overflow: a translation far too long for its window is a typed refusal, nothing truncated ----
            String longText = "Bienvenidos a todos ustedes a esta presentación extraordinariamente larga del informe "
                    + "trimestral de resultados financieros de nuestra empresa, que no cabe en la ventana original.";
            List<Map<String, Object>> overflowing = new ArrayList<>(revision);
            overflowing.set(0, Map.of("segmentId", "seg-0001", "text", longText));
            JsonNode overflowRevision = live.ownerPost("/dev/v1/translations/revisions", Map.of("requestId", "rev-long-" + live.run,
                    "baseArtifactId", translationId, "baseArtifactVersionId", translationVersion, "segments", overflowing), 201);
            int dubRows = live.rows("dubSchema");
            HttpResponse<String> overflow = live.owner("POST", "/dev/v1/dubs", dubBody("dub-over-" + live.run,
                    overflowRevision.path("translationId").asString(),
                    overflowRevision.path("translation").path("artifact").path("artifactVersionId").asString(), null, null));
            assertThat(overflow.statusCode()).as(overflow.body()).isEqualTo(422);
            JsonNode overflowDetails = JSON.readTree(overflow.body()).path("error").path("details");
            System.out.println("J16_OVERFLOW " + overflow.body());
            assertThat(JSON.readTree(overflow.body()).path("error").path("code").asString()).isEqualTo("DUB_TIMING_OVERFLOW");
            assertThat(overflowDetails.path("overflowSegments").get(0).path("segmentId").asString()).isEqualTo("seg-0001");
            assertThat(overflowDetails.path("overflowSegments").get(0).path("requiredTempoFactor").asDouble()).isGreaterThan(1.25);
            assertThat(overflowDetails.path("segments").size()).isEqualTo(revision.size());
            HttpResponse<String> spill = live.owner("POST", "/dev/v1/dubs", dubBody("dub-spill-" + live.run,
                    overflowRevision.path("translationId").asString(),
                    overflowRevision.path("translation").path("artifact").path("artifactVersionId").asString(), null, "ALLOW_SPILL"));
            assertThat(spill.statusCode()).as(spill.body()).isEqualTo(422);
            assertThat(spill.body()).contains("DUB_TIMING_OVERFLOW");
            assertThat(live.rows("dubSchema")).as("a refused dub registers nothing, truncated or not").isEqualTo(dubRows);

            // ---- voice clone reference: refused, nothing registered ----
            HttpResponse<String> clone = live.owner("POST", "/dev/v1/dubs", Map.of("requestId", "dub-clone-" + live.run,
                    "translatedArtifactId", revisedId, "translatedArtifactVersionId", revisedVersion, "voiceReference",
                    Map.of("artifactId", narrationId, "artifactVersionId", narrationVersion)));
            assertThat(clone.statusCode()).as(clone.body()).isIn(403, 422);
            assertThat(clone.body()).containsAnyOf("RIGHTS_DECISION_", "RIGHTS_AUTHORITY_UNAVAILABLE", "VOICE_CLONING_NOT_SUPPORTED");
            assertThat(live.rows("dubSchema")).isEqualTo(dubRows);

            // ---- the Spanish dub: real Kokoro es stock voice, fitted to the source windows ----
            started = System.nanoTime();
            JsonNode dub = live.ownerPost("/dev/v1/dubs", Map.of("requestId", "dub-" + live.run, "translatedArtifactId", revisedId,
                    "translatedArtifactVersionId", revisedVersion, "overflowPolicy", "ALLOW_SPILL"), 201);
            long dubMillis = (System.nanoTime() - started) / 1_000_000;
            String dubId = dub.path("dubId").asString();
            JsonNode timing = dub.path("timing");
            System.out.println("J16_DUB_TIMING millis=" + dubMillis + " " + timing);
            assertThat(timing.path("voice").asString()).isEqualTo("ef_dora");
            assertThat(timing.path("lipTiming").path("status").asString()).isEqualTo("SOURCE_WINDOWS_ONLY");
            assertThat(timing.path("segments").size()).isEqualTo(revision.size());
            String audioId = dub.path("outputs").path("audio").path("artifact").path("artifactId").asString();
            String audioVersion = dub.path("outputs").path("audio").path("artifact").path("artifactVersionId").asString();
            String captionsId = dub.path("outputs").path("captions").path("artifact").path("artifactId").asString();
            String captionsVersion = dub.path("outputs").path("captions").path("artifact").path("artifactVersionId").asString();
            JsonNode audioLineage = dub.path("outputs").path("audio").path("lineage");
            assertThat(audioLineage.path("voice").asString()).isEqualTo("ef_dora");
            assertThat(audioLineage.path("voiceCloning").asString()).isEqualTo("NOT_SUPPORTED");
            assertThat(audioLineage.path("translatedTranscript").path("artifactVersionId").asString()).isEqualTo(revisedVersion);
            assertThat(audioLineage.path("source").path("artifactId").asString()).isEqualTo(narrationId);
            assertThat(audioLineage.path("model").path("modelId").asString()).isEqualTo("hexgrad/Kokoro-82M");
            assertThat(audioLineage.path("rightsDecision").asString()).contains(attestationId);

            // Independent measurement of the registered track: ffprobe duration, decoded onsets and silent gaps.
            byte[] dubWav = s3Bytes(LOCALSTACK, live.bucket, storedArtifact(POSTGRES, live.tenant, live.owner, audioId));
            assertThat(sha256(dubWav)).isEqualTo(dub.path("outputs").path("audio").path("artifact").path("sha256").asString());
            JsonNode wavProbe = probe(dubWav, "wav");
            double wavSeconds = Double.parseDouble(stream(wavProbe, "audio").path("duration").asString("0"));
            assertThat(stream(wavProbe, "audio").path("sample_rate").asString()).isEqualTo("24000");
            assertThat(wavSeconds * 1000).isBetween(timing.path("totals").path("trackDurationMillis").asDouble() - 20,
                    timing.path("totals").path("trackDurationMillis").asDouble() + 20);
            short[] pcm = pcm24k(dubWav);
            long worstOnsetMillis = 0;
            for (int i = 0; i < timing.path("segments").size(); i++) {
                JsonNode segment = timing.path("segments").get(i);
                long start = segment.path("sourceStartMillis").asLong();
                long placedEnd = segment.path("placedEndMillis").asLong();
                assertThat(segment.path("placedStartMillis").asLong()).isEqualTo(start);
                assertThat(segment.path("tempoFactor").asDouble()).isBetween(1.0, 1.25);
                assertThat(segment.path("dubDurationMillis").asLong()).isGreaterThan(0)
                        .isEqualTo(placedEnd - start);
                if (segment.path("overflow").asBoolean()) {
                    assertThat(segment.path("overflowMillis").asLong()).isEqualTo(segment.path("dubDurationMillis").asLong()
                            - segment.path("windowMillis").asLong());
                } else {
                    assertThat(segment.path("dubDurationMillis").asLong()).isLessThanOrEqualTo(segment.path("windowMillis").asLong());
                }
                long onset = firstAbove(pcm, Math.max(0, start - 100), 300);
                System.out.println("J16_ONSET segment=" + segment.path("segmentId").asString() + " sourceStartMs=" + start
                        + " onsetMs=" + onset + " fit=" + segment.path("fit").asString() + " tempo="
                        + segment.path("tempoFactor").asDouble() + " natural=" + segment.path("naturalDurationMillis").asLong()
                        + " dub=" + segment.path("dubDurationMillis").asLong() + " window=" + segment.path("windowMillis").asLong());
                assertThat(onset).as("speech starts at its source window start (+ the voice's own lead-in)")
                        .isBetween(start, start + 500);
                worstOnsetMillis = Math.max(worstOnsetMillis, onset - start);
                long next = i + 1 < timing.path("segments").size()
                        ? timing.path("segments").get(i + 1).path("sourceStartMillis").asLong() : pcm.length * 1000L / 24_000;
                assertThat(firstAbove(pcm, placedEnd + 20, 1)).as("exact silence between a segment and the next one")
                        .isGreaterThanOrEqualTo(next);
            }
            System.out.println("J16_ALIGNMENT worstOnsetAfterSourceStartMs=" + worstOnsetMillis);

            // ---- Whisper Spanish on the dub: it speaks the translation (WER) ----
            live.attest(audioId, audioVersion);
            JsonNode dubStt = live.ownerPost("/dev/v1/speech/transcriptions", Map.of("requestId", "stt-es-" + live.run,
                    "artifactId", audioId, "artifactVersionId", audioVersion, "language", "es"), 201);
            String recognized = dubStt.path("text").asString();
            double dubWer = wer(String.join(" ", finalText), recognized);
            double dubCer = cer(String.join(" ", finalText), recognized);
            System.out.println("J16_DUB_WHISPER_ES text=\"" + recognized + "\" reference=\"" + String.join(" ", finalText)
                    + "\" WER=" + dubWer + " CER=" + dubCer);
            assertThat(dubWer).as("Whisper es recognizes the dubbed speech as the translation").isLessThanOrEqualTo(DUB_WER_MAX);

            // ---- dubbed MP4: source frame + Spanish dub + Spanish captions through the existing timeline render ----
            byte[] frame = live.extractFrame(source);
            String frameId = live.upload("source-frame.png", "image/png", frame);
            long ticks = Math.max(1, (long) Math.floor(wavSeconds * 24));
            String workspaceId = live.ownerGet("/dev/v1/context", 200).path("selectedAuthorizedWorkspaceId").asString();
            JsonNode project = live.ownerPost("/dev/v1/projects", Map.of("selectedAuthorizedWorkspaceId", workspaceId,
                    "title", "J-16 dubbed video " + live.run, "requestId", "j16-project-" + live.run), 201);
            String projectId = project.path("project").path("projectId").asString();
            String head = live.ownerPost("/dev/v1/projects/" + projectId + "/timelines", Map.of("expectedHeadRevisionId",
                    project.path("initialRevision").path("revisionId").asString(), "timelineId", "timeline-main"), 201)
                    .path("revision").path("revisionId").asString();
            String revisionId = live.ownerPost("/dev/v1/projects/" + projectId + "/timelines/timeline-main/edits", Map.of(
                    "expectedHeadRevisionId", head, "edits", List.of(
                            Map.of("type", "addScene", "sceneId", "scene-main", "order", 0),
                            Map.of("type", "addTrack", "trackId", "video-main", "sceneId", "scene-main", "trackKind", "VIDEO", "order", 0),
                            clip("clip-frame", "video-main", frameId, "sha256:" + sha256(frame), 1, ticks),
                            Map.of("type", "addTrack", "trackId", "audio-dub", "sceneId", "scene-main", "trackKind", "AUDIO", "order", 1),
                            clip("clip-dub", "audio-dub", audioId, audioVersion, ticks, ticks),
                            Map.of("type", "addTrack", "trackId", "caption-es", "sceneId", "scene-main", "trackKind", "CAPTION", "order", 2),
                            clip("clip-captions", "caption-es", captionsId, captionsVersion, ticks, ticks))), 201)
                    .path("revision").path("revisionId").asString();
            JsonNode render = live.ownerPost("/dev/v1/projects/" + projectId + "/renders", Map.of("requestId", "j16-render-" + live.run,
                    "revisionId", revisionId, "timelineId", "timeline-main", "width", 320, "height", 180, "framesPerSecond", 10,
                    "format", "mp4"), 201);
            String renderId = render.path("renderId").asString();
            byte[] mp4 = s3Bytes(LOCALSTACK, live.bucket, storedArtifact(POSTGRES, live.tenant, live.owner, renderId));
            assertThat(sha256(mp4)).isEqualTo(render.path("artifact").path("sha256").asString());
            JsonNode mp4Probe = probe(mp4, "mp4");
            assertThat(stream(mp4Probe, "video").path("codec_name").asString()).isEqualTo("h264");
            assertThat(stream(mp4Probe, "audio").path("codec_name").asString()).isEqualTo("aac");
            assertThat(stream(mp4Probe, "subtitle")).as("Spanish captions are in the MP4").isNotNull();
            double mp4AudioSeconds = Double.parseDouble(stream(mp4Probe, "audio").path("duration").asString("0"));
            assertThat(mp4AudioSeconds).isBetween(wavSeconds - 0.3, wavSeconds + 0.3);
            Decoded mp4Audio = decode(mp4, "mp4");
            System.out.println("J16_DUBBED_MP4 bytes=" + mp4.length + " audioSeconds=" + mp4AudioSeconds + " rms=" + mp4Audio.rms()
                    + " streams=" + mp4Probe.path("streams").size());
            assertThat(mp4Audio.rms()).as("the Spanish dub is audible in the MP4").isGreaterThan(100.0);
            String subtitles = live.subtitleText(mp4);
            assertThat(normalize(subtitles)).contains(normalize(finalText.get(0)).substring(0, 20));
            boolean dubSourced = false;
            boolean captionSourced = false;
            for (JsonNode sourceRef : render.path("lineage").path("sources")) {
                if (audioId.equals(sourceRef.path("artifactId").asString())) dubSourced = true;
                if (captionsId.equals(sourceRef.path("artifactId").asString())) captionSourced = true;
            }
            assertThat(dubSourced && captionSourced).as("render lineage names the exact dub and caption versions").isTrue();

            // ---- idempotent dub: the same request replays and runs no model ----
            int dubRowsAfter = live.rows("dubSchema");
            assertThat(dubRowsAfter).isEqualTo(dubRows + 3);
            JsonNode dubReplay = live.ownerPost("/dev/v1/dubs", Map.of("requestId", "dub-" + live.run, "translatedArtifactId", revisedId,
                    "translatedArtifactVersionId", revisedVersion, "overflowPolicy", "ALLOW_SPILL"), 200);
            assertThat(dubReplay.path("replayed").asBoolean()).isTrue();
            assertThat(dubReplay.path("dubId").asString()).isEqualTo(dubId);
            assertThat(live.rows("dubSchema")).isEqualTo(dubRowsAfter);

            // ---- the sidecar killed: UNKNOWN, nothing registered; the retry registers exactly once ----
            live.killSidecar();
            int beforeSidecar = live.rows("translationSchema");
            Map<String, Object> killedTranslation = translateBody("tr-sidecar-" + live.run, transcriptId, transcriptVersion, "en", "es");
            HttpResponse<String> unknownTranslation = live.owner("POST", "/dev/v1/translations", killedTranslation);
            assertThat(unknownTranslation.statusCode()).as(unknownTranslation.body()).isEqualTo(503);
            assertThat(unknownTranslation.body()).contains("TRANSLATION_OUTCOME_UNKNOWN").contains("\"retrySafe\":true")
                    .doesNotContain("\"segments\"");
            assertThat(live.rows("translationSchema")).as("UNKNOWN registered nothing").isEqualTo(beforeSidecar);
            live.startSidecar();
            JsonNode retriedTranslation = live.ownerPost("/dev/v1/translations", killedTranslation, 201);
            assertThat(live.rows("translationSchema")).as("exactly one registration on retry").isEqualTo(beforeSidecar + 1);
            assertThat(live.ownerPost("/dev/v1/translations", killedTranslation, 200).path("translationId").asString())
                    .isEqualTo(retriedTranslation.path("translationId").asString());
            assertThat(live.rows("translationSchema")).isEqualTo(beforeSidecar + 1);

            // ---- the Kokoro worker killed mid-dub: UNKNOWN, nothing registered; the retry registers exactly once ----
            int beforeWorker = live.rows("dubSchema");
            Map<String, Object> workerDub = dubBody("dub-worker-" + live.run, revisedId, revisedVersion, null, "ALLOW_SPILL");
            AtomicBoolean stop = new AtomicBoolean();
            AtomicBoolean killedAny = new AtomicBoolean();
            Thread killer = new Thread(() -> {
                while (!stop.get()) {
                    for (ProcessHandle worker : live.workers()) {
                        worker.destroyForcibly();
                        killedAny.set(true);
                    }
                    try { Thread.sleep(150); } catch (InterruptedException interrupted) { return; }
                }
            }, "j16-kokoro-killer");
            killer.setDaemon(true);
            HttpResponse<String> unknownDub;
            CompletableFuture<HttpResponse<String>> inFlight = CompletableFuture.supplyAsync(() -> {
                try { return live.owner("POST", "/dev/v1/dubs", workerDub); }
                catch (Exception failure) { throw new IllegalStateException(failure); }
            });
            Thread.sleep(700);
            killer.start();
            try {
                unknownDub = inFlight.get(150, TimeUnit.SECONDS);
            } finally {
                stop.set(true);
                killer.join(5_000);
            }
            assertThat(killedAny.get()).as("a real Kokoro worker process was killed mid-dub").isTrue();
            assertThat(unknownDub.statusCode()).as(unknownDub.body()).isEqualTo(503);
            assertThat(unknownDub.body()).contains("DUB_OUTCOME_UNKNOWN").contains("\"retrySafe\":true").doesNotContain("\"outputs\"");
            assertThat(live.rows("dubSchema")).as("UNKNOWN registered nothing").isEqualTo(beforeWorker);
            JsonNode retriedDub = live.ownerPost("/dev/v1/dubs", workerDub, 201);
            assertThat(live.rows("dubSchema")).as("exactly one dub (audio, captions, timing) on retry").isEqualTo(beforeWorker + 3);
            assertThat(live.ownerPost("/dev/v1/dubs", workerDub, 200).path("dubId").asString()).isEqualTo(retriedDub.path("dubId").asString());
            assertThat(live.rows("dubSchema")).isEqualTo(beforeWorker + 3);

            // ---- restart readback: everything reads back and the replays still run no model ----
            live.restart();
            JsonNode reread = live.ownerGet("/dev/v1/dubs/" + dubId, 200);
            assertThat(reread.path("timing")).isEqualTo(timing);
            assertThat(reread.path("outputs").path("audio").path("artifact").path("sha256").asString())
                    .isEqualTo(dub.path("outputs").path("audio").path("artifact").path("sha256").asString());
            assertThat(live.ownerGet("/dev/v1/translations/" + revisedId, 200).path("segments")).isEqualTo(revised.path("segments"));
            int afterRestart = live.rows("dubSchema");
            JsonNode replayAfterRestart = live.ownerPost("/dev/v1/dubs", Map.of("requestId", "dub-" + live.run, "translatedArtifactId", revisedId,
                    "translatedArtifactVersionId", revisedVersion, "overflowPolicy", "ALLOW_SPILL"), 200);
            assertThat(replayAfterRestart.path("replayed").asBoolean()).isTrue();
            assertThat(replayAfterRestart.path("dubId").asString()).isEqualTo(dubId);
            assertThat(live.rows("dubSchema")).isEqualTo(afterRestart);
            assertThat(live.send(live.otherToken(), "GET", "/dev/v1/dubs/" + dubId, null).statusCode()).isEqualTo(404);
            assertThat(live.send(live.otherToken(), "GET", "/dev/v1/translations/" + revisedId, null).statusCode()).isEqualTo(404);
            assertThat(live.get(live.ownerToken(), "/api/v1/artifacts/" + audioId, 200).path("artifactId").asString()).isEqualTo(audioId);

            // ---- rights revoked at the original source: translation and dub are refused, replays included ----
            live.ownerPost("/dev/v1/rights/attestations/" + attestationId + "/revoke", Map.of("reason", "TEST: revoked"), 200);
            int translationsBeforeRevoke = live.rows("translationSchema");
            int dubsBeforeRevoke = live.rows("dubSchema");
            for (int attempt = 0; attempt < 2; attempt++) {
                if (attempt == 1) live.restart();
                HttpResponse<String> revokedTranslation = live.owner("POST", "/dev/v1/translations", translateBody(
                        "tr-after-revoke-" + attempt + "-" + live.run, transcriptId, transcriptVersion, "en", "es"));
                assertThat(revokedTranslation.statusCode()).as(revokedTranslation.body()).isEqualTo(403);
                assertThat(revokedTranslation.body()).contains("RIGHTS_DECISION_REVOKED").contains(narrationId);
                HttpResponse<String> revokedReplay = live.owner("POST", "/dev/v1/dubs", Map.of("requestId", "dub-" + live.run,
                        "translatedArtifactId", revisedId, "translatedArtifactVersionId", revisedVersion,
                        "overflowPolicy", "ALLOW_SPILL"));
                assertThat(revokedReplay.statusCode()).as(revokedReplay.body()).isEqualTo(403);
                assertThat(revokedReplay.body()).contains("RIGHTS_DECISION_REVOKED").doesNotContain("\"outputs\"");
                HttpResponse<String> revokedNewDub = live.owner("POST", "/dev/v1/dubs", dubBody("dub-after-revoke-" + attempt + "-" + live.run,
                        revisedId, revisedVersion, null, "ALLOW_SPILL"));
                assertThat(revokedNewDub.statusCode()).as(revokedNewDub.body()).isEqualTo(403);
            }
            assertThat(live.rows("translationSchema")).isEqualTo(translationsBeforeRevoke);
            assertThat(live.rows("dubSchema")).isEqualTo(dubsBeforeRevoke);
            live.passed = true;
        }
    }

    // ---- helpers ----

    private static Map<String, Object> translateBody(String requestId, String transcriptId, String version, String source,
                                                     String target) {
        return Map.of("requestId", requestId, "transcriptArtifactId", transcriptId, "transcriptArtifactVersionId", version,
                "sourceLanguage", source, "targetLanguage", target);
    }

    private static Map<String, Object> dubBody(String requestId, String artifactId, String version, String voice, String policy) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("translatedArtifactId", artifactId);
        body.put("translatedArtifactVersionId", version);
        if (voice != null) body.put("voice", voice);
        if (policy != null) body.put("overflowPolicy", policy);
        return body;
    }

    private static Map<String, Object> time(long ticks, String clock) {
        return Map.of("ticks", Long.toString(ticks), "rateNumerator", "24", "rateDenominator", "1", "clock", clock);
    }

    private static Map<String, Object> clip(String clipId, String trackId, String artifactId, String version, long sourceTicks,
                                            long storyTicks) {
        return Map.of("type", "putClip", "clip", Map.of("clipId", clipId, "sceneId", "scene-main", "trackId", trackId,
                "source", Map.of("artifactId", artifactId, "artifactVersionId", version),
                "sourceIn", time(0, "SOURCE_PRESENTATION"), "sourceOut", time(sourceTicks, "SOURCE_PRESENTATION"),
                "storyStart", time(0, "STORY"), "storyDuration", time(storyTicks, "STORY")));
    }

    static String normalize(String text) {
        String folded = Normalizer.normalize(text.toLowerCase(Locale.ROOT), Normalizer.Form.NFC);
        return " " + folded.replaceAll("[^\\p{L}\\p{N} ]", " ").replaceAll("\\s+", " ").trim() + " ";
    }

    private static int distance(String[] a, String[] b) {
        int[] previous = new int[b.length + 1];
        for (int j = 0; j <= b.length; j++) previous[j] = j;
        for (int i = 1; i <= a.length; i++) {
            int[] current = new int[b.length + 1];
            current[0] = i;
            for (int j = 1; j <= b.length; j++) {
                current[j] = Math.min(Math.min(previous[j] + 1, current[j - 1] + 1),
                        previous[j - 1] + (a[i - 1].equals(b[j - 1]) ? 0 : 1));
            }
            previous = current;
        }
        return previous[b.length];
    }

    static double wer(String reference, String hypothesis) {
        String[] ref = normalize(reference).trim().split(" ");
        String[] hyp = normalize(hypothesis).trim().split(" ");
        return distance(ref, hyp) / (double) ref.length;
    }

    static double cer(String reference, String hypothesis) {
        String[] ref = normalize(reference).trim().split("");
        String[] hyp = normalize(hypothesis).trim().split("");
        return distance(ref, hyp) / (double) ref.length;
    }

    /** Mono 24 kHz PCM16 samples of a RIFF WAV (chunk-walking, no assumption about the header length). */
    static short[] pcm24k(byte[] wav) {
        ByteBuffer buffer = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        for (int at = 12; at + 8 <= wav.length; ) {
            String id = new String(wav, at, 4, StandardCharsets.US_ASCII);
            int size = buffer.getInt(at + 4);
            if (id.equals("data")) {
                short[] samples = new short[Math.min(size, wav.length - at - 8) / 2];
                for (int i = 0; i < samples.length; i++) samples[i] = buffer.getShort(at + 8 + i * 2);
                return samples;
            }
            at += 8 + size + (size & 1);
        }
        throw new AssertionError("WAV has no data chunk");
    }

    /** Milliseconds of the first sample at or after {@code fromMillis} whose magnitude is at least {@code threshold}. */
    static long firstAbove(short[] pcm, long fromMillis, int threshold) {
        for (int i = (int) (fromMillis * 24); i < pcm.length; i++) {
            if (Math.abs((int) pcm[i]) >= threshold) return i / 24;
        }
        return pcm.length / 24;
    }

    /** Milliseconds of the last sample whose magnitude is at least {@code threshold} after {@code fromMillis}, else 0. */
    static long lastAbove(short[] pcm, long fromMillis, int threshold) {
        for (int i = pcm.length - 1; i >= (int) (fromMillis * 24); i--) {
            if (Math.abs((int) pcm[i]) >= threshold) return i / 24;
        }
        return 0;
    }

    private record Source(byte[] wav, byte[] mp4, Path mp4File) { }

    /** One real launcher process, one real loopback vision sidecar and the harness around them. */
    private static final class Live implements AutoCloseable {
        final String run = UUID.randomUUID().toString().replace("-", "").substring(0, 16);
        final String tenant = "tenant-dev-j16-" + run;
        final String owner = "test-principal-owner-" + run;
        final String other = "test-principal-other-" + run;
        final String bucket = "media-dev-j16-" + run;
        final String schema = "media_dev_j16_" + run;
        final int port;
        final int sidecarPort;
        final String sidecarToken;
        final Path work;
        final Path services;
        final Path log;
        final Path python;
        final Path sidecarScript;
        final Path models;
        final String classpath;
        final Map<String, String> environment;
        Process launcher;
        Process sidecar;
        boolean passed;
        private final Map<String, long[]> tokenExpiry = new HashMap<>();
        private final Map<String, String> tokenCache = new HashMap<>();

        private Live() throws Exception {
            Path data = modelRoot();
            models = Path.of(System.getenv().getOrDefault("MEDIA_LOCAL_VISION_MODELS_ROOT", data.resolve("models").toString()));
            python = Path.of(System.getenv().getOrDefault("MEDIA_LOCAL_VISION_PYTHON",
                    data.resolve("runtimes/vision-venv/bin/python").toString()));
            sidecarScript = locate("tools/model-runtimes/vision/vision_sidecar.py");
            assertThat(sidecarScript).as("vision_sidecar.py").isNotNull();
            assertThat(python).as("vision venv python").isExecutable();
            assertThat(ffmpeg()).as("MEDIA_DEV_RENDER_FFMPEG").isNotBlank();
            assertThat(ffprobe()).as("MEDIA_DEV_RENDER_FFPROBE").isNotBlank();
            try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
            try (var socket = new java.net.ServerSocket(0)) { sidecarPort = socket.getLocalPort(); }
            byte[] tokenBytes = new byte[24];
            new SecureRandom().nextBytes(tokenBytes);
            sidecarToken = HexFormat.of().formatHex(tokenBytes);
            work = Files.createTempDirectory("media-dev-j16-work-");
            services = Files.createTempDirectory("media-dev-j16-services-");
            log = Files.createTempFile("media-dev-j16-process-", ".log");
            try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            classpath = services + java.io.File.pathSeparator + childClasspath;
            environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.putAll(kokoroEnvironment(data));
            environment.put("MEDIA_KOKORO_WORKER", "true");
            environment.put("MEDIA_WHISPER_CPP_BIN", data.resolve("runtimes/whisper.cpp-src/build-vulkan/bin/whisper-cli").toString());
            environment.put("MEDIA_WHISPER_CPP_THREADS", "8");
            environment.put("MEDIA_LOCAL_VISION_MODELS_ROOT", models.toString());
            environment.put("MEDIA_LOCAL_VISION_SIDECAR_URL", "http://127.0.0.1:" + sidecarPort);
            environment.put("MEDIA_LOCAL_VISION_SIDECAR_TOKEN", sidecarToken);
            environment.put("MEDIA_LOCAL_VISION_TIMEOUT_SECONDS", "480");
            environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg());
            environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe());
            environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
        }

        static Live start() throws Exception {
            Live live = new Live();
            live.startSidecar();
            live.launcher = startLauncher(live.classpath, live.environment, live.log);
            awaitReady(live.launcher, live.port);
            return live;
        }

        static Path locate(String relative) {
            for (Path dir = Path.of("").toAbsolutePath(); dir != null; dir = dir.getParent()) {
                Path candidate = dir.resolve(relative);
                if (Files.isRegularFile(candidate)) return candidate;
            }
            return null;
        }

        void startSidecar() throws Exception {
            ProcessBuilder builder = new ProcessBuilder(python.toString(), "-I", sidecarScript.toString(), "--port",
                    Integer.toString(sidecarPort), "--models-root", models.toString());
            builder.redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.appendTo(work.resolve("sidecar.log").toFile()));
            builder.environment().clear();
            builder.environment().putAll(Map.of("GHATANA_VISION_SIDECAR_TOKEN", sidecarToken,
                    "HOME", System.getProperty("user.home"), "PATH", "/usr/bin:/bin"));
            sidecar = builder.start();
            long deadline = System.nanoTime() + Duration.ofSeconds(180).toNanos();
            while (System.nanoTime() < deadline) {
                if (!sidecar.isAlive()) throw new AssertionError("vision sidecar exited: " + sidecar.exitValue());
                try {
                    HttpResponse<String> response = HttpClient.newHttpClient().send(HttpRequest.newBuilder(
                            URI.create("http://127.0.0.1:" + sidecarPort + "/v1/health"))
                            .header("Authorization", "Bearer " + sidecarToken).GET().build(), HttpResponse.BodyHandlers.ofString());
                    if (response.statusCode() == 200) return;
                } catch (java.io.IOException ignored) { }
                Thread.sleep(250);
            }
            throw new AssertionError("vision sidecar did not become healthy");
        }

        void killSidecar() throws Exception {
            sidecar.destroyForcibly();
            assertThat(sidecar.waitFor(15, TimeUnit.SECONDS)).isTrue();
        }

        List<ProcessHandle> workers() {
            List<ProcessHandle> workers = new ArrayList<>();
            launcher.toHandle().descendants().forEach(handle -> {
                if (handle.info().commandLine().orElse("").contains("kokoro_worker.py")) workers.add(handle);
            });
            return workers;
        }

        void restart() throws Exception {
            stopLauncher(launcher);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
        }

        /** DEV_ONLY tokens live 300 s; the journey is longer, so each role refreshes its token on demand. */
        private String cached(String role, String principal) throws Exception {
            long now = System.nanoTime();
            long[] expiry = tokenExpiry.get(role);
            if (expiry == null || now > expiry[0]) {
                tokenCache.put(role, issueDevToken(tenant, principal));
                tokenExpiry.put(role, new long[] {now + TimeUnit.SECONDS.toNanos(200)});
            }
            return tokenCache.get(role);
        }

        String ownerToken() throws Exception { return cached("owner", owner); }
        String otherToken() throws Exception { return cached("other", other); }

        HttpResponse<String> send(String token, String method, String path, Object body) throws Exception {
            return MediaDevLiveFixtures.send(port, tenant, token, method, path, body == null ? null : JSON.writeValueAsString(body));
        }
        HttpResponse<String> owner(String method, String path, Object body) throws Exception { return send(ownerToken(), method, path, body); }
        JsonNode get(String token, String path, int status) throws Exception { return MediaDevLiveFixtures.get(port, tenant, token, path, status); }
        JsonNode ownerGet(String path, int status) throws Exception { return get(ownerToken(), path, status); }
        JsonNode ownerPost(String path, Object body, int status) throws Exception {
            return MediaDevLiveFixtures.post(port, tenant, ownerToken(), path, body, status);
        }

        String upload(String fileName, String contentType, byte[] bytes) throws Exception {
            return MediaDevLiveFixtures.upload(port, tenant, owner, ownerToken(), run + "-" + fileName, fileName, contentType, bytes);
        }

        String attest(String artifactId, String version) throws Exception {
            return ownerPost("/dev/v1/rights/attestations", Map.of("artifactId", artifactId, "artifactVersionId", version,
                    "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"), "basis", PROVENANCE), 201)
                    .path("attestationId").asString();
        }

        /** Durable artifact rows of the owner whose metadata carries one of the schema keys. */
        int rows(String... keys) throws Exception {
            StringBuilder where = new StringBuilder();
            for (int i = 0; i < keys.length; i++) where.append(i == 0 ? "" : " OR ").append("metadata_json LIKE ?");
            try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                 var statement = connection.prepareStatement("SELECT count(*) FROM media_artifacts WHERE tenant_id=? AND principal_id=? AND ("
                         + where + ")")) {
                statement.setString(1, tenant);
                statement.setString(2, owner);
                for (int i = 0; i < keys.length; i++) statement.setString(3 + i, "%" + keys[i] + "%");
                try (var row = statement.executeQuery()) {
                    row.next();
                    return row.getInt(1);
                }
            }
        }

        /**
         * Builds the real input: three English sentences synthesized by the real Kokoro worker through the product route
         * (voice af_heart), joined with silent gaps, muxed over a generated on-screen frame by FFmpeg, and the narration
         * extracted again from the MP4 as a 16 kHz mono WAV (the form the speech lane accepts).
         */
        Source buildSource() throws Exception {
            ByteArrayOutputStream pcm = new ByteArrayOutputStream();
            writeSilence(pcm, 600);
            for (int i = 0; i < NARRATION.size(); i++) {
                JsonNode synthesized = ownerPost("/dev/v1/speech/syntheses", Map.of("requestId", "narration-" + i + "-" + run,
                        "text", NARRATION.get(i), "voice", "af_heart", "locale", "en"), 201);
                String id = synthesized.path("artifact").path("artifactId").asString();
                byte[] wav = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, owner, id));
                short[] samples = pcm24k(wav);
                ByteBuffer buffer = ByteBuffer.allocate(samples.length * 2).order(ByteOrder.LITTLE_ENDIAN);
                for (short sample : samples) buffer.putShort(sample);
                pcm.write(buffer.array());
                writeSilence(pcm, 1_800);
            }
            byte[] data = pcm.toByteArray();
            ByteBuffer header = ByteBuffer.allocate(44 + data.length).order(ByteOrder.LITTLE_ENDIAN);
            header.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + data.length)
                    .put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1)
                    .putInt(24_000).putInt(48_000).putShort((short) 2).putShort((short) 16)
                    .put("data".getBytes(StandardCharsets.US_ASCII)).putInt(data.length).put(data);
            Files.write(work.resolve("narration24.wav"), header.array());
            writeSceneFrame(work.resolve("frame.png"));
            runFfmpeg(List.of("-loop", "1", "-framerate", "5", "-i", work.resolve("frame.png").toString(), "-i",
                    work.resolve("narration24.wav").toString(), "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "96k", "-shortest", "-movflags", "+faststart", work.resolve("source.mp4").toString()));
            runFfmpeg(List.of("-i", work.resolve("source.mp4").toString(), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
                    work.resolve("narration16.wav").toString()));
            byte[] wav = Files.readAllBytes(work.resolve("narration16.wav"));
            byte[] mp4 = Files.readAllBytes(work.resolve("source.mp4"));
            assertThat(wav.length).as("narration fits one upload chunk").isLessThan(4 * 1024 * 1024);
            assertThat(mp4.length).isLessThan(2_000_000);
            return new Source(wav, mp4, work.resolve("source.mp4"));
        }

        private static void writeSilence(ByteArrayOutputStream out, int millis) {
            out.write(new byte[millis * 24 * 2], 0, millis * 24 * 2);
        }

        /** A frame of the source MP4 (the on-screen content), extracted by FFmpeg. */
        byte[] extractFrame(Source source) throws Exception {
            Path png = work.resolve("source-frame.png");
            runFfmpeg(List.of("-ss", "0.5", "-i", source.mp4File.toString(), "-frames:v", "1", png.toString()));
            return Files.readAllBytes(png);
        }

        /** The mov_text subtitle stream of the rendered MP4 as SRT text. */
        String subtitleText(byte[] mp4) throws Exception {
            Path file = work.resolve("rendered.mp4");
            Path srt = work.resolve("rendered.srt");
            Files.write(file, mp4);
            runFfmpeg(List.of("-i", file.toString(), "-map", "0:s:0", "-f", "srt", srt.toString()));
            return Files.readString(srt);
        }

        private void runFfmpeg(List<String> arguments) throws Exception {
            List<String> command = new ArrayList<>(List.of(ffmpeg(), "-nostdin", "-v", "error", "-y"));
            command.addAll(arguments);
            Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
            String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            assertThat(process.waitFor(3, TimeUnit.MINUTES)).isTrue();
            assertThat(process.exitValue()).as("ffmpeg " + arguments + ": " + output).isZero();
        }

        /** On-screen content: a title, a bar of text and two shapes, rendered with Java2D. */
        private static void writeSceneFrame(Path out) throws Exception {
            var image = new java.awt.image.BufferedImage(640, 360, java.awt.image.BufferedImage.TYPE_INT_RGB);
            var g = image.createGraphics();
            try {
                g.setColor(java.awt.Color.WHITE);
                g.fillRect(0, 0, 640, 360);
                g.setColor(new java.awt.Color(220, 30, 30));
                g.fillRect(50, 150, 200, 170);
                g.setColor(new java.awt.Color(30, 60, 220));
                g.fillOval(360, 150, 200, 170);
                g.setColor(java.awt.Color.BLACK);
                g.setFont(new java.awt.Font(java.awt.Font.SANS_SERIF, java.awt.Font.BOLD, 54));
                g.drawString("QUARTERLY REPORT", 50, 90);
            } finally {
                g.dispose();
            }
            javax.imageio.ImageIO.write(image, "png", out.toFile());
        }

        @Override public void close() throws Exception {
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            if (sidecar != null) {
                sidecar.destroyForcibly();
                sidecar.waitFor(15, TimeUnit.SECONDS);
            }
            if (!passed) {
                try {
                    List<String> lines = Files.readAllLines(log);
                    System.out.println("J16 launcher log tail:\n" + String.join("\n",
                            lines.subList(Math.max(0, lines.size() - 40), lines.size())));
                } catch (java.io.IOException ignored) { }
            }
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            deleteTree(services);
            deleteTree(work);
            Files.deleteIfExists(log);
        }
    }
}
