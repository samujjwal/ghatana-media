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

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * Real Chromium drives the Explorer "Voice synthesis" panel against a real launcher process (PostgreSQL + S3) with the
 * REAL Kokoro-82M model: voices and locales come from the host, two clips are synthesized (mouse, then keyboard only),
 * played back after SHA-256 verification and added to a project timeline. The Java side then decodes each registered
 * clip with FFmpeg, proves the timeline holds the exact versions, and renders the UI-built timeline to MP4 whose AUDIO
 * stream is probed. The synthetic principal and statements are TEST identities.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevExplorerVoiceSynthesisLiveIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void explorerSynthesizesPlaysAndAddsToTheTimelineThenTheUiBuiltTimelineRendersToMp4WithAudio() throws Exception {
        Map<String, String> speech = kokoroEnvironment(modelRoot());
        assumeTrue(LocalKokoroTtsProvider.fromEnvironment(speech).ready(),
                "the verified local Kokoro-82M install is required");
        assumeTrue(ffmpeg() != null && ffprobe() != null, "FFmpeg/FFprobe tool paths are required");
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-explorer-voice-" + run;
        String principal = "test-principal-voice-" + run;
        String bucket = "media-dev-explorer-voice-" + run.substring(0, 12);
        String schema = "media_dev_explorer_voice_" + run.substring(0, 12);
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-explorer-voice-services-");
        Path log = Files.createTempFile("media-dev-explorer-voice-process-", ".log");
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

            Path repoRoot = findMediaRepoRoot();
            Path script = repoRoot.resolve("apps/media-experience-explorer/test/dev-voice-synthesis-live-browser.mjs");
            assertThat(Files.isRegularFile(script)).isTrue();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            ProcessBuilder builder = new ProcessBuilder("node", script.toString());
            builder.directory(repoRoot.toFile());
            builder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            Map<String, String> env = builder.environment();
            env.put("MEDIA_DEV_VOICE_BROWSER_TOKEN", token);
            env.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(port));
            env.put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            env.put("MEDIA_DEV_VITE_VERSION", packageVersion(viteBinary));
            env.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            browser = builder.start();

            JsonNode event;
            try (BufferedReader output = new BufferedReader(new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8))) {
                FutureTask<String> lineTask = new FutureTask<>(output::readLine);
                Thread reader = new Thread(lineTask, "media-dev-voice-browser-output");
                reader.setDaemon(true);
                reader.start();
                String line = lineTask.get(300, TimeUnit.SECONDS);
                assertThat(line).as("browser event; log=" + Files.readString(log)).isNotNull();
                event = JSON.readTree(line);
            }
            assertThat(browser.waitFor(60, TimeUnit.SECONDS)).isTrue();
            assertThat(browser.exitValue()).as("live browser script must pass; see " + log).isZero();
            assertThat(event.path("event").asString()).isEqualTo("synthesized");
            assertThat(event.path("playbackSeconds").asDouble()).as("the browser audio element advanced").isGreaterThan(0.2);

            // Every clip the UI synthesized decodes independently as real speech.
            String projectId = event.path("projectId").asString();
            JsonNode clips = event.path("clips");
            assertThat(clips).hasSize(2);
            for (JsonNode clip : clips) {
                byte[] wav = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, clip.path("artifactId").asString()));
                assertThat(sha256(wav)).isEqualTo(clip.path("sha256").asString());
                JsonNode probe = probe(wav, "wav");
                JsonNode audio = stream(probe, "audio");
                double seconds = Double.parseDouble(probe.path("format").path("duration").asString());
                System.out.println("J04_UI_CLIP voice=" + clip.path("voice").asString() + " codec=" + audio.path("codec_name").asString()
                        + " sample_rate=" + audio.path("sample_rate").asString() + " duration=" + seconds + "s");
                assertThat(audio.path("codec_name").asString()).isEqualTo("pcm_s16le");
                assertThat(audio.path("sample_rate").asString()).isEqualTo("24000");
                assertThat(seconds).isGreaterThan(1.0);
                assertThat(decode(wav, "wav").rms()).isGreaterThan(200.0);
            }
            assertThat(countArtifacts(POSTGRES, tenant, principal, "audio/wav")).isEqualTo(2);

            // The UI-built timeline holds the exact synthesized versions on one AUDIO track.
            JsonNode project = get(port, tenant, token, "/dev/v1/projects/" + projectId, 200);
            String head = project.path("currentRevision").path("revisionId").asString();
            assertThat(head).isEqualTo(event.path("secondRevision").asString());
            JsonNode graph = project.path("currentRevision").path("timelines").get(0).path("graph");
            assertThat(graph.path("tracks")).hasSize(1);
            assertThat(graph.path("tracks").get(0).toString()).contains("AUDIO").contains("audio-voice");
            assertThat(graph.path("clips")).hasSize(2);
            for (int i = 0; i < 2; i++) {
                JsonNode clip = graph.path("clips").get(i);
                JsonNode expected = clips.get(i);
                assertThat(clip.path("source").path("artifactId").asString()).isEqualTo(expected.path("artifactId").asString());
                assertThat(clip.path("source").path("artifactVersionId").asString()).isEqualTo(expected.path("artifactVersionId").asString());
                assertThat(clip.path("clipId").asString()).isEqualTo("voice-" + expected.path("requestId").asString());
            }

            // Render the UI-built timeline: keep the first clip (mono clips are not mixed), add a still for the MP4.
            String secondClipId = "voice-" + clips.get(1).path("requestId").asString();
            byte[] png = solidPng(0xff2060c0);
            String pngId = upload(port, tenant, principal, token, "j04-ui-still", "still.png", "image/png", png);
            long ticks = ticksFor(clips.get(0).path("durationMillis").asLong());
            String revisionId = post(port, tenant, token, "/dev/v1/projects/" + projectId + "/timelines/timeline-main/edits", Map.of(
                    "expectedHeadRevisionId", head, "edits", List.of(
                            Map.of("type", "removeClip", "clipId", secondClipId),
                            Map.of("type", "addTrack", "trackId", "video-main", "sceneId", "scene-voice", "trackKind", "VIDEO", "order", 1),
                            Map.of("type", "putClip", "clip", Map.of("clipId", "clip-still", "sceneId", "scene-voice", "trackId", "video-main",
                                    "source", Map.of("artifactId", pngId, "artifactVersionId", "sha256:" + sha256(png)),
                                    "sourceIn", time(0, "SOURCE_PRESENTATION"), "sourceOut", time(1, "SOURCE_PRESENTATION"),
                                    "storyStart", time(0, "STORY"), "storyDuration", time(ticks, "STORY"))))), 201)
                    .path("revision").path("revisionId").asString();
            JsonNode render = post(port, tenant, token, "/dev/v1/projects/" + projectId + "/renders", Map.of(
                    "requestId", "j04-ui-render-" + run, "revisionId", revisionId, "timelineId", "timeline-main",
                    "width", 32, "height", 24, "framesPerSecond", 10, "format", "mp4"), 201);
            byte[] mp4 = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, render.path("renderId").asString()));
            assertThat(sha256(mp4)).isEqualTo(render.path("artifact").path("sha256").asString());
            JsonNode mp4Probe = probe(mp4, "mp4");
            JsonNode mp4Audio = stream(mp4Probe, "audio");
            assertThat(mp4Audio).as("the rendered MP4 has an audio stream").isNotNull();
            double audioSeconds = Double.parseDouble(mp4Audio.path("duration").asString("0"));
            System.out.println("J04_UI_MP4 audio_codec=" + mp4Audio.path("codec_name").asString()
                    + " audio_sample_rate=" + mp4Audio.path("sample_rate").asString() + " audio_duration=" + audioSeconds + "s");
            assertThat(mp4Audio.path("codec_name").asString()).isEqualTo("aac");
            assertThat(audioSeconds).isBetween(ticks / 24.0 - 0.25, ticks / 24.0 + 0.25);
            assertThat(decode(mp4, "mp4").rms()).as("the synthesized voice is audible in the render").isGreaterThan(100.0);
            browser = null;
            passed = true;
        } finally {
            if (browser != null && browser.isAlive()) stopProcessTree(browser);
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("Explorer voice synthesis live failure log retained at " + log);
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
