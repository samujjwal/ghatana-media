package com.ghatana.audio.video.vision.video;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Server-side admission policy for the authenticated OCI broker. Every check is
 * enforced inside the broker process; callers supply only the bounded launch
 * description. Images must be digest-pinned AND on the operator's allowlist,
 * uid/gid must equal the operator-pinned worker identity, worker arguments are
 * a fixed codec shape (no URLs, escapes, or dangerous ffmpeg options), the
 * source must be an owned regular file inside the source root whose bytes match
 * the claimed digest, and each request carries a fresh timestamp and a nonce
 * that has never been seen before.
 */
final class MediaOciBrokerPolicy {

    static final int MAX_NONCE_CACHE = 65_536;
    static final long MAX_REQUEST_SKEW_MS = Duration.ofMinutes(5).toMillis();
    static final int MAX_ARG_LENGTH = 512;

    /** ffmpeg/ffprobe flags that escape the sandboxed codec shape. */
    private static final Set<String> FORBIDDEN_WORKER_FLAGS = Set.of(
            "-filter_script", "-filter_complex_script", "-filter:script",
            "-vstats_file", "-sdp_file", "-hls_playlist", "-scp", "-sftp",
            "-dump_attachment", "-allow", "-pre", "-fpre", "-override_ffserver",
            "-reconnect", "-reconnect_at_eof", "-reconnect_streamed");

    private MediaOciBrokerPolicy() { }

    /** Operator-pinned server policy; all values come from broker-owned configuration. */
    record Policy(
            Set<String> allowedImageDigests,
            long workerUid,
            long workerGid,
            Path sourceRoot,
            Path outputRoot) { }

    /** Bounded replay window: each nonce is valid at most once inside a timestamp skew. */
    static final class NonceReplayGuard {
        private final Map<String, Boolean> seen = new LinkedHashMap<>() {
            @Override protected boolean removeEldestEntry(Map.Entry<String, Boolean> eldest) {
                return size() > MAX_NONCE_CACHE;
            }
        };

        synchronized boolean admit(String nonce, long timestampMs, long now) {
            if (Math.abs(now - timestampMs) > MAX_REQUEST_SKEW_MS) return false;
            return nonce != null && nonce.length() >= 16 && nonce.length() <= 128
                    && seen.putIfAbsent(nonce, Boolean.TRUE) == null;
        }
    }

    /** The caller-described worker must be exactly one server-approved shape. */
    static boolean imageAllowed(Policy policy, String image) {
        return image != null && policy.allowedImageDigests().contains(image);
    }

    static boolean workerIdentityAllowed(Policy policy, long uid, long gid) {
        return uid == policy.workerUid() && gid == policy.workerGid();
    }

    /**
     * Codec worker arguments: bounded length, no network URLs, no parent traversal,
     * no forbidden flags, and absolute paths only under the sandbox mount points.
     */
    static boolean workerArgsAllowed(List<String> args) {
        for (String arg : args) {
            if (arg == null || arg.isBlank() || arg.length() > MAX_ARG_LENGTH
                    || arg.chars().anyMatch(Character::isISOControl)) return false;
            if (arg.contains("://") || arg.contains("..")) return false;
            if (FORBIDDEN_WORKER_FLAGS.contains(arg)) return false;
            if (arg.startsWith("/") && !arg.startsWith("/source/")
                    && !arg.startsWith("/output/") && !arg.startsWith("/tmp/")) {
                return false;
            }
        }
        return true;
    }

    /**
     * The source must be an unlinked regular file inside the source root, owned by the
     * pinned worker uid/gid, with bytes matching the digest the caller pinned at submit.
     */
    static boolean sourceAllowed(Policy policy, String source, String sourceSha256)
            throws IOException {
        if (source == null) return true;
        if (sourceSha256 == null || !sourceSha256.matches("[0-9a-f]{64}")) return false;
        Path literal = Path.of(source);
        if (Files.isSymbolicLink(literal)) return false;
        Path resolved = literal.toRealPath();
        if (!resolved.startsWith(policy.sourceRoot()) || !Files.isRegularFile(resolved)) {
            return false;
        }
        try {
            Object uid = Files.getAttribute(resolved, "unix:uid", LinkOption.NOFOLLOW_LINKS);
            Object gid = Files.getAttribute(resolved, "unix:gid", LinkOption.NOFOLLOW_LINKS);
            if (!(uid instanceof Number ownerUid) || !(gid instanceof Number ownerGid)
                    || ownerUid.longValue() != policy.workerUid()
                    || ownerGid.longValue() != policy.workerGid()) {
                return false;
            }
        } catch (UnsupportedOperationException | IllegalArgumentException unsupported) {
            return false;
        }
        String actual = sha256File(resolved);
        return MessageDigest.isEqual(actual.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                sourceSha256.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    static boolean outputAllowed(Policy policy, String output) throws IOException {
        if (output == null) return true;
        Path literal = Path.of(output);
        if (Files.isSymbolicLink(literal)) return false;
        Path resolved = literal.toRealPath();
        return resolved.startsWith(policy.outputRoot()) && Files.isDirectory(resolved);
    }

    /** Credential material must never be group/other readable. */
    static boolean ownerOnlyFile(Path file) throws IOException {
        try {
            Set<java.nio.file.attribute.PosixFilePermission> perms =
                    Files.getPosixFilePermissions(file);
            return perms.equals(PosixFilePermissions.fromString("rw-------"));
        } catch (UnsupportedOperationException unsupported) {
            return false;
        }
    }

    private static String sha256File(Path file) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (var in = Files.newInputStream(file)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) >= 0) digest.update(buffer, 0, read);
            }
            return java.util.HexFormat.of().formatHex(digest.digest());
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }
}
