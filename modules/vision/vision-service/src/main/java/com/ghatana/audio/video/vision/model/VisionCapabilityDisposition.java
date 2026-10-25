package com.ghatana.audio.video.vision.model;

import java.util.Arrays;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Runtime disposition for advanced Vision intents that have no qualified provider contract.
 *
 * <p>This is an executable projection of the registered PDP capability IDs, not a provider
 * admission source. No tensor, geometry, tracking ID, or other result shape is implied here.
 * A future implementation must add a qualified provider and its source-owned output contract
 * before changing any disposition.
 */
public enum VisionCapabilityDisposition {
    IMAGE_SEGMENTATION("media.vision.segment.image"),
    VIDEO_SEGMENTATION("media.vision.segment.video"),
    OBJECT_TRACKING("media.vision.track.object"),
    POINT_TRACKING("media.vision.track.point"),
    OPTICAL_FLOW("media.vision.estimate.optical-flow"),
    DEPTH_ESTIMATION("media.vision.estimate.depth"),
    SURFACE_NORMAL_ESTIMATION("media.vision.estimate.surface-normals"),
    HUMAN_POSE_ESTIMATION("media.vision.estimate.human-pose"),
    HAND_POSE_ESTIMATION("media.vision.estimate.hand-pose"),
    FOREGROUND_BACKGROUND_MATTE("media.vision.matte.foreground-background"),
    MOTION_SEGMENTATION("media.vision.segment.motion"),
    SALIENCY_ESTIMATION("media.vision.estimate.saliency");

    public enum Status { NOT_ADMITTED }

    private static final Map<String, VisionCapabilityDisposition> BY_INTENT_ID = Arrays.stream(values())
            .collect(Collectors.toUnmodifiableMap(
                    VisionCapabilityDisposition::intentId,
                    Function.identity()));

    private final String intentId;

    VisionCapabilityDisposition(String intentId) {
        this.intentId = intentId;
    }

    public String intentId() {
        return intentId;
    }

    public Status status() {
        return Status.NOT_ADMITTED;
    }

    /** Returns a disposition only for an exact registered capability ID. */
    public static Optional<VisionCapabilityDisposition> forIntentId(String intentId) {
        return Optional.ofNullable(BY_INTENT_ID.get(intentId));
    }
}
