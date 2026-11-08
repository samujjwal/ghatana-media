package com.ghatana.audio.video.vision.video;

import com.ghatana.media.runtime.MediaDeploymentProfiles;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class HostOciVisionWorkerSupervisorTest {
    private static final String IMAGE = "registry.example/media/vision-worker@sha256:" + "a".repeat(64);
    private static final String INVOCATION = "00000000-0000-0000-0000-000000000001";

    @TempDir Path temporaryDirectory;

    @Test
    void outputVolumeCleanupAttemptsEveryResourceAndRetainsSuppressedFailures() {
        List<String> attempts = new ArrayList<>();
        IOException workerFailure = new IOException("worker removal failed");
        IOException keeperFailure = new IOException("keeper removal failed");

        assertThatThrownBy(() -> HostOciVisionWorkerSupervisor.cleanupAll(
                () -> { attempts.add("worker"); throw workerFailure; },
                () -> { attempts.add("keeper"); throw keeperFailure; },
                () -> attempts.add("volume")))
                .isSameAs(workerFailure);

        assertThat(attempts).containsExactly("worker", "keeper", "volume");
        assertThat(workerFailure.getSuppressed()).containsExactly(keeperFailure);
    }

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
    void brokerRequirementUsesCanonicalProductionProfilesAndExplicitOverride() {
        for (String profile : List.of("prod", "production", "staging", "sovereign", "integration", "e2e")) {
            assertThat(HostOciVisionWorkerSupervisor.brokerRequired(
                    Map.of("MEDIA_RUNTIME_ENVIRONMENT", profile))).as(profile).isTrue();
        }

        assertThat(HostOciVisionWorkerSupervisor.brokerRequired(Map.of("MEDIA_PROFILE", "production")))
                .as("profile fallback is production-like").isTrue();
        assertThat(HostOciVisionWorkerSupervisor.brokerRequired(Map.of("MEDIA_PROFILE", "local")))
                .as("MEDIA_PROFILE is used when runtime environment is absent").isFalse();
        assertThat(HostOciVisionWorkerSupervisor.brokerRequired(Map.of("MEDIA_RUNTIME_ENVIRONMENT", "local")))
                .as("explicit local profile keeps direct worker available").isFalse();
        assertThat(HostOciVisionWorkerSupervisor.brokerRequired(Map.of(
                "MEDIA_RUNTIME_ENVIRONMENT", "", "MEDIA_PROFILE", "local")))
                .as("present blank runtime environment suppresses fallback and forbids direct OCI")
                .isTrue();
        assertThat(MediaDeploymentProfiles.productionLike("prodution"))
                .as("unknown typo is not classified as production").isFalse();
        assertThat(HostOciVisionWorkerSupervisor.brokerRequired(Map.of("MEDIA_RUNTIME_ENVIRONMENT", "prodution")))
                .as("unknown profile forbids direct OCI fallback").isTrue();
        assertThat(HostOciVisionWorkerSupervisor.brokerRequired(Map.of(
                "MEDIA_RUNTIME_ENVIRONMENT", "local",
                HostOciVisionWorkerSupervisor.BROKER_REQUIRED_ENV, "true")))
                .as("explicit true override").isTrue();
        assertThat(HostOciVisionWorkerSupervisor.brokerRequired(Map.of(
                "MEDIA_RUNTIME_ENVIRONMENT", "local",
                HostOciVisionWorkerSupervisor.BROKER_REQUIRED_ENV, "1")))
                .as("explicit 1 override").isTrue();
        assertThat(HostOciVisionWorkerSupervisor.brokerRequired(Map.of(
                "MEDIA_RUNTIME_ENVIRONMENT", "local",
                HostOciVisionWorkerSupervisor.BROKER_REQUIRED_ENV, "yes")))
                .as("malformed nonempty override forbids direct OCI fallback").isTrue();
        assertThat(HostOciVisionWorkerSupervisor.brokerRequired(Map.of(
                "MEDIA_RUNTIME_ENVIRONMENT", "local",
                HostOciVisionWorkerSupervisor.BROKER_REQUIRED_ENV, "")))
                .as("present empty override forbids direct OCI fallback").isTrue();
        assertThat(HostOciVisionWorkerSupervisor.brokerRequired(Map.of(
                "MEDIA_RUNTIME_ENVIRONMENT", "local",
                HostOciVisionWorkerSupervisor.BROKER_REQUIRED_ENV, "true ")))
                .as("whitespace malformed override forbids direct OCI fallback").isTrue();
        assertThat(HostOciVisionWorkerSupervisor.brokerRequired(Map.of(
                "MEDIA_RUNTIME_ENVIRONMENT", "prod",
                HostOciVisionWorkerSupervisor.BROKER_REQUIRED_ENV, "false")))
                .as("explicit false cannot disable production profile").isTrue();
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
                "--mount", "type=volume,source=media-vision-output-" + INVOCATION
                        + ",target=/output,volume-nocopy",
                "--entrypoint=/usr/bin/ffmpeg");
        assertThat(HostOciVisionWorkerSupervisor.outputVolumeOptions(536870912, uid, gid))
                .isEqualTo("size=536870912,uid=" + uid + ",gid=" + gid
                        + ",mode=0700,nr_inodes=4097,nosuid,nodev,noexec");
        assertThat(HostOciVisionWorkerSupervisor.outputKeeperCreateCommand(plan))
                .contains("--network=none", "--read-only", "--memory=67108864", "--memory-swap=67108864",
                        "--pids-limit=4", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
                        "type=volume,source=media-vision-output-" + INVOCATION
                                + ",target=/output,readonly,volume-nocopy")
                .doesNotContain("--privileged", "--device", "--publish");
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
    void rejectsSymlinkedRequestAndOutputPathsAndOutputTraversal() throws Exception {
        Path workspace = privateDirectory("request");
        Path source = workspace.resolve("input.mp4");
        Files.write(source, new byte[] {1});
        Files.setPosixFilePermissions(source, EnumSet.of(PosixFilePermission.OWNER_READ));
        Path outside = privateDirectory("outside");
        Path outsideFile = outside.resolve("outside.mp4");
        Files.write(outsideFile, new byte[] {2});
        Files.setPosixFilePermissions(outsideFile, EnumSet.of(PosixFilePermission.OWNER_READ));
        Path output = privateDirectory("output");
        long uid = ((Number) Files.getAttribute(source, "unix:uid")).longValue();
        long gid = ((Number) Files.getAttribute(source, "unix:gid")).longValue();

        Path sourceLink = workspace.resolve("linked.mp4");
        Files.createSymbolicLink(sourceLink, outsideFile);
        assertThatThrownBy(() -> HostOciVisionWorkerSupervisor.plan(
                List.of("ffprobe", "-i", sourceLink.toString()), workspace, null,
                IMAGE, "docker", uid, gid, INVOCATION))
                .isInstanceOf(IOException.class)
                .hasMessageContaining("inside its private request workspace");

        Path workspaceLink = temporaryDirectory.resolve("request-link");
        Files.createSymbolicLink(workspaceLink, workspace);
        assertThatThrownBy(() -> HostOciVisionWorkerSupervisor.plan(
                List.of("ffprobe", "-i", source.toString()), workspaceLink, null,
                IMAGE, "docker", uid, gid, INVOCATION))
                .isInstanceOf(IOException.class).hasMessageContaining("workspace is unsafe");

        Path outputLink = temporaryDirectory.resolve("output-link");
        Files.createSymbolicLink(outputLink, output);
        assertThatThrownBy(() -> HostOciVisionWorkerSupervisor.plan(
                List.of("ffmpeg", "-i", source.toString(), outputLink.resolve("frame.png").toString()),
                workspace, outputLink, IMAGE, "docker", uid, gid, INVOCATION))
                .isInstanceOf(IOException.class).hasMessageContaining("output directory is unsafe");

        assertThatThrownBy(() -> HostOciVisionWorkerSupervisor.plan(
                List.of("ffmpeg", "-i", source.toString(), output.resolve("../outside/frame.png").toString()),
                workspace, output, IMAGE, "docker", uid, gid, INVOCATION))
                .isInstanceOf(IOException.class).hasMessageContaining("unmounted host path");
        assertThat(Files.exists(output.resolve("frame.png"))).isFalse();
    }

    @Test
    void preflightRejectsAnyChangedKernelLimitsOrUnexpectedSocketMount() {
        String host = "{\"Memory\":1610612736,\"MemorySwap\":1610612736,\"NanoCpus\":2000000000,"
                + "\"PidsLimit\":32,\"Ulimits\":[{\"Name\":\"nofile\",\"Soft\":64,\"Hard\":64},"
                + "{\"Name\":\"fsize\",\"Soft\":536870912,\"Hard\":536870912}],"
                + "\"NetworkMode\":\"none\",\"ReadonlyRootfs\":true,\"Privileged\":false,"
                + "\"CapDrop\":[\"ALL\"],\"CapAdd\":null,\"Devices\":[],\"DeviceRequests\":null,"
                + "\"SecurityOpt\":[\"no-new-privileges:true\"],"
                + "\"Tmpfs\":{\"/tmp\":\"rw,nosuid,nodev,exec,size=128m,nr_inodes=4096\","
                + "\"/output\":\"rw,nosuid,nodev,noexec,size=536870912,nr_inodes=4097\"},"
                + "\"PublishAllPorts\":false,\"Mounts\":["
                + "{\"Type\":\"bind\",\"Source\":\"/tmp/input.mp4\",\"Target\":\"/source/input\",\"ReadOnly\":true}]}";
        String config = "{\"User\":\"501:20\",\"Entrypoint\":[\"/usr/bin/ffmpeg\"],"
                + "\"Cmd\":[\"-i\",\"/tmp/input.mp4\"],"
                + "\"Image\":\"" + IMAGE + "\","
                + "\"Env\":[\"HOME=/tmp\",\"TMPDIR=/tmp\",\"PATH=/usr/bin:/bin\","
                + "\"LANG=C.UTF-8\",\"LC_ALL=C.UTF-8\"]}";
        String mounts = "[{\"Type\":\"bind\",\"Destination\":\"/source/input\",\"ReadOnly\":true,\"Source\":\"/tmp/input.mp4\",\"RW\":false}]";
        host = host.replace("\"NetworkMode\":\"none\"", "\"NetworkMode\":\"none\",\"PortBindings\":{}");

        assertThat(HostOciVisionWorkerSupervisor.effectiveLimitsMatch(
                host + "|" + config + "|" + mounts, true, true, "501:20", "/usr/bin/ffmpeg",
                IMAGE, Path.of("/tmp/input.mp4"), Path.of("/tmp/output"), 536870912,
                List.of("-i", "/tmp/input.mp4")))
                .isTrue();
        assertThat(HostOciVisionWorkerSupervisor.effectiveLimitsMatch(
                host + "|" + config + "|" + mounts, true, true, "501:20", "/usr/bin/ffmpeg",
                IMAGE, Path.of("/tmp/input.mp4"), Path.of("/tmp/output"), 536870912,
                List.of("-i", "/tmp/other.mp4")))
                .isFalse();
        assertThat(HostOciVisionWorkerSupervisor.effectiveLimitsMatch(
                host + "|" + config.replace("\"Cmd\":[\"-i\",\"/tmp/input.mp4\"]",
                        "\"Cmd\":[\"-i\",\"/tmp/other.mp4\"]") + "|" + mounts,
                true, true, "501:20", "/usr/bin/ffmpeg", IMAGE, Path.of("/tmp/input.mp4"),
                Path.of("/tmp/output"), 536870912, List.of("-i", "/tmp/input.mp4")))
                .isFalse();
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
                host.replace("nr_inodes=4097", "nr_inodes=4096")
                        + "|" + config + "|" + mounts,
                true, true, "501:20", "/usr/bin/ffmpeg", IMAGE,
                Path.of("/tmp/input.mp4"), Path.of("/tmp/output"))).isFalse();
        assertThat(HostOciVisionWorkerSupervisor.effectiveLimitsMatch(
                host.replace("size=536870912", "size=536870911") + "|" + config + "|" + mounts,
                true, true, "501:20", "/usr/bin/ffmpeg", IMAGE,
                Path.of("/tmp/input.mp4"), Path.of("/tmp/output"), 536870912,
                List.of("-i", "/tmp/input.mp4"))).isFalse();
    }

    @Test
    void preflightRequiresTheInvocationScopedBoundedTmpfsVolumeAndRejectsPersistentOrWrongVolumes() {
        String volume = "media-vision-output-" + INVOCATION;
        String host = "{\"Memory\":1610612736,\"MemorySwap\":1610612736,\"NanoCpus\":2000000000,"
                + "\"PidsLimit\":32,\"Ulimits\":[{\"Name\":\"nofile\",\"Soft\":64,\"Hard\":64},"
                + "{\"Name\":\"fsize\",\"Soft\":536870912,\"Hard\":536870912}],"
                + "\"NetworkMode\":\"none\",\"ReadonlyRootfs\":true,\"Privileged\":false,"
                + "\"CapDrop\":[\"ALL\"],\"CapAdd\":null,\"Devices\":[],\"DeviceRequests\":null,"
                + "\"SecurityOpt\":[\"no-new-privileges:true\"],\"Tmpfs\":{\"/tmp\":\"rw,nosuid,nodev,exec,size=128m,nr_inodes=4096\"},"
                + "\"PortBindings\":{},\"PublishAllPorts\":false,\"Mounts\":["
                + "{\"Type\":\"bind\",\"Source\":\"/tmp/input.mp4\",\"Target\":\"/source/input\",\"ReadOnly\":true},"
                + "{\"Type\":\"volume\",\"Source\":\"" + volume + "\",\"Target\":\"/output\","
                + "\"VolumeOptions\":{\"NoCopy\":true}}]}";
        String config = "{\"User\":\"501:20\",\"Entrypoint\":[\"/usr/bin/ffmpeg\"],"
                + "\"Cmd\":[\"-i\",\"/source/input\"],\"Image\":\"" + IMAGE + "\","
                + "\"Env\":[\"HOME=/tmp\",\"TMPDIR=/tmp\",\"PATH=/usr/bin:/bin\",\"LANG=C.UTF-8\",\"LC_ALL=C.UTF-8\"]}";
        String mounts = "[{\"Type\":\"bind\",\"Destination\":\"/source/input\",\"ReadOnly\":true,"
                + "\"Source\":\"/tmp/input.mp4\",\"RW\":false},{\"Type\":\"volume\",\"Name\":\""
                + volume + "\",\"Destination\":\"/output\",\"RW\":true}]";
        String inspection = host + "|" + config + "|" + mounts;

        assertThat(HostOciVisionWorkerSupervisor.effectiveVolumeLimitsMatch(inspection,
                true, true, "501:20", "/usr/bin/ffmpeg", IMAGE,
                Path.of("/tmp/input.mp4"), Path.of("/tmp/output"), 536870912,
                List.of("-i", "/source/input"), volume)).isTrue();
        assertThat(HostOciVisionWorkerSupervisor.effectiveVolumeLimitsMatch(inspection,
                true, true, "501:20", "/usr/bin/ffmpeg", IMAGE,
                Path.of("/tmp/input.mp4"), Path.of("/tmp/output"), 536870912,
                List.of("-i", "/source/input"), volume + "-other")).isFalse();
        assertThat(HostOciVisionWorkerSupervisor.effectiveVolumeLimitsMatch(
                inspection.replace("\"Type\":\"volume\"", "\"Type\":\"bind\""),
                true, true, "501:20", "/usr/bin/ffmpeg", IMAGE,
                Path.of("/tmp/input.mp4"), Path.of("/tmp/output"), 536870912,
                List.of("-i", "/source/input"), volume)).isFalse();
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
        assertThat(((Number) Files.getAttribute(output, "unix:mode")).intValue() & 07777).isEqualTo(02770);
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
