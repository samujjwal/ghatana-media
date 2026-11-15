package com.ghatana.media.integration;

import com.ghatana.media.integration.MediaDevFaultInjector.ModeScript;
import com.ghatana.media.integration.MediaDevFaultInjector.MovableBinary;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import tools.jackson.databind.JsonNode;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.SecureRandom;
import java.sql.DriverManager;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-27 `media.dev.outcome-provider-outage-safe-path` and J-30 `media.dev.outcome-eligible-provider-catalog` against
 * REAL processes: the real launcher with the durable PostgreSQL + S3 stores (Testcontainers), the real whisper.cpp
 * binary (Vulkan GPU), the real Kokoro-82M worker, the real Florence-2 sidecar and the real FFmpeg. A test-only
 * {@link MediaDevFaultInjector} makes those providers fail the way a host sees it (process killed with SIGKILL or
 * SIGSEGV, hung with SIGSTOP, binary removed or swapped, interpreter that cannot start, an encode that crashes or
 * hangs) and the test asserts, per lane:
 *
 * <ul>
 *   <li>the typed outcome (UNAVAILABLE 503, UNKNOWN 503 or TIMEOUT 504, with {@code details.fallback = NONE}) and never
 *       a success or a silent substitution by another model;</li>
 *   <li>zero artifacts registered during the outage (independent PostgreSQL readback) and the durable request ledger
 *       row RELEASED;</li>
 *   <li>the provider catalog transitions (READY, then the real observed state, then READY after recovery);</li>
 *   <li>after recovery the same requestId runs and registers exactly once and a further retry replays it.</li>
 * </ul>
 *
 * Nothing here is a mock model. A missing runtime prerequisite FAILS the test.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class MediaDevProviderOutageLiveIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private static final String CATALOG = "/dev/v1/providers/catalog";
    private static final Duration SPEECH_BUDGET = Duration.ofSeconds(80);

    private static String run;
    private static String tenant;
    private static String bucket;
    private static String schema;
    private static int port;
    private static int sidecarPort;
    private static String sidecarToken;
    private static Path work;
    private static Path services;
    private static Path injectDir;
    private static Path log;
    private static Path data;
    private static Path models;
    private static Path digestCache;
    private static Path pythonVenv;
    private static Path sidecarScript;
    private static Path ffmpegReal;
    private static Path ffprobeReal;
    private static Process launcher;
    private static Process sidecar;
    private static ModeScript ffmpegFault;
    private static ModeScript pythonFault;
    private static MovableBinary whisper;
    private static Path whisperOriginalBytes;
    private static boolean passed;
    private static final Map<String, long[]> TOKEN_AGE = new HashMap<>();
    private static final Map<String, String> TOKENS = new HashMap<>();
    // Shared between tests: the synthesized speech source for STT and the generated video for vision.
    private static String speechArtifactId;
    private static String speechVersion;

    @BeforeAll
    static void startRealHost() throws Exception {
        Path home = Path.of(System.getProperty("user.home"));
        data = MediaDevVoiceJourneySupport.modelRoot();
        models = data.resolve("models");
        pythonVenv = data.resolve("runtimes/kokoro-venv/bin/python");
        Path visionPython = Path.of(System.getenv().getOrDefault("MEDIA_LOCAL_VISION_PYTHON",
                data.resolve("runtimes/vision-venv/bin/python").toString()));
        sidecarScript = locate("tools/model-runtimes/vision/vision_sidecar.py");
        Path kokoroScript = locate("tools/model-runtimes/kokoro_synth.py");
        Path whisperReal = data.resolve("runtimes/whisper.cpp-src/build-vulkan/bin/whisper-cli");
        String ffmpegEnv = MediaDevVoiceJourneySupport.ffmpeg();
        String ffprobeEnv = MediaDevVoiceJourneySupport.ffprobe();
        assertThat(ffmpegEnv).as("MEDIA_DEV_RENDER_FFMPEG").isNotBlank();
        assertThat(ffprobeEnv).as("MEDIA_DEV_RENDER_FFPROBE").isNotBlank();
        ffmpegReal = Path.of(ffmpegEnv);
        ffprobeReal = Path.of(ffprobeEnv);
        assertThat(sidecarScript).as("vision_sidecar.py").isNotNull();
        assertThat(kokoroScript).as("kokoro_synth.py").isNotNull();
        assertThat(Files.isExecutable(visionPython)).as("vision python " + visionPython).isTrue();
        assertThat(Files.isExecutable(pythonVenv)).as("kokoro python " + pythonVenv).isTrue();
        assertThat(Files.isExecutable(whisperReal)).as("whisper-cli " + whisperReal).isTrue();
        assertThat(models.resolve("florence-2-large/ghatana-model-manifest.json")).exists();
        assertThat(models.resolve("qwen2.5-vl-7b-instruct/ghatana-model-manifest.json")).exists();

        run = UUID.randomUUID().toString().replace("-", "");
        tenant = "tenant-dev-outage-" + run;
        bucket = "media-dev-outage-" + run;
        schema = "media_dev_outage_" + run;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        try (var socket = new java.net.ServerSocket(0)) { sidecarPort = socket.getLocalPort(); }
        byte[] tokenBytes = new byte[24];
        new SecureRandom().nextBytes(tokenBytes);
        sidecarToken = HexFormat.of().formatHex(tokenBytes);
        work = Files.createTempDirectory("media-outage-work-");
        services = Files.createTempDirectory("media-outage-services-");
        injectDir = Files.createTempDirectory("media-outage-inject-");
        log = Files.createTempFile("media-outage-process-", ".log");
        digestCache = Path.of(System.getenv().getOrDefault("MEDIA_LOCAL_MODEL_DIGEST_CACHE",
                Path.of(System.getProperty("java.io.tmpdir"), "ghatana-media-vision-model-digests.json").toString()));

        // Test-only injectors in front of the real tools; the launcher is configured with THESE paths.
        ffmpegFault = ModeScript.ffmpeg(injectDir, ffmpegReal);
        pythonFault = ModeScript.python(injectDir, pythonVenv);
        whisper = new MovableBinary(whisperReal, injectDir, "whisper-cli");
        whisperOriginalBytes = injectDir.resolve("whisper-cli.pristine");
        Files.copy(whisper.path(), whisperOriginalBytes, StandardCopyOption.REPLACE_EXISTING);

        try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
        sidecar = startSidecar();
        awaitSidecar();
        warmSidecar();

        installDescriptors(services);
        String childClasspath = System.getProperty("media.child.classpath", "");
        assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
        String classpath = services + java.io.File.pathSeparator + childClasspath;
        Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
        environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
        environment.put("MEDIA_LOCAL_MODEL_ROOT", data.toString());
        environment.put("MEDIA_WHISPER_CPP_BIN", whisper.path().toString());
        environment.put("MEDIA_WHISPER_CPP_THREADS", "8");
        environment.put("MEDIA_KOKORO_PYTHON", pythonFault.path().toString());
        environment.put("MEDIA_KOKORO_SCRIPT", kokoroScript.toString());
        environment.put("MEDIA_KOKORO_WORKER", "true");
        environment.put("MEDIA_KOKORO_DEVICE", "auto");
        environment.put("MEDIA_LOCAL_MODEL_PRELOAD", "true");
        environment.put("MEDIA_FFMPEG", ffmpegReal.toString());
        environment.put("MEDIA_FFPROBE", ffprobeReal.toString());
        environment.put("MEDIA_DEV_SPEECH_TIMEOUT_SECONDS", Long.toString(SPEECH_BUDGET.toSeconds()));
        environment.put("MEDIA_DEV_RENDER_TIMEOUT_SECONDS", "10");
        environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpegFault.path().toString());
        environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobeReal.toString());
        environment.put("MEDIA_LOCAL_VISION_MODELS_ROOT", models.toString());
        environment.put("MEDIA_LOCAL_VISION_SIDECAR_URL", "http://127.0.0.1:" + sidecarPort);
        environment.put("MEDIA_LOCAL_VISION_SIDECAR_TOKEN", sidecarToken);
        environment.put("MEDIA_LOCAL_VISION_TIMEOUT_SECONDS", "25");
        environment.put("MEDIA_LOCAL_MODEL_DIGEST_CACHE", digestCache.toString());
        environment.put("MEDIA_DEV_PROVIDER_CATALOG_TTL_SECONDS", "1");
        launcher = startLauncher(classpath, environment, log);
        awaitReadyPatiently(launcher, port);
    }

    /** A failed earlier journey must not leave an injected fault behind for the next one. */
    @BeforeEach
    void clearInjectedFaults() throws Exception {
        ffmpegFault.mode("ok");
        pythonFault.mode("ok");
        // A sidecar left SIGSTOPped by a failed journey must not stall the next one (SIGCONT is harmless otherwise).
        if (sidecar != null && sidecar.isAlive()) MediaDevFaultInjector.signal(sidecar.toHandle(), "CONT");
    }

    @AfterAll
    static void stopRealHost() throws Exception {
        if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
        if (sidecar != null) killTree(sidecar);
        dropSchema(POSTGRES, schema);
        deleteBucket(LOCALSTACK, bucket);
        deleteTree(services);
        deleteTree(work);
        deleteTree(injectDir);
        if (passed) Files.deleteIfExists(log);
        else System.err.println("Provider outage live failure log retained at " + log);
    }

    // =================================================================================== J-30: the catalog

    @Test
    @Order(1)
    void catalogReportsRealReadinessWithManifestFactsAndNoPathsOrProductionEligibility() throws Exception {
        String principal = "media-dev-outage-catalog-" + run;
        // Kokoro starts its worker on the first request: the catalog is UNAVAILABLE (worker not running) until then.
        // Preload warms it in the background; wait for every provider to be observed READY.
        for (String provider : List.of("whisper", "kokoro", "florence", "qwen", "ffmpeg")) {
            awaitProvider(principal, provider, "READY", Duration.ofMinutes(5));
        }
        HttpResponse<String> raw = send(port, tenant, token(principal), "GET", CATALOG, null);
        assertThat(raw.statusCode()).isEqualTo(200);
        JsonNode catalog = JSON.readTree(raw.body());
        System.out.println("J30-CATALOG " + raw.body());
        assertThat(catalog.path("schema").asString()).isEqualTo("media.dev.provider-catalog.v1");
        assertThat(catalog.path("scope").asString()).isEqualTo("DEV_ONLY");
        assertThat(catalog.path("productionEligible").asBoolean(true)).isFalse();
        assertThat(raw.body()).as("no filesystem path, endpoint or token").doesNotContain("/home/").doesNotContain("/tmp/")
                .doesNotContain(sidecarToken).doesNotContain("127.0.0.1");
        assertThat(catalog.path("providers")).hasSize(5);
        for (JsonNode provider : catalog.path("providers")) {
            assertThat(provider.path("productionEligible").asBoolean(true)).as(provider.path("providerId").asString()).isFalse();
            assertThat(provider.path("fallback").asString()).isEqualTo("NONE");
            assertThat(provider.path("lastCheckedAt").asString()).isNotBlank();
        }

        // Manifest facts read independently from the installed manifests.
        JsonNode whisperManifest = JSON.readTree(Files.readString(models.resolve("whisper-large-v3-turbo/manifest.json")));
        JsonNode whisperEntry = provider(catalog, "whisper");
        assertThat(whisperEntry.path("license").path("spdx").asString()).isEqualTo(whisperManifest.path("license").path("spdx").asString());
        assertThat(whisperEntry.path("license").path("notice").asString()).isEqualTo(whisperManifest.path("attribution").path("notice").asString());
        assertThat(whisperEntry.path("digests").path("weightsSha256").asString()).isEqualTo(weightsSha(whisperManifest));
        assertThat(whisperEntry.path("digests").path("executableSha256").asString())
                .isEqualTo(whisperManifest.path("runtime").path("executableSha256").asString())
                .isEqualTo(sha256(Files.readAllBytes(whisper.path())));
        assertThat(texts(whisperEntry.path("verifiedLanguages"))).isEqualTo(texts(whisperManifest.path("verifiedLanguages")));
        assertThat(whisperEntry.path("device").path("reported").asBoolean(true)).as("whisper-cli names no device outside inference").isFalse();

        JsonNode kokoroManifest = JSON.readTree(Files.readString(models.resolve("kokoro-82m/manifest.json")));
        JsonNode kokoroEntry = provider(catalog, "kokoro");
        List<String> manifestVoices = new ArrayList<>();
        for (JsonNode file : kokoroManifest.path("files")) {
            if ("VOICE".equals(file.path("role").asString())) {
                String name = Path.of(file.path("path").asString()).getFileName().toString();
                manifestVoices.add(name.substring(0, name.lastIndexOf('.')));
            }
        }
        java.util.Collections.sort(manifestVoices);
        assertThat(texts(kokoroEntry.path("voices"))).isEqualTo(manifestVoices);
        assertThat(kokoroEntry.path("license").path("spdx").asString()).isEqualTo("Apache-2.0");
        assertThat(kokoroEntry.path("device").path("reported").asBoolean()).isTrue();
        assertThat(kokoroEntry.path("device").path("kind").asString()).isIn("GPU", "CPU");
        assertThat(kokoroEntry.path("device").path("name").asString()).isNotBlank();

        JsonNode sidecarHealth = JSON.readTree(HttpClient.newHttpClient().send(HttpRequest.newBuilder(
                URI.create("http://127.0.0.1:" + sidecarPort + "/v1/health")).header("Authorization", "Bearer " + sidecarToken)
                .GET().build(), HttpResponse.BodyHandlers.ofString()).body());
        for (String vision : List.of("florence", "qwen")) {
            JsonNode entry = provider(catalog, vision);
            JsonNode manifest = JSON.readTree(Files.readString(models.resolve(
                    "florence".equals(vision) ? "florence-2-large/ghatana-model-manifest.json"
                            : "qwen2.5-vl-7b-instruct/ghatana-model-manifest.json")));
            assertThat(entry.path("digests").path("fileSetSha256").asString()).isEqualTo(manifest.path("fileSetSha256").asString());
            assertThat(entry.path("license").path("spdx").asString()).isEqualTo(manifest.path("spdxLicense").asString());
            assertThat(entry.path("device").path("kind").asString()).isEqualTo(sidecarHealth.path("deviceInfo").path("kind").asString());
            assertThat(entry.path("device").path("name").asString()).isEqualTo(sidecarHealth.path("deviceInfo").path("name").asString());
        }

        JsonNode ffmpegEntry = provider(catalog, "ffmpeg");
        String realVersion = firstLine(capture(ffmpegReal, "-version"));
        assertThat(realVersion).contains("version " + ffmpegEntry.path("revision").asString());
        assertThat(ffmpegEntry.path("license").path("spdx").asString()).isIn("GPL-2.0-or-later", "GPL-3.0-or-later",
                "LGPL-2.1-or-later", "LGPL-3.0-or-later", "LicenseRef-FFmpeg-nonfree");
        assertThat(ffmpegEntry.path("digests").path("ffprobeSha256").asString()).isEqualTo(sha256(Files.readAllBytes(ffprobeReal)));
    }

    // ============================================================================== J-27: render (FFmpeg)

    @Test
    @Order(2)
    void renderLaneFailsTypedWhenFfmpegCrashesHangsOrDisappearsAndRendersOnceAfterRecovery() throws Exception {
        String principal = "media-dev-outage-render-" + run;
        String t = token(principal);
        byte[] red = solidPng(0xffff0000);
        byte[] blue = solidPng(0xff0000ff);
        String redId = upload(port, tenant, principal, t, run + "-r-red", "red.png", "image/png", red);
        String blueId = upload(port, tenant, principal, t, run + "-r-blue", "blue.png", "image/png", blue);
        String workspaceId = get(port, tenant, t, "/dev/v1/context", 200).path("selectedAuthorizedWorkspaceId").asString();
        JsonNode created = post(port, tenant, t, "/dev/v1/projects", Map.of("selectedAuthorizedWorkspaceId", workspaceId,
                "title", "Outage render " + run, "requestId", "outage-project-" + run), 201);
        String projectId = created.path("project").path("projectId").asString();
        String head = post(port, tenant, t, "/dev/v1/projects/" + projectId + "/timelines", Map.of(
                "expectedHeadRevisionId", created.path("initialRevision").path("revisionId").asString(),
                "timelineId", "timeline-main"), 201).path("revision").path("revisionId").asString();
        String revisionId = post(port, tenant, t, "/dev/v1/projects/" + projectId + "/timelines/timeline-main/edits",
                Map.of("expectedHeadRevisionId", head, "edits", List.of(
                        Map.of("type", "addScene", "sceneId", "scene-main", "order", 0),
                        Map.of("type", "addTrack", "trackId", "video-main", "sceneId", "scene-main", "trackKind", "VIDEO", "order", 0),
                        stillClip("clip-red", redId, red, 0), stillClip("clip-blue", blueId, blue, 24))), 201)
                .path("revision").path("revisionId").asString();
        Map<String, Object> render = new LinkedHashMap<>(Map.of("requestId", "outage-render-" + run, "revisionId", revisionId,
                "timelineId", "timeline-main", "width", 32, "height", 24, "framesPerSecond", 10, "format", "mp4"));
        String path = "/dev/v1/projects/" + projectId + "/renders";
        int sources = countAll(principal);

        awaitProvider(principal, "ffmpeg", "READY", Duration.ofSeconds(30));

        // 1. The encode crashes (SIGSEGV, exit 139): the process may have run, so UNKNOWN; nothing registered.
        ffmpegFault.mode("crash");
        HttpResponse<String> crashed = send(port, tenant, t, "POST", path, JSON.writeValueAsString(render));
        outage(crashed, 503, "RENDER_OUTCOME_UNKNOWN", "UNKNOWN");
        assertThat(countAll(principal)).as("a crashed render registers nothing").isEqualTo(sources);

        // 2. The encode hangs: TIMEOUT (504) within the render budget; the hung process is killed, not abandoned.
        ffmpegFault.mode("hang");
        long started = System.nanoTime();
        HttpResponse<String> hung = send(port, tenant, t, "POST", path, JSON.writeValueAsString(render));
        outage(hung, 504, "RENDER_TIMEOUT", "TIMEOUT");
        assertThat(Duration.ofNanos(System.nanoTime() - started)).as("bounded by MEDIA_DEV_RENDER_TIMEOUT_SECONDS")
                .isBetween(Duration.ofSeconds(9), Duration.ofSeconds(40));
        MediaDevFaultInjector.awaitNoDescendant(launcher, "sleep 3600", Duration.ofSeconds(15));
        assertThat(countAll(principal)).isEqualTo(sources);

        // 3. FFmpeg is absent: UNAVAILABLE (nothing ran) and the catalog follows the real binary.
        ffmpegFault.mode("ok");
        ffmpegFault.removeAway();
        HttpResponse<String> absent = send(port, tenant, t, "POST", path, JSON.writeValueAsString(render));
        outage(absent, 503, "RENDER_CODEC_UNAVAILABLE", "UNAVAILABLE");
        assertThat(countAll(principal)).isEqualTo(sources);
        JsonNode down = awaitProvider(principal, "ffmpeg", "UNAVAILABLE", Duration.ofSeconds(30));
        assertThat(down.path("reason").asString()).isEqualTo("FFMPEG_BINARY_MISSING");

        // 4. Recovery: the binary is back, the catalog says READY, and the same requestId renders exactly once.
        ffmpegFault.restore();
        awaitProvider(principal, "ffmpeg", "READY", Duration.ofSeconds(30));
        JsonNode rendered = post(port, tenant, t, path, render, 201);
        assertThat(rendered.path("artifact").path("contentType").asString()).isEqualTo("video/mp4");
        assertThat(countAll(principal)).as("one registration after recovery").isEqualTo(sources + 1);
        JsonNode replay = post(port, tenant, t, path, render, 200);
        assertThat(replay.path("replayed").asBoolean()).isTrue();
        assertThat(replay.path("artifact").path("sha256").asString()).isEqualTo(rendered.path("artifact").path("sha256").asString());
        assertThat(countAll(principal)).as("a replay registers nothing").isEqualTo(sources + 1);
    }

    // ==================================================================== J-27: speech synthesis (Kokoro)

    @Test
    @Order(3)
    void synthesisLaneFailsTypedWhenTheKokoroWorkerDiesCannotRestartOrHangsAndRegistersOnceAfterRecovery() throws Exception {
        String principal = "media-dev-outage-speech-" + run;
        String t = token(principal);
        // Real baseline: a spoken source that the STT journey below reuses (about a minute of speech).
        String sourceText = speechText(14);
        JsonNode base = post(port, tenant, t, "/dev/v1/speech/syntheses", Map.of("requestId", "s-base-" + run, "text", sourceText), 201);
        speechArtifactId = base.path("artifact").path("artifactId").asString();
        speechVersion = base.path("artifact").path("artifactVersionId").asString();
        assertThat(base.path("artifact").path("contentType").asString()).isEqualTo("audio/wav");
        int registered = countAll(principal);
        awaitProvider(principal, "kokoro", "READY", Duration.ofSeconds(60));

        // 1. The worker is SIGSEGV'd mid-synthesis and its interpreter can no longer start: the run may have happened,
        //    so UNKNOWN (never success); nothing is registered; the ledger row is RELEASED so a retry runs again.
        pythonFault.mode("refuse");
        String unknownId = "s-unknown-" + run;
        Map<String, Object> unknownBody = Map.of("requestId", unknownId, "text", speechText(21));
        CompletableFuture<HttpResponse<String>> inFlight = async(() -> send(port, tenant, t, "POST", "/dev/v1/speech/syntheses",
                JSON.writeValueAsString(unknownBody)));
        ProcessHandle worker = MediaDevFaultInjector.awaitDescendant(launcher, "kokoro_worker.py", Duration.ofSeconds(30));
        // Let the request reach the worker first: a kill before dispatch would (truthfully) be UNAVAILABLE, not UNKNOWN.
        Thread.sleep(1_500);
        MediaDevFaultInjector.signal(worker, "SEGV");
        HttpResponse<String> lost = inFlight.get(150, TimeUnit.SECONDS);
        outage(lost, 503, "SPEECH_OUTCOME_UNKNOWN", "UNKNOWN");
        assertThat(countAll(principal)).as("an UNKNOWN synthesis registers nothing").isEqualTo(registered);
        assertThat(ledger(principal, "speech.synthesize", unknownId)).hasValueSatisfying(row -> assertThat(row.state()).isEqualTo("RELEASED"));
        JsonNode down = awaitProvider(principal, "kokoro", "UNAVAILABLE", Duration.ofSeconds(30));
        assertThat(down.path("reason").asString()).isEqualTo("WORKER_NOT_RUNNING");

        // 2. Nothing can start the worker: UNAVAILABLE (nothing ran), then the worker's own cool-down. Still no success.
        String unavailableId = "s-unavailable-" + run;
        HttpResponse<String> refused = send(port, tenant, t, "POST", "/dev/v1/speech/syntheses",
                JSON.writeValueAsString(Map.of("requestId", unavailableId, "text", "Nobody can speak right now.")));
        outage(refused, 503, "SPEECH_RUNTIME_UNAVAILABLE", "UNAVAILABLE");
        assertThat(countAll(principal)).isEqualTo(registered);

        // 3. Recovery. The interpreter works again; while the worker cools down the lane keeps answering UNAVAILABLE
        //    (typed, nothing registered) and then the same requestId runs once.
        pythonFault.mode("ok");
        HttpResponse<String> recovered = retryUntilCreated("/dev/v1/speech/syntheses", unknownBody, t, "SPEECH_RUNTIME_UNAVAILABLE",
                "UNAVAILABLE", Duration.ofSeconds(180));
        assertThat(JSON.readTree(recovered.body()).path("replayed").asBoolean()).isFalse();
        assertThat(countAll(principal)).as("exactly one registration after recovery").isEqualTo(registered + 1);
        HttpResponse<String> replay = send(port, tenant, t, "POST", "/dev/v1/speech/syntheses", JSON.writeValueAsString(unknownBody));
        assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
        assertThat(JSON.readTree(replay.body()).path("replayed").asBoolean()).isTrue();
        assertThat(countAll(principal)).isEqualTo(registered + 1);
        assertThat(ledger(principal, "speech.synthesize", unknownId)).hasValueSatisfying(row -> {
            assertThat(row.state()).isEqualTo("COMPLETED");
            assertThat(row.attempts()).as("the failed run and the recovered run").isGreaterThanOrEqualTo(2);
        });
        awaitProvider(principal, "kokoro", "READY", Duration.ofSeconds(60));
        registered = countAll(principal);

        // 4. The worker hangs (SIGSTOP: the port stays open, nothing answers): TIMEOUT, the hung worker is killed and
        //    nothing is registered; the same requestId then runs once on a fresh worker.
        ProcessHandle running = MediaDevFaultInjector.awaitDescendant(launcher, "kokoro_worker.py", Duration.ofSeconds(30));
        MediaDevFaultInjector.signal(running, "STOP");
        String timeoutId = "s-timeout-" + run;
        Map<String, Object> timeoutBody = Map.of("requestId", timeoutId, "text", "This sentence will not be finished in time.");
        long started = System.nanoTime();
        HttpResponse<String> timedOut = send(port, tenant, t, "POST", "/dev/v1/speech/syntheses", JSON.writeValueAsString(timeoutBody));
        outage(timedOut, 504, "SPEECH_TIMEOUT", "TIMEOUT");
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isBetween(SPEECH_BUDGET.minusSeconds(2), SPEECH_BUDGET.plusSeconds(25));
        MediaDevFaultInjector.awaitNoDescendant(launcher, "kokoro_worker.py", Duration.ofSeconds(20));
        assertThat(countAll(principal)).isEqualTo(registered);
        assertThat(ledger(principal, "speech.synthesize", timeoutId)).hasValueSatisfying(row -> assertThat(row.state()).isEqualTo("RELEASED"));
        HttpResponse<String> again = retryUntilCreated("/dev/v1/speech/syntheses", timeoutBody, t, "SPEECH_RUNTIME_UNAVAILABLE",
                "UNAVAILABLE", Duration.ofSeconds(180));
        assertThat(again.statusCode()).isEqualTo(201);
        assertThat(countAll(principal)).isEqualTo(registered + 1);
    }

    // ============================================================= J-27: transcription and captions (Whisper)

    @Test
    @Order(4)
    void transcriptionAndCaptionLanesFailTypedWhenWhisperCrashesHangsIsMissingOrChangedAndRunOnceAfterRecovery() throws Exception {
        String principal = "media-dev-outage-speech-" + run;
        String t = token(principal);
        assertThat(speechArtifactId).as("the synthesized source of the previous journey").isNotNull();
        attest(t, speechArtifactId, speechVersion);
        awaitProvider(principal, "whisper", "READY", Duration.ofSeconds(60));
        int registered = countAll(principal);
        String path = "/dev/v1/speech/transcriptions";
        String needle = whisper.path().toString();

        // 1. whisper-cli crashes mid-run (SIGSEGV, exit 139): UNKNOWN, nothing registered.
        String id = "t-main-" + run;
        Map<String, Object> body = Map.of("requestId", id, "artifactId", speechArtifactId, "artifactVersionId", speechVersion);
        CompletableFuture<HttpResponse<String>> inFlight = async(() -> send(port, tenant, t, "POST", path, JSON.writeValueAsString(body)));
        ProcessHandle process = MediaDevFaultInjector.awaitDescendant(launcher, needle, Duration.ofSeconds(60));
        MediaDevFaultInjector.signal(process, "SEGV");
        outage(inFlight.get(120, TimeUnit.SECONDS), 503, "SPEECH_OUTCOME_UNKNOWN", "UNKNOWN");
        assertThat(countAll(principal)).as("a crashed recognizer registers nothing").isEqualTo(registered);
        assertThat(ledger(principal, "speech.transcribe", id)).hasValueSatisfying(row -> assertThat(row.state()).isEqualTo("RELEASED"));

        // 2. whisper-cli hangs (SIGSTOP): TIMEOUT within the speech budget and the process tree is killed.
        String hungId = "t-hung-" + run;
        Map<String, Object> hungBody = Map.of("requestId", hungId, "artifactId", speechArtifactId, "artifactVersionId", speechVersion);
        long started = System.nanoTime();
        CompletableFuture<HttpResponse<String>> hung = async(() -> send(port, tenant, t, "POST", path, JSON.writeValueAsString(hungBody)));
        MediaDevFaultInjector.signal(MediaDevFaultInjector.awaitDescendant(launcher, needle, Duration.ofSeconds(60)), "STOP");
        outage(hung.get(150, TimeUnit.SECONDS), 504, "SPEECH_TIMEOUT", "TIMEOUT");
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isBetween(SPEECH_BUDGET.minusSeconds(5), SPEECH_BUDGET.plusSeconds(25));
        MediaDevFaultInjector.awaitNoDescendant(launcher, needle, Duration.ofSeconds(20));
        assertThat(countAll(principal)).isEqualTo(registered);

        // 3. The binary is missing: UNAVAILABLE (nothing ran); the catalog follows.
        whisper.removeAway();
        outage(send(port, tenant, t, "POST", path, JSON.writeValueAsString(Map.of("requestId", "t-absent-" + run,
                "artifactId", speechArtifactId, "artifactVersionId", speechVersion))), 503, "SPEECH_RUNTIME_UNAVAILABLE", "UNAVAILABLE");
        assertThat(awaitProvider(principal, "whisper", "UNAVAILABLE", Duration.ofSeconds(30)).path("reason").asString())
                .isEqualTo("BINARY_MISSING");
        assertThat(countAll(principal)).isEqualTo(registered);

        // 4. A different binary appears at the pinned path: WITHDRAWN (it was READY, its digest changed); no run.
        Files.write(whisper.path(), Files.readAllBytes(whisperOriginalBytes));
        Files.write(whisper.path(), new byte[] {0}, java.nio.file.StandardOpenOption.APPEND);
        Files.setPosixFilePermissions(whisper.path(), java.nio.file.attribute.PosixFilePermissions.fromString("rwxr-xr-x"));
        JsonNode withdrawn = awaitProvider(principal, "whisper", "WITHDRAWN", Duration.ofSeconds(30));
        assertThat(withdrawn.path("reason").asString()).isEqualTo("BINARY_CHANGED");
        outage(send(port, tenant, t, "POST", path, JSON.writeValueAsString(Map.of("requestId", "t-changed-" + run,
                "artifactId", speechArtifactId, "artifactVersionId", speechVersion))), 503, "SPEECH_RUNTIME_UNAVAILABLE", "UNAVAILABLE");
        assertThat(countAll(principal)).isEqualTo(registered);
        Files.delete(whisper.path());
        Files.copy(whisperOriginalBytes, whisper.path());
        Files.setPosixFilePermissions(whisper.path(), java.nio.file.attribute.PosixFilePermissions.fromString("rwxr-xr-x"));

        // 5. Recovery: READY again, and the same requestId runs and registers (transcript + WebVTT) exactly once.
        awaitProvider(principal, "whisper", "READY", Duration.ofSeconds(60));
        JsonNode done = post(port, tenant, t, path, body, 201);
        assertThat(done.path("text").asString()).isNotBlank();
        assertThat(countAll(principal)).as("one transcript and one WebVTT").isEqualTo(registered + 2);
        JsonNode replay = post(port, tenant, t, path, body, 200);
        assertThat(replay.path("replayed").asBoolean()).isTrue();
        assertThat(countAll(principal)).isEqualTo(registered + 2);
        assertThat(ledger(principal, "speech.transcribe", id)).hasValueSatisfying(row -> {
            assertThat(row.state()).isEqualTo("COMPLETED");
            assertThat(row.attempts()).isGreaterThanOrEqualTo(2);
        });

        // 6. Captions: human correction calls no model, so it keeps working while Whisper is gone.
        String captionId = done.path("captions").path("artifact").path("artifactId").asString();
        String captionVersion = done.path("captions").path("artifact").path("artifactVersionId").asString();
        whisper.removeAway();
        awaitProvider(principal, "whisper", "UNAVAILABLE", Duration.ofSeconds(30));
        JsonNode corrected = post(port, tenant, t, "/dev/v1/captions/corrections", Map.of("requestId", "c-" + run,
                "baseArtifactId", captionId, "expectedVersionId", captionVersion,
                "cues", List.of(Map.of("startMillis", 0, "endMillis", 1500, "text", "Corrected while Whisper was down"))), 201);
        assertThat(corrected.path("artifact").path("contentType").asString()).isEqualTo("text/vtt");
        whisper.restore();
        awaitProvider(principal, "whisper", "READY", Duration.ofSeconds(60));
    }

    // ============================================================================== J-27: vision (Florence-2)

    @Test
    @Order(5)
    void visionLanesFailTypedWhenTheSidecarHangsDiesOrIsKilledMidRunAndRegisterOnceAfterRecovery() throws Exception {
        String principal = "media-dev-outage-vision-" + run;
        String t = token(principal);
        Path videoWork = Files.createDirectory(work.resolve("vision"));
        byte[] video = TrackingVideoFixture.generate(ffmpegReal, videoWork, false);
        String videoId = upload(port, tenant, principal, t, run + "-video", "motion.mp4", "video/mp4", video);
        String version = "sha256:" + sha256(video);
        attest(t, videoId, version);
        int sources = countAll(principal);
        String analyses = "/dev/v1/vision/analyses";
        String tracks = "/dev/v1/vision/tracks";
        String rois = "/dev/v1/vision/roi-analyses";
        awaitProvider(principal, "florence", "READY", Duration.ofSeconds(30));

        // Real baseline analysis proves the lane works before any fault.
        JsonNode analysed = post(port, tenant, t, analyses, Map.of("requestId", "v-base-" + run, "artifactId", videoId,
                "artifactVersionId", version, "tasks", List.of("detect"), "frameTimeMs", 500), 201);
        assertThat(analysed.path("artifact").path("contentType").asString()).isEqualTo("application/json");
        sources = countAll(principal);

        // 1. The sidecar hangs (SIGSTOP; the port stays open and the kernel still accepts the connection): the lane
        //    reports TIMEOUT (504) and the catalog DEGRADED. The lane request goes first: every abandoned catalog probe
        //    would otherwise queue in the stopped process's small accept backlog and later requests would then fail to
        //    connect at all, which is (truthfully) UNAVAILABLE because the request was never delivered.
        MediaDevFaultInjector.signal(sidecar.toHandle(), "STOP");
        long started = System.nanoTime();
        HttpResponse<String> timedOut = send(port, tenant, t, "POST", analyses, JSON.writeValueAsString(Map.of(
                "requestId", "v-timeout-" + run, "artifactId", videoId, "artifactVersionId", version, "tasks", List.of("detect"),
                "frameTimeMs", 500)));
        outage(timedOut, 504, "VISION_TIMEOUT", "TIMEOUT");
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isBetween(Duration.ofSeconds(20), Duration.ofSeconds(60));
        assertThat(countAll(principal)).as("a timed-out analysis registers nothing").isEqualTo(sources);
        JsonNode degraded = awaitProvider(principal, "florence", "DEGRADED", Duration.ofSeconds(40));
        assertThat(degraded.path("reason").asString()).isEqualTo("SIDECAR_HEALTH_TIMEOUT");
        MediaDevFaultInjector.signal(sidecar.toHandle(), "CONT");
        awaitProvider(principal, "florence", "READY", Duration.ofSeconds(40));

        // 2. The sidecar is killed: UNAVAILABLE (nothing ran) for analysis, tracking and ROI; the catalog says so.
        killTree(sidecar);
        JsonNode gone = awaitProvider(principal, "florence", "UNAVAILABLE", Duration.ofSeconds(30));
        assertThat(gone.path("reason").asString()).isEqualTo("SIDECAR_UNREACHABLE");
        assertThat(awaitProvider(principal, "qwen", "UNAVAILABLE", Duration.ofSeconds(30)).path("reason").asString()).isEqualTo("SIDECAR_UNREACHABLE");
        Map<String, Object> analysisBody = Map.of("requestId", "v-down-" + run, "artifactId", videoId, "artifactVersionId", version,
                "tasks", List.of("detect"), "frameTimeMs", 500);
        Map<String, Object> trackBody = Map.of("requestId", "v-track-" + run, "artifactId", videoId, "artifactVersionId", version, "maxFrames", 64);
        Map<String, Object> roiBody = Map.of("requestId", "v-roi-" + run, "artifactId", videoId, "artifactVersionId", version,
                "tasks", List.of("detect"), "roi", Map.of("x", 0, "y", 200, "width", 300, "height", 150));
        outage(send(port, tenant, t, "POST", analyses, JSON.writeValueAsString(analysisBody)), 503, "LOCAL_VISION_UNAVAILABLE", "UNAVAILABLE");
        outage(send(port, tenant, t, "POST", tracks, JSON.writeValueAsString(trackBody)), 503, "LOCAL_VISION_UNAVAILABLE", "UNAVAILABLE");
        outage(send(port, tenant, t, "POST", rois, JSON.writeValueAsString(roiBody)), 503, "LOCAL_VISION_UNAVAILABLE", "UNAVAILABLE");
        assertThat(countAll(principal)).isEqualTo(sources);

        // 3. Restart; the sidecar dies again part-way through tracking: UNKNOWN (frames already ran), nothing registered.
        sidecar = startSidecar();
        awaitSidecar();
        warmSidecar();
        awaitProvider(principal, "florence", "READY", Duration.ofSeconds(60));
        CompletableFuture<HttpResponse<String>> tracking = async(() -> send(port, tenant, t, "POST", tracks, JSON.writeValueAsString(trackBody)));
        Thread.sleep(2_500);
        killTree(sidecar);
        HttpResponse<String> midRun = tracking.get(120, TimeUnit.SECONDS);
        JsonNode error = outage(midRun, 503, "VISION_OUTCOME_UNKNOWN", "UNKNOWN");
        assertThat(error.path("details").path("framesCompleted").asInt()).isLessThan(error.path("details").path("framesPlanned").asInt());
        assertThat(countAll(principal)).as("a lost tracking run registers nothing").isEqualTo(sources);
        assertThat(ledger(principal, "vision.track", "v-track-" + run)).hasValueSatisfying(row -> assertThat(row.state()).isEqualTo("RELEASED"));

        // 4. Recovery: the same requestIds now run exactly once each and a repeat replays.
        sidecar = startSidecar();
        awaitSidecar();
        warmSidecar();
        awaitProvider(principal, "florence", "READY", Duration.ofSeconds(60));
        JsonNode tracked = post(port, tenant, t, tracks, trackBody, 201);
        assertThat(tracked.path("artifact").path("contentType").asString()).isEqualTo("application/json");
        JsonNode roi = post(port, tenant, t, rois, roiBody, 201);
        JsonNode analysedAgain = post(port, tenant, t, analyses, analysisBody, 201);
        assertThat(countAll(principal)).as("one registration per recovered request").isEqualTo(sources + 3);
        assertThat(post(port, tenant, t, tracks, trackBody, 200).path("replayed").asBoolean()).isTrue();
        assertThat(post(port, tenant, t, rois, roiBody, 200).path("replayed").asBoolean()).isTrue();
        assertThat(countAll(principal)).isEqualTo(sources + 3);
        assertThat(ledger(principal, "vision.track", "v-track-" + run)).hasValueSatisfying(row -> {
            assertThat(row.state()).isEqualTo("COMPLETED");
            assertThat(row.attempts()).isGreaterThanOrEqualTo(3);
        });
        assertThat(roi.path("outputId").asString()).isNotBlank();
        assertThat(analysedAgain.path("outputId").asString()).isNotBlank();
    }

    // ============================================================== J-27: grounded answers (STT + vision + Qwen)

    @Test
    @Order(6)
    void groundedLaneReportsAnUnavailableEvidenceProviderAsUnavailableAndAnswersOnceAfterRecovery() throws Exception {
        String principal = "media-dev-outage-grounded-" + run;
        String t = token(principal);
        assertThat(speechArtifactId).isNotNull();
        // Source video: the real Kokoro narration plus a rendered title card, muxed by the real FFmpeg.
        Path groundedWork = Files.createDirectory(work.resolve("grounded"));
        byte[] narration = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, "media-dev-outage-speech-" + run, speechArtifactId));
        Files.write(groundedWork.resolve("speech.wav"), narration);
        writeSceneFrame(groundedWork.resolve("frame.png"));
        Process mux = new ProcessBuilder(ffmpegReal.toString(), "-nostdin", "-v", "error", "-y", "-loop", "1", "-framerate", "10",
                "-i", groundedWork.resolve("frame.png").toString(), "-i", groundedWork.resolve("speech.wav").toString(), "-t", "12",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart",
                groundedWork.resolve("source.mp4").toString()).redirectErrorStream(true).start();
        String muxOutput = new String(mux.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(mux.waitFor(120, TimeUnit.SECONDS)).isTrue();
        assertThat(mux.exitValue()).as(muxOutput).isZero();
        byte[] mp4 = Files.readAllBytes(groundedWork.resolve("source.mp4"));
        String videoId = upload(port, tenant, principal, t, run + "-grounded", "grounded.mp4", "video/mp4", mp4);
        String version = "sha256:" + sha256(mp4);
        attest(t, videoId, version);
        int sources = countAll(principal);
        String path = "/dev/v1/grounded-answers";
        Map<String, Object> body = Map.of("requestId", "g-main-" + run, "artifactId", videoId, "artifactVersionId", version,
                "question", "What text is shown on screen?");
        awaitProvider(principal, "florence", "READY", Duration.ofSeconds(60));
        awaitProvider(principal, "whisper", "READY", Duration.ofSeconds(60));

        // 1. The vision sidecar is gone: the vision evidence child is UNAVAILABLE, so no answer and nothing registered.
        killTree(sidecar);
        awaitProvider(principal, "florence", "UNAVAILABLE", Duration.ofSeconds(30));
        JsonNode noVision = outage(send(port, tenant, t, "POST", path, JSON.writeValueAsString(body)), 503, "GROUNDED_UNAVAILABLE", "UNAVAILABLE");
        assertThat(noVision.path("details").toString()).contains("VISION").contains("UNAVAILABLE");
        assertThat(countAll(principal)).isEqualTo(sources);
        // allowPartial is an explicit caller choice, never a model substitution: with no vision there is no frame to answer from.
        HttpResponse<String> partial = send(port, tenant, t, "POST", path, JSON.writeValueAsString(withPartial(body)));
        assertThat(partial.statusCode()).as(partial.body()).isEqualTo(422);
        assertThat(partial.body()).contains("GROUNDED_NO_EVIDENCE");
        assertThat(countAll(principal)).isEqualTo(sources);

        // 2. Vision is back but Whisper is missing: the speech evidence child is UNAVAILABLE.
        sidecar = startSidecar();
        awaitSidecar();
        warmSidecar();
        awaitProvider(principal, "florence", "READY", Duration.ofSeconds(60));
        whisper.removeAway();
        awaitProvider(principal, "whisper", "UNAVAILABLE", Duration.ofSeconds(30));
        JsonNode noSpeech = outage(send(port, tenant, t, "POST", path, JSON.writeValueAsString(body)), 503, "GROUNDED_UNAVAILABLE", "UNAVAILABLE");
        assertThat(noSpeech.path("details").toString()).contains("STT").contains("UNAVAILABLE");
        assertThat(countAll(principal)).isEqualTo(sources);

        // 3. Recovery with the real Qwen2.5-VL answering model: the same requestId answers once; a repeat replays.
        whisper.restore();
        awaitProvider(principal, "whisper", "READY", Duration.ofSeconds(60));
        // A freshly restarted sidecar loads the 7B model on its first question, which exceeds the short per-call
        // deadline this journey configures for its timeout cases; load it directly so the deadline is not the subject.
        warmQwen();
        // The GPU is shared and nearly full with Qwen, Florence and other processes: free this journey's own Kokoro
        // worker (it restarts on demand) so Whisper's Vulkan allocation can succeed. If it still fails, the only
        // acceptable answer is the typed UNKNOWN with nothing registered, and the same requestId is retried.
        java.util.Optional<ProcessHandle> idleWorker = MediaDevFaultInjector.findDescendant(launcher, "kokoro_worker.py");
        if (idleWorker.isPresent()) MediaDevFaultInjector.signal(idleWorker.get(), "KILL");
        HttpResponse<String> answered = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            answered = send(port, tenant, t, "POST", path, JSON.writeValueAsString(body));
            if (answered.statusCode() == 201) break;
            outage(answered, 503, "GROUNDED_OUTCOME_UNKNOWN", "UNKNOWN");
            assertThat(countAll(principal)).isEqualTo(sources);
        }
        assertThat(answered.statusCode()).as(answered.body()).isEqualTo(201);
        assertThat(countAll(principal)).as("one grounded answer registered").isEqualTo(sources + 1);
        HttpResponse<String> replay = send(port, tenant, t, "POST", path, JSON.writeValueAsString(body));
        assertThat(replay.statusCode()).isEqualTo(200);
        assertThat(countAll(principal)).isEqualTo(sources + 1);
        assertThat(ledger(principal, "grounded.answer", "g-main-" + run)).hasValueSatisfying(row -> assertThat(row.state()).isEqualTo("COMPLETED"));
    }

    // =================================================================== live browser on the provider status page

    @Test
    @Order(7)
    void aRealChromiumSessionOnTheProviderStatusPageSeesTheOutageAndTheRecoveryLive() throws Exception {
        String principal = "media-dev-outage-browser-" + run;
        // The Kokoro worker starts on demand: make sure it is running before the page is opened.
        retryUntilCreated("/dev/v1/speech/syntheses", Map.of("requestId", "b-warm-" + run, "text", "Warming the voice."),
                token(principal), "SPEECH_RUNTIME_UNAVAILABLE", "UNAVAILABLE", Duration.ofMinutes(3));
        for (String provider : List.of("whisper", "kokoro", "florence", "qwen", "ffmpeg")) {
            awaitProvider(principal, provider, "READY", Duration.ofMinutes(3));
        }
        Path repoRoot = findMediaRepoRoot();
        Path browserScript = repoRoot.resolve("apps/media-experience-explorer/test/dev-provider-status-live-browser.mjs");
        assertThat(browserScript).exists();
        Path viteBinary = findViteBinary(repoRoot);
        Path playwrightModule = findPlaywrightModule(repoRoot);
        String viteVersion = packageVersion(viteBinary);
        assertThat(viteVersion).isIn("7.3.1", "8.3.0");
        ProcessBuilder builder = new ProcessBuilder("node", browserScript.toString());
        builder.directory(repoRoot.toFile());
        builder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
        Map<String, String> env = builder.environment();
        env.put("MEDIA_DEV_PROVIDER_BROWSER_TOKEN", longToken(principal));
        env.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(port));
        env.put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
        env.put("MEDIA_DEV_VITE_VERSION", viteVersion);
        env.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
        Process browser = builder.start();
        try (BufferedReader output = new BufferedReader(new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8));
                BufferedWriter input = new BufferedWriter(new OutputStreamWriter(browser.getOutputStream(), StandardCharsets.UTF_8))) {
            JsonNode connected = readBrowserEvent(browser, output, "connected", 240);
            // The page shows what the host's own catalog says.
            JsonNode catalog = get(port, tenant, token(principal), CATALOG, 200);
            for (JsonNode provider : catalog.path("providers")) {
                assertThat(connected.path("states").path(provider.path("providerId").asString()).asString())
                        .isEqualTo(provider.path("state").asString());
            }

            // The Kokoro worker is killed while the page is open; the page must show UNAVAILABLE without a reload.
            ProcessHandle worker = MediaDevFaultInjector.awaitDescendant(launcher, "kokoro_worker.py", Duration.ofSeconds(30));
            MediaDevFaultInjector.signal(worker, "KILL");
            input.write("outage kokoro\n");
            input.flush();
            JsonNode outage = readBrowserEvent(browser, output, "outage-observed", 150);
            assertThat(outage.path("state").asString()).isEqualTo("UNAVAILABLE");
            assertThat(outage.path("text").asString()).contains("WORKER_NOT_RUNNING");

            // Recovery: the next synthesis restarts the worker; the page then shows READY.
            JsonNode synthesis = null;
            String tSpeech = token(principal);
            for (int attempt = 0; attempt < 40 && synthesis == null; attempt++) {
                HttpResponse<String> response = send(port, tenant, tSpeech, "POST", "/dev/v1/speech/syntheses",
                        JSON.writeValueAsString(Map.of("requestId", "b-recover-" + run, "text", "The worker is back.")));
                if (response.statusCode() == 201) synthesis = JSON.readTree(response.body());
                else Thread.sleep(3_000);
            }
            assertThat(synthesis).as("the worker restarts on the next synthesis").isNotNull();
            input.write("recovered\n");
            input.flush();
            readBrowserEvent(browser, output, "recovery-observed", 150);
            readBrowserEvent(browser, output, "done", 60);
            assertThat(browser.waitFor(60, TimeUnit.SECONDS)).isTrue();
            assertThat(browser.exitValue()).as("live browser script must pass; see " + log).isZero();
        } finally {
            if (browser.isAlive()) stopProcessTree(browser);
        }
    }

    // ============================================================================================== metrics

    @Test
    @Order(8)
    void metricsExposeReadinessAndOutageCountersWithBoundedLabelsAndNoSecrets() throws Exception {
        HttpResponse<String> scrape = HttpClient.newHttpClient().send(HttpRequest.newBuilder(
                URI.create("http://127.0.0.1:" + port + "/metrics")).header("Accept", "text/plain;version=0.0.4;charset=utf-8")
                .GET().build(), HttpResponse.BodyHandlers.ofString());
        assertThat(scrape.statusCode()).isEqualTo(200);
        String text = scrape.body();
        System.out.println("J27-METRICS " + text.lines().filter(line -> line.startsWith("media_dev_provider")).toList());
        for (String provider : List.of("whisper", "kokoro", "florence", "qwen", "ffmpeg")) {
            assertThat(text).contains("media_dev_provider_state{").contains("provider=\"" + provider + "\"");
        }
        assertThat(text).containsPattern("media_dev_provider_state\\{[^}]*provider=\"whisper\"[^}]*state=\"ready\"[^}]*\\} 1\\.0");
        for (String expected : List.of("lane=\"render\",outcome=\"unknown\"", "lane=\"render\",outcome=\"timeout\"",
                "lane=\"render\",outcome=\"unavailable\"", "lane=\"speech_synthesize\"", "lane=\"vision\",outcome=\"timeout\"",
                "lane=\"vision\",outcome=\"unknown\"", "lane=\"vision\",outcome=\"unavailable\"", "lane=\"grounded\",outcome=\"unavailable\"")) {
            assertThat(text).as(expected).containsPattern("media_dev_provider_outages_total\\{[^}]*" + java.util.regex.Pattern.quote(expected) + "[^}]*\\} [1-9]");
        }
        for (String line : text.lines().filter(l -> l.startsWith("media_dev_provider")).toList()) {
            assertThat(line).doesNotContain(sidecarToken).doesNotContain("/home/").doesNotContain("http").doesNotContain("secret");
        }
        passed = true;
    }

    // =================================================================================================== helpers

    private static CompletableFuture<HttpResponse<String>> async(ThrowingSupplier<HttpResponse<String>> call) {
        return CompletableFuture.supplyAsync(() -> {
            try { return call.get(); } catch (Exception failure) { throw new IllegalStateException(failure); }
        });
    }

    @FunctionalInterface
    private interface ThrowingSupplier<T> { T get() throws Exception; }

    /** Asserts a typed provider-outage refusal: status, code, shared outcome vocabulary, no fallback, no output. */
    private static JsonNode outage(HttpResponse<String> response, int status, String code, String outcome) throws Exception {
        assertThat(response.statusCode()).as(response.body()).isEqualTo(status);
        JsonNode body = JSON.readTree(response.body());
        JsonNode error = body.path("error");
        assertThat(error.path("code").asString()).as(response.body()).isEqualTo(code);
        assertThat(error.path("details").path("outcome").asString()).as(response.body()).isEqualTo(outcome);
        assertThat(error.path("details").path("fallback").asString()).isEqualTo("NONE");
        assertThat(body.has("artifact") || body.has("outputId") || body.has("renderId") || body.has("transcript"))
                .as("an outage is never a success: " + response.body()).isFalse();
        return error;
    }

    private static HttpResponse<String> retryUntilCreated(String path, Map<String, Object> body, String token, String interimCode,
                                                          String interimOutcome, Duration timeout) throws Exception {
        long deadline = System.nanoTime() + timeout.toNanos();
        HttpResponse<String> last = null;
        while (System.nanoTime() < deadline) {
            last = send(port, tenant, token, "POST", path, JSON.writeValueAsString(body));
            if (last.statusCode() == 201) return last;
            // Until the provider is usable again the only acceptable answer is the typed outage.
            outage(last, 503, interimCode, interimOutcome);
            Thread.sleep(3_000);
        }
        throw new AssertionError("the lane did not recover within " + timeout + "; last=" + (last == null ? null : last.body()));
    }

    private static Map<String, Object> withPartial(Map<String, Object> body) {
        Map<String, Object> copy = new LinkedHashMap<>(body);
        copy.put("requestId", body.get("requestId") + "-partial");
        copy.put("allowPartial", true);
        return copy;
    }

    private static JsonNode provider(JsonNode catalog, String id) {
        for (JsonNode provider : catalog.path("providers")) if (id.equals(provider.path("providerId").asString())) return provider;
        throw new AssertionError("provider " + id + " is not in the catalog");
    }

    /** Polls the catalog (TTL 1 s) until a provider is observed in the given state; returns that provider row. */
    private static JsonNode awaitProvider(String principal, String id, String state, Duration timeout) throws Exception {
        long deadline = System.nanoTime() + timeout.toNanos();
        String last = "";
        while (System.nanoTime() < deadline) {
            JsonNode entry = provider(get(port, tenant, token(principal), CATALOG, 200), id);
            last = entry.path("state").asString() + "/" + entry.path("reason").asString();
            if (state.equals(entry.path("state").asString())) return entry;
            Thread.sleep(700);
        }
        throw new AssertionError("provider " + id + " did not become " + state + " within " + timeout + "; last observed " + last);
    }

    private static String token(String principal) throws Exception {
        long[] age = TOKEN_AGE.get(principal);
        if (age == null || System.nanoTime() - age[0] > Duration.ofSeconds(120).toNanos()) {
            TOKENS.put(principal, issueDevToken(tenant, principal));
            TOKEN_AGE.put(principal, new long[] {System.nanoTime()});
        }
        return TOKENS.get(principal);
    }

    private static String longToken(String principal) throws Exception {
        Path repoRoot = findMediaRepoRoot();
        List<String> command = new ArrayList<>(List.of("node", "scripts/media-dev-identity-token.mjs", "--tenant", tenant,
                "--subject", principal, "--expires-in", "290"));
        for (String permission : List.of("media:project:dev:read", "media:project:dev:write", "media:artifact:create",
                "media:artifact:read")) { command.add("--permission"); command.add(permission); }
        ProcessBuilder builder = new ProcessBuilder(command).directory(repoRoot.toFile()).redirectErrorStream(true);
        builder.environment().put("MEDIA_PROFILE", "dev");
        builder.environment().put("MEDIA_RUNTIME_ENVIRONMENT", "dev");
        builder.environment().put("MEDIA_DEV_IDENTITY_ENABLED", "true");
        builder.environment().put("MEDIA_DEV_JWT_HMAC_SECRET", DEV_SECRET);
        Process issuer = builder.start();
        String out = new String(issuer.getInputStream().readAllBytes(), StandardCharsets.US_ASCII).trim();
        assertThat(issuer.waitFor(10, TimeUnit.SECONDS)).isTrue();
        assertThat(issuer.exitValue()).as(out).isZero();
        return out;
    }

    private static String speechText(int sentences) {
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < sentences; i++) {
            text.append("Sentence number ").append(i + 1).append(" of this provider outage test is spoken here by the local voice. ");
        }
        return text.toString().trim();
    }

    private static void attest(String token, String artifactId, String version) throws Exception {
        HttpResponse<String> attested = send(port, tenant, token, "POST", "/dev/v1/rights/attestations",
                JSON.writeValueAsString(Map.of("artifactId", artifactId, "artifactVersionId", version,
                        "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                        "basis", "TEST: synthetic media generated by the provider outage integration test")));
        assertThat(attested.statusCode()).as(attested.body()).isEqualTo(201);
    }

    private static int countAll(String principal) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                var statement = connection.prepareStatement(
                        "SELECT count(*) FROM media_artifacts WHERE tenant_id=? AND principal_id=?")) {
            statement.setString(1, tenant);
            statement.setString(2, principal);
            try (var row = statement.executeQuery()) {
                row.next();
                return row.getInt(1);
            }
        }
    }

    private record LedgerRow(String state, int attempts, String lastFailure) { }

    private static java.util.Optional<LedgerRow> ledger(String principal, String lane, String requestId) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                var statement = connection.prepareStatement("SELECT state, attempts, last_failure_code FROM media_dev_request_ledger "
                        + "WHERE tenant_id=? AND principal_id=? AND lane=? AND request_id=?")) {
            statement.setString(1, tenant);
            statement.setString(2, principal);
            statement.setString(3, lane);
            statement.setString(4, requestId);
            try (var row = statement.executeQuery()) {
                return row.next() ? java.util.Optional.of(new LedgerRow(row.getString(1), row.getInt(2), row.getString(3)))
                        : java.util.Optional.empty();
            }
        }
    }

    private static List<String> texts(JsonNode array) {
        List<String> out = new ArrayList<>();
        array.forEach(node -> out.add(node.asString()));
        java.util.Collections.sort(out);
        return out;
    }

    private static String weightsSha(JsonNode manifest) {
        for (JsonNode file : manifest.path("files")) if ("WEIGHTS".equals(file.path("role").asString())) return file.path("sha256").asString();
        throw new AssertionError("no WEIGHTS entry");
    }

    private static String firstLine(String text) { return text.lines().findFirst().orElse(""); }

    private static String capture(Path tool, String... args) throws Exception {
        List<String> command = new ArrayList<>(List.of(tool.toString()));
        command.addAll(List.of(args));
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        String out = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(process.waitFor(30, TimeUnit.SECONDS)).isTrue();
        return out;
    }

    private static Map<String, Object> stillClip(String clipId, String artifactId, byte[] bytes, long startTicks) throws Exception {
        return Map.of("type", "putClip", "clip", Map.of("clipId", clipId, "sceneId", "scene-main", "trackId", "video-main",
                "source", Map.of("artifactId", artifactId, "artifactVersionId", "sha256:" + sha256(bytes)),
                "sourceIn", MediaDevVoiceJourneySupport.time(0, "SOURCE_PRESENTATION"),
                "sourceOut", MediaDevVoiceJourneySupport.time(1, "SOURCE_PRESENTATION"),
                "storyStart", MediaDevVoiceJourneySupport.time(startTicks, "STORY"),
                "storyDuration", MediaDevVoiceJourneySupport.time(24, "STORY")));
    }

    private static void writeSceneFrame(Path out) throws Exception {
        var image = new java.awt.image.BufferedImage(640, 360, java.awt.image.BufferedImage.TYPE_INT_RGB);
        var g = image.createGraphics();
        g.setColor(java.awt.Color.WHITE);
        g.fillRect(0, 0, 640, 360);
        g.setColor(java.awt.Color.BLACK);
        g.setFont(new java.awt.Font(java.awt.Font.SANS_SERIF, java.awt.Font.BOLD, 64));
        g.drawString("GHATANA", 150, 190);
        g.dispose();
        javax.imageio.ImageIO.write(image, "png", out.toFile());
    }

    private static Process startSidecar() throws Exception {
        Path python = Path.of(System.getenv().getOrDefault("MEDIA_LOCAL_VISION_PYTHON",
                data.resolve("runtimes/vision-venv/bin/python").toString()));
        ProcessBuilder builder = new ProcessBuilder(python.toString(), "-I", sidecarScript.toString(), "--port",
                Integer.toString(sidecarPort), "--models-root", models.toString());
        builder.redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD);
        builder.environment().clear();
        builder.environment().putAll(Map.of("GHATANA_VISION_SIDECAR_TOKEN", sidecarToken,
                "HOME", System.getProperty("user.home"), "PATH", "/usr/bin:/bin", "HF_HUB_OFFLINE", "1",
                "TRANSFORMERS_OFFLINE", "1", "MEDIA_LOCAL_MODEL_DIGEST_CACHE", digestCache.toString()));
        return builder.start();
    }

    private static void awaitSidecar() throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(180).toNanos();
        while (System.nanoTime() < deadline) {
            if (!sidecar.isAlive()) throw new AssertionError("vision sidecar exited: " + sidecar.exitValue());
            try {
                HttpResponse<String> response = HttpClient.newHttpClient().send(HttpRequest.newBuilder(
                        URI.create("http://127.0.0.1:" + sidecarPort + "/v1/health")).header("Authorization", "Bearer " + sidecarToken)
                        .GET().build(), HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() == 200) return;
            } catch (java.io.IOException ignored) { }
            Thread.sleep(250);
        }
        throw new AssertionError("vision sidecar did not become healthy");
    }

    /** Loads Florence-2 in the sidecar with one real analysis so a later fault is not confused with a cold start. */
    private static void warmSidecar() throws Exception {
        var image = new java.awt.image.BufferedImage(96, 96, java.awt.image.BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < 96; y++) for (int x = 0; x < 96; x++) image.setRGB(x, y, (x / 12 + y / 12) % 2 == 0 ? 0xDDDDDD : 0x335577);
        var png = new java.io.ByteArrayOutputStream();
        javax.imageio.ImageIO.write(image, "png", png);
        String body = JSON.writeValueAsString(Map.of("imageBase64", java.util.Base64.getEncoder().encodeToString(png.toByteArray()),
                "tasks", List.of("caption"), "maxNewTokens", 16));
        HttpResponse<String> response = HttpClient.newHttpClient().send(HttpRequest.newBuilder(
                URI.create("http://127.0.0.1:" + sidecarPort + "/v1/analyze")).header("Authorization", "Bearer " + sidecarToken)
                .header("Content-Type", "application/json").timeout(Duration.ofMinutes(10))
                .POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as("sidecar warm-up: " + response.body()).isEqualTo(200);
    }

    /** Loads Qwen2.5-VL in the sidecar with one real question (a cold 7B load takes far longer than the lane deadline). */
    private static void warmQwen() throws Exception {
        var image = new java.awt.image.BufferedImage(96, 96, java.awt.image.BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < 96; y++) for (int x = 0; x < 96; x++) image.setRGB(x, y, (x / 12 + y / 12) % 2 == 0 ? 0xDDDDDD : 0x335577);
        var png = new java.io.ByteArrayOutputStream();
        javax.imageio.ImageIO.write(image, "png", png);
        String body = JSON.writeValueAsString(Map.of("imageBase64", java.util.Base64.getEncoder().encodeToString(png.toByteArray()),
                "question", "What is in this image?", "maxNewTokens", 16));
        HttpResponse<String> response = HttpClient.newHttpClient().send(HttpRequest.newBuilder(
                URI.create("http://127.0.0.1:" + sidecarPort + "/v1/ask")).header("Authorization", "Bearer " + sidecarToken)
                .header("Content-Type", "application/json").timeout(Duration.ofMinutes(10))
                .POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as("Qwen warm-up: " + response.body()).isEqualTo(200);
    }

    private static void killTree(Process process) throws InterruptedException {
        process.toHandle().descendants().forEach(ProcessHandle::destroyForcibly);
        process.destroyForcibly();
        process.waitFor(10, TimeUnit.SECONDS);
    }

    private static void awaitReadyPatiently(Process process, int port) throws Exception {
        long deadline = System.nanoTime() + Duration.ofMinutes(20).toNanos();
        while (System.nanoTime() < deadline) {
            if (!process.isAlive()) throw new AssertionError("MediaLauncher exited: " + process.exitValue());
            try {
                HttpResponse<String> response = HttpClient.newHttpClient().send(HttpRequest.newBuilder(
                        URI.create("http://127.0.0.1:" + port + "/health/ready")).GET().build(), HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() == 200) return;
            } catch (java.io.IOException ignored) { }
            Thread.sleep(500);
        }
        throw new AssertionError("MediaLauncher did not become ready within 20 minutes");
    }

    private static Path locate(String relative) {
        for (Path dir = Path.of("").toAbsolutePath(); dir != null; dir = dir.getParent()) {
            Path candidate = dir.resolve(relative);
            if (Files.isRegularFile(candidate)) return candidate;
        }
        return null;
    }

    private static JsonNode readBrowserEvent(Process browser, BufferedReader output, String expectedEvent, int seconds) throws Exception {
        FutureTask<String> lineTask = new FutureTask<>(output::readLine);
        Thread reader = new Thread(lineTask, "media-dev-provider-live-browser-output");
        reader.setDaemon(true);
        reader.start();
        String line;
        try {
            line = lineTask.get(seconds, TimeUnit.SECONDS);
        } catch (java.util.concurrent.TimeoutException timeout) {
            stopProcessTree(browser);
            throw new AssertionError("Timed out waiting for browser event " + expectedEvent + "; log=" + Files.readString(log), timeout);
        }
        assertThat(line).as("browser event " + expectedEvent + "; log=" + Files.readString(log)).isNotNull();
        JsonNode event = JSON.readTree(line);
        assertThat(event.path("event").asString()).isEqualTo(expectedEvent);
        return event;
    }

    private static void stopProcessTree(Process process) throws InterruptedException {
        var descendants = process.toHandle().descendants().toList();
        for (int index = descendants.size() - 1; index >= 0; index--) descendants.get(index).destroy();
        process.destroy();
        if (!process.waitFor(3, TimeUnit.SECONDS)) process.destroyForcibly();
        for (ProcessHandle descendant : descendants) if (descendant.isAlive()) descendant.destroyForcibly();
    }

    private static Path findMediaRepoRoot() {
        Path repoRoot = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (!Files.isRegularFile(repoRoot.resolve("scripts/media-dev-identity-token.mjs"))) {
            repoRoot = repoRoot.getParent();
            if (repoRoot == null) throw new AssertionError("Could not locate the Media repository root");
        }
        return repoRoot;
    }

    private static Path findViteBinary(Path repoRoot) throws Exception {
        Path local = repoRoot.resolve("apps/media-experience-explorer/node_modules/vite/bin/vite.js");
        if (Files.isRegularFile(local)) return local;
        Path localPnpm = findPnpmPackageBinary(repoRoot, "vite@7.3.1", "vite/bin/vite.js");
        if (localPnpm != null) return localPnpm;
        Path globalVite = globalNodeModules().resolve("vitest/node_modules/vite/bin/vite.js");
        assertThat(Files.isRegularFile(globalVite)).as("a Vite installation is required").isTrue();
        return globalVite;
    }

    private static Path findPlaywrightModule(Path repoRoot) throws Exception {
        Path local = repoRoot.resolve("node_modules/playwright/index.mjs");
        if (Files.isRegularFile(local)) return local;
        Path appLocal = repoRoot.resolve("apps/media-experience-explorer/node_modules/playwright/index.mjs");
        if (Files.isRegularFile(appLocal)) return appLocal;
        Path localPnpm = findPnpmPackageBinary(repoRoot, "playwright@1.63.0", "playwright/index.mjs");
        if (localPnpm != null) return localPnpm;
        Path global = globalNodeModules().resolve("@playwright/test/index.mjs");
        assertThat(Files.isRegularFile(global)).as("Playwright 1.63.0 is required").isTrue();
        return global;
    }

    private static Path findPnpmPackageBinary(Path repoRoot, String packagePrefix, String relativeBinary) throws Exception {
        Path pnpmStore = repoRoot.resolve("node_modules/.pnpm");
        if (!Files.isDirectory(pnpmStore)) return null;
        try (var entries = Files.list(pnpmStore)) {
            return entries.filter(path -> path.getFileName().toString().startsWith(packagePrefix))
                    .map(path -> path.resolve("node_modules").resolve(relativeBinary))
                    .filter(Files::isRegularFile).findFirst().orElse(null);
        }
    }

    private static String packageVersion(Path executable) throws Exception {
        Path packageJson = executable.toRealPath().getParent().getParent().resolve("package.json");
        return JSON.readTree(Files.readString(packageJson)).path("version").asString();
    }

    private static Path globalNodeModules() throws Exception {
        Process npm = new ProcessBuilder("npm", "root", "-g").redirectErrorStream(true).start();
        byte[] output = npm.getInputStream().readAllBytes();
        assertThat(npm.waitFor(10, TimeUnit.SECONDS)).isTrue();
        return Path.of(new String(output, StandardCharsets.UTF_8).trim());
    }
}
