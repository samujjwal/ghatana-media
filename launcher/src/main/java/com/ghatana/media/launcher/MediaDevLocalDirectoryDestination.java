package com.ghatana.media.launcher;

import com.ghatana.media.production.delivery.DeliveryOperationStore;
import com.ghatana.media.production.delivery.MediaDeliveryEngine;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.ChunkReceipt;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.DestinationReceipt;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.ExportRequest;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.FencedChunkReceipt;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.FencedDestinationReceipt;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.FencedReconciliation;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.TransferAuthorization;
import com.ghatana.media.runtime.MediaCreationContracts;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Arrays;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * DEV_ONLY destination: one configured local directory. It is a real, independent destination in the sense
 * the engine needs: a write is never its own proof. Every destination receipt is produced by re-reading the
 * stored bytes from disk and hashing what is actually there, so a tampered, truncated or substituted file
 * yields an honest receipt (or no receipt) that the engine refuses to confirm.
 *
 * <p>Object names are derived only from a SHA-256 of (tenant, principal, requestId), never from caller text,
 * so there is no path component to traverse; the configured root is resolved to a real directory once and
 * every derived path is re-checked to stay directly under it and not be a symbolic link. Objects are
 * write-once: bytes stage in {@code <name>.part} and are atomically moved to {@code <name>.bin} only when the
 * full artifact length is present. A replayed chunk is verified byte for byte, never rewritten.
 */
final class MediaDevLocalDirectoryDestination implements MediaDeliveryEngine.FencedDestinationPort {
    private static final Pattern NAME = Pattern.compile("[0-9a-f]{64}");
    private static final Set<PosixFilePermission> PRIVATE_FILE_PERMISSIONS = Set.of(
            PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE);
    private final Path root;
    private final DeliveryOperationStore operations;

    MediaDevLocalDirectoryDestination(Path root, DeliveryOperationStore operations) {
        this.root = Objects.requireNonNull(root, "root");
        this.operations = Objects.requireNonNull(operations, "operations");
    }

    /** Validates the configured directory: absolute, no traversal segments, existing, real directory. */
    static Path confineRoot(String configured) {
        if (configured == null || configured.isBlank() || !configured.equals(configured.strip())) {
            throw new IllegalArgumentException("delivery destination directory must be a non-blank exact path");
        }
        Path candidate = Path.of(configured);
        if (!candidate.isAbsolute()) {
            throw new IllegalArgumentException("delivery destination directory must be absolute");
        }
        for (Path part : candidate) {
            if ("..".equals(part.toString()) || ".".equals(part.toString())) {
                throw new IllegalArgumentException("delivery destination directory must not contain traversal segments");
            }
        }
        try {
            Path real = candidate.toRealPath();
            if (!Files.isDirectory(real) || !Files.isWritable(real)) {
                throw new IllegalArgumentException("delivery destination directory must be an existing writable directory");
            }
            return real;
        } catch (IOException failure) {
            throw new IllegalArgumentException("delivery destination directory cannot be resolved", failure);
        }
    }

    static boolean supportsPrivateFilePermissions(Path directory) {
        return Files.getFileAttributeView(directory,
                java.nio.file.attribute.PosixFileAttributeView.class, LinkOption.NOFOLLOW_LINKS) != null;
    }

    /** Public object name for a request; also the only filename component this adapter ever uses. */
    static String objectName(String tenantId, String principalId, String requestId) {
        return MediaDevProjectRenderRuntime.sha256Hex(
                tenantId + "\u0000" + principalId + "\u0000" + requestId);
    }

    /**
     * Removes the delivered object (and any partial write) of one request from the destination directory. The file
     * name is a SHA-256 of tenant, principal and request id, so no caller text reaches the path. Returns how many
     * files were removed.
     */
    static int eraseDelivered(Path root, String tenantId, String principalId, String requestId) {
        String name = objectName(tenantId, principalId, requestId);
        int removed = 0;
        for (String suffix : new String[] {".bin", ".part"}) {
            try {
                if (java.nio.file.Files.deleteIfExists(root.resolve(name + suffix))) removed++;
            } catch (IOException failure) {
                throw new IllegalStateException("delivered object could not be erased", failure);
            }
        }
        return removed;
    }

