package com.ghatana.media.production.rendering;

import java.io.IOException;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Objects;
import java.util.function.BooleanSupplier;

/**
 * Internal byte-budget guard for a future render destination. This accounts
 * bytes accepted by the delegate; it does not establish a playable artifact.
 */
final class BoundedRenderOutput extends OutputStream {
    private final OutputStream destination;
    private final long maximumBytes;
    private final MessageDigest digest;
    private final BooleanSupplier cancellationRequested;
    private long bytesWritten;
    private boolean closed;
    private boolean failed;
    private String completedSha256;

    BoundedRenderOutput(OutputStream destination, long maximumBytes) {
        this(destination, maximumBytes, () -> false);
    }

    /**
     * The cancellation signal is sampled before each write and flush. Once
     * observed, later bytes are rejected and the output digest remains absent;
     * closing still attempts destination cleanup. An in-flight delegate call
     * is not interrupted and this local boundary does not establish job or
     * provider cancellation finality.
     */
    BoundedRenderOutput(OutputStream destination, long maximumBytes, BooleanSupplier cancellationRequested) {
        this.destination = Objects.requireNonNull(destination, "destination");
        this.cancellationRequested = Objects.requireNonNull(cancellationRequested, "cancellationRequested");
        if (maximumBytes <= 0 || maximumBytes > MultitrackRenderPlanner.MAX_DECLARED_OUTPUT_BYTES) {
            throw new IllegalArgumentException("output limit must be within 1.."
                    + MultitrackRenderPlanner.MAX_DECLARED_OUTPUT_BYTES + " bytes");
        }
        this.maximumBytes = maximumBytes;
        try {
            this.digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is required", impossible);
        }
    }

    @Override
    public synchronized void write(int value) throws IOException {
        ensureWritable(1);
        try {
            destination.write(value);
            digest.update((byte) value);
            bytesWritten++;
        } catch (IOException | RuntimeException | Error failure) {
            failed = true;
            throw failure;
        }
    }

    @Override
    public synchronized void write(byte[] bytes, int offset, int length) throws IOException {
        Objects.checkFromIndexSize(offset, length, bytes.length);
        ensureWritable(length);
        try {
            destination.write(bytes, offset, length);
            digest.update(bytes, offset, length);
            bytesWritten += length;
        } catch (IOException | RuntimeException | Error failure) {
            // The delegate may have emitted a prefix before failing. Treat the
            // destination as partial and never expose its digest as complete.
            failed = true;
            throw failure;
        }
    }

    private void ensureWritable(int length) throws IOException {
        if (closed) throw new IOException("render output is closed");
        if (failed) throw new IOException("render output has failed");
        try {
            if (cancellationRequested.getAsBoolean()) {
                failed = true;
                throw new IOException("render output cancellation requested");
            }
        } catch (RuntimeException | Error failure) {
            failed = true;
            throw failure;
        }
        if ((long) length > maximumBytes - bytesWritten) {
            failed = true;
            throw new IOException("render output byte budget exceeded");
        }
    }

    @Override
    public synchronized void flush() throws IOException {
        ensureWritable(0);
        try {
            destination.flush();
        } catch (IOException | RuntimeException | Error failure) {
            failed = true;
            throw failure;
        }
    }

    @Override
    public synchronized void close() throws IOException {
        if (closed) return;
        boolean cancelled = false;
        RuntimeException cancellationRuntimeFailure = null;
        Error cancellationErrorFailure = null;
        try {
            cancelled = cancellationRequested.getAsBoolean();
        } catch (RuntimeException failure) {
            failed = true;
            cancellationRuntimeFailure = failure;
        } catch (Error failure) {
            failed = true;
            cancellationErrorFailure = failure;
        }
        boolean cancelledAtClose = cancelled && !failed;
        if (cancelled) failed = true;
        try {
            destination.close();
            closed = true;
            // Closing a buffered destination may take time. Recheck before
            // publishing completion so a cancellation observed during close
            // cannot leave a successful digest for the partial result.
            if (!failed && cancellationRequested.getAsBoolean()) {
                failed = true;
                throw new IOException("render output cancellation requested");
            }
            if (!failed) completedSha256 = HexFormat.of().formatHex(digest.digest());
        } catch (IOException | RuntimeException | Error failure) {
            failed = true;
            if (cancellationRuntimeFailure != null) cancellationRuntimeFailure.addSuppressed(failure);
            else if (cancellationErrorFailure != null) cancellationErrorFailure.addSuppressed(failure);
            else throw failure;
        }
        if (cancellationRuntimeFailure != null) throw cancellationRuntimeFailure;
        if (cancellationErrorFailure != null) throw cancellationErrorFailure;
        if (cancelledAtClose) throw new IOException("render output cancellation requested");
    }

    synchronized long bytesWritten() { return bytesWritten; }

    /** Digest is available only after a clean close; partial output has no completion digest. */
    synchronized String completedSha256() { return completedSha256; }
}
