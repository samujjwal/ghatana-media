package com.ghatana.audio.video.vision.video;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.EnumSet;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class HostOciVisionWorkerSupervisorTest {
    private static final String IMAGE = "registry.example/media/vision-worker@sha256:" + "a".repeat(64);
    private static final String INVOCATION = "00000000-0000-0000-0000-000000000001";

    @TempDir Path temporaryDirectory;

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

    private Path privateDirectory(String name) throws IOException {
        Path directory = Files.createDirectory(temporaryDirectory.resolve(name));
        Files.setPosixFilePermissions(directory, EnumSet.of(
                PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE,
                PosixFilePermission.OWNER_EXECUTE));
        return directory.toRealPath();
    }
}
