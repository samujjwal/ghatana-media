package com.ghatana.audio.video.vision.model;

import java.util.Locale;
import java.util.Map;
import java.util.Objects;

/**
 * Explicit host capability profile for the Vision gRPC service.
 *
 * <p>{@link #FULL_VISION} is the default and preserves the existing contract: an admitted,
 * initialized YOLO detector is required before the server binds. {@link #OCR_ONLY} is the
 * source-approved DI-only profile: no detector is composed, scene-text recognition is served
 * exclusively through Document Intelligence, and detector RPCs stay unavailable with truthful
 * NOT_ADMITTED semantics. A capability profile never silently inherits another capability's
 * admission.
 */
public enum VisionCapabilityProfile {
    FULL_VISION,
    OCR_ONLY;

    public static VisionCapabilityProfile fromEnvironment(Map<String, String> environment) {
        Objects.requireNonNull(environment, "environment");
        String raw = environment.getOrDefault("VISION_CAPABILITY_PROFILE", "FULL_VISION").trim();
        if (raw.isEmpty()) return FULL_VISION;
        try {
            return valueOf(raw.toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException unknown) {
            throw new IllegalArgumentException(
                    "VISION_CAPABILITY_PROFILE must be FULL_VISION or OCR_ONLY", unknown);
        }
    }
}
