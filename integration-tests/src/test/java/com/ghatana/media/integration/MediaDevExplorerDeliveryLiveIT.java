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
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevLiveFixtures.JSON;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-22 through the hosted Explorer: a real Chromium (Playwright 1.63) drives {@code dev-delivery.html} against a real
 * launcher (PostgreSQL + S3) and an independent signed-ACK receiver. This test injects each fault at the receiver at the
 * moment the browser is waiting, and reads the receiver, PostgreSQL and the HTTP API directly to prove what the page
 * claims: a lost ACK shows UNKNOWN, a read-only reconcile resolves it with no second upload, a revoked credential and a
 * checksum mismatch are typed failures, and nothing is DELIVERED without the verified receipt. Test principals are
 * synthetic; no real approval is implied.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevExplorerDeliveryLiveIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void explorerShowsTheAckStateForLostAckRevokedCredentialAndChecksumMismatchAndReconcilesWithoutADuplicateUpload() throws Exception {
        Process browser = null;
        boolean passed = false;
        try (MediaDevAckRig rig = new MediaDevAckRig(POSTGRES, LOCALSTACK, "300000")) {
            rig.start();
            MediaDevAckRig.Artifact artifact = rig.artifact("ui", 160, 120, true);
            MediaDevAckRig.Artifact unattested = rig.artifact("ui-unattested", 64, 64, false);
            String r = rig.run;
            LocalAckReceiver receiver = rig.receiver;
            rig.receiver.dropAckAfterStore(1);

            Path repoRoot = findMediaRepoRoot();
            Path script = repoRoot.resolve("apps/media-experience-explorer/test/dev-delivery-live-browser.mjs");
            assertThat(Files.isRegularFile(script)).isTrue();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            String viteVersion = packageVersion(viteBinary);
            assertThat(viteVersion).isIn("7.3.1", "8.3.0");
            ProcessBuilder builder = new ProcessBuilder("node", script.toString());
            builder.directory(repoRoot.toFile());
            builder.redirectError(ProcessBuilder.Redirect.appendTo(rig.log.toFile()));
            var env = builder.environment();
            env.put("MEDIA_DEV_DELIVERY_BROWSER_TOKEN", rig.ownerToken());
            env.put("MEDIA_DEV_DELIVERY_BROWSER_ARTIFACT_ID", artifact.artifactId());
            env.put("MEDIA_DEV_DELIVERY_BROWSER_VERSION_ID", artifact.versionId());
            env.put("MEDIA_DEV_DELIVERY_BROWSER_UNATTESTED_ID", unattested.artifactId());
            env.put("MEDIA_DEV_DELIVERY_BROWSER_UNATTESTED_VERSION", unattested.versionId());
            env.put("MEDIA_DEV_DELIVERY_BROWSER_RUN", r);
            env.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(rig.port));
            env.put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            env.put("MEDIA_DEV_VITE_VERSION", viteVersion);
            env.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            browser = builder.start();
            Path log = rig.log;
            try (BufferedReader output = new BufferedReader(new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8));
                 BufferedWriter input = new BufferedWriter(new OutputStreamWriter(browser.getOutputStream(), StandardCharsets.UTF_8))) {
                String req1 = "ui-j22-1-" + r, req2 = "ui-j22-2-" + r, req3 = "ui-j22-3-" + r, req4 = "ui-j22-4-" + r;

                // 1. Lost ACK: the receiver stored the object; the page shows UNKNOWN.
                readBrowserEvent(browser, output, "unknown", log);
                assertThat(receiver.storedBytes(rig.objectKey(req1))).isEqualTo(artifact.bytes());
                assertThat(rig.ledgerStatus(req1)).startsWith("OUTCOME_UNKNOWN");
                assertThat(rig.read(req1).path("ackState").asString()).isEqualTo("UNKNOWN");
                gate(input, "verified-unknown");

                // 2. Read-only reconcile: delivered from the signed status, with no second upload.
                int puts = receiver.putRequests();
                readBrowserEvent(browser, output, "delivered", log);
                assertThat(receiver.putRequests()).as("reconcile must not upload").isEqualTo(puts);
                assertThat(receiver.partWrites().stream().filter(w -> w.objectKey().equals(rig.objectKey(req1)))).hasSize(1);
                assertThat(rig.ledgerStatus(req1)).startsWith("DESTINATION_CONFIRMED");
                gate(input, "verified-delivered");

                // 3. Duplicate export.
                readBrowserEvent(browser, output, "duplicate", log);
                assertThat(receiver.putRequests()).isEqualTo(puts);
                assertThat(rig.ledgerRows(req1)).isEqualTo(1);
                receiver.revokeCredential();
                gate(input, "verified-duplicate");

                // 4. Credential revoked before transfer.
                readBrowserEvent(browser, output, "revoked", log);
                assertThat(receiver.received(rig.objectKey(req2))).isZero();
                assertThat(rig.ledgerStatus(req2)).startsWith("UNAVAILABLE");
                receiver.restoreCredential();
                receiver.dropBeforeStore(1);
                gate(input, "verified-revoked");

                // 5. Dropped before the store: unknown, absent, then one resumed upload.
                readBrowserEvent(browser, output, "dropped", log);
                assertThat(receiver.received(rig.objectKey(req3))).isZero();
                gate(input, "verified-dropped");
                readBrowserEvent(browser, output, "absent", log);
                assertThat(receiver.received(rig.objectKey(req3))).isZero();
                gate(input, "verified-absent");
                readBrowserEvent(browser, output, "resumed", log);
                assertThat(receiver.storedBytes(rig.objectKey(req3))).isEqualTo(artifact.bytes());
                assertThat(receiver.partWrites().stream().filter(w -> w.objectKey().equals(rig.objectKey(req3)))).hasSize(1);
                receiver.corruptStoredObjectOnComplete(true);
                gate(input, "verified-resumed");

                // 6. Checksum mismatch.
                readBrowserEvent(browser, output, "mismatch", log);
                receiver.corruptStoredObjectOnComplete(false);
                assertThat(rig.ledgerStatus(req4)).startsWith("OUTCOME_UNKNOWN");
                assertThat(rig.read(req4).path("failure").asString()).isEqualTo("CHECKSUM_MISMATCH");
                assertThat(rig.read(req4).path("destinationConfirmed").asBoolean()).isFalse();
                gate(input, "verified-mismatch");

                // 7. Denied and 8. accessibility, then the script's own verdict.
                readBrowserEvent(browser, output, "denied", log);
                assertThat(rig.ledgerRows("ui-j22-5-" + r)).as("a rights refusal leaves no ledger row").isZero();
                JsonNode finished = readBrowserEvent(browser, output, "delivery-browser", log);
                assertThat(finished.path("calls").asInt()).isPositive();
                assertThat(browser.waitFor(90, TimeUnit.SECONDS)).isTrue();
                assertThat(browser.exitValue()).as("live browser script must pass; see " + log).isZero();
            }
            browser = null;
            passed = true;
            Files.deleteIfExists(rig.log);
        } finally {
            if (browser != null && browser.isAlive()) stopProcessTree(browser);
            if (!passed) System.err.println("Delivery live failure: see the retained launcher log under java.io.tmpdir (media-dev-j22-process-*.log)");
        }
    }

    private static void gate(BufferedWriter input, String message) throws Exception {
        input.write(message + "\n");
        input.flush();
    }

    private static JsonNode readBrowserEvent(Process browser, BufferedReader output, String expectedEvent, Path log) throws Exception {
        FutureTask<String> lineTask = new FutureTask<>(output::readLine);
        Thread reader = new Thread(lineTask, "media-dev-j26-browser-output");
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
