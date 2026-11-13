package com.ghatana.media.production.rendering;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Runs one external program with an argument array (never a shell), a cleared environment, no stdin,
 * bounded stdout/stderr capture, a wall-clock deadline, cooperative cancellation, an optional watched
 * output-file byte ceiling, and process-tree termination. Stderr content is retained only as a byte
 * count and SHA-256; it is deliberately not exposed so tool diagnostics cannot leak into errors.
 */
public final class BoundedProcessRunner {
    private static final long POLL_MILLIS = 20;

    private BoundedProcessRunner() { }

    @FunctionalInterface
    public interface CancellationToken {
        boolean isCancelled();
        CancellationToken NEVER = () -> false;
    }

    /** Simple settable token. */
    public static final class CancellationSource implements CancellationToken {
        private final AtomicBoolean cancelled = new AtomicBoolean();
        public void cancel() { cancelled.set(true); }
        @Override public boolean isCancelled() { return cancelled.get(); }
    }

    public enum End { EXITED, TIMED_OUT, CANCELLED, STDOUT_OVERFLOW, WATCHED_FILE_TOO_LARGE }

    public record Result(End end, int exitCode, byte[] stdout, long stderrBytes, String stderrSha256) {
        @Override public byte[] stdout() { return stdout.clone(); }
        public boolean succeeded() { return end == End.EXITED && exitCode == 0; }
        @Override public String toString() {
            return "Result[end=" + end + ", exitCode=" + exitCode + ", stdoutBytes=" + stdout.length
                    + ", stderrBytes=" + stderrBytes + "]";
        }
    }

    /**
     * @param watchedFile optional file whose size is polled; the process is killed when it exceeds
     *                    {@code watchedMaxBytes}
     * @throws IOException when the process cannot be started
     */
    public static Result run(List<String> command, Path workingDirectory, Map<String, String> environment,
            Duration timeout, int maxStdoutBytes, int maxStderrBytes, CancellationToken cancellation,
            Path watchedFile, long watchedMaxBytes) throws IOException {
        Objects.requireNonNull(command, "command");
        Objects.requireNonNull(timeout, "timeout");
        if (command.isEmpty() || timeout.isNegative() || timeout.isZero() || maxStdoutBytes < 0 || maxStderrBytes < 0) {
            throw new IllegalArgumentException("invalid process invocation");
        }
        ProcessBuilder builder = new ProcessBuilder(List.copyOf(command));
        if (workingDirectory != null) builder.directory(workingDirectory.toFile());
        builder.environment().clear();
        builder.environment().putAll(environment == null ? Map.of() : environment);
        builder.redirectInput(ProcessBuilder.Redirect.from(new File("/dev/null")));
        Process process = builder.start();
        Capture out = new Capture(process.getInputStream(), maxStdoutBytes, "bounded-process-stdout");
        Capture err = new Capture(process.getErrorStream(), maxStderrBytes, "bounded-process-stderr");
        CancellationToken token = cancellation == null ? CancellationToken.NEVER : cancellation;
        long deadline = System.nanoTime() + timeout.toNanos();
        End end = End.EXITED;
        try {
            while (true) {
                if (process.waitFor(POLL_MILLIS, TimeUnit.MILLISECONDS)) break;
                if (token.isCancelled()) { end = End.CANCELLED; break; }
                if (System.nanoTime() - deadline >= 0) { end = End.TIMED_OUT; break; }
                if (out.total.get() > maxStdoutBytes) { end = End.STDOUT_OVERFLOW; break; }
                if (watchedFile != null && size(watchedFile) > watchedMaxBytes) {
                    end = End.WATCHED_FILE_TOO_LARGE;
                    break;
                }
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            end = End.CANCELLED;
        }
        if (end != End.EXITED) killTree(process);
        else if (out.total.get() > maxStdoutBytes) end = End.STDOUT_OVERFLOW;
        else if (watchedFile != null && size(watchedFile) > watchedMaxBytes) end = End.WATCHED_FILE_TOO_LARGE;
        out.join();
        err.join();
        int exit = process.isAlive() ? -1 : process.exitValue();
        return new Result(end, exit, out.bytes(), err.total.get(), err.sha256());
    }

    private static long size(Path file) {
        try {
            return Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) ? Files.size(file) : 0L;
        } catch (IOException e) {
            return 0L;
        }
    }

    private static void killTree(Process process) {
        ProcessHandle handle = process.toHandle();
        handle.descendants().forEach(ProcessHandle::destroyForcibly);
        process.destroyForcibly();
        try {
            process.waitFor(5, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        // Children spawned while the first snapshot was taken.
        handle.descendants().forEach(ProcessHandle::destroyForcibly);
    }

    private static final class Capture implements Runnable {
        private final InputStream stream;
        private final int limit;
        private final ByteArrayOutputStream kept = new ByteArrayOutputStream();
        private final MessageDigest digest = newDigest();
        final AtomicLong total = new AtomicLong();
        private final Thread thread;

        Capture(InputStream stream, int limit, String name) {
            this.stream = stream;
            this.limit = limit;
            this.thread = new Thread(this, name);
            this.thread.setDaemon(true);
            this.thread.start();
        }

        @Override public void run() {
            byte[] buffer = new byte[8192];
            try (stream) {
                int n;
                while ((n = stream.read(buffer)) >= 0) {
                    synchronized (this) {
                        long before = total.get();
                        int keep = (int) Math.max(0, Math.min(n, (long) limit - before));
                        if (keep > 0) {
                            kept.write(buffer, 0, keep);
                            digest.update(buffer, 0, keep);
                        }
                        total.addAndGet(n);
                    }
                }
            } catch (IOException ignored) {
                // stream closed by process kill
            }
        }

        void join() {
            try {
                thread.join(2_000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }

        synchronized byte[] bytes() { return kept.toByteArray(); }
        synchronized String sha256() { return HexFormat.of().formatHex(((MessageDigest) cloneDigest()).digest()); }

        private Object cloneDigest() {
            try {
                return digest.clone();
            } catch (CloneNotSupportedException e) {
                throw new IllegalStateException(e);
            }
        }

        private static MessageDigest newDigest() {
            try {
                return MessageDigest.getInstance("SHA-256");
            } catch (NoSuchAlgorithmException e) {
                throw new IllegalStateException(e);
            }
        }
    }
}
