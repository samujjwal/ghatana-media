package com.ghatana.media.launcher;

import com.ghatana.audio.video.vision.local.LocalModelAdmission;
import com.ghatana.audio.video.vision.local.LocalOpenModelVisionProvider;
import com.ghatana.audio.video.vision.local.LocalVisionEngine;
import com.ghatana.audio.video.vision.local.LocalVisionRightsAuthority;
import com.ghatana.audio.video.vision.local.LocalVisionSidecarClient;

import java.net.URI;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.Optional;

/**
 * Host composition of the owner-selected local vision models (Florence-2, Qwen2.5-VL-7B-Instruct).
 * Configuration is entirely explicit: {@code MEDIA_LOCAL_VISION_MODELS_ROOT} (absolute directory holding
 * {@code florence-2-large} and {@code qwen2.5-vl-7b-instruct}, each with a digest manifest),
 * {@code MEDIA_LOCAL_VISION_SIDECAR_URL} (an http loopback URL) and {@code MEDIA_LOCAL_VISION_SIDECAR_TOKEN}.
 * Anything absent yields no engine, so nothing is admitted. The rights authority defaults to the unavailable
 * one: production-like profiles therefore never treat the provider as production eligible.
 */
final class MediaLocalVisionComposition {
    static final String MODELS_ROOT_ENV = "MEDIA_LOCAL_VISION_MODELS_ROOT";
    static final String SIDECAR_URL_ENV = "MEDIA_LOCAL_VISION_SIDECAR_URL";
    static final String SIDECAR_TOKEN_ENV = "MEDIA_LOCAL_VISION_SIDECAR_TOKEN";
    static final String TIMEOUT_ENV = "MEDIA_LOCAL_VISION_TIMEOUT_SECONDS";
    static final String FLORENCE_DIR = "florence-2-large";
    static final String QWEN_DIR = "qwen2.5-vl-7b-instruct";

    private MediaLocalVisionComposition() { }

    static Optional<LocalVisionEngine> engineFrom(Map<String, String> environment) {
        return engineFrom(environment, LocalVisionRightsAuthority.unavailable());
    }

    static Optional<LocalVisionEngine> engineFrom(Map<String, String> environment, LocalVisionRightsAuthority rights) {
        String root = environment.getOrDefault(MODELS_ROOT_ENV, "");
        String url = environment.getOrDefault(SIDECAR_URL_ENV, "");
        String token = environment.getOrDefault(SIDECAR_TOKEN_ENV, "");
        if (root.isBlank() || url.isBlank() || token.isBlank()) return Optional.empty();
        Path modelsRoot = Path.of(root);
        if (!modelsRoot.isAbsolute()) throw new IllegalArgumentException(MODELS_ROOT_ENV + " must be absolute");
        long seconds = Long.parseLong(environment.getOrDefault(TIMEOUT_ENV, "240"));
        LocalVisionSidecarClient client = new LocalVisionSidecarClient(URI.create(url), token, Duration.ofSeconds(seconds));
        return Optional.of(new LocalVisionEngine(client,
                new LocalModelAdmission(modelsRoot.resolve(FLORENCE_DIR), LocalVisionEngine.FLORENCE_MODEL_ID,
                        "VISION", "MIT"),
                new LocalModelAdmission(modelsRoot.resolve(QWEN_DIR), LocalVisionEngine.QWEN_MODEL_ID,
                        "MULTIMODAL_QA", "Apache-2.0"),
                rights));
    }

    static Optional<LocalOpenModelVisionProvider> providerFrom(Map<String, String> environment) {
        return engineFrom(environment).map(engine ->
                new LocalOpenModelVisionProvider(engine, MediaDevFfmpegFrameExtractor.from(environment)));
    }
}
