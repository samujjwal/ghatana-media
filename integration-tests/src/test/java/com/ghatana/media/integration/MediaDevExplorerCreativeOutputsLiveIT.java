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
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * Real Chromium drives the Explorer "Creative outputs" page against a real launcher process (PostgreSQL + S3): audio
 * repair of a seeded clipped WAV, a valid/rejected simulation pair, a scientific simulation PNG, a project-revision GIF
 * and a spatial GLB from seeded source artifacts. Installed clients read immutable output versions; Chromium decodes
 * PNG/GIF/WAV and the pinned Khronos validator checks GLB. The launcher then restarts and every registered output is
 * read back. Sources are uploaded over HTTP because this page has no upload path. Each output must be registered
 * exactly once in PostgreSQL and S3.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevExplorerCreativeOutputsLiveIT {
    private static final int RATE = 8_000;
    private static final int MAX_CONTAINER_CPUS = 4;
    private static final Pattern CPU_SET_ENTRY = Pattern.compile("^([0-9]+)(?:-([0-9]+))?$");
    private static final String CONTAINER_CPU_SET = configuredContainerCpuSet();

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"))
            .withCreateContainerCmdModifier(command -> command.withCpusetCpus(CONTAINER_CPU_SET));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3)
            .withCreateContainerCmdModifier(command -> command.withCpusetCpus(CONTAINER_CPU_SET));

    private static String configuredContainerCpuSet() {
        String configured = System.getenv("GHATANA_CPUSET");
        return validatedContainerCpuSet(configured == null || configured.isEmpty() ? "0-3" : configured);
    }

    private static String validatedContainerCpuSet(String cpuSet) {
        int selectedCpuCount = 0;
        for (String entry : cpuSet.split(",", -1)) {
            Matcher matcher = CPU_SET_ENTRY.matcher(entry);
            if (!matcher.matches()) {
                throw new IllegalArgumentException("Invalid CPU selection in GHATANA_CPUSET: " + entry);
            }
            long first;
            long last;
            try {
                first = Long.parseLong(matcher.group(1));
                last = matcher.group(2) == null ? first : Long.parseLong(matcher.group(2));
            } catch (NumberFormatException invalidCpuId) {
                throw new IllegalArgumentException("Invalid CPU selection in GHATANA_CPUSET: " + entry,
                        invalidCpuId);
            }
            if (first > last) {
                throw new IllegalArgumentException("Invalid CPU range in GHATANA_CPUSET: " + entry);
            }
            long rangeDifference = last - first;
            if (rangeDifference >= MAX_CONTAINER_CPUS - selectedCpuCount) {
                throw new IllegalArgumentException("GHATANA_CPUSET may select at most " + MAX_CONTAINER_CPUS
                        + " CPUs for PostgreSQL and LocalStack containers");
            }
            selectedCpuCount += (int) (rangeDifference + 1);
        }
        return cpuSet;
    }

    @Test
    void explorerCreatesVerifiesAndReopensCreativeOutputsAcrossLauncherRestart() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-explorer-co-" + run;
        String principal = "media-dev-explorer-co-" + run;
        String bucket = "media-dev-explorer-co-" + run;
        String schema = "media_dev_explorer_co_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-explorer-co-services-");
        Path log = Files.createTempFile("media-dev-explorer-co-process-", ".log");
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
            String token = issueDevToken(tenant, principal);
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            // ---- sources, seeded over HTTP ----
            byte[] clipped = clippedWav(36_000);
            String wavSha = sha256(clipped);
            String wavId = upload(port, tenant, principal, token, run + "-wav", "clipped.wav", "audio/wav", clipped);
            byte[] pngA = solidPng(0xffff0000);
            byte[] pngB = solidPng(0xff0000ff);
            String pngAId = upload(port, tenant, principal, token, run + "-a", "rig-a.png", "image/png", pngA);
            String pngBId = upload(port, tenant, principal, token, run + "-b", "rig-b.png", "image/png", pngB);
            List<Map<String, Object>> sources = List.of(
                    Map.of("artifactId", pngBId, "artifactVersionId", "sha256:" + sha256(pngB)),
                    Map.of("artifactId", pngAId, "artifactVersionId", "sha256:" + sha256(pngA)));
            String rigJson = JSON.writeValueAsString(spatialBody("unused", "rig-1", sources).get("rig"));

            Path repoRoot = findMediaRepoRoot();
            Path script = repoRoot.resolve("apps/media-experience-explorer/test/dev-creative-outputs-live-browser.mjs");
            assertThat(Files.isRegularFile(script)).isTrue();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            String viteVersion = packageVersion(viteBinary);
            assertThat(viteVersion).isIn("7.3.1", "8.3.0");
            ProcessBuilder builder = new ProcessBuilder("node", script.toString());
            builder.directory(repoRoot.toFile());
            builder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            Map<String, String> env = builder.environment();
            env.put("MEDIA_DEV_CREATIVE_BROWSER_TOKEN", token);
            env.put("MEDIA_DEV_CREATIVE_BROWSER_TENANT_ID", tenant);
            env.put("MEDIA_DEV_CREATIVE_BROWSER_PRINCIPAL_ID", principal);
            env.put("MEDIA_DEV_CREATIVE_BROWSER_WAV_ID", wavId);
            env.put("MEDIA_DEV_CREATIVE_BROWSER_WAV_SHA256", wavSha);
            env.put("MEDIA_DEV_CREATIVE_BROWSER_RIG_JSON", rigJson);
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
                String audioId = created.path("audioId").asString();
                String simId = created.path("simId").asString();
                String scientificSimulationId = created.path("scientificSimulationId").asString();
                String scientificResultSha = created.path("scientificResultSha").asString();
                String scientificScenarioSha = created.path("scientificScenarioSha").asString();
                String pngId = created.path("pngArtifactId").asString();
                String pngSha = created.path("pngSha").asString();
                String gifId = created.path("gifId").asString();
                String gifSha = created.path("gifSha").asString();
                String glbId = created.path("glbId").asString();
                String audioSha = created.path("audioSha").asString();
                String simSha = created.path("simSha").asString();
                String glbSha = created.path("glbSha").asString();
                String projectId = created.path("projectId").asString();
                String projectRevisionId = created.path("projectRevisionId").asString();
                String sourceProjectRevisionRef = created.path("sourceProjectRevisionRef").asString();
                assertThat(created.path("rejectedFindings").asString()).contains("terminal-position");
                assertThat(created.path("installedClient").asBoolean()).isTrue();
                assertThat(created.path("glbValidation").path("assetSha256").asString()).isEqualTo(glbSha);
                assertThat(created.path("pngDecode").path("width").asInt()).isEqualTo(800);
                assertThat(created.path("pngDecode").path("height").asInt()).isEqualTo(400);
                assertThat(created.path("gifDecode").path("width").asInt()).isEqualTo(64);
                assertThat(created.path("gifDecode").path("height").asInt()).isEqualTo(64);
                assertThat(created.path("wavDecode").path("duration").asDouble()).isBetween(0.9, 1.1);
                assertThat(sourceProjectRevisionRef).isEqualTo("project_revision:" + projectId + "@" + projectRevisionId);

                // ---- exactly-once registration: rows and S3 bytes ----
                assertThat(countArtifacts(tenant, principal, "audio/wav"))
                        .as("source WAV + one repaired WAV despite the create and replay clicks").isEqualTo(2);
                assertThat(countArtifacts(tenant, principal, "application/json"))
                        .as("one creative simulation plus one scientific simulation result; the REJECTED run registered nothing")
                        .isEqualTo(2);
                assertThat(countArtifacts(tenant, principal, "image/png"))
                        .as("two seeded PNG sources plus one durable scientific plot").isEqualTo(3);
                assertThat(countArtifacts(tenant, principal, "image/gif")).as("one exact-revision GIF render").isEqualTo(1);
                assertThat(countArtifacts(tenant, principal, "model/gltf-binary")).isEqualTo(1);
                StoredArtifact audioRow = storedArtifact(POSTGRES, tenant, principal, audioId);
                assertThat(audioRow.sha256()).isEqualTo(audioSha);
                byte[] audioBytes = s3Bytes(LOCALSTACK, bucket, audioRow);
                assertThat(sha256(audioBytes)).isEqualTo(audioSha);
                assertThat(audioBytes).hasSameSizeAs(clipped).isNotEqualTo(clipped);
                assertThat(s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, wavId)))
                        .as("the source WAV is never modified").isEqualTo(clipped);
                StoredArtifact simRow = storedArtifact(POSTGRES, tenant, principal, simId);
                assertThat(simRow.contentType()).isEqualTo("application/json");
                byte[] simBytes = s3Bytes(LOCALSTACK, bucket, simRow);
                assertThat(sha256(simBytes)).isEqualTo(simSha);
                JsonNode simDocument = JSON.readTree(new String(simBytes, StandardCharsets.UTF_8));
                assertThat(simDocument.path("outputKind").asString()).isEqualTo("SIMULATED_OUTPUT_NOT_MEASUREMENT");
                assertThat(simDocument.path("observations").size()).as("page table rows come from the stored document")
                        .isEqualTo(created.path("simRows").asInt());
                assertThat(scientificSimulationId).isNotBlank().isNotEqualTo(simId);
                StoredArtifact scientificResultRow = storedArtifact(POSTGRES, tenant, principal, scientificSimulationId);
                assertThat(scientificResultRow.contentType()).isEqualTo("application/json");
                assertThat(scientificResultRow.sha256()).isEqualTo(scientificResultSha);
                byte[] scientificResultBytes = s3Bytes(LOCALSTACK, bucket, scientificResultRow);
                assertThat(sha256(scientificResultBytes)).isEqualTo(scientificResultSha);
                JsonNode scientificDocument = JSON.readTree(new String(scientificResultBytes, StandardCharsets.UTF_8));
                assertThat(scientificDocument.path("schema").asString()).isEqualTo("media.dev.simulation-result.v1");
                assertThat(scientificDocument.path("scope").asString()).isEqualTo("DEV_ONLY");
                assertThat(scientificDocument.path("scenarioSha256").asString()).isEqualTo(scientificScenarioSha);
                assertThat(scientificDocument.path("productionEligible").asBoolean()).isFalse();
                StoredArtifact pngRow = storedArtifact(POSTGRES, tenant, principal, pngId);
                assertThat(pngRow.contentType()).isEqualTo("image/png");
                byte[] pngBytes = s3Bytes(LOCALSTACK, bucket, pngRow);
                assertThat(sha256(pngBytes)).isEqualTo(pngSha);
                assertThat(pngBytes).startsWith(new byte[] {(byte) 0x89, 0x50, 0x4e, 0x47});
                StoredArtifact gifRow = storedArtifact(POSTGRES, tenant, principal, gifId);
                assertThat(gifRow.contentType()).isEqualTo("image/gif");
                byte[] gifBytes = s3Bytes(LOCALSTACK, bucket, gifRow);
                assertThat(sha256(gifBytes)).isEqualTo(gifSha);
                assertThat(new String(gifBytes, 0, 3, StandardCharsets.US_ASCII)).isEqualTo("GIF");
                StoredArtifact glbRow = storedArtifact(POSTGRES, tenant, principal, glbId);
                assertThat(glbRow.contentType()).isEqualTo("model/gltf-binary");
                byte[] glbBytes = s3Bytes(LOCALSTACK, bucket, glbRow);
                assertThat(sha256(glbBytes)).as("browser-downloaded GLB sha equals the S3 object").isEqualTo(glbSha);
                assertThat(new String(glbBytes, 0, 4, StandardCharsets.US_ASCII)).isEqualTo("glTF");

                stopLauncher(launcher);
                launcher = null;
                launcher = startLauncher(classpath, environment, log);
                awaitReady(launcher, port);
                String freshToken = issueDevToken(tenant, principal);
                input.write("host-restarted " + freshToken + "\n");
                input.flush();

                JsonNode readback = readBrowserEvent(browser, output, "readback", log);
                assertThat(readback.path("audioId").asString()).isEqualTo(audioId);
                assertThat(readback.path("simId").asString()).isEqualTo(simId);
                assertThat(readback.path("scientificSimulationId").asString()).isEqualTo(scientificSimulationId);
                assertThat(readback.path("scientificResultSha").asString()).isEqualTo(scientificResultSha);
                assertThat(readback.path("scientificScenarioSha").asString()).isEqualTo(scientificScenarioSha);
                assertThat(readback.path("pngArtifactId").asString()).isEqualTo(pngId);
                assertThat(readback.path("pngSha").asString()).isEqualTo(pngSha);
                assertThat(readback.path("gifId").asString()).isEqualTo(gifId);
                assertThat(readback.path("gifSha").asString()).isEqualTo(gifSha);
                assertThat(readback.path("pngDecode").path("width").asInt()).isEqualTo(800);
                assertThat(readback.path("gifDecode").path("width").asInt()).isEqualTo(64);
                assertThat(readback.path("wavDecode").path("duration").asDouble()).isBetween(0.9, 1.1);
                assertThat(readback.path("glbId").asString()).isEqualTo(glbId);
                assertThat(readback.path("audioSha").asString()).isEqualTo(audioSha);
                assertThat(readback.path("simSha").asString()).isEqualTo(simSha);
                assertThat(readback.path("glbSha").asString()).isEqualTo(glbSha);
                assertThat(readback.path("installedClient").asBoolean()).isTrue();
                assertThat(readback.path("glbValidation").path("assetSha256").asString()).isEqualTo(glbSha);
                assertThat(readback.path("projectId").asString()).isEqualTo(projectId);
                assertThat(readback.path("projectRevisionId").asString()).isEqualTo(projectRevisionId);
                assertThat(readback.path("sourceProjectRevisionRef").asString()).isEqualTo(sourceProjectRevisionRef);
                assertThat(browser.waitFor(90, TimeUnit.SECONDS)).isTrue();
                assertThat(browser.exitValue()).as("live browser script must pass; see " + log).isZero();

                // Reopening and downloading again registered nothing new.
                assertThat(countArtifacts(tenant, principal, "audio/wav")).isEqualTo(2);
                assertThat(countArtifacts(tenant, principal, "application/json")).isEqualTo(2);
                assertThat(countArtifacts(tenant, principal, "image/png")).isEqualTo(3);
                assertThat(countArtifacts(tenant, principal, "image/gif")).isEqualTo(1);
                assertThat(countArtifacts(tenant, principal, "model/gltf-binary")).isEqualTo(1);
                assertThat(storedArtifact(POSTGRES, tenant, principal, glbId).sha256()).isEqualTo(glbSha);
                assertThat(storedArtifact(POSTGRES, tenant, principal, pngId).sha256()).isEqualTo(pngSha);
                assertThat(storedArtifact(POSTGRES, tenant, principal, gifId).sha256()).isEqualTo(gifSha);
                assertThat(storedArtifact(POSTGRES, tenant, principal, simId).sha256()).isEqualTo(simSha);
                assertThat(storedArtifact(POSTGRES, tenant, principal, scientificSimulationId).sha256())
                        .isEqualTo(scientificResultSha);
            }
            browser = null;
            passed = true;
        } finally {
            if (browser != null && browser.isAlive()) stopProcessTree(browser);
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("Explorer creative-outputs live failure log retained at " + log);
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
        Thread reader = new Thread(lineTask, "media-dev-creative-live-browser-output");
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

    /** Two-bone rig with exact rational keyframes (0, 1/3, 1). */
    private static Map<String, Object> spatialBody(String requestId, String rigId, List<Map<String, Object>> sources) {
        double half = Math.sin(Math.PI / 12);
        double halfW = Math.cos(Math.PI / 12);
        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("frameRef", "urn:media:frame:glb");
        frame.put("frameVersionRef", "v1");
        frame.put("handedness", "RIGHT_HANDED");
        frame.put("axisDirections", new ArrayList<>(List.of("POS_X", "POS_Y", "POS_Z")));
        frame.put("positionUnitRef", "urn:media:spatial:unit:metre:v1");
        frame.put("orientationUnitRef", "urn:media:spatial:orientation:unit-quaternion-xyzw:v1");
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("id", "root");
        root.put("restPose", Map.of("position", List.of(0, 0, 0), "orientation", List.of(0, 0, 0, 1)));
        root.put("constraint", new LinkedHashMap<>(Map.of("kind", "BALL", "maxAngularDeviationRadians", Math.PI)));
        Map<String, Object> child = new LinkedHashMap<>();
        child.put("id", "child");
        child.put("parentId", "root");
        child.put("restPose", Map.of("position", List.of(0, 1, 0), "orientation", List.of(0, 0, 0, 1)));
        child.put("constraint", new LinkedHashMap<>(Map.of("kind", "BALL", "maxAngularDeviationRadians", Math.PI)));
        Map<String, Object> track = new LinkedHashMap<>();
        track.put("root", new ArrayList<>(List.of(
                key(0, 1, 0, 0, 0, 0, 0, 0, 1),
                key(1, 3, 0.5, 0, 0, 0, 0, half, halfW),
                key(1, 1, 1, 0, 0, 0, 0, 0.7071067811865476, 0.7071067811865476))));
        Map<String, Object> rig = new LinkedHashMap<>();
        rig.put("id", rigId);
        rig.put("coordinateFrame", frame);
        rig.put("sourceVersions", new ArrayList<>(sources));
        rig.put("bones", new ArrayList<>(List.of(root, child)));
        rig.put("tracks", track);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("rig", rig);
        return body;
    }

    private static Map<String, Object> key(long num, long den, double x, double y, double z, double qx, double qy,
                                           double qz, double qw) {
        return Map.of("time", Map.of("numerator", num, "denominator", den),
                "pose", Map.of("position", List.of(x, y, z), "orientation", List.of(qx, qy, qz, qw)));
    }

    /** Mono 16-bit sine whose peaks exceed full scale and are hard-clipped. */
    private static byte[] clippedWav(int amplitude) {
        int[] samples = new int[RATE];
        for (int i = 0; i < samples.length; i++) {
            long v = Math.round(amplitude * Math.sin(2 * Math.PI * 440 * i / (double) RATE));
            samples[i] = (int) Math.max(-32768, Math.min(32767, v));
        }
        ByteBuffer wav = ByteBuffer.allocate(44 + samples.length * 2).order(ByteOrder.LITTLE_ENDIAN);
        wav.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + samples.length * 2)
                .put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1)
                .putInt(RATE).putInt(RATE * 2).putShort((short) 2).putShort((short) 16)
                .put("data".getBytes(StandardCharsets.US_ASCII)).putInt(samples.length * 2);
        for (int sample : samples) wav.putShort((short) sample);
        return wav.array();
    }
}
