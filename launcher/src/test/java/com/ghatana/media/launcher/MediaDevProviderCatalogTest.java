package com.ghatana.media.launcher;

import com.ghatana.audio.video.vision.local.LocalModelAdmission;
import com.ghatana.audio.video.vision.local.LocalVisionEngine;
import com.ghatana.audio.video.vision.local.LocalVisionRightsAuthority;
import com.ghatana.audio.video.vision.local.LocalVisionSidecarClient;
import com.ghatana.audiovideo.observability.MediaWorkflowMetrics.LocalProvider;
import com.ghatana.media.launcher.MediaDevProviderCatalog.Observation;
import com.ghatana.media.launcher.MediaDevProviderCatalog.Probe;
import com.ghatana.media.launcher.MediaDevProviderCatalog.State;
import com.ghatana.media.runtime.localmodel.LocalModelManifest;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The DEV_ONLY provider catalog: bounded probing (TTL cache, single-flight refresh, concurrency cap, per-probe deadline),
 * production-like redaction and honest readiness from real checks (fake FFmpeg scripts, a loopback fake sidecar and a
 * FIXTURE_ONLY manifest tree). Nothing is READY from configuration alone.
 */
class MediaDevProviderCatalogTest {
    private static final String TOKEN = "fixture-only-token-0123456789abcdef";

    @TempDir
    Path tmp;

    // ----------------------------------------------------------------------------------- bounded probing

    private static Probe fixed(LocalProvider provider, Observation observation, AtomicInteger calls) {
        return new Probe() {
            @Override public LocalProvider provider() { return provider; }
            @Override public String kind() { return "FIXTURE"; }
            @Override public Observation observe() { calls.incrementAndGet(); return observation; }
        };
    }

    private static MediaDevProviderCatalog catalog(List<Probe> probes, Duration ttl, int concurrency,
                                                   boolean productionLike, Duration deadline) {
        return new MediaDevProviderCatalog(probes, ttl, concurrency, productionLike, Clock.systemUTC(), deadline, null);
    }

