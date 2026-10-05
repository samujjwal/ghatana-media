package com.ghatana.audio.video.vision.recognition;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;

/**
 * Facial recognition service for the Vision pipeline (AV-009.1).
 *
 * <p>Detects faces in images and, when enrolled identities are available,
 * attempts to identify them using pluggable {@link FaceRecognitionModel}.
 *
 * <h3>Acceptance criteria (AV-009.1)</h3>
 * <ul>
 *   <li>Face detection and identification.</li>
 *   <li>Recognition accuracy &gt;95% (validated in quality tests).</li>
 * </ul>
 *
 * @doc.type class
 * @doc.purpose Facial detection and recognition for the vision analysis pipeline
 * @doc.layer product
 * @doc.pattern Service
 */
public final class FacialRecognitionService {

    private static final Logger LOG = LoggerFactory.getLogger(FacialRecognitionService.class);

    private final FaceRecognitionModel model;
    private final double identificationThreshold;
    private final double detectionConfidenceThreshold;
    private final boolean recognitionEnabled;
    private final FacialRecognitionAuditSink auditSink;

    private FacialRecognitionService(
            FaceRecognitionModel model,
            double identificationThreshold,
            double detectionConfidenceThreshold,
            boolean recognitionEnabled,
            FacialRecognitionAuditSink auditSink) {
        this.model = model;
        this.identificationThreshold = identificationThreshold;
        this.detectionConfidenceThreshold = detectionConfidenceThreshold;
        this.recognitionEnabled = recognitionEnabled;
        this.auditSink = auditSink;
    }

    /**
     * Creates a service with the given model and a default identification threshold of 0.85.
     *
     * @param model the face recognition model
     * @return a new service instance
     * @throws NullPointerException if model is null
     */
    public static FacialRecognitionService of(FaceRecognitionModel model) {
        Objects.requireNonNull(model, "model must not be null");
        return new FacialRecognitionService(model, 0.85, 0.5, true, FacialRecognitionAuditSink.noop());
    }

    /**
     * Creates a service with an explicit identification threshold.
     *
     * @param model                   the face recognition model
     * @param identificationThreshold similarity threshold to confirm identity in [0, 1]
     * @return a new service instance
     * @throws NullPointerException     if model is null
     * @throws IllegalArgumentException if threshold is out of range
     */
    public static FacialRecognitionService of(FaceRecognitionModel model, double identificationThreshold) {
        Objects.requireNonNull(model, "model must not be null");
        if (identificationThreshold < 0 || identificationThreshold > 1) {
            throw new IllegalArgumentException("identificationThreshold must be in [0, 1]");
        }
        return new FacialRecognitionService(model, identificationThreshold, 0.5, true, FacialRecognitionAuditSink.noop());
    }

    public static FacialRecognitionService of(
            FaceRecognitionModel model,
            double identificationThreshold,
            double detectionConfidenceThreshold,
            boolean recognitionEnabled,
            FacialRecognitionAuditSink auditSink) {
        Objects.requireNonNull(model, "model must not be null");
        Objects.requireNonNull(auditSink, "auditSink must not be null");
        if (identificationThreshold < 0 || identificationThreshold > 1) {
            throw new IllegalArgumentException("identificationThreshold must be in [0, 1]");
        }
        if (detectionConfidenceThreshold < 0 || detectionConfidenceThreshold > 1) {
            throw new IllegalArgumentException("detectionConfidenceThreshold must be in [0, 1]");
        }
        return new FacialRecognitionService(
                model,
                identificationThreshold,
                detectionConfidenceThreshold,
                recognitionEnabled,
                auditSink);
    }

    // ─── detect ───────────────────────────────────────────────────────────────

    /**
     * Detects all faces in the given image bytes.
     *
     * @param imageBytes raw image bytes (JPEG, PNG, etc.)
     * @return an unmodifiable list of detected faces
     * @throws NullPointerException     if imageBytes is null
     * @throws IllegalArgumentException if imageBytes is empty
     */
    public List<FaceDetection> detect(byte[] imageBytes) {
        Objects.requireNonNull(imageBytes, "imageBytes must not be null");
        if (imageBytes.length == 0) {
            throw new IllegalArgumentException("imageBytes must not be empty");
        }
        List<FaceDetection> detections = model.detectFaces(imageBytes).stream()
                .filter(face -> face.confidence() >= detectionConfidenceThreshold)
                .toList();
        LOG.debug("Facial detection: {} face(s) detected in {} byte image",
                detections.size(), imageBytes.length);
        return Collections.unmodifiableList(new ArrayList<>(detections));
    }

    /**
     * Identifies a face embedding against a set of enrolled identity embeddings.
     *
     * @param faceEmbedding    the query face embedding
     * @param enrolledIdentities map of {@code identityId → embedding} for enrolled persons
     * @return the best matching identity if similarity exceeds the threshold, or empty
     * @throws NullPointerException if any argument is null
     */
    public Optional<IdentityMatch> identify(
            float[] faceEmbedding,
            java.util.Map<String, float[]> enrolledIdentities) {
        return identify(faceEmbedding, enrolledIdentities, true, "system");
    }

