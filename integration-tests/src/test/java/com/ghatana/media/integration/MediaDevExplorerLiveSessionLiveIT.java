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
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.countArtifacts;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffmpeg;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffprobe;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * Real Chromium drives the Explorer "Live capture session" page against a real launcher process (PostgreSQL + S3). The
 * page captures a WebAudio oscillator through an AudioWorklet, streams 20 ms PCM frames with sequence, exact PTS and CRC,
 * survives a real browser-offline window, ends the stream and compares the stored WAV with what it sent; it then shows the
 * typed REVOKED outcome when the (second-person confirmed) VOICE_OR_LIKENESS_USE consent is revoked while live, and the
 * ABORTED outcome. This test then decodes the stored WAV from S3 with FFmpeg and compares its SHA-256 with the page's own,
 * and proves the revoked and aborted sessions stored nothing. TEST identities only; the statements are synthetic test
 * principals', not real consent.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevExplorerLiveSessionLiveIT {
    private static final long POLL_MS = 250;

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(LocalStackContainer.Service.S3);

    @Test
    void explorerStreamsAWebAudioTonePastANetworkDropStoresItExactlyAndShowsRevocationAndAbort() throws Exception {
        assertThat(ffmpeg()).as("MEDIA_DEV_RENDER_FFMPEG").isNotBlank();
        Path repoRoot = findMediaRepoRoot();
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-explorer-live-" + run;
        String principal = "test-principal-live-" + run;
        String bucket = "media-dev-explorer-live-" + run.substring(0, 12);
        String schema = "media_dev_explorer_live_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-explorer-live-services-");
        Path work = Files.createTempDirectory("media-dev-explorer-live-work-");
        Path log = Files.createTempFile("media-dev-explorer-live-process-", ".log");
        Process launcher = null;
        Process browser = null;
        boolean passed = false;
        try {
            try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
            environment.put("MEDIA_MAX_BODY_BYTES", Integer.toString(16 * 1024 * 1024));
            environment.put("MEDIA_MAX_CHUNK_BYTES", Integer.toString(16 * 1024 * 1024));
            environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg());
            environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe());
            environment.put("MEDIA_DEV_LIVE_SESSION_DIR", work.resolve("live-spool").toString());
            environment.put("MEDIA_DEV_LIVE_REVOCATION_POLL_MS", Long.toString(POLL_MS));
            launcher = startLauncher(services + java.io.File.pathSeparator + childClasspath, environment, log);
            awaitReady(launcher, port);
            String token = issueDevToken(tenant, principal);
            String confirmer = issueDevToken(tenant, "test-principal-confirmer-" + run);

            // consent subjects: a PROCESSING statement, and a VOICE_OR_LIKENESS_USE statement confirmed by a second principal
            byte[] processing = solidPng(0xFF112233);
            String processingId = upload(port, tenant, principal, token, run + "-p", "consent-p.png", "image/png", processing);
            post(port, tenant, token, "/dev/v1/rights/attestations", Map.of("artifactId", processingId,
                    "artifactVersionId", "sha256:" + sha256(processing), "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                    "basis", "TEST: synthetic oscillator tone in an automated test; a statement by a synthetic test principal, not a legal determination"), 201);
            byte[] voice = solidPng(0xFF332211);
            String voiceId = upload(port, tenant, principal, token, run + "-v", "consent-v.png", "image/png", voice);
            String attestation = post(port, tenant, token, "/dev/v1/rights/attestations", Map.of("artifactId", voiceId,
                    "artifactVersionId", "sha256:" + sha256(voice), "statementKind", "IDENTIFIABLE_PERSON_CONSENT",
                    "scopes", List.of("VOICE_OR_LIKENESS_USE"),
                    "basis", "TEST: synthetic oscillator tone, no real person; a statement by a synthetic test principal, not real consent"), 201)
                    .path("attestationId").asString();
            assertThat(send(port, tenant, confirmer, "POST", "/dev/v1/rights/attestations/" + attestation + "/confirm", "{}").statusCode()).isEqualTo(200);
            int wavBefore = countArtifacts(POSTGRES, tenant, principal, "audio/wav");

            Path script = repoRoot.resolve("apps/media-experience-explorer/test/dev-live-session-live-browser.mjs");
            assertThat(script).isRegularFile();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            ProcessBuilder builder = new ProcessBuilder("node", script.toString());
            builder.directory(repoRoot.toFile());
            builder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            Map<String, String> env = builder.environment();
            env.put("MEDIA_DEV_LIVE_BROWSER_TOKEN", token);
            env.put("MEDIA_DEV_LIVE_CONSENT_ID", processingId);
            env.put("MEDIA_DEV_LIVE_CONSENT_VERSION", "sha256:" + sha256(processing));
            env.put("MEDIA_DEV_LIVE_VOICE_ID", voiceId);
            env.put("MEDIA_DEV_LIVE_VOICE_VERSION", "sha256:" + sha256(voice));
            env.put("MEDIA_DEV_LIVE_VOICE_ATTESTATION", attestation);
            env.put("MEDIA_DEV_LIVE_POLL_MS", Long.toString(POLL_MS));
            env.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(port));
            env.put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            env.put("MEDIA_DEV_VITE_VERSION", packageVersion(viteBinary));
            env.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            browser = builder.start();

            JsonNode event;
            try (BufferedReader output = new BufferedReader(new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8))) {
                FutureTask<String> lineTask = new FutureTask<>(output::readLine);
                Thread reader = new Thread(lineTask, "media-dev-live-browser-output");
                reader.setDaemon(true);
                reader.start();
                String line = lineTask.get(300, TimeUnit.SECONDS);
                assertThat(line).as("browser event; log=" + Files.readString(log)).isNotNull();
                event = JSON.readTree(line);
            }
            assertThat(browser.waitFor(60, TimeUnit.SECONDS)).isTrue();
            assertThat(browser.exitValue()).as("live browser script must pass; see " + log).isZero();
            System.out.println("J29_UI_BROWSER_EVENT " + event);
            assertThat(event.path("event").asString()).isEqualTo("live");

            // ---- independent readback: FFmpeg decodes the stored WAV; its PCM digest equals the one the BROWSER computed ----
            byte[] wav = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, event.path("wavId").asString()));
            assertThat(sha256(wav)).isEqualTo(event.path("wavSha256").asString());
            byte[] decoded = MediaDevLiveSessionSupport.decodeWav(wav, work, "browser");
            assertThat(decoded.length).isEqualTo(event.path("frames").asInt() * MediaDevLiveSessionSupport.FRAME_BYTES);
            assertThat(sha256(decoded)).as("what FFmpeg decodes equals the PCM the page sent").isEqualTo(event.path("sentPcmSha256").asString());
            double rms = 0;
            for (int i = 0; i + 1 < decoded.length; i += 2) {
                double v = (short) ((decoded[i] & 0xff) | (decoded[i + 1] << 8));
                rms += v * v;
            }
            rms = Math.sqrt(rms / (decoded.length / 2.0)) / 32768.0;
            System.out.printf("J29_UI decoded %d frames, rms %.3f (half-scale sine = 0.354), %d network errors survived, revoke seen after %d ms%n",
                    event.path("frames").asInt(), rms, event.path("networkErrorsSurvived").asInt(), event.path("revokedAfterMs").asInt());
            assertThat(rms).isBetween(0.30, 0.40);
            JsonNode index = JSON.readTree(new String(s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal,
                    event.path("indexId").asString())), StandardCharsets.UTF_8));
            assertThat(index.path("frameCount").asInt()).isEqualTo(event.path("frames").asInt());
            for (int i = 0; i < index.path("frames").size(); i++) {
                assertThat(index.path("frames").get(i).path("ptsSamples").asLong()).isEqualTo((long) i * 960);
            }
            assertThat(countArtifacts(POSTGRES, tenant, principal, "audio/wav")).as("only the completed stream stored audio; revoke and abort stored nothing")
                    .isEqualTo(wavBefore + 1);
            assertThat(get(port, tenant, token, "/dev/v1/live-sessions/" + event.path("revokedSessionId").asString(), 200).path("state").asString()).isEqualTo("REVOKED");
            assertThat(get(port, tenant, token, "/dev/v1/live-sessions/" + event.path("abortedSessionId").asString(), 200).path("state").asString()).isEqualTo("ABORTED");
            passed = true;
        } finally {
            if (browser != null && browser.isAlive()) stopProcessTree(browser);
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("Explorer live-session failure log retained at " + log);
            deleteTree(services);
            deleteTree(work);
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