    Path finalPath(String tenantId, String principalId, String requestId) {
        return confined(objectName(tenantId, principalId, requestId) + ".bin");
    }

    private Path partPath(ExportRequest request) {
        return confined(objectName(request.tenantId(), request.principalId(), request.requestId()) + ".part");
    }

    private Path finalPath(ExportRequest request) {
        return finalPath(request.tenantId(), request.principalId(), request.requestId());
    }

    private Path confined(String fileName) {
        if (!NAME.matcher(fileName.substring(0, 64)).matches()) throw new IllegalStateException("invalid object name");
        Path resolved = root.resolve(fileName).normalize();
        if (!root.equals(resolved.getParent())) throw new IllegalStateException("destination path escaped its root");
        if (Files.isSymbolicLink(resolved)) throw new IllegalStateException("destination object must not be a symbolic link");
        verifyPrivatePermissions(resolved);
        return resolved;
    }

    /** Preflight is effect-free, so a permission failure here is a known UNAVAILABLE result. */
    @Override
    public void preflight(ExportRequest request) {
        if (!supportsPrivateFilePermissions(root)) {
            throw new IllegalStateException("destination does not support owner-only file permissions");
        }
        finalPath(request);
        partPath(request);
    }

    private static void verifyPrivatePermissions(Path path) {
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return;
        try {
            if (!Files.getPosixFilePermissions(path, LinkOption.NOFOLLOW_LINKS).equals(PRIVATE_FILE_PERMISSIONS)) {
                throw new IllegalStateException("destination object permissions must be owner-only");
            }
        } catch (IOException | UnsupportedOperationException failure) {
            throw new IllegalStateException("destination object permissions cannot be verified", failure);
        }
    }

    @Override
    public FencedChunkReceipt sendChunk(ExportRequest request, int offset, byte[] chunk, String chunkDigest,
                                        TransferAuthorization authorization,
                                        DeliveryOperationStore.DispatchClaim claim) {
        requireCurrentClaim(request, claim);
        if (authorization == null || !authorization.requestId().equals(request.requestId())
                || !authorization.destinationRef().equals(request.destinationRef())) {
            throw new IllegalStateException("transfer authorization does not match this destination write");
        }
        if (!MediaCreationContracts.sha256(chunk).equals(chunkDigest)) {
            throw new IllegalStateException("chunk digest does not match chunk bytes");
        }
        byte[] artifact = request.artifact().bytes();
        if (offset < 0 || offset + chunk.length > artifact.length
                || !Arrays.equals(chunk, Arrays.copyOfRange(artifact, offset, offset + chunk.length))) {
            throw new IllegalStateException("chunk is not the exact artifact range");
        }
        try {
            Path object = finalPath(request);
            Path part = partPath(request);
            if (Files.exists(object, LinkOption.NOFOLLOW_LINKS)) {
                // Write-once: an existing object is only acceptable as a byte-identical replay.
                verifyRange(object, offset, chunk);
            } else {
                long staged = Files.exists(part, LinkOption.NOFOLLOW_LINKS) ? Files.size(part) : 0L;
                if (staged < offset) throw new IllegalStateException("destination staging is behind the offset");
                if (staged > offset) {
                    verifyRange(part, offset, chunk);
                } else {
                    try (FileChannel channel = FileChannel.open(part,
                            Set.of(StandardOpenOption.CREATE, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS),
                            PosixFilePermissions.asFileAttribute(PRIVATE_FILE_PERMISSIONS))) {
                        channel.position(offset);
                        ByteBuffer buffer = ByteBuffer.wrap(chunk);
                        while (buffer.hasRemaining()) channel.write(buffer);
                        channel.force(true);
                    }
                }
                if (offset + chunk.length == artifact.length) {
                    Files.move(part, object, StandardCopyOption.ATOMIC_MOVE);
                }
            }
        } catch (IOException failure) {
            throw new IllegalStateException("destination write failed", failure);
        }
        ChunkReceipt receipt = new ChunkReceipt(
                "dev-local-directory-chunk:" + objectName(request.tenantId(), request.principalId(), request.requestId())
                        + ":" + offset,
                request.tenantId(), request.principalId(), request.requestId(), request.artifact().artifactId(),
                request.artifact().versionRef(), request.destinationRef(), request.artifact().digest(),
                offset, chunkDigest, chunk.length, offset + chunk.length);
        return new FencedChunkReceipt(receipt, claim.fence());
    }

