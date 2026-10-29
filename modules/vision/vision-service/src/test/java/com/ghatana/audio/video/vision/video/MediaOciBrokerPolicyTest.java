package com.ghatana.audio.video.vision.video;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** Server-side broker policy negatives; no Docker or socket required. */
class MediaOciBrokerPolicyTest {

    @TempDir Path root;

    private MediaOciBrokerPolicy.Policy policy() throws Exception {
        Path real = root.toRealPath();
        return new MediaOciBrokerPolicy.Policy(
                Set.of("worker@sha256:" + "a".repeat(64)),
                uidOf(root), gidOf(root), real, real);
    }

    private static long uidOf(Path path) throws Exception {
        return ((Number) Files.getAttribute(path, "unix:uid")).longValue();
    }

    private static long gidOf(Path path) throws Exception {
        return ((Number) Files.getAttribute(path, "unix:gid")).longValue();
    }

    @Test
    void imageMustBeOnTheServerAllowlist() throws Exception {
        var policy = policy();
        assertThat(MediaOciBrokerPolicy.imageAllowed(policy, "worker@sha256:" + "a".repeat(64))).isTrue();
        assertThat(MediaOciBrokerPolicy.imageAllowed(policy, "worker@sha256:" + "b".repeat(64))).isFalse();
        assertThat(MediaOciBrokerPolicy.imageAllowed(policy, "evil:latest")).isFalse();
        assertThat(MediaOciBrokerPolicy.imageAllowed(policy, null)).isFalse();
    }

    @Test
    void workerIdentityMustEqualThePinnedUidGid() throws Exception {
        var policy = policy();
        assertThat(MediaOciBrokerPolicy.workerIdentityAllowed(
                policy, policy.workerUid(), policy.workerGid())).isTrue();
        assertThat(MediaOciBrokerPolicy.workerIdentityAllowed(policy, 0, 0)).isFalse();
        assertThat(MediaOciBrokerPolicy.workerIdentityAllowed(
                policy, policy.workerUid() + 1, policy.workerGid())).isFalse();
    }

    @Test
    void workerArgsRejectUrlsTraversalAndDangerousFlags() {
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed(List.of(
                "-nostdin", "-hide_banner", "-loglevel", "error",
                "-i", "/source/input", "-y", "/output/result.out"))).isTrue();
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed(List.of("-i", "http://evil/x"))).isFalse();
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed(List.of("-i", "s3://bucket/x"))).isFalse();
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed(List.of("-i", "/source/../../etc/passwd"))).isFalse();
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed(List.of("-i", "/etc/passwd"))).isFalse();
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed(List.of("-filter_script", "/tmp/x"))).isFalse();
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed(List.of("-sdp_file", "/output/x"))).isFalse();
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed(List.of("x".repeat(600)))).isFalse();
    }

    @Test
    void nonceReplayIsRejectedAndTimestampMustBeCurrent() {
        var guard = new MediaOciBrokerPolicy.NonceReplayGuard();
        long now = System.currentTimeMillis();
        assertThat(guard.admit("nonce-a-16-bytes-long", now, now)).isTrue();
        assertThat(guard.admit("nonce-a-16-bytes-long", now, now)).as("replay").isFalse();
        assertThat(guard.admit("nonce-b-16-bytes-long", now, now)).isTrue();
        assertThat(guard.admit("nonce-c-16-bytes-long",
                now + MediaOciBrokerPolicy.MAX_REQUEST_SKEW_MS + 1, now)).isFalse();
        assertThat(guard.admit("short", now, now)).isFalse();
    }

    @Test
    void sourceRequiresOwnershipInsideRootAndMatchingDigest() throws Exception {
        var policy = policy();
        Path source = root.resolve("input.bin");
        byte[] bytes = "verify".getBytes();
        Files.write(source, bytes);
        String sha = HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(bytes));

        assertThat(MediaOciBrokerPolicy.sourceAllowed(policy, source.toString(), sha)).isTrue();
        assertThat(MediaOciBrokerPolicy.sourceAllowed(policy, source.toString(), null)).isFalse();
        assertThat(MediaOciBrokerPolicy.sourceAllowed(policy, source.toString(),
                "b".repeat(64))).as("digest mismatch").isFalse();
        assertThat(MediaOciBrokerPolicy.sourceAllowed(policy, "/etc/hosts", sha))
                .as("outside source root").isFalse();
        Path link = root.resolve("link.bin");
        Files.createSymbolicLink(link, source);
        assertThat(MediaOciBrokerPolicy.sourceAllowed(policy, link.toString(), sha))
                .as("symlink").isFalse();
        assertThat(MediaOciBrokerPolicy.sourceAllowed(policy, null, null)).isTrue();
    }

    @Test
    void credentialFileMustBeOwnerOnly() throws Exception {
        Path token = root.resolve("token");
        Files.writeString(token, "x".repeat(64));
        Files.setPosixFilePermissions(token, java.util.Set.of(
                java.nio.file.attribute.PosixFilePermission.OWNER_READ,
                java.nio.file.attribute.PosixFilePermission.OWNER_WRITE));
        assertThat(MediaOciBrokerPolicy.ownerOnlyFile(token)).isTrue();
        Files.setPosixFilePermissions(token, java.util.Set.of(
                java.nio.file.attribute.PosixFilePermission.OWNER_READ,
                java.nio.file.attribute.PosixFilePermission.OWNER_WRITE,
                java.nio.file.attribute.PosixFilePermission.GROUP_READ));
        assertThat(MediaOciBrokerPolicy.ownerOnlyFile(token)).isFalse();
    }
}
