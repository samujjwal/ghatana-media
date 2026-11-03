package com.ghatana.audio.video.vision.video;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.util.EnumSet;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class HostOciVisionWorkerSupervisorTest {
    private static final String IMAGE = "registry.example/media/vision-worker@sha256:" + "a".repeat(64);
    private static final String INVOCATION = "00000000-0000-0000-0000-000000000001";

    @TempDir Path temporaryDirectory;

    @Test
    void productionCompositionCanRequireTheBrokerAndDirectFallbackGuardIsFailClosed() throws Exception {
        assertThat(new VideoFrameExtractor(true).requiresAuthenticatedBroker()).isTrue();
        assertThat(new VideoFrameExtractor(false).requiresAuthenticatedBroker())
                .isEqualTo(HostOciVisionWorkerSupervisor.brokerRequired());

        assertThatThrownBy(() -> HostOciVisionWorkerSupervisor.requireBrokerConfigured(true, false))
                .isInstanceOf(IOException.class)
                .hasMessageContaining("authenticated OCI broker is required and unconfigured");
        HostOciVisionWorkerSupervisor.requireBrokerConfigured(false, false);
        HostOciVisionWorkerSupervisor.requireBrokerConfigured(true, true);
    }

    @Test
    void brokerTerminalFlagsCannotBeLostByTheProcessAdapter() {
        var oom = HostOciVisionWorkerSupervisor.toProcessResult(
                new MediaOciBroker.WorkerResult(true, 0, false, true, false, "oom"), 128);
        assertThat(oom.exitCode()).isEqualTo(137);
        assertThat(oom.timedOut()).isFalse();

        var incomplete = HostOciVisionWorkerSupervisor.toProcessResult(
                new MediaOciBroker.WorkerResult(false, 0, false, false, false, "incomplete"), 128);
        assertThat(incomplete.exitCode()).isEqualTo(-1);
        assertThat(incomplete.timedOut()).isFalse();

        var exceeded = HostOciVisionWorkerSupervisor.toProcessResult(
                new MediaOciBroker.WorkerResult(true, 0, false, false, true, "bounded tail"), 4);
        assertThat(exceeded.exitCode()).isZero();
        assertThat(exceeded.outputExceeded()).isTrue();
        assertThat(exceeded.output()).isEqualTo("tail");
    }

    @Test
    void launchPlanPinsTheWorkerAndLimitsItToPrivateSourceAndOutputMounts() throws Exception {
        Path workspace = privateDirectory("request");
        Path source = workspace.resolve("input.mp4");
        Files.write(source, new byte[] {1, 2, 3});
        Files.setPosixFilePermissions(source, EnumSet.of(PosixFilePermission.OWNER_READ));
        Path output = privateDirectory("output");
        long uid = ((Number) Files.getAttribute(source, "unix:uid")).longValue();
        long gid = ((Number) Files.getAttribute(source, "unix:gid")).longValue();

        var plan = HostOciVisionWorkerSupervisor.plan(
                List.of("ffmpeg", "-nostdin", "-i", source.toString(), output.resolve("frame_%04d.jpg").toString(), "-n"),
                workspace, output, IMAGE, "/usr/local/bin/docker", uid, gid, INVOCATION);

        assertThat(plan.imageDigest()).isEqualTo(IMAGE);
        assertThat(plan.createCommand()).contains(
                "--pull=never", "--platform=linux/arm64", "--memory=1610612736",
                "--memory-swap=1610612736", "--cpus=2", "--pids-limit=32", "--ulimit=nofile=64:64",
                "--ulimit=fsize=536870912:536870912", "--network=none",
                "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
                "--tmpfs", "/tmp:rw,nosuid,nodev,exec,size=128m,nr_inodes=4096", "--user=" + uid + ":" + gid,
                "--mount", "type=bind,source=" + source + ",target=/source/input,readonly",
                "--mount", "type=bind,source=" + output + ",target=/output", "--entrypoint=/usr/bin/ffmpeg");
        assertThat(plan.createCommand()).contains("/source/input", "/output/frame_%04d.jpg")
                .doesNotContain(source.toString(), output.toString(), "/var/run/docker.sock");
        assertThat(plan.createCommand()).doesNotContain("AWS_SECRET_ACCESS_KEY", "MEDIA_POSTGRES_PASSWORD", "DOCKER_HOST");

        var localContentAddressedPlan = HostOciVisionWorkerSupervisor.plan(
                List.of("ffprobe", "-i", source.toString()), workspace, null,
                "sha256:" + "b".repeat(64), "/usr/local/bin/docker", uid, gid, INVOCATION);
        assertThat(localContentAddressedPlan.imageDigest()).isEqualTo("sha256:" + "b".repeat(64));
    }

    @Test
    void rejectsUnpinnedImagesAndCommandsThatNameAnUnmappedHostPath() throws Exception {
        Path workspace = privateDirectory("request");
        Path source = workspace.resolve("input.mp4");
        Files.write(source, new byte[] {1});
        Files.setPosixFilePermissions(source, EnumSet.of(PosixFilePermission.OWNER_READ));
        long uid = ((Number) Files.getAttribute(source, "unix:uid")).longValue();
        long gid = ((Number) Files.getAttribute(source, "unix:gid")).longValue();

        assertThatThrownBy(() -> HostOciVisionWorkerSupervisor.plan(
                List.of("ffprobe", source.toString()), workspace, null, "registry.example/media/vision-worker:latest",
                "docker", uid, gid, INVOCATION))
                .isInstanceOf(IOException.class).hasMessageContaining("pinned by a SHA-256 digest");
        assertThatThrownBy(() -> HostOciVisionWorkerSupervisor.plan(
                List.of("ffmpeg", "-i", "/etc/passwd"), workspace, null, IMAGE, "docker", uid, gid, INVOCATION))
                .isInstanceOf(IOException.class).hasMessageContaining("inside its private request workspace");
    }

    @Test
    void preflightRejectsAnyChangedKernelLimitsOrUnexpectedSocketMount() {
        String host = "{\"Memory\":1610612736,\"MemorySwap\":1610612736,\"NanoCpus\":2000000000,"
                + "\"PidsLimit\":32,\"Ulimits\":[{\"Name\":\"nofile\",\"Soft\":64,\"Hard\":64},"
                + "{\"Name\":\"fsize\",\"Soft\":536870912,\"Hard\":536870912}],"
                + "\"NetworkMode\":\"none\",\"ReadonlyRootfs\":true,\"Privileged\":false,"
                + "\"CapDrop\":[\"ALL\"],\"CapAdd\":null,\"Devices\":[],\"DeviceRequests\":null,"
                + "\"SecurityOpt\":[\"no-new-privileges:true\"],"
                + "\"Tmpfs\":{\"/tmp\":\"rw,nosuid,nodev,exec,size=128m,nr_inodes=4096\"},"
                + "\"PublishAllPorts\":false,\"Mounts\":["
                + "{\"Type\":\"bind\",\"Source\":\"/tmp/input.mp4\",\"Target\":\"/source/input\",\"ReadOnly\":true},"
                + "{\"Type\":\"bind\",\"Source\":\"/tmp/output\",\"Target\":\"/output\"}]}";
        String config = "{\"User\":\"501:20\",\"Entrypoint\":[\"/usr/bin/ffmpeg\"],"
                + "\"Image\":\"" + IMAGE + "\","
                + "\"Env\":[\"HOME=/tmp\",\"TMPDIR=/tmp\",\"PATH=/usr/bin:/bin\","
                + "\"LANG=C.UTF-8\",\"LC_ALL=C.UTF-8\"]}";
        String mounts = "[{\"Type\":\"bind\",\"Destination\":\"/source/input\",\"ReadOnly\":true,\"Source\":\"/tmp/input.mp4\",\"RW\":false},"
                + "{\"Type\":\"bind\",\"Destination\":\"/output\",\"ReadOnly\":false,\"Source\":\"/tmp/output\",\"RW\":true}]";
        host = host.replace("\"NetworkMode\":\"none\"", "\"NetworkMode\":\"none\",\"PortBindings\":{}");

        assertThat(HostOciVisionWorkerSupervisor.effectiveLimitsMatch(
                host + "|" + config + "|" + mounts, true, true, "501:20", "/usr/bin/ffmpeg",
                IMAGE, Path.of("/tmp/input.mp4"), Path.of("/tmp/output")))
                .isTrue();
        assertThat(HostOciVisionWorkerSupervisor.effectiveLimitsMatch(
                host.replace("\"Memory\":1610612736", "\"Memory\":1610612735") + "|" + config + "|" + mounts,
                true, true, "501:20", "/usr/bin/ffmpeg", IMAGE,
                Path.of("/tmp/input.mp4"), Path.of("/tmp/output"))).isFalse();
        assertThat(HostOciVisionWorkerSupervisor.effectiveLimitsMatch(
                host.replace("\"Soft\":64", "\"Soft\":65") + "|" + config + "|" + mounts,
                true, true, "501:20", "/usr/bin/ffmpeg", IMAGE,
                Path.of("/tmp/input.mp4"), Path.of("/tmp/output"))).isFalse();
        assertThat(HostOciVisionWorkerSupervisor.effectiveLimitsMatch(
                host.replace("\"Soft\":536870912", "\"Soft\":536870911") + "|" + config + "|" + mounts,
                true, true, "501:20", "/usr/bin/ffmpeg", IMAGE,
                Path.of("/tmp/input.mp4"), Path.of("/tmp/output"))).isFalse();
        assertThat(HostOciVisionWorkerSupervisor.effectiveLimitsMatch(
                host.replace("\"Memory\":1610612736,\"MemorySwap\":1610612736",
                                "\"MemorySwap\":1610612736, \"Memory\":1610612736")
                        + "|" + config + "|" + mounts,
                true, true, "501:20", "/usr/bin/ffmpeg", IMAGE,
                Path.of("/tmp/input.mp4"), Path.of("/tmp/output"))).isTrue();
        assertThat(HostOciVisionWorkerSupervisor.effectiveLimitsMatch(
                host + "|" + config + "|" + mounts.substring(0, mounts.length() - 1)
                        + ",{\"Destination\":\"/var/run/docker.sock\",\"RW\":true}]",
                true, true, "501:20", "/usr/bin/ffmpeg", IMAGE,
                Path.of("/tmp/input.mp4"), Path.of("/tmp/output"))).isFalse();
        assertThat(HostOciVisionWorkerSupervisor.effectiveLimitsMatch(
                host + "|" + config + "|" + mounts.replace("/tmp/input.mp4", "/tmp/other.mp4"),
                true, true, "501:20", "/usr/bin/ffmpeg", IMAGE,
                Path.of("/tmp/input.mp4"), Path.of("/tmp/output"))).isFalse();
        assertThat(HostOciVisionWorkerSupervisor.effectiveLimitsMatch(
                host.replace("\"Target\":\"/source/input\",\"ReadOnly\":true",
                                "\"Target\":\"/source/input\",\"ReadOnly\":false")
                        + "|" + config + "|" + mounts,
                true, true, "501:20", "/usr/bin/ffmpeg", IMAGE,
                Path.of("/tmp/input.mp4"), Path.of("/tmp/output"))).isFalse();
        assertThat(HostOciVisionWorkerSupervisor.effectiveLimitsMatch(
                host.replace("\"Target\":\"/output\"", "\"Target\":\"/output\",\"ReadOnly\":true")
                        + "|" + config + "|" + mounts,
                true, true, "501:20", "/usr/bin/ffmpeg", IMAGE,
                Path.of("/tmp/input.mp4"), Path.of("/tmp/output"))).isFalse();
    }

    @Test
    void copiesOnlyManifestBoundFilesIntoOwnerOnlyStaging() throws Exception {
        Path brokerOutput = brokerOutputDirectory();
        Path privateOutput = privateOutputDirectory();
        byte[] content = "verified-frame".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        Files.write(brokerOutput.resolve("frame_0001.png"), content);

        HostOciVisionWorkerSupervisor.copyVerifiedBrokerOutput(brokerOutput, privateOutput,
                content.length, List.of(outputFile("frame_0001.png", content)));

        Path copied = privateOutput.resolve("frame_0001.png");
        assertThat(Files.readAllBytes(copied)).isEqualTo(content);
        assertThat(Files.getPosixFilePermissions(copied))
                .containsExactlyInAnyOrderElementsOf(PosixFilePermissions.fromString("rw-------"));
    }

    @Test
    void hashFailureRollsBackEarlierFilesFromTheSameTransfer() throws Exception {
        Path brokerOutput = brokerOutputDirectory();
        Path privateOutput = privateOutputDirectory();
        byte[] first = "first-frame".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        byte[] second = "second-frame".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        Files.write(brokerOutput.resolve("frame_0001.png"), first);
        Files.write(brokerOutput.resolve("frame_0002.png"), second);

        assertThatThrownBy(() -> HostOciVisionWorkerSupervisor.copyVerifiedBrokerOutput(
                brokerOutput, privateOutput, first.length + second.length, List.of(
                        outputFile("frame_0001.png", first),
                        new MediaOciBroker.OutputFile("frame_0002.png", second.length, "0".repeat(64)))))
                .isInstanceOf(java.io.IOException.class)
                .hasMessageContaining("hash or identity changed");

        assertThat(privateOutput.resolve("frame_0001.png")).doesNotExist();
        assertThat(privateOutput.resolve("frame_0002.png")).doesNotExist();
    }

    @Test
    void rejectsSymlinkedBrokerEntriesAndPreservesDestinationCollisions() throws Exception {
        Path brokerOutput = brokerOutputDirectory();
        Path privateOutput = privateOutputDirectory();
        byte[] content = "frame-bytes".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        Path outside = temporaryDirectory.resolve("outside.bin");
        Files.write(outside, content);
        Files.createSymbolicLink(brokerOutput.resolve("frame.png"), outside);

        assertThatThrownBy(() -> HostOciVisionWorkerSupervisor.copyVerifiedBrokerOutput(
                brokerOutput, privateOutput, content.length, List.of(outputFile("frame.png", content))))
                .isInstanceOf(java.io.IOException.class)
                .hasMessageContaining("not a new regular file");
        assertThat(privateOutput.resolve("frame.png")).doesNotExist();

        Files.delete(brokerOutput.resolve("frame.png"));
        Files.write(brokerOutput.resolve("frame.png"), content);
        Path collision = privateOutput.resolve("frame.png");
        Files.writeString(collision, "keep-existing");
        assertThatThrownBy(() -> HostOciVisionWorkerSupervisor.copyVerifiedBrokerOutput(
                brokerOutput, privateOutput, content.length, List.of(outputFile("frame.png", content))))
                .isInstanceOf(java.io.IOException.class)
                .hasMessageContaining("not a new regular file");
        assertThat(Files.readString(collision)).isEqualTo("keep-existing");
    }

    private Path brokerOutputDirectory() throws Exception {
        Path sharedRoot = Files.createDirectory(temporaryDirectory.resolve("shared-output"));
        Files.setAttribute(sharedRoot, "unix:mode", 02750);
        long uid = ((Number) Files.getAttribute(sharedRoot, "unix:uid")).longValue();
        long gid = ((Number) Files.getAttribute(sharedRoot, "unix:gid")).longValue();
        Path output = HostOciVisionWorkerSupervisor.createBrokerOutputDirectory(sharedRoot, uid, gid);
        assertThat(output.getFileName().toString()).matches("media-vision-output-[a-f0-9-]{36}");
        return output;
    }

    private Path privateOutputDirectory() throws Exception {
        Path output = Files.createDirectory(temporaryDirectory.resolve("private-" + UUID.randomUUID()));
        Files.setPosixFilePermissions(output, PosixFilePermissions.fromString("rwx------"));
        return output;
    }

    private static MediaOciBroker.OutputFile outputFile(String name, byte[] bytes) throws Exception {
        return new MediaOciBroker.OutputFile(name, bytes.length,
                HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)));
    }

    private Path privateDirectory(String name) throws IOException {
        Path directory = Files.createDirectory(temporaryDirectory.resolve(name));
        Files.setPosixFilePermissions(directory, EnumSet.of(
                PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE,
                PosixFilePermission.OWNER_EXECUTE));
        return directory.toRealPath();
    }
}