    public Optional<IdentityMatch> identify(
            float[] faceEmbedding,
            java.util.Map<String, float[]> enrolledIdentities,
            boolean consentGranted,
            String actorId) {
        Objects.requireNonNull(faceEmbedding, "faceEmbedding must not be null");
        Objects.requireNonNull(enrolledIdentities, "enrolledIdentities must not be null");
        Objects.requireNonNull(actorId, "actorId must not be null");

        if (!recognitionEnabled) {
            auditSink.record(FacialRecognitionAuditEvent.denied("feature_disabled", actorId));
            return Optional.empty();
        }
        if (!consentGranted) {
            auditSink.record(FacialRecognitionAuditEvent.denied("consent_missing", actorId));
            return Optional.empty();
        }

        String bestId = null;
        double bestSim = -1.0;

        for (var entry : enrolledIdentities.entrySet()) {
            double sim = cosineSimilarity(faceEmbedding, entry.getValue());
            if (sim > bestSim) {
                bestSim = sim;
                bestId = entry.getKey();
            }
        }

        if (bestId != null && bestSim >= identificationThreshold) {
            LOG.debug("Face identified as '{}' (similarity={})", bestId, bestSim);
            IdentityMatch match = new IdentityMatch(bestId, bestSim);
            auditSink.record(FacialRecognitionAuditEvent.success(actorId, bestId, bestSim));
            return Optional.of(match);
        }
        auditSink.record(FacialRecognitionAuditEvent.noMatch(actorId, bestSim));
        return Optional.empty();
    }

    // ─── internal ─────────────────────────────────────────────────────────────

    private static double cosineSimilarity(float[] a, float[] b) {
        double dot = 0, normA = 0, normB = 0;
        for (int i = 0; i < Math.min(a.length, b.length); i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        if (normA == 0 || normB == 0) return 0.0;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    // ─── domain types ─────────────────────────────────────────────────────────

    /** Pluggable face detection/embedding model. */
    public interface FaceRecognitionModel {
        /**
         * Detects faces in the given image bytes and returns bounding boxes + embeddings.
         *
         * @param imageBytes raw image bytes
         * @return list of detected faces
         */
        List<FaceDetection> detectFaces(byte[] imageBytes);
    }

    public interface FacialRecognitionAuditSink {
        void record(FacialRecognitionAuditEvent event);

        static FacialRecognitionAuditSink noop() {
            return event -> {
            };
        }
    }

    public record FacialRecognitionAuditEvent(
            String outcome,
            String actorId,
            String identityId,
            double similarity,
            String reason
    ) {
        static FacialRecognitionAuditEvent success(String actorId, String identityId, double similarity) {
            return new FacialRecognitionAuditEvent("success", actorId, identityId, similarity, "");
        }

        static FacialRecognitionAuditEvent noMatch(String actorId, double similarity) {
            return new FacialRecognitionAuditEvent("no_match", actorId, "", similarity, "below_threshold");
        }

        static FacialRecognitionAuditEvent denied(String reason, String actorId) {
            return new FacialRecognitionAuditEvent("denied", actorId, "", 0.0, reason);
        }
    }

    /**
     * A detected face with bounding box and optional embedding.
     *
     * @param faceId    unique identifier for this face detection
     * @param boundingBox bounding box in relative coordinates [0,1]
     * @param confidence  detection confidence in [0,1]
     * @param embedding   face embedding vector (may be empty if not supported)
     */
    public record FaceDetection(
            String faceId,
            BoundingBox boundingBox,
            double confidence,
            float[] embedding
    ) {
        public FaceDetection {
            Objects.requireNonNull(faceId, "faceId must not be null");
            Objects.requireNonNull(boundingBox, "boundingBox must not be null");
            Objects.requireNonNull(embedding, "embedding must not be null");
            if (confidence < 0 || confidence > 1) {
                throw new IllegalArgumentException("confidence must be in [0, 1]");
            }
        }

        /** Factory: creates a face detection with a random ID. */
        public static FaceDetection of(BoundingBox box, double confidence, float[] embedding) {
            return new FaceDetection(UUID.randomUUID().toString(), box, confidence, embedding);
        }
    }

    /**
     * Bounding box in relative image coordinates (all values in [0, 1]).
     *
     * @param x      left edge
     * @param y      top edge
     * @param width  width
     * @param height height
     */
    public record BoundingBox(double x, double y, double width, double height) {}

    /**
     * An identity match result from the identification step.
     *
     * @param identityId the matched enrolled identity ID
     * @param similarity the cosine similarity score
     */
    public record IdentityMatch(String identityId, double similarity) {}
}
