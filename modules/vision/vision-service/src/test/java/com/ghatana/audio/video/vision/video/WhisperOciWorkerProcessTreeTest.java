package com.ghatana.audio.video.vision.video;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

class WhisperOciWorkerProcessTreeTest {
    @Test
    void timeoutTerminatesTrustedCliWrapperDescendants() throws Exception {
        Assumptions.assumeTrue(Files.isExecutable(Path.of("/bin/sh")));
        Path pidFile = Files.createTempFile("whisper-cli-child-", ".pid");
        Files.deleteIfExists(pidFile);
        try {
            String script = "sleep 30 & echo $! > '" + pidFile + "'; wait";
            long startedAt = System.nanoTime();
            var result = new WhisperOciWorkerSupervisor.ProcessBuilderCommandRunner().run(
                    List.of("/bin/sh", "-c", script), null, Duration.ofMillis(500), 1024, 1024);

            assertThat(result.timedOut()).isTrue();
            assertThat(result.cleanupConfirmed()).isTrue();
            assertThat(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt))
                    .as("process termination and stream joins share one 2 s cleanup budget")
                    .isLessThan(3000L);
            assertThat(Files.exists(pidFile)).isTrue();
            long childPid = Long.parseLong(Files.readString(pidFile).trim());
            assertProcessEventuallyExits(childPid);
        } finally {
            cleanupPidFileChildren(pidFile);
            Files.deleteIfExists(pidFile);
        }
    }

    @Test
    void timeoutRescansDescendantsSpawnedByWrapperTerminationHandler() throws Exception {
        Assumptions.assumeTrue(Files.isExecutable(Path.of("/bin/sh")));
        Path pidFile = Files.createTempFile("whisper-cli-term-child-", ".pid");
        Files.deleteIfExists(pidFile);
        try {
            String escapedPath = pidFile.toString().replace("'", "'\\''");
            String script = "trap 'sleep 30 & echo $! > \"" + escapedPath
                    + "\"; sleep 0.4' TERM; sleep 30";
            var result = new WhisperOciWorkerSupervisor.ProcessBuilderCommandRunner().run(
                    List.of("/bin/sh", "-c", script), null, Duration.ofMillis(500), 1024, 1024);

            assertThat(result.timedOut()).isTrue();
            assertThat(result.cleanupConfirmed()).isTrue();
            assertThat(Files.exists(pidFile)).as("TERM handler should have forked its child").isTrue();
            long childPid = Long.parseLong(Files.readString(pidFile).trim());
            assertProcessEventuallyExits(childPid);
        } finally {
            cleanupPidFileChildren(pidFile);
            Files.deleteIfExists(pidFile);
        }
    }

    @Test
    void interruptionTerminatesDescendantsAndReturnsWithinBound() throws Exception {
        Assumptions.assumeTrue(Files.isExecutable(Path.of("/bin/sh")));
        Path pidFile = Files.createTempFile("whisper-cli-interrupt-child-", ".pid");
        Files.deleteIfExists(pidFile);
        String script = "sleep 30 & echo $! > \"" + pidFile + "\"; wait";
        AtomicReference<WhisperOciWorkerSupervisor.CommandResult> result = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread runnerThread = new Thread(() -> {
            try {
                result.set(new WhisperOciWorkerSupervisor.ProcessBuilderCommandRunner().run(
                        List.of("/bin/sh", "-c", script), null, Duration.ofSeconds(20), 1024, 1024));
            } catch (Throwable unexpected) {
                failure.set(unexpected);
            }
        }, "whisper-process-runner-interrupt-test");
        try {
            runnerThread.start();
            long pidDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
            while (!Files.exists(pidFile) && System.nanoTime() < pidDeadline) Thread.sleep(10);
            assertThat(Files.exists(pidFile)).as("wrapper child should have started before interruption").isTrue();
            long childPid = Long.parseLong(Files.readString(pidFile).trim());

            long interruptedAt = System.nanoTime();
            runnerThread.interrupt();
            runnerThread.join(TimeUnit.SECONDS.toMillis(4));

            assertThat(runnerThread.isAlive()).as("interrupted command runner must return boundedly").isFalse();
            assertThat(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - interruptedAt)).isLessThan(4000L);
            assertThat(failure.get()).isNull();
            assertThat(result.get()).isNotNull();
            assertThat(result.get().timedOut()).isTrue();
            assertThat(result.get().cleanupConfirmed()).isTrue();
            assertThat(runnerThread.isInterrupted()).as("interrupt status should be restored").isTrue();
            assertProcessEventuallyExits(childPid);
        } finally {
            runnerThread.interrupt();
            runnerThread.join(TimeUnit.SECONDS.toMillis(4));
            cleanupPidFileChildren(pidFile);
            Files.deleteIfExists(pidFile);
        }
    }

    @Test
    void childDiscoveryOverflowFailsClosedWithoutChangingOutputLimitResult() throws Exception {
        Assumptions.assumeTrue(Files.isExecutable(Path.of("/bin/sh")));
        Path pidFile = Files.createTempFile("whisper-cli-overflow-children-", ".pid");
        Files.deleteIfExists(pidFile);
        String script = "sleep 30 & echo $! >> \"" + pidFile + "\"; "
                + "sleep 30 & echo $! >> \"" + pidFile + "\"; wait";
        List<Long> childPids = new ArrayList<>();
        try {
            var result = new WhisperOciWorkerSupervisor.ProcessBuilderCommandRunner(1).run(
                    List.of("/bin/sh", "-c", script), null, Duration.ofMillis(1000), 1024, 1024);
            assertThat(Files.exists(pidFile)).isTrue();
            for (String pid : Files.readAllLines(pidFile)) childPids.add(Long.parseLong(pid.trim()));
            assertThat(childPids).hasSize(2);
            assertThat(result.timedOut()).isTrue();
            assertThat(result.cleanupConfirmed())
                    .as("discovery beyond the configured child bound must be surfaced as incomplete")
                    .isFalse();
            assertThat(result.outputExceeded())
                    .as("process discovery overflow is separate from captured output limits")
                    .isFalse();
        } finally {
            cleanupPidFileChildren(pidFile);
            Files.deleteIfExists(pidFile);
        }
    }

    private static void cleanupPidFileChildren(Path pidFile) throws Exception {
        if (!Files.exists(pidFile)) return;
        List<Long> pids = new ArrayList<>();
        for (String pid : Files.readAllLines(pidFile)) {
            try { pids.add(Long.parseLong(pid.trim())); } catch (NumberFormatException ignored) { }
        }
        for (long pid : pids) ProcessHandle.of(pid).ifPresent(ProcessHandle::destroyForcibly);
        for (long pid : pids) assertProcessEventuallyExits(pid);
    }

    private static void assertProcessEventuallyExits(long pid) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        while (ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false)
                && System.nanoTime() < deadline) {
            Thread.sleep(25);
        }
        assertThat(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false))
                .as("child started during wrapper termination must not outlive cleanup")
                .isFalse();
    }
}
