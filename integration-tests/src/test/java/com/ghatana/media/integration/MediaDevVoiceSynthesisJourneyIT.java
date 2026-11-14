package com.ghatana.media.integration;

import com.ghatana.tts.local.LocalKokoroTtsProvider;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import tools.jackson.databind.JsonNode;

import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-04 (authorized voice synthesis) against a real launcher process (PostgreSQL + S3) with the REAL Kokoro-82M model,
 * real FFmpeg/FFprobe decoding and the real DEV_ONLY rights authority. Nothing is stubbed: the journey decodes the
 * registered audio, places it on a project timeline, renders an MP4 whose audio stream is probed, and reviews it; the
 * fault suite refuses a locale and a voice outside the manifest, a voice or likeness reference (confirmed
 * VOICE_OR_LIKENESS_USE statement required, then still unsupported), a statement revoked mid-journey, altered weights,
 * and a killed worker or launcher (UNKNOWN, never success; the retry is idempotent by requestId and the artifact reads
 * back after a restart). Statements and principals are clearly synthetic TEST identities; no real person's rights,
 * consent or approval is claimed.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevVoiceSynthesisJourneyIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private record Host(int port, Path services, Path log, String classpath, Map<String, String> environment,
                        String tenant, String owner, String confirmer, String bucket, String schema) { }

    private Host host(String tag, Map<String, String> speech) throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-voice-services-");
        Path log = Files.createTempFile("media-dev-voice-process-", ".log");
        String bucket = "media-dev-voice-" + tag + "-" + run.substring(0, 12);
        String schema = "media_dev_voice_" + tag + "_" + run.substring(0, 12);
        try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
        installDescriptors(services);
        String childClasspath = System.getProperty("media.child.classpath", "");
        assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
        Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
        environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
        environment.put("MEDIA_DEV_REVIEW_ENABLED", "true");
        environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg());
        environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe());
        environment.putAll(speech);
        return new Host(port, services, log, services + java.io.File.pathSeparator + childClasspath, environment,
                "tenant-dev-voice-" + run, "test-principal-owner-" + run, "test-principal-confirmer-" + run, bucket, schema);
    }

    private static void cleanup(Host host, Process launcher) throws Exception {
        if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
        deleteBucket(LOCALSTACK, host.bucket());
        dropSchema(POSTGRES, host.schema());
        deleteTree(host.services());
        Files.deleteIfExists(host.log());
    }

    private static String devToken(Host host, String principal) throws Exception {
        return issueDevToken(host.tenant(), principal);
    }

    private static void requireRealToolchain(Map<String, String> speech) {
        assumeTrue(LocalKokoroTtsProvider.fromEnvironment(speech).ready(),
                "the verified local Kokoro-82M install (tools/model-runtimes/install-local-manifests.sh) is required");
        assumeTrue(ffmpeg() != null && ffprobe() != null,
                "MEDIA_DEV_RENDER_FFMPEG / MEDIA_DEV_RENDER_FFPROBE are required to decode and render");
    }

    private static HttpResponse<String> synth(int port, Host host, String token, Map<String, Object> body) throws Exception {
        return send(port, host.tenant(), token, "POST", "/dev/v1/speech/syntheses", JSON.writeValueAsString(body));
    }

    private static String errorCode(HttpResponse<String> response) throws Exception {
        return JSON.readTree(response.body()).path("error").path("code").asString();
    }

    @Test
    void lawfulVoiceBecomesDecodedAudioOnATimelineRenderedToMp4WithAudioAndReviewed() throws Exception {
        Map<String, String> speech = kokoroEnvironment(modelRoot());
        requireRealToolchain(speech);
        Host host = host("journey", speech);
        Process launcher = null;
        try {
            launcher = startLauncher(host.classpath(), host.environment(), host.log());
            awaitReady(launcher, host.port());
            int port = host.port();
            String owner = host.owner();
            String token = devToken(host, owner);
            String tenant = host.tenant();

            // 1. Capabilities come from the verified manifest: two stock voices, one verified language, no cloning.
            JsonNode tts = get(port, tenant, token, "/dev/v1/speech/capabilities", 200).path("textToSpeech");
            assertThat(tts.path("ready").asBoolean()).isTrue();
            assertThat(tts.path("voices")).extracting(JsonNode::asString).containsExactly("af_heart", "am_michael");
            assertThat(tts.path("verifiedLanguages")).extracting(JsonNode::asString).containsExactly("en");
            assertThat(tts.path("voiceCloning").asString()).isEqualTo("NOT_SUPPORTED");
            assertThat(tts.path("licenseSpdx").asString()).isEqualTo("Apache-2.0");
            assertThat(tts.path("attribution").path("noticeRequired").asBoolean()).isTrue();
            assertThat(tts.path("attribution").path("notice").asString()).contains("Apache");

            // 2. A user picks an admitted voice and locale, enters text and synthesizes (real Kokoro-82M).
            String requestId = "j04-journey-" + UUID.randomUUID().toString().substring(0, 8);
            JsonNode synthesized = post(port, tenant, token, "/dev/v1/speech/syntheses", Map.of(
                    "requestId", requestId, "text", SENTENCE, "voice", "am_michael", "locale", "en"), 201);
            String audioId = synthesized.path("artifact").path("artifactId").asString();
            String audioVersion = synthesized.path("artifact").path("artifactVersionId").asString();
            String audioSha = synthesized.path("artifact").path("sha256").asString();
            long reportedMillis = synthesized.path("lineage").path("audio").path("durationMillis").asLong();
            assertThat(synthesized.path("lineage").path("locale").asString()).isEqualTo("en");
            assertThat(synthesized.path("lineage").path("voice").asString()).isEqualTo("am_michael");
            assertThat(synthesized.path("lineage").path("audio").path("voiceCloning").asString()).isEqualTo("NOT_SUPPORTED");
            assertThat(synthesized.path("lineage").toString()).doesNotContain(SENTENCE);

            // 3. The registered bytes are independently decoded: codec, duration, sample rate, non-silence.
            StoredArtifact stored = storedArtifact(POSTGRES, tenant, owner, audioId);
            byte[] wav = s3Bytes(LOCALSTACK, host.bucket(), stored);
            assertThat(sha256(wav)).isEqualTo(audioSha);
            JsonNode wavProbe = probe(wav, "wav");
            JsonNode wavAudio = stream(wavProbe, "audio");
            double probedSeconds = Double.parseDouble(wavProbe.path("format").path("duration").asString());
            System.out.println("J04_AUDIO_FFPROBE codec=" + wavAudio.path("codec_name").asString()
                    + " sample_rate=" + wavAudio.path("sample_rate").asString() + " channels=" + wavAudio.path("channels").asInt()
                    + " duration=" + probedSeconds + "s sha256=" + audioSha);
            assertThat(wavAudio.path("codec_name").asString()).isEqualTo("pcm_s16le");
            assertThat(wavAudio.path("sample_rate").asString()).isEqualTo("24000");
            assertThat(wavAudio.path("channels").asInt()).isEqualTo(1);
            assertThat(probedSeconds).isGreaterThan(1.0);
            assertThat(probedSeconds * 1000).isBetween(reportedMillis - 20.0, reportedMillis + 20.0);
            Decoded decoded = decode(wav, "wav");
            System.out.println("J04_AUDIO_DECODE samples=" + decoded.samples() + " rms=" + decoded.rms() + " peak=" + decoded.peak());
            assertThat(decoded.samples()).isBetween((int) (probedSeconds * 24000) - 50, (int) (probedSeconds * 24000) + 50);
            assertThat(decoded.rms()).as("real speech is not silence").isGreaterThan(200.0);
            assertThat(decoded.peak()).isLessThan(32767);

            // 4. The same requestId replays the existing artifact (idempotent) instead of creating another.
            int wavCount = countArtifacts(POSTGRES, tenant, owner, "audio/wav");
            JsonNode replay = post(port, tenant, token, "/dev/v1/speech/syntheses", Map.of(
                    "requestId", requestId, "text", SENTENCE, "voice", "am_michael", "locale", "en"), 200);
            assertThat(replay.path("replayed").asBoolean()).isTrue();
            assertThat(replay.path("artifact").path("artifactVersionId").asString()).isEqualTo(audioVersion);
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).isEqualTo(wavCount);
            // A different request under the same identifier is refused, never merged.
            HttpResponse<String> reused = synth(port, host, token, Map.of("requestId", requestId, "text", "A different sentence.",
                    "voice", "am_michael", "locale", "en"));
            assertThat(reused.statusCode()).as(reused.body()).isEqualTo(409);
            assertThat(errorCode(reused)).isEqualTo("SPEECH_REQUEST_ID_REUSED");

            // 5. Place the exact version on a project timeline AUDIO track (plus a still, which MP4 needs), then render.
            byte[] png = solidPng(0xff2060c0);
            String pngId = upload(port, tenant, owner, token, "j04-still", "still.png", "image/png", png);
            String workspaceId = get(port, tenant, token, "/dev/v1/context", 200).path("selectedAuthorizedWorkspaceId").asString();
            JsonNode created = post(port, tenant, token, "/dev/v1/projects", Map.of(
                    "selectedAuthorizedWorkspaceId", workspaceId, "title", "J-04 voice journey", "requestId", "j04-project-" + requestId), 201);
            String projectId = created.path("project").path("projectId").asString();
            String head = post(port, tenant, token, "/dev/v1/projects/" + projectId + "/timelines", Map.of(
                    "expectedHeadRevisionId", created.path("initialRevision").path("revisionId").asString(),
                    "timelineId", "timeline-main"), 201).path("revision").path("revisionId").asString();
            long ticks = ticksFor(reportedMillis);
            String revisionId = post(port, tenant, token, "/dev/v1/projects/" + projectId + "/timelines/timeline-main/edits", Map.of(
                    "expectedHeadRevisionId", head, "edits", List.of(
                            Map.of("type", "addScene", "sceneId", "scene-main", "order", 0),
                            Map.of("type", "addTrack", "trackId", "video-main", "sceneId", "scene-main", "trackKind", "VIDEO", "order", 0),
                            Map.of("type", "putClip", "clip", Map.of("clipId", "clip-still", "sceneId", "scene-main", "trackId", "video-main",
                                    "source", Map.of("artifactId", pngId, "artifactVersionId", "sha256:" + sha256(png)),
                                    "sourceIn", time(0, "SOURCE_PRESENTATION"), "sourceOut", time(1, "SOURCE_PRESENTATION"),
                                    "storyStart", time(0, "STORY"), "storyDuration", time(ticks, "STORY"))),
                            Map.of("type", "addTrack", "trackId", "audio-voice", "sceneId", "scene-main", "trackKind", "AUDIO", "order", 1),
                            Map.of("type", "putClip", "clip", Map.of("clipId", "clip-voice", "sceneId", "scene-main", "trackId", "audio-voice",
                                    "source", Map.of("artifactId", audioId, "artifactVersionId", audioVersion),
                                    "sourceIn", time(0, "SOURCE_PRESENTATION"), "sourceOut", time(ticks, "SOURCE_PRESENTATION"),
                                    "storyStart", time(0, "STORY"), "storyDuration", time(ticks, "STORY"))))), 201)
                    .path("revision").path("revisionId").asString();
            JsonNode render = post(port, tenant, token, "/dev/v1/projects/" + projectId + "/renders", Map.of(
                    "requestId", "j04-render-" + requestId, "revisionId", revisionId, "timelineId", "timeline-main",
                    "width", 32, "height", 24, "framesPerSecond", 10, "format", "mp4"), 201);
            String renderId = render.path("renderId").asString();
            String renderSha = render.path("artifact").path("sha256").asString();
            assertThat(render.path("artifact").path("contentType").asString()).isEqualTo("video/mp4");
            boolean voiceSourced = false;
            for (JsonNode source : render.path("lineage").path("sources")) {
                if (audioId.equals(source.path("artifactId").asString())) {
                    assertThat(source.path("artifactVersionId").asString()).isEqualTo(audioVersion);
                    voiceSourced = true;
                }
            }
            assertThat(voiceSourced).as("render lineage names the exact synthesized version").isTrue();

            // 6. The MP4's AUDIO stream is present, decodable and as long as the clip.
            StoredArtifact renderStored = storedArtifact(POSTGRES, tenant, owner, renderId);
            byte[] mp4 = s3Bytes(LOCALSTACK, host.bucket(), renderStored);
            assertThat(sha256(mp4)).isEqualTo(renderSha);
            JsonNode mp4Probe = probe(mp4, "mp4");
            JsonNode mp4Audio = stream(mp4Probe, "audio");
            JsonNode mp4Video = stream(mp4Probe, "video");
            assertThat(mp4Audio).as("the rendered MP4 has an audio stream").isNotNull();
            assertThat(mp4Video).as("the rendered MP4 has a video stream").isNotNull();
            double audioStreamSeconds = Double.parseDouble(mp4Audio.path("duration").asString("0"));
            System.out.println("J04_MP4_FFPROBE audio_codec=" + mp4Audio.path("codec_name").asString()
                    + " audio_sample_rate=" + mp4Audio.path("sample_rate").asString() + " audio_duration=" + audioStreamSeconds
                    + "s video_codec=" + mp4Video.path("codec_name").asString() + " container=" + mp4Probe.path("format").path("format_name").asString());
            assertThat(mp4Audio.path("codec_name").asString()).isEqualTo("aac");
            assertThat(audioStreamSeconds).isGreaterThan(1.0)
                    .isBetween(ticks / 24.0 - 0.25, ticks / 24.0 + 0.25);
            Decoded mp4Decoded = decode(mp4, "mp4");
            System.out.println("J04_MP4_DECODE samples=" + mp4Decoded.samples() + " rms=" + mp4Decoded.rms());
            assertThat(mp4Decoded.rms()).as("the voice is audible in the MP4").isGreaterThan(100.0);

            // 7. Review: an assigned DEV_ONLY reviewer comments on and decides the render; this is not an approval claim.
            String renderVersion = render.path("artifact").path("artifactVersionId").asString();
            String reviewCase = post(port, tenant, token, "/dev/v1/reviews", Map.of("subject", Map.of(
                    "kind", "ARTIFACT_VERSION", "artifactId", renderId, "artifactVersionId", renderVersion)), 201)
                    .path("reviewCaseId").asString();
            post(port, tenant, token, "/dev/v1/reviews/" + reviewCase + "/comments", Map.of(
                    "requestId", "j04-comment-" + requestId, "expectedCaseRevision", 0,
                    "text", "TEST: synthesized voice present on the audio track", "disposition", "OPEN"), 201);
            String reviewerToken = devToken(host, host.confirmer());
            post(port, tenant, token, "/dev/v1/reviews/" + reviewCase + "/assignments", Map.of(
                    "requestId", "j04-assign-" + requestId, "expectedCaseRevision", 1, "reviewerPrincipalId", host.confirmer(),
                    "scopes", List.of("QUALITY"), "expiresAt", java.time.Instant.now().plus(java.time.Duration.ofMinutes(20)).toString()), 201);
            JsonNode decision = post(port, tenant, reviewerToken, "/dev/v1/reviews/" + reviewCase + "/decisions", Map.of(
                    "requestId", "j04-decision-" + requestId, "expectedCaseRevision", 1, "decision", "ACCEPT",
                    "reason", "DEV_ONLY J-04 journey", "scope", "QUALITY", "confirmed", true), 201);
            assertThat(decision.path("establishesApproval").asBoolean()).isFalse();

            // 8. Restart: the audio artifact, the render and the review read back unchanged.
            stopLauncher(launcher);
            launcher = startLauncher(host.classpath(), host.environment(), host.log());
            awaitReady(launcher, port);
            token = devToken(host, owner);
            JsonNode reopened = get(port, tenant, token, "/dev/v1/speech/outputs/" + audioId, 200);
            assertThat(reopened.path("artifact").path("sha256").asString()).isEqualTo(audioSha);
            assertThat(reopened.path("lineage").path("kind").asString()).isEqualTo("LOCAL_TTS_AUDIO");
            assertThat(reopened.path("lineage").path("inputTextSha256").asString()).isEqualTo(sha256(SENTENCE.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
            assertThat(sha256(s3Bytes(LOCALSTACK, host.bucket(), storedArtifact(POSTGRES, tenant, owner, audioId)))).isEqualTo(audioSha);
            assertThat(get(port, tenant, token, "/dev/v1/projects/" + projectId + "/renders/" + renderId, 200)
                    .path("artifact").path("sha256").asString()).isEqualTo(renderSha);
            assertThat(get(port, tenant, token, "/dev/v1/reviews/" + reviewCase, 200).path("records")).hasSize(2);
            // Another principal cannot reopen the owner's output.
            assertThat(send(port, tenant, devToken(host, host.confirmer()), "GET", "/dev/v1/speech/outputs/" + audioId, null)
                    .statusCode()).isEqualTo(404);
        } finally {
            cleanup(host, launcher);
        }
    }

    @Test
    void deniedLocaleVoiceReferenceAndLikenessAndMidJourneyRevocationAreRefusedWithNoEffect() throws Exception {
        Map<String, String> speech = kokoroEnvironment(modelRoot());
        requireRealToolchain(speech);
        Host host = host("denials", speech);
        Process launcher = null;
        try {
            launcher = startLauncher(host.classpath(), host.environment(), host.log());
            awaitReady(launcher, host.port());
            int port = host.port();
            String tenant = host.tenant();
            String owner = host.owner();
            String token = devToken(host, owner);
            String confirmerToken = devToken(host, host.confirmer());
            String run = UUID.randomUUID().toString().substring(0, 8);

            // Source artifacts for the reference inputs: clearly synthetic stand-ins (a tone and a plain image).
            byte[] referenceWav = toneWav(24_000, 1);
            String referenceId = upload(port, tenant, owner, token, "j04-ref-voice", "TEST-reference-voice.wav", "audio/wav", referenceWav);
            String referenceVersion = "sha256:" + sha256(referenceWav);
            byte[] likenessPng = solidPng(0xff884422);
            String likenessId = upload(port, tenant, owner, token, "j04-ref-likeness", "TEST-likeness.png", "image/png", likenessPng);
            String likenessVersion = "sha256:" + sha256(likenessPng);
            int wavBefore = countArtifacts(POSTGRES, tenant, owner, "audio/wav");

            // A. Locale outside the manifest's verified languages: typed denial, no effect.
            for (String locale : List.of("ne", "ne-NP", "hi-IN", "fr")) {
                HttpResponse<String> denied = synth(port, host, token, Map.of("requestId", "j04-locale-" + locale + run,
                        "text", SENTENCE, "voice", "af_heart", "locale", locale));
                assertThat(denied.statusCode()).as(denied.body()).isEqualTo(422);
                assertThat(errorCode(denied)).isEqualTo("LOCALE_NOT_ADMITTED");
                assertThat(JSON.readTree(denied.body()).path("error").path("details").path("verifiedLanguages").get(0).asString()).isEqualTo("en");
            }

            // B. Voice not in the manifest: denied, no effect (including path-like and unknown names).
            for (String voice : List.of("bf_emma", "af_heart/../am_michael", "default")) {
                HttpResponse<String> denied = synth(port, host, token, Map.of("requestId", "j04-voice-" + Math.abs(voice.hashCode()) + run,
                        "text", SENTENCE, "voice", voice, "locale", "en"));
                assertThat(denied.statusCode()).as(denied.body()).isEqualTo(422);
                assertThat(errorCode(denied)).isEqualTo("VOICE_NOT_ADMITTED");
            }

            // C. Unknown input fields (a voice sample or an embedding) are rejected outright.
            for (String field : List.of("referenceAudio", "voiceSample", "embedding", "speakerEmbedding")) {
                HttpResponse<String> unknown = synth(port, host, token, Map.of("requestId", "j04-field-" + field + run,
                        "text", SENTENCE, "voice", "af_heart", field, "AAAA"));
                assertThat(unknown.statusCode()).as(unknown.body()).isEqualTo(400);
            }

            // D. Voice reference: no statement -> denied; wrong scope -> denied; unconfirmed -> denied; confirmed ->
            // STILL refused as unsupported (never a clone); revoked mid-journey -> refused again, even on a retry.
            Map<String, Object> voiceRequest = Map.of("requestId", "j04-voiceref-" + run, "text", SENTENCE, "voice", "af_heart",
                    "locale", "en", "voiceReference", Map.of("artifactId", referenceId, "artifactVersionId", referenceVersion));
            HttpResponse<String> noStatement = synth(port, host, token, voiceRequest);
            assertThat(noStatement.statusCode()).as(noStatement.body()).isEqualTo(403);
            assertThat(errorCode(noStatement)).isEqualTo("RIGHTS_DECISION_DENIED");

            post(port, tenant, token, "/dev/v1/rights/attestations", Map.of("artifactId", referenceId,
                    "artifactVersionId", referenceVersion, "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                    "basis", "TEST: synthetic tone, processing only; no voice or likeness consent"), 201);
            HttpResponse<String> wrongScope = synth(port, host, token, voiceRequest);
            assertThat(wrongScope.statusCode()).as(wrongScope.body()).isEqualTo(403);
            assertThat(errorCode(wrongScope)).isEqualTo("RIGHTS_DECISION_DENIED");

            String consentId = post(port, tenant, token, "/dev/v1/rights/attestations", Map.of("artifactId", referenceId,
                    "artifactVersionId", referenceVersion, "statementKind", "IDENTIFIABLE_PERSON_CONSENT",
                    "scopes", List.of("VOICE_OR_LIKENESS_USE"),
                    "basis", "TEST: synthetic statement by a test principal; no real person consented"), 201)
                    .path("attestationId").asString();
            HttpResponse<String> unconfirmed = synth(port, host, token, voiceRequest);
            assertThat(unconfirmed.statusCode()).as(unconfirmed.body()).isEqualTo(403);
            assertThat(errorCode(unconfirmed)).isEqualTo("RIGHTS_DECISION_DENIED");

            post(port, tenant, confirmerToken, "/dev/v1/rights/attestations/" + consentId + "/confirm",
                    Map.of("note", "TEST second-person confirmation by a synthetic test principal"), 200);
            HttpResponse<String> confirmed = synth(port, host, token, voiceRequest);
            assertThat(confirmed.statusCode()).as(confirmed.body()).isEqualTo(422);
            assertThat(errorCode(confirmed)).isEqualTo("VOICE_CLONING_NOT_SUPPORTED");
            assertThat(confirmed.body()).doesNotContain("\"artifact\"");

            // The same confirmed statement does not make a likeness reference on ANOTHER version admissible.
            Map<String, Object> likenessRequest = Map.of("requestId", "j04-likeness-" + run, "text", SENTENCE, "voice", "af_heart",
                    "likenessReference", Map.of("artifactId", likenessId, "artifactVersionId", likenessVersion));
            HttpResponse<String> likenessDenied = synth(port, host, token, likenessRequest);
            assertThat(likenessDenied.statusCode()).as(likenessDenied.body()).isEqualTo(403);
            String likenessConsent = post(port, tenant, token, "/dev/v1/rights/attestations", Map.of("artifactId", likenessId,
                    "artifactVersionId", likenessVersion, "statementKind", "IDENTIFIABLE_PERSON_CONSENT",
                    "scopes", List.of("VOICE_OR_LIKENESS_USE"), "basis", "TEST: synthetic statement; no real person"), 201)
                    .path("attestationId").asString();
            post(port, tenant, confirmerToken, "/dev/v1/rights/attestations/" + likenessConsent + "/confirm",
                    Map.of("note", "TEST confirmation"), 200);
            HttpResponse<String> likenessConfirmed = synth(port, host, token, likenessRequest);
            assertThat(likenessConfirmed.statusCode()).as(likenessConfirmed.body()).isEqualTo(422);
            assertThat(errorCode(likenessConfirmed)).isEqualTo("VOICE_CLONING_NOT_SUPPORTED");

            // Revocation mid-journey: the retry with the SAME requestId is refused with the revoked reason.
            post(port, tenant, token, "/dev/v1/rights/attestations/" + consentId + "/revoke", Map.of("reason", "TEST: revoked mid-journey"), 200);
            HttpResponse<String> revoked = synth(port, host, token, voiceRequest);
            assertThat(revoked.statusCode()).as(revoked.body()).isEqualTo(403);
            assertThat(errorCode(revoked)).isEqualTo("RIGHTS_DECISION_REVOKED");
            post(port, tenant, token, "/dev/v1/rights/attestations/" + likenessConsent + "/revoke", Map.of("reason", "TEST: revoked"), 200);
            HttpResponse<String> likenessRevoked = synth(port, host, token, likenessRequest);
            assertThat(errorCode(likenessRevoked)).isEqualTo("RIGHTS_DECISION_REVOKED");

            // A reference the caller cannot see is a typed 404, never a rights oracle.
            HttpResponse<String> foreign = synth(port, host, confirmerToken, voiceRequest);
            assertThat(foreign.statusCode()).as(foreign.body()).isEqualTo(404);

            // E. Nothing above produced any audio artifact or any model run.
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).isEqualTo(wavBefore);
            assertThat(countArtifacts(POSTGRES, tenant, host.confirmer(), "audio/wav")).isZero();

            // F. The revoked refusals survive a restart.
            stopLauncher(launcher);
            launcher = startLauncher(host.classpath(), host.environment(), host.log());
            awaitReady(launcher, port);
            token = devToken(host, owner);
            HttpResponse<String> afterRestart = synth(port, host, token, voiceRequest);
            assertThat(errorCode(afterRestart)).isEqualTo("RIGHTS_DECISION_REVOKED");
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).isEqualTo(wavBefore);
        } finally {
            cleanup(host, launcher);
        }
    }

    @Test
    void alteredWeightsWithdrawTheProfileWithNoEffectAndRestoringThemReadmitsIt() throws Exception {
        Path realRoot = modelRoot();
        Map<String, String> realSpeech = kokoroEnvironment(realRoot);
        requireRealToolchain(realSpeech);
        // Work on a COPY of the verified install: the shared, digest-pinned weights are never touched.
        Path copyRoot = Files.createTempDirectory("media-dev-voice-modelroot-");
        Path modelCopy = copyRoot.resolve("models").resolve("kokoro-82m");
        Path source = realRoot.resolve("models").resolve("kokoro-82m");
        try (var walk = Files.walk(source)) {
            for (Path path : (Iterable<Path>) walk::iterator) {
                Path target = modelCopy.resolve(source.relativize(path).toString());
                if (Files.isDirectory(path)) Files.createDirectories(target);
                else Files.copy(path, target, StandardCopyOption.COPY_ATTRIBUTES);
            }
        }
        Map<String, String> speech = kokoroEnvironment(copyRoot);
        Host host = host("weights", speech);
        Process launcher = null;
        try {
            launcher = startLauncher(host.classpath(), host.environment(), host.log());
            awaitReady(launcher, host.port());
            int port = host.port();
            String tenant = host.tenant();
            String owner = host.owner();
            String token = devToken(host, owner);
            assertThat(get(port, tenant, token, "/dev/v1/speech/capabilities", 200).path("textToSpeech").path("ready").asBoolean()).isTrue();
            post(port, tenant, token, "/dev/v1/speech/syntheses", Map.of("requestId", "j04-weights-ok", "text", "Short check.",
                    "voice", "af_heart", "locale", "en"), 201);
            int before = countArtifacts(POSTGRES, tenant, owner, "audio/wav");
            assertThat(before).isEqualTo(1);

            // The weights are altered after admission (one appended byte): the profile is withdrawn at once.
            Path weights = modelCopy.resolve("kokoro-v1_0.pth");
            Files.write(weights, new byte[]{0x42}, StandardOpenOption.APPEND);
            JsonNode withdrawn = get(port, tenant, token, "/dev/v1/speech/capabilities", 200).path("textToSpeech");
            assertThat(withdrawn.path("ready").asBoolean()).isFalse();
            assertThat(withdrawn.path("voices")).isEmpty();
            HttpResponse<String> refused = synth(port, host, token, Map.of("requestId", "j04-weights-altered", "text", "Short check.",
                    "voice", "af_heart", "locale", "en"));
            assertThat(refused.statusCode()).as(refused.body()).isEqualTo(503);
            assertThat(errorCode(refused)).isEqualTo("SPEECH_RUNTIME_UNAVAILABLE");
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).isEqualTo(before);

            // A restart re-verifies the manifest digests and keeps it withdrawn.
            stopLauncher(launcher);
            launcher = startLauncher(host.classpath(), host.environment(), host.log());
            awaitReady(launcher, port);
            token = devToken(host, owner);
            JsonNode after = get(port, tenant, token, "/dev/v1/speech/capabilities", 200).path("textToSpeech");
            assertThat(after.path("ready").asBoolean()).isFalse();
            assertThat(after.path("installState").asString()).isNotEqualTo("VERIFIED");
            assertThat(after.path("voices")).isEmpty();
            assertThat(errorCode(synth(port, host, token, Map.of("requestId", "j04-weights-altered-2", "text", "Short check.",
                    "voice", "af_heart", "locale", "en")))).isEqualTo("SPEECH_RUNTIME_UNAVAILABLE");

            // Restoring the original bytes re-admits it after a restart (no manual flag, no self-approval).
            try (var channel = java.nio.channels.FileChannel.open(weights, StandardOpenOption.WRITE)) {
                channel.truncate(Files.size(weights) - 1);
            }
            stopLauncher(launcher);
            launcher = startLauncher(host.classpath(), host.environment(), host.log());
            awaitReady(launcher, port);
            token = devToken(host, owner);
            assertThat(get(port, tenant, token, "/dev/v1/speech/capabilities", 200).path("textToSpeech").path("ready").asBoolean()).isTrue();
        } finally {
            cleanup(host, launcher);
            deleteTree(copyRoot);
        }
    }

    @Test
    void aKilledWorkerOrLauncherIsUnknownNeverSuccessAndTheRetryIsIdempotentByRequestId() throws Exception {
        Map<String, String> speech = kokoroEnvironment(modelRoot());
        requireRealToolchain(speech);
        Host host = host("kill", speech);
        Process launcher = null;
        try {
            launcher = startLauncher(host.classpath(), host.environment(), host.log());
            awaitReady(launcher, host.port());
            int port = host.port();
            String tenant = host.tenant();
            String owner = host.owner();
            String token = devToken(host, owner);
            String run = UUID.randomUUID().toString().substring(0, 8);
            String text = longText();

            // 1. The synthesis worker is killed mid-run: UNKNOWN (never success), nothing registered.
            String workerRequest = "j04-worker-kill-" + run;
            Map<String, Object> body = Map.of("requestId", workerRequest, "text", text, "voice", "af_heart", "locale", "en");
            final Process running = launcher;
            CompletableFuture<HttpResponse<String>> inFlight = CompletableFuture.supplyAsync(() -> {
                try { return synth(port, host, devToken(host, owner), body); }
                catch (Exception failure) { throw new IllegalStateException(failure); }
            });
            List<ProcessHandle> workers = awaitWorkers(running);
            workers.forEach(ProcessHandle::destroyForcibly);
            HttpResponse<String> unknown = inFlight.get(120, TimeUnit.SECONDS);
            assertThat(unknown.statusCode()).as(unknown.body()).isEqualTo(503);
            assertThat(errorCode(unknown)).isEqualTo("SPEECH_OUTCOME_UNKNOWN");
            assertThat(unknown.body()).doesNotContain("\"artifact\"");
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).as("an UNKNOWN outcome registers nothing").isZero();

            // 2. The retry with the same requestId completes exactly once; a further retry replays it.
            HttpResponse<String> retry = synth(port, host, token, body);
            assertThat(retry.statusCode()).as(retry.body()).isEqualTo(201);
            JsonNode created = JSON.readTree(retry.body());
            String retryVersion = created.path("artifact").path("artifactVersionId").asString();
            assertThat(created.path("lineage").path("audio").path("durationMillis").asLong()).isGreaterThan(10_000);
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).isEqualTo(1);
            HttpResponse<String> replay = synth(port, host, token, body);
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            assertThat(JSON.readTree(replay.body()).path("replayed").asBoolean()).isTrue();
            assertThat(JSON.readTree(replay.body()).path("artifact").path("artifactVersionId").asString()).isEqualTo(retryVersion);
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).isEqualTo(1);

            // 3. The whole launcher process is killed mid-synthesis: the client sees no result; after a restart
            // the retry with the same requestId creates exactly one artifact and a second retry replays it.
            String launcherRequest = "j04-launcher-kill-" + run;
            Map<String, Object> second = Map.of("requestId", launcherRequest, "text", text, "voice", "am_michael", "locale", "en");
            CompletableFuture<Object> lost = CompletableFuture.supplyAsync(() -> {
                try { return synth(port, host, devToken(host, owner), second); }
                catch (Exception expected) { return expected; }
            });
            awaitWorkers(running);
            running.destroyForcibly();
            running.waitFor(15, TimeUnit.SECONDS);
            Object outcome = lost.get(120, TimeUnit.SECONDS);
            assertThat(outcome).as("a killed launcher never reports success").isInstanceOf(Exception.class);
            launcher = startLauncher(host.classpath(), host.environment(), host.log());
            awaitReady(launcher, port);
            token = devToken(host, owner);
            int beforeRetry = countArtifacts(POSTGRES, tenant, owner, "audio/wav");
            assertThat(beforeRetry).as("the killed launcher registered at most the first artifact plus possibly the second").isBetween(1, 2);
            HttpResponse<String> afterKill = synth(port, host, token, second);
            assertThat(afterKill.statusCode()).as(afterKill.body()).isIn(200, 201);
            String secondVersion = JSON.readTree(afterKill.body()).path("artifact").path("artifactVersionId").asString();
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).isEqualTo(2);
            HttpResponse<String> again = synth(port, host, token, second);
            assertThat(again.statusCode()).isEqualTo(200);
            assertThat(JSON.readTree(again.body()).path("artifact").path("artifactVersionId").asString()).isEqualTo(secondVersion);
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).isEqualTo(2);

            // 4. After one more restart the registered artifact reads back with its decoded duration.
            stopLauncher(launcher);
            launcher = startLauncher(host.classpath(), host.environment(), host.log());
            awaitReady(launcher, port);
            token = devToken(host, owner);
            String artifactId = JSON.readTree(afterKill.body()).path("artifact").path("artifactId").asString();
            JsonNode reopened = get(port, tenant, token, "/dev/v1/speech/outputs/" + artifactId, 200);
            assertThat(reopened.path("artifact").path("artifactVersionId").asString()).isEqualTo(secondVersion);
            byte[] wav = s3Bytes(LOCALSTACK, host.bucket(), storedArtifact(POSTGRES, tenant, owner, artifactId));
            assertThat(Double.parseDouble(probe(wav, "wav").path("format").path("duration").asString())).isGreaterThan(10.0);
        } finally {
            cleanup(host, launcher);
        }
    }

    private static List<ProcessHandle> awaitWorkers(Process launcher) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        while (System.nanoTime() < deadline) {
            List<ProcessHandle> workers = kokoroWorkers(launcher);
            if (!workers.isEmpty()) {
                Thread.sleep(2_000); // let the model load so the kill lands mid-synthesis, not before it starts
                List<ProcessHandle> alive = new ArrayList<>(kokoroWorkers(launcher));
                if (!alive.isEmpty()) return alive;
            }
            Thread.sleep(100);
        }
        throw new AssertionError("no Kokoro worker process appeared under the launcher");
    }
}
