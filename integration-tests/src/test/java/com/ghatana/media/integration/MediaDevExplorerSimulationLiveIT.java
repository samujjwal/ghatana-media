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
 * Real Chromium drives the Explorer "Scientific simulation" page against a real launcher process (PostgreSQL + S3) and
 * real FFmpeg. The browser authors a damped spring and checks the host's validated result against the closed form
 * (observables and the curve pixels of the verified plot in the browser's own decode), receives the typed refusals
 * (wrong-dimension unit with its JSON path and focus, over budget, a non-finite number that is never sent), the typed
 * ABSTAINED outcomes (step budget, violated constraint: reasons and no values), a replay, a reopen by id and a
 * projectile with quadratic drag whose impact time and range match an independent RK4 reference in the browser, then
 * plays the verified MP4 in a real {@code <video>}. The Java side then reads the stored bytes back independently and
 * reopens the browser-created simulation after a launcher restart. TEST identities only.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevExplorerSimulationLiveIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(LocalStackContainer.Service.S3);

    @Test
    void explorerAuthorsSolvesVerifiesPlotAndVideoInChromiumAndShowsTypedRefusalsAndAbstentions() throws Exception {
        assertThat(ffmpeg()).as("MEDIA_DEV_RENDER_FFMPEG").isNotBlank();
        assertThat(ffprobe()).as("MEDIA_DEV_RENDER_FFPROBE").isNotBlank();
        Path repoRoot = findMediaRepoRoot();
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-explorer-sim-" + run;
        String principal = "test-principal-sim-" + run;
        String bucket = "media-dev-explorer-sim-" + run.substring(0, 12);
        String schema = "media_dev_explorer_sim_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-explorer-sim-services-");
        Path log = Files.createTempFile("media-dev-explorer-sim-process-", ".log");
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
            environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg());
            environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe());
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            String token = issueDevToken(tenant, principal);

            Path script = repoRoot.resolve("apps/media-experience-explorer/test/dev-simulation-live-browser.mjs");
            assertThat(script).isRegularFile();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            ProcessBuilder builder = new ProcessBuilder("node", script.toString());
            builder.directory(repoRoot.toFile());
            builder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            Map<String, String> env = builder.environment();
            env.put("MEDIA_DEV_SIM_BROWSER_TOKEN", issueDevToken(tenant, principal));
            env.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(port));
            env.put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            env.put("MEDIA_DEV_VITE_VERSION", packageVersion(viteBinary));
            env.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            browser = builder.start();

            JsonNode event;
            try (BufferedReader output = new BufferedReader(new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8))) {
                FutureTask<String> lineTask = new FutureTask<>(output::readLine);
                Thread reader = new Thread(lineTask, "media-dev-sim-browser-output");
                reader.setDaemon(true);
                reader.start();
                String line = lineTask.get(420, TimeUnit.SECONDS);
                assertThat(line).as("browser event; log=" + Files.readString(log)).isNotNull();
                event = JSON.readTree(line);
            }
            assertThat(browser.waitFor(60, TimeUnit.SECONDS)).isTrue();
            assertThat(browser.exitValue()).as("live browser script must pass; see " + log).isZero();
            System.out.println("J14_UI_BROWSER_EVENT " + event);
            assertThat(event.path("event").asString()).isEqualTo("simulated");
            assertThat(event.path("curvePixelHits").asInt()).isPositive();
            assertThat(event.path("playbackAdvancedSeconds").asDouble()).as("the browser <video> advanced").isGreaterThan(0.3);
            assertThat(event.path("videoWidth").asInt()).isEqualTo(800);
            assertThat(Math.abs(event.path("springFinalX").asDouble() - event.path("springTruthX").asDouble())).isLessThan(1e-7);
            assertThat(Math.abs(event.path("impactTimeSeconds").asDouble() - event.path("referenceImpactSeconds").asDouble())).isLessThan(1e-6);

            // ---- independent readback of what the UI produced: stored bytes, durable rows, then a launcher restart ----
            JsonNode spring = get(port, tenant, token, "/dev/v1/simulations/" + event.path("springSimulationId").asString(), 200);
            assertThat(spring.path("result").path("requestId").asString()).isEqualTo(event.path("springRequestId").asString());
            byte[] resultBytes = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal,
                    spring.path("resultArtifact").path("artifactId").asString()));
            assertThat(sha256(resultBytes)).isEqualTo(spring.path("resultArtifact").path("sha256").asString());
            assertThat(JSON.readTree(resultBytes).path("trace").path("rows")).isNotEmpty();
            byte[] mp4 = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, event.path("shotVideoId").asString()));
            assertThat(sha256(mp4)).isEqualTo(event.path("shotVideoSha256").asString());
            JsonNode videoProbe = probe(mp4, "mp4");
            assertThat(stream(videoProbe, "video").path("codec_name").asString()).isEqualTo("h264");
            assertThat(stream(videoProbe, "video").path("width").asInt()).isEqualTo(800);
            int resultRows = countArtifacts(tenant, principal, "application/json");
            assertThat(resultRows).as("results of: spring, constraint-satisfied spring, step-budget abstention, constraint abstention, projectile")
                    .isEqualTo(5);

            stopLauncher(launcher);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            String afterToken = issueDevToken(tenant, principal);
            JsonNode afterRestart = get(port, tenant, afterToken, "/dev/v1/simulations/" + event.path("springSimulationId").asString(), 200);
            assertThat(afterRestart.path("result").path("trace").toString()).isEqualTo(spring.path("result").path("trace").toString());
            assertThat(get(port, tenant, afterToken, "/dev/v1/simulations/" + event.path("abstainedSimulationId").asString(), 200)
                    .path("outcome").asString()).isEqualTo("ABSTAINED");
            passed = true;
        } finally {
            if (browser != null && browser.isAlive()) stopProcessTree(browser);
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("Explorer simulation live failure log retained at " + log);
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
