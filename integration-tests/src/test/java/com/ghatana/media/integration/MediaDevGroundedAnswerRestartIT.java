package com.ghatana.media.integration;

import com.ghatana.stt.provider.LocalWhisperCppSttProvider;
import com.ghatana.tts.local.LocalKokoroTtsProvider;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import tools.jackson.databind.JsonNode;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.sql.DriverManager;
import java.time.Duration;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import com.ghatana.media.integration.MediaDevLiveFixtures.StoredArtifact;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-06 real-process journey: a real launcher process (Testcontainers PostgreSQL + LocalStack S3) with REAL
 * whisper.cpp (GPU), REAL Florence-2 and REAL Qwen2.5-VL (loopback sidecar) answers a question about an FFmpeg-built
 * MP4 whose audio is Kokoro-synthesized narration and whose picture is rendered text and shapes. Asserts the typed,
 * grounded answer (every grounded claim cites existing evidence ids; transcript times are bound to the container clock
 * independently probed with ffprobe), then the fault suite against the same process: rights missing and revoked
 * (no effect), an unreadable clock (refused), a killed sidecar (OUTCOME_UNKNOWN, nothing registered), launcher
 * restart (readback of the registered answer) and retry of the unknown request after recovery.
 * Rights come from REAL attestations through the DEV rights routes by a synthetic TEST principal.
 * Skipped with an explicit reason only when the model runtimes, FFmpeg/FFprobe or Docker are absent.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevGroundedAnswerRestartIT {
    private static final String ANSWERS = "/dev/v1/grounded-answers";
    private static final String NARRATION = "Quarterly revenue grew by twelve percent, driven by strong demand in Europe.";
    private static final String QUESTION = "What does the narrator say about revenue?";

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void realWhisperFlorenceAndQwenGroundTheAnswerAndTheFaultSuiteHoldsAcrossRestart() throws Exception {
        Path home = Path.of(System.getProperty("user.home"));
        Path data = home.resolve(".local/share/ghatana-media");
        Path models = Path.of(System.getenv().getOrDefault("MEDIA_LOCAL_VISION_MODELS_ROOT",
                data.resolve("models").toString()));
        Path python = Path.of(System.getenv().getOrDefault("MEDIA_LOCAL_VISION_PYTHON",
                data.resolve("runtimes/vision-venv/bin/python").toString()));
        Path sidecarScript = locate("tools/model-runtimes/vision/vision_sidecar.py");
        Path kokoroScript = locate("tools/model-runtimes/kokoro_synth.py");
        String ffmpeg = System.getenv("MEDIA_DEV_RENDER_FFMPEG");
        String ffprobe = System.getenv("MEDIA_DEV_RENDER_FFPROBE");
        Map<String, String> speech = Map.of("MEDIA_LOCAL_MODEL_ROOT", data.toString(),
                "MEDIA_WHISPER_CPP_BIN", data.resolve("runtimes/whisper.cpp-src/build-vulkan/bin/whisper-cli").toString(),
                "MEDIA_KOKORO_PYTHON", data.resolve("runtimes/kokoro-venv/bin/python").toString(),
                "MEDIA_KOKORO_SCRIPT", String.valueOf(kokoroScript), "MEDIA_WHISPER_CPP_THREADS", "8");
        Assumptions.assumeTrue(sidecarScript != null && kokoroScript != null && Files.isExecutable(python)
                        && ffmpeg != null && !ffmpeg.isBlank() && ffprobe != null && !ffprobe.isBlank()
                        && Files.isRegularFile(models.resolve("florence-2-large/ghatana-model-manifest.json"))
                        && Files.isRegularFile(models.resolve("qwen2.5-vl-7b-instruct/ghatana-model-manifest.json")),
                "SKIPPED: vision runtime/models, Kokoro script or MEDIA_DEV_RENDER_FFMPEG/FFPROBE absent");
        LocalKokoroTtsProvider tts = LocalKokoroTtsProvider.fromEnvironment(speech);
        Assumptions.assumeTrue(tts.ready() && LocalWhisperCppSttProvider.fromEnvironment(speech).ready(),
                "SKIPPED: local Whisper/Kokoro runtimes with verified manifests absent");

        // ---- source media: Kokoro narration + rendered title and shapes, muxed by FFmpeg ----
        Path work = Files.createTempDirectory("media-grounded-it-");
        var synthesis = tts.synthesizer().synthesize(NARRATION, "af_heart", 1.0, Duration.ofMinutes(3), () -> false);
        Files.write(work.resolve("speech.wav"), synthesis.wav());
        writeSceneFrame(work.resolve("frame.png"));
        byte[] mp4 = mux(ffmpeg, work, "a.mp4", List.of());
        byte[] shifted = mux(ffmpeg, work, "b.mp4", List.of("-output_ts_offset", "5"));
        byte[] whole = mux(ffmpeg, work, "c.mp4", List.of());
        // A real MP4 cut in half: the container magic is intact but the moov atom (clock, timebases) is gone.
        byte[] truncated = java.util.Arrays.copyOf(whole, whole.length / 2);
        assertThat(mp4.length).as("source must fit one upload chunk").isLessThan(1_000_000);
        Probe a = probe(ffprobe, work.resolve("a.mp4"));
        Probe b = probe(ffprobe, work.resolve("b.mp4"));
        System.out.println("GROUNDED-IT independent ffprobe A containerStart=" + a.containerStartMicros + "us audioStartPts="
                + a.audioStartPts + " audioTb=" + a.audioTimebase + " | B containerStart=" + b.containerStartMicros + "us");
        assertThat(b.containerStartMicros).as("the shifted source really has a different container start_time")
                .isGreaterThan(a.containerStartMicros + 4_000_000L);

        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-grounded-" + run;
        String principal = "media-dev-grounded-" + run;
        String bucket = "media-dev-grounded-" + run;
        String schema = "media_dev_grounded_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        int sidecarPort;
        try (var socket = new java.net.ServerSocket(0)) { sidecarPort = socket.getLocalPort(); }
        byte[] tokenBytes = new byte[24];
        new SecureRandom().nextBytes(tokenBytes);
        String sidecarToken = HexFormat.of().formatHex(tokenBytes);
        Path services = Files.createTempDirectory("media-dev-grounded-services-");
        Path log = Files.createTempFile("media-dev-grounded-process-", ".log");
        Process sidecar = null;
        Process launcher = null;
        try {
            try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
            sidecar = startSidecar(python, sidecarScript, models, sidecarPort, sidecarToken, home, work.resolve("sidecar.log"));
            awaitSidecar(sidecar, sidecarPort, sidecarToken);

            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.putAll(speech);
            environment.put("MEDIA_LOCAL_VISION_MODELS_ROOT", models.toString());
            environment.put("MEDIA_LOCAL_VISION_SIDECAR_URL", "http://127.0.0.1:" + sidecarPort);
            environment.put("MEDIA_LOCAL_VISION_SIDECAR_TOKEN", sidecarToken);
            environment.put("MEDIA_LOCAL_VISION_TIMEOUT_SECONDS", "480");
            environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg);
            environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe);
            environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
            String token = issueDevToken(tenant, principal);
            launcher = startLauncher(classpath, environment, log);
            awaitLauncher(launcher, port, log);
            token = issueDevToken(tenant, principal);

            JsonNode status = get(port, tenant, token, ANSWERS + "/status", 200);
            assertThat(status.path("florence").asString()).isEqualTo("QUALIFIED");
            assertThat(status.path("qwen").asString()).isEqualTo("QUALIFIED");
            assertThat(status.path("speechToText").asString()).isEqualTo("AVAILABLE");
            assertThat(status.path("documentIntelligence").path("status").asString()).isEqualTo("UNAVAILABLE");

            String sourceId = upload(port, tenant, principal, token, run + "-a", "report.mp4", "video/mp4", mp4);
            String version = "sha256:" + sha256(mp4);
            String shiftedId = upload(port, tenant, principal, token, run + "-b", "report-shifted.mp4", "video/mp4", shifted);
            String shiftedVersion = "sha256:" + sha256(shifted);
            String garbageId = upload(port, tenant, principal, token, run + "-g", "truncated.mp4", "video/mp4", truncated);
            String garbageVersion = "sha256:" + sha256(truncated);

            // ---- rights missing: refused before any child runs; no answer artifact exists ----
            String groundedRequestId = "grounded-" + run;
            Map<String, Object> body = Map.of("requestId", groundedRequestId, "artifactId", sourceId,
                    "artifactVersionId", version, "question", QUESTION);
            HttpResponse<String> noRights = send(port, tenant, token, "POST", ANSWERS, JSON.writeValueAsString(body));
            assertThat(noRights.statusCode()).as(noRights.body()).isEqualTo(403);
            assertThat(noRights.body()).contains("RIGHTS_DENIED");
            assertThat(groundedRows(tenant)).as("rights missing leaves no answer artifact").isZero();

            String attestationId = attest(port, tenant, token, sourceId, version, "report");

            // ---- the real grounded answer ----
            long started = System.nanoTime();
            HttpResponse<String> createdResponse = send(port, tenant, token, "POST", ANSWERS, JSON.writeValueAsString(body));
            if (createdResponse.statusCode() != 201) {
                List<String> launcherLines = Files.readAllLines(log);
                throw new AssertionError("grounded answer returned " + createdResponse.statusCode() + ": "
                        + createdResponse.body() + "\nlauncher log tail:\n"
                        + String.join("\n", launcherLines.subList(Math.max(0, launcherLines.size() - 80), launcherLines.size())));
            }
            JsonNode created = JSON.readTree(createdResponse.body());
            System.out.println("GROUNDED-IT answer took " + Duration.ofNanos(System.nanoTime() - started).toSeconds() + "s");
            String answerId = created.path("outputId").asString();
            JsonNode document = created.path("document");
            System.out.println("REAL-GROUNDED-ANSWER " + JSON.writerWithDefaultPrettyPrinter().writeValueAsString(document));
            assertThat(created.path("admission").path("attestationIds").get(0).asString()).isEqualTo(attestationId);
            assertGroundingInvariants(document, a, version, sha256(mp4), sourceId);
            JsonNode answer = document.path("answer");
            assertThat(answer.path("status").asString()).isIn("GROUNDED", "PARTIALLY_GROUNDED");
            assertThat(answer.path("claims").size()).as("at least one claim cites valid evidence").isGreaterThanOrEqualTo(1);
            // The real children produced the evidence the answer is built from.
            String allText = evidenceText(document).toLowerCase(Locale.ROOT);
            assertThat(allText).as("Whisper heard the narration").contains("revenue").containsAnyOf("twelve", "12");
            JsonNode children = document.path("children");
            assertThat(children.get(0).path("status").asString()).isEqualTo("COMPLETED");
            assertThat(children.get(1).path("status").asString()).isEqualTo("COMPLETED");
            assertThat(children.get(2).path("kind").asString()).isEqualTo("DOCUMENT_INTELLIGENCE");
            assertThat(children.get(2).path("status").asString()).isEqualTo("UNAVAILABLE");
            assertThat(document.path("evidenceCompleteness").asString()).isEqualTo("COMPLETE");

            // Independent durable readback of the registered bytes (PostgreSQL row + S3 object).
            StoredArtifact row = storedArtifact(POSTGRES, tenant, principal, answerId);
            assertThat(row.contentType()).isEqualTo("application/json");
            byte[] stored = s3Bytes(LOCALSTACK, bucket, row);
            assertThat(sha256(stored)).isEqualTo(row.sha256()).isEqualTo(created.path("artifact").path("sha256").asString());
            assertThat(JSON.readTree(new String(stored, StandardCharsets.UTF_8))).isEqualTo(document);
            assertThat(s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, sourceId)))
                    .as("the source version is untouched").isEqualTo(mp4);
            assertThat(groundedRows(tenant)).isEqualTo(1);
            token = issueDevToken(tenant, principal);
            JsonNode outcome = get(port, tenant, token,
                    "/dev/v1/request-outcomes/grounded.answer/" + groundedRequestId, 200);
            assertThat(outcome.path("state").asString()).isEqualTo("COMPLETED");
            assertThat(outcome.path("outputs").size()).isEqualTo(1);
            assertThat(outcome.path("outputs").get(0).path("artifactId").asString()).isEqualTo(answerId);
            assertThat(outcome.path("outputs").get(0).path("versionId").asString())
                    .isEqualTo(created.path("artifact").path("artifactVersionId").asString());

            // DEV_ONLY tokens live 5 minutes and the real models take longer: re-issue before each step.
            token = issueDevToken(tenant, principal);
            // ---- clock binding on a source whose container start_time is 5 s ----
            attest(port, tenant, token, shiftedId, shiftedVersion, "shifted");
            JsonNode shiftedAnswer = post(port, tenant, token, ANSWERS, Map.of("requestId", "grounded-shift-" + run,
                    "artifactId", shiftedId, "artifactVersionId", shiftedVersion, "question", QUESTION), 201);
            JsonNode shiftedDocument = shiftedAnswer.path("document");
            assertGroundingInvariants(shiftedDocument, b, shiftedVersion, sha256(shifted), shiftedId);
            assertThat(shiftedDocument.path("sourceClock").path("clockId").asString())
                    .isNotEqualTo(document.path("sourceClock").path("clockId").asString());
            for (JsonNode item : shiftedDocument.path("evidence")) {
                assertThat(item.path("startMicros").asLong()).as("%s is on the container clock", item.path("evidenceId"))
                        .isGreaterThanOrEqualTo(b.containerStartMicros - 1_000_000L);
            }
            long firstSpeech = Long.MAX_VALUE;
            for (JsonNode item : shiftedDocument.path("evidence")) {
                if ("TRANSCRIPT_SEGMENT".equals(item.path("kind").asString())) {
                    firstSpeech = Math.min(firstSpeech, item.path("startMicros").asLong());
                }
            }
            assertThat(firstSpeech).as("speech on the shifted source starts after its 5 s container start")
                    .isGreaterThanOrEqualTo(b.containerStartMicros);
            System.out.println("GROUNDED-IT clock A start=" + a.containerStartMicros + " B start=" + b.containerStartMicros
                    + " firstSpeechB=" + firstSpeech);

            // DEV_ONLY tokens live 5 minutes and the real models take longer: re-issue before each step.
            token = issueDevToken(tenant, principal);
            // ---- unreadable clock: refused; the answer count does not change ----
            attest(port, tenant, token, garbageId, garbageVersion, "garbage");
            HttpResponse<String> noClock = send(port, tenant, token, "POST", ANSWERS, JSON.writeValueAsString(Map.of(
                    "requestId", "grounded-garbage-" + run, "artifactId", garbageId, "artifactVersionId", garbageVersion,
                    "question", QUESTION)));
            assertThat(noClock.statusCode()).as(noClock.body()).isEqualTo(422);
            assertThat(noClock.body()).contains("SOURCE_CLOCK_UNDETERMINED");
            assertThat(groundedRows(tenant)).isEqualTo(2);

            // DEV_ONLY tokens live 5 minutes and the real models take longer: re-issue before each step.
            token = issueDevToken(tenant, principal);
            // ---- a question the evidence cannot answer: whatever the model says, no claim is grounded falsely ----
            JsonNode unanswerable = post(port, tenant, token, ANSWERS, Map.of("requestId", "grounded-unanswerable-" + run,
                    "artifactId", sourceId, "artifactVersionId", version,
                    "question", "What is the name of the narrator's dog?"), 201);
            System.out.println("REAL-GROUNDED-UNANSWERABLE " + unanswerable.path("document").path("answer"));
            assertGroundingInvariants(unanswerable.path("document"), a, version, sha256(mp4), sourceId);
            assertThat(groundedRows(tenant)).isEqualTo(3);

            // DEV_ONLY tokens live 5 minutes and the real models take longer: re-issue before each step.
            token = issueDevToken(tenant, principal);
            // ---- revocation: refused, no effect ----
            post(port, tenant, token, "/dev/v1/rights/attestations/" + attestationId + "/revoke",
                    Map.of("reason", "TEST: revoked to prove fail-closed"), 200);
            HttpResponse<String> revoked = send(port, tenant, token, "POST", ANSWERS, JSON.writeValueAsString(Map.of(
                    "requestId", "grounded-revoked-" + run, "artifactId", sourceId, "artifactVersionId", version,
                    "question", QUESTION)));
            assertThat(revoked.statusCode()).as(revoked.body()).isEqualTo(403);
            assertThat(revoked.body()).contains("RIGHTS_REVOKED");
            assertThat(groundedRows(tenant)).isEqualTo(3);
            attest(port, tenant, token, sourceId, version, "report-second-statement");

            // DEV_ONLY tokens live 5 minutes and the real models take longer: re-issue before each step.
            token = issueDevToken(tenant, principal);
            // ---- sidecar is unreachable before inference: typed UNAVAILABLE, nothing registered ----
            sidecar.destroyForcibly();
            sidecar.waitFor(15, TimeUnit.SECONDS);
            String retryRequest = "grounded-retry-" + run;
            Map<String, Object> retryBody = Map.of("requestId", retryRequest, "artifactId", sourceId,
                    "artifactVersionId", version, "question", QUESTION);
            HttpResponse<String> unavailable = send(port, tenant, token, "POST", ANSWERS, JSON.writeValueAsString(retryBody));
            System.out.println("GROUNDED-IT sidecar-unreachable-before-inference -> " + unavailable.statusCode()
                    + " " + unavailable.body());
            assertThat(unavailable.statusCode()).as(unavailable.body()).isEqualTo(503);
            assertThat(unavailable.body()).contains("GROUNDED_UNAVAILABLE").contains("\"outcome\":\"UNAVAILABLE\"");
            assertThat(groundedRows(tenant)).isEqualTo(3);

            // ---- restart: sidecar back on the same endpoint, launcher restarted; readback and resume ----
            sidecar = startSidecar(python, sidecarScript, models, sidecarPort, sidecarToken, home, work.resolve("sidecar.log"));
            awaitSidecar(sidecar, sidecarPort, sidecarToken);
            stopLauncher(launcher);
            launcher = startLauncher(classpath, environment, log);
            awaitLauncher(launcher, port, log);
            token = issueDevToken(tenant, principal);

            JsonNode reopened = get(port, tenant, token, ANSWERS + "/" + answerId, 200);
            assertThat(reopened.path("document")).isEqualTo(document);
            assertThat(reopened.path("artifact").path("sha256").asString()).isEqualTo(row.sha256());
            assertThat(reopened.path("lineage").path("source").path("artifactVersionId").asString()).isEqualTo(version);
            assertThat(reopened.path("lineage").path("sourceClockId").asString())
                    .isEqualTo(document.path("sourceClock").path("clockId").asString());
            String otherToken = issueDevToken(tenant, "someone-else-" + run);
            assertThat(send(port, tenant, otherToken, "GET", ANSWERS + "/" + answerId, null).statusCode()).isEqualTo(404);
            JsonNode otherOutcome = get(port, tenant, otherToken,
                    "/dev/v1/request-outcomes/grounded.answer/" + groundedRequestId, 200);
            assertThat(otherOutcome.path("state").asString()).isEqualTo("ABSENT");
            assertThat(otherOutcome.path("outputs")).isEmpty();

            // The unavailable request retries with the same requestId and registers exactly one answer.
            // The GPU is shared with other processes, so the freshly restarted sidecar may briefly fail to load a model:
            // the documented contract is to retry the same requestId, which must resume without a second registration.
            HttpResponse<String> resumedResponse = null;
            for (int attempt = 1; attempt <= 4; attempt++) {
                token = issueDevToken(tenant, principal);
                resumedResponse = send(port, tenant, token, "POST", ANSWERS, JSON.writeValueAsString(retryBody));
                System.out.println("GROUNDED-IT resume attempt " + attempt + " -> " + resumedResponse.statusCode()
                        + (resumedResponse.statusCode() == 201 ? "" : " " + resumedResponse.body()));
                if (resumedResponse.statusCode() == 201) break;
                List<String> sidecarLines = Files.readAllLines(work.resolve("sidecar.log"));
                System.out.println("GROUNDED-IT sidecar log tail:\n" + String.join("\n",
                        sidecarLines.subList(Math.max(0, sidecarLines.size() - 15), sidecarLines.size())));
                assertThat(resumedResponse.statusCode()).as("only typed retryable failures may precede the resume: "
                        + resumedResponse.body()).isIn(502, 503);
                assertThat(groundedRows(tenant)).as("a failed attempt registers nothing").isEqualTo(3);
                Thread.sleep(30_000);
            }
            assertThat(resumedResponse.statusCode()).as(resumedResponse.body()).isEqualTo(201);
            JsonNode resumed = JSON.readTree(resumedResponse.body());
            assertGroundingInvariants(resumed.path("document"), a, version, sha256(mp4), sourceId);
            assertThat(groundedRows(tenant)).isEqualTo(4);
            // Re-sending the first request after the restart: the durable request ledger maps the requestId to the
            // registered answer, so this is a replay (HTTP 200, same artifact) without re-running the models, whatever
            // the nondeterministic models would answer now. Never a 409 and never a second artifact.
            HttpResponse<String> replay = send(port, tenant, token, "POST", ANSWERS, JSON.writeValueAsString(body));
            System.out.println("GROUNDED-IT replay after restart -> " + replay.statusCode());
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            assertThat(JSON.readTree(replay.body()).path("replayed").asBoolean()).isTrue();
            assertThat(JSON.readTree(replay.body()).path("outputId").asString()).isEqualTo(answerId);
            assertThat(groundedRows(tenant)).isEqualTo(4);

            // ---- the hosted UI: real Chromium, real launcher, the REAL registered answer ----
            token = issueDevToken(tenant, principal);
            Path viewFile = work.resolve("answer-view.json");
            Files.writeString(viewFile, JSON.writeValueAsString(get(port, tenant, token, ANSWERS + "/" + answerId, 200)));
            String unattestedId = upload(port, tenant, principal, token, run + "-c", "unattested.mp4", "video/mp4", whole);
            runBrowser(port, token, answerId, viewFile, unattestedId, "sha256:" + sha256(whole), garbageId, garbageVersion, log);
        } finally {
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            if (sidecar != null) {
                sidecar.destroyForcibly();
                sidecar.waitFor(10, TimeUnit.SECONDS);
            }
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            deleteTree(services);
            deleteTree(work);
            Files.deleteIfExists(log);
        }
    }

    // ---- invariants every returned answer must satisfy, independent of what the model said ----

    private static void assertGroundingInvariants(JsonNode document, Probe probe, String version, String sha,
                                                  String sourceId) {
        assertThat(document.path("schema").asString()).isEqualTo("media.dev.grounded-answer.v1");
        assertThat(document.path("source").path("artifactId").asString()).isEqualTo(sourceId);
        assertThat(document.path("source").path("artifactVersionId").asString()).isEqualTo(version);
        assertThat(document.path("source").path("sha256").asString()).isEqualTo(sha);
        JsonNode clock = document.path("sourceClock");
        assertThat(clock.path("containerStartMicros").asLong()).isEqualTo(probe.containerStartMicros);
        assertThat(clock.path("audio").path("startPts").asLong()).isEqualTo(probe.audioStartPts);
        assertThat(clock.path("audio").path("timebase").asString()).isEqualTo(probe.audioTimebase);
        long end = clock.path("containerStartMicros").asLong() + clock.path("containerDurationMicros").asLong();
        Set<String> evidenceIds = new LinkedHashSet<>();
        Set<String> offered = new LinkedHashSet<>();
        document.path("evidenceOffered").forEach(id -> offered.add(id.asString()));
        for (JsonNode item : document.path("evidence")) {
            evidenceIds.add(item.path("evidenceId").asString());
            assertThat(item.path("startMicros").asLong()).isBetween(probe.containerStartMicros - 1_000_000L, end + 1_000_000L);
            assertThat(item.path("endMicros").asLong()).isBetween(probe.containerStartMicros - 1_000_000L, end + 1_000_000L);
            if (item.has("box")) {
                JsonNode box = item.path("box");
                JsonNode frame = item.path("frame");
                assertThat(frame.path("ptsTicks").isIntegralNumber()).isTrue();
                assertThat(box.path("x").asDouble()).isGreaterThanOrEqualTo(-1.0);
                assertThat(box.path("y").asDouble()).isGreaterThanOrEqualTo(-1.0);
                assertThat(box.path("x").asDouble() + box.path("width").asDouble())
                        .isLessThanOrEqualTo(frame.path("width").asDouble() + 1.0);
                assertThat(box.path("y").asDouble() + box.path("height").asDouble())
                        .isLessThanOrEqualTo(frame.path("height").asDouble() + 1.0);
            }
        }
        for (JsonNode claim : document.path("answer").path("claims")) {
            assertThat(claim.path("status").asString()).isEqualTo("GROUNDED");
            assertThat(claim.path("evidenceIds").size()).as("a grounded claim is never uncited").isGreaterThanOrEqualTo(1);
            for (JsonNode id : claim.path("evidenceIds")) {
                assertThat(evidenceIds).as("cited id %s exists", id).contains(id.asString());
                assertThat(offered).as("cited id %s was offered to the model", id).contains(id.asString());
            }
        }
        for (JsonNode flagged : document.path("answer").path("flaggedClaims")) {
            assertThat(flagged.path("status").asString()).isEqualTo("NOT_GROUNDED");
            assertThat(flagged.path("flags").size()).isGreaterThanOrEqualTo(1);
        }
    }

    private static String evidenceText(JsonNode document) {
        StringBuilder text = new StringBuilder();
        for (JsonNode item : document.path("evidence")) text.append(item.path("text").asString()).append(' ');
        return text.toString();
    }

    // ---- helpers ----

    private static String attest(int port, String tenant, String token, String artifactId, String version, String label)
            throws Exception {
        return post(port, tenant, token, "/dev/v1/rights/attestations", Map.of("artifactId", artifactId,
                "artifactVersionId", version, "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                "basis", "TEST: synthetic source generated by the integration test (" + label + ")"), 201)
                .path("attestationId").asString();
    }

    private static int groundedRows(String tenant) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT count(*) FROM media_artifacts WHERE tenant_id=? AND metadata_json LIKE '%groundedSchema%'")) {
            statement.setString(1, tenant);
            try (var rows = statement.executeQuery()) {
                rows.next();
                return rows.getInt(1);
            }
        }
    }

    private record Probe(long containerStartMicros, long audioStartPts, String audioTimebase) { }

    /** Independent ffprobe of the source (not the code under test) for the container clock facts. */
    private static Probe probe(String ffprobe, Path file) throws Exception {
        Process process = new ProcessBuilder(ffprobe, "-v", "error", "-of", "json", "-show_entries",
                "format=start_time:stream=codec_type,start_pts,time_base", file.toString())
                .redirectErrorStream(true).start();
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(process.waitFor(60, TimeUnit.SECONDS)).isTrue();
        JsonNode root = JSON.readTree(output);
        long containerStart = new java.math.BigDecimal(root.path("format").path("start_time").asString())
                .movePointRight(6).setScale(0, java.math.RoundingMode.HALF_UP).longValueExact();
        for (JsonNode stream : root.path("streams")) {
            if ("audio".equals(stream.path("codec_type").asString())) {
                return new Probe(containerStart, stream.path("start_pts").asLong(), stream.path("time_base").asString());
            }
        }
        throw new AssertionError("fixture has no audio stream: " + output);
    }

    private static byte[] mux(String ffmpeg, Path work, String name, List<String> extra) throws Exception {
        List<String> command = new java.util.ArrayList<>(List.of(ffmpeg, "-nostdin", "-v", "error", "-y", "-loop", "1",
                "-framerate", "5", "-i", work.resolve("frame.png").toString(), "-i", work.resolve("speech.wav").toString(),
                "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k",
                "-shortest"));
        // The truncated-source fixture keeps its moov atom at the end (no faststart) so cutting the file loses it.
        if (!name.startsWith("c")) command.addAll(List.of("-movflags", "+faststart"));
        command.addAll(extra);
        command.add(work.resolve(name).toString());
        Process process = new ProcessBuilder(command).redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.DISCARD).start();
        assertThat(process.waitFor(2, TimeUnit.MINUTES)).isTrue();
        assertThat(process.exitValue()).as("ffmpeg must build the fixture " + name).isZero();
        return Files.readAllBytes(work.resolve(name));
    }

    /** A title in text plus a red square and a blue circle, rendered with Java2D. */
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

    private static Process startSidecar(Path python, Path script, Path models, int port, String token, Path home,
                                        Path sidecarLog) throws Exception {
        ProcessBuilder builder = new ProcessBuilder(python.toString(), "-I", script.toString(), "--port",
                Integer.toString(port), "--models-root", models.toString());
        builder.redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.appendTo(sidecarLog.toFile()));
        builder.environment().clear();
        builder.environment().putAll(Map.of("GHATANA_VISION_SIDECAR_TOKEN", token, "HOME", home.toString(),
                "PATH", "/usr/bin:/bin"));
        return builder.start();
    }

    private static void awaitSidecar(Process process, int port, String token) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(180).toNanos();
        while (System.nanoTime() < deadline) {
            if (!process.isAlive()) throw new AssertionError("vision sidecar exited: " + process.exitValue());
            try {
                HttpResponse<String> response = HttpClient.newHttpClient().send(
                        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/v1/health"))
                                .header("Authorization", "Bearer " + token).GET().build(),
                        HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() == 200) return;
            } catch (java.io.IOException ignored) { }
            Thread.sleep(250);
        }
        throw new AssertionError("vision sidecar did not become healthy");
    }

    /** Like the shared readiness wait but with a longer budget (model digests are verified at composition) and a log tail on failure. */
    private static void awaitLauncher(Process process, int port, Path log) throws Exception {
        long deadline = System.nanoTime() + Duration.ofMinutes(10).toNanos();
        while (System.nanoTime() < deadline) {
            if (!process.isAlive()) break;
            try {
                HttpResponse<String> response = HttpClient.newHttpClient().send(
                        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/health/ready")).GET().build(),
                        HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() == 200) return;
            } catch (java.io.IOException ignored) { }
            Thread.sleep(500);
        }
        List<String> lines = Files.readAllLines(log);
        System.out.println("GROUNDED-IT launcher not ready (alive=" + process.isAlive() + "); log tail:\n"
                + String.join("\n", lines.subList(Math.max(0, lines.size() - 60), lines.size())));
        throw new AssertionError("MediaLauncher did not become ready");
    }

    /** Runs the live Chromium page test (Vite page + Playwright) against this launcher; the page test asserts everything itself. */
    private static void runBrowser(int port, String token, String answerId, Path viewFile, String unattestedId,
                                   String unattestedVersion, String garbageId, String garbageVersion, Path log)
            throws Exception {
        Path repoRoot = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (!Files.isRegularFile(repoRoot.resolve("scripts/media-dev-identity-token.mjs"))) {
            repoRoot = repoRoot.getParent();
            if (repoRoot == null) throw new AssertionError("Could not locate the Media repository root");
        }
        Path script = repoRoot.resolve("apps/media-experience-explorer/test/dev-grounded-answer-live-browser.mjs");
        Path vite = repoRoot.resolve("apps/media-experience-explorer/node_modules/vite/bin/vite.js");
        Path playwright = repoRoot.resolve("apps/media-experience-explorer/node_modules/playwright/index.mjs");
        assertThat(script).isRegularFile();
        assertThat(vite).as("pnpm install --frozen-lockfile --offline must have linked Vite").isRegularFile();
        assertThat(playwright).as("pnpm install must have linked Playwright").isRegularFile();
        String viteVersion = JSON.readTree(Files.readString(
                vite.toRealPath().getParent().getParent().resolve("package.json"))).path("version").asString();
        ProcessBuilder builder = new ProcessBuilder("node", script.toString());
        builder.directory(repoRoot.toFile());
        builder.redirectErrorStream(true);
        Map<String, String> env = builder.environment();
        env.put("MEDIA_DEV_GROUNDED_BROWSER_TOKEN", token);
        env.put("MEDIA_DEV_GROUNDED_BROWSER_ANSWER_ID", answerId);
        env.put("MEDIA_DEV_GROUNDED_BROWSER_DOCUMENT_PATH", viewFile.toString());
        env.put("MEDIA_DEV_GROUNDED_BROWSER_UNATTESTED_ID", unattestedId);
        env.put("MEDIA_DEV_GROUNDED_BROWSER_UNATTESTED_VERSION", unattestedVersion);
        env.put("MEDIA_DEV_GROUNDED_BROWSER_GARBAGE_ID", garbageId);
        env.put("MEDIA_DEV_GROUNDED_BROWSER_GARBAGE_VERSION", garbageVersion);
        env.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(port));
        env.put("MEDIA_DEV_VITE_BINARY", vite.toString());
        env.put("MEDIA_DEV_VITE_VERSION", viteVersion);
        env.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwright.toString());
        Process browser = builder.start();
        String output = new String(browser.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        boolean finished = browser.waitFor(5, TimeUnit.MINUTES);
        if (!finished) browser.destroyForcibly();
        System.out.println("GROUNDED-IT browser output:\n" + output);
        assertThat(finished).as("browser test finished").isTrue();
        assertThat(browser.exitValue()).as("live Chromium grounded-answer test:\n" + output).isZero();
        assertThat(output).contains("\"event\":\"grounded-answer-browser\"");
    }

    private static Path locate(String relative) {
        for (Path dir = Path.of("").toAbsolutePath(); dir != null; dir = dir.getParent()) {
            Path candidate = dir.resolve(relative);
            if (Files.isRegularFile(candidate)) return candidate;
        }
        return null;
    }
}
