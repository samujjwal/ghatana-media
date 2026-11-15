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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevCompositeSupport.*;
import static com.ghatana.media.integration.MediaDevLiveFixtures.JSON;
import static com.ghatana.media.integration.MediaDevLiveFixtures.issueDevToken;
import static com.ghatana.media.integration.MediaDevLiveFixtures.sha256;
import static com.ghatana.media.integration.MediaDevStoryboardSupport.storyboardRenderRows;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * Real Chromium drives the Explorer "Brief to reviewed media" page against a real launcher process (PostgreSQL + S3), real
 * FFmpeg, a real rights authority and the real review runtime. The test principal uploads and attests the two stored source
 * videos only; the BROWSER writes the brief, edits the storyboard (a typed refusal first), makes the owner's own rights
 * statement for the authored animation, renders, verifies and plays the MP4 (decoded by Chromium at every shot), opens the
 * version-specific review, then sees that review go STALE when another editor saves version 3 and has its own stale save
 * refused. The Java side reads the registered bytes back from S3 and probes them independently. TEST identities only.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevExplorerStoryboardLiveIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void explorerWritesABriefEditsRendersReviewsAndSeesTheReviewGoStale() throws Exception {
        try (Host host = Host.start(POSTGRES, LOCALSTACK, MediaDevStoryboardJourneyIT.withEnv(Map.of()))) {
            Media media = generate(host.work.resolve("gen"));
            String a = host.upload("a.mp4", "video/mp4", media.videoA());
            String b = host.upload("b.mp4", "video/mp4", media.videoB());
            host.attest(a, media.videoA());
            host.attest(b, media.videoB());
            Map<String, Object> sources = new LinkedHashMap<>();
            sources.put("a", ref(a, media.videoA()));
            sources.put("b", ref(b, media.videoB()));

            Path repoRoot = findMediaRepoRoot();
            Path script = repoRoot.resolve("apps/media-experience-explorer/test/dev-storyboard-live-browser.mjs");
            assertThat(script).isRegularFile();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            ProcessBuilder builder = new ProcessBuilder("node", script.toString());
            builder.directory(repoRoot.toFile());
            builder.redirectError(ProcessBuilder.Redirect.appendTo(host.log.toFile()));
            Map<String, String> env = builder.environment();
            env.put("MEDIA_DEV_STORYBOARD_BROWSER_TOKEN", issueDevToken(host.tenant, host.owner));
            env.put("MEDIA_DEV_STORYBOARD_SOURCES", JSON.writeValueAsString(sources));
            env.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(host.port));
            env.put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            env.put("MEDIA_DEV_VITE_VERSION", packageVersion(viteBinary));
            env.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            Process browser = builder.start();
            JsonNode event;
            try {
                try (BufferedReader output = new BufferedReader(new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8))) {
                    FutureTask<String> lineTask = new FutureTask<>(output::readLine);
                    Thread reader = new Thread(lineTask, "media-dev-storyboard-browser-output");
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
            System.out.println("J09_UI_BROWSER_EVENT " + event);
            assertThat(event.path("event").asString()).isEqualTo("storyboarded");
            assertThat(event.path("playbackAdvancedSeconds").asDouble()).as("the browser video element advanced").isGreaterThan(0.3);
            assertThat(event.path("frameCount").asInt()).isEqualTo(100);
            String id = event.path("storyboardId").asString();

            // independent readback of what the UI produced
            assertThat(storyboardRenderRows(host, id, 2)).as("exactly one registered render of version 2").isEqualTo(1);
            assertThat(storyboardRenderRows(host, id, 3)).isZero();
            byte[] bytes = host.artifactBytes(event.path("renderId").asString());
            assertThat(sha256(bytes)).isEqualTo(event.path("artifactSha256").asString());
            Path mp4 = host.work.resolve("ui-storyboard.mp4");
            Files.write(mp4, bytes);
            JsonNode probe = probe(mp4);
            assertThat(probe.path("streams").get(0).path("nb_read_frames").asString()).isEqualTo("100");
            int[][] signatures = {{0, 255, 128, 0}, {24, 255, 128, 0}, {25, 0, 255, 0}, {49, 0, 255, 0}, {50, 255, 0, 255},
                    {74, 255, 0, 255}, {75, 255, 255, 0}, {99, 255, 255, 0}};
            for (int[] s : signatures) {
                int x = s[0] >= 50 && s[0] <= 74 ? 250 : 160, y = s[0] >= 50 && s[0] <= 74 ? 60 : 200;
                assertThat(nearly(frame(mp4, s[0]), x, y, s[1], s[2], s[3])).as("frame " + s[0]).isTrue();
            }
            // the review the browser opened is STALE for the storyboard version another editor saved
            String reviewCase = event.path("reviewCaseId").asString();
            assertThat(host.ownerGet("/dev/v1/reviews/" + reviewCase, 200).path("currentness").asString()).isEqualTo("STALE");
            JsonNode head = host.ownerGet("/dev/v1/storyboards/" + id, 200);
            assertThat(head.path("versionNumber").asInt()).isEqualTo(3);
            assertThat(host.ownerGet("/dev/v1/storyboards/" + id + "/versions", 200).path("versions")).hasSize(3);
            assertThat(host.workDirectories()).as("no work directory left behind").isEmpty();
            host.passed = true;
        }
    }

    private static Map<String, String> ref(String artifactId, byte[] bytes) throws Exception {
        return Map.of("id", artifactId, "version", "sha256:" + sha256(bytes));
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
