package com.ghatana.audio.video.vision.model;

import java.util.Objects;

/**
 * Production admission boundary for the Vision model provider.
 *
 * <p>No trusted license/provider admission source is currently wired into Media Vision. Local
 * profile metadata, including an operator-supplied license identifier, is deliberately insufficient
 * to authorize model initialization or traffic.
 */
public final class VisionProviderAdmission {
    private VisionProviderAdmission() { }

    public static void requireAdmitted(VisionModelProfile preflightProfile) {
        Objects.requireNonNull(preflightProfile, "preflightProfile");
        throw new VisionModelProfile.VisionProviderUnavailableException(
                VisionModelProfile.UnavailableReason.PROVIDER_NOT_ADMITTED,
                "No trusted Vision license/provider admission source is configured");
    }
}
