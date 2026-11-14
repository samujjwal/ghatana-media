package com.ghatana.tts.local;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.media.runtime.localmodel.LocalModelInstall;
import com.ghatana.media.runtime.localmodel.LocalModelManifest;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.sound.sampled.AudioFileFormat;
import javax.sound.sampled.AudioFormat;
import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Supervision of the persistent Kokoro worker against a stdlib fake worker (it speaks the real wire protocol, a
 * mode file steers its behaviour) plus the real {@code kokoro_worker.py} for the digest-refusal path, which fails
 * before torch is ever imported. Proves the Java-side contract: lazy start, crash restart, bounded retries and
 * cool-down, typed fail-closed refusals, readiness withdrawal and cleanup. Not model quality.
 */
class LocalKokoroWorkerTest {
    private static final Path PYTHON = Path.of("/usr/bin/python3");
    private static final String FAKE = """
            import argparse, http.server, os, sys, time
            p = argparse.ArgumentParser()
            for a in ("--host", "--port", "--model-dir", "--manifest", "--device", "--parent-pid"):
                p.add_argument(a)
            args = p.parse_args()
            here = os.path.dirname(os.path.abspath(__file__))
            token = os.environ["GHATANA_KOKORO_WORKER_TOKEN"]
            def mode():
                try:
                    return open(os.path.join(here, "mode")).read().strip()
                except OSError:
                    return "ok"
            with open(os.path.join(here, "starts"), "a") as f:
                f.write("x\\n")
            if mode() == "exit-at-start":
                sys.exit(3)
            wav = open(os.path.join(here, "clip.wav"), "rb").read()
            class H(http.server.BaseHTTPRequestHandler):
                def log_message(self, *a): pass
                def send(self, status, body, ctype="application/json", extra=None):
                    self.send_response(status)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Content-Length", str(len(body)))
                    for k, v in (extra or {}).items():
                        self.send_header(k, v)
                    self.end_headers()
                    self.wfile.write(body)
                def ok(self):
                    return self.headers.get("Authorization") == "Bearer " + token
                def do_GET(self):
                    if not self.ok():
                        return self.send(401, b'{"error":"UNAUTHORIZED"}')
                    self.send(200, b'{"status":"UP","device":"cuda:0"}')
                def do_POST(self):
                    n = int(self.headers.get("Content-Length", "0"))
                    body = self.rfile.read(n)
                    if not self.ok():
                        return self.send(401, b'{"error":"UNAUTHORIZED"}')
                    m = mode()
                    with open(os.path.join(here, "bodies"), "ab") as f:
                        f.write(body + b"\\n")
                    if m == "crash-once" and not os.path.exists(os.path.join(here, "crashed")):
                        open(os.path.join(here, "crashed"), "w").close()
                        os._exit(1)
                    if m == "crash-always":
                        os._exit(1)
                    if m == "401": return self.send(401, b'{"error":"UNAUTHORIZED"}')
                    if m == "400": return self.send(400, b'{"error":"INVALID_REQUEST"}')
                    if m == "429": return self.send(429, b'{"error":"BUSY"}')
                    if m == "504": return self.send(504, b'{"error":"DEADLINE_EXCEEDED"}')
                    if m == "files": return self.send(503, b'{"error":"FILES_CHANGED"}')
                    if m == "garbage": return self.send(200, b"not a wav", "audio/wav")
                    if m == "slow": time.sleep(5)
                    self.send(200, wav, "audio/wav", {"X-Kokoro-Device": "cuda:0"})
                    if m == "exit-after-one":
                        self.wfile.flush()
                        os._exit(0)
            http.server.ThreadingHTTPServer(("127.0.0.1", int(args.port)), H).serve_forever()
            """;

    @TempDir Path dir;
    private LocalKokoroWorker worker;
    private final AtomicBoolean installCurrent = new AtomicBoolean(true);
    private Path script;

