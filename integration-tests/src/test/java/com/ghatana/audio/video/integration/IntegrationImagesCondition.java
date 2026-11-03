/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.integration;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;
import org.junit.jupiter.api.extension.ConditionEvaluationResult;
import org.junit.jupiter.api.extension.ExecutionCondition;
import org.junit.jupiter.api.extension.ExtensionContext;

/**
 * Disables Docker-Compose-based audio-video integration suites when the service
 * images they orchestrate are not present in the local Docker daemon.
 *
 * <p>A local run without verifiable images cannot start the compose stack, so
 * the suite reports a truthful skip rather than a misleading infrastructure
 * failure. Images can be supplied only by selecting
 * {@code AUDIO_VIDEO_STT_IMAGE} / {@code AUDIO_VIDEO_TTS_IMAGE} as immutable
 * repository digests that Docker reports for the exact local image. Mutable
 * tags, including the local default {@code :latest} values, are not qualification
 * evidence.
 */
final class IntegrationImagesCondition implements ExecutionCondition {

    private static final String STT_IMAGE_ENV = "AUDIO_VIDEO_STT_IMAGE";
    private static final String TTS_IMAGE_ENV = "AUDIO_VIDEO_TTS_IMAGE";
    private static final String STT_DEFAULT_IMAGE = "ghatana/stt-service:latest";
    private static final String TTS_DEFAULT_IMAGE = "ghatana/tts-service:latest";
    private static final Pattern PINNED_IMAGE = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[0-9a-f]{64}");
    private static final int MAX_INSPECT_OUTPUT_BYTES = 16 * 1024;
    private static final ObjectMapper JSON = JsonMapper.builder()
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .build();

    @Override
    public ConditionEvaluationResult evaluateExecutionCondition(ExtensionContext context) {
        List<String> missing = new ArrayList<>();
        for (String image : List.of(selectedImage(AudioVideoContainerBase.STT_SERVICE),
                selectedImage(AudioVideoContainerBase.TTS_SERVICE))) {
            if (!isPinnedDigest(image)) {
                missing.add(image + " (must be an immutable repository@sha256:<64-hex> reference)");
            } else if (!imageHasExactDigest(image)) {
                missing.add(image + " (unable to verify the exact repository digest with the local Docker daemon)");
            }
        }
        if (!missing.isEmpty()) {
            return ConditionEvaluationResult.disabled(
                    "GH-90000: required audio-video service image test inputs are missing or unverified: " + missing
                            + ". Set " + STT_IMAGE_ENV + "/" + TTS_IMAGE_ENV
                            + " to immutable repository@sha256 references available in the local Docker daemon.");
        }
        return ConditionEvaluationResult.enabled(
                "exact selected audio-video service image digests present locally: "
                        + List.of(selectedImage(AudioVideoContainerBase.STT_SERVICE),
                                selectedImage(AudioVideoContainerBase.TTS_SERVICE)));
    }

    static String selectedImage(String serviceName) {
        if (AudioVideoContainerBase.STT_SERVICE.equals(serviceName)) {
            return System.getenv().getOrDefault(STT_IMAGE_ENV, STT_DEFAULT_IMAGE);
        }
        if (AudioVideoContainerBase.TTS_SERVICE.equals(serviceName)) {
            return System.getenv().getOrDefault(TTS_IMAGE_ENV, TTS_DEFAULT_IMAGE);
        }
        throw new IllegalArgumentException("Unknown Media Compose service: " + serviceName);
    }

    static boolean isPinnedDigest(String image) {
        return image != null && PINNED_IMAGE.matcher(image).matches();
    }

    static boolean reportsExactDigest(String image, String inspectOutput) {
        if (!isPinnedDigest(image) || inspectOutput == null) {
            return false;
        }
        try {
            JsonNode digests = JSON.readTree(inspectOutput);
            if (digests == null || !digests.isArray()) {
                return false;
            }
            boolean found = false;
            for (JsonNode digest : digests) {
                if (!digest.isString()) {
                    return false;
                }
                found |= image.equals(digest.asString());
            }
            return found;
        } catch (RuntimeException malformedJson) {
            return false;
        }
    }

    private static boolean imageHasExactDigest(String image) {
        Process probe = null;
        CompletableFuture<BoundedOutput> stdout = null;
        CompletableFuture<BoundedOutput> stderr = null;
        try {
            probe = new ProcessBuilder("docker", "image", "inspect",
                    "--format={{json .RepoDigests}}", image)
                    .start();
            Process running = probe;
            stdout = CompletableFuture.supplyAsync(() -> readBounded(running.getInputStream()));
            stderr = CompletableFuture.supplyAsync(() -> readBounded(running.getErrorStream()));
            if (!probe.waitFor(30, TimeUnit.SECONDS)) {
                stopAndReap(probe);
                return false;
            }
            BoundedOutput captured = stdout.get(5, TimeUnit.SECONDS);
            stderr.get(5, TimeUnit.SECONDS); // Drain separately so diagnostics can never satisfy JSON matching.
            return probe.exitValue() == 0 && !captured.truncated()
                    && reportsExactDigest(image, captured.text());
        } catch (InterruptedException e) {
            if (probe != null) {
                stopAndReap(probe);
            }
            Thread.currentThread().interrupt();
            return false;
        } catch (Exception e) {
            if (probe != null) {
                stopAndReap(probe);
            }
            return false;
        } finally {
            if (probe != null) {
                closeQuietly(probe.getInputStream());
                closeQuietly(probe.getErrorStream());
                closeQuietly(probe.getOutputStream());
            }
        }
    }

    private static BoundedOutput readBounded(InputStream stream) {
        try (stream; ByteArrayOutputStream captured = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            boolean truncated = false;
            int count;
            while ((count = stream.read(buffer)) != -1) {
                int remaining = MAX_INSPECT_OUTPUT_BYTES - captured.size();
                if (remaining > 0) {
                    int retained = Math.min(remaining, count);
                    captured.write(buffer, 0, retained);
                    truncated |= retained != count;
                } else {
                    truncated = true;
                }
            }
            return new BoundedOutput(new String(captured.toByteArray(), StandardCharsets.UTF_8), truncated);
        } catch (IOException unreadable) {
            throw new IllegalStateException("Unable to read bounded Docker image inspection output", unreadable);
        }
    }

    private static void stopAndReap(Process process) {
        process.descendants().forEach(ProcessHandle::destroyForcibly);
        process.destroyForcibly();
        try {
            process.waitFor(5, TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private static void closeQuietly(AutoCloseable closeable) {
        try {
            closeable.close();
        } catch (Exception ignored) {
            // The probe result is already fail-closed; stream cleanup must not mask it.
        }
    }

    private record BoundedOutput(String text, boolean truncated) { }
}
