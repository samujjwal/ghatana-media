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

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStreamReader;
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
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffmpeg;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffprobe;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.kokoroEnvironment;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.modelRoot;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.probe;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.stream;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * Real Chromium drives the Explorer "Translate and dub" panel against a real launcher process (PostgreSQL + S3), a real
 * Kokoro-82M worker, real Whisper large-v3-turbo, real Qwen2.5-VL-7B-Instruct text-only translation (loopback vision
 * sidecar) and real FFmpeg. The test principal prepares the real input through the API (Kokoro English narration,
 * attested, Whisper English transcript); the browser then translates (keyboard only), edits and saves a revision, dubs,
 * verifies the timing table against the host JSON, plays the dub after SHA-256 verification and exercises the typed
 * overflow refusal. The Java side then reads the registered bytes back independently. TEST identities only.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevExplorerDubbingLiveIT {
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

    @Test
    void explorerTranslatesEditsDubsPlaysAndRefusesAnOverflowAgainstTheRealModels() throws Exception {
        Path data = modelRoot();
        Path models = Path.of(System.getenv().getOrDefault("MEDIA_LOCAL_VISION_MODELS_ROOT", data.resolve("models").toString()));
        Path python = Path.of(System.getenv().getOrDefault("MEDIA_LOCAL_VISION_PYTHON",
                data.resolve("runtimes/vision-venv/bin/python").toString()));
        Path repoRoot = findMediaRepoRoot();
        Path sidecarScript = repoRoot.resolve("tools/model-runtimes/vision/vision_sidecar.py");
        assertThat(sidecarScript).as("vision_sidecar.py").isRegularFile();
        assertThat(python).as("vision venv python").isExecutable();
        assertThat(ffmpeg()).as("MEDIA_DEV_RENDER_FFMPEG").isNotBlank();
        assertThat(ffprobe()).as("MEDIA_DEV_RENDER_FFPROBE").isNotBlank();

        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-explorer-dub-" + run;
        String principal = "test-principal-dub-" + run;
        String bucket = "media-dev-explorer-dub-" + run.substring(0, 12);
        String schema = "media_dev_explorer_dub_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        int sidecarPort;
        try (var socket = new java.net.ServerSocket(0)) { sidecarPort = socket.getLocalPort(); }
        byte[] tokenBytes = new byte[24];
        new SecureRandom().nextBytes(tokenBytes);
        String sidecarToken = HexFormat.of().formatHex(tokenBytes);
        Path work = Files.createTempDirectory("media-dev-explorer-dub-work-");
        Path services = Files.createTempDirectory("media-dev-explorer-dub-services-");
        Path log = Files.createTempFile("media-dev-explorer-dub-process-", ".log");
        Process sidecar = null;
        Process launcher = null;
        Process browser = null;
        boolean passed = false;
        try {
            try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
            ProcessBuilder sidecarBuilder = new ProcessBuilder(python.toString(), "-I", sidecarScript.toString(), "--port",
                    Integer.toString(sidecarPort), "--models-root", models.toString());
            sidecarBuilder.redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.appendTo(work.resolve("sidecar.log").toFile()));
            sidecarBuilder.environment().clear();
            sidecarBuilder.environment().putAll(Map.of("GHATANA_VISION_SIDECAR_TOKEN", sidecarToken,
                    "HOME", System.getProperty("user.home"), "PATH", "/usr/bin:/bin"));
            sidecar = sidecarBuilder.start();
            awaitSidecar(sidecar, sidecarPort, sidecarToken);

            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
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
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            // ---- real input through the API: Kokoro English narration -> attested -> Whisper English transcript ----
            String token = issueDevToken(tenant, principal);
            ByteArrayOutputStream pcm = new ByteArrayOutputStream();
            pcm.write(new byte[600 * 24 * 2]);
            for (int i = 0; i < NARRATION.size(); i++) {
                JsonNode synthesized = post(port, tenant, token, "/dev/v1/speech/syntheses", Map.of("requestId", "narration-" + i + "-" + run,
                        "text", NARRATION.get(i), "voice", "af_heart", "locale", "en"), 201);
                byte[] wav = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal,
                        synthesized.path("artifact").path("artifactId").asString()));
                pcm.write(dataChunk(wav));
                pcm.write(new byte[1800 * 24 * 2]);
            }
            byte[] data24 = pcm.toByteArray();
            ByteBuffer wav24 = ByteBuffer.allocate(44 + data24.length).order(ByteOrder.LITTLE_ENDIAN);
            wav24.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + data24.length)
                    .put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1)
                    .putInt(24_000).putInt(48_000).putShort((short) 2).putShort((short) 16)
                    .put("data".getBytes(StandardCharsets.US_ASCII)).putInt(data24.length).put(data24);
            Files.write(work.resolve("narration24.wav"), wav24.array());
            writeSceneFrame(work.resolve("frame.png"));
            ffmpegRun(List.of("-loop", "1", "-framerate", "5", "-i", work.resolve("frame.png").toString(), "-i",
                    work.resolve("narration24.wav").toString(), "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "96k", "-shortest", "-movflags", "+faststart", work.resolve("source.mp4").toString()));
            ffmpegRun(List.of("-i", work.resolve("source.mp4").toString(), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
                    work.resolve("narration16.wav").toString()));
            byte[] narration = Files.readAllBytes(work.resolve("narration16.wav"));
            byte[] mp4 = Files.readAllBytes(work.resolve("source.mp4"));
            String narrationId = upload(port, tenant, principal, token, run + "-narration", "narration-en.wav", "audio/wav", narration);
            String narrationVersion = "sha256:" + sha256(narration);
            String videoId = upload(port, tenant, principal, token, run + "-video", "source-en.mp4", "video/mp4", mp4);
            for (String[] target : new String[][] {{narrationId, narrationVersion}, {videoId, "sha256:" + sha256(mp4)}}) {
                post(port, tenant, token, "/dev/v1/rights/attestations", Map.of("artifactId", target[0], "artifactVersionId", target[1],
                        "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                        "basis", "TEST: narration generated by Kokoro-82M inside an automated test; a statement by a synthetic test "
                                + "principal, not a legal determination"), 201);
            }
            JsonNode stt = post(port, tenant, token, "/dev/v1/speech/transcriptions", Map.of("requestId", "stt-" + run,
                    "artifactId", narrationId, "artifactVersionId", narrationVersion, "language", "en"), 201);
            String transcriptId = stt.path("transcript").path("artifact").path("artifactId").asString();
            String transcriptVersion = stt.path("transcript").path("artifact").path("artifactVersionId").asString();
            System.out.println("J16_UI_WHISPER_EN text=\"" + stt.path("text").asString() + "\" cues=" + stt.path("cueCount").asInt());
            assertThat(stt.path("cueCount").asInt()).isGreaterThanOrEqualTo(2);
            int dubRowsBefore = rows(tenant, principal, "dubSchema");
            int translationRowsBefore = rows(tenant, principal, "translationSchema");

            // ---- the real browser journey ----
            Path script = repoRoot.resolve("apps/media-experience-explorer/test/dev-dubbing-live-browser.mjs");
            assertThat(script).isRegularFile();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            ProcessBuilder builder = new ProcessBuilder("node", script.toString());
            builder.directory(repoRoot.toFile());
            builder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            Map<String, String> env = builder.environment();
            env.put("MEDIA_DEV_DUB_BROWSER_TOKEN", issueDevToken(tenant, principal));
            env.put("MEDIA_DEV_DUB_TRANSCRIPT_ID", transcriptId);
            env.put("MEDIA_DEV_DUB_TRANSCRIPT_VERSION", transcriptVersion);
            env.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(port));
            env.put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            env.put("MEDIA_DEV_VITE_VERSION", packageVersion(viteBinary));
            env.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            browser = builder.start();

            JsonNode event;
            try (BufferedReader output = new BufferedReader(new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8))) {
                FutureTask<String> lineTask = new FutureTask<>(output::readLine);
                Thread reader = new Thread(lineTask, "media-dev-dub-browser-output");
                reader.setDaemon(true);
                reader.start();
                String line = lineTask.get(900, TimeUnit.SECONDS);
                assertThat(line).as("browser event; log=" + Files.readString(log)).isNotNull();
                event = JSON.readTree(line);
            }
            assertThat(browser.waitFor(60, TimeUnit.SECONDS)).isTrue();
            assertThat(browser.exitValue()).as("live browser script must pass; see " + log).isZero();
            System.out.println("J16_UI_BROWSER_EVENT " + event);
            assertThat(event.path("event").asString()).isEqualTo("dubbed");
            assertThat(event.path("playbackAdvancedSeconds").asDouble()).as("the browser audio element advanced").isGreaterThan(0.3);

            // ---- independent readback of what the UI produced ----
            assertThat(rows(tenant, principal, "translationSchema")).as("one machine translation and two human revisions")
                    .isEqualTo(translationRowsBefore + 3);
            assertThat(rows(tenant, principal, "dubSchema")).as("exactly one registered dub (audio, captions, timing); the overflow registered nothing")
                    .isEqualTo(dubRowsBefore + 3);
            JsonNode dub = get(port, tenant, token, "/dev/v1/dubs/" + event.path("dubId").asString(), 200);
            String audioId = dub.path("outputs").path("audio").path("artifact").path("artifactId").asString();
            byte[] dubWav = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, audioId));
            assertThat(sha256(dubWav)).isEqualTo(event.path("audioSha256").asString());
            JsonNode wavProbe = probe(dubWav, "wav");
            assertThat(stream(wavProbe, "audio").path("sample_rate").asString()).isEqualTo("24000");
            double seconds = Double.parseDouble(stream(wavProbe, "audio").path("duration").asString("0"));
            assertThat(seconds * 1000).isBetween(event.path("trackMillis").asDouble() - 20, event.path("trackMillis").asDouble() + 20);
            assertThat(dub.path("outputs").path("audio").path("lineage").path("voiceCloning").asString()).isEqualTo("NOT_SUPPORTED");
            assertThat(dub.path("outputs").path("audio").path("lineage").path("translatedTranscript").path("artifactVersionId").asString())
                    .isEqualTo(event.path("revisedVersion").asString());
            passed = true;
        } finally {
            if (browser != null && browser.isAlive()) stopProcessTree(browser);
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            if (sidecar != null) {
                sidecar.destroyForcibly();
                sidecar.waitFor(15, TimeUnit.SECONDS);
            }
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("Explorer dubbing live failure log retained at " + log);
            deleteTree(services);
            deleteTree(work);
        }
    }

    private static int rows(String tenant, String principal, String key) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement("SELECT count(*) FROM media_artifacts WHERE tenant_id=? AND principal_id=? "
                     + "AND metadata_json LIKE ?")) {
            statement.setString(1, tenant);
            statement.setString(2, principal);
            statement.setString(3, "%" + key + "%");
            try (var row = statement.executeQuery()) {
                row.next();
                return row.getInt(1);
            }
        }
    }

    /** The PCM bytes of the data chunk of a mono 24 kHz PCM16 WAV. */
    private static byte[] dataChunk(byte[] wav) {
        ByteBuffer buffer = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        for (int at = 12; at + 8 <= wav.length; ) {
            String id = new String(wav, at, 4, StandardCharsets.US_ASCII);
            int size = buffer.getInt(at + 4);
            if (id.equals("data")) return java.util.Arrays.copyOfRange(wav, at + 8, Math.min(wav.length, at + 8 + size));
            at += 8 + size + (size & 1);
        }
        throw new AssertionError("WAV has no data chunk");
    }

    private static void ffmpegRun(List<String> arguments) throws Exception {
        List<String> command = new ArrayList<>(List.of(ffmpeg(), "-nostdin", "-v", "error", "-y"));
        command.addAll(arguments);
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(process.waitFor(3, TimeUnit.MINUTES)).isTrue();
        assertThat(process.exitValue()).as("ffmpeg " + arguments + ": " + output).isZero();
    }

    private static void writeSceneFrame(Path out) throws Exception {
        var image = new java.awt.image.BufferedImage(640, 360, java.awt.image.BufferedImage.TYPE_INT_RGB);
        var g = image.createGraphics();
        try {
            g.setColor(java.awt.Color.WHITE);
            g.fillRect(0, 0, 640, 360);
            g.setColor(new java.awt.Color(220, 30, 30));
            g.fillRect(50, 150, 200, 170);
            g.setColor(java.awt.Color.BLACK);
            g.setFont(new java.awt.Font(java.awt.Font.SANS_SERIF, java.awt.Font.BOLD, 54));
            g.drawString("QUARTERLY REPORT", 50, 90);
        } finally {
            g.dispose();
        }
        javax.imageio.ImageIO.write(image, "png", out.toFile());
    }

    private static void awaitSidecar(Process process, int port, String token) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(180).toNanos();
        while (System.nanoTime() < deadline) {
            if (!process.isAlive()) throw new AssertionError("vision sidecar exited: " + process.exitValue());
            try {
                HttpResponse<String> response = HttpClient.newHttpClient().send(
                        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/v1/health"))
                                .header("Authorization", "Bearer " + token).GET().build(), HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() == 200) return;
            } catch (java.io.IOException ignored) { }
            Thread.sleep(250);
        }
        throw new AssertionError("vision sidecar did not become healthy");
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
        Path pnpm = findPnpmPackageBinary(repoRoot, "vite@", "vite/bin/vite.js");
        if (pnpm != null) return pnpm;
        Path global = globalNodeModules().resolve("vitest/node_modules/vite/bin/vite.js");
        assertThat(Files.isRegularFile(global)).as("a Vite installation is required").isTrue();
        return global;
    }

    private static Path findPlaywrightModule(Path repoRoot) throws Exception {
        for (String candidate : List.of("node_modules/playwright/index.mjs",
                "apps/media-experience-explorer/node_modules/playwright/index.mjs")) {
            Path path = repoRoot.resolve(candidate);
            if (Files.isRegularFile(path)) return path;
        }
        Path pnpm = findPnpmPackageBinary(repoRoot, "playwright@1.63.0", "playwright/index.mjs");
        if (pnpm != null) return pnpm;
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