    private static String sha(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static byte[] wav24k(int samples) throws Exception {
        AudioFormat format = new AudioFormat(24_000, 16, 1, true, false);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        AudioSystem.write(new AudioInputStream(new ByteArrayInputStream(new byte[samples * 2]), format, samples),
                AudioFileFormat.Type.WAVE, out);
        return out.toByteArray();
    }

    @BeforeEach
    void setUp() throws Exception {
        Assumptions.assumeTrue(Files.isExecutable(PYTHON), "system python3 is required for the fake worker");
        script = Files.writeString(dir.resolve("worker.py"), FAKE);
        Files.write(dir.resolve("clip.wav"), wav24k(2400));
    }

    @AfterEach
    void tearDown() {
        if (worker != null) worker.close();
    }

    private void mode(String value) throws Exception {
        Files.writeString(dir.resolve("mode"), value);
    }

    private int starts() throws Exception {
        Path file = dir.resolve("starts");
        return Files.exists(file) ? Files.readAllLines(file).size() : 0;
    }

    private LocalKokoroWorker worker(int maxFailures, Duration cooldown) throws Exception {
        LocalKokoroWorker.Config config = LocalKokoroWorker.Config.of(PYTHON, script, dir, dir.resolve("manifest.json"))
                .withTimings(Duration.ofSeconds(20), maxFailures, cooldown);
        worker = new LocalKokoroWorker(config, sha(FAKE.getBytes(StandardCharsets.UTF_8)), installCurrent::get);
        return worker;
    }

    private LocalTtsException failure(LocalKokoroWorker w, Duration budget) {
        return org.junit.jupiter.api.Assertions.assertThrows(LocalTtsException.class,
                () -> w.synthesize("hello", "af_heart", 1.0, budget, BoundedProcessRunner.CancellationToken.NEVER));
    }

    private LocalKokoroWorker.Result ok(LocalKokoroWorker w) throws Exception {
        return w.synthesize("hello", "af_heart", 1.0, Duration.ofSeconds(30),
                BoundedProcessRunner.CancellationToken.NEVER);
    }

    @Test
    void startsLazilyServesWarmCallsAndStopsOnClose() throws Exception {
        var w = worker(3, Duration.ofSeconds(1));
        assertThat(w.running()).isFalse();
        var first = ok(w);
        assertThat(first.samples()).isEqualTo(2400);
        assertThat(first.device()).isEqualTo("cuda:0");
        ok(w);
        ok(w);
        assertThat(w.startCount()).isEqualTo(1);
        assertThat(starts()).isEqualTo(1);
        assertThat(w.healthJson()).contains("\"UP\"");
        w.close();
        assertThat(w.running()).isFalse();
        assertThat(failure(w, Duration.ofSeconds(5)).code()).isEqualTo(LocalTtsException.Code.FILES_CHANGED);
    }

    @Test
    void crashDuringARequestRestartsTheWorkerAndTheCallStillSucceedsOnce() throws Exception {
        mode("crash-once");
        var w = worker(3, Duration.ofSeconds(1));
        assertThat(ok(w).samples()).isEqualTo(2400);
        assertThat(w.startCount()).isEqualTo(2);
        assertThat(starts()).isEqualTo(2);
    }

    @Test
    void workerThatDiesBetweenCallsIsRestartedOnTheNextCall() throws Exception {
        mode("exit-after-one");
        var w = worker(3, Duration.ofSeconds(1));
        ok(w);
        Thread.sleep(500);
        ok(w);
        assertThat(w.startCount()).isEqualTo(2);
    }

    @Test
    void aWorkerThatKeepsCrashingIsRefusedTypedThenCoolsDownWithoutSpawningMore() throws Exception {
        mode("crash-always");
        var w = worker(3, Duration.ofMinutes(10));
        assertThat(failure(w, Duration.ofSeconds(30)).code()).isEqualTo(LocalTtsException.Code.WORKER_UNAVAILABLE);
        int afterFirst = w.startCount();
        assertThat(afterFirst).isLessThanOrEqualTo(3);
        for (int i = 0; i < 4; i++) {
            assertThat(failure(w, Duration.ofSeconds(30)).code()).isEqualTo(LocalTtsException.Code.WORKER_UNAVAILABLE);
        }
        assertThat(w.startCount()).isLessThanOrEqualTo(3);
        int frozen = w.startCount();
        assertThat(failure(w, Duration.ofSeconds(30)).getMessage()).contains("cooling down");
        assertThat(w.startCount()).isEqualTo(frozen);
    }

    @Test
    void workerThatCannotStartIsATypedRefusalNeverASuccess() throws Exception {
        mode("exit-at-start");
        var w = worker(2, Duration.ofMinutes(10));
        assertThat(failure(w, Duration.ofSeconds(30)).code()).isEqualTo(LocalTtsException.Code.WORKER_UNAVAILABLE);
        assertThat(failure(w, Duration.ofSeconds(30)).code()).isEqualTo(LocalTtsException.Code.WORKER_UNAVAILABLE);
        assertThat(w.startCount()).isEqualTo(2);
        assertThat(failure(w, Duration.ofSeconds(30)).getMessage()).contains("cooling down");
        assertThat(w.startCount()).isEqualTo(2);
    }

    @Test
    void recoversAfterTheCoolDownWhenTheWorkerIsHealthyAgain() throws Exception {
        mode("exit-at-start");
        var w = worker(1, Duration.ofMillis(300));
        assertThat(failure(w, Duration.ofSeconds(30)).code()).isEqualTo(LocalTtsException.Code.WORKER_UNAVAILABLE);
        assertThat(failure(w, Duration.ofSeconds(30)).getMessage()).contains("cooling down");
        mode("ok");
        Thread.sleep(400);
        assertThat(ok(w).samples()).isEqualTo(2400);
    }

    @Test
    void workerResponsesMapToTypedCodes() throws Exception {
        var w = worker(3, Duration.ofSeconds(1));
        Map<String, LocalTtsException.Code> expected = Map.of(
                "401", LocalTtsException.Code.WORKER_UNAVAILABLE,   // the worker refused the supervisor's token
                "400", LocalTtsException.Code.INVALID_INPUT,
                "429", LocalTtsException.Code.WORKER_BUSY,
                "504", LocalTtsException.Code.TIMEOUT,              // deadline exceeded inside the worker
                "files", LocalTtsException.Code.FILES_CHANGED,
                "garbage", LocalTtsException.Code.OUTPUT_INVALID);
        for (var entry : expected.entrySet()) {
            mode(entry.getKey());
            assertThat(failure(w, Duration.ofSeconds(30)).code()).as(entry.getKey()).isEqualTo(entry.getValue());
        }
        mode("ok");
        assertThat(ok(w).samples()).isEqualTo(2400);  // refusals did not poison a healthy worker
        assertThat(w.startCount()).isEqualTo(1);
    }

    @Test
    void anExhaustedBudgetNeverStartsOrCallsTheWorker() throws Exception {
        var w = worker(3, Duration.ofSeconds(1));
        assertThat(failure(w, Duration.ZERO.plusNanos(1)).code()).isEqualTo(LocalTtsException.Code.TIMEOUT);
        assertThat(starts()).isEqualTo(0);
    }

    @Test
    void cancellationStopsWaitingForASlowWorker() throws Exception {
        mode("slow");
        var w = worker(3, Duration.ofSeconds(1));
        long started = System.nanoTime();
        AtomicBoolean cancel = new AtomicBoolean();
        new Thread(() -> {
            try { Thread.sleep(1500); } catch (InterruptedException ignored) { }
            cancel.set(true);
        }).start();
        var failure = org.junit.jupiter.api.Assertions.assertThrows(LocalTtsException.class,
                () -> w.synthesize("hello", "af_heart", 1.0, Duration.ofSeconds(60), cancel::get));
        assertThat(failure.code()).isEqualTo(LocalTtsException.Code.CANCELLED);
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(5));
    }

