package com.ghatana.media.production.rendering;

import java.io.IOException;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Objects;

/**
 * Internal byte-budget guard for a future render destination. This accounts
 * bytes accepted by the delegate; it does not establish a playable artifact.
 */
final class BoundedRenderOutput extends OutputStream {
    private final OutputStream destination;
    private final long maximumBytes;
    private final MessageDigest digest;
    private long bytesWritten;
    private boolean closed;
    private boolean failed;
    private String completedSha256;

    BoundedRenderOutput(OutputStream destination, long maximumBytes) {
        this.destination = Objects.requireNonNull(destination, "destination");
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
    public void write(int value) throws IOException {
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
    public void write(byte[] bytes, int offset, int length) throws IOException {
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
        if ((long) length > maximumBytes - bytesWritten) {
            failed = true;
            throw new IOException("render output byte budget exceeded");
        }
    }

    @Override
    public void flush() throws IOException {
        if (closed) throw new IOException("render output is closed");
        if (failed) throw new IOException("render output has failed");
        try {
            destination.flush();
        } catch (IOException | RuntimeException | Error failure) {
            failed = true;
            throw failure;
        }
    }

    @Override
    public void close() throws IOException {
        if (closed) return;
        closed = true;
        try {
            destination.close();
            if (!failed) completedSha256 = HexFormat.of().formatHex(digest.digest());
        } catch (IOException | RuntimeException | Error failure) {
            failed = true;
            throw failure;
        }
    }

    long bytesWritten() { return bytesWritten; }

    /** Digest is available only after a clean close; partial output has no completion digest. */
    String completedSha256() { return completedSha256; }
}
