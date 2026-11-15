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
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * J-23 (media.dev.outcome-offline-conflict-reconnect): real Chromium drives the Explorer project timeline page against a
 * real launcher process (PostgreSQL + S3). The user edits online, goes offline with Playwright, keeps editing (drafts are
 * AES-GCM ciphertext in IndexedDB under a non-extractable key), reloads the page while offline from the app-shell cache,
 * and a second session changes the same timeline on the host. On reconnect the script proves: an expired token, a token
 * without the project write right and another principal's token are refused typed with the draft kept; a lost request and a
 * lost response never duplicate an effect; a stale draft shows both versions and keep-mine / take-theirs; a real host 409
 * from a raced CAS; and a corrupted draft fails closed with no host call. This test then re-reads the host independently:
 * the final scene set, the exact revision chain (no duplicate revisions), and that the discarded and corrupt edits never
 * reached the host. TEST principals only; nothing here is real rights, consent or approval.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevExplorerOfflineReconnectLiveIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(LocalStackContainer.Service.S3);

    @Test
    void explorerKeepsEncryptedOfflineDraftsAcrossReloadAndReconnectsWithFreshRightsAndTypedConflicts() throws Exception {
        Path repoRoot = findMediaRepoRoot();
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-offline-" + run;
        String principal = "test-principal-offline-" + run;
        String other = "test-principal-stranger-" + run;
        String bucket = "media-dev-offline-" + run.substring(0, 12);
        String schema = "media_dev_offline_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-offline-services-");
        Path log = Files.createTempFile("media-dev-offline-process-", ".log");
        Process launcher = null;
        Process browser = null;
        boolean passed = false;
        try {
            try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            // A 30 s token must really expire at the host within the test, not 30 s later.
            environment.put("MEDIA_DEV_JWT_CLOCK_SKEW_SECONDS", "0");
            launcher = startLauncher(services + java.io.File.pathSeparator + childClasspath, environment, log);
            awaitReady(launcher, port);

            Path script = repoRoot.resolve("apps/media-experience-explorer/test/dev-offline-reconnect-live-browser.mjs");
            assertThat(script).isRegularFile();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            ProcessBuilder builder = new ProcessBuilder("node", script.toString());
            builder.directory(repoRoot.toFile());
            builder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            Map<String, String> env = builder.environment();
            env.put("MEDIA_DEV_OFFLINE_TENANT", tenant);
            env.put("MEDIA_DEV_OFFLINE_PRINCIPAL", principal);
            env.put("MEDIA_DEV_OFFLINE_OTHER_PRINCIPAL", other);
            env.put("MEDIA_DEV_JWT_HMAC_SECRET", DEV_SECRET);
            env.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(port));
            env.put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            env.put("MEDIA_DEV_VITE_VERSION", packageVersion(viteBinary));
            env.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            browser = builder.start();

            JsonNode event;
            try (BufferedReader output = new BufferedReader(new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8))) {
                FutureTask<String> lineTask = new FutureTask<>(output::readLine);
                Thread reader = new Thread(lineTask, "media-dev-offline-browser-output");
                reader.setDaemon(true);
                reader.start();
                String line = lineTask.get(600, TimeUnit.SECONDS);
                assertThat(line).as("browser event; log=" + Files.readString(log)).isNotNull();
                event = JSON.readTree(line);
            }
            assertThat(browser.waitFor(60, TimeUnit.SECONDS)).isTrue();
            assertThat(browser.exitValue()).as("offline-reconnect browser script must pass; see " + log).isZero();
            System.out.println("J23_BROWSER_EVENT " + event);
            assertThat(event.path("event").asString()).isEqualTo("offline-reconnect");

            // ---- independent readback from the real host (PostgreSQL-backed), with a fresh token ----
            String token = issueDevToken(tenant, principal);
            String projectId = event.path("projectId").asString();
            JsonNode head = get(port, tenant, token, "/dev/v1/projects/" + projectId, 200);
            assertThat(head.path("project").path("headRevisionId").asString()).isEqualTo(event.path("finalHeadRevisionId").asString());
            Set<String> scenes = new TreeSet<>();
            head.path("currentRevision").path("timelines").get(0).path("graph").path("scenes")
                    .forEach(scene -> scenes.add(scene.path("sceneId").asString()));
            Set<String> expected = new TreeSet<>();
            event.path("expectedScenes").forEach(scene -> expected.add(scene.asString()));
            assertThat(scenes).as("final scenes: both sessions' edits, nothing overwritten").isEqualTo(expected);
            event.path("absentScenes").forEach(scene -> assertThat(scenes).doesNotContain(scene.asString()));
            // The exact revision chain from the head back to the base: one revision per applied edit, no duplicates.
            Set<String> chain = new HashSet<>();
            String cursor = head.path("project").path("headRevisionId").asString();
            String base = event.path("baseRevisionId").asString();
            int length = 0;
            while (!cursor.equals(base)) {
                assertThat(chain.add(cursor)).as("revision chain must not repeat").isTrue();
                JsonNode revision = get(port, tenant, token, "/dev/v1/projects/" + projectId + "/revisions/" + cursor, 200)
                        .path("revision");
                cursor = revision.path("parentRevisionId").asString();
                length++;
                assertThat(length).isLessThan(50);
            }
            assertThat(length).as("revisions after the base: offline-a, second-session, ep2-a, race-theirs, race-mine")
                    .isEqualTo(event.path("revisionsAfterBase").asInt());
            System.out.printf("J23_HOST scenes=%s revisionsAfterBase=%d%n", scenes, length);
            // Another principal still cannot read the project (no access was granted by any replay).
            assertThat(send(port, tenant, issueDevToken(tenant, other), "GET", "/dev/v1/projects/" + projectId, null).statusCode())
                    .isEqualTo(403);
            passed = true;
        } finally {
            if (browser != null && browser.isAlive()) stopProcessTree(browser);
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("Explorer offline-reconnect failure log retained at " + log);
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