    @Test
    void aVerifiedFileChangeWithdrawsReadinessAndStopsTheWorker() throws Exception {
        var w = worker(3, Duration.ofSeconds(1));
        ok(w);
        assertThat(w.ready()).isTrue();
        installCurrent.set(false);  // weights / voice pack / manifest changed on disk
        assertThat(w.ready()).isFalse();
        assertThat(w.running()).isFalse();
        assertThat(failure(w, Duration.ofSeconds(5)).code()).isEqualTo(LocalTtsException.Code.FILES_CHANGED);
        installCurrent.set(true);  // restoring the bytes does not resurrect a withdrawn worker
        assertThat(w.ready()).isFalse();
    }

    @Test
    void aChangedWorkerScriptWithdrawsReadiness() throws Exception {
        var w = worker(3, Duration.ofSeconds(1));
        ok(w);
        Files.writeString(script, FAKE + "\n# tampered\n");
        assertThat(w.ready()).isFalse();
        assertThat(w.running()).isFalse();
    }

    @Test
    void requestTextIsJsonEscapedAndOversizeTextNeverReachesTheWorker() throws Exception {
        assertThat(LocalKokoroWorker.quote("a\"b\\c\nd\u0001é")).isEqualTo("\"a\\\"b\\\\c\\nd\\u0001é\"");
        var w = worker(3, Duration.ofSeconds(1));
        var synthesizer = new LocalKokoroSynthesizer(new LocalKokoroSynthesizer.Config(PYTHON, script, dir,
                java.util.Set.of("af_heart"), "0".repeat(64), Duration.ofSeconds(30)), w);
        assertThat(synthesizer.usesWorker()).isTrue();
        assertThatThrownBy(() -> synthesizer.synthesize("a".repeat(LocalKokoroSynthesizer.MAX_TEXT_CHARS + 1),
                "af_heart", 1.0, Duration.ofSeconds(5), BoundedProcessRunner.CancellationToken.NEVER))
                .isInstanceOfSatisfying(LocalTtsException.class,
                        e -> assertThat(e.code()).isEqualTo(LocalTtsException.Code.INVALID_INPUT));
        assertThat(starts()).isEqualTo(0);
        var result = synthesizer.synthesize("it's \"quoted\"\nnew line", "af_heart", 1.0, Duration.ofSeconds(30),
                BoundedProcessRunner.CancellationToken.NEVER);
        assertThat(result.samples()).isEqualTo(2400);
        assertThat(Files.readString(dir.resolve("bodies"))).contains("\\\"quoted\\\"\\nnew line");
    }

