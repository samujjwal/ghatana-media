package com.ghatana.tts.local;

import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.media.runtime.localmodel.LocalModelManifest;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.BooleanSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Owns one persistent loopback Kokoro worker ({@code tools/model-runtimes/kokoro_worker.py}) so a synthesis no longer
 * pays the interpreter start-up, torch import and weight load of the one-shot sidecar.
 *
 * <p>Process model: {@code python -I kokoro_worker.py} with an argument array (never a shell), a minimal environment,
 * a random per-process bearer token, a free loopback port and discarded stdout/stderr (no content reaches a log). The
 * worker itself refuses to serve unless the weights, config, voice packs and its own script match the manifest, and
 * exits when this JVM disappears. This class starts it lazily, restarts it after a crash (a bounded number of
 * consecutive failures, then a cool-down), and stops it on {@link #close()}.</p>
 *
 * <p>Fail-closed: an unreachable, crashed, unverified or refusing worker is a typed {@link LocalTtsException}, never
 * a fabricated success. A call is retried once after a crash because synthesis has no external effect.</p>
 */
public final class LocalKokoroWorker implements AutoCloseable {
    static final int MAX_RESPONSE_BYTES = (int) LocalKokoroSynthesizer.MAX_WAV_BYTES;
    private static final int MAX_BODY_BYTES = 64 * 1024;
    private static final Pattern ERROR_CODE = Pattern.compile("\"error\"\\s*:\\s*\"([A-Z_]{1,40})\"");
    private static final ConcurrentHashMap<String, LocalKokoroWorker> SHARED = new ConcurrentHashMap<>();
    private static volatile boolean hookInstalled;

    public record Config(Path python, Path script, Path modelDir, Path manifest, String device,
                         Duration startupTimeout, int maxConsecutiveFailures, Duration failureCooldown) {
        public Config {
            Objects.requireNonNull(python, "python");
            Objects.requireNonNull(script, "script");
            Objects.requireNonNull(modelDir, "modelDir");
            Objects.requireNonNull(manifest, "manifest");
            if (!python.isAbsolute() || !script.isAbsolute() || !modelDir.isAbsolute() || !manifest.isAbsolute()) {
                throw new IllegalArgumentException("worker paths must be absolute");
            }
            if (!Map.of("auto", 1, "cpu", 1, "cuda", 1).containsKey(device)) {
                throw new IllegalArgumentException("device must be auto, cpu or cuda");
            }
            if (startupTimeout.isNegative() || startupTimeout.isZero()
                    || startupTimeout.compareTo(Duration.ofMinutes(10)) > 0) {
                throw new IllegalArgumentException("startupTimeout must be within (0, 10 minutes]");
            }
            if (maxConsecutiveFailures < 1 || maxConsecutiveFailures > 10) {
                throw new IllegalArgumentException("maxConsecutiveFailures must be 1-10");
            }
            if (failureCooldown.isNegative()) throw new IllegalArgumentException("failureCooldown");
        }

        public static Config of(Path python, Path script, Path modelDir, Path manifest) {
            return new Config(python.toAbsolutePath().normalize(), script.toAbsolutePath().normalize(),
                    modelDir.toAbsolutePath().normalize(), manifest.toAbsolutePath().normalize(), "auto",
                    Duration.ofMinutes(3), 3, Duration.ofSeconds(30));
        }

        public Config withDevice(String value) {
            return new Config(python, script, modelDir, manifest, value, startupTimeout, maxConsecutiveFailures,
                    failureCooldown);
        }

        public Config withTimings(Duration startup, int failures, Duration cooldown) {
            return new Config(python, script, modelDir, manifest, device, startup, failures, cooldown);
        }
    }

    public record Result(byte[] wav, String device, long samples, long elapsedMillis) { }

    private final Config config;
    private final String pinnedScriptSha256;
    private final BooleanSupplier installCurrent;
    private final String scriptStamp;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5))
            .followRedirects(HttpClient.Redirect.NEVER).build();
    private final Object lifecycle = new Object();
    private Process process;
    private URI base;
    private String token;
    private Path home;
    private int consecutiveFailures;
    private long lastFailureNanos;
    private volatile int startCount;
    private volatile boolean closed;
    private volatile boolean withdrawn;

    /**
     * @param installCurrent true while the verified model install (weights, voices, manifest) is unchanged on disk;
     *                       a false answer withdraws the worker permanently (it is stopped and refuses to serve).
     */
    public LocalKokoroWorker(Config config, String pinnedScriptSha256, BooleanSupplier installCurrent) {
        this.config = Objects.requireNonNull(config, "config");
        if (!pinnedScriptSha256.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("pinnedScriptSha256");
        this.pinnedScriptSha256 = pinnedScriptSha256;
        this.installCurrent = Objects.requireNonNull(installCurrent, "installCurrent");
        this.scriptStamp = stamp(config.script());
    }

    /**
     * Builds a worker only when the manifest pins a worker script digest and the script on disk matches it, the
     * interpreter and manifest exist. Returns null when no verifiable worker can be offered.
     */
    public static LocalKokoroWorker forVerified(LocalModelManifest manifest, Path manifestFile, Config config,
                                                BooleanSupplier installCurrent) {
        LocalModelManifest.RuntimeBinding binding = manifest.runtime();
        if (binding == null || !"kokoro".equals(binding.name()) || binding.workerSha256().isEmpty()) return null;
        if (!Files.isExecutable(config.python())
                || !Files.isRegularFile(config.script(), LinkOption.NOFOLLOW_LINKS)
                || !Files.isRegularFile(manifestFile, LinkOption.NOFOLLOW_LINKS)) return null;
        final String scriptSha256;
        try {
            scriptSha256 = LocalModelManifest.sha256(config.script());
        } catch (IOException unreadable) {
            return null;
        }
        if (!binding.acceptsWorkerSha256(scriptSha256)) return null;
        return new LocalKokoroWorker(config, scriptSha256, installCurrent);
    }

    /**
     * One worker per JVM for the same interpreter/script/model: several providers built from the same environment
     * share one loaded model (and one slice of GPU memory). Shared workers are stopped at JVM exit, not by a provider.
     */
    public static LocalKokoroWorker shared(LocalModelManifest manifest, Path manifestFile, Config config,
                                           BooleanSupplier installCurrent) {
        String key = config.python() + "|" + config.script() + "|" + config.modelDir() + "|" + config.device();
        LocalKokoroWorker existing = SHARED.get(key);
        if (existing != null && !existing.closed && !existing.withdrawn) return existing;
        LocalKokoroWorker created = forVerified(manifest, manifestFile, config, installCurrent);
        if (created == null) return null;
        SHARED.put(key, created);
        installHook();
        return created;
    }

    private static synchronized void installHook() {
        if (hookInstalled) return;
        hookInstalled = true;
        Runtime.getRuntime().addShutdownHook(new Thread(() -> SHARED.values().forEach(LocalKokoroWorker::close),
                "media-kokoro-worker-shutdown"));
    }

    /** True while the worker script and the verified install are unchanged and the worker was not closed. */
    public boolean ready() {
        if (closed || withdrawn) return false;
        if (!scriptStamp.equals(stamp(config.script())) || !installCurrent.getAsBoolean()) {
            withdraw();
            return false;
        }
        return true;
    }

    /** Number of worker processes started so far (1 after the first call, more after crash restarts). */
    public int startCount() { return startCount; }

    /** True while a worker process is alive (it may still be starting). */
    public boolean running() {
        synchronized (lifecycle) { return process != null && process.isAlive(); }
    }

    /** The worker's own authenticated health answer, or null when it is not running or unreachable. */
    public String healthJson() {
        URI uri;
        String bearer;
        synchronized (lifecycle) {
            if (process == null || !process.isAlive()) return null;
            uri = base;
            bearer = token;
        }
        try {
            HttpResponse<String> response = http.send(HttpRequest.newBuilder(uri.resolve("/v1/health"))
                    .timeout(Duration.ofSeconds(5)).header("Authorization", "Bearer " + bearer).GET().build(),
                    HttpResponse.BodyHandlers.ofString());
            return response.statusCode() == 200 ? response.body() : null;
        } catch (IOException | RuntimeException e) {
            return null;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        }
    }

    public Result synthesize(String text, String voice, double speed, Duration budget,
                             BoundedProcessRunner.CancellationToken cancellation) throws LocalTtsException {
        long deadline = System.nanoTime() + budget.toNanos();
        // True once a request reached the worker and the connection was then lost: the synthesis may have run.
        boolean mayHaveRun = false;
        for (int attempt = 0; ; attempt++) {
            if (!ready()) throw new LocalTtsException(LocalTtsException.Code.FILES_CHANGED,
                    "the Kokoro worker's verified files changed or it was closed; it is withdrawn");
            Duration remaining = Duration.ofNanos(deadline - System.nanoTime());
            if (remaining.isNegative() || remaining.isZero()) {
                throw new LocalTtsException(LocalTtsException.Code.TIMEOUT, "no time budget remains");
            }
            URI uri;
            String bearer;
            Process used;
            synchronized (lifecycle) {
                try {
                    ensureRunning(deadline);
                } catch (LocalTtsException notRunning) {
                    // A restart that cannot come up after a call that was lost mid-flight: the earlier call may have run.
                    if (mayHaveRun && notRunning.code() == LocalTtsException.Code.WORKER_UNAVAILABLE) {
                        throw new LocalTtsException(LocalTtsException.Code.PROCESS_FAILED,
                                "the Kokoro worker was lost mid-synthesis and could not be restarted");
                    }
                    throw notRunning;
                }
                uri = base;
                bearer = token;
                used = process;
            }
            remaining = Duration.ofNanos(deadline - System.nanoTime());
            if (remaining.isNegative() || remaining.isZero()) {
                throw new LocalTtsException(LocalTtsException.Code.TIMEOUT, "worker start-up used the time budget");
            }
            try {
                Result result = post(uri, bearer, text, voice, speed, remaining, cancellation);
                synchronized (lifecycle) { consecutiveFailures = 0; }
                return result;
            } catch (WorkerUnreachable unreachable) {
                synchronized (lifecycle) {
                    if (process == used) stopProcess();
                    recordFailure();
                }
                if (unreachable.hung) {
                    // The worker accepted the request and then neither answered nor hit its own deadline: it is hung.
                    // It was killed above, so the abandoned call cannot finish later and the next call starts fresh.
                    throw new LocalTtsException(LocalTtsException.Code.TIMEOUT,
                            "Kokoro synthesis exceeded its time budget and the hung worker was stopped");
                }
                mayHaveRun |= unreachable.sent;
                if (attempt >= 1) {
                    throw new LocalTtsException(mayHaveRun ? LocalTtsException.Code.PROCESS_FAILED
                            : LocalTtsException.Code.WORKER_UNAVAILABLE,
                            mayHaveRun ? "the Kokoro worker was lost mid-synthesis; the outcome is unknown"
                                    : "the Kokoro worker is unreachable after a restart");
                }
            }
        }
    }

    // ---- request ----

    private Result post(URI uri, String bearer, String text, String voice, double speed, Duration remaining,
                        BoundedProcessRunner.CancellationToken cancellation)
            throws LocalTtsException, WorkerUnreachable {
        long deadlineMillis = Math.max(1, Math.min(remaining.toMillis(), 180_000));
        byte[] body = ("{\"text\":" + quote(text) + ",\"voice\":" + quote(voice) + ",\"lang\":\"" + voice.charAt(0) + "\",\"speed\":"
                + String.format(Locale.ROOT, "%.4f", speed) + ",\"deadlineMillis\":" + deadlineMillis + "}")
                .getBytes(StandardCharsets.UTF_8);
        if (body.length > MAX_BODY_BYTES) {
            throw new LocalTtsException(LocalTtsException.Code.INVALID_INPUT, "request exceeds the worker's body bound");
        }
        HttpRequest request = HttpRequest.newBuilder(uri.resolve("/v1/synthesize"))
                .timeout(Duration.ofMillis(deadlineMillis + 5_000)).header("Authorization", "Bearer " + bearer)
                .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofByteArray(body)).build();
        CompletableFuture<HttpResponse<InputStream>> future =
                http.sendAsync(request, HttpResponse.BodyHandlers.ofInputStream());
        try {
            HttpResponse<InputStream> response = awaitCancellable(future, cancellation);
            try (InputStream stream = response.body()) {
                byte[] data = stream.readNBytes(MAX_RESPONSE_BYTES + 1);
                if (data.length > MAX_RESPONSE_BYTES) {
                    throw new LocalTtsException(LocalTtsException.Code.OUTPUT_TOO_LARGE,
                            "Kokoro worker output exceeded its ceiling");
                }
                if (response.statusCode() == 200) {
                    String device = response.headers().firstValue("X-Kokoro-Device").orElse("unknown");
                    long[] shape = LocalKokoroSynthesizer.validate(data);
                    return new Result(data, device, shape[1], 0);
                }
                throw refusal(response.statusCode(), new String(data, StandardCharsets.UTF_8));
            }
        } catch (LocalTtsException typed) {
            throw typed;
        } catch (InterruptedException interrupted) {
            future.cancel(true);
            Thread.currentThread().interrupt();
            throw new LocalTtsException(LocalTtsException.Code.CANCELLED, "Kokoro synthesis was interrupted");
        } catch (ExecutionException failure) {
            Throwable cause = failure.getCause();
            if (cause instanceof java.net.http.HttpConnectTimeoutException || cause instanceof java.net.ConnectException) {
                throw new WorkerUnreachable(false, false);
            }
            if (cause instanceof HttpTimeoutException) throw new WorkerUnreachable(true, true);
            throw new WorkerUnreachable(true, false);
        } catch (IOException failure) {
            throw new WorkerUnreachable(true, false);
        }
    }

    private static LocalTtsException refusal(int status, String body) {
        Matcher matcher = ERROR_CODE.matcher(body);
        String code = matcher.find() ? matcher.group(1) : "ERROR";
        return switch (status) {
            case 400, 413 -> new LocalTtsException(LocalTtsException.Code.INVALID_INPUT,
                    "Kokoro worker rejected the request (" + code + ")");
            case 401, 403 -> new LocalTtsException(LocalTtsException.Code.WORKER_UNAVAILABLE,
                    "Kokoro worker refused the supervisor's credentials");
            case 429 -> new LocalTtsException(LocalTtsException.Code.WORKER_BUSY,
                    "Kokoro worker queue is full");
            case 504 -> new LocalTtsException(LocalTtsException.Code.TIMEOUT,
                    "Kokoro synthesis exceeded its time budget");
            case 503 -> new LocalTtsException("FILES_CHANGED".equals(code)
                    ? LocalTtsException.Code.FILES_CHANGED : LocalTtsException.Code.WORKER_UNAVAILABLE,
                    "Kokoro worker refused to serve (" + code + ")");
            case 422 -> new LocalTtsException("OUTPUT_TOO_LARGE".equals(code)
                    ? LocalTtsException.Code.OUTPUT_TOO_LARGE : LocalTtsException.Code.PROCESS_FAILED,
                    "Kokoro worker could not synthesize (" + code + ")");
            default -> new LocalTtsException(LocalTtsException.Code.PROCESS_FAILED,
                    "Kokoro worker failed (" + status + " " + code + ")");
        };
    }

    private HttpResponse<InputStream> awaitCancellable(CompletableFuture<HttpResponse<InputStream>> future,
                                                       BoundedProcessRunner.CancellationToken cancellation)
            throws InterruptedException, ExecutionException, LocalTtsException {
        while (true) {
            try {
                return future.get(100, TimeUnit.MILLISECONDS);
            } catch (TimeoutException stillRunning) {
                if (cancellation.isCancelled()) {
                    future.cancel(true);
                    throw new LocalTtsException(LocalTtsException.Code.CANCELLED, "Kokoro synthesis was cancelled");
                }
            }
        }
    }

    private static final class WorkerUnreachable extends Exception {
        private static final long serialVersionUID = 1L;
        /** The request reached the worker (so the synthesis may have run) before the connection was lost. */
        final boolean sent;
        /** The worker accepted the request but never answered within the client deadline. */
        final boolean hung;
        WorkerUnreachable(boolean sent, boolean hung) {
            super(null, null, false, false);
            this.sent = sent;
            this.hung = hung;
        }
    }

    // ---- supervision (callers hold the lifecycle lock) ----

    private void ensureRunning(long deadlineNanos) throws LocalTtsException {
        if (closed || withdrawn) throw new LocalTtsException(LocalTtsException.Code.FILES_CHANGED,
                "the Kokoro worker was withdrawn");
        if (process != null && process.isAlive()) return;
        if (process != null) {  // died since the last call: crash
            stopProcess();
            recordFailure();
        }
        if (consecutiveFailures >= config.maxConsecutiveFailures()) {
            if (System.nanoTime() - lastFailureNanos < config.failureCooldown().toNanos()) {
                throw new LocalTtsException(LocalTtsException.Code.WORKER_UNAVAILABLE,
                        "the Kokoro worker failed " + consecutiveFailures + " times in a row; cooling down");
            }
            consecutiveFailures = config.maxConsecutiveFailures() - 1;  // one probe after the cool-down
        }
        try {
            startProcess(deadlineNanos);
        } catch (IOException failure) {
            stopProcess();
            recordFailure();
            throw new LocalTtsException(LocalTtsException.Code.WORKER_UNAVAILABLE,
                    "the Kokoro worker could not be started or did not become ready");
        }
    }

    private void recordFailure() {
        consecutiveFailures++;
        lastFailureNanos = System.nanoTime();
    }

    private void startProcess(long deadlineNanos) throws IOException {
        byte[] random = new byte[24];
        new SecureRandom().nextBytes(random);
        token = HexFormat.of().formatHex(random);
        int port;
        try (ServerSocket probe = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            port = probe.getLocalPort();
        }
        home = Files.createTempDirectory("media-kokoro-worker-");
        List<String> command = new ArrayList<>(List.of(config.python().toString(), "-I", config.script().toString(),
                "--host", "127.0.0.1", "--port", Integer.toString(port), "--model-dir", config.modelDir().toString(),
                "--manifest", config.manifest().toString(), "--device", config.device(),
                "--parent-pid", Long.toString(ProcessHandle.current().pid())));
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.environment().clear();
        builder.environment().putAll(Map.of("GHATANA_KOKORO_WORKER_TOKEN", token, "PATH", "/usr/bin:/bin",
                "HOME", home.toString(), "LC_ALL", "C.UTF-8", "HF_HUB_OFFLINE", "1", "TRANSFORMERS_OFFLINE", "1",
                "XDG_CACHE_HOME", home.toString(), "TORCH_HOME", home.toString(), "PYTHONDONTWRITEBYTECODE", "1",
                "OMP_NUM_THREADS", "4"));
        builder.directory(home.toFile());
        builder.redirectInput(ProcessBuilder.Redirect.from(new File("/dev/null")));
        builder.redirectOutput(ProcessBuilder.Redirect.DISCARD);
        builder.redirectError(ProcessBuilder.Redirect.DISCARD);
        process = builder.start();
        base = URI.create("http://127.0.0.1:" + port);
        startCount++;
        long startBy = Math.min(System.nanoTime() + config.startupTimeout().toNanos(), deadlineNanos);
        try {
            while (System.nanoTime() < startBy) {
                if (!process.isAlive()) throw new IOException("worker exited during start-up");
                if (probeHealthy()) return;
                Thread.sleep(200);
            }
            throw new IOException("worker did not become healthy in time");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException("interrupted while starting the worker", interrupted);
        }
    }

    private boolean probeHealthy() {
        try {
            HttpResponse<Void> response = http.send(HttpRequest.newBuilder(base.resolve("/v1/health"))
                    .timeout(Duration.ofSeconds(5)).header("Authorization", "Bearer " + token).GET().build(),
                    HttpResponse.BodyHandlers.discarding());
            return response.statusCode() == 200;
        } catch (IOException | RuntimeException e) {
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private void stopProcess() {
        Process old = process;
        process = null;
        if (old != null) {
            old.toHandle().descendants().forEach(ProcessHandle::destroyForcibly);
            old.destroyForcibly();
            try {
                old.waitFor(10, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
        if (home != null) {
            deleteTree(home);
            home = null;
        }
    }

    private void withdraw() {
        withdrawn = true;
        synchronized (lifecycle) { stopProcess(); }
    }

    @Override
    public void close() {
        closed = true;
        synchronized (lifecycle) { stopProcess(); }
    }

    // ---- helpers ----

    private static String stamp(Path file) {
        try {
            BasicFileAttributes attrs = Files.readAttributes(file, BasicFileAttributes.class,
                    LinkOption.NOFOLLOW_LINKS);
            return attrs.size() + ":" + attrs.lastModifiedTime().to(TimeUnit.NANOSECONDS) + ":" + attrs.fileKey();
        } catch (IOException unreadable) {
            return "unreadable";
        }
    }

    static String quote(String value) {
        StringBuilder out = new StringBuilder(value.length() + 2).append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c)); else out.append(c);
                }
            }
        }
        return out.append('"').toString();
    }

    private static void deleteTree(Path root) {
        try (var walk = Files.walk(root)) {
            walk.sorted(Comparator.reverseOrder()).forEach(path -> {
                try { Files.deleteIfExists(path); } catch (IOException ignored) { /* temporary only */ }
            });
        } catch (IOException ignored) {
            // temporary home only
        }
    }
}