    @Test
    void anObservationIsServedFromTheCacheUntilTheTtlExpires() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        MediaDevProviderCatalog catalog = catalog(List.of(fixed(LocalProvider.WHISPER,
                Observation.of(State.READY, "VERIFIED_AND_PROBED"), calls)), Duration.ofMillis(300), 2, false,
                Duration.ofSeconds(5));
        Map<String, Object> first = catalog.view();
        catalog.view();
        catalog.view();
        assertThat(calls).hasValue(1);
        assertThat(catalog.refreshCount()).isEqualTo(1);
        Thread.sleep(350);
        Map<String, Object> later = catalog.view();
        assertThat(calls).hasValue(2);
        assertThat(later.get("checkedAt")).isNotEqualTo(first.get("checkedAt"));
        catalog.close();
    }

    @Test
    void concurrentCallersShareOneRefreshAndTheProbeConcurrencyIsCapped() throws Exception {
        AtomicInteger active = new AtomicInteger();
        AtomicInteger maxActive = new AtomicInteger();
        AtomicInteger calls = new AtomicInteger();
        List<Probe> probes = new ArrayList<>();
        for (LocalProvider provider : LocalProvider.values()) {
            probes.add(new Probe() {
                @Override public LocalProvider provider() { return provider; }
                @Override public String kind() { return "FIXTURE"; }
                @Override public Observation observe() {
                    calls.incrementAndGet();
                    int now = active.incrementAndGet();
                    maxActive.accumulateAndGet(now, Math::max);
                    try { Thread.sleep(150); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                    active.decrementAndGet();
                    return Observation.of(State.READY, "VERIFIED_AND_PROBED");
                }
            });
        }
        MediaDevProviderCatalog catalog = catalog(probes, Duration.ofSeconds(30), 2, false, Duration.ofSeconds(5));
        ExecutorService callers = Executors.newFixedThreadPool(16);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<Map<String, Object>>> results = new ArrayList<>();
        for (int i = 0; i < 16; i++) {
            results.add(callers.submit(() -> { go.await(); return catalog.view(); }));
        }
        go.countDown();
        for (Future<Map<String, Object>> result : results) assertThat(result.get(30, TimeUnit.SECONDS)).isNotNull();
        callers.shutdownNow();
        assertThat(catalog.refreshCount()).as("16 simultaneous callers share one refresh").isEqualTo(1);
        assertThat(calls).as("each provider probed once").hasValue(LocalProvider.values().length);
        assertThat(maxActive.get()).as("probe concurrency cap").isLessThanOrEqualTo(2);
        catalog.close();
    }

    @Test
    void aProbeThatExceedsItsDeadlineIsUnavailableAndDoesNotBlockTheOthers() {
        CountDownLatch never = new CountDownLatch(1);
        Probe hung = new Probe() {
            @Override public LocalProvider provider() { return LocalProvider.QWEN; }
            @Override public String kind() { return "FIXTURE"; }
            @Override public Observation observe() {
                try { never.await(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                return Observation.of(State.READY, "NEVER");
            }
        };
        Probe fine = fixed(LocalProvider.WHISPER, Observation.of(State.READY, "VERIFIED_AND_PROBED"), new AtomicInteger());
        Probe broken = new Probe() {
            @Override public LocalProvider provider() { return LocalProvider.KOKORO; }
            @Override public String kind() { return "FIXTURE"; }
            @Override public Observation observe() { throw new IllegalStateException("fixture failure"); }
        };
        MediaDevProviderCatalog catalog = catalog(List.of(hung, fine, broken), Duration.ofSeconds(30), 3, false,
                Duration.ofMillis(400));
        Map<String, Object> view = catalog.view();
        Map<String, Map<String, Object>> byId = byId(view);
        assertThat(byId.get("qwen")).containsEntry("state", "UNAVAILABLE").containsEntry("reason", "PROBE_TIMEOUT");
        assertThat(byId.get("whisper")).containsEntry("state", "READY");
        assertThat(byId.get("kokoro")).containsEntry("state", "UNAVAILABLE").containsEntry("reason", "PROBE_FAILED");
        never.countDown();
        catalog.close();
    }

    @Test
    void viewNeverClaimsProductionEligibilityOrExposesPathsAndProductionLikeOmitsDeviceNames() {
        Observation observation = new Observation(State.READY, "VERIFIED_AND_PROBED", "", "model", "rev", "MIT", true,
                "notice", Map.of("weightsSha256", "a".repeat(64)), java.util.Set.of("en"), java.util.Set.of(),
                MediaDevProviderCatalog.device("GPU", "Quadro RTX 5000", "torch 2.9"), Map.of("runtimeVersion", "v1"));
        Probe probe = fixed(LocalProvider.FLORENCE, observation, new AtomicInteger());
        Map<String, Object> dev = catalog(List.of(probe), Duration.ofSeconds(5), 1, false, Duration.ofSeconds(5)).view();
        Map<String, Object> prod = catalog(List.of(probe), Duration.ofSeconds(5), 1, true, Duration.ofSeconds(5)).view();
        assertThat(dev).containsEntry("productionEligible", false);
        Map<String, Object> devEntry = byId(dev).get("florence");
        assertThat(devEntry).containsEntry("productionEligible", false).containsEntry("fallback", "NONE");
        assertThat(String.valueOf(devEntry.get("device"))).contains("Quadro RTX 5000");
        assertThat(devEntry).containsKey("runtime");
        Map<String, Object> prodEntry = byId(prod).get("florence");
        assertThat(String.valueOf(prodEntry.get("device"))).doesNotContain("Quadro").doesNotContain("torch");
        assertThat(prodEntry).doesNotContainKey("runtime");
        assertThat(String.valueOf(dev) + prod).doesNotContain("/home/").doesNotContain("/tmp/").doesNotContain(TOKEN);
        assertThat(String.valueOf(dev.get("fallbackPolicy"))).startsWith("NONE");
    }

    @Test
    void observationCallbackReceivesEveryProviderOnceAndANullViewBusyIsTyped() {
        List<MediaDevProviderCatalog.Entry> seen = new ArrayList<>();
        MediaDevProviderCatalog catalog = new MediaDevProviderCatalog(List.of(
                fixed(LocalProvider.WHISPER, Observation.of(State.NOT_ADMITTED, "MODEL_DIGEST_MISMATCH"), new AtomicInteger())),
                Duration.ofSeconds(30), 1, false, Clock.systemUTC(), Duration.ofSeconds(2), seen::add);
        catalog.view();
        catalog.view();
        assertThat(seen).hasSize(1);
        assertThat(seen.get(0).observation().state()).isEqualTo(State.NOT_ADMITTED);
        assertThatThrownBy(() -> catalog(List.of(), Duration.ofSeconds(1), 0, false, Duration.ofSeconds(1)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    // --------------------------------------------------------------------------------------- FFmpeg probe

    private Path fakeTool(String name, String version, boolean withEncoders) throws IOException {
        Path script = tmp.resolve(name);
        String encoders = withEncoders
                ? " V....D libx264              libx264 H.264\\n A....D aac                  AAC\\n S..... mov_text             MOV text\\n"
                : " V....D mpeg4                MPEG-4\\n";
        Files.writeString(script, "#!/bin/sh\n"
                + "case \"$1\" in\n"
                + "  -version) echo \"" + name + " version " + version + " fixture\"; "
                + "echo \"configuration: --enable-gpl --enable-version3 --enable-libx264\";;\n"
                + "  -hide_banner) printf \"Encoders:\\n ------\\n" + encoders + "\";;\n"
                + "  *) exit 3;;\n"
                + "esac\n");
        Files.setPosixFilePermissions(script, PosixFilePermissions.fromString("rwxr-xr-x"));
        return script;
    }

    @Test
    void ffmpegReadinessComesFromRealToolRunsAndFollowsTheBinaryThroughOutageAndRecovery() throws Exception {
        Path ffmpeg = fakeTool("ffmpeg", "7.0.2", true);
        Path ffprobe = fakeTool("ffprobe", "7.0.2", true);
        Map<String, String> env = Map.of(MediaDevProjectRenderRuntime.FFMPEG_ENV, ffmpeg.toString(),
                MediaDevProjectRenderRuntime.FFPROBE_ENV, ffprobe.toString());
        Probe probe = new MediaDevProviderCatalog.FfmpegProbe(env);

        Observation ready = probe.observe();
        assertThat(ready.state()).isEqualTo(State.READY);
        assertThat(ready.reason()).isEqualTo("VERIFIED_AND_PROBED");
        assertThat(ready.licenseSpdx()).isEqualTo("GPL-3.0-or-later");
        assertThat(ready.revision()).isEqualTo("7.0.2");
        assertThat(ready.digests()).containsKeys("ffmpegSha256", "ffprobeSha256");
        assertThat(ready.device()).containsEntry("kind", "CPU");

        Path moved = tmp.resolve("ffmpeg.away");
        Files.move(ffmpeg, moved);
        Observation outage = probe.observe();
        assertThat(outage.state()).isEqualTo(State.UNAVAILABLE);
        assertThat(outage.reason()).isEqualTo("FFMPEG_BINARY_MISSING");

        Files.move(moved, ffmpeg);
        assertThat(probe.observe().state()).as("recovers once the binary is back").isEqualTo(State.READY);

        Files.delete(ffprobe);
        assertThat(probe.observe().reason()).isEqualTo("FFPROBE_BINARY_MISSING");
    }

    @Test
    void ffmpegWithoutTheRequiredEncodersOrWithoutConfigurationIsNeverReady() throws Exception {
        assertThat(new MediaDevProviderCatalog.FfmpegProbe(Map.of()).observe())
                .satisfies(o -> { assertThat(o.state()).isEqualTo(State.UNAVAILABLE); assertThat(o.reason()).isEqualTo("NOT_CONFIGURED"); });
        Path ffmpeg = fakeTool("ffmpeg", "7.0.2", false);
        Path ffprobe = fakeTool("ffprobe", "7.0.2", false);
        Observation o = new MediaDevProviderCatalog.FfmpegProbe(Map.of(MediaDevProjectRenderRuntime.FFMPEG_ENV,
                ffmpeg.toString(), MediaDevProjectRenderRuntime.FFPROBE_ENV, ffprobe.toString())).observe();
        assertThat(o.state()).isEqualTo(State.UNAVAILABLE);
        assertThat(o.reason()).isEqualTo("ENCODER_UNAVAILABLE");
        // A relative path is never resolved through PATH.
        assertThat(new MediaDevProviderCatalog.FfmpegProbe(Map.of(MediaDevProjectRenderRuntime.FFMPEG_ENV, "ffmpeg",
                MediaDevProjectRenderRuntime.FFPROBE_ENV, "ffprobe")).observe().reason()).isEqualTo("NOT_CONFIGURED");
    }

    @Test
    void ffmpegLicenceIsDerivedFromTheBinaryConfigurationLine() {
        assertThat(MediaDevProviderCatalog.FfmpegProbe.spdxFromConfiguration("configuration: --enable-gpl"))
                .isEqualTo("GPL-2.0-or-later");
        assertThat(MediaDevProviderCatalog.FfmpegProbe.spdxFromConfiguration("configuration: --enable-gpl --enable-nonfree"))
                .isEqualTo("LicenseRef-FFmpeg-nonfree");
        assertThat(MediaDevProviderCatalog.FfmpegProbe.spdxFromConfiguration("configuration: --enable-shared"))
                .isEqualTo("LGPL-2.1-or-later");
    }

    // --------------------------------------------------------------------------------------- vision probe

    /** Writes FIXTURE_ONLY files plus a matching directory manifest; the "weights" are a few bytes, never a model. */
    private static Path modelDir(Path parent, String name, String modelId, String role, String spdx) throws IOException {
        Path dir = Files.createDirectory(parent.resolve(name));
        byte[] weights = ("FIXTURE_ONLY weights for " + name).getBytes(StandardCharsets.UTF_8);
        byte[] license = ("FIXTURE_ONLY licence text " + spdx).getBytes(StandardCharsets.UTF_8);
        Files.write(dir.resolve("model.safetensors"), weights);
        Files.write(dir.resolve("LICENSE"), license);
        String fileSet = sha256(("LICENSE:" + sha256(license) + "\nmodel.safetensors:" + sha256(weights) + "\n")
                .getBytes(StandardCharsets.UTF_8));
        String manifest = "{\"schemaVersion\":\"ghatana.media.local-model-manifest.v1\",\"modelId\":\"" + modelId
                + "\",\"role\":\"" + role + "\",\"sourceUrl\":\"https://example.invalid/fixture\",\"revision\":\""
                + "a".repeat(40) + "\",\"spdxLicense\":\"" + spdx + "\",\"licenseFile\":{\"path\":\"LICENSE\","
                + "\"sha256\":\"" + sha256(license) + "\",\"source\":\"fixture\"},\"files\":["
                + entry("LICENSE", license) + "," + entry("model.safetensors", weights)
                + "],\"fileSetSha256\":\"" + fileSet + "\",\"remoteCode\":{\"required\":false,\"files\":[]},"
                + "\"runtime\":{\"kind\":\"fixture\",\"quantization\":\"none\"},\"ownerDecision\":{\"quote\":\""
                + LocalModelManifest.OWNER_DECISION_QUOTE + "\",\"decidedOn\":\"2026-11-14\",\"channel\":\"user chat\","
                + "\"licenseNote\":\"" + LocalModelManifest.OWNER_LICENSE_STATEMENT + "\"},\"attribution\":\"fixture\","
                + "\"obligations\":[]}";
        Files.writeString(dir.resolve(LocalModelManifest.DIRECTORY_MANIFEST_FILE), manifest);
        return dir;
    }

    private static String entry(String path, byte[] bytes) {
        return "{\"path\":\"" + path + "\",\"sha256\":\"" + sha256(bytes) + "\",\"sizeBytes\":" + bytes.length + "}";
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    /** A loopback sidecar stand-in whose health answer can be changed or whose port can be closed and reopened. */
    private static final class FakeSidecar implements AutoCloseable {
        final int port;
        final AtomicInteger delayMillis = new AtomicInteger();
        final AtomicReference<String> body = new AtomicReference<>(
                "{\"status\":\"UP\",\"floren2Loaded\":true,\"qwenLoaded\":false,\"device\":\"cuda:0\","
                        + "\"deviceInfo\":{\"kind\":\"GPU\",\"name\":\"Fixture GPU\",\"torch\":\"fixture\"}}");
        private HttpServer server;

        FakeSidecar() throws IOException {
            try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
            start();
        }

        void start() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
            server.createContext("/v1/health", exchange -> {
                try { Thread.sleep(delayMillis.get()); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                byte[] bytes = body.get().getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(200, bytes.length);
                exchange.getResponseBody().write(bytes);
                exchange.close();
            });
            server.start();
        }

        void stop() { server.stop(0); }

        @Override public void close() { server.stop(0); }
    }

    private static LocalVisionEngine engine(FakeSidecar sidecar, Path florence, Path qwen) {
        LocalVisionSidecarClient client = new LocalVisionSidecarClient(URI.create("http://127.0.0.1:" + sidecar.port),
                TOKEN, Duration.ofSeconds(30));
        return new LocalVisionEngine(client,
                new LocalModelAdmission(florence, LocalVisionEngine.FLORENCE_MODEL_ID, "VISION", "MIT"),
                new LocalModelAdmission(qwen, LocalVisionEngine.QWEN_MODEL_ID, "MULTIMODAL_QA", "Apache-2.0"),
                LocalVisionRightsAuthority.unavailable());
    }

    @Test
    void visionReadinessFollowsTheSidecarThroughOutageAndRecoveryWithTheDeviceItReports() throws Exception {
        Path florence = modelDir(tmp, "florence", LocalVisionEngine.FLORENCE_MODEL_ID, "VISION", "MIT");
        Path qwen = modelDir(tmp, "qwen", LocalVisionEngine.QWEN_MODEL_ID, "MULTIMODAL_QA", "Apache-2.0");
        try (FakeSidecar sidecar = new FakeSidecar()) {
            LocalVisionEngine engine = engine(sidecar, florence, qwen);
            Probe florenceProbe = new MediaDevProviderCatalog.VisionProbe(LocalProvider.FLORENCE, "VISION", engine, false);

            Observation ready = florenceProbe.observe();
            assertThat(ready.state()).isEqualTo(State.READY);
            assertThat(ready.device()).containsEntry("kind", "GPU").containsEntry("name", "Fixture GPU");
            assertThat(ready.licenseSpdx()).isEqualTo("MIT");
            assertThat(ready.digests()).containsKey("fileSetSha256");
            assertThat(ready.extras()).containsEntry("modelLoaded", true);

            sidecar.stop();
            Observation down = florenceProbe.observe();
            assertThat(down.state()).isEqualTo(State.UNAVAILABLE);
            assertThat(down.reason()).isEqualTo("SIDECAR_UNREACHABLE");

            sidecar.start();
            assertThat(florenceProbe.observe().state()).isEqualTo(State.READY);

            // Degraded: the process answers but not within the probe's budget (hung or saturated).
            sidecar.delayMillis.set(5_000);
            Observation slow = florenceProbe.observe();
            assertThat(slow.state()).isEqualTo(State.DEGRADED);
            assertThat(slow.reason()).isEqualTo("SIDECAR_HEALTH_TIMEOUT");
            sidecar.delayMillis.set(0);
            assertThat(florenceProbe.observe().state()).isEqualTo(State.READY);

            // The qualified weights are swapped after admission: withdrawn, with the digest cause kept.
            Files.writeString(florence.resolve("model.safetensors"), "tampered after admission");
            Observation withdrawn = florenceProbe.observe();
            assertThat(withdrawn.state()).isEqualTo(State.WITHDRAWN);
            assertThat(withdrawn.reason()).isEqualTo("MODEL_FILES_CHANGED");
            assertThat(withdrawn.detail()).isEqualTo(LocalModelAdmission.NOT_ADMITTED_DIGEST);
        }
    }

    @Test
    void visionModelThatWasNeverAdmittedIsNotAdmittedWithTheStableReasonAndAbsentEngineIsUnavailable() throws Exception {
        Path florence = modelDir(tmp, "florence", LocalVisionEngine.FLORENCE_MODEL_ID, "VISION", "MIT");
        Files.writeString(florence.resolve("model.safetensors"), "tampered before admission");
        Path missing = tmp.resolve("no-qwen-here");
        try (FakeSidecar sidecar = new FakeSidecar()) {
            LocalVisionEngine engine = engine(sidecar, florence, missing);
            Observation bad = new MediaDevProviderCatalog.VisionProbe(LocalProvider.FLORENCE, "VISION", engine, false).observe();
            assertThat(bad.state()).isEqualTo(State.NOT_ADMITTED);
            assertThat(bad.reason()).isEqualTo(LocalModelAdmission.NOT_ADMITTED_DIGEST);
            Observation absent = new MediaDevProviderCatalog.VisionProbe(LocalProvider.QWEN, "MULTIMODAL_QA", engine, true).observe();
            assertThat(absent.state()).isEqualTo(State.NOT_ADMITTED);
            assertThat(absent.reason()).isEqualTo(LocalModelAdmission.NOT_ADMITTED_MANIFEST_MISSING);
        }
        Observation none = new MediaDevProviderCatalog.VisionProbe(LocalProvider.FLORENCE, "VISION", null, false).observe();
        assertThat(none.state()).isEqualTo(State.UNAVAILABLE);
        assertThat(none.reason()).isEqualTo("NOT_CONFIGURED");
    }

    @Test
    void speechProvidersThatAreNotComposedAreUnavailableNotReady() {
        assertThat(new MediaDevProviderCatalog.WhisperProbe(null, Map.of()).observe().state()).isEqualTo(State.UNAVAILABLE);
        assertThat(new MediaDevProviderCatalog.KokoroProbe(null).observe().reason()).isEqualTo("NOT_CONFIGURED");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Map<String, Object>> byId(Map<String, Object> view) {
        Map<String, Map<String, Object>> out = new java.util.LinkedHashMap<>();
        for (Map<String, Object> provider : (List<Map<String, Object>>) view.get("providers")) {
            out.put(String.valueOf(provider.get("providerId")), provider);
        }
        return out;
    }
}
