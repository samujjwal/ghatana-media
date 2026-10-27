/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.integration;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.extension.ExtendWith;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * Runs isolated Compose startup probes for the STT and TTS candidate images.
 *
 * <p>The current production provider profiles are not admitted. The expected
 * contract is therefore a bounded, typed startup refusal before gRPC/HTTP
 * listeners or provider effects are created. {@code docker compose run} does
 * not publish service ports unless {@code --service-ports} is explicitly set.
 *
 * @doc.type class
 * @doc.purpose Shared Compose startup-refusal probes for audio-video images
 * @doc.layer integration
 * @doc.pattern TestBase
 */
@Tag("integration")
@ExtendWith(IntegrationImagesCondition.class)
public abstract class AudioVideoContainerBase {

    protected static final String STT_SERVICE = "stt-service";
    protected static final String TTS_SERVICE = "tts-service";
    protected static final String STT_PROVIDER_REFUSAL = "STT_PROVIDER_NOT_ADMITTED";
    protected static final String TTS_PROVIDER_REFUSAL = "TTS_PROVIDER_NOT_ADMITTED";

    private static final String STT_IMAGE_ENV = "AUDIO_VIDEO_STT_IMAGE";
    private static final String TTS_IMAGE_ENV = "AUDIO_VIDEO_TTS_IMAGE";
    private static final String STT_DEFAULT_IMAGE = "ghatana/stt-service:latest";
    private static final String TTS_DEFAULT_IMAGE = "ghatana/tts-service:latest";
    private static final Duration STARTUP_TIMEOUT = Duration.ofSeconds(30);
    private static final Duration CLEANUP_TIMEOUT = Duration.ofSeconds(8);
    private static final int MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;
    private static final Map<String, StartupResult> RESULTS = new ConcurrentHashMap<>();

    protected static StartupResult startupRefusal(String serviceName) {
        if (!STT_SERVICE.equals(serviceName) && !TTS_SERVICE.equals(serviceName)) {
            throw new IllegalArgumentException("Unknown Media Compose service: " + serviceName);
        }
        return RESULTS.computeIfAbsent(serviceName, AudioVideoContainerBase::runStartupProbe);
    }

    protected static CommandResult javaVersion(String serviceName) {
        String image = imageFor(serviceName);
        return runCommand(List.of("docker", "run", "--rm", "--entrypoint", "java", image, "-version"));
    }

    private static String imageFor(String serviceName) {
        return STT_SERVICE.equals(serviceName)
                ? System.getenv().getOrDefault(STT_IMAGE_ENV, STT_DEFAULT_IMAGE)
                : System.getenv().getOrDefault(TTS_IMAGE_ENV, TTS_DEFAULT_IMAGE);
    }

    private static StartupResult runStartupProbe(String serviceName) {
        Path composeFile = Path.of("docker-compose.integration.yml").toAbsolutePath();
        if (!composeFile.toFile().isFile()) {
            throw new IllegalStateException("Compose fixture is missing: " + composeFile);
        }
        String projectName = "avw2-" + UUID.randomUUID().toString().replace("-", "");
        CommandResult result = null;
        boolean cleanupSuccessful;
        try {
            result = runCommand(List.of(
                    "docker", "compose", "--project-name", projectName,
                    "-f", composeFile.toString(),
                    "run", "--rm", "--no-deps", serviceName));
        } finally {
            cleanupSuccessful = cleanupProject(projectName, composeFile, serviceName, AudioVideoContainerBase::runCommand);
        }
        return new StartupResult(serviceName, imageFor(serviceName), result.exitCode(),
                result.timedOut(), result.output(), result.elapsed(),
                result.command().contains("--service-ports"), cleanupSuccessful);
    }

    static CommandResult runCommand(List<String> command) {
        return runCommand(command, STARTUP_TIMEOUT);
    }

    static CommandResult runCommand(List<String> command, Duration timeout) {
        long startedNanos = System.nanoTime();
        Process process;
        try {
            process = new ProcessBuilder(command)
                    .directory(new File(System.getProperty("user.dir")))
                    .redirectErrorStream(true)
                    .start();
        } catch (IOException failure) {
            throw new IllegalStateException("Unable to start bounded image probe", failure);
        }

        CompletableFuture<byte[]> output = CompletableFuture.supplyAsync(
                () -> readBounded(process.getInputStream()));
        boolean finished;
        try {
            finished = process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS);
            if (!finished) {
                process.descendants().forEach(ProcessHandle::destroyForcibly);
                process.destroyForcibly();
                process.waitFor(5, TimeUnit.SECONDS);
            }
            byte[] captured = output.get(5, TimeUnit.SECONDS);
            return new CommandResult(command, finished ? process.exitValue() : -1, !finished,
                    new String(captured, StandardCharsets.UTF_8),
                    Duration.ofNanos(System.nanoTime() - startedNanos));
        } catch (InterruptedException interrupted) {
            process.descendants().forEach(ProcessHandle::destroyForcibly);
            process.destroyForcibly();
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Image probe was interrupted", interrupted);
        } catch (Exception failure) {
            process.descendants().forEach(ProcessHandle::destroyForcibly);
            process.destroyForcibly();
            throw new IllegalStateException("Unable to collect bounded image probe result", failure);
        }
    }

    static boolean cleanupProject(String projectName, Path composeFile, String serviceName, CommandExecutor executor) {
        boolean interrupted = Thread.interrupted();
        boolean successful = true;
        try {
            successful &= runCleanup(executor, List.of("docker", "compose", "--project-name", projectName,
                    "-f", composeFile.toString(), "down", "--remove-orphans", "--timeout", "2"));
            interrupted |= Thread.interrupted();
            successful &= runCleanup(executor, List.of("docker", "compose", "--project-name", projectName,
                    "-f", composeFile.toString(), "rm", "--force", "--stop", serviceName));
            interrupted |= Thread.interrupted();
            return successful;
        } finally {
            if (interrupted) Thread.currentThread().interrupt();
        }
    }

    private static boolean runCleanup(CommandExecutor executor, List<String> command) {
        try {
            CommandResult result = executor.run(command, CLEANUP_TIMEOUT);
            return result.exitCode() == 0 && !result.timedOut();
        } catch (RuntimeException cleanupFailure) {
            return false;
        }
    }

    private static byte[] readBounded(InputStream stream) {
        try (stream; ByteArrayOutputStream captured = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = stream.read(buffer)) != -1) {
                int remaining = MAX_CAPTURED_OUTPUT_BYTES - captured.size();
                if (remaining > 0) captured.write(buffer, 0, Math.min(count, remaining));
            }
            return captured.toByteArray();
        } catch (IOException failure) {
            throw new IllegalStateException("Unable to capture bounded image probe output", failure);
        }
    }

    protected record StartupResult(
            String serviceName,
            String image,
            int exitCode,
            boolean timedOut,
            String output,
            Duration elapsed,
            boolean servicePortsRequested,
            boolean cleanupSuccessful) {}

    protected record CommandResult(
            List<String> command,
            int exitCode,
            boolean timedOut,
            String output,
            Duration elapsed) {}

    @FunctionalInterface
    interface CommandExecutor {
        CommandResult run(List<String> command, Duration timeout);
    }
}
