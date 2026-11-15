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
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * Real Chromium drives the Explorer "Resumable upload and versions" page against a real launcher process (PostgreSQL +
 * S3). The browser uploads a real few-MB MP4 in checksummed chunks, pauses and resumes, and while it is uploading this
 * test SIGKILLs the launcher and restarts it: the page waits, reads the server offset and finishes without re-sending
 * acknowledged chunks. It then shows the ffprobe result, the missing-rights state, a rights statement for that exact
 * version, version 2 of a revised file with a parent link, and dedupe of a repeated upload. The Java side verifies the
 * stored bytes, the immutable ledger rows and the probe independently. TEST identity and synthetic media only.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevExplorerResumableUploadLiveIT {
    private static final long CHUNK = 512 * 1024;

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void browserUploadResumesAcrossLauncherKillAndRegistersProbedVersions() throws Exception {
        assumeTrue(ffmpeg() != null && ffprobe() != null, "FFmpeg/FFprobe tool paths are required");
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-ru-ui-" + run;
        String owner = "test-principal-owner-" + run;
        String bucket = "media-dev-ru-ui-" + run.substring(0, 12);
        String schema = "media_dev_ru_ui_" + run.substring(0, 12);
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-ru-ui-services-");
        Path work = Files.createTempDirectory("media-dev-ru-ui-work-");
        Path log = Files.createTempFile("media-dev-ru-ui-process-", ".log");
        Path repoRoot = findMediaRepoRoot();
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
            environment.put("MEDIA_DEV_INTAKE_ENABLED", "true");
            environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg());
            environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe());
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            byte[] v1 = MediaDevResumableIntakeIT.generateMp4(work, "browser-v1.mp4", 440, 8);
            byte[] v2 = MediaDevResumableIntakeIT.generateMp4(work, "browser-v2.mp4", 880, 7);
            assertThat(v1.length).isBetween(2_000_000, 12_000_000);
            assertThat(v1.length / CHUNK).as("enough chunks to kill the host mid-upload").isGreaterThanOrEqualTo(4);

            Path script = repoRoot.resolve("apps/media-experience-explorer/test/dev-resumable-upload-live-browser.mjs");
            assertThat(script).isRegularFile();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            ProcessBuilder builder = new ProcessBuilder("node", script.toString());
            builder.directory(repoRoot.toFile());
            builder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            Map<String, String> env = builder.environment();
            env.put("MEDIA_DEV_RU_BROWSER_TOKEN", issueDevToken(tenant, owner));
            env.put("MEDIA_DEV_RU_FILE_V1", work.resolve("browser-v1.mp4").toString());
            env.put("MEDIA_DEV_RU_FILE_V2", work.resolve("browser-v2.mp4").toString());
            env.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(port));
            env.put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            env.put("MEDIA_DEV_VITE_VERSION", packageVersion(viteBinary));
            env.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            browser = builder.start();

            // Output reader and the host-killer run concurrently with the browser journey.
            FutureTask<String> lineTask;
            BufferedReader output = new BufferedReader(new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8));
            lineTask = new FutureTask<>(output::readLine);
            Thread reader = new Thread(lineTask, "media-dev-ru-browser-output");
            reader.setDaemon(true);
            reader.start();

            // Kill the host while the browser is partway through chunks (at least 3 acknowledged, not complete).
            long deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(3);
            long killedAtBytes = -1;
            while (System.nanoTime() < deadline && killedAtBytes < 0) {
                if (!browser.isAlive()) break;
                long received = bytesReceived(tenant);
                if (received >= 3 * CHUNK && received < v1.length) {
                    launcher.destroyForcibly();
                    assertThat(launcher.waitFor(15, TimeUnit.SECONDS)).isTrue();
                    killedAtBytes = received;
                } else {
                    Thread.sleep(40);
                }
            }
            assertThat(killedAtBytes).as("the host was killed mid-upload; log=" + log).isPositive();
            Thread.sleep(4_000);                           // a real outage the page must ride out
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            String line = lineTask.get(600, TimeUnit.SECONDS);
            assertThat(line).as("browser event; log=" + Files.readString(log)).isNotNull();
            JsonNode event = JSON.readTree(line);
            assertThat(browser.waitFor(60, TimeUnit.SECONDS)).isTrue();
            assertThat(browser.exitValue()).as("live browser script must pass; see " + log).isZero();
            System.out.println("J02_UI_BROWSER_EVENT killedAtBytes=" + killedAtBytes + " " + event);
            assertThat(event.path("event").asString()).isEqualTo("uploaded");
            assertThat(event.path("lostAtBytes").asLong()).isGreaterThanOrEqualTo(2 * CHUNK).isLessThan(v1.length);

            // ---- independent readback of what the browser produced ----
            String token = issueDevToken(tenant, owner);
            JsonNode lineage = get(port, tenant, token, "/dev/v1/intakes/browser-media", 200);
            assertThat(lineage.path("versions")).hasSize(2);
            JsonNode first = lineage.path("versions").get(0);
            JsonNode second = lineage.path("versions").get(1);
            assertThat(first.path("sha256").asString()).isEqualTo(sha256(v1)).isEqualTo(event.path("sha1").asString());
            assertThat(second.path("sha256").asString()).isEqualTo(sha256(v2)).isEqualTo(event.path("sha2").asString());
            assertThat(second.path("parentArtifactVersionId").asString()).isEqualTo("sha256:" + sha256(v1));
            assertThat(first.path("processingAdmission").path("usableForProcessing").asBoolean()).isTrue();
            assertThat(second.path("processingAdmission").path("usableForProcessing").asBoolean()).isFalse();
            StoredArtifact stored1 = storedArtifact(POSTGRES, tenant, owner, first.path("artifactId").asString());
            StoredArtifact stored2 = storedArtifact(POSTGRES, tenant, owner, second.path("artifactId").asString());
            assertThat(s3Bytes(LOCALSTACK, bucket, stored1)).isEqualTo(v1);
            assertThat(s3Bytes(LOCALSTACK, bucket, stored2)).isEqualTo(v2);
            JsonNode independent = probe(v1, "mp4");
            assertThat(first.path("probe").path("format").path("durationSeconds").asDouble())
                    .isCloseTo(independent.path("format").path("duration").asDouble(), org.assertj.core.data.Offset.offset(0.001));
            try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                 var statement = connection.prepareStatement(
                         "SELECT COUNT(*) FROM media_upload_sessions WHERE tenant_id=? AND status='COMPLETED'")) {
                statement.setString(1, tenant);
                try (var rows = statement.executeQuery()) { rows.next(); assertThat(rows.getInt(1)).isEqualTo(2); }
            }
            passed = true;
        } finally {
            if (browser != null && browser.isAlive()) stopProcessTree(browser);
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            deleteBucket(LOCALSTACK, bucket);
            dropSchema(POSTGRES, schema);
            deleteTree(services);
            deleteTree(work);
            if (passed) Files.deleteIfExists(log);
            else System.out.println("J02_UI_PROCESS_LOG " + log);
        }
    }

    private static long bytesReceived(String tenant) {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT COALESCE(MAX(bytes_received),0) FROM media_upload_sessions WHERE tenant_id=? AND status='OPEN'")) {
            statement.setString(1, tenant);
            try (var rows = statement.executeQuery()) { rows.next(); return rows.getLong(1); }
        } catch (Exception notYet) {
            return 0;
        }
    }

    private static void stopProcessTree(Process process) throws Exception {
        List<ProcessHandle> descendants = process.descendants().toList();
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
