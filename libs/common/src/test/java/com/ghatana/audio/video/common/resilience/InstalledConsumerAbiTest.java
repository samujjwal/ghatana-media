package com.ghatana.audio.video.common.resilience;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Purpose: compile and run an installed-style consumer against the built common archive.
 * Consumers: the common-library source-free ABI regression suite.
 * Non-goals: published-package admission, provider qualification, or host/native leak qualification.
 * Change policy: keep the child classpath limited to the owning archive and declared runtime JARs.
 */
class InstalledConsumerAbiTest {
    private static final int MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
    private static final String OUTPUT_TRUNCATED = "\n[process output truncated after 65536 bytes]";

    private static final String CONSUMER_SOURCE = """
            package consumer;

            import com.ghatana.audio.video.common.resilience.ContextAwareBoundedExecutor;
            import io.grpc.Status;
            import io.grpc.StatusRuntimeException;

            import java.util.concurrent.CompletableFuture;
            import java.util.concurrent.CountDownLatch;
            import java.util.concurrent.ExecutionException;
            import java.util.concurrent.LinkedBlockingQueue;
            import java.util.concurrent.ThreadPoolExecutor;
            import java.util.concurrent.TimeUnit;
            import java.util.concurrent.atomic.AtomicInteger;

            public final class InstalledConsumer {
                public static void main(String[] args) throws Exception {
                    successfulResultHasSourceAssignableType();
                    consumerCannotMutateActiveWorkerOutcome();
                    queuedCancellationIsKnownNoEffect();
                    startedCancellationIsUnknownOutcome();
                }

                private static void successfulResultHasSourceAssignableType() throws Exception {
                    ThreadPoolExecutor workers = worker();
                    try {
                        ContextAwareBoundedExecutor.Submission<String> submission =
                                new ContextAwareBoundedExecutor(workers).submit(() -> "consumer-result");
                        CompletableFuture<String> result = submission.result();
                        require("consumer-result".equals(result.get(2, TimeUnit.SECONDS)),
                                "successful result did not cross the installed consumer boundary");
                    } finally {
                        stop(workers);
                    }
                }

                private static void consumerCannotMutateActiveWorkerOutcome() throws Exception {
                    ThreadPoolExecutor workers = worker();
                    CountDownLatch childStarted = new CountDownLatch(1);
                    CountDownLatch releaseChild = new CountDownLatch(1);
                    AtomicInteger mutationSuppliers = new AtomicInteger();
                    try {
                        ContextAwareBoundedExecutor.Submission<String> submission =
                                new ContextAwareBoundedExecutor(workers).submit(() -> {
                                    childStarted.countDown();
                                    if (!releaseChild.await(2, TimeUnit.SECONDS)) {
                                        throw new IllegalStateException("test did not release active child");
                                    }
                                    return "actual-worker-result";
                                });
                        CompletableFuture<String> result = submission.result();
                        require(childStarted.await(2, TimeUnit.SECONDS), "child did not start");
                        require(submission.started(), "active child was not marked started");
                        require(!result.isDone(), "active worker result completed before worker release");

                        expectMutationRejected(() -> result.complete("forged-success"));
                        expectMutationRejected(() -> result.completeExceptionally(
                                new IllegalStateException("forged-failure")));
                        expectMutationRejected(() -> result.obtrudeValue("obtruded-success"));
                        expectMutationRejected(() -> result.obtrudeException(
                                new IllegalStateException("obtruded-failure")));
                        expectMutationRejected(() -> result.completeAsync(() -> {
                            mutationSuppliers.incrementAndGet();
                            return "async-forged-success";
                        }));
                        expectMutationRejected(() -> result.completeAsync(() -> {
                            mutationSuppliers.incrementAndGet();
                            return "executor-forged-success";
                        }, Runnable::run));
                        expectMutationRejected(() -> result.orTimeout(1, TimeUnit.HOURS));
                        expectMutationRejected(() -> result.completeOnTimeout("timeout-forged-success",
                                1, TimeUnit.HOURS));

                        require(mutationSuppliers.get() == 0, "rejected mutation supplier was invoked");
                        require(!result.isDone(), "consumer mutation completed the worker result");
                        require(!result.isCancelled(), "consumer mutation cancelled the worker result");
                        releaseChild.countDown();
                        require("actual-worker-result".equals(result.get(2, TimeUnit.SECONDS)),
                                "consumer mutation replaced the actual worker result");
                        require(!result.isCancelled(), "actual worker result was marked cancelled");
                    } finally {
                        releaseChild.countDown();
                        stop(workers);
                    }
                }

                private static void expectMutationRejected(Runnable mutation) {
                    try {
                        mutation.run();
                        throw new AssertionError("consumer mutation was accepted");
                    } catch (UnsupportedOperationException expected) {
                        require(expected.getMessage().equals(
                                        "Submission result is owned by the executor; observe it or cancel the submission"),
                                "consumer mutation failed with an unexpected message: " + expected.getMessage());
                    }
                }

                private static void queuedCancellationIsKnownNoEffect() throws Exception {
                    ThreadPoolExecutor workers = worker();
                    CountDownLatch blockerStarted = new CountDownLatch(1);
                    CountDownLatch releaseBlocker = new CountDownLatch(1);
                    AtomicInteger effects = new AtomicInteger();
                    try {
                        workers.execute(() -> {
                            blockerStarted.countDown();
                            awaitUninterruptibly(releaseBlocker);
                        });
                        require(blockerStarted.await(2, TimeUnit.SECONDS), "worker did not start blocker");
                        ContextAwareBoundedExecutor.Submission<String> submission =
                                new ContextAwareBoundedExecutor(workers).submit(() -> {
                                    effects.incrementAndGet();
                                    return "must-not-run";
                                });
                        CompletableFuture<String> result = submission.result();
                        require(!submission.started(), "queued child was marked started");
                        submission.cancel();
                        StatusRuntimeException outcome = failure(result);
                        require(Status.fromThrowable(outcome).getCode() == Status.Code.CANCELLED,
                                "pre-start cancellation was not CANCELLED: " + outcome);
                        require(outcome.getMessage().contains("known to have no effect"),
                                "pre-start cancellation did not state known no effect: " + outcome);
                        require(!result.isCancelled(), "outcome future hid the classified result as cancelled");
                        require(effects.get() == 0, "cancelled queued child produced an effect");
                        releaseBlocker.countDown();
                        workers.shutdown();
                        require(workers.awaitTermination(2, TimeUnit.SECONDS), "worker did not terminate");
                    } finally {
                        releaseBlocker.countDown();
                        stop(workers);
                    }
                }

                private static void startedCancellationIsUnknownOutcome() throws Exception {
                    ThreadPoolExecutor workers = worker();
                    CountDownLatch childStarted = new CountDownLatch(1);
                    CountDownLatch releaseChild = new CountDownLatch(1);
                    CountDownLatch childFinished = new CountDownLatch(1);
                    AtomicInteger effects = new AtomicInteger();
                    try {
                        ContextAwareBoundedExecutor.Submission<String> submission =
                                new ContextAwareBoundedExecutor(workers).submit(() -> {
                                    childStarted.countDown();
                                    awaitUninterruptibly(releaseChild);
                                    effects.incrementAndGet();
                                    childFinished.countDown();
                                    return "effect-committed";
                                });
                        CompletableFuture<String> result = submission.result();
                        require(childStarted.await(2, TimeUnit.SECONDS), "child did not start");
                        require(submission.started(), "started child was not marked started");
                        submission.cancel();
                        StatusRuntimeException outcome = failure(result);
                        require(Status.fromThrowable(outcome).getCode() == Status.Code.UNKNOWN,
                                "started cancellation was not UNKNOWN: " + outcome);
                        require(outcome.getMessage().contains("UNKNOWN_OUTCOME"),
                                "started cancellation omitted UNKNOWN_OUTCOME: " + outcome);
                        releaseChild.countDown();
                        require(childFinished.await(2, TimeUnit.SECONDS), "child did not finish after cancellation");
                        require(effects.get() == 1, "started child effect count was not preserved");
                        require(Status.fromThrowable(failure(result)).getCode() == Status.Code.UNKNOWN,
                                "late child completion replaced the final UNKNOWN outcome");
                    } finally {
                        releaseChild.countDown();
                        stop(workers);
                    }
                }

                private static ThreadPoolExecutor worker() {
                    return new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new LinkedBlockingQueue<>());
                }

                private static StatusRuntimeException failure(CompletableFuture<?> result) throws Exception {
                    try {
                        result.get(2, TimeUnit.SECONDS);
                        throw new AssertionError("expected a classified cancellation outcome");
                    } catch (ExecutionException failure) {
                        if (failure.getCause() instanceof StatusRuntimeException statusFailure) return statusFailure;
                        throw new AssertionError("unexpected result failure", failure.getCause());
                    }
                }

                private static void awaitUninterruptibly(CountDownLatch latch) {
                    boolean interrupted = false;
                    while (true) {
                        try {
                            latch.await();
                            break;
                        } catch (InterruptedException ignored) {
                            interrupted = true;
                        }
                    }
                    if (interrupted) Thread.currentThread().interrupt();
                }

                private static void stop(ThreadPoolExecutor workers) throws InterruptedException {
                    workers.shutdownNow();
                    require(workers.awaitTermination(2, TimeUnit.SECONDS), "executor did not terminate");
                }

                private static void require(boolean condition, String message) {
                    if (!condition) throw new AssertionError(message);
                }
            }
            """;

