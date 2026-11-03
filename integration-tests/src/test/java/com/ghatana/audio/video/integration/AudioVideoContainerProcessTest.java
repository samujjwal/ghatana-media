package com.ghatana.audio.video.integration;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

@Tag("integration")
class AudioVideoContainerProcessTest {
    @TempDir Path tempDir;

    private static final String PINNED_STT_IMAGE = "ghatana/stt-service@sha256:" + "a".repeat(64);

    @Test
    void mutableTagsAreNotPinnedImageProof() {
        assertThat(IntegrationImagesCondition.isPinnedDigest("ghatana/stt-service:latest")).isFalse();
        assertThat(IntegrationImagesCondition.isPinnedDigest("ghatana/stt-service:1.2.3")).isFalse();
        assertThat(IntegrationImagesCondition.isPinnedDigest(PINNED_STT_IMAGE)).isTrue();
        assertThat(IntegrationImagesCondition.isPinnedDigest("ghatana/stt-service@sha256:" + "A".repeat(64)))
                .isFalse();
    }

    @Test
    void localInspectionMustReportTheExactSelectedRepositoryDigest() {
        assertThat(IntegrationImagesCondition.reportsExactDigest(PINNED_STT_IMAGE,
                "[\"" + PINNED_STT_IMAGE + "\"]")).isTrue();
        assertThat(IntegrationImagesCondition.reportsExactDigest(PINNED_STT_IMAGE,
                "[\"ghatana/stt-service@sha256:" + "b".repeat(64) + "\"]")).isFalse();
        assertThat(IntegrationImagesCondition.reportsExactDigest(PINNED_STT_IMAGE, "[]")).isFalse();
        assertThat(IntegrationImagesCondition.reportsExactDigest(PINNED_STT_IMAGE,
                "{\"diagnostic\":\"" + PINNED_STT_IMAGE + "\"}")).isFalse();
        assertThat(IntegrationImagesCondition.reportsExactDigest(PINNED_STT_IMAGE,
                "[\"" + PINNED_STT_IMAGE + "\",{}]")).isFalse();
        assertThat(IntegrationImagesCondition.reportsExactDigest(PINNED_STT_IMAGE,
                "[\"" + PINNED_STT_IMAGE + "\"]\n\"" + PINNED_STT_IMAGE + "\"")).isFalse();
        assertThat(IntegrationImagesCondition.reportsExactDigest(PINNED_STT_IMAGE, "not-json " + PINNED_STT_IMAGE))
                .isFalse();
        assertThat(IntegrationImagesCondition.reportsExactDigest(
                "ghatana/stt-service:latest", "[\"ghatana/stt-service:latest\"]")).isFalse();
    }

    @Test
    void interruptedBoundedCommandStopsItsChildProcesses() throws Exception {
        Path pidFile = tempDir.resolve("compose-command-child.pid");
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread worker = new Thread(() -> {
            try {
                AudioVideoContainerBase.runCommand(List.of("/bin/sh", "-c",
                        "sleep 30 & echo $! > \"$1\"; wait", "compose-cleanup-test", pidFile.toString()));
            } catch (Throwable thrown) {
                failure.set(thrown);
            }
        });
        worker.start();
        long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        while (!Files.exists(pidFile) && System.nanoTime() < deadline) Thread.sleep(10);
        assertThat(pidFile).exists();
        long childPid = Long.parseLong(Files.readString(pidFile).trim());
        worker.interrupt();
        worker.join(5_000);
        assertThat(worker.isAlive()).isFalse();
        assertThat(failure.get()).isInstanceOf(IllegalStateException.class).hasMessageContaining("interrupted");
        long exitDeadline = System.nanoTime() + Duration.ofSeconds(2).toNanos();
        while (ProcessHandle.of(childPid).map(ProcessHandle::isAlive).orElse(false)
                && System.nanoTime() < exitDeadline) Thread.sleep(20);
        assertThat(ProcessHandle.of(childPid).map(ProcessHandle::isAlive).orElse(false)).isFalse();
    }

    @Test
    void interruptedDownStillAttemptsRmAndRestoresInterruptStatus() {
        AtomicReference<Integer> calls = new AtomicReference<>(0);
        try {
            boolean clean = AudioVideoContainerBase.cleanupProject("test-project", Path.of("compose.yml"),
                    AudioVideoContainerBase.STT_SERVICE, (command, timeout) -> {
                        int invocation = calls.getAndSet(calls.get() + 1);
                        if (invocation == 0) {
                            assertThat(command).contains("down");
                            assertThat(timeout).isEqualTo(Duration.ofSeconds(8));
                            Thread.currentThread().interrupt();
                        } else {
                            assertThat(command).contains("rm", AudioVideoContainerBase.STT_SERVICE);
                            assertThat(Thread.currentThread().isInterrupted()).isFalse();
                        }
                        return new AudioVideoContainerBase.CommandResult(command, 0, false, "", Duration.ZERO);
                    });
            assertThat(clean).isTrue();
            assertThat(calls.get()).isEqualTo(2);
            assertThat(Thread.currentThread().isInterrupted()).isTrue();
        } finally {
            Thread.interrupted();
        }
    }
}
