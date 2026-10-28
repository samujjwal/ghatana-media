package com.ghatana.audio.video.vision.video;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Assumptions;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class LinuxVisionWorkerSandboxTest {
    @Test
    void locatesCodecWorkspaceUnderCanonicalTemporaryDirectory() throws Exception {
        Path workspace = VideoFrameExtractor.createPrivateWorkspace();
        Path input = workspace.resolve("input.mp4");
        try {
            Files.writeString(input, "private fixture");
            assertThat(LinuxVisionWorkerSandbox.workspaceFor(List.of("ffprobe", "-i", input.toString())))
                    .isEqualTo(workspace);
        } finally {
            Files.deleteIfExists(input);
            Files.deleteIfExists(workspace);
        }
    }

    @Test
    void onlyFfmpegAndFfprobeEnterTheNativeWorkerBoundary() {
        assertThat(LinuxVisionWorkerSandbox.isCodecCommand(List.of("ffmpeg", "-version"))).isTrue();
        assertThat(LinuxVisionWorkerSandbox.isCodecCommand(List.of("/opt/media/ffprobe", "input.mp4"))).isTrue();
        assertThat(LinuxVisionWorkerSandbox.isCodecCommand(List.of("sh", "-c", "ffmpeg"))).isFalse();
        assertThat(LinuxVisionWorkerSandbox.isCodecCommand(List.of("ffmpeg-wrapper", "input.mp4"))).isFalse();
    }

    @Test
    void nonLinuxArmHostsFailClosedBeforeStartingACodecProcess() {
        if (LinuxVisionWorkerSandbox.requiresSandboxHost()) return;
        assertThatThrownBy(() -> LinuxVisionWorkerSandbox.prepare(List.of("ffmpeg", "-version"), Path.of("/tmp")))
                .isInstanceOf(IOException.class)
                .hasMessageContaining("bounded Linux ARM64 workers are required");
    }

    @Test
    void codecWorkerEnvironmentDropsInheritedCredentialsAndLoaderOverrides() {
        var environment = LinuxVisionWorkerSandbox.workerEnvironment(Path.of("/work/request"));
        assertThat(environment).containsOnlyKeys("PATH", "LANG", "LC_ALL", "HOME", "TMPDIR")
                .containsEntry("HOME", "/work/request")
                .containsEntry("TMPDIR", "/work/request")
                .doesNotContainKey("AWS_SECRET_ACCESS_KEY")
                .doesNotContainKey("MEDIA_POSTGRES_PASSWORD")
                .doesNotContainKey("LD_PRELOAD")
                .doesNotContainKey("LD_LIBRARY_PATH");
    }

    @Test
    void linuxArm64RefusesCodecLaunchWhenNoDelegatedCgroupIsConfigured() throws Exception {
        Assumptions.assumeTrue(LinuxVisionWorkerSandbox.requiresSandboxHost());
        Assumptions.assumeTrue(System.getenv("GHATANA_MEDIA_VISION_CGROUP_ROOT") == null);
        assertThatThrownBy(() -> LinuxVisionWorkerSandbox.prepare(List.of("ffmpeg", "-version"), Path.of("/tmp")))
                .isInstanceOf(IOException.class)
                .hasMessageContaining("delegated cgroup v2 root is not configured");
    }
}
