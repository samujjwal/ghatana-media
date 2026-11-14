package com.ghatana.media.launcher;

import com.ghatana.agent.framework.tools.ToolActionClass;
import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.agent.framework.tools.ToolExecutionStatus;
import com.ghatana.agent.framework.tools.ToolTransport;
import com.ghatana.audio.video.tools.AudioVideoToolHandlerFactory;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.ClaimResult;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.InvocationLedger;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.LogicalAction;
import com.ghatana.audio.video.tools.MediaToolJobBridge;
import com.ghatana.audio.video.tools.RuntimeMediaJobSubmissionPort;
import com.ghatana.governance.PolicyDecisionOutcome;
import com.ghatana.governance.PolicyDecisionRecord;
import com.ghatana.governance.PolicyEngine;
import com.ghatana.governance.PolicyEvaluationContext;
import com.ghatana.governance.PolicyReasonCode;
import com.ghatana.media.provider.aws.PostgresqlMediaConsentAuthority;
import com.ghatana.media.provider.aws.PostgresqlMediaJobStore;
import com.ghatana.media.provider.aws.PostgresqlMediaSourceAuthorizationAuthority;
import com.ghatana.media.provider.aws.PostgresqlMediaSourceRightsAdministration;
import com.ghatana.media.provider.aws.PostgresqlMediaStreamSessionStore;
import com.ghatana.media.provider.aws.PostgresqlMediaTranscriptStore;
import com.ghatana.media.provider.aws.TestAwsStateInstall;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.media.runtime.MediaSourceRightsAdministration;
import com.ghatana.stt.local.PcmWav;
import com.ghatana.stt.provider.LocalWhisperCppSttProvider;
import com.ghatana.tools.testing.EventloopTestBase;
import com.ghatana.tts.local.LocalKokoroTtsProvider;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Canonical durable path for the local speech models, driven the way an agent drives it: the
 * {@code av.speech-to-text} / {@code av.text-to-speech} tool handlers -> MediaToolJobBridge ->
 * RuntimeMediaJobSubmissionPort -> MediaRuntime job admission, provider attempt, fenced commit -> PostgreSQL job and
 * transcript stores, with the REAL pinned Whisper large-v3-turbo (whisper.cpp) and Kokoro-82M runtimes.
 *
 * <p>Rights and policy are explicit TEST FIXTURES (an ALLOW policy engine and a registered source-rights record);
 * they prove the canonical rights path accepts a registered source, not that any real rights decision exists. Skipped
 * with a reason only when Docker or the installed runtimes are absent.</p>
 */
@Tag("integration")
@Testcontainers(disabledWithoutDocker = true)
class MediaLocalSpeechCanonicalToolIT extends EventloopTestBase {
    @Container static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    private static final String TENANT = "tenant-a";
    private static final String PRINCIPAL = "principal-a";
    private static final String SENTENCE = "The quick brown fox jumps over the lazy dog.";
    private static com.sun.net.httpserver.HttpsServer s3Stub;
    private static Path keystore;
    private static String stubUrl;
    private static final Map<String, String> previousTls = new HashMap<>();

