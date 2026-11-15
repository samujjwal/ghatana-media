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
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffmpeg;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffprobe;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * Real Chromium drives the Explorer "Stems, foley and master" page against a real launcher process (PostgreSQL + S3) and
 * real FFmpeg. The browser builds original procedural stems through the form, mixes them with sample-exact starts, gains,
 * pans and fades, receives the host's typed refusals (invalid pan with its JSON path, an uploaded stem without a rights
 * statement, a silent stem that makes the host abstain), masters for real, plays the stored WAV in a real {@code <audio>}
 * element after the registered SHA-256 matches, and decodes both stored masters itself (the FLAC must equal the WAV sample for
 * sample; the sample peak must equal the report and respect the ceiling). The Java side then measures the stored WAV
 * independently with FFmpeg's EBU R128 meter. TEST identities only; the rights statement is a synthetic test principal's, not a
 * real approval.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevExplorerMasterLiveIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(LocalStackContainer.Service.S3);

    @Test
    void explorerBuildsStemsMixesMastersAndPlaysTheVerifiedMasterInChromiumAndShowsTypedRefusals() throws Exception {
        assertThat(ffmpeg()).as("MEDIA_DEV_RENDER_FFMPEG").isNotBlank();
        assertThat(ffprobe()).as("MEDIA_DEV_RENDER_FFPROBE").isNotBlank();
        Path repoRoot = findMediaRepoRoot();
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-dev-explorer-master-" + run;
        String principal = "test-principal-master-" + run;
        String bucket = "media-dev-explorer-master-" + run.substring(0, 12);
        String schema = "media_dev_explorer_master_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Path services = Files.createTempDirectory("media-dev-explorer-master-services-");
        Path log = Files.createTempFile("media-dev-explorer-master-process-", ".log");
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
            launcher = startLauncher(services + java.io.File.pathSeparator + childClasspath, environment, log);
            awaitReady(launcher, port);
            String token = issueDevToken(tenant, principal);

            // two uploaded stems: one without any rights statement, one silent but attested by the (test) uploader
            byte[] denied = wavBytes(48_000, 1, tonePcm(196, 72_000));
            byte[] silent = wavBytes(48_000, 1, new short[48_000]);
            String deniedId = upload(port, tenant, principal, token, run + "-denied", "denied.wav", "audio/wav", denied);
            String silentId = upload(port, tenant, principal, token, run + "-silent", "silent.wav", "audio/wav", silent);
            String deniedVersion = "sha256:" + sha256(denied);
            String silentVersion = "sha256:" + sha256(silent);
            post(port, tenant, token, "/dev/v1/rights/attestations", Map.of("artifactId", silentId, "artifactVersionId", silentVersion,
                    "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                    "basis", "TEST: a synthetic silent clip generated inside an automated test; a statement by a synthetic test "
                            + "principal, not a legal determination"), 201);
            int flacBefore = countArtifacts(tenant, principal, "audio/flac");

            Path script = repoRoot.resolve("apps/media-experience-explorer/test/dev-masters-live-browser.mjs");
            assertThat(script).isRegularFile();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            ProcessBuilder builder = new ProcessBuilder("node", script.toString());
            builder.directory(repoRoot.toFile());
            builder.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
            Map<String, String> env = builder.environment();
            env.put("MEDIA_DEV_MASTER_BROWSER_TOKEN", issueDevToken(tenant, principal));
            env.put("MEDIA_DEV_MASTER_DENIED_ID", deniedId);
            env.put("MEDIA_DEV_MASTER_DENIED_VERSION", deniedVersion);
            env.put("MEDIA_DEV_MASTER_SILENT_ID", silentId);
            env.put("MEDIA_DEV_MASTER_SILENT_VERSION", silentVersion);
            env.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(port));
            env.put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            env.put("MEDIA_DEV_VITE_VERSION", packageVersion(viteBinary));
            env.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            browser = builder.start();

            JsonNode event;
            try (BufferedReader output = new BufferedReader(new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8))) {
                FutureTask<String> lineTask = new FutureTask<>(output::readLine);
                Thread reader = new Thread(lineTask, "media-dev-master-browser-output");
                reader.setDaemon(true);
                reader.start();
                String line = lineTask.get(300, TimeUnit.SECONDS);
                assertThat(line).as("browser event; log=" + Files.readString(log)).isNotNull();
                event = JSON.readTree(line);
            }
            assertThat(browser.waitFor(60, TimeUnit.SECONDS)).isTrue();
            assertThat(browser.exitValue()).as("live browser script must pass; see " + log).isZero();
            System.out.println("J17_UI_BROWSER_EVENT " + event);
            assertThat(event.path("event").asString()).isEqualTo("mastered");
            assertThat(event.path("playbackAdvancedSeconds").asDouble()).as("the browser <audio> advanced").isGreaterThan(0.3);
            assertThat(event.path("flacIdenticalToWavInBrowser").asBoolean()).isTrue();

            // ---- independent readback of what the UI produced: FFmpeg's EBU R128 meter on the stored bytes ----
            assertThat(countArtifacts(tenant, principal, "audio/flac")).as("exactly one master: every refusal registered nothing")
                    .isEqualTo(flacBefore + 1);
            JsonNode reopened = get(port, tenant, token, "/dev/v1/masters/" + event.path("masterId").asString(), 200);
            assertThat(reopened.path("report").path("measurement").path("integratedLufs").asDouble()).isEqualTo(event.path("hostLufs").asDouble());
            byte[] wav = s3Bytes(LOCALSTACK, bucket, storedArtifact(POSTGRES, tenant, principal, event.path("wavId").asString()));
            assertThat(sha256(wav)).isEqualTo(event.path("wavSha256").asString());
            Path wavFile = Files.createTempFile("media-dev-master-ui-", ".wav");
            try {
                Files.write(wavFile, wav);
                Process meter = new ProcessBuilder(ffmpeg(), "-nostdin", "-nostats", "-hide_banner", "-i", wavFile.toString(),
                        "-af", "ebur128=peak=true", "-f", "null", "-").redirectErrorStream(true).start();
                String meterOutput = new String(meter.getInputStream().readAllBytes());
                assertThat(meter.waitFor(2, TimeUnit.MINUTES)).isTrue();
                String summary = meterOutput.substring(meterOutput.lastIndexOf("Summary:"));
                Matcher integrated = Pattern.compile("I:\\s+(-?[0-9.]+) LUFS").matcher(summary);
                Matcher peak = Pattern.compile("True peak:\\s+Peak:\\s+(-?[0-9.]+) dBFS").matcher(summary);
                assertThat(integrated.find()).as(summary).isTrue();
                assertThat(peak.find()).as(summary).isTrue();
                double lufs = Double.parseDouble(integrated.group(1));
                double truePeak = Double.parseDouble(peak.group(1));
                System.out.printf("J17_UI_EBUR128 ffmpeg %.2f LUFS / %.2f dBTP; page reported %.2f LUFS / %.2f dBTP%n",
                        lufs, truePeak, event.path("hostLufs").asDouble(), event.path("hostTruePeakDbtp").asDouble());
                assertThat(lufs).isBetween(-16.5, -15.5);
                assertThat(truePeak).isLessThanOrEqualTo(-1.0);
                assertThat(Math.abs(lufs - event.path("hostLufs").asDouble())).isLessThanOrEqualTo(0.5);
            } finally {
                Files.deleteIfExists(wavFile);
            }
            passed = true;
        } finally {
            if (browser != null && browser.isAlive()) stopProcessTree(browser);
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            if (passed) Files.deleteIfExists(log);
            else System.err.println("Explorer master live failure log retained at " + log);
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

    private static short[] tonePcm(double hz, int frames) {
        short[] out = new short[frames];
        for (int i = 0; i < frames; i++) out[i] = (short) Math.round(12_000 * Math.sin(2 * Math.PI * hz * i / 48_000));
        return out;
    }

    private static byte[] wavBytes(int rate, int channels, short[] samples) {
        java.nio.ByteBuffer out = java.nio.ByteBuffer.allocate(44 + samples.length * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        out.putInt(0x46464952).putInt(36 + samples.length * 2).putInt(0x45564157);
        out.putInt(0x20746d66).putInt(16).putShort((short) 1).putShort((short) channels).putInt(rate).putInt(rate * channels * 2)
                .putShort((short) (channels * 2)).putShort((short) 16);
        out.putInt(0x61746164).putInt(samples.length * 2);
        out.asShortBuffer().put(samples);
        return out.array();
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