    @Test
    void builtArchiveCompilesAndRunsFromAnInstalledConsumerProcess(@TempDir Path work) throws Exception {
        Path projectDir = Path.of(System.getProperty("user.dir")).toRealPath();
        Path archive = Path.of(System.getProperty("media.common.consumer.archive")).toRealPath();
        assertThat(archive).isRegularFile();

        Path mainClasses = projectDir.resolve("build/classes/java/main").toRealPath();
        List<Path> classpathEntries = new ArrayList<>();
        classpathEntries.add(archive.toRealPath());
        String declaredRuntimeClasspath = System.getProperty("media.common.consumer.runtimeClasspath", "");
        for (String entry : declaredRuntimeClasspath.split(java.util.regex.Pattern.quote(File.pathSeparator))) {
            if (entry.isBlank()) continue;
            Path path = Path.of(entry).toRealPath();
            assertThat(Files.isRegularFile(path)).as("declared runtime dependency artifact %s", path).isTrue();
            assertThat(path.toString()).endsWith(".jar");
            assertThat(path).isNotEqualTo(mainClasses);
            classpathEntries.add(path);
        }
        String consumerClasspath = classpathEntries.stream().map(Path::toString)
                .collect(java.util.stream.Collectors.joining(File.pathSeparator));
        assertThat(List.of(consumerClasspath.split(java.util.regex.Pattern.quote(File.pathSeparator))))
                .doesNotContain(mainClasses.toString());

        Path source = work.resolve("consumer/InstalledConsumer.java");
        Path classes = work.resolve("classes");
        Files.createDirectories(source.getParent());
        Files.createDirectories(classes);
        Files.writeString(source, CONSUMER_SOURCE, StandardCharsets.UTF_8);

        Path javaHome = Path.of(System.getProperty("java.home"));
        Path javac = javaHome.resolve("bin/javac");
        Path java = javaHome.resolve("bin/java");
        run(List.of(javac.toString(), "-proc:none", "-classpath", consumerClasspath,
                "-d", classes.toString(), source.toString()), work);
        run(List.of(java.toString(), "-classpath", classes + File.pathSeparator + consumerClasspath,
                "consumer.InstalledConsumer"), work);
    }