    @org.junit.jupiter.api.BeforeAll
    static void startS3Stub() throws Exception {
        keystore = Files.createTempFile("media-speech-s3-", ".p12");
        Files.delete(keystore);
        new ProcessBuilder("keytool", "-genkeypair", "-alias", "s3stub", "-keyalg", "RSA", "-keysize", "2048",
                "-validity", "1", "-keystore", keystore.toString(), "-storetype", "PKCS12", "-storepass", "changeit",
                "-keypass", "changeit", "-dname", "CN=localhost", "-ext", "SAN=dns:localhost,ip:127.0.0.1")
                .inheritIO().start().waitFor();
        javax.net.ssl.KeyManagerFactory keyManagers = javax.net.ssl.KeyManagerFactory
                .getInstance(javax.net.ssl.KeyManagerFactory.getDefaultAlgorithm());
        var store = java.security.KeyStore.getInstance(keystore.toFile(), "changeit".toCharArray());
        keyManagers.init(store, "changeit".toCharArray());
        javax.net.ssl.SSLContext tls = javax.net.ssl.SSLContext.getInstance("TLS");
        tls.init(keyManagers.getKeyManagers(), null, null);
        for (String prop : new String[]{"javax.net.ssl.trustStore", "javax.net.ssl.trustStorePassword",
                "javax.net.ssl.trustStoreType"}) {
            previousTls.put(prop, System.getProperty(prop));
        }
        System.setProperty("javax.net.ssl.trustStore", keystore.toString());
        System.setProperty("javax.net.ssl.trustStorePassword", "changeit");
        System.setProperty("javax.net.ssl.trustStoreType", "PKCS12");
        s3Stub = com.sun.net.httpserver.HttpsServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        s3Stub.setHttpsConfigurator(new com.sun.net.httpserver.HttpsConfigurator(tls));
        s3Stub.createContext("/", exchange -> {
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        s3Stub.start();
        stubUrl = "https://127.0.0.1:" + s3Stub.getAddress().getPort();
    }

    @org.junit.jupiter.api.AfterAll
    static void stopS3Stub() throws Exception {
        if (s3Stub != null) s3Stub.stop(0);
        previousTls.forEach((key, value) -> {
            if (value == null) System.clearProperty(key);
            else System.setProperty(key, value);
        });
        if (keystore != null) Files.deleteIfExists(keystore);
    }

    private static Map<String, String> speechEnvironment() {
        String configured = System.getenv("MEDIA_LOCAL_MODEL_ROOT");
        Path root = configured != null && !configured.isBlank() ? Path.of(configured)
                : Path.of(System.getProperty("user.home"), ".local", "share", "ghatana-media");
        Path script = Path.of("").toAbsolutePath().getParent().resolve("tools/model-runtimes/kokoro_synth.py");
        Map<String, String> environment = new HashMap<>(Map.of("MEDIA_LOCAL_MODEL_ROOT", root.toString(),
                "MEDIA_WHISPER_CPP_BIN", root.resolve("runtimes/whisper.cpp-src/build-vulkan/bin/whisper-cli").toString(),
                "MEDIA_KOKORO_PYTHON", root.resolve("runtimes/kokoro-venv/bin/python").toString(),
                "MEDIA_KOKORO_SCRIPT", script.toString(), "MEDIA_KOKORO_WORKER", "true",
                "MEDIA_WHISPER_CPP_THREADS", "8"));
        // MP3 / OGG_OPUS encoding needs an FFmpeg build with the codec; absent means WAV only.
        String ffmpeg = System.getenv("MEDIA_FFMPEG");
        if (ffmpeg != null && !ffmpeg.isBlank()) environment.put("MEDIA_FFMPEG", ffmpeg);
        return environment;
    }

    @Test
    void agentSpeechToolsRunRealLocalModelsThroughTheCanonicalJobAndTranscriptStores() throws Exception {
        LocalWhisperCppSttProvider stt = LocalWhisperCppSttProvider.fromEnvironment(speechEnvironment());
        LocalKokoroTtsProvider tts = LocalKokoroTtsProvider.fromEnvironment(speechEnvironment());
        assumeTrue(stt.ready() && tts.ready(), "local Whisper/Kokoro runtimes with verified manifests are not "
                + "installed on this host (run tools/model-runtimes/install-local-manifests.sh)");

        // Optional warm-up (MEDIA_LOCAL_MODEL_PRELOAD): loads Kokoro and pages in the Whisper weights ahead of use.
        long sttWarm = stt.warmUp().get(10, java.util.concurrent.TimeUnit.MINUTES);
        long ttsWarm = tts.warmUp().get(10, java.util.concurrent.TimeUnit.MINUTES);
        System.out.println("LOCAL_SPEECH_WARMUP whisperMillis=" + sttWarm + " kokoroMillis=" + ttsWarm);
        assertThat(sttWarm).isGreaterThanOrEqualTo(0);
        assertThat(ttsWarm).isGreaterThanOrEqualTo(0);

        // A real 16 kHz mono clip, produced by the real Kokoro model.
        long synthesisStarted = System.nanoTime();
        var synthesis = tts.synthesizer().synthesize(SENTENCE, "af_heart", 1.0, Duration.ofMinutes(3),
                () -> false);
        System.out.println("LOCAL_SPEECH_KOKORO_AFTER_WARMUP millis="
                + Duration.ofNanos(System.nanoTime() - synthesisStarted).toMillis());
        PcmWav.Pcm pcm16k = PcmWav.resample(PcmWav.decode(synthesis.wav()), 16_000);
        byte[] wav = PcmWav.encode(pcm16k);
        String wavSha = sha(wav);

        try (AutoCloseable installed = TestAwsStateInstall.install(environment());
             var artifactStore = new LocalMediaRuntimeSupport.FileArtifactStore(
                     Files.createTempDirectory("media-speech-artifacts"));
             var jobStore = new PostgresqlMediaJobStore();
             var streamStore = new PostgresqlMediaStreamSessionStore();
             var consentAuthority = new PostgresqlMediaConsentAuthority();
             var authority = new PostgresqlMediaSourceAuthorizationAuthority(new AllowPolicy());
             var transcriptStore = new PostgresqlMediaTranscriptStore();
             var administration = new PostgresqlMediaSourceRightsAdministration();
             var runtime = new MediaRuntime(
                     new MediaRuntimeConfig(true, "test", 8094, 8 * 1024 * 1024, 4 * 1024 * 1024,
                             64L * 1024 * 1024, Duration.ofMinutes(5), 4, "", "", false, false,
                             Files.createTempDirectory("media-speech-root")),
                     artifactStore, jobStore, streamStore, consentAuthority,
                     MediaSemanticRedactionRuntime.disabled(Duration.ofSeconds(2)),
                     MediaLifecyclePublisher.disabled(), List.of(stt, tts),
                     List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()), List.of(), authority,
                     transcriptStore, Clock.systemUTC())) {

            MediaArtifact source = upload(runtime, wav, wavSha, pcm16k.samples().length, "speech-upload-1");
            seedArtifactRow(source, pcm16k.samples().length);
            MediaArtifact unregistered = upload(runtime, wav, wavSha, pcm16k.samples().length, "speech-upload-2");
            assertThat(unregistered.artifactId()).isNotEqualTo(source.artifactId());

            // Rights fixture: only `source` has a registered, current, source-owner rights record.
            MediaSourceRightsAdministration.SourceRecord record = administration.register(
                    new MediaSourceRightsAdministration.RegisterRequest(TENANT, PRINCIPAL, source.artifactId(),
                            source.version().value(), wavSha, PRINCIPAL,
                            MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                            MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                            "", Set.of("speech_to_text", "caption_version_write"), Set.of("transcription"),
                            Set.of("local"), Set.of(ProviderDataRetention.NONE), "fixture-clock-evidence",
                            "provenance://fixture/speech", Instant.now().plusSeconds(3600), "correlation-speech"),
                    new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(TENANT, PRINCIPAL, Instant.now()));
            assertThat(record.revoked()).isFalse();

            var profile = stt.speechToTextProfile().orElseThrow();
            var bridge = new MediaToolJobBridge(new RuntimeMediaJobSubmissionPort(runtime), "test",
                    new MediaToolJobBridge.SpeechProfilePin(profile.profileId(), profile.profileVersion(),
                            profile.configurationDigest()), Duration.ofMinutes(5),
                    Map.of(com.ghatana.media.runtime.MediaRuntimeContracts.JobType.SPEECH_TO_TEXT, governance()))
                    .withSupportedTtsEncodings(tts.supportedEncodings());
            var factory = new AudioVideoToolHandlerFactory(new MediaToolExecutionBinder(new MemoryLedger(),
                    bridge.readback(), (p, id) -> p.tenantId().equals(id.tenantId())
                            && p.principalId().equals(id.callerAgentId())), bridge);
            var caller = new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(TENANT, PRINCIPAL, Instant.now());

            // ---- speech-to-text tool: real whisper.cpp, canonical admission, fenced commit, transcript store ----
            ToolExecutionResult stto = runTool(factory, caller, "av.speech-to-text", Map.of(
                    "audioSource", Map.of("mediaArtifactId", source.artifactId()), "languageCode", "en-US",
                    "sourceArtifactVersion", source.version().value()));
            assertThat(stto.status()).as("STT tool result: %s / %s", stto.status(), stto.failure())
                    .isEqualTo(ToolExecutionStatus.SUCCESS);
            @SuppressWarnings("unchecked") Map<String, Object> sttOut = (Map<String, Object>) stto.output();
            assertThat(sttOut).containsEntry("status", "COMPLETED").containsEntry("jobType", "SPEECH_TO_TEXT");
            String jobId = (String) sttOut.get("jobId");
            var binding = transcriptStore.readAttemptBinding(TENANT, PRINCIPAL, "transcript:" + jobId, 1);
            var transcript = transcriptStore.revisionByVersionRef(TENANT, PRINCIPAL,
                    binding.transcriptVersionRef()).orElseThrow();
            assertThat(transcript.admissionStatus()).isEqualTo("ADMITTED");
            String text = transcript.draft().text();
            System.out.println("LOCAL_SPEECH_CANONICAL_STT input=\"" + SENTENCE + "\" transcript=\"" + text + "\"");
            String normalized = text.toLowerCase(Locale.ROOT).replaceAll("[^a-z ]", " ");
            for (String word : List.of("quick", "brown", "fox", "jumps", "lazy", "dog")) {
                assertThat(normalized).as("durable transcript: %s", text).contains(word);
            }
            // The declared 1 tick/second clock cannot map 16 kHz sample extents exactly, so (as for the ONNX provider)
            // the provider makes no timing claim; the production-like transcript store admits no segment projection.
            assertThat(transcript.draft().segments()).isEmpty();

            // ---- STT rights gate stays closed for a source with no registered rights ----
            ToolExecutionResult denied = runTool(factory, caller, "av.speech-to-text", Map.of(
                    "audioSource", Map.of("mediaArtifactId", unregistered.artifactId()), "languageCode", "en-US",
                    "sourceArtifactVersion", unregistered.version().value()));
            assertThat(denied.status()).isEqualTo(ToolExecutionStatus.FAILED);
            assertThat(denied.failure().code()).isEqualTo("MEDIA_NOT_ADMITTED");

            // ---- text-to-speech tool: real Kokoro through the same canonical job path ----
            ToolExecutionResult ttso = runTool(factory, caller, "av.text-to-speech", Map.of(
                    "text", "Local speech, on this machine.", "voiceId", "af_heart", "audioEncoding", "LINEAR16",
                    "sourceArtifactId", source.artifactId(), "sourceArtifactVersion", source.version().value()));
            assertThat(ttso.status()).as("TTS tool result: %s / %s", ttso.status(), ttso.failure())
                    .isEqualTo(ToolExecutionStatus.SUCCESS);
            @SuppressWarnings("unchecked") Map<String, Object> ttsOut = (Map<String, Object>) ttso.output();
            @SuppressWarnings("unchecked") Map<String, Object> ttsResult = (Map<String, Object>) ttsOut.get("result");
            assertThat((String) ttsResult.get("audioSha256")).matches("[0-9a-f]{64}");
            assertThat(ttsResult).containsEntry("sampleRate", 24_000).containsEntry("audioContentType", "audio/wav");
            assertThat(((Number) ttsResult.get("sizeBytes")).intValue()).isGreaterThan(20_000);
            assertThat(ttsResult).containsEntry("voiceCloning", "NOT_SUPPORTED").containsEntry("voice", "af_heart");
            assertThat(ttsResult).doesNotContainKey("audioBytes");

            // ---- the audio itself is a canonical artifact version, with lineage, readable back byte-exact ----
            String audioId = (String) ttsOut.get("audioArtifactId");
            String audioVersion = (String) ttsOut.get("audioArtifactVersion");
            assertThat(audioId).isNotBlank();
            assertThat(audioVersion).isEqualTo("sha256:" + ttsResult.get("audioSha256"));
            assertThat(ttsResult).containsEntry("audioArtifactRef", "urn:ghatana:media-artifact:" + audioId);
            MediaArtifact audioArtifact = runtime.artifact(TENANT, PRINCIPAL, audioId).orElseThrow();
            assertThat(audioArtifact.contentType()).isEqualTo("audio/wav");
            assertThat(audioArtifact.sha256()).isEqualTo(ttsResult.get("audioSha256"));
            assertThat(audioArtifact.metadata()).containsEntry("derivation", "TEXT_TO_SPEECH")
                    .containsEntry("derivedFromArtifactId", source.artifactId())
                    .containsEntry("derivedFromArtifactVersion", source.version().value())
                    .containsEntry("voice", "af_heart")
                    .containsEntry("modelKey", "kokoro-82m")
                    .containsEntry("textSha256", sha("Local speech, on this machine.".getBytes(java.nio.charset.StandardCharsets.UTF_8)));
            assertThat((String) audioArtifact.metadata().get("modelSha256")).matches("[0-9a-f]{64}");
            java.io.ByteArrayOutputStream readBack = new java.io.ByteArrayOutputStream();
            runtime.copyArtifactContent(TENANT, PRINCIPAL, audioId, audioArtifact.version(), readBack, 8L * 1024 * 1024)
                    .orElseThrow();
            assertThat(sha(readBack.toByteArray())).isEqualTo(ttsResult.get("audioSha256"));
            assertThat(PcmWav.decode(readBack.toByteArray()).sampleRate()).isEqualTo(24_000);
            System.out.println("LOCAL_SPEECH_CANONICAL_TTS_WAV artifact=" + audioId + " version=" + audioVersion
                    + " bytes=" + readBack.size());

            // ---- MP3 (the tool's default encoding): real FFmpeg encoding, registered, decodable; else typed refusal ----
            Map<String, Object> mp3Input = new HashMap<>(Map.of(
                    "text", "Encoding check, as an MP3 file.", "voiceId", "af_heart",
                    "sourceArtifactId", source.artifactId(), "sourceArtifactVersion", source.version().value()));
            ToolExecutionResult mp3 = runTool(factory, caller, "av.text-to-speech", mp3Input); // default MP3
            if (tts.supportedEncodings().contains("MP3")) {
                assertThat(mp3.status()).as("MP3 tool result: %s / %s", mp3.status(), mp3.failure())
                        .isEqualTo(ToolExecutionStatus.SUCCESS);
                @SuppressWarnings("unchecked") Map<String, Object> mp3Out = (Map<String, Object>) mp3.output();
                @SuppressWarnings("unchecked") Map<String, Object> mp3Result = (Map<String, Object>) mp3Out.get("result");
                assertThat(mp3Result).containsEntry("audioContentType", "audio/mpeg").containsEntry("audioEncoding", "MP3");
                MediaArtifact mp3Artifact = runtime.artifact(TENANT, PRINCIPAL, (String) mp3Out.get("audioArtifactId"))
                        .orElseThrow();
                assertThat(mp3Artifact.contentType()).isEqualTo("audio/mpeg");
                assertThat(mp3Artifact.fileName()).endsWith(".mp3");
                java.io.ByteArrayOutputStream mp3Bytes = new java.io.ByteArrayOutputStream();
                runtime.copyArtifactContent(TENANT, PRINCIPAL, mp3Artifact.artifactId(), mp3Artifact.version(),
                        mp3Bytes, 8L * 1024 * 1024).orElseThrow();
                assertThat(sha(mp3Bytes.toByteArray())).isEqualTo(mp3Artifact.sha256());
                assertThat(mp3Bytes.size()).isGreaterThan(5_000).isLessThan(((Number) ttsResult.get("sizeBytes")).intValue());
                Path mp3File = Files.createTempFile("tts-out-", ".mp3");
                Files.write(mp3File, mp3Bytes.toByteArray());
                System.out.println("LOCAL_SPEECH_CANONICAL_TTS_MP3 artifact=" + mp3Artifact.artifactId()
                        + " bytes=" + mp3Bytes.size() + " file=" + mp3File);
            } else {
                assertThat(mp3.status()).as("an encoding the profile cannot produce must never report success")
                        .isNotEqualTo(ToolExecutionStatus.SUCCESS);
                assertThat(mp3.failure().code()).isEqualTo("TTS_AUDIO_ENCODING_NOT_SUPPORTED");
            }

            // ---- input the provider can prove it never acted on (a pitch shift Kokoro cannot do) is a typed
            //      no-effect failure of the job, never an endless OUTCOME_UNKNOWN ----
            ToolExecutionResult pitch = runTool(factory, caller, "av.text-to-speech", Map.of(
                    "text", "Pitch check.", "voiceId", "af_heart", "audioEncoding", "LINEAR16", "pitch", 5.0,
                    "sourceArtifactId", source.artifactId(), "sourceArtifactVersion", source.version().value()));
            assertThat(pitch.status()).as("pitch refusal: %s / %s", pitch.status(), pitch.failure())
                    .isEqualTo(ToolExecutionStatus.FAILED);
            assertThat(pitch.failure().code()).isEqualTo("PROVIDER_NO_EFFECT_PROVEN");

            // ---- an encoding the host's profile cannot honour is refused before any job exists ----
            if (!tts.supportedEncodings().contains("OGG_OPUS")) {
                ToolExecutionResult ogg = runTool(factory, caller, "av.text-to-speech", Map.of(
                        "text", "Encoding check.", "voiceId", "af_heart", "audioEncoding", "OGG_OPUS",
                        "sourceArtifactId", source.artifactId(), "sourceArtifactVersion", source.version().value()));
                assertThat(ogg.status()).isEqualTo(ToolExecutionStatus.FAILED);
                assertThat(ogg.failure().code()).isEqualTo("TTS_AUDIO_ENCODING_NOT_SUPPORTED");
            }
        }
    }

    /**
     * The agent {@code av.multimodal-inference} tool with transcription AND vision enabled runs both canonical children
     * over one source version: a real MP4 whose audio is a Kokoro-spoken sentence and whose frame is rendered text.
     * Whisper (real) transcribes the extracted audio track, Florence-2 (real, through the loopback sidecar) reads the
     * frame, and the parent completes with a fused result. Source rights remain required: the same call on a source
     * with no registered rights is refused. Skipped with the reason when a runtime, FFmpeg (MEDIA_FFMPEG,
     * MEDIA_FFPROBE) or the vision sidecar is absent.
     */
    @Test
    void agentMultimodalToolRunsRealWhisperAndFlorenceChildrenAndFusesTheirResults() throws Exception {
        Map<String, String> speechEnvironment = new HashMap<>(speechEnvironment());
        String ffmpeg = System.getenv("MEDIA_FFMPEG");
        String ffprobe = System.getenv("MEDIA_FFPROBE");
        assumeTrue(ffmpeg != null && !ffmpeg.isBlank() && ffprobe != null && !ffprobe.isBlank(),
                "SKIPPED: MEDIA_FFMPEG / MEDIA_FFPROBE (absolute paths of a working FFmpeg) are not set");
        LocalWhisperCppSttProvider stt = LocalWhisperCppSttProvider.fromEnvironment(speechEnvironment);
        LocalKokoroTtsProvider tts = LocalKokoroTtsProvider.fromEnvironment(speechEnvironment);
        assumeTrue(stt.ready() && tts.ready(), "SKIPPED: local Whisper/Kokoro runtimes with verified manifests absent");
        Path home = Path.of(System.getProperty("user.home"));
        Path models = home.resolve(".local/share/ghatana-media/models");
        Path python = home.resolve(".local/share/ghatana-media/runtimes/vision-venv/bin/python");
        Path script = Path.of("").toAbsolutePath().getParent().resolve("tools/model-runtimes/vision/vision_sidecar.py");
        assumeTrue(java.nio.file.Files.isExecutable(python) && Files.isRegularFile(script)
                && Files.isRegularFile(models.resolve("florence-2-large/ghatana-model-manifest.json")),
                "SKIPPED: the local vision runtime or Florence-2 manifest is absent");

        // Source: MP4 = rendered text frame + spoken sentence (real Kokoro, resampled to 16 kHz mono).
        var synthesis = tts.synthesizer().synthesize(SENTENCE, "af_heart", 1.0, Duration.ofMinutes(3), () -> false);
        byte[] speech16k = PcmWav.encode(PcmWav.resample(PcmWav.decode(synthesis.wav()), 16_000));
        byte[] mp4 = buildMp4(Path.of(ffmpeg), speech16k);
        assertThat(mp4.length).as("the source must fit the 4 MiB STT staging ceiling").isLessThan(4 * 1024 * 1024);
        String mp4Sha = sha(mp4);

        try (var sidecar = com.ghatana.audio.video.vision.local.LocalVisionSidecarProcess.start(python, script, models,
                Duration.ofSeconds(120));
             AutoCloseable installed = TestAwsStateInstall.install(environment());
             var artifactStore = new LocalMediaRuntimeSupport.FileArtifactStore(
                     Files.createTempDirectory("media-mm-artifacts"));
             var jobStore = new PostgresqlMediaJobStore();
             var streamStore = new PostgresqlMediaStreamSessionStore();
             var consentAuthority = new PostgresqlMediaConsentAuthority();
             var authority = new PostgresqlMediaSourceAuthorizationAuthority(new AllowPolicy());
             var transcriptStore = new PostgresqlMediaTranscriptStore();
             var administration = new PostgresqlMediaSourceRightsAdministration()) {
            var engine = new com.ghatana.audio.video.vision.local.LocalVisionEngine(
                    sidecar.client(Duration.ofMinutes(8)),
                    new com.ghatana.audio.video.vision.local.LocalModelAdmission(models.resolve("florence-2-large"),
                            com.ghatana.audio.video.vision.local.LocalVisionEngine.FLORENCE_MODEL_ID, "VISION", "MIT"),
                    new com.ghatana.audio.video.vision.local.LocalModelAdmission(
                            models.resolve("qwen2.5-vl-7b-instruct"),
                            com.ghatana.audio.video.vision.local.LocalVisionEngine.QWEN_MODEL_ID, "MULTIMODAL_QA",
                            "Apache-2.0"),
                    com.ghatana.audio.video.vision.local.LocalVisionRightsAuthority.unavailable());
            var vision = new com.ghatana.audio.video.vision.local.LocalOpenModelVisionProvider(engine,
                    MediaDevFfmpegFrameExtractor.from(Map.of(MediaDevProjectRenderRuntime.FFMPEG_ENV, ffmpeg)));
            var multimodal = new com.ghatana.audio.video.multimodal.engine.DelegatingMultimodalProvider();
            try (var runtime = new MediaRuntime(
                    new MediaRuntimeConfig(true, "test", 8094, 8 * 1024 * 1024, 4 * 1024 * 1024,
                            64L * 1024 * 1024, Duration.ofMinutes(10), 4, "", "", false, false,
                            Files.createTempDirectory("media-mm-root")),
                    artifactStore, jobStore, streamStore, consentAuthority,
                    MediaSemanticRedactionRuntime.disabled(Duration.ofSeconds(2)),
                    MediaLifecyclePublisher.disabled(), List.of(stt, vision, multimodal),
                    List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()), List.of(), authority,
                    transcriptStore, Clock.systemUTC())) {
                String metadata = "{\"sourceClockId\":\"fixture-clock\","
                        + "\"sourceClockMappingEvidenceRef\":\"fixture-clock-evidence\","
                        + "\"sourceClockTicksPerSecond\":1,\"sourceDurationTicks\":10}";
                var upload = runtime.beginUpload(new UploadRequest(TENANT, PRINCIPAL, "talk.mp4", "video/mp4",
                        mp4.length, mp4Sha, "CONFIDENTIAL", Duration.ofMinutes(30), Map.of(
                        "sourceClockId", "fixture-clock", "sourceClockMappingEvidenceRef", "fixture-clock-evidence",
                        "sourceClockTicksPerSecond", 1, "sourceDurationTicks", 10)), "mm-upload-1");
                runtime.appendChunk(TENANT, PRINCIPAL, upload.uploadId(), 0, mp4);
                MediaArtifact source = runtime.completeUpload(TENANT, PRINCIPAL, upload.uploadId());
                seedArtifactRow(source, metadata);
                var upload2 = runtime.beginUpload(new UploadRequest(TENANT, PRINCIPAL, "talk.mp4", "video/mp4",
                        mp4.length, mp4Sha, "CONFIDENTIAL", Duration.ofMinutes(30), Map.of(
                        "sourceClockId", "fixture-clock", "sourceClockMappingEvidenceRef", "fixture-clock-evidence",
                        "sourceClockTicksPerSecond", 1, "sourceDurationTicks", 10)), "mm-upload-2");
                runtime.appendChunk(TENANT, PRINCIPAL, upload2.uploadId(), 0, mp4);
                MediaArtifact unregistered = runtime.completeUpload(TENANT, PRINCIPAL, upload2.uploadId());
                assertThat(unregistered.artifactId()).isNotEqualTo(source.artifactId());
                seedArtifactRow(unregistered, metadata);

                // Rights fixture: only `source` has a current source-owner rights record, for exactly the operations
                // the parent and its two children use. It is a TEST FIXTURE, not a real rights decision.
                administration.register(new MediaSourceRightsAdministration.RegisterRequest(TENANT, PRINCIPAL,
                        source.artifactId(), source.version().value(), mp4Sha, PRINCIPAL,
                        MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                        MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT, "",
                        Set.of("multimodal", "speech_to_text", "vision", "caption_version_write"),
                        Set.of("transcription"), Set.of("local"), Set.of(ProviderDataRetention.NONE),
                        "fixture-clock-evidence", "provenance://fixture/multimodal",
                        Instant.now().plusSeconds(3600), "correlation-multimodal"),
                        new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(TENANT, PRINCIPAL, Instant.now()));

                var profile = stt.speechToTextProfile().orElseThrow();
                var governance = governance();
                var bridge = new MediaToolJobBridge(new RuntimeMediaJobSubmissionPort(runtime), "test",
                        new MediaToolJobBridge.SpeechProfilePin(profile.profileId(), profile.profileVersion(),
                                profile.configurationDigest()), Duration.ofMinutes(9),
                        Map.of(com.ghatana.media.runtime.MediaRuntimeContracts.JobType.SPEECH_TO_TEXT, governance,
                                com.ghatana.media.runtime.MediaRuntimeContracts.JobType.VISION, governance,
                                com.ghatana.media.runtime.MediaRuntimeContracts.JobType.MULTIMODAL, governance));
                var factory = new AudioVideoToolHandlerFactory(new MediaToolExecutionBinder(new MemoryLedger(),
                        bridge.readback(), (p, id) -> p.tenantId().equals(id.tenantId())
                                && p.principalId().equals(id.callerAgentId())), bridge);
                var caller = new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(TENANT, PRINCIPAL,
                        Instant.now());

                // ---- rights PROCESSING stays required: an unregistered source is refused, nothing runs ----
                ToolExecutionResult denied = runTool(factory, caller, "av.multimodal-inference", Map.of(
                        "mediaArtifactId", unregistered.artifactId(), "languageCode", "en-US",
                        "sourceArtifactVersion", unregistered.version().value()));
                System.out.println("LOCAL_MULTIMODAL_UNREGISTERED_SOURCE status=" + denied.status()
                        + " failure=" + denied.failure());
                assertThat(denied.status()).isIn(ToolExecutionStatus.FAILED, ToolExecutionStatus.DENIED);
                assertThat(String.valueOf(denied.failure())).contains("MEDIA_");

                // ---- the registered source: transcription + vision, both real, fused ----
                ToolExecutionResult result = runTool(factory, caller, "av.multimodal-inference", Map.of(
                        "mediaArtifactId", source.artifactId(), "languageCode", "en-US",
                        "enableTranscription", true, "enableVisionAnalysis", true,
                        "sourceArtifactVersion", source.version().value()));
                assertThat(result.status()).as("multimodal tool result: %s / %s", result.status(), result.failure())
                        .isEqualTo(ToolExecutionStatus.SUCCESS);
                @SuppressWarnings("unchecked") Map<String, Object> out = (Map<String, Object>) result.output();
                assertThat(out).containsEntry("status", "COMPLETED").containsEntry("jobType", "MULTIMODAL");
                String fused = String.valueOf(out.get("result"));
                System.out.println("LOCAL_MULTIMODAL_CANONICAL_FUSED result=" + fused);
                String normalized = fused.toLowerCase(Locale.ROOT);
                for (String word : List.of("quick", "brown", "fox", "lazy", "dog")) {
                    assertThat(normalized).as("fused result must carry the Whisper transcript: %s", fused)
                            .contains(word);
                }
                assertThat(normalized).as("fused result must carry the Florence reading of the frame: %s", fused)
                        .contains("ghatana");
                // Both canonical children exist, completed, and ran under their own admitted providers.
                var sttChild = jobStore.findByRequest(TENANT, out.get("requestId") + ":stt").orElseThrow();
                var visionChild = jobStore.findByRequest(TENANT, out.get("requestId") + ":vision").orElseThrow();
                assertThat(sttChild.status().name()).isEqualTo("COMPLETED");
                assertThat(sttChild.providerId()).isEqualTo(LocalWhisperCppSttProvider.PROVIDER_ID);
                assertThat(visionChild.status().name()).isEqualTo("COMPLETED");
                assertThat(visionChild.providerId())
                        .isEqualTo(com.ghatana.audio.video.vision.local.LocalOpenModelVisionProvider.PROVIDER_ID);
                assertThat(sttChild.expectedArtifactVersion()).isEqualTo(source.version().value());
                assertThat(visionChild.expectedArtifactVersion()).isEqualTo(source.version().value());
            }
        }
    }

