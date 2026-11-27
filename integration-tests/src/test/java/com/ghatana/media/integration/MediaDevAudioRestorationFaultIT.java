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

import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevAudioSupport.*;
import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-07 fault suite against a real launcher process (PostgreSQL + S3) and the REAL FFmpeg: invalid parameters refused
 * before any processing, rights missing/revoked (a replay included), stale and foreign versions, the real FFmpeg process
 * SIGKILLed mid-run (outcome UNKNOWN, then exactly one registration on retry), the launcher itself SIGKILLed mid-run
 * (dead-owner reclaim, one registration), the wall-clock deadline, and restart readback. The configured FFmpeg is a
 * wrapper that logs each filter-graph invocation (so "nothing ran" is observable) and execs the real binary. Audio is a
 * clearly synthetic tone-plus-noise clip; principals and statements are TEST identities.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevAudioRestorationFaultIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private static final Map<String, Object> OPS = Map.of("declip", Map.of("threshold", 10),
            "dehum", Map.of("frequencyHz", 50), "denoise", Map.of("reductionDb", 12, "noiseFloorDb", -50, "trackNoise", true));

    private static Map<String, Object> body(String requestId, String artifactId, String version, Object operations) {
        Map<String, Object> body = new HashMap<>();
        body.put("requestId", requestId);
        body.put("artifactId", artifactId);
        body.put("artifactVersionId", version);
        if (operations != null) body.put("operations", operations);
        return body;
    }

    private static HttpResponse<String> restore(int port, String tenant, String token, Map<String, Object> body) throws Exception {
        return send(port, tenant, token, "POST", "/dev/v1/audio/restorations", JSON.writeValueAsString(body));
    }

    private static String code(HttpResponse<String> response) throws Exception {
        return JSON.readTree(response.body()).path("error").path("code").asString();
    }

    @Test
    void faultsLeaveExactlyTheRightRegistrationsAndNeverRunTheEngineWhenRefused() throws Exception {
        assumeTrue(ffmpeg() != null && ffprobe() != null, "FFmpeg/FFprobe tool paths are required");
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-audio-fault-" + run;
        String owner = "test-principal-owner-" + run;
        String bucket = "media-dev-audio-fault-" + run.substring(0, 12);
        String schema = "media_dev_audio_fault_" + run.substring(0, 12);
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-audio-fault-services-");
        Path markers = Files.createTempDirectory("media-dev-audio-fault-markers-");
        Path log = Files.createTempFile("media-dev-audio-fault-process-", ".log");
        Process launcher = null;
        boolean passed = false;
        try {
            try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Path wrapper = ffmpegWrapper(markers);
            Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
            environment.put("MEDIA_DEV_RENDER_FFMPEG", wrapper.toString());
            environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe());
            environment.put("MEDIA_DEV_AUDIO_RESTORE_TIMEOUT_SECONDS", "60");
            String token = issueDevToken(tenant, owner);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            byte[] sourceBytes = wav(24_000, syntheticClip(24_000, 6.0, 7L));
            String sourceId = upload(port, tenant, owner, token, "j07-fault-source-" + run, "source.wav", "audio/wav", sourceBytes);
            String version = "sha256:" + sha256(sourceBytes);
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).isEqualTo(1);

            // ---- invalid parameters are refused before any rights call, source read or engine start ----
            List<Object> invalidOperations = new ArrayList<>();
            invalidOperations.add(Map.of());
            invalidOperations.add(Map.of("denoise", Map.of("reductionDb", 99)));
            invalidOperations.add(Map.of("denoise", Map.of("noiseFloorDb", -5)));
            invalidOperations.add(Map.of("declip", Map.of("threshold", 0)));
            invalidOperations.add(Map.of("dehum", Map.of("frequencyHz", 55)));
            invalidOperations.add(Map.of("normalize", Map.of("targetLufs", -5)));
            invalidOperations.add(Map.of("reverb", Map.of("amount", 1)));
            invalidOperations.add(Map.of("denoise", Map.of("reductionDb", "12")));
            invalidOperations.add(Map.of("dehum", Map.of()));
            invalidOperations.add(Map.of("declip", Map.of("threshold", 10.5)));
            invalidOperations.add(Map.of("denoise", Map.of("trackNoise", "yes")));
            invalidOperations.add("denoise");
            int index = 0;
            for (Object operations : invalidOperations) {
                HttpResponse<String> refused = restore(port, tenant, token, body("j07-invalid-" + index++ + "-" + run, sourceId, version, operations));
                assertThat(refused.statusCode()).as(operations + " -> " + refused.body()).isBetween(400, 422);
                assertThat(refused.statusCode()).isNotEqualTo(403); // never reached the rights check
            }
            Map<String, Object> unknownField = body("j07-extra-" + run, sourceId, version, OPS);
            unknownField.put("outputFormat", "mp3");
            assertThat(restore(port, tenant, token, unknownField).statusCode()).isBetween(400, 422);
            assertThat(restore(port, tenant, token, body("j07-noops-" + run, sourceId, version, null)).statusCode()).isBetween(400, 422);
            HttpResponse<String> typed = restore(port, tenant, token, body("j07-typed-" + run, sourceId, version,
                    Map.of("dehum", Map.of("frequencyHz", 55))));
            assertThat(typed.statusCode()).isEqualTo(422);
            assertThat(code(typed)).isEqualTo("AUDIO_PARAMETERS_INVALID");
            assertThat(invocations(markers)).as("no engine process started for any invalid request").isZero();
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).isEqualTo(1);

            // ---- rights missing: refused, nothing processed or registered ----
            HttpResponse<String> noRights = restore(port, tenant, token, body("j07-norights-" + run, sourceId, version, OPS));
            assertThat(noRights.statusCode()).as(noRights.body()).isEqualTo(403);
            assertThat(code(noRights)).isEqualTo("RIGHTS_DECISION_DENIED");
            assertThat(invocations(markers)).isZero();

            // ---- stale / unknown / foreign versions ----
            JsonNode attested = post(port, tenant, token, "/dev/v1/rights/attestations", Map.of("artifactId", sourceId,
                    "artifactVersionId", version, "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                    "basis", "TEST: synthetic tone-plus-noise clip generated by the test; no real person or rights"), 201);
            String attestationId = attested.path("attestationId").asString();
            String staleVersion = "sha256:" + "0".repeat(64);
            HttpResponse<String> stale = restore(port, tenant, token, body("j07-stale-" + run, sourceId, staleVersion, OPS));
            assertThat(stale.statusCode()).as(stale.body()).isEqualTo(409);
            assertThat(code(stale)).isEqualTo("SOURCE_VERSION_STALE");
            assertThat(JSON.readTree(stale.body()).path("error").path("details").path("currentVersionId").asString()).isEqualTo(version);
            assertThat(restore(port, tenant, token, body("j07-unknown-" + run, "does-not-exist-" + run, version, OPS)).statusCode())
                    .isEqualTo(404);
            String foreign = issueDevToken(tenant, "test-principal-foreign-" + run);
            assertThat(restore(port, tenant, foreign, body("j07-foreign-" + run, sourceId, version, OPS)).statusCode()).isEqualTo(404);
            assertThat(invocations(markers)).isZero();

            // ---- the REAL FFmpeg process is SIGKILLed mid-run: UNKNOWN, nothing registered; retry registers once ----
            token = issueDevToken(tenant, owner);
            Files.createFile(markers.resolve("kill-once"));
            String killedToken = token;
            CompletableFuture<HttpResponse<String>> pending = CompletableFuture.supplyAsync(() -> {
                try { return restore(port, tenant, killedToken, body("j07-killed-" + run, sourceId, version, OPS)); }
                catch (Exception failure) { throw new IllegalStateException(failure); }
            });
            long pid = awaitPid(markers.resolve("pid"));
            Thread.sleep(400);
            Process kill = new ProcessBuilder("kill", "-9", Long.toString(pid)).start();
            assertThat(kill.waitFor(10, TimeUnit.SECONDS)).isTrue();
            HttpResponse<String> unknown = pending.get(60, TimeUnit.SECONDS);
            assertThat(unknown.statusCode()).as(unknown.body()).isEqualTo(503);
            assertThat(code(unknown)).isEqualTo("AUDIO_RESTORATION_OUTCOME_UNKNOWN");
            assertThat(JSON.readTree(unknown.body()).path("error").path("details").path("outcome").asString()).isEqualTo("UNKNOWN");
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).as("nothing registered after UNKNOWN").isEqualTo(1);
            assertThat(invocations(markers)).isEqualTo(1);
            // retry of the SAME requestId: runs again, registers exactly once
            JsonNode retried = JSON.readTree(assertStatus(restore(port, tenant, token, body("j07-killed-" + run, sourceId, version, OPS)), 201));
            String restoredId = retried.path("outputId").asString();
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).isEqualTo(2);
            assertThat(invocations(markers)).isEqualTo(2);
            JsonNode again = JSON.readTree(assertStatus(restore(port, tenant, token, body("j07-killed-" + run, sourceId, version, OPS)), 200));
            assertThat(again.path("outputId").asString()).isEqualTo(restoredId);
            assertThat(again.path("replayed").asBoolean()).isTrue();
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).as("single registration").isEqualTo(2);
            assertThat(invocations(markers)).as("a replay never re-runs the engine").isEqualTo(2);
            byte[] restoredBytes = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, owner, restoredId));
            assertThat(sha256(restoredBytes)).isEqualTo(retried.path("artifact").path("sha256").asString());
            assertThat(decodeWithFfmpeg(restoredBytes).samples().length).isEqualTo(decodeWithFfmpeg(sourceBytes).samples().length);
            assertThat(s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, owner, sourceId))).as("source preserved").isEqualTo(sourceBytes);

            // ---- rights revoked: even a replay of a completed request is refused, nothing runs ----
            post(port, tenant, token, "/dev/v1/rights/attestations/" + attestationId + "/revoke", Map.of("reason", "TEST: revoked"), 200);
            HttpResponse<String> revokedReplay = restore(port, tenant, token, body("j07-killed-" + run, sourceId, version, OPS));
            assertThat(revokedReplay.statusCode()).as(revokedReplay.body()).isEqualTo(403);
            assertThat(code(revokedReplay)).isEqualTo("RIGHTS_DECISION_REVOKED");
            HttpResponse<String> revokedNew = restore(port, tenant, token, body("j07-after-revoke-" + run, sourceId, version, OPS));
            assertThat(revokedNew.statusCode()).isEqualTo(403);
            assertThat(code(revokedNew)).isEqualTo("RIGHTS_DECISION_REVOKED");
            assertThat(invocations(markers)).isEqualTo(2);
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).isEqualTo(2);
            post(port, tenant, token, "/dev/v1/rights/attestations", Map.of("artifactId", sourceId, "artifactVersionId", version,
                    "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                    "basis", "TEST: second statement for the synthetic clip after the revocation drill"), 201);

            // ---- restart readback ----
            stopLauncher(launcher);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            token = issueDevToken(tenant, owner);
            JsonNode reopened = get(port, tenant, token, "/dev/v1/audio/outputs/" + restoredId, 200);
            assertThat(reopened.path("artifact").path("sha256").asString()).isEqualTo(sha256(restoredBytes));
            assertThat(reopened.path("lineage").path("source").path("sha256").asString()).isEqualTo(sha256(sourceBytes));
            assertThat(reopened.path("lineage").path("filterGraph").asString()).contains("adeclip", "bandreject=f=50", "afftdn");
            JsonNode replayAfterRestart = JSON.readTree(assertStatus(restore(port, tenant, token,
                    body("j07-killed-" + run, sourceId, version, OPS)), 200));
            assertThat(replayAfterRestart.path("outputId").asString()).isEqualTo(restoredId);
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).isEqualTo(2);
            assertThat(invocations(markers)).isEqualTo(2);

            // ---- the launcher itself is SIGKILLed while FFmpeg runs: outcome unknown; reclaim and one registration ----
            Files.createFile(markers.resolve("slow"));
            String hardKillToken = token;
            CompletableFuture<Object> inFlight = CompletableFuture.supplyAsync(() -> {
                try { return restore(port, tenant, hardKillToken, body("j07-hardkill-" + run, sourceId, version, OPS)); }
                catch (Exception expected) { return expected; }
            });
            long deadline = System.nanoTime() + java.time.Duration.ofSeconds(30).toNanos();
            while (invocations(markers) < 3 && System.nanoTime() < deadline) Thread.sleep(50);
            assertThat(invocations(markers)).as("the engine started for the hard-kill request").isEqualTo(3);
            Thread.sleep(300);
            launcher.destroyForcibly();
            assertThat(launcher.waitFor(15, TimeUnit.SECONDS)).isTrue();
            inFlight.get(60, TimeUnit.SECONDS); // connection reset; the caller learns nothing about the outcome
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).as("nothing registered by the killed launcher").isEqualTo(2);
            Files.deleteIfExists(markers.resolve("slow"));
            // third launcher process: also a 2 second engine deadline
            environment.put("MEDIA_DEV_AUDIO_RESTORE_TIMEOUT_SECONDS", "2");
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            token = issueDevToken(tenant, owner);
            JsonNode reclaimed = JSON.readTree(assertStatus(restore(port, tenant, token,
                    body("j07-hardkill-" + run, sourceId, version, OPS)), 201));
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).as("exactly one registration after reclaim").isEqualTo(3);
            assertThat(JSON.readTree(assertStatus(restore(port, tenant, token,
                    body("j07-hardkill-" + run, sourceId, version, OPS)), 200)).path("outputId").asString())
                    .isEqualTo(reclaimed.path("outputId").asString());
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).isEqualTo(3);

            // ---- wall-clock deadline: a run slower than the budget is killed and reported UNKNOWN ----
            Files.createFile(markers.resolve("slow"));
            long started = System.nanoTime();
            HttpResponse<String> timedOut = restore(port, tenant, token, body("j07-deadline-" + run, sourceId, version, OPS));
            long elapsedMillis = (System.nanoTime() - started) / 1_000_000;
            assertThat(timedOut.statusCode()).as(timedOut.body()).isEqualTo(503);
            assertThat(code(timedOut)).isEqualTo("AUDIO_RESTORATION_OUTCOME_UNKNOWN");
            assertThat(JSON.readTree(timedOut.body()).path("error").path("details").path("reason").asString()).isEqualTo("TIMED_OUT");
            assertThat(elapsedMillis).as("the engine was cut off at the deadline").isLessThan(15_000);
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).isEqualTo(3);
            Files.deleteIfExists(markers.resolve("slow"));
            assertStatus(restore(port, tenant, token, body("j07-deadline-" + run, sourceId, version, OPS)), 201);
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).isEqualTo(4);
            System.out.println("J07_FAULTS engineRuns=" + invocations(markers) + " registeredWavs=4 (1 source + 3 restorations)");
            passed = true;
        } finally {
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            deleteTree(services);
            deleteTree(markers);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("J-07 fault suite failure log retained at " + log);
        }
    }

    @Test
    void fixedRmsNoiseSuppressionUsesExactInputAndPersistsItsCandidateAcrossRestart() throws Exception {
        String configuredGateBinary = System.getenv("MEDIA_DEV_AUDIO_RMS_BLOCK_GATE_BIN");
        Path gateBinary = configuredGateBinary == null || configuredGateBinary.isBlank()
                ? Path.of(System.getProperty("user.dir"), "target/debug/examples/audio-repair-preview")
                : Path.of(configuredGateBinary);
        gateBinary = gateBinary.toAbsolutePath().normalize();
        assumeTrue(Files.isRegularFile(gateBinary) && Files.isExecutable(gateBinary),
                "the offline-built speech-audio-rust preview executable is required");
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-rms-gate-" + run;
        String owner = "test-principal-rms-gate-" + run;
        String bucket = "media-dev-rms-gate-" + run.substring(0, 12);
        String schema = "media_dev_rms_gate_" + run.substring(0, 12);
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-rms-services-");
        Path log = Files.createTempFile("media-dev-rms-process-", ".log");
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
            environment.put("MEDIA_DEV_AUDIO_RMS_BLOCK_GATE_BIN", gateBinary.toString());
            String token = issueDevToken(tenant, owner);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            short[] samples = new short[8_192];
            java.util.Random random = new java.util.Random(20261127L);
            for (int frame = 0; frame < samples.length; frame++) {
                samples[frame] = frame < 1_024 ? (short) random.nextInt(-300, 301)
                        : (short) Math.round(7_000 * Math.sin(2 * Math.PI * 440 * frame / 8_000));
            }
            byte[] sourceBytes = wav(8_000, samples);
            String sourceId = upload(port, tenant, owner, token, "rms-source-" + run, "rms-source.wav", "audio/wav", sourceBytes);
            String sourceVersion = "sha256:" + sha256(sourceBytes);
            String requestId = "rms-gate-" + run;
            Map<String, Object> request = rmsRequest(requestId, sourceId, sourceVersion, sourceBytes.length, 1_024);

            HttpResponse<String> denied = send(port, tenant, token, "POST", "/dev/v1/audio/restorations",
                    JSON.writeValueAsString(request));
            assertThat(denied.statusCode()).as(denied.body()).isEqualTo(403);
            assertThat(code(denied)).isEqualTo("RIGHTS_DECISION_DENIED");
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).isEqualTo(1);

            JsonNode attested = post(port, tenant, token, "/dev/v1/rights/attestations", Map.of("artifactId", sourceId,
                    "artifactVersionId", sourceVersion, "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                    "basis", "TEST: deterministic source-free PCM generated by this test; no real person or rights"), 201);
            policyPayload(request).put("rightsEvidenceRefs", List.of(attested.path("attestationId").asString()));
            JsonNode succeeded = post(port, tenant, token, "/dev/v1/audio/restorations", request, 201);
            assertThat(succeeded.size()).as("exact PXD-1 result schema").isEqualTo(7);
            assertThat(succeeded.path("outcome").asString()).isEqualTo("SUCCEEDED");
            assertThat(succeeded.path("implementationState").asString()).isEqualTo("UNKNOWN");
            assertThat(succeeded.path("qualificationState").asString()).isEqualTo("NOT_EVALUATED");
            assertThat(succeeded.path("runtimeAvailability").asString()).isEqualTo("UNKNOWN");
            assertThat(succeeded.path("provenance").path("operationRef").asString())
                    .isEqualTo("media.operation.capability.media-enhance-audio-noise-suppression");
            assertThat(succeeded.path("provenance").path("inputDigest").asString()).isEqualTo("sha256:" + sha256(sourceBytes));
            String outputId = succeeded.path("outputs").get(0).path("payload").path("artifactId").asString();
            String outputVersion = succeeded.path("outputs").get(0).path("payload").path("versionId").asString();
            String outputSha = succeeded.path("provenance").path("outputDigest").asString().substring("sha256:".length());
            assertThat(outputId).isNotEqualTo(sourceId);
            assertThat(outputVersion).isEqualTo("sha256:" + outputSha);
            assertThat(succeeded.path("provenance").path("profileRef").asString()).isEqualTo("RMS_BLOCK_GATE_V1");

            StoredArtifact sourceRow = storedArtifact(POSTGRES, tenant, owner, sourceId);
            StoredArtifact outputRow = storedArtifact(POSTGRES, tenant, owner, outputId);
            byte[] outputBytes = s3Bytes(LOCALSTACK, bucket, outputRow);
            assertThat(sourceRow.sha256()).isEqualTo(sha256(sourceBytes));
            assertThat(s3Bytes(LOCALSTACK, bucket, sourceRow)).isEqualTo(sourceBytes);
            assertThat(outputRow.sha256()).isEqualTo(outputSha);
            assertThat(outputBytes).isNotEqualTo(sourceBytes);
            JsonNode reopenedOutput = get(port, tenant, token, "/dev/v1/audio/outputs/" + outputId, 200);
            JsonNode lineage = reopenedOutput.path("lineage");
            assertThat(lineage.path("source").path("artifactId").asString()).isEqualTo(sourceId);
            assertThat(lineage.path("source").path("artifactVersionId").asString()).isEqualTo(sourceVersion);
            assertThat(lineage.path("source").path("sha256").asString()).isEqualTo(sha256(sourceBytes));
            assertThat(lineage.path("profile").path("profileRef").asString()).isEqualTo("RMS_BLOCK_GATE_V1");
            assertThat(lineage.path("engine").path("binarySha256").asString()).isEqualTo(sha256(Files.readAllBytes(gateBinary)));
            assertThat(lineage.path("input2AuthorityState").asString()).contains("NOT_EVALUATED");
            assertThat(lineage.path("noiseOnlyFrameRange").path("startFrame").asLong()).isZero();
            assertThat(lineage.path("noiseOnlyFrameRange").path("endFrame").asLong()).isEqualTo(1_024);
            assertThat(lineage.path("measurements").path("metrics").path("changedSamples").asLong()).isGreaterThan(0);
            assertThat(lineage.path("measurements").path("metrics").path("sourceSnrDbVsReference").isNull()).isTrue();
            assertThat(lineage.path("measurements").path("metrics").path("snrDbVsReference").isNull()).isTrue();
            assertThat(lineage.path("rightsDecision").asString()).startsWith("rights-attestation:");

            JsonNode replay = post(port, tenant, token, "/dev/v1/audio/restorations", request, 200);
            assertThat(replay.path("outputs").get(0).path("payload").path("artifactId").asString()).isEqualTo(outputId);
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).isEqualTo(2);
            Map<String, Object> changedRange = rmsRequest(requestId, sourceId, sourceVersion, sourceBytes.length, 1_025);
            policyPayload(changedRange).put("rightsEvidenceRefs", List.of(attested.path("attestationId").asString()));
            HttpResponse<String> conflict = send(port, tenant, token, "POST", "/dev/v1/audio/restorations",
                    JSON.writeValueAsString(changedRange));
            assertThat(conflict.statusCode()).as(conflict.body()).isEqualTo(409);
            assertThat(code(conflict)).isEqualTo("AUDIO_REQUEST_ID_REUSED");

            JsonNode comparison = post(port, tenant, token, "/dev/v1/audio/comparisons", Map.of("requestId", "rms-compare-" + run,
                    "source", Map.of("artifactId", sourceId, "artifactVersionId", sourceVersion),
                    "restored", Map.of("artifactId", outputId, "artifactVersionId", outputVersion)), 201);
            assertThat(comparison.path("report").path("metrics").path("delta").path("snrDb").isNull()).isTrue();
            String comparisonId = comparison.path("outputId").asString();

            stopLauncher(launcher);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            token = issueDevToken(tenant, owner);
            JsonNode reopened = get(port, tenant, token, "/dev/v1/audio/outputs/" + outputId, 200);
            assertThat(reopened.path("artifact").path("sha256").asString()).isEqualTo(outputSha);
            assertThat(reopened.path("lineage")).isEqualTo(lineage);
            assertThat(get(port, tenant, token, "/dev/v1/audio/outputs/" + comparisonId, 200)
                    .path("report").path("metrics")).isEqualTo(comparison.path("report").path("metrics"));
            JsonNode replayAfterRestart = post(port, tenant, token, "/dev/v1/audio/restorations", request, 200);
            assertThat(replayAfterRestart.path("outputs").get(0).path("payload").path("artifactId").asString())
                    .isEqualTo(outputId);
            assertThat(countArtifacts(POSTGRES, tenant, owner, "audio/wav")).isEqualTo(2);
            passed = true;
        } finally {
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            deleteTree(services);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("PXD-250 RMS gate integration failure log retained at " + log);
        }
    }

    private static Map<String, Object> rmsRequest(String requestId, String sourceId, String sourceVersion,
                                                   int sourceBytes, int endFrame) {
        return new HashMap<>(Map.of("requestId", requestId,
                "input1", Map.of("artifactType", "audio-artifact", "payload", Map.of("artifactId", sourceId,
                        "versionId", sourceVersion, "sourceRef", "artifact:" + sourceId + ":" + sourceVersion,
                        "declaredMediaType", "audio/wav", "declaredByteLength", sourceBytes)),
                "input2", Map.of("artifactType", "preservation-and-enhancement-policy", "payload", new HashMap<String, Object>(
                        Map.of("purposeRef", "TEST: local audio noise suppression"))),
                "parameters", Map.of("noiseOnlyFrameRange", Map.of("startFrame", 0, "endFrame", endFrame),
                        "profileRef", "RMS_BLOCK_GATE_V1")));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> policyPayload(Map<String, Object> request) {
        return (Map<String, Object>) ((Map<String, Object>) request.get("input2")).get("payload");
    }

    private static String assertStatus(HttpResponse<String> response, int expected) {
        assertThat(response.statusCode()).as(response.body()).isEqualTo(expected);
        return response.body();
    }

    private static long awaitPid(Path pidFile) throws Exception {
        long deadline = System.nanoTime() + java.time.Duration.ofSeconds(30).toNanos();
        while (System.nanoTime() < deadline) {
            if (Files.isRegularFile(pidFile)) {
                String text = Files.readString(pidFile).trim();
                if (!text.isEmpty()) return Long.parseLong(text);
            }
            Thread.sleep(25);
        }
        throw new AssertionError("the engine wrapper never recorded a pid");
    }
}