    private static void run(List<String> command, Path workingDirectory) throws Exception {
        Process process = new ProcessBuilder(command).directory(workingDirectory.toFile())
                .redirectErrorStream(true).start();
        ByteArrayOutputStream capturedOutput = new ByteArrayOutputStream(MAX_PROCESS_OUTPUT_BYTES);
        AtomicReference<IOException> outputReadFailure = new AtomicReference<>();
        AtomicReference<Boolean> outputWasTruncated = new AtomicReference<>(false);
        Thread outputReader = new Thread(
                () -> drainOutput(process.getInputStream(), capturedOutput, outputWasTruncated, outputReadFailure),
                "installed-consumer-output-reader");
        outputReader.setDaemon(true);
        outputReader.start();
        boolean exited = process.waitFor(30, TimeUnit.SECONDS);
        if (!exited) {
            process.destroyForcibly();
            process.waitFor(2, TimeUnit.SECONDS);
        }
        outputReader.join(2_000);
        if (outputReader.isAlive()) {
            process.getInputStream().close();
            outputReader.join(2_000);
        }
        assertThat(outputReader.isAlive()).as("consumer process output reader stopped").isFalse();
        String output = capturedOutput.toString(StandardCharsets.UTF_8)
                + (outputWasTruncated.get() ? OUTPUT_TRUNCATED : "");
        assertThat(outputReadFailure.get()).as("consumer process output was readable").isNull();
        if (!exited) throw new AssertionError("consumer process timed out: " + command + "\n" + output);
        assertThat(process.exitValue()).withFailMessage("command failed: %s\n%s", command, output).isZero();
    }

    private static void drainOutput(InputStream input, ByteArrayOutputStream captured,
                                    AtomicReference<Boolean> wasTruncated,
                                    AtomicReference<IOException> readFailure) {
        byte[] buffer = new byte[8 * 1024];
        int retained = 0;
        try (input) {
            int read;
            while ((read = input.read(buffer)) != -1) {
                int keep = Math.min(read, MAX_PROCESS_OUTPUT_BYTES - retained);
                if (keep > 0) {
                    captured.write(buffer, 0, keep);
                    retained += keep;
                }
                if (keep < read) wasTruncated.set(true);
            }
        } catch (IOException failure) {
            readFailure.set(failure);
        }
    }
}
