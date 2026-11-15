package com.ghatana.media.integration;

import com.ghatana.stt.provider.LocalWhisperCppSttProvider;
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
import java.util.Map;
import java.util.UUID;

import static com.ghatana.media.integration.MediaDevAudioSupport.*;
import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-07 real denoise/declip measured A/B with source preservation, through a real launcher process (PostgreSQL + S3).
 *
 * <p>Real Kokoro-82M synthesizes clean speech; the test then adds KNOWN degradations (white noise at a set SNR, a 50 Hz
 * hum with its 100 Hz harmonic, hard clipping) and registers the result as the source artifact. The lane restores it
 * with FFmpeg and compares source, restored and the clean reference: SNR, segmental SNR, clipped samples, noise-floor
 * level and flatness, and a real Whisper (GPU) transcript diff against the clean transcript. The reported numbers are
 * re-derived here from independently decoded bytes. The source bytes and version are asserted unchanged. A restoration
 * that only changes the level (loudness normalization) must NOT be reported as an improvement. Principals and rights
 * statements are clearly synthetic TEST identities.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevAudioRestorationJourneyIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private static final String TEXT = "The quick brown fox jumps over the lazy dog. "
            + "Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump.";
    private static final double NOISE_SNR_DB = 12.0;
    private static final double HUM_AMPLITUDE = 330.0;
    private static final double CLIP_FRACTION = 0.6;

    private static Map<String, String> speechEnvironment() {
        Path root = modelRoot();
        Map<String, String> speech = new HashMap<>(kokoroEnvironment(root));
        speech.put("MEDIA_WHISPER_CPP_BIN", root.resolve("runtimes/whisper.cpp-src/build-vulkan/bin/whisper-cli").toString());
        speech.put("MEDIA_WHISPER_CPP_THREADS", "8");
        speech.put("MEDIA_KOKORO_WORKER", "true");
        return speech;
    }

    private static JsonNode restoration(int port, String tenant, String token, String requestId, String artifactId,
                                        String version, Map<String, Object> operations, int status) throws Exception {
        return post(port, tenant, token, "/dev/v1/audio/restorations", Map.of("requestId", requestId,
                "artifactId", artifactId, "artifactVersionId", version, "operations", operations), status);
    }

    private static Map<String, Object> ref(String artifactId, String version) {
        return Map.of("artifactId", artifactId, "artifactVersionId", version);
    }

    @Test
    void degradedKokoroSpeechIsRestoredAndMeasuredAgainstTheCleanReferenceWithSourcePreserved() throws Exception {
        Map<String, String> speech = speechEnvironment();
        assumeTrue(LocalKokoroTtsProvider.fromEnvironment(speech).ready()
                        && LocalWhisperCppSttProvider.fromEnvironment(speech).ready(),
                "the verified local Kokoro-82M and Whisper installs are required");
        assumeTrue(ffmpeg() != null && ffprobe() != null, "FFmpeg/FFprobe tool paths are required");
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-audio-" + run;
        String owner = "test-principal-owner-" + run;
        String bucket = "media-dev-audio-" + run.substring(0, 12);
        String schema = "media_dev_audio_" + run.substring(0, 12);
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-audio-services-");
        Path log = Files.createTempFile("media-dev-audio-process-", ".log");
        Process launcher = null;
        boolean passed = false;
        try {
            try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
            environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg());
            environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe());
            environment.putAll(speech);
            String token = issueDevToken(tenant, owner);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            JsonNode status = get(port, tenant, token, "/dev/v1/audio/status", 200);
            assertThat(status.path("engine").path("ready").asBoolean()).isTrue();
            assertThat(status.path("engine").path("version").asString()).startsWith("ffmpeg version 7.0");
            assertThat(status.path("transcriptDiff").path("ready").asBoolean()).isTrue();

            // ---- 1. real clean speech (Kokoro-82M) is the clean reference ----
            JsonNode synthesized = post(port, tenant, token, "/dev/v1/speech/syntheses",
                    Map.of("requestId", "j07-clean-" + run, "text", TEXT, "voice", "am_michael", "locale", "en"), 201);
            String cleanId = synthesized.path("artifact").path("artifactId").asString();
            String cleanVersion = synthesized.path("artifact").path("artifactVersionId").asString();
            byte[] cleanBytes = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, owner, cleanId));
            Wav clean = decodeWithFfmpeg(cleanBytes);
            assertThat(clean.samples().length / (double) clean.sampleRate()).isGreaterThan(8.0);

            // ---- 2. known degradations -> the source artifact (a separate uploaded version) ----
            short[] degradedSamples = degrade(clean.samples(), clean.sampleRate(), NOISE_SNR_DB, HUM_AMPLITUDE,
                    CLIP_FRACTION, 20261114L);
            byte[] degradedBytes = wav(clean.sampleRate(), degradedSamples);
            String sourceId = upload(port, tenant, owner, token, "j07-degraded-" + run, "degraded.wav", "audio/wav", degradedBytes);
            String sourceVersion = "sha256:" + sha256(degradedBytes);
            double sourceSnrIndependent = snrDb(degradedSamples, clean.samples());
            int sourceClippedIndependent = clippedSamples(degradedSamples);
            System.out.printf("J07_DEGRADED noiseSnrDb=%.1f humAmp=%.0f clipFraction=%.2f -> snrVsClean=%.2f dB clippedSamples=%d%n",
                    NOISE_SNR_DB, HUM_AMPLITUDE, CLIP_FRACTION, sourceSnrIndependent, sourceClippedIndependent);
            assertThat(sourceClippedIndependent).as("the degraded source really is hard clipped").isGreaterThan(100);

            // ---- 3. rights: no attestation -> nothing processed; then a REAL attestation for source and reference ----
            Map<String, Object> primaryOps = Map.of("declip", Map.of("threshold", 10), "dehum", Map.of("frequencyHz", 50),
                    "denoise", Map.of("reductionDb", 20, "noiseFloorDb", -40, "trackNoise", true));
            HttpResponse<String> notYet = send(port, tenant, token, "POST", "/dev/v1/audio/restorations",
                    JSON.writeValueAsString(Map.of("requestId", "j07-norights-" + run, "artifactId", sourceId,
                            "artifactVersionId", sourceVersion, "operations", primaryOps)));
            assertThat(notYet.statusCode()).as(notYet.body()).isEqualTo(403);
            assertThat(notYet.body()).contains("RIGHTS_DECISION_DENIED");
            for (String[] target : new String[][] {{sourceId, sourceVersion}, {cleanId, cleanVersion}}) {
                post(port, tenant, token, "/dev/v1/rights/attestations", Map.of("artifactId", target[0],
                        "artifactVersionId", target[1], "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                        "basis", "TEST: synthetic Kokoro clip and its test-generated degradation; no real person or rights"), 201);
            }

            // ---- 4. restore: new immutable version with full lineage; the source is untouched ----
            JsonNode restored = restoration(port, tenant, token, "j07-restore-" + run, sourceId, sourceVersion, primaryOps, 201);
            String restoredId = restored.path("outputId").asString();
            String restoredVersion = restored.path("artifact").path("artifactVersionId").asString();
            assertThat(restoredId).isNotEqualTo(sourceId);
            assertThat(restored.path("artifact").path("contentType").asString()).isEqualTo("audio/wav");
            JsonNode lineage = restored.path("lineage");
            assertThat(lineage.path("source").path("sha256").asString()).isEqualTo(sha256(degradedBytes));
            assertThat(lineage.path("source").path("artifactVersionId").asString()).isEqualTo(sourceVersion);
            String graph = lineage.path("filterGraph").asString();
            System.out.println("J07_FILTER_GRAPH " + graph);
            assertThat(graph).contains("adeclip=threshold=10", "bandreject=f=50", "bandreject=f=100", "bandreject=f=150",
                    "afftdn=nr=20.0:nf=-40.0:tn=1").doesNotContain("loudnorm");
            assertThat(lineage.path("operations").path("normalize").path("enabled").asBoolean()).isFalse();
            assertThat(lineage.path("engine").path("version").asString()).startsWith("ffmpeg version 7.0");
            assertThat(lineage.path("engine").path("binarySha256").asString()).matches("[0-9a-f]{64}");
            assertThat(lineage.path("rightsDecision").asString()).startsWith("rights-attestation:");
            byte[] restoredBytes = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, owner, restoredId));
            assertThat(sha256(restoredBytes)).isEqualTo(restored.path("artifact").path("sha256").asString());
            assertThat(restoredVersion).isEqualTo("sha256:" + sha256(restoredBytes));
            assertThat(restoredBytes).isNotEqualTo(degradedBytes);
            Wav restoredWav = decodeWithFfmpeg(restoredBytes);
            assertThat(restoredWav.sampleRate()).isEqualTo(clean.sampleRate());
            assertThat(restoredWav.samples().length).as("restored keeps the exact frame count").isEqualTo(clean.samples().length);
            assertThat(probe(restoredBytes, "wav").path("streams").get(0).path("codec_name").asString()).isEqualTo("pcm_s16le");
            // source preservation: the stored source bytes are byte-identical and its version did not change
            assertThat(s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, owner, sourceId))).isEqualTo(degradedBytes);
            assertThat(storedArtifact(POSTGRES, tenant, owner, sourceId).sha256()).isEqualTo(sha256(degradedBytes));

            // ---- 5. measured comparison against the clean reference, with a real Whisper transcript diff ----
            Map<String, Object> compareBody = Map.of("requestId", "j07-compare-" + run, "source", ref(sourceId, sourceVersion),
                    "restored", ref(restoredId, restoredVersion), "reference", ref(cleanId, cleanVersion),
                    "transcript", Map.of("language", "en", "referenceText", TEXT));
            JsonNode comparison = post(port, tenant, token, "/dev/v1/audio/comparisons", compareBody, 201);
            JsonNode report = comparison.path("report");
            JsonNode sourceSide = report.path("metrics").path("source");
            JsonNode restoredSide = report.path("metrics").path("restored");
            JsonNode delta = report.path("metrics").path("delta");
            System.out.println("J07_COMPARISON " + report.path("metrics") + " verdict=" + report.path("verdict")
                    + " transcript=" + report.path("transcript"));
            // the reported numbers equal an independent computation from independently decoded bytes
            assertThat(sourceSide.path("snrDb").asDouble()).isCloseTo(sourceSnrIndependent, org.assertj.core.data.Offset.offset(0.01));
            assertThat(restoredSide.path("snrDb").asDouble()).isCloseTo(snrDb(restoredWav.samples(), clean.samples()),
                    org.assertj.core.data.Offset.offset(0.01));
            assertThat(sourceSide.path("clippedSamples").asInt()).isEqualTo(sourceClippedIndependent);
            assertThat(restoredSide.path("clippedSamples").asInt()).isEqualTo(clippedSamples(restoredWav.samples()));
            // direction and magnitude of the measured improvement (thresholds are conservative fractions of the observed run)
            assertThat(delta.path("snrDb").asDouble()).as("SNR vs clean improved").isGreaterThanOrEqualTo(1.0);
            assertThat(delta.path("segmentalSnrDb").asDouble()).as("segmental SNR vs clean improved").isGreaterThanOrEqualTo(1.0);
            assertThat(restoredSide.path("clippedSamples").asInt()).as("clipped samples before -> after")
                    .isLessThanOrEqualTo(sourceSide.path("clippedSamples").asInt() / 10);
            assertThat(delta.path("noiseFloorDbfs").asDouble()).as("noise-floor level dropped").isLessThanOrEqualTo(-3.0);
            assertThat(sourceSide.path("noiseFloor").path("spectralFlatness").asDouble()).isBetween(0.0, 1.0);
            assertThat(report.path("verdict").path("overall").asString()).isEqualTo("IMPROVED");
            assertThat(report.path("verdict").path("clipping").asString()).isEqualTo("REDUCED");
            JsonNode transcript = report.path("transcript");
            assertThat(transcript.path("status").asString()).isEqualTo("MEASURED");
            assertThat(transcript.path("restoredWordErrorRate").asDouble()).as("intelligibility did not regress")
                    .isLessThanOrEqualTo(transcript.path("sourceWordErrorRate").asDouble());
            assertThat(transcript.path("intelligibility").asString()).isIn("IMPROVED", "UNCHANGED");
            assertThat(transcript.path("restoredWordErrorRate").asDouble()).isLessThanOrEqualTo(0.2);
            JsonNode referenceSide = report.path("metrics").path("reference");
            assertThat(referenceSide.path("clippedSamples").asInt()).isZero();
            String comparisonId = comparison.path("outputId").asString();

            // ---- 6. honesty control: a level-only change (loudness normalization) is not an improvement ----
            JsonNode loud = restoration(port, tenant, token, "j07-loud-" + run, sourceId, sourceVersion,
                    Map.of("normalize", Map.of("targetLufs", -10)), 201);
            assertThat(loud.path("lineage").path("filterGraph").asString()).contains("loudnorm=I=-10.0");
            JsonNode loudComparison = post(port, tenant, token, "/dev/v1/audio/comparisons", Map.of(
                    "requestId", "j07-compare-loud-" + run, "source", ref(sourceId, sourceVersion),
                    "restored", ref(loud.path("outputId").asString(), loud.path("artifact").path("artifactVersionId").asString()),
                    "reference", ref(cleanId, cleanVersion)), 201).path("report");
            System.out.println("J07_NORMALIZE_ONLY deltaSnr=" + loudComparison.path("metrics").path("delta").path("snrDb")
                    + " verdict=" + loudComparison.path("verdict"));
            assertThat(loudComparison.path("verdict").path("overall").asString()).isNotEqualTo("IMPROVED");
            assertThat(loudComparison.path("metrics").path("delta").path("snrDb").asDouble()).isLessThan(0.5);
            assertThat(loudComparison.path("transcript").path("status").asString()).isEqualTo("NOT_REQUESTED");

            // ---- 7. a comparison without a reference reports descriptive numbers and claims no improvement ----
            JsonNode noReference = post(port, tenant, token, "/dev/v1/audio/comparisons", Map.of(
                    "requestId", "j07-compare-noref-" + run, "source", ref(sourceId, sourceVersion),
                    "restored", ref(restoredId, restoredVersion)), 201).path("report");
            assertThat(noReference.path("verdict").path("overall").asString()).isEqualTo("NOT_MEASURED_AGAINST_REFERENCE");
            assertThat(noReference.path("metrics").path("source").path("snrDb").isNull()).isTrue();
            assertThat(noReference.path("metrics").path("delta").path("snrDb").isNull()).isTrue();

            // ---- 8. a different recording cannot be passed off as the restoration of this source ----
            HttpResponse<String> lineageMismatch = send(port, tenant, token, "POST", "/dev/v1/audio/comparisons",
                    JSON.writeValueAsString(Map.of("requestId", "j07-compare-lineage-" + run, "source", ref(sourceId, sourceVersion),
                            "restored", ref(cleanId, cleanVersion))));
            assertThat(lineageMismatch.statusCode()).as(lineageMismatch.body()).isEqualTo(422);
            assertThat(lineageMismatch.body()).contains("COMPARISON_LINEAGE_MISMATCH");

            // ---- 9. idempotency: same requestId replays; a different request under it is refused ----
            int wavCount = countArtifacts(POSTGRES, tenant, owner, "audio/wav");
            JsonNode replay = restoration(port, tenant, token, "j07-restore-" + run, sourceId, sourceVersion, primaryOps, 200);
            assertThat(replay.path("replayed").asBoolean()).isTrue();
            assertThat(replay.path("outputId").asString()).isEqualTo(restoredId);
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).isEqualTo(wavCount);
            HttpResponse<String> reused = send(port, tenant, token, "POST", "/dev/v1/audio/restorations", JSON.writeValueAsString(
                    Map.of("requestId", "j07-restore-" + run, "artifactId", sourceId, "artifactVersionId", sourceVersion,
                            "operations", Map.of("dehum", Map.of("frequencyHz", 60)))));
            assertThat(reused.statusCode()).as(reused.body()).isEqualTo(409);
            assertThat(reused.body()).contains("AUDIO_REQUEST_ID_REUSED");

            // ---- 10. restart: reopen both outputs byte-for-byte with their lineage, and replay ----
            stopLauncher(launcher);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            token = issueDevToken(tenant, owner);
            JsonNode reopened = get(port, tenant, token, "/dev/v1/audio/outputs/" + restoredId, 200);
            assertThat(reopened.path("kind").asString()).isEqualTo("RESTORATION");
            assertThat(reopened.path("artifact").path("sha256").asString()).isEqualTo(sha256(restoredBytes));
            assertThat(reopened.path("lineage").path("filterGraph").asString()).isEqualTo(graph);
            JsonNode reopenedComparison = get(port, tenant, token, "/dev/v1/audio/outputs/" + comparisonId, 200);
            assertThat(reopenedComparison.path("report").path("metrics")).isEqualTo(report.path("metrics"));
            assertThat(reopenedComparison.path("report").path("verdict")).isEqualTo(report.path("verdict"));
            assertThat(reopenedComparison.path("report").path("transcript")).isEqualTo(report.path("transcript"));
            assertThat(restoration(port, tenant, token, "j07-restore-" + run, sourceId, sourceVersion, primaryOps, 200)
                    .path("outputId").asString()).isEqualTo(restoredId);
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).isEqualTo(wavCount);
            // a foreign principal can neither see nor restore the owner's audio
            String foreign = issueDevToken(tenant, "test-principal-foreign-" + run);
            assertThat(send(port, tenant, foreign, "GET", "/dev/v1/audio/outputs/" + restoredId, null).statusCode()).isEqualTo(404);
            assertThat(send(port, tenant, foreign, "POST", "/dev/v1/audio/restorations", JSON.writeValueAsString(Map.of(
                    "requestId", "j07-foreign-" + run, "artifactId", sourceId, "artifactVersionId", sourceVersion,
                    "operations", primaryOps))).statusCode()).isEqualTo(404);
            passed = true;
        } finally {
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            deleteTree(services);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("J-07 journey failure log retained at " + log);
        }
    }
}
