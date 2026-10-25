package com.ghatana.audio.video.vision.model;

import java.util.Arrays;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Executable projection of the registered 22 Vision and scene-text PDP-0 capability IDs.
 *
 * <p>{@link ImplementationStatus#IMPLEMENTED} means that Media contains a code path; it does
 * not mean the production provider is qualified. Provider admission, model version, and format
 * qualification remain absent for every row until a trusted provider profile is admitted.
 */
public enum VisionCapabilityDisposition {
    SCENE_TEXT_REGION_TRACK(
            "media.vision.scene-text.region.track", ImplementationStatus.NOT_ADMITTED,
            "AnalyzeVideoFile", "ProcessVideo"),
    SCENE_TEXT_OBSERVATION_CREATE(
            "media.vision.scene-text.observation.create", ImplementationStatus.NOT_ADMITTED,
            "AnalyzeImage", "AnalyzeVideoFile", "ProcessVideo"),
    DETECT(
            "media.vision.detect", ImplementationStatus.IMPLEMENTED,
            "DetectObjects", "AnalyzeVideoFile", "ProcessVideo"),
    CLASSIFY(
            "media.vision.classify", ImplementationStatus.CONTRACT_ONLY,
            "ClassifyImage"),
    IMAGE_SEGMENTATION(
            "media.vision.segment.image", ImplementationStatus.NOT_ADMITTED,
            "AnalyzeImage"),
    VIDEO_SEGMENTATION(
            "media.vision.segment.video", ImplementationStatus.NOT_ADMITTED,
            "AnalyzeVideoFile", "ProcessVideo"),
    OBJECT_TRACKING(
            "media.vision.track.object", ImplementationStatus.NOT_ADMITTED,
            "AnalyzeVideoFile", "ProcessVideo"),
    POINT_TRACKING(
            "media.vision.track.point", ImplementationStatus.NOT_ADMITTED,
            "AnalyzeVideoFile", "ProcessVideo"),
    OPTICAL_FLOW(
            "media.vision.estimate.optical-flow", ImplementationStatus.NOT_ADMITTED,
            "AnalyzeVideoFile", "ProcessVideo"),
    DEPTH_ESTIMATION(
            "media.vision.estimate.depth", ImplementationStatus.NOT_ADMITTED,
            "AnalyzeImage", "AnalyzeVideoFile", "ProcessVideo"),
    SURFACE_NORMAL_ESTIMATION(
            "media.vision.estimate.surface-normals", ImplementationStatus.NOT_ADMITTED,
            "AnalyzeImage"),
    HUMAN_POSE_ESTIMATION(
            "media.vision.estimate.human-pose", ImplementationStatus.NOT_ADMITTED,
            "AnalyzeImage"),
    HAND_POSE_ESTIMATION(
            "media.vision.estimate.hand-pose", ImplementationStatus.NOT_ADMITTED,
            "AnalyzeImage"),
    FACE_LANDMARK_ESTIMATION(
            "media.vision.estimate.face-landmarks", ImplementationStatus.NOT_ADMITTED,
            "AnalyzeImage"),
    EXPRESSION_ANALYSIS(
            "media.vision.analyze.expression", ImplementationStatus.NOT_ADMITTED,
            "AnalyzeImage"),
    GAZE_ANALYSIS(
            "media.vision.analyze.gaze", ImplementationStatus.NOT_ADMITTED,
            "AnalyzeImage"),
    FOREGROUND_BACKGROUND_MATTE(
            "media.vision.matte.foreground-background", ImplementationStatus.NOT_ADMITTED,
            "AnalyzeImage", "AnalyzeVideoFile"),
    MOTION_SEGMENTATION(
            "media.vision.segment.motion", ImplementationStatus.NOT_ADMITTED,
            "AnalyzeVideoFile", "ProcessVideo"),
    SALIENCY_ESTIMATION(
            "media.vision.estimate.saliency", ImplementationStatus.NOT_ADMITTED,
            "AnalyzeImage", "AnalyzeVideoFile"),
    SCENE_CLASSIFICATION(
            "media.vision.classify.scene", ImplementationStatus.CONTRACT_ONLY,
            "AnalyzeImage", "ClassifyImage"),
    SHOT_BOUNDARY_DETECTION(
            "media.vision.detect.shot-boundary", ImplementationStatus.CONTRACT_ONLY,
            "AnalyzeVideoFile"),
    CAMERA_MOTION_ESTIMATION(
            "media.vision.estimate.camera-motion", ImplementationStatus.CONTRACT_ONLY,
            "AnalyzeVideoFile", "ProcessVideo");

    /** Source implementation state, separate from actual provider admission. */
    public enum ImplementationStatus { IMPLEMENTED, CONTRACT_ONLY, NOT_ADMITTED }

    /** Runtime provider state. No Vision provider/model/version/format is currently admitted. */
    public enum Status { NOT_ADMITTED }

    private static final Map<String, VisionCapabilityDisposition> BY_INTENT_ID = Arrays.stream(values())
            .collect(Collectors.toUnmodifiableMap(
                    VisionCapabilityDisposition::intentId,
                    Function.identity()));

    private final String intentId;
    private final ImplementationStatus implementationStatus;
    private final Set<String> rpcMethods;

    VisionCapabilityDisposition(
            String intentId,
            ImplementationStatus implementationStatus,
            String... rpcMethods) {
        this.intentId = intentId;
        this.implementationStatus = implementationStatus;
        this.rpcMethods = Set.of(rpcMethods);
    }

    public String intentId() {
        return intentId;
    }

    public ImplementationStatus implementationStatus() {
        return implementationStatus;
    }

    /** All entries remain unavailable for positive provider-backed execution. */
    public Status status() {
        return Status.NOT_ADMITTED;
    }

    /**
     * Closest proto RPC request/result surfaces for this intent. Membership is a mapping only;
     * it does not assert that the wire schema can represent the complete result.
     */
    public Set<String> rpcMethods() {
        return rpcMethods;
    }

    /** No model or version has passed trusted production admission. */
    public Optional<String> qualifiedModelVersion() {
        return Optional.empty();
    }

    /** No image/video format has been qualified with an admitted model profile. */
    public Set<String> qualifiedFormats() {
        return Set.of();
    }

    /** Returns a disposition only for an exact registered capability ID. */
    public static Optional<VisionCapabilityDisposition> forIntentId(String intentId) {
        return Optional.ofNullable(BY_INTENT_ID.get(intentId));
    }
}
