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
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
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
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-03 UI: real Chromium drives the Explorer caption correction page against a real launcher process (PostgreSQL + S3)
 * holding REAL Whisper output of whisper.cpp's bundled {@code samples/jfk.wav} (MIT repository; US government
 * public-domain speech). The page edits by keyboard, saves new versions, retries an unknown outcome idempotently,
 * meets a stale-base conflict, lets the owner assign a reviewer and a second browser context (the assigned reviewer)
 * accept the exact version, then everything is read back after a launcher restart. Principals are synthetic test
 * principals; no decision is a human approval.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevExplorerCaptionCorrectionLiveIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private static final Path MODEL_ROOT = Path.of(System.getProperty("user.home"), ".local", "share", "ghatana-media");
    private static final Path JFK = MODEL_ROOT.resolve("runtimes/whisper.cpp-src/samples/jfk.wav");

    @Test
    void explorerCorrectsRealWhisperCaptionsByKeyboardRetriesUnknownMeetsConflictAndAssignedReviewerAcceptsAcrossRestart()
            throws Exception {
        Map<String, String> probe = Map.of("MEDIA_LOCAL_MODEL_ROOT", MODEL_ROOT.toString(),
                "MEDIA_WHISPER_CPP_BIN", MODEL_ROOT.resolve("runtimes/whisper.cpp-src/build-vulkan/bin/whisper-cli").toString(),
                "MEDIA_WHISPER_CPP_THREADS", "8");
        assumeTrue(Files.isRegularFile(JFK) && com.ghatana.stt.provider.LocalWhisperCppSttProvider
                        .fromEnvironment(probe).ready(),
                "the verified whisper.cpp runtime/model and jfk.wav sample are not installed on this host");
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-j03-ui-" + run;
        String owner = "test-principal-owner-" + run;
        String reviewer = "test-principal-reviewer-" + run;
        String bucket = "media-dev-j03-ui-" + run;
        String schema = "media_dev_j03_ui_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-j03-ui-services-");
        Path log = Files.createTempFile("media-dev-j03-ui-process-", ".log");
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
            environment.put("MEDIA_DEV_REVIEW_ENABLED", "true");
            environment.putAll(probe);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            // Real input and real Whisper through the host (6 s of the sample keeps the transcript short).
            byte[] audio = trim(Files.readAllBytes(JFK), 6);
            String seedToken = issueDevToken(tenant, owner);
            String audioId = upload(port, tenant, owner, seedToken, run + "-jfk", "jfk-6s.wav", "audio/wav", audio);
            String audioVersion = "sha256:" + sha256(audio);
            post(port, tenant, seedToken, "/dev/v1/rights/attestations", Map.of("artifactId", audioId,
                    "artifactVersionId", audioVersion, "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                    "basis", "TEST: whisper.cpp samples/jfk.wav (MIT-licensed repository; a US government public-domain "
                            + "speech) used by an automated test; a statement by a synthetic test principal, not a "
                            + "legal determination"), 201);
            JsonNode stt = post(port, tenant, seedToken, "/dev/v1/speech/transcriptions", Map.of(
                    "requestId", "stt-ui-" + run, "artifactId", audioId, "artifactVersionId", audioVersion,
                    "language", "en"), 201);
            System.out.println("J03_UI_REAL_WHISPER_TRANSCRIPT text=\"" + stt.path("text").asString() + "\"");
            String machineId = stt.path("captions").path("artifact").path("artifactId").asString();
            String machineVersion = stt.path("captions").path("artifact").path("artifactVersionId").asString();

            Path repoRoot = findMediaRepoRoot();
            Path script = repoRoot.resolve("apps/media-experience-explorer/test/dev-caption-correction-live-browser.mjs");
            assertThat(Files.isRegularFile(script)).isTrue();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            String viteVersion = packageVersion(viteBinary);
            assertThat(viteVersion).isIn("7.3.1", "8.3.0");
            ProcessBuilder builder = new ProcessBuilder("node", script.toString());
            builder.directory(repoRoot.toFile());
            builder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            Map<String, String> env = builder.environment();
            env.put("MEDIA_DEV_CAPTION_BROWSER_TOKEN", issueDevToken(tenant, owner));
            env.put("MEDIA_DEV_CAPTION_BROWSER_PRINCIPAL", owner);
            env.put("MEDIA_DEV_CAPTION_BROWSER_REVIEWER_TOKEN", issueDevToken(tenant, reviewer));
            env.put("MEDIA_DEV_CAPTION_BROWSER_REVIEWER_PRINCIPAL", reviewer);
            env.put("MEDIA_DEV_CAPTION_BROWSER_MACHINE_ID", machineId);
            env.put("MEDIA_DEV_CAPTION_BROWSER_MACHINE_VERSION", machineVersion);
            env.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(port));
            env.put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            env.put("MEDIA_DEV_VITE_VERSION", viteVersion);
            env.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            browser = builder.start();

            try (BufferedReader output = new BufferedReader(new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8));
                 BufferedWriter input = new BufferedWriter(new OutputStreamWriter(browser.getOutputStream(), StandardCharsets.UTF_8))) {
                JsonNode created = readBrowserEvent(browser, output, "created", log);
                String v1 = created.path("v1").asString();
                String v2 = created.path("v2").asString();
                String caseId = created.path("reviewCaseId").asString();
                assertThat(List.of(machineId, v1, v2)).doesNotHaveDuplicates();

                // Exactly the machine version, v1 and v2 exist as WebVTT: the unknown-outcome retry and the stale
                // conflict created no extra version.
                assertThat(count(tenant, owner, "text/vtt")).as("machine + v1 + v2").isEqualTo(3);
                JsonNode second = get(port, tenant, issueDevToken(tenant, owner), "/dev/v1/captions/" + v2, 200);
                assertThat(second.path("lineage").path("parent").path("artifactId").asString()).isEqualTo(v1);
                assertThat(second.path("lineage").path("machineVersion").path("artifactId").asString()).isEqualTo(machineId);
                assertThat(second.path("lineage").path("correctedByPrincipalId").asString()).isEqualTo(owner);
                assertThat(second.path("lineage").path("correctionNumber").asInt()).isEqualTo(2);
                assertThat(second.path("review").path("acceptedByAssignedReviewer").asBoolean()).isTrue();
                assertThat(get(port, tenant, issueDevToken(tenant, owner), "/dev/v1/captions/" + v1, 200)
                        .path("review").path("acceptedByAssignedReviewer").asBoolean()).isFalse();
                assertThat(get(port, tenant, issueDevToken(tenant, owner), "/dev/v1/captions/" + machineId, 200)
                        .path("artifact").path("sha256").asString()).isEqualTo(machineVersion.substring("sha256:".length()));

                stopLauncher(launcher);
                launcher = startLauncher(classpath, environment, log);
                awaitReady(launcher, port);
                input.write("host-restarted\n");
                input.flush();

                JsonNode readback = readBrowserEvent(browser, output, "readback", log);
                assertThat(readback.path("v2").asString()).isEqualTo(v2);
                assertThat(readback.path("reviewCaseId").asString()).isEqualTo(caseId);
                assertThat(browser.waitFor(90, TimeUnit.SECONDS)).isTrue();
                assertThat(browser.exitValue()).as("live browser script must pass; see " + log).isZero();
                assertThat(count(tenant, owner, "text/vtt")).as("readback created nothing").isEqualTo(3);
                JsonNode reviewCase = get(port, tenant, issueDevToken(tenant, owner), "/dev/v1/reviews/" + caseId, 200);
                assertThat(reviewCase.path("reviewState").path("status").asString())
                        .isEqualTo("DEV_ASSIGNED_REVIEWER_ACCEPT_CURRENT");
                assertThat(reviewCase.path("reviewState").path("humanReviewApproval").asBoolean()).isFalse();
                assertThat(reviewCase.path("assignments").get(0).path("reviewerPrincipalId").asString()).isEqualTo(reviewer);
            }
            browser = null;
            passed = true;
        } finally {
            if (browser != null && browser.isAlive()) stopProcessTree(browser);
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("Caption correction live failure log retained at " + log);
            deleteTree(services);
        }
    }

    private static int count(String tenant, String principal, String contentType) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
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

    private static byte[] trim(byte[] wav, int seconds) {
        int dataAt = -1;
        for (int i = 12; i + 8 < wav.length; ) {
            String id = new String(wav, i, 4, StandardCharsets.US_ASCII);
            int size = ByteBuffer.wrap(wav, i + 4, 4).order(ByteOrder.LITTLE_ENDIAN).getInt();
            if (id.equals("data")) { dataAt = i + 8; break; }
            i += 8 + size + (size & 1);
        }
        assertThat(dataAt).isPositive();
        int data = Math.min(seconds * 16_000 * 2, wav.length - dataAt);
        ByteBuffer out = ByteBuffer.allocate(44 + data).order(ByteOrder.LITTLE_ENDIAN);
        out.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + data).put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII))
                .putInt(16).putShort((short) 1).putShort((short) 1).putInt(16_000).putInt(32_000).putShort((short) 2)
                .putShort((short) 16).put("data".getBytes(StandardCharsets.US_ASCII)).putInt(data);
        out.put(wav, dataAt, data);
        return out.array();
    }

    private static JsonNode readBrowserEvent(Process browser, BufferedReader output, String expectedEvent, Path log)
            throws Exception {
        FutureTask<String> lineTask = new FutureTask<>(output::readLine);
        Thread reader = new Thread(lineTask, "media-dev-j03-browser-output");
        reader.setDaemon(true);
        reader.start();
        String line;
        try {
            line = lineTask.get(170, TimeUnit.SECONDS);
        } catch (java.util.concurrent.TimeoutException timeout) {
            stopProcessTree(browser);
            throw new AssertionError("Timed out waiting for browser event " + expectedEvent + "; log="
                    + (Files.exists(log) ? Files.readString(log) : "<none>"), timeout);
        }
        String state = browser.isAlive() ? "still-running" : "exit=" + browser.exitValue();
        assertThat(line).as("browser event " + expectedEvent + "; process=" + state + "; log="
                + (Files.exists(log) ? Files.readString(log) : "<none>")).isNotNull();
        JsonNode event = JSON.readTree(line);
        assertThat(event.path("event").asString()).isEqualTo(expectedEvent);
        return event;
    }

    private static void stopProcessTree(Process process) throws InterruptedException {
        if (process == null) return;
        var descendants = process.toHandle().descendants().toList();
        for (int index = descendants.size() - 1; index >= 0; index--) descendants.get(index).destroy();
        process.destroy();
        if (!process.waitFor(3, TimeUnit.SECONDS)) process.destroyForcibly();
        for (ProcessHandle descendant : descendants) {
            if (descendant.isAlive()) descendant.destroyForcibly();
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
        Path globalVite = globalNodeModules().resolve("vitest/node_modules/vite/bin/vite.js");
        assertThat(Files.isRegularFile(globalVite)).as("a pinned Vite is required").isTrue();
        assertThat(packageVersion(globalVite)).isEqualTo("8.3.0");
        return globalVite;
    }

    private static Path findPlaywrightModule(Path repoRoot) throws Exception {
        for (String candidate : List.of("node_modules/playwright/index.mjs",
                "apps/media-experience-explorer/node_modules/playwright/index.mjs")) {
            Path local = repoRoot.resolve(candidate);
            if (Files.isRegularFile(local)) return local;
        }
        Path global = globalNodeModules().resolve("@playwright/test/index.mjs");
        assertThat(Files.isRegularFile(global)).as("Playwright 1.63.0 is required").isTrue();
        return global;
    }

    private static String packageVersion(Path executable) throws Exception {
        Path resolved = executable.toRealPath();
        Path packageJson = resolved.getParent().getParent().resolve("package.json");
        return JSON.readTree(Files.readString(packageJson)).path("version").asString();
    }

    private static Path globalNodeModules() throws Exception {
        Process npm = new ProcessBuilder("npm", "root", "-g").redirectErrorStream(true).start();
        byte[] output = npm.getInputStream().readAllBytes();
        assertThat(npm.waitFor(10, TimeUnit.SECONDS)).isTrue();
        return Path.of(new String(output, StandardCharsets.UTF_8).trim());
    }
}
