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
import java.io.ByteArrayInputStream;
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
import static org.assertj.core.api.Assertions.assertThat;

/**
 * Real Chromium drives the Explorer "Reference scenes" page against a real launcher process (PostgreSQL + S3). The
 * browser registers a reference set (a reference without a rights statement is the host's typed 403 and focuses its
 * field), asks for the generative model (typed MODEL_UNAVAILABLE, nothing created), meets typed 422 refusals with their
 * JSON paths and a continuity-threshold failure, generates three scenes from the authored template with attested
 * references, verifies each scene against its registered SHA-256, decodes them in the browser, and regenerates them
 * byte-identically. The Java side then reads the stored PNGs back from S3 independently. TEST identities only; the rights
 * statements are a synthetic test principal's, not real approvals.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevExplorerReferenceSceneLiveIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(LocalStackContainer.Service.S3);

    @Test
    void explorerRegistersReferencesGeneratesVerifiedScenesAndShowsTypedRefusalsInChromium() throws Exception {
        Path repoRoot = findMediaRepoRoot();
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-explorer-refscene-" + run;
        String principal = "test-principal-refscene-" + run;
        String bucket = "media-dev-explorer-refscene-" + run.substring(0, 10);
        String schema = "media_dev_xrs_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-explorer-refscene-services-");
        Path log = Files.createTempFile("media-dev-explorer-refscene-process-", ".log");
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
            launcher = startLauncher(services + java.io.File.pathSeparator + childClasspath, environment, log);
            awaitReady(launcher, port);
            String token = issueDevToken(tenant, principal);

            byte[] heroPng = twoColour(48, 64, 0xFFFFD000, 0xFF2060FF);
            byte[] logoPng = gradient(64, 64);
            byte[] strangerPng = twoColour(40, 40, 0xFF00FF00, 0xFF000000);
            String heroId = upload(port, tenant, principal, token, run + "-hero", "hero.png", "image/png", heroPng);
            String logoId = upload(port, tenant, principal, token, run + "-logo", "logo.png", "image/png", logoPng);
            String strangerId = upload(port, tenant, principal, token, run + "-stranger", "stranger.png", "image/png", strangerPng);
            String heroVersion = "sha256:" + sha256(heroPng);
            String logoVersion = "sha256:" + sha256(logoPng);
            String strangerVersion = "sha256:" + sha256(strangerPng);
            for (String[] attested : new String[][] {{heroId, heroVersion, "hero"}, {logoId, logoVersion, "logo"}}) {
                post(port, tenant, token, "/dev/v1/rights/attestations", Map.of("artifactId", attested[0],
                        "artifactVersionId", attested[1], "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                        "basis", "TEST: " + attested[2] + " is a synthetic image generated inside an automated test; a statement by "
                                + "a synthetic test principal, not a legal determination"), 201);
            }
            assertThat(outputs(tenant, principal)).isZero();

            Path script = repoRoot.resolve("apps/media-experience-explorer/test/dev-reference-scenes-live-browser.mjs");
            assertThat(script).isRegularFile();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            ProcessBuilder builder = new ProcessBuilder("node", script.toString());
            builder.directory(repoRoot.toFile());
            builder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            Map<String, String> env = builder.environment();
            env.put("MEDIA_DEV_REFSCENE_BROWSER_TOKEN", issueDevToken(tenant, principal));
            env.put("MEDIA_DEV_REFSCENE_HERO_ID", heroId);
            env.put("MEDIA_DEV_REFSCENE_HERO_VERSION", heroVersion);
            env.put("MEDIA_DEV_REFSCENE_LOGO_ID", logoId);
            env.put("MEDIA_DEV_REFSCENE_LOGO_VERSION", logoVersion);
            env.put("MEDIA_DEV_REFSCENE_STRANGER_ID", strangerId);
            env.put("MEDIA_DEV_REFSCENE_STRANGER_VERSION", strangerVersion);
            env.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(port));
            env.put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            env.put("MEDIA_DEV_VITE_VERSION", packageVersion(viteBinary));
            env.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            browser = builder.start();

            JsonNode event;
            try (BufferedReader output = new BufferedReader(new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8))) {
                FutureTask<String> lineTask = new FutureTask<>(output::readLine);
                Thread reader = new Thread(lineTask, "media-dev-refscene-browser-output");
                reader.setDaemon(true);
                reader.start();
                String line = lineTask.get(300, TimeUnit.SECONDS);
                assertThat(line).as("browser event; log=" + Files.readString(log)).isNotNull();
                event = JSON.readTree(line);
            }
            assertThat(browser.waitFor(60, TimeUnit.SECONDS)).isTrue();
            assertThat(browser.exitValue()).as("live browser script must pass; see " + log).isZero();
            System.out.println("J10_UI_BROWSER_EVENT " + event);
            assertThat(event.path("event").asString()).isEqualTo("reference-scenes");
            assertThat(event.path("byteIdentical").asBoolean()).isTrue();

            // ---- independent readback of what the UI produced: one set, three scenes, one manifest; every refusal registered nothing ----
            assertThat(outputs(tenant, principal)).as("set + 3 scenes + manifest").isEqualTo(5);
            JsonNode reopened = get(port, tenant, token, "/dev/v1/reference-scenes/runs/" + event.path("runId").asString(), 200);
            assertThat(reopened.path("outcome").asString()).isEqualTo("CONTINUITY_PASSED");
            for (int i = 0; i < 3; i++) {
                byte[] png = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, event.path("sceneIds").path(i).asString()));
                assertThat(sha256(png)).isEqualTo(event.path("sceneSha256").path(i).asString());
                BufferedImage image = ImageIO.read(new ByteArrayInputStream(png));
                assertThat(image.getWidth()).isEqualTo(320);
                assertThat(image.getHeight()).isEqualTo(180);
                assertThat(reopened.path("manifest").path("scenes").path(i).path("canonicalPngSha256").asString())
                        .isEqualTo(event.path("canonicalSha256").path(i).asString());
            }
            passed = true;
        } finally {
            if (browser != null && browser.isAlive()) stopProcessTree(browser);
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("Explorer reference scene live failure log retained at " + log);
            deleteTree(services);
        }
    }

    private static int outputs(String tenant, String principal) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement("SELECT count(*) FROM media_artifacts WHERE tenant_id=? AND principal_id=? "
                     + "AND (metadata_json LIKE '%REFERENCE_SET%' OR metadata_json LIKE '%REFERENCE_SCENE_PNG%' "
                     + "OR metadata_json LIKE '%REFERENCE_SCENE_MANIFEST%')")) {
            statement.setString(1, tenant);
            statement.setString(2, principal);
            try (var row = statement.executeQuery()) {
                row.next();
                return row.getInt(1);
            }
        }
    }

    private static byte[] twoColour(int width, int height, int left, int right) throws Exception {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) image.setRGB(x, y, x < width / 2 ? left : right);
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    private static byte[] gradient(int width, int height) throws Exception {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                image.setRGB(x, y, 0xFF000000 | ((x * 255 / (width - 1)) << 16) | ((y * 255 / (height - 1)) << 8) | 0x80);
            }
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
