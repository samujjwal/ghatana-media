package com.ghatana.media.integration;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import tools.jackson.databind.JsonNode;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevCompositeSupport.*;
import static com.ghatana.media.integration.MediaDevLiveFixtures.JSON;
import static com.ghatana.media.integration.MediaDevLiveFixtures.issueDevToken;
import static com.ghatana.media.integration.MediaDevLiveFixtures.sha256;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * Real Chromium drives the Explorer "Multitrack finished master" page against a real launcher process (PostgreSQL + S3),
 * real FFmpeg and a real rights authority. The test principal uploads and attests the generated sources and creates the
 * project and its empty timeline; the BROWSER places the six clips on the timeline, triggers a typed refusal, cancels a render mid-encode,
 * renders, verifies and plays the MP4 (decoded by Chromium at each clip's timeline position) and replays. The Java side
 * then reads the registered bytes back from S3 and probes them independently. TEST identities only.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevExplorerCompositeLiveIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void explorerPlacesRendersCancelsVerifiesAndPlaysTheFinishedMaster() throws Exception {
        try (Host host = Host.start(POSTGRES, LOCALSTACK, Map.of("MEDIA_DEV_COMPOSITE_X264_PRESET", "slower"))) {
            Media media = generate(host.work.resolve("gen"));
            String a = host.upload("a.mp4", "video/mp4", media.videoA());
            String b = host.upload("b.mp4", "video/mp4", media.videoB());
            String narration = host.upload("narration.wav", "audio/wav", media.narration());
            String music = host.upload("music.wav", "audio/wav", media.music());
            String graphic = host.upload("lower-third.png", "image/png", media.graphic());
            String vtt = host.upload("cues.vtt", "text/vtt", media.vtt());
            host.attest(a, media.videoA());
            host.attest(b, media.videoB());
            host.attest(narration, media.narration());
            host.attest(music, media.music());
            host.attest(graphic, media.graphic());
            host.attest(vtt, media.vtt());
            String workspaceId = host.ownerGet("/dev/v1/context", 200).path("selectedAuthorizedWorkspaceId").asString();
            String projectId = host.ownerPost("/dev/v1/projects", Map.of("selectedAuthorizedWorkspaceId", workspaceId,
                    "title", "J-18 UI " + host.run, "requestId", "j18-ui-project-" + host.run), 201).path("project").path("projectId").asString();
            String head = host.ownerGet("/dev/v1/projects/" + projectId, 200).path("currentRevision").path("revisionId").asString();
            host.ownerPost("/dev/v1/projects/" + projectId + "/timelines", Map.of("expectedHeadRevisionId", head,
                    "timelineId", "timeline-main"), 201);
            Map<String, Object> sources = new LinkedHashMap<>();
            sources.put("a", ref(a, media.videoA()));
            sources.put("b", ref(b, media.videoB()));
            sources.put("narration", ref(narration, media.narration()));
            sources.put("music", ref(music, media.music()));
            sources.put("graphic", ref(graphic, media.graphic()));
            sources.put("vtt", ref(vtt, media.vtt()));

            Path repoRoot = findMediaRepoRoot();
            Path script = repoRoot.resolve("apps/media-experience-explorer/test/dev-composite-render-live-browser.mjs");
            assertThat(script).isRegularFile();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            ProcessBuilder builder = new ProcessBuilder("node", script.toString());
            builder.directory(repoRoot.toFile());
            builder.redirectError(ProcessBuilder.Redirect.appendTo(host.log.toFile()));
            Map<String, String> env = builder.environment();
            env.put("MEDIA_DEV_COMPOSITE_BROWSER_TOKEN", issueDevToken(host.tenant, host.owner));
            env.put("MEDIA_DEV_COMPOSITE_PROJECT_ID", projectId);
            env.put("MEDIA_DEV_COMPOSITE_SOURCES", JSON.writeValueAsString(sources));
            env.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(host.port));
            env.put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            env.put("MEDIA_DEV_VITE_VERSION", packageVersion(viteBinary));
            env.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            Process browser = builder.start();
            JsonNode event;
            try {
                try (BufferedReader output = new BufferedReader(new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8))) {
                    FutureTask<String> lineTask = new FutureTask<>(output::readLine);
                    Thread reader = new Thread(lineTask, "media-dev-composite-browser-output");
                    reader.setDaemon(true);
                    reader.start();
                    String line = lineTask.get(900, TimeUnit.SECONDS);
                    assertThat(line).as("browser event; log=" + Files.readString(host.log)).isNotNull();
                    event = JSON.readTree(line);
                }
                assertThat(browser.waitFor(60, TimeUnit.SECONDS)).isTrue();
                assertThat(browser.exitValue()).as("live browser script must pass; see " + host.log).isZero();
            } finally {
                if (browser.isAlive()) { browser.descendants().forEach(ProcessHandle::destroyForcibly); browser.destroyForcibly(); }
            }
            System.out.println("J18_UI_BROWSER_EVENT " + event);
            assertThat(event.path("event").asString()).isEqualTo("composited");
            assertThat(event.path("playbackAdvancedSeconds").asDouble()).as("the browser video element advanced").isGreaterThan(0.3);
            assertThat(event.path("frameCount").asInt()).isEqualTo(100);

            // independent readback of what the UI produced
            String requestId = event.path("requestIds").get(event.path("requestIds").size() - 1).asString();
            assertThat(countRenders(host)).as("exactly one registered render: the refusal and the cancelled render registered nothing").isEqualTo(1);
            byte[] bytes = host.artifactBytes(event.path("renderId").asString());
            assertThat(sha256(bytes)).isEqualTo(event.path("artifactSha256").asString());
            Path mp4 = host.work.resolve("ui-master.mp4");
            Files.write(mp4, bytes);
            JsonNode probe = probe(mp4);
            assertThat(probe.path("streams").get(0).path("nb_read_frames").asString()).isEqualTo("100");
            assertThat(subtitleCues(mp4)).containsExactly("00:00:00,500 --> 00:00:01,500 Hello world",
                    "00:00:02,500 --> 00:00:03,500 Second cue");
            double onset = beepOnsetSeconds(leftChannel(mp4));
            assertThat(Math.abs(onset - 1.0)).isLessThanOrEqualTo(1.0 / FPS);
            assertThat(host.renderRows(requestId)).isEqualTo(1);
            assertThat(host.workDirectories()).as("no work directory left behind").isEmpty();
            assertThat(host.encoders()).isEmpty();
            host.passed = true;
        }
    }

    private static Map<String, String> ref(String artifactId, byte[] bytes) throws Exception {
        return Map.of("id", artifactId, "version", "sha256:" + sha256(bytes));
    }

    private static int countRenders(Host host) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement("SELECT count(*) FROM media_artifacts WHERE tenant_id=? AND principal_id=? "
                     + "AND metadata_json LIKE ?")) {
            statement.setString(1, host.tenant);
            statement.setString(2, host.owner);
            statement.setString(3, "%media.dev.composite-render.v1%");
            try (var row = statement.executeQuery()) {
                row.next();
                return row.getInt(1);
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
        if (Files.isRegularFile(local)) return local;
        Path pnpm = findPnpmPackageBinary(repoRoot, "vite@", "vite/bin/vite.js");
        if (pnpm != null) return pnpm;
        Path global = globalNodeModules().resolve("vitest/node_modules/vite/bin/vite.js");
        assertThat(Files.isRegularFile(global)).as("a Vite installation is required").isTrue();
        return global;
    }

    private static Path findPlaywrightModule(Path repoRoot) throws Exception {
        for (String candidate : List.of("node_modules/playwright/index.mjs", "apps/media-experience-explorer/node_modules/playwright/index.mjs")) {
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