    @Test
    void realWorkerScriptRefusesToServeWhenAFileDigestDoesNotMatchTheManifest() throws Exception {
        Path realScript = Path.of("").toAbsolutePath().getParent().getParent().getParent()
                .resolve("tools/model-runtimes/kokoro_worker.py");
        Assumptions.assumeTrue(Files.isRegularFile(realScript), "kokoro_worker.py not found: " + realScript);
        Path model = Files.createDirectories(dir.resolve("kokoro-82m/voices"));
        model = model.getParent();
        Files.writeString(model.resolve("kokoro-v1_0.pth"), "weights");
        Files.writeString(model.resolve("voices/af_heart.pt"), "voice");
        String realSha = sha(Files.readAllBytes(realScript));
        Files.writeString(model.resolve("manifest.json"), """
                {"files":[{"role":"WEIGHTS","path":"kokoro-v1_0.pth","sha256":"%s"},
                          {"role":"VOICE","path":"voices/af_heart.pt","sha256":"%s"}],
                 "runtime":{"name":"kokoro","workerSha256":"%s"}}
                """.formatted(sha("TAMPERED".getBytes(StandardCharsets.UTF_8)), sha("voice".getBytes()), realSha));
        LocalKokoroWorker.Config config = LocalKokoroWorker.Config.of(PYTHON, realScript, model,
                model.resolve("manifest.json")).withTimings(Duration.ofSeconds(20), 1, Duration.ofMinutes(1));
        worker = new LocalKokoroWorker(config, realSha, () -> true);
        var refused = failure(worker, Duration.ofSeconds(30));
        assertThat(refused.code()).isEqualTo(LocalTtsException.Code.WORKER_UNAVAILABLE);
        assertThat(worker.running()).isFalse();
    }

