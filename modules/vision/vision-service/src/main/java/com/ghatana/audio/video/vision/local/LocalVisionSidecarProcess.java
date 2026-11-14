package com.ghatana.audio.video.vision.local;

import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Starts and owns one loopback vision sidecar process: {@code python -I vision_sidecar.py} with an argument
 * array (no shell), a minimal environment, a random per-process bearer token and a free loopback port.
 * Standard output and error are discarded, so no request content can reach a log. {@link #close()} terminates
 * the process tree. Intended for development hosts and tests; production-like hosts supply an already
 * supervised sidecar through {@code MEDIA_LOCAL_VISION_SIDECAR_URL}.
 *
 * @doc.type class
 * @doc.purpose Owned loopback sidecar process lifecycle
 * @doc.layer product
 * @doc.pattern Resource
 */
public final class LocalVisionSidecarProcess implements AutoCloseable {

    private final Process process;
    private final URI base;
    private final String token;

    private LocalVisionSidecarProcess(Process process, URI base, String token) {
        this.process = process;
        this.base = base;
        this.token = token;
    }

    public URI baseUri() { return base; }

    public String token() { return token; }

    /** Builds a client with the given per-call timeout. */
    public LocalVisionSidecarClient client(Duration timeout) {
        return new LocalVisionSidecarClient(base, token, timeout);
    }

    /**
     * @param python    absolute path of the sidecar virtual environment's interpreter
     * @param script    absolute path of {@code vision_sidecar.py}
     * @param modelsRoot absolute directory holding the model directories
     * @param startupTimeout maximum time to wait for the sidecar's authenticated health endpoint
     */
    public static LocalVisionSidecarProcess start(Path python, Path script, Path modelsRoot, Duration startupTimeout)
            throws IOException {
        Objects.requireNonNull(python, "python");
        if (!python.isAbsolute() || !script.isAbsolute() || !modelsRoot.isAbsolute()) {
            throw new IllegalArgumentException("sidecar paths must be absolute");
        }
        if (!Files.isExecutable(python) || !Files.isRegularFile(script) || !Files.isDirectory(modelsRoot)) {
            throw new IOException("sidecar interpreter, script or models root is not available");
        }
        byte[] random = new byte[24];
        new SecureRandom().nextBytes(random);
        String token = HexFormat.of().formatHex(random);
        int port;
        try (ServerSocket probe = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            port = probe.getLocalPort();
        }
        List<String> command = new ArrayList<>(List.of(python.toString(), "-I", script.toString(),
                "--host", "127.0.0.1", "--port", Integer.toString(port), "--models-root", modelsRoot.toString()));
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.environment().clear();
        builder.environment().putAll(Map.of("GHATANA_VISION_SIDECAR_TOKEN", token,
                "HOME", System.getProperty("user.home"), "PATH", "/usr/bin:/bin",
                "HF_HUB_OFFLINE", "1", "TRANSFORMERS_OFFLINE", "1"));
        builder.redirectInput(ProcessBuilder.Redirect.from(new java.io.File("/dev/null")));
        builder.redirectOutput(ProcessBuilder.Redirect.DISCARD);
        builder.redirectError(ProcessBuilder.Redirect.DISCARD);
        Process process = builder.start();
        URI base = URI.create("http://127.0.0.1:" + port);
        LocalVisionSidecarProcess owned = new LocalVisionSidecarProcess(process, base, token);
        LocalVisionSidecarClient probeClient = owned.client(Duration.ofSeconds(5));
        long deadline = System.nanoTime() + startupTimeout.toNanos();
        try {
            while (System.nanoTime() < deadline) {
                if (!process.isAlive()) throw new IOException("sidecar exited during startup");
                if (probeClient.healthy()) return owned;
                Thread.sleep(250);
            }
            throw new IOException("sidecar did not become healthy in time");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            owned.close();
            throw new IOException("interrupted while starting the sidecar", interrupted);
        } catch (IOException | RuntimeException failure) {
            owned.close();
            throw failure;
        }
    }

    @Override
    public void close() {
        process.toHandle().descendants().forEach(ProcessHandle::destroyForcibly);
        process.destroyForcibly();
        try {
            process.waitFor(10, java.util.concurrent.TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }
}