    /** One still frame of rendered text plus the spoken clip, muxed into a small H.264/AAC MP4 through FFmpeg. */
    private static byte[] buildMp4(Path ffmpeg, byte[] speechWav) throws Exception {
        Path work = Files.createTempDirectory("media-mm-source-");
        java.awt.image.BufferedImage image = new java.awt.image.BufferedImage(640, 360,
                java.awt.image.BufferedImage.TYPE_INT_RGB);
        java.awt.Graphics2D g = image.createGraphics();
        g.setColor(java.awt.Color.WHITE);
        g.fillRect(0, 0, 640, 360);
        g.setColor(java.awt.Color.BLACK);
        g.setFont(new java.awt.Font(java.awt.Font.SANS_SERIF, java.awt.Font.BOLD, 96));
        g.drawString("GHATANA", 60, 210);
        g.dispose();
        javax.imageio.ImageIO.write(image, "png", work.resolve("frame.png").toFile());
        Files.write(work.resolve("speech.wav"), speechWav);
        Process process = new ProcessBuilder(ffmpeg.toString(), "-nostdin", "-v", "error", "-y", "-loop", "1",
                "-framerate", "5", "-i", work.resolve("frame.png").toString(), "-i", work.resolve("speech.wav").toString(),
                "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k",
                "-shortest", "-movflags", "+faststart", work.resolve("talk.mp4").toString())
                .redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD).start();
        assertThat(process.waitFor(2, java.util.concurrent.TimeUnit.MINUTES)).isTrue();
        assertThat(process.exitValue()).as("ffmpeg must build the fixture mp4").isZero();
        return Files.readAllBytes(work.resolve("talk.mp4"));
    }

    // ---- helpers ----

    private ToolExecutionResult runTool(AudioVideoToolHandlerFactory factory,
                                        MediaSourceAuthorizationContracts.AuthenticatedPrincipal caller,
                                        String toolId, Map<String, Object> input) {
        ToolExecutionEnvelope envelope = ToolExecutionEnvelope.of(toolId, "1.0.0", PRINCIPAL, null, TENANT,
                ToolActionClass.CALL_EXTERNAL, "1.0", input);
        ToolContract contract = new ToolContract(toolId, "1.0.0", "test", "test", envelope.actionClass(), false, true,
                Map.of(), Map.of(), Set.of(), ToolTransport.IN_PROCESS, null, Map.of());
        return runPromise(() -> factory.createAuthenticated(toolId).handle(envelope, contract, caller),
                Duration.ofMinutes(6));
    }

    private static final class MemoryLedger implements InvocationLedger {
        private final Map<String, LogicalAction> actions = new HashMap<>();
        @Override public synchronized Optional<LogicalAction> find(String id) { return Optional.ofNullable(actions.get(id)); }
        @Override public synchronized void record(LogicalAction action) { actions.put(action.invocationId(), action); }
        @Override public synchronized ClaimResult claim(LogicalAction fence) {
            return actions.putIfAbsent(fence.invocationId(), fence) == null ? ClaimResult.CLAIMED
                    : ClaimResult.ALREADY_CLAIMED;
        }
        @Override public synchronized boolean complete(LogicalAction terminal) {
            actions.put(terminal.invocationId(), terminal);
            return true;
        }
    }

    /** Host-owned purpose for the speech-to-text tool; the rights fixture below allows exactly this purpose. */
    private static com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext governance() {
        return new com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext("", "transcription",
                com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification.CONFIDENTIAL, "local",
                Set.of("local"), false, "short-lived-media", false, false, "",
                com.ghatana.media.runtime.MediaRuntimeContracts.BiometricSensitivity.NONE,
                com.ghatana.media.runtime.MediaRuntimeContracts.AutomationRisk.ASSISTIVE);
    }

    private static String sha(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static MediaArtifact upload(MediaRuntime runtime, byte[] wav, String wavSha, int samples, String key)
            throws Exception {
        var upload = runtime.beginUpload(new UploadRequest(TENANT, PRINCIPAL, "speech.wav", "audio/wav", wav.length,
                wavSha, "CONFIDENTIAL", Duration.ofMinutes(30), Map.of("sourceClockId", "fixture-clock",
                "sourceClockMappingEvidenceRef", "fixture-clock-evidence", "sourceClockTicksPerSecond", 1,
                "sourceDurationTicks", samples)), key);
        runtime.appendChunk(TENANT, PRINCIPAL, upload.uploadId(), 0, wav);
        return runtime.completeUpload(TENANT, PRINCIPAL, upload.uploadId());
    }

    /** Mirrors the artifact store's durable admission record for the fixture upload (as the existing STT IT does). */
    private static void seedArtifactRow(MediaArtifact artifact, int samples) throws Exception {
        seedArtifactRow(artifact, "{\"sourceClockId\":\"fixture-clock\","
                + "\"sourceClockMappingEvidenceRef\":\"fixture-clock-evidence\","
                + "\"sourceClockTicksPerSecond\":1,\"sourceDurationTicks\":" + samples + "}");
    }

    private static void seedArtifactRow(MediaArtifact artifact, String metadataJson) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "INSERT INTO media_artifacts (tenant_id,artifact_id,principal_id,file_name,"
                             + "content_type,size_bytes,sha256,object_reference,classification,"
                             + "created_at,expires_at,metadata_json,scan_status,"
                             + "scan_policy_version,scanner_id,scanned_at) "
                             + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'CLEAN',?,?,?) ON CONFLICT DO NOTHING")) {
            statement.setString(1, artifact.tenantId());
            statement.setString(2, artifact.artifactId());
            statement.setString(3, artifact.principalId());
            statement.setString(4, artifact.fileName());
            statement.setString(5, artifact.contentType());
            statement.setLong(6, artifact.sizeBytes());
            statement.setString(7, artifact.sha256());
            statement.setString(8, artifact.objectReference());
            statement.setString(9, artifact.classification());
            statement.setLong(10, artifact.createdAt().toEpochMilli());
            statement.setLong(11, artifact.expiresAt().toEpochMilli());
            statement.setString(12, metadataJson);
            statement.setString(13, "fixture-scan-policy/v1");
            statement.setString(14, "fixture-scanner/v1");
            statement.setLong(15, Instant.now().toEpochMilli());
            statement.executeUpdate();
        }
    }

    private static Map<String, String> environment() {
        Map<String, String> env = new HashMap<>();
        env.put("MEDIA_RUNTIME_ENABLED", "true");
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "integration");
        env.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        env.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_E2E_DB_PASSWORD");
        env.put("MEDIA_E2E_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        env.put("MEDIA_S3_BUCKET", "media-e2e-speech");
        env.put("MEDIA_S3_REGION", "us-east-1");
        env.put("MEDIA_S3_ENDPOINT", stubUrl);
        env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_E2E_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_E2E_SECRET");
        env.put("MEDIA_E2E_ACCESS", "e2e-access");
        env.put("MEDIA_E2E_SECRET", "e2e-secret");
        return env;
    }

    /** TEST FIXTURE: deterministic ALLOW decision for the source-rights authority under test. */
    private static final class AllowPolicy implements PolicyEngine {
        @Override public CompletionStage<PolicyDecisionRecord> evaluate(
                com.ghatana.governance.PolicyEvaluationRequest request) {
            PolicyEvaluationContext context = new PolicyEvaluationContext(
                    request.principalId(), request.tenantId(), request.actionClass(),
                    request.targetType(), request.targetId(), request.toolId(),
                    request.criticality(), request.reversibility(), request.attributes(),
                    Instant.now(), request.correlationId(), request.verifiedContext());
            return CompletableFuture.completedFuture(new PolicyDecisionRecord(
                    "policy-decision-e2e", PolicyDecisionOutcome.ALLOW,
                    List.of("policy-v1:rule-allow-media"), List.of("rule-allow-media"),
                    List.of("e2e policy evaluation"), context, Instant.now(), null,
                    "policy-v1", List.of(PolicyReasonCode.POLICY_ALLOWED)));
        }
        @Override public CompletionStage<Boolean> policyExists(String policyId) {
            return CompletableFuture.completedFuture("policy-v1".equals(policyId));
        }
        @Override public CompletionStage<Boolean> policyExists(String policyId, String version) { return policyExists(policyId); }
        @Override public boolean isOpen() { return true; }
        @Override public void close() { }
        @Override public com.ghatana.governance.PolicyEngineLifecycle.State lifecycleState() {
            return com.ghatana.governance.PolicyEngineLifecycle.State.OPEN;
        }
        @Override public long inFlightEvaluations() { return 0; }
        @Override public com.ghatana.governance.PolicyEngineLifecycle.Result drain(Duration timeout) {
            return new com.ghatana.governance.PolicyEngineLifecycle.Result(
                    com.ghatana.governance.PolicyEngineLifecycle.State.DRAINED, 0);
        }
        @Override public com.ghatana.governance.PolicyEngineLifecycle.Result close(Duration timeout) {
            return new com.ghatana.governance.PolicyEngineLifecycle.Result(
                    com.ghatana.governance.PolicyEngineLifecycle.State.CLOSED, 0);
        }
    }
}