    @Test
    void providerWithoutAWorkerDigestInTheManifestIsNotReadyInWorkerMode() throws Exception {
        Path sidecar = Files.writeString(dir.resolve("kokoro_synth.py"), "# sidecar fixture\n");
        Path modelDir = Files.createDirectories(dir.resolve("kokoro-82m/voices")).getParent();
        byte[] weights = "w".getBytes(StandardCharsets.UTF_8);
        byte[] voice = "v".getBytes(StandardCharsets.UTF_8);
        byte[] licence = "l".getBytes(StandardCharsets.UTF_8);
        Files.write(modelDir.resolve("kokoro-v1_0.pth"), weights);
        Files.write(modelDir.resolve("voices/af_heart.pt"), voice);
        Files.write(modelDir.resolve("LICENSE-Apache-2.0.txt"), licence);
        String runtime = "\"runtime\":{\"name\":\"kokoro\",\"version\":\"fixture\",\"executableSha256\":\"" + sha(
                Files.readAllBytes(sidecar)) + "\"%s}";
        for (boolean pinned : new boolean[]{false, true}) {
            String json = """
                    {"schema":"ghatana.media.local-model-manifest.v1","modelKey":"kokoro-82m",
                     "modality":"TEXT_TO_SPEECH","modelId":"fixture/kokoro","source":{"url":"https://example.invalid/k","revision":"rev-k"},
                     "files":[{"role":"WEIGHTS","path":"kokoro-v1_0.pth","sha256":"%s","sizeBytes":1},
                              {"role":"VOICE","path":"voices/af_heart.pt","sha256":"%s","sizeBytes":1},
                              {"role":"LICENSE","path":"LICENSE-Apache-2.0.txt","sha256":"%s","sizeBytes":1}],
                     "license":{"spdx":"Apache-2.0","licenseSourceUrl":"https://example.invalid/l","verifiedOn":"2026-11-14"},
                     "ownerDecision":{"date":"2026-11-14","quote":"%s","licenseStatement":"%s"},
                     "attribution":{"noticeRequired":true,"notice":"fixture"},
                     "admission":{"scope":"ARTIFACT_IDENTITY_AND_LICENSE_ONLY","productionEligible":false},
                     "verifiedLanguages":["en"],"voiceCloning":"NOT_SUPPORTED",
                     %s}
                    """.formatted(sha(weights), sha(voice), sha(licence), LocalModelManifest.OWNER_DECISION_QUOTE,
                    LocalModelManifest.OWNER_LICENSE_STATEMENT,
                    runtime.formatted(pinned ? ",\"workerSha256\":\"" + sha(FAKE.getBytes(StandardCharsets.UTF_8))
                            + "\"" : ""));
            Files.writeString(modelDir.resolve("manifest.json"), json);
            LocalModelInstall install = LocalModelInstall.inspect(modelDir, "kokoro-82m",
                    LocalModelManifest.Modality.TEXT_TO_SPEECH);
            assertThat(install.usable()).isTrue();
            var provider = new LocalKokoroTtsProvider(install, PYTHON, sidecar, null,
                    new LocalKokoroTtsProvider.WorkerSettings(script, "cpu"));
            assertThat(provider.ready()).as("worker digest pinned=" + pinned).isEqualTo(pinned);
            assertThat(provider.productionEligible()).isFalse();
            if (pinned) {
                assertThat(provider.synthesizer().usesWorker()).isTrue();
                // the worker is shared per JVM and stopped at JVM exit; stop it so the temp directory can go
                provider.synthesizer().worker().close();
            }
        }
    }
}
