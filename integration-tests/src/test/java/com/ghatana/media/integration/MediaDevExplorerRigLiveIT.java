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

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffmpeg;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffprobe;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.probe;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.stream;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * Real Chromium drives the Explorer "3D rig" page against a real launcher process (PostgreSQL + S3) and real FFmpeg.
 * The browser receives the host's typed refusals (unparseable spec is never sent; joint limit with its JSON path;
 * left-handed frame; over budget; a floor texture without a rights statement), renders with an attested texture,
 * shows the per-frame joint angles by keyboard, plays the stored MP4 in a real {@code <video>} element after the
 * registered SHA-256 matches, finds the end-effector marker in the browser's own decode at the host-projected pixel, and
 * verifies the GLB export. The Java side then reads the stored bytes back independently. TEST identities only; the rights
 * statement is a synthetic test principal's, not a real approval.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevExplorerRigLiveIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(LocalStackContainer.Service.S3);

    @Test
    void explorerAuthorsRigRendersPlaysTheVerifiedMp4InChromiumAndShowsJointAnglesAndTypedRefusals() throws Exception {
        assertThat(ffmpeg()).as("MEDIA_DEV_RENDER_FFMPEG").isNotBlank();
        assertThat(ffprobe()).as("MEDIA_DEV_RENDER_FFPROBE").isNotBlank();
        Path repoRoot = findMediaRepoRoot();
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-explorer-rig-" + run;
        String principal = "test-principal-rig-" + run;
        String bucket = "media-dev-explorer-rig-" + run.substring(0, 12);
        String schema = "media_dev_explorer_rig_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-explorer-rig-services-");
        Path log = Files.createTempFile("media-dev-explorer-rig-process-", ".log");
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
            environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg());
            environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe());
            launcher = startLauncher(services + java.io.File.pathSeparator + childClasspath, environment, log);
            awaitReady(launcher, port);
            String token = issueDevToken(tenant, principal);

            // two lawful-image candidates: one attested by the (test) uploader, one without any statement
            byte[] okPng = sticker(0xFF9AA5B8, 0xFF6E7A90);
            byte[] deniedPng = sticker(0xFFFF00FF, 0xFF00FFFF);
            String okId = upload(port, tenant, principal, token, run + "-ok", "floor-ok.png", "image/png", okPng);
            String deniedId = upload(port, tenant, principal, token, run + "-denied", "floor-denied.png", "image/png", deniedPng);
            String okVersion = "sha256:" + sha256(okPng);
            String deniedVersion = "sha256:" + sha256(deniedPng);
            post(port, tenant, token, "/dev/v1/rights/attestations", Map.of("artifactId", okId, "artifactVersionId", okVersion,
                    "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                    "basis", "TEST: a synthetic image generated inside an automated test; a statement by a synthetic test principal, "
                            + "not a legal determination"), 201);
            int videosBefore = countArtifacts(tenant, principal, "video/mp4");

            Path script = repoRoot.resolve("apps/media-experience-explorer/test/dev-rig-live-browser.mjs");
            assertThat(script).isRegularFile();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            ProcessBuilder builder = new ProcessBuilder("node", script.toString());
            builder.directory(repoRoot.toFile());
            builder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            Map<String, String> env = builder.environment();
            env.put("MEDIA_DEV_RIG_BROWSER_TOKEN", issueDevToken(tenant, principal));
            env.put("MEDIA_DEV_RIG_ASSET_OK_ID", okId);
            env.put("MEDIA_DEV_RIG_ASSET_OK_VERSION", okVersion);
            env.put("MEDIA_DEV_RIG_ASSET_DENIED_ID", deniedId);
            env.put("MEDIA_DEV_RIG_ASSET_DENIED_VERSION", deniedVersion);
            env.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(port));
            env.put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            env.put("MEDIA_DEV_VITE_VERSION", packageVersion(viteBinary));
            env.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            browser = builder.start();

            JsonNode event;
            try (BufferedReader output = new BufferedReader(new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8))) {
                FutureTask<String> lineTask = new FutureTask<>(output::readLine);
                Thread reader = new Thread(lineTask, "media-dev-rig-browser-output");
                reader.setDaemon(true);
                reader.start();
                String line = lineTask.get(300, TimeUnit.SECONDS);
                assertThat(line).as("browser event; log=" + Files.readString(log)).isNotNull();
                event = JSON.readTree(line);
            }
            assertThat(browser.waitFor(60, TimeUnit.SECONDS)).isTrue();
            assertThat(browser.exitValue()).as("live browser script must pass; see " + log).isZero();
            System.out.println("J13_UI_BROWSER_EVENT " + event);
            assertThat(event.path("event").asString()).isEqualTo("rigged");
            assertThat(event.path("playbackAdvancedSeconds").asDouble()).as("the browser <video> advanced").isGreaterThan(0.3);
            assertThat(event.path("videoWidth").asInt()).isEqualTo(320);
            assertThat(event.path("videoHeight").asInt()).isEqualTo(240);
            for (JsonNode seek : event.path("seeks")) {
                assertThat(seek.path("errorPx").asDouble()).as("browser-decoded marker vs host projection at frame " + seek.path("frame")).isLessThanOrEqualTo(2.0);
            }

            // ---- independent readback of what the UI produced ----
            assertThat(countArtifacts(tenant, principal, "video/mp4")).as("exactly one registered video: every refusal registered nothing")
                    .isEqualTo(videosBefore + 1);
            JsonNode reopened = get(port, tenant, token, "/dev/v1/rigs/renders/" + event.path("renderId").asString(), 200);
            assertThat(reopened.path("manifest").path("frameSetSha256").asString()).isEqualTo(event.path("frameSetSha256").asString());
            byte[] mp4 = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, event.path("videoId").asString()));
            assertThat(sha256(mp4)).isEqualTo(event.path("videoSha256").asString());
            JsonNode videoProbe = probe(mp4, "mp4");
            assertThat(stream(videoProbe, "video").path("codec_name").asString()).isEqualTo("h264");
            assertThat(stream(videoProbe, "video").path("avg_frame_rate").asString()).isEqualTo("24/1");
            assertThat(stream(videoProbe, "video").path("width").asInt()).isEqualTo(320);
            assertThat(countArtifacts(tenant, principal, "model/gltf-binary")).as("exactly one registered GLB").isEqualTo(1);
            byte[] glb = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, event.path("glbId").asString()));
            assertThat(sha256(glb)).isEqualTo(event.path("glbSha256").asString());
            assertThat(java.nio.ByteBuffer.wrap(glb).order(java.nio.ByteOrder.LITTLE_ENDIAN).getInt(0)).isEqualTo(0x46546c67);
            passed = true;
        } finally {
            if (browser != null && browser.isAlive()) stopProcessTree(browser);
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("Explorer rig live failure log retained at " + log);
            deleteTree(services);
        }
    }

    private static int countArtifacts(String tenant, String principal, String contentType) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement("SELECT count(*) FROM media_artifacts WHERE tenant_id=? AND principal_id=? AND content_type=?")) {
            statement.setString(1, tenant);
            statement.setString(2, principal);
            statement.setString(3, contentType);
            try (var row = statement.executeQuery()) {
                row.next();
                return row.getInt(1);
            }
        }
    }

    private static byte[] sticker(int first, int second) throws Exception {
        BufferedImage image = new BufferedImage(16, 16, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < 16; y++) {
            for (int x = 0; x < 16; x++) image.setRGB(x, y, ((x / 4 + y / 4) % 2 == 0) ? first : second);
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(image, "png", out);
        return out.toByteArray();
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
