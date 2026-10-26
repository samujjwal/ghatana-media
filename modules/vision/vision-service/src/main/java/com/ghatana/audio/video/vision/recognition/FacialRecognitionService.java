package com.ghatana.audio.video.vision.recognition;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Supplier;

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

    private final FaceRecognitionModel model;
    private final double identificationThreshold;
    private final double detectionConfidenceThreshold;
    private final boolean recognitionEnabled;
    private final FacialRecognitionAuditSink auditSink;
    private final BiometricAdmissionResolver admissionResolver;
    private final Supplier<JwtServerInterceptor.VerifiedIdentity> verifiedIdentity;
    private final Clock clock;

    private FacialRecognitionService(
            FaceRecognitionModel model,
            double identificationThreshold,
            double detectionConfidenceThreshold,
            boolean recognitionEnabled,
            FacialRecognitionAuditSink auditSink,
            BiometricAdmissionResolver admissionResolver,
            Supplier<JwtServerInterceptor.VerifiedIdentity> verifiedIdentity,
            Clock clock) {
        this.model = model;
        this.identificationThreshold = identificationThreshold;
        this.detectionConfidenceThreshold = detectionConfidenceThreshold;
        this.recognitionEnabled = recognitionEnabled;
        this.auditSink = auditSink;
        this.admissionResolver = admissionResolver;
        this.verifiedIdentity = Objects.requireNonNull(verifiedIdentity, "verifiedIdentity");
        this.clock = Objects.requireNonNull(clock, "clock");
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
        return new FacialRecognitionService(model, 0.85, 0.5, true, FacialRecognitionAuditSink.noop(),
                null, JwtServerInterceptor::verifiedIdentity, Clock.systemUTC());
    }

    /**
     * Creates a service with an authority resolver supplied by the trusted application composition.
     * The resolver must bind the verified transport identity and every request reference to current
     * source rights, biometric purpose, consent/revocation, processing region, and retention policy.
     *
     * <p>Without a resolver, or without a verified gRPC identity, restricted provider calls remain
     * unavailable. Request labels are selectors for authority lookup and never grant permission.</p>
     */
    public static FacialRecognitionService of(
            FaceRecognitionModel model,
            BiometricAdmissionResolver admissionResolver) {
        Objects.requireNonNull(model, "model must not be null");
        Objects.requireNonNull(admissionResolver, "admissionResolver must not be null");
        return new FacialRecognitionService(model, 0.85, 0.5, true, FacialRecognitionAuditSink.noop(),
                admissionResolver, JwtServerInterceptor::verifiedIdentity, Clock.systemUTC());
    }

    /** Test-only composition seam for exercising authenticated request decisions without a gRPC server. */
    static FacialRecognitionService ofForTesting(
            FaceRecognitionModel model,
            BiometricAdmissionResolver admissionResolver,
            Supplier<JwtServerInterceptor.VerifiedIdentity> verifiedIdentity,
            Clock clock) {
        Objects.requireNonNull(model, "model must not be null");
        return new FacialRecognitionService(model, 0.85, 0.5, true, FacialRecognitionAuditSink.noop(),
                admissionResolver, verifiedIdentity, clock);
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
        return new FacialRecognitionService(model, identificationThreshold, 0.5, true,
                FacialRecognitionAuditSink.noop(), null, JwtServerInterceptor::verifiedIdentity, Clock.systemUTC());
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
                auditSink,
                null,
                JwtServerInterceptor::verifiedIdentity,
                Clock.systemUTC());
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
        throw new NotAdmittedException();
    }

    /**
     * Performs sensitive face detection only after a fresh authority decision for this request.
     * This overload is intentionally unavailable unless the trusted composition supplied a resolver.
     */
    public List<FaceDetection> detect(byte[] imageBytes, BiometricRequest request) {
        Objects.requireNonNull(imageBytes, "imageBytes must not be null");
        Objects.requireNonNull(request, "request must not be null");
        if (imageBytes.length == 0) throw new IllegalArgumentException("imageBytes must not be empty");
        if (request.operation() != BiometricOperation.FACE_DETECTION) throw new NotAdmittedException();
        requireAdmission(request);
        return List.copyOf(Objects.requireNonNull(model.detectFaces(imageBytes), "face model result"));
    }

    private void requireAdmission(BiometricRequest request) {
        JwtServerInterceptor.VerifiedIdentity identity = verifiedIdentity.get();
        if (admissionResolver == null || identity == null
                || identity.subject() == null || identity.subject().isBlank()
                || identity.tenantId() == null || identity.tenantId().isBlank()) {
            throw new NotAdmittedException();
        }
        Instant now = clock.instant();
        final BiometricAdmission admission;
        try {
            admission = admissionResolver.resolve(identity, request);
        } catch (RuntimeException unavailable) {
            throw new NotAdmittedException();
        }
        if (admission == null || !admission.allowed()
                || !identity.tenantId().equals(admission.tenantId())
                || !identity.subject().equals(admission.principalId())
                || !request.operation().equals(admission.operation())
                || !request.sourceArtifactId().equals(admission.sourceArtifactId())
                || !request.sourceVersion().equals(admission.sourceVersion())
                || !request.purpose().equals(admission.purpose())
                || !request.region().equals(admission.region())
                || !request.retentionPolicy().equals(admission.retentionPolicy())
                || admission.decisionRef() == null || admission.decisionRef().isBlank()
                || admission.checkedAt() == null || admission.checkedAt().isAfter(now)
                || admission.expiresAt() == null || !admission.expiresAt().isAfter(now)) {
            throw new NotAdmittedException();
        }
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

        // Consent booleans and caller supplied identities are not trusted
        // authority. Do not call the model or emit an audit payload.
        throw new NotAdmittedException();

    }

    /** Restricted face analysis has no admitted authority or provider in this service. */
    public static final class NotAdmittedException extends SecurityException {
        public NotAdmittedException() {
            super("NOT_ADMITTED: trusted biometric rights authority is unavailable");
        }
    }

    /** Trusted authority boundary. Production composition must back this with current source/rights policy. */
    @FunctionalInterface
    public interface BiometricAdmissionResolver {
        BiometricAdmission resolve(JwtServerInterceptor.VerifiedIdentity identity, BiometricRequest request);
    }

    public enum BiometricOperation {
        FACE_DETECTION,
        FACE_LANDMARKS,
        GAZE_ANALYSIS,
        EXPRESSION_ANALYSIS,
        FACE_IDENTIFICATION
    }

    /** Untrusted operation/source/policy selectors; each must be echoed by the trusted decision. */
    public record BiometricRequest(
            BiometricOperation operation,
            String sourceArtifactId,
            String sourceVersion,
            String purpose,
            String region,
            String retentionPolicy) {
        public BiometricRequest {
            Objects.requireNonNull(operation, "operation");
            sourceArtifactId = required(sourceArtifactId, "sourceArtifactId");
            sourceVersion = required(sourceVersion, "sourceVersion");
            purpose = required(purpose, "purpose");
            region = required(region, "region");
            retentionPolicy = required(retentionPolicy, "retentionPolicy");
        }
    }

    /** Authority-owned, request-scoped decision. The resolver must recheck revocation before each call. */
    public record BiometricAdmission(
            boolean allowed,
            String tenantId,
            String principalId,
            BiometricOperation operation,
            String sourceArtifactId,
            String sourceVersion,
            String purpose,
            String region,
            String retentionPolicy,
            String decisionRef,
            Instant checkedAt,
            Instant expiresAt,
            String denialReason) {
        public static BiometricAdmission denied(String reason) {
            return new BiometricAdmission(false, "", "", null, "", "", "", "", "", "",
                    null, null, required(reason, "reason"));
        }
    }

    private static String required(String value, String field) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(field + " is required");
        return value.trim();
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
     * A face-region observation with a bounding box. Geometry is not an
     * identity assertion; identity results use the separate {@link IdentityMatch}
     * type and remain unavailable without admitted biometric rights.
     *
     * @param faceId    ephemeral identifier for this detection only; not a person identity
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
            if (faceId.isBlank()) {
                throw new IllegalArgumentException("faceId must not be blank");
            }
            Objects.requireNonNull(boundingBox, "boundingBox must not be null");
            Objects.requireNonNull(embedding, "embedding must not be null");
            if (!Double.isFinite(confidence) || confidence < 0 || confidence > 1) {
                throw new IllegalArgumentException("confidence must be finite and in [0, 1]");
            }
            embedding = embedding.clone();
            for (float value : embedding) {
                if (!Float.isFinite(value)) {
                    throw new IllegalArgumentException("embedding values must be finite");
                }
            }
        }

        @Override
        public float[] embedding() {
            return embedding.clone();
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
    public record BoundingBox(double x, double y, double width, double height) {
        public BoundingBox {
            if (!Double.isFinite(x) || !Double.isFinite(y)
                    || !Double.isFinite(width) || !Double.isFinite(height)
                    || x < 0 || y < 0 || width <= 0 || height <= 0
                    || x + width > 1 || y + height > 1) {
                throw new IllegalArgumentException("Face bounding box must be a positive normalized box within [0,1]");
            }
        }
    }

    /**
     * An identity match result from the identification step.
     *
     * @param identityId the matched enrolled identity ID
     * @param similarity the cosine similarity score
     */
    public record IdentityMatch(String identityId, double similarity) {}
}
