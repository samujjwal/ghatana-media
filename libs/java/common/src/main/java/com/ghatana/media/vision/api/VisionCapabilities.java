package com.ghatana.media.vision.api;

import java.util.EnumSet;
import java.util.Set;

/**
 * Immutable capability advertisement for one composed vision engine.
 *
 * @doc.type record
 * @doc.purpose Represent Vision Capabilities values
 * @doc.layer product
 * @doc.pattern ValueObject
 */
public record VisionCapabilities(Set<Capability> supported) {
    public VisionCapabilities {
        supported = Set.copyOf(supported == null ? Set.of() : supported);
    }

    public boolean supports(Capability capability) {
        return supported.contains(capability);
    }

    public static VisionCapabilities objectDetectionOnly() {
        return new VisionCapabilities(EnumSet.of(Capability.OBJECT_DETECTION));
    }

    public enum Capability {
        OBJECT_DETECTION,
        CLASSIFICATION,
        CAPTION,
        SEGMENTATION,
        TRACKING
    }
}