    /**
     * Independent readback. The receipt carries the checksum of the bytes found on disk now, whatever they
     * are; the engine, not this adapter, decides whether that equals the artifact digest.
     */
    @Override
    public FencedReconciliation reconcile(ExportRequest request, DeliveryOperationStore.DispatchClaim claim) {
        requireCurrentClaim(request, claim);
        byte[] artifact = request.artifact().bytes();
        try {
            Path object = finalPath(request);
            Path part = partPath(request);
            if (!Files.exists(object, LinkOption.NOFOLLOW_LINKS) && Files.exists(part, LinkOption.NOFOLLOW_LINKS)) {
                long staged = Files.size(part);
                int comparable = (int) Math.min(staged, artifact.length);
                byte[] prefix = readPrefix(part, comparable);
                if (!Arrays.equals(prefix, Arrays.copyOf(artifact, comparable))) {
                    Files.delete(part); // our own staging file holds foreign bytes; restart it
                    return new FencedReconciliation(0, Optional.empty(), claim.fence());
                }
                if (staged == artifact.length) {
                    Files.move(part, object, StandardCopyOption.ATOMIC_MOVE);
                } else {
                    int verified = (int) (staged - staged % MediaDeliveryEngine.CHUNK_BYTES);
                    return new FencedReconciliation(verified, Optional.empty(), claim.fence());
                }
            }
            if (!Files.exists(object, LinkOption.NOFOLLOW_LINKS)) {
                return new FencedReconciliation(0, Optional.empty(), claim.fence());
            }
            long size = Files.size(object);
            if (size != artifact.length) {
                throw new IllegalStateException("destination object size differs from the artifact length");
            }
            byte[] stored = Files.readAllBytes(object);
            String checksum = MediaCreationContracts.sha256(stored);
            DestinationReceipt receipt = new DestinationReceipt(
                    "dev-local-directory-receipt:" + objectName(request.tenantId(), request.principalId(),
                            request.requestId()) + ":" + checksum.substring("sha256:".length(), "sha256:".length() + 16),
                    request.tenantId(), request.principalId(), request.requestId(), request.artifact().artifactId(),
                    request.artifact().versionRef(), request.artifact().digest(), request.destinationRef(),
                    stored.length, checksum);
            return new FencedReconciliation(stored.length,
                    Optional.of(new FencedDestinationReceipt(receipt, claim.fence())), claim.fence());
        } catch (IOException failure) {
            throw new IllegalStateException("destination readback failed", failure);
        }
    }

    private void requireCurrentClaim(ExportRequest request, DeliveryOperationStore.DispatchClaim claim) {
        if (claim == null || !claim.requestId().equals(request.requestId())
                || !claim.tenantId().equals(request.tenantId())
                || !claim.principalId().equals(request.principalId())
                || !claim.destinationRef().equals(request.destinationRef())
                || !operations.isDispatchClaimCurrent(claim)) {
            throw new IllegalStateException("stale or foreign dispatch fence rejected by destination");
        }
    }

    private static void verifyRange(Path file, long offset, byte[] expected) throws IOException {
        try (FileChannel channel = FileChannel.open(file, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            if (channel.size() < offset + expected.length) {
                throw new IllegalStateException("destination object is shorter than the replayed chunk");
            }
            ByteBuffer buffer = ByteBuffer.allocate(expected.length);
            channel.position(offset);
            while (buffer.hasRemaining()) if (channel.read(buffer) < 0) break;
            if (!Arrays.equals(buffer.array(), expected)) {
                throw new IllegalStateException("destination object differs from the replayed chunk");
            }
        }
    }

    private static byte[] readPrefix(Path file, int length) throws IOException {
        try (FileChannel channel = FileChannel.open(file, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            ByteBuffer buffer = ByteBuffer.allocate(length);
            while (buffer.hasRemaining()) if (channel.read(buffer) < 0) break;
            return buffer.array();
        }
    }

}
