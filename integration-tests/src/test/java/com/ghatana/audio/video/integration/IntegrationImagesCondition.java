/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.integration;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.extension.ConditionEvaluationResult;
import org.junit.jupiter.api.extension.ExecutionCondition;
import org.junit.jupiter.api.extension.ExtensionContext;

/**
 * Disables Docker-Compose-based audio-video integration suites when the service
 * images they orchestrate are not present in the local Docker daemon.
 *
 * <p>Images are produced by the audio-video CI pipeline (GH-90000); a local run
 * without them cannot start the compose stack, so the suite reports a truthful
 * skip rather than a misleading infrastructure failure. Images can be supplied
 * either by building {@code docker/Dockerfile.stt-service} /
 * {@code docker/Dockerfile.tts-service} after {@code installDist}, or by
 * pointing {@code AUDIO_VIDEO_STT_IMAGE} / {@code AUDIO_VIDEO_TTS_IMAGE} at
 * already-published image coordinates.
 */
final class IntegrationImagesCondition implements ExecutionCondition {

    private static final String STT_IMAGE_ENV = "AUDIO_VIDEO_STT_IMAGE";
    private static final String TTS_IMAGE_ENV = "AUDIO_VIDEO_TTS_IMAGE";
    private static final String STT_DEFAULT_IMAGE = "ghatana/stt-service:latest";
    private static final String TTS_DEFAULT_IMAGE = "ghatana/tts-service:latest";

    @Override
    public ConditionEvaluationResult evaluateExecutionCondition(ExtensionContext context) {
        List<String> required = List.of(
                System.getenv().getOrDefault(STT_IMAGE_ENV, STT_DEFAULT_IMAGE),
                System.getenv().getOrDefault(TTS_IMAGE_ENV, TTS_DEFAULT_IMAGE));
        List<String> missing = new ArrayList<>();
        for (String image : required) {
            if (!imagePresent(image)) {
                missing.add(image);
            }
        }
        if (!missing.isEmpty()) {
            return ConditionEvaluationResult.disabled(
                    "GH-90000: audio-video service image(s) not available locally: " + missing
                            + ". Build docker/Dockerfile.* after :installDist, or set "
                            + STT_IMAGE_ENV + "/" + TTS_IMAGE_ENV + " to published coordinates.");
        }
        return ConditionEvaluationResult.enabled("audio-video service images present");
    }

    private static boolean imagePresent(String image) {
        try {
            Process probe = new ProcessBuilder("docker", "image", "inspect", image)
                    .redirectErrorStream(true)
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .start();
            boolean finished = probe.waitFor(30, TimeUnit.SECONDS);
            if (!finished) {
                probe.destroyForcibly();
                return false;
            }
            return probe.exitValue() == 0;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        } catch (Exception e) {
            return false;
        }
    }
}
