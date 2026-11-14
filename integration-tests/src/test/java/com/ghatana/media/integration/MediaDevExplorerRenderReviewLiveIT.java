package com.ghatana.media.integration;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import tools.jackson.databind.JsonNode;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * Real Chromium drives the Explorer "Render and review" panel against a real launcher process (PostgreSQL + S3):
 * render create/replay/reopen, review comment and decision, STALE after a UI timeline edit, and readback across a
 * launcher restart. The PNG source is uploaded over HTTP because the timeline page has no upload path (its separate
 * artifact-intake page is covered by MediaDevProjectTimelineRestartIT).
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevExplorerRenderReviewLiveIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void explorerRendersAssignsReviewerDecidesAsReviewerGoesStaleAndReadsBackAcrossLauncherRestart() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-explorer-rr-" + run;
        String principal = "media-dev-explorer-rr-" + run;
        String reviewer = "media-dev-explorer-reviewer-" + run;
        String bucket = "media-dev-explorer-rr-" + run;
        String schema = "media_dev_explorer_rr_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-explorer-rr-services-");
        Path log = Files.createTempFile("media-dev-explorer-rr-process-", ".log");
        Process launcher = null;
        Process browser = null;
        boolean passed = false;
        try {
            try (S3Client s3 = s3(LOCALSTACK)) {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.put("MEDIA_DEV_REVIEW_ENABLED", "true");
            Path destinationDir = Files.createTempDirectory("media-dev-live-export-");
            environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
            environment.put("MEDIA_DELIVERY_DEV_ENABLED", "true");
            environment.put("MEDIA_DELIVERY_DEV_DESTINATION_DIR", destinationDir.toString());
            String ffmpeg = System.getenv("GHATANA_MEDIA_FFMPEG");
            String ffprobe = System.getenv("GHATANA_MEDIA_FFPROBE");
            boolean mp4 = ffmpeg != null && !ffmpeg.isBlank() && ffprobe != null && !ffprobe.isBlank();
            if (mp4) {
                environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg);
                environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe);
            }
            String token = issueDevToken(tenant, principal, "media:delivery:dev:export", "media:delivery:dev:read");
            // A second DEV_ONLY identity: the owner assigns it for APPROVAL and it acts in its own browser context.
            String reviewerToken = issueDevToken(tenant, reviewer);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            byte[] png = solidPng(0xffff0000);
            String pngSha = sha256(png);
            String sourceId = upload(port, tenant, principal, token, run, "frame-" + run + ".png", "image/png", png);

            Path repoRoot = findMediaRepoRoot();
            Path script = repoRoot.resolve("apps/media-experience-explorer/test/dev-render-review-live-browser.mjs");
            assertThat(Files.isRegularFile(script)).isTrue();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            String viteVersion = packageVersion(viteBinary);
            assertThat(viteVersion).isIn("7.3.1", "8.3.0");
            ProcessBuilder builder = new ProcessBuilder("node", script.toString());
            builder.directory(repoRoot.toFile());
            builder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            Map<String, String> env = builder.environment();
            env.put("MEDIA_DEV_RENDER_REVIEW_BROWSER_TOKEN", token);
            env.put("MEDIA_DEV_RENDER_REVIEW_BROWSER_TENANT", tenant);
            env.put("MEDIA_DEV_RENDER_REVIEW_BROWSER_PRINCIPAL", principal);
            env.put("MEDIA_DEV_RENDER_REVIEW_BROWSER_REVIEWER_TOKEN", reviewerToken);
            env.put("MEDIA_DEV_RENDER_REVIEW_BROWSER_REVIEWER_PRINCIPAL", reviewer);
            env.put("MEDIA_DEV_RENDER_REVIEW_BROWSER_ARTIFACT_ID", sourceId);
            env.put("MEDIA_DEV_RENDER_REVIEW_BROWSER_ARTIFACT_SHA256", pngSha);
            env.put("MEDIA_DEV_RENDER_REVIEW_FORMAT", mp4 ? "mp4" : "gif");
            env.put("MEDIA_DEV_RENDER_REVIEW_BROWSER_DESTINATION_ID", "dev-local-directory");
            env.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(port));
            env.put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            env.put("MEDIA_DEV_VITE_VERSION", viteVersion);
            env.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            browser = builder.start();

            try (BufferedReader output = new BufferedReader(
                    new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8));
                    BufferedWriter input = new BufferedWriter(
                            new OutputStreamWriter(browser.getOutputStream(), StandardCharsets.UTF_8))) {
                JsonNode created = readBrowserEvent(browser, output, "created", log);
                String projectId = created.path("projectId").asString();
                String renderId = created.path("renderId").asString();
                String renderSha = created.path("renderSha").asString();
                String caseId = created.path("reviewCaseId").asString();
                String renderedRevisionId = created.path("renderedRevisionId").asString();
                String expectedType = mp4 ? "video/mp4" : "image/gif";
                assertThat(projectId).isNotBlank();
                assertThat(created.path("editedRevisionId").asString()).isNotEqualTo(renderedRevisionId);

                // The registered render artifact exists exactly once before the restart.
                StoredArtifact before = storedArtifact(POSTGRES, tenant, principal, renderId);
                assertThat(before.contentType()).isEqualTo(expectedType);
                assertThat(before.sha256()).isEqualTo(renderSha);
                assertThat(countArtifacts(tenant, principal, expectedType))
                        .as("one render artifact despite two render clicks (create + replay)").isEqualTo(1);

                stopLauncher(launcher);
                launcher = null;
                launcher = startLauncher(classpath, environment, log);
                awaitReady(launcher, port);
                input.write("host-restarted\n");
                input.flush();

                JsonNode readback = readBrowserEvent(browser, output, "readback", log);
                assertThat(readback.path("renderId").asString()).isEqualTo(renderId);
                assertThat(readback.path("reviewCaseId").asString()).isEqualTo(caseId);
                assertThat(readback.path("exportDestinationId").asString()).isEqualTo("dev-local-directory");
                assertThat(readback.path("exportReceipt").isMissingNode() || readback.path("exportReceipt").isNull())
                        .as("browser export must be destination-confirmed with a receipt").isFalse();
                assertThat(browser.waitFor(90, TimeUnit.SECONDS)).isTrue();
                assertThat(browser.exitValue()).as("live browser script must pass; see " + log).isZero();

                // The destination holds exactly one exported object whose bytes are the render artifact.
                try (var exported = Files.list(destinationDir)) {
                    var files = exported.filter(Files::isRegularFile).toList();
                    assertThat(files).as("exactly one exported object").hasSize(1);
                    assertThat(java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                            .digest(Files.readAllBytes(files.get(0))))).isEqualTo(renderSha);
                }

                // Independent host readback after the restart.
                JsonNode render = get(port, tenant, token, "/dev/v1/projects/" + projectId + "/renders/" + renderId, 200);
                assertThat(render.path("artifact").path("sha256").asString()).isEqualTo(renderSha);
                assertThat(render.path("lineage").path("revisionId").asString()).isEqualTo(renderedRevisionId);
                JsonNode reviewCase = get(port, tenant, token, "/dev/v1/reviews/" + caseId, 200);
                assertThat(reviewCase.toString()).contains("STALE");
                assertThat(reviewCase.toString()).contains("COMMENT").contains("ACCEPT");
                assertThat(reviewCase.path("reviewState").path("status").asString())
                        .isEqualTo("DEV_ASSIGNED_REVIEWER_ACCEPT_STALE");
                assertThat(reviewCase.path("reviewState").path("establishesApproval").asBoolean()).isFalse();
                assertThat(reviewCase.path("reviewState").path("humanReviewApproval").asBoolean()).isFalse();
                assertThat(reviewCase.path("assignments")).hasSize(1);
                JsonNode assignment = reviewCase.path("assignments").get(0);
                assertThat(assignment.path("reviewerPrincipalId").asString()).isEqualTo(reviewer);
                assertThat(assignment.path("assignedByPrincipalId").asString()).isEqualTo(principal);
                assertThat(assignment.path("scopes")).hasSize(1);
                assertThat(assignment.path("scopes").get(0).asString()).isEqualTo("APPROVAL");
                boolean reviewerDecision = false;
                for (JsonNode record : reviewCase.path("records")) {
                    if ("DECISION".equals(record.path("kind").asString())) {
                        assertThat(record.path("recordedAs").asString()).isEqualTo("DEV_ASSIGNED_REVIEWER_ACCEPT");
                        assertThat(record.path("scope").asString()).isEqualTo("APPROVAL");
                        assertThat(record.path("principalId").asString()).isEqualTo(reviewer);
                        reviewerDecision = true;
                    }
                }
                assertThat(reviewerDecision).as("the only decision was recorded by the assigned reviewer").isTrue();

                // Exactly one durable render artifact row and matching S3 object.
                StoredArtifact after = storedArtifact(POSTGRES, tenant, principal, renderId);
                assertThat(after.sha256()).isEqualTo(renderSha);
                assertThat(sha256(s3Bytes(LOCALSTACK, bucket, after))).isEqualTo(renderSha);
                assertThat(countArtifacts(tenant, principal, expectedType)).isEqualTo(1);
            }
            browser = null;
            passed = true;
        } finally {
            if (browser != null && browser.isAlive()) stopProcessTree(browser);
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("Explorer render/review live failure log retained at " + log);
            deleteTree(services);
        }
    }

    private static int countArtifacts(String tenant, String principal, String contentType) throws Exception {
        try (var connection = DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                var statement = connection.prepareStatement(
                        "SELECT count(*) FROM media_artifacts WHERE tenant_id=? AND principal_id=? AND content_type=?")) {
            statement.setString(1, tenant);
            statement.setString(2, principal);
            statement.setString(3, contentType);
            try (var row = statement.executeQuery()) {
                row.next();
                return row.getInt(1);
            }
        }
    }

    private static JsonNode readBrowserEvent(Process browser, BufferedReader output, String expectedEvent, Path log)
            throws Exception {
        FutureTask<String> lineTask = new FutureTask<>(output::readLine);
        Thread reader = new Thread(lineTask, "media-dev-live-browser-output");
        reader.setDaemon(true);
        reader.start();
        String line;
        try {
            line = lineTask.get(130, TimeUnit.SECONDS);
        } catch (java.util.concurrent.TimeoutException timeout) {
            stopProcessTree(browser);
            String processState = browser.isAlive() ? "still-running" : "exit=" + browser.exitValue();
            String diagnostics = Files.exists(log) ? Files.readString(log) : "<no browser log>";
            throw new AssertionError("Timed out waiting for browser event " + expectedEvent
                    + "; process=" + processState + "; log=" + diagnostics, timeout);
        }
        String processState = browser.isAlive() ? "still-running" : "exit=" + browser.exitValue();
        String diagnostics = Files.exists(log) ? Files.readString(log) : "<no browser log>";
        assertThat(line).as("browser event " + expectedEvent + "; process=" + processState + "; log=" + diagnostics)
                .isNotNull();
        JsonNode event = JSON.readTree(line);
        assertThat(event.path("event").asString()).isEqualTo(expectedEvent);
        return event;
    }

    private static void stopProcessTree(Process process) throws InterruptedException {
        if (process == null) return;
        var descendants = process.toHandle().descendants().toList();
        for (int index = descendants.size() - 1; index >= 0; index--) {
            descendants.get(index).destroy();
        }
        process.destroy();
        if (!process.waitFor(3, TimeUnit.SECONDS)) process.destroyForcibly();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        for (ProcessHandle descendant : descendants) {
            if (!descendant.isAlive()) continue;
            descendant.destroyForcibly();
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0) break;
            try {
                descendant.onExit().get(remaining, TimeUnit.NANOSECONDS);
            } catch (java.util.concurrent.TimeoutException ignored) {
                break;
            } catch (java.util.concurrent.ExecutionException ignored) {
                // The descendant already exited; continue cleaning up siblings.
            }
        }
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
        if (Files.isRegularFile(local)) {
            assertThat(packageVersion(local)).as("workspace Vite pin").isEqualTo("7.3.1");
            return local;
        }
        Path localPnpm = findPnpmPackageBinary(repoRoot, "vite@7.3.1", "vite/bin/vite.js");
        if (localPnpm != null) {
            assertThat(packageVersion(localPnpm)).as("workspace Vite pin").isEqualTo("7.3.1");
            return localPnpm;
        }
        Path globalRoot = globalNodeModules();
        Path globalVite = globalRoot.resolve("vitest/node_modules/vite/bin/vite.js");
        assertThat(Files.isRegularFile(globalVite))
                .as("Vite 8.3.0 from the documented global Vitest toolchain is required when the workspace link is absent")
                .isTrue();
        assertThat(packageVersion(globalVite)).as("documented host Vite fallback pin").isEqualTo("8.3.0");
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
        assertThat(Files.isRegularFile(global))
                .as("Playwright 1.63.0 global runner is required when the workspace package link is absent").isTrue();
        return global;
    }

    private static Path findPnpmPackageBinary(Path repoRoot, String packagePrefix, String relativeBinary)
            throws Exception {
        Path pnpmStore = repoRoot.resolve("node_modules/.pnpm");
        if (!Files.isDirectory(pnpmStore)) return null;
        try (var entries = Files.list(pnpmStore)) {
            return entries.filter(path -> path.getFileName().toString().startsWith(packagePrefix))
                    .map(path -> path.resolve("node_modules").resolve(relativeBinary))
                    .filter(Files::isRegularFile)
                    .findFirst().orElse(null);
        }
    }

    private static String packageVersion(Path executable) throws Exception {
        Path resolved = executable.toRealPath();
        Path packageJson = resolved.getParent().getParent().resolve("package.json");
        return JSON.readTree(Files.readString(packageJson)).path("version").asString();
    }

    private static Path globalNodeModules() throws Exception {
        Process npm = new ProcessBuilder("npm", "root", "-g").redirectErrorStream(true).start();
        byte[] output = npm.getInputStream().readAllBytes();
        assertThat(npm.waitFor(10, TimeUnit.SECONDS)).as("npm root -g must finish").isTrue();
        assertThat(npm.exitValue()).as("npm root -g output: " + new String(output, StandardCharsets.UTF_8)).isZero();
        return Path.of(new String(output, StandardCharsets.UTF_8).trim());
    }

}
