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

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevAudioSupport.*;
import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * Real Chromium drives the Explorer "Audio restoration A/B" page against a real launcher process (PostgreSQL + S3)
 * with real Kokoro clean speech, known degradations, real FFmpeg restoration and a real Whisper transcript diff. The
 * browser checks the host's numbers on screen, plays verified source and restored clips through one player that switches
 * at the same position (mouse, then keyboard only), and checks focus, labels and the phone layout. The Java side then
 * re-derives the measured improvement from independently decoded bytes and proves the source is byte-identical. The
 * principal and statements are clearly synthetic TEST identities.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevExplorerAudioRestorationLiveIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private static final String TEXT = "The quick brown fox jumps over the lazy dog. "
            + "Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump.";

    @Test
    void explorerRestoresMeasuresAndSwitchesAbPlaybackOverVerifiedBytes() throws Exception {
        Path root = modelRoot();
        Map<String, String> speech = new HashMap<>(kokoroEnvironment(root));
        speech.put("MEDIA_WHISPER_CPP_BIN", root.resolve("runtimes/whisper.cpp-src/build-vulkan/bin/whisper-cli").toString());
        speech.put("MEDIA_WHISPER_CPP_THREADS", "8");
        speech.put("MEDIA_KOKORO_WORKER", "true");
        assumeTrue(LocalKokoroTtsProvider.fromEnvironment(speech).ready() && LocalWhisperCppSttProvider.fromEnvironment(speech).ready(),
                "the verified local Kokoro-82M and Whisper installs are required");
        assumeTrue(ffmpeg() != null && ffprobe() != null, "FFmpeg/FFprobe tool paths are required");
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-explorer-audio-" + run;
        String principal = "test-principal-audio-" + run;
        String bucket = "media-dev-explorer-audio-" + run.substring(0, 12);
        String schema = "media_dev_explorer_audio_" + run.substring(0, 12);
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-explorer-audio-services-");
        Path log = Files.createTempFile("media-dev-explorer-audio-process-", ".log");
        Process launcher = null;
        Process browser = null;
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
            String token = issueDevToken(tenant, principal);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            // Fixtures prepared through the real routes: Kokoro clean reference, known degradation as the source.
            JsonNode synthesized = post(port, tenant, token, "/dev/v1/speech/syntheses",
                    Map.of("requestId", "j07-ui-clean-" + run, "text", TEXT, "voice", "am_michael", "locale", "en"), 201);
            String cleanId = synthesized.path("artifact").path("artifactId").asString();
            String cleanVersion = synthesized.path("artifact").path("artifactVersionId").asString();
            byte[] cleanBytes = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, cleanId));
            Wav clean = decodeWithFfmpeg(cleanBytes);
            byte[] degradedBytes = wav(clean.sampleRate(), degrade(clean.samples(), clean.sampleRate(), 12.0, 330.0, 0.6, 20261114L));
            String sourceId = upload(port, tenant, principal, token, "j07-ui-degraded-" + run, "degraded.wav", "audio/wav", degradedBytes);
            String sourceVersion = "sha256:" + sha256(degradedBytes);
            for (String[] target : new String[][] {{sourceId, sourceVersion}, {cleanId, cleanVersion}}) {
                post(port, tenant, token, "/dev/v1/rights/attestations", Map.of("artifactId", target[0], "artifactVersionId", target[1],
                        "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                        "basis", "TEST: synthetic Kokoro clip and its test-generated degradation; no real person or rights"), 201);
            }

            Path repoRoot = findMediaRepoRoot();
            Path script = repoRoot.resolve("apps/media-experience-explorer/test/dev-audio-restoration-live-browser.mjs");
            assertThat(Files.isRegularFile(script)).isTrue();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            ProcessBuilder builder = new ProcessBuilder("node", script.toString());
            builder.directory(repoRoot.toFile());
            builder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            Map<String, String> env = builder.environment();
            env.put("MEDIA_DEV_AUDIO_BROWSER_TOKEN", token);
            env.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(port));
            env.put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            env.put("MEDIA_DEV_VITE_VERSION", packageVersion(viteBinary));
            env.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            env.put("MEDIA_DEV_AUDIO_SOURCE_ID", sourceId);
            env.put("MEDIA_DEV_AUDIO_SOURCE_VERSION", sourceVersion);
            env.put("MEDIA_DEV_AUDIO_REFERENCE_ID", cleanId);
            env.put("MEDIA_DEV_AUDIO_REFERENCE_VERSION", cleanVersion);
            env.put("MEDIA_DEV_AUDIO_REFERENCE_TEXT", TEXT);
            browser = builder.start();

            JsonNode event;
            try (BufferedReader output = new BufferedReader(new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8))) {
                FutureTask<String> lineTask = new FutureTask<>(output::readLine);
                Thread reader = new Thread(lineTask, "media-dev-audio-browser-output");
                reader.setDaemon(true);
                reader.start();
                String line = lineTask.get(600, TimeUnit.SECONDS);
                assertThat(line).as("browser event; log=" + Files.readString(log)).isNotNull();
                event = JSON.readTree(line);
            }
            assertThat(browser.waitFor(60, TimeUnit.SECONDS)).isTrue();
            assertThat(browser.exitValue()).as("live browser script must pass; see " + log).isZero();
            assertThat(event.path("event").asString()).isEqualTo("restored");
            assertThat(event.path("verdict").asString()).isEqualTo("IMPROVED");
            assertThat(event.path("playbackSeconds").asDouble()).as("the browser audio element advanced").isGreaterThan(1.4);

            // Independently re-derive the improvement from the registered bytes; the source is unchanged.
            String restoredId = event.path("restored").path("artifactId").asString();
            byte[] restoredBytes = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, restoredId));
            assertThat(sha256(restoredBytes)).isEqualTo(event.path("restored").path("sha256").asString());
            Wav restored = decodeWithFfmpeg(restoredBytes);
            Wav degraded = decodeWithFfmpeg(degradedBytes);
            double before = snrDb(degraded.samples(), clean.samples());
            double after = snrDb(restored.samples(), clean.samples());
            System.out.printf("J07_UI snrVsClean %.2f dB -> %.2f dB (browser reported %.2f -> %.2f); clipped %d -> %d%n", before, after,
                    event.path("snrSource").asDouble(), event.path("snrRestored").asDouble(),
                    clippedSamples(degraded.samples()), clippedSamples(restored.samples()));
            assertThat(after).as("restored is closer to the clean reference").isGreaterThan(before + 1.0);
            assertThat(event.path("snrRestored").asDouble()).isCloseTo(after, org.assertj.core.data.Offset.offset(0.01));
            assertThat(clippedSamples(restored.samples())).isLessThanOrEqualTo(clippedSamples(degraded.samples()) / 10);
            assertThat(s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, sourceId))).isEqualTo(degradedBytes);
            JsonNode reopened = get(port, tenant, token, "/dev/v1/audio/outputs/" + event.path("comparisonId").asString(), 200);
            assertThat(reopened.path("report").path("verdict").path("overall").asString()).isEqualTo("IMPROVED");
            assertThat(reopened.path("report").path("transcript").path("status").asString()).isEqualTo("MEASURED");
            assertThat(countArtifacts(POSTGRES, tenant, principal, "audio/wav")).as("clean + source + one restoration").isEqualTo(3);
            browser = null;
            passed = true;
        } finally {
            if (browser != null && browser.isAlive()) stopProcessTree(browser);
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("Explorer audio restoration live failure log retained at " + log);
            deleteTree(services);
        }
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
