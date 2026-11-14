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
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * Real launcher process (PostgreSQL + S3) with the REAL local speech models: Kokoro synthesizes through the DEV lane,
 * Whisper transcribes the registered version only after a REAL attestation made through the /dev/v1/rights routes by
 * a synthetic TEST principal, and a revoked attestation withdraws the admission again (also after a restart). No
 * stubbed rights resolver is involved; the statements prove the code path, not any real person's rights.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevLocalSpeechRightsIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private static final String SENTENCE = "The quick brown fox jumps over the lazy dog.";

    @Test
    void realAttestationAdmitsWhisperOnTheExactVersionAndRevocationWithdrawsItAcrossRestart() throws Exception {
        Path root = Path.of(System.getProperty("user.home"), ".local", "share", "ghatana-media");
        Path script = Path.of(System.getProperty("user.dir")).toAbsolutePath().resolve("tools/model-runtimes/kokoro_synth.py");
        Path searchRoot = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (!Files.isRegularFile(script) && searchRoot.getParent() != null) {
            searchRoot = searchRoot.getParent();
            script = searchRoot.resolve("tools/model-runtimes/kokoro_synth.py");
        }
        Map<String, String> speech = Map.of("MEDIA_LOCAL_MODEL_ROOT", root.toString(),
                "MEDIA_WHISPER_CPP_BIN", root.resolve("runtimes/whisper.cpp-src/build/bin/whisper-cli").toString(),
                "MEDIA_KOKORO_PYTHON", root.resolve("runtimes/kokoro-venv/bin/python").toString(),
                "MEDIA_KOKORO_SCRIPT", script.toString(), "MEDIA_WHISPER_CPP_THREADS", "8");
        var tts = LocalKokoroTtsProvider.fromEnvironment(speech);
        assumeTrue(tts.ready() && com.ghatana.stt.provider.LocalWhisperCppSttProvider
                        .fromEnvironment(speech).ready(),
                "local Whisper/Kokoro runtimes with verified manifests are not installed on this host");

        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-speech-" + run;
        String owner = "test-principal-owner-" + run;
        String bucket = "media-dev-speech-" + run;
        String schema = "media_dev_speech_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-speech-services-");
        Path log = Files.createTempFile("media-dev-speech-process-", ".log");
        Process launcher = null;
        try {
            try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
            environment.putAll(speech);
            String token = issueDevToken(tenant, owner);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            // text -> audio artifact through the DEV lane (stock voice; no media-rights statement is required).
            JsonNode capabilities = get(port, tenant, token, "/dev/v1/speech/capabilities", 200);
            assertThat(capabilities.path("speechToText").path("ready").asBoolean()).isTrue();
            assertThat(capabilities.path("textToSpeech").path("ready").asBoolean()).isTrue();
            JsonNode synth = post(port, tenant, token, "/dev/v1/speech/syntheses",
                    Map.of("requestId", "speech-tts-" + run, "text", SENTENCE, "voice", "af_heart"), 201);
            String clipId = synth.path("artifact").path("artifactId").asString();
            String clipVersion = synth.path("artifact").path("artifactVersionId").asString();
            assertThat(synth.path("artifact").path("contentType").asString()).isEqualTo("audio/wav");

            // No attestation: the exact version is refused with the matching admission reason; nothing registered.
            Map<String, Object> transcribe = Map.of("requestId", "speech-stt-" + run, "artifactId", clipId,
                    "artifactVersionId", clipVersion, "language", "en");
            HttpResponse<String> refused = send(port, tenant, token, "POST", "/dev/v1/speech/transcriptions",
                    JSON.writeValueAsString(transcribe));
            assertThat(refused.statusCode()).as(refused.body()).isEqualTo(403);
            assertThat(refused.body()).contains("RIGHTS_DECISION_DENIED");

            // A REAL attestation by the owner principal for PROCESSING on the exact version.
            JsonNode attested = post(port, tenant, token, "/dev/v1/rights/attestations", Map.of(
                    "artifactId", clipId, "artifactVersionId", clipVersion, "statementKind", "MEDIA_RIGHTS",
                    "scopes", List.of("PROCESSING"),
                    "basis", "TEST: synthetic Kokoro clip generated by the test, no real person or rights"), 201);
            String attestationId = attested.path("attestationId").asString();

            JsonNode stt = post(port, tenant, token, "/dev/v1/speech/transcriptions", transcribe, 201);
            String text = stt.path("text").asString();
            System.out.println("LOCAL_SPEECH_REAL_STORE_ROUND_TRIP input=\"" + SENTENCE + "\" transcript=\"" + text + "\"");
            String normalized = text.toLowerCase(Locale.ROOT).replaceAll("[^a-z ]", " ");
            for (String word : List.of("quick", "brown", "fox", "jumps", "lazy", "dog")) {
                assertThat(normalized).as(text).contains(word);
            }
            assertThat(stt.path("captions").path("artifact").path("contentType").asString()).isEqualTo("text/vtt");
            assertThat(stt.path("transcript").path("lineage").path("rightsDecision").asString())
                    .contains(attestationId);

            // Revocation withdraws the admission; a restart keeps it withdrawn.
            post(port, tenant, token, "/dev/v1/rights/attestations/" + attestationId + "/revoke",
                    Map.of("reason", "TEST: revoked"), 200);
            stopLauncher(launcher);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            token = issueDevToken(tenant, owner);
            HttpResponse<String> after = send(port, tenant, token, "POST", "/dev/v1/speech/transcriptions",
                    JSON.writeValueAsString(Map.of("requestId", "speech-stt-after-" + run, "artifactId", clipId,
                            "artifactVersionId", clipVersion, "language", "en")));
            assertThat(after.statusCode()).as(after.body()).isEqualTo(403);
            assertThat(after.body()).contains("RIGHTS_DECISION_REVOKED");
            // The registered audio artifact is durable across the restart.
            assertThat(get(port, tenant, token, "/dev/v1/speech/outputs/" + clipId, 200)
                    .path("lineage").path("kind").asString()).isEqualTo("LOCAL_TTS_AUDIO");
        } finally {
            if (launcher != null) stopLauncher(launcher);
            deleteBucket(LOCALSTACK, bucket);
            dropSchema(POSTGRES, schema);
            deleteTree(services);
        }
    }
}
