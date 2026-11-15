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
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.http.HttpResponse;
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
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffmpeg;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffprobe;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-21 in a real browser: two Chromium contexts (uploader and reviewer, distinct TEST tokens) drive the Explorer
 * "Versioned review" page against a real launcher (PostgreSQL + S3). The reviewer plays the exact, digest-verified
 * version, adds time-coded comments and accepts it; the host then registers a revised version through the intake lane;
 * both pages show the earlier acceptance as STALE and the new version as not reviewed, a late decision on the old version
 * is a typed 409, and the uploader cannot decide their own revision (typed 403). The Java side then reads the review
 * records from PostgreSQL and proves delivery of the old version is refused and the re-reviewed one is exported with the
 * exact bytes. TEST identities only: nothing here is a human or production approval.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevExplorerVersionedReviewLiveIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void uploaderAndReviewerBrowsersReviewAnExactVersionAndSeeItStaleWhenTheSourceIsRevised() throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(ffmpeg() != null && ffprobe() != null, "FFmpeg/FFprobe are required");
        Path repoRoot = findMediaRepoRoot();
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-explorer-vreview-" + run;
        String uploader = "test-principal-uploader-" + run;
        String reviewer = "test-principal-reviewer-" + run;
        String confirmer = "test-principal-confirmer-" + run;
        String bucket = "media-dev-ui-vreview-" + run.substring(0, 12);
        String schema = "media_dev_ui_vreview_" + run.substring(0, 12);
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-ui-vreview-services-");
        Path work = Files.createTempDirectory("media-dev-ui-vreview-work-");
        Path destination = Files.createTempDirectory("media-dev-ui-vreview-destination-");
        Path log = Files.createTempFile("media-dev-ui-vreview-process-", ".log");
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
            environment.put("MEDIA_DEV_REVIEW_ENABLED", "true");
            environment.put("MEDIA_DEV_REVIEW_REQUIRED_FOR_DELIVERY", "true");
            environment.put("MEDIA_DELIVERY_DEV_ENABLED", "true");
            environment.put("MEDIA_DELIVERY_DEV_DESTINATION_DIR", destination.toString());
            environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg());
            environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe());
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            byte[] mp4v1 = mp4(work, "v1.mp4", "testsrc2=size=320x240:rate=12:duration=3", 440);
            byte[] mp4v2 = mp4(work, "v2.mp4", "smptebars=size=320x240:rate=12:duration=3", 660);
            String lineage = "ui-review-" + run;
            String uploaderApiToken = issueDevToken(tenant, uploader, "media:delivery:dev:export", "media:delivery:dev:read");
            String id1 = upload(port, tenant, uploader, uploaderApiToken, run + "-v1", "cut-v1.mp4", "video/mp4", mp4v1);
            String id2 = upload(port, tenant, uploader, uploaderApiToken, run + "-v2", "cut-v2.mp4", "video/mp4", mp4v2);
            String ver1 = "sha256:" + sha256(mp4v1);
            String ver2 = "sha256:" + sha256(mp4v2);
            post(port, tenant, uploaderApiToken, "/dev/v1/intakes", Map.of("lineageId", lineage, "artifactId", id1,
                    "artifactVersionId", ver1), 201);

            Path script = repoRoot.resolve("apps/media-experience-explorer/test/dev-review-live-browser.mjs");
            assertThat(script).isRegularFile();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            ProcessBuilder builder = new ProcessBuilder("node", script.toString());
            builder.directory(repoRoot.toFile());
            builder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            Map<String, String> env = builder.environment();
            env.put("MEDIA_DEV_REVIEW_UPLOADER_TOKEN", issueDevToken(tenant, uploader));
            env.put("MEDIA_DEV_REVIEW_REVIEWER_TOKEN", issueDevToken(tenant, reviewer));
            env.put("MEDIA_DEV_REVIEW_REVIEWER_PRINCIPAL", reviewer);
            env.put("MEDIA_DEV_REVIEW_LINEAGE_ID", lineage);
            env.put("MEDIA_DEV_REVIEW_V1_SHA256", sha256(mp4v1));
            env.put("MEDIA_DEV_REVIEW_V2_SHA256", sha256(mp4v2));
            env.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(port));
            env.put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            env.put("MEDIA_DEV_VITE_VERSION", packageVersion(viteBinary));
            env.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            browser = builder.start();
            JsonNode approved;
            JsonNode last;
            try (BufferedReader output = new BufferedReader(new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8));
                 BufferedWriter input = new BufferedWriter(new OutputStreamWriter(browser.getOutputStream(), StandardCharsets.UTF_8))) {
                approved = readEvent(browser, output, "approved", log, 600);
                // the source is revised while both browsers are open: version 2 joins the lineage through the intake lane
                post(port, tenant, uploaderApiToken, "/dev/v1/intakes", Map.of("lineageId", lineage, "artifactId", id2,
                        "artifactVersionId", ver2), 201);
                input.write("REVISED\n");
                input.flush();
                last = readEvent(browser, output, "re-reviewed", log, 600);
            }
            assertThat(browser.waitFor(120, TimeUnit.SECONDS)).isTrue();
            assertThat(browser.exitValue()).as("live browser script must pass; see " + log).isZero();
            browser = null;
            System.out.println("J21_UI_BROWSER_EVENTS " + approved + " " + last);
            assertThat(approved.path("playbackAdvancedSeconds").asDouble()).as("the browser played the verified video").isGreaterThan(0.3);

            // ---- independent readback of what the two browsers did ----
            String caseId1 = approved.path("caseId1").asString();
            String caseId2 = last.path("caseId2").asString();
            String uploaderToken = issueDevToken(tenant, uploader, "media:delivery:dev:export", "media:delivery:dev:read");
            String reviewerToken = issueDevToken(tenant, reviewer);
            JsonNode case1 = get(port, tenant, reviewerToken, "/dev/v1/reviews/" + caseId1, 200);
            assertThat(case1.path("currentness").asString()).isEqualTo("STALE");
            assertThat(case1.path("reviewState").path("status").asString()).isEqualTo("DEV_ASSIGNED_REVIEWER_ACCEPT_STALE");
            long comments = 0;
            for (JsonNode record : case1.path("records")) {
                if ("COMMENT".equals(record.path("kind").asString())) {
                    comments++;
                    assertThat(record.path("principalId").asString()).isEqualTo(reviewer);
                    assertThat(record.path("annotation").has("timeRange")).as("time-coded").isTrue();
                }
                if ("DECISION".equals(record.path("kind").asString())) {
                    assertThat(record.path("principalId").asString()).isEqualTo(reviewer).isNotEqualTo(uploader);
                }
            }
            assertThat(comments).isEqualTo(2);
            assertThat(reviewRows(schema, caseId1, "media_review_records")).as("2 comments + 1 decision; the late decision and the uploader's refused one recorded nothing").isEqualTo(3);
            assertThat(reviewRows(schema, caseId2, "media_review_records")).isEqualTo(1);
            JsonNode lineageView = get(port, tenant, uploaderToken, "/dev/v1/review-lineages/" + lineage, 200);
            assertThat(lineageView.path("versions").get(0).path("state").asString()).isEqualTo("ACCEPT_STALE");
            assertThat(lineageView.path("versions").get(1).path("state").asString()).isEqualTo("ACCEPT_CURRENT");
            // delivery: the superseded version is refused; the re-reviewed head is exported with the exact bytes
            for (String[] artifact : new String[][] {{id1, ver1}, {id2, ver2}}) {
                String attestation = post(port, tenant, uploaderToken, "/dev/v1/rights/attestations", Map.of("artifactId", artifact[0],
                        "artifactVersionId", artifact[1], "statementKind", "MEDIA_RIGHTS", "scopes", List.of("EXTERNAL_DELIVERY"),
                        "basis", "TEST: synthetic media generated by the test"), 201).path("attestationId").asString();
                HttpResponse<String> confirmed = send(port, tenant, issueDevToken(tenant, confirmer), "POST",
                        "/dev/v1/rights/attestations/" + attestation + "/confirm", "{}");
                assertThat(confirmed.statusCode()).as(confirmed.body()).isEqualTo(200);
            }
            HttpResponse<String> refused = send(port, tenant, uploaderToken, "POST", "/dev/v1/exports", JSON.writeValueAsString(
                    Map.of("requestId", "ui-export-v1-" + run, "artifactId", id1, "artifactVersionId", ver1, "destinationId", "dev-local-directory")));
            assertThat(refused.statusCode()).as(refused.body()).isEqualTo(409);
            assertThat(JSON.readTree(refused.body()).path("error").path("code").asString()).isEqualTo("EXPORT_REVIEW_SUPERSEDED");
            assertThat(destinationFiles(destination)).isEmpty();
            JsonNode exported = post(port, tenant, uploaderToken, "/dev/v1/exports", Map.of("requestId", "ui-export-v2-" + run,
                    "artifactId", id2, "artifactVersionId", ver2, "destinationId", "dev-local-directory"), 201);
            assertThat(exported.path("status").asString()).isEqualTo("DESTINATION_CONFIRMED");
            assertThat(destinationFiles(destination)).hasSize(1);
            assertThat(Files.readAllBytes(destinationFiles(destination).get(0))).isEqualTo(mp4v2);
            passed = true;
        } finally {
            if (browser != null && browser.isAlive()) stopProcessTree(browser);
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            deleteTree(services);
            deleteTree(work);
            deleteTree(destination);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("Explorer versioned review live failure log retained at " + log);
        }
    }

    private static JsonNode readEvent(Process browser, BufferedReader output, String expectedEvent, Path log, int seconds) throws Exception {
        FutureTask<String> lineTask = new FutureTask<>(output::readLine);
        Thread reader = new Thread(lineTask, "media-dev-vreview-live-browser-output");
        reader.setDaemon(true);
        reader.start();
        String line;
        try {
            line = lineTask.get(seconds, TimeUnit.SECONDS);
        } catch (java.util.concurrent.TimeoutException timeout) {
            stopProcessTree(browser);
            throw new AssertionError("Timed out waiting for browser event " + expectedEvent + "; log="
                    + (Files.exists(log) ? Files.readString(log) : "<no log>"), timeout);
        }
        assertThat(line).as("browser event " + expectedEvent + "; process=" + (browser.isAlive() ? "running" : "exit=" + browser.exitValue())
                + "; log=" + (Files.exists(log) ? Files.readString(log) : "<no log>")).isNotNull();
        JsonNode event = JSON.readTree(line);
        assertThat(event.path("event").asString()).isEqualTo(expectedEvent);
        return event;
    }

    private static List<Path> destinationFiles(Path destination) throws Exception {
        try (var files = Files.list(destination)) { return files.filter(Files::isRegularFile).sorted().toList(); }
    }

    private static int reviewRows(String schema, String caseId, String table) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement("SELECT count(*) FROM " + schema + "." + table + " WHERE review_case_id=?")) {
            statement.setString(1, caseId);
            try (var rows = statement.executeQuery()) { rows.next(); return rows.getInt(1); }
        }
    }

    private static byte[] mp4(Path work, String name, String video, int toneHz) throws Exception {
        Path out = work.resolve(name);
        Process process = new ProcessBuilder(ffmpeg(), "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", video,
                "-f", "lavfi", "-i", "sine=frequency=" + toneHz + ":duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-shortest", "-movflags", "+faststart", out.toString()).redirectErrorStream(true).start();
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(process.waitFor(2, TimeUnit.MINUTES)).isTrue();
        assertThat(process.exitValue()).as("ffmpeg: " + output).isZero();
        return Files.readAllBytes(out);
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
