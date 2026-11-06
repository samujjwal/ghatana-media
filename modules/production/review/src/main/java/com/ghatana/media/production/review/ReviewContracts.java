package com.ghatana.media.production.review;

import java.time.Instant;
import java.util.List;
import java.util.Objects;

/** Exact-version review record types. A recorded decision is not an owner approval or publication grant. */
public final class ReviewContracts {
    private ReviewContracts() { }

    public enum SubjectKind { ARTIFACT_VERSION, PROJECT_REVISION, TRANSCRIPT_VERSION, CAPTION_VERSION, PROCESSING_JOB }
    public enum ClockDomain { SOURCE_PRESENTATION, STORY }
    public enum CommentDisposition { OPEN, RESOLVED, NEEDS_OWNER_RESPONSE }
    public enum Decision { ACCEPT, REJECT, REQUEST_CHANGES, DEFER }
    public enum AuthorizationStatus { ALLOW, DENY, UNKNOWN }
    public enum RetentionStatus { ACTIVE, EXPIRED, UNKNOWN }
    public enum Currentness { CURRENT, STALE, UNKNOWN }

    /** Host-attested identity supplied by the caller boundary; a role label is never accepted here. */
    public record Actor(String tenantId, String principalId) {
        public Actor {
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
        }
    }

    /** Opaque immutable object version, not a digest or a mutable alias. */
    public record ExactVersionRef(SubjectKind kind, String objectId, String versionId) {
        public ExactVersionRef {
            Objects.requireNonNull(kind, "kind");
            objectId = opaque(objectId, "objectId");
            versionId = opaque(versionId, "versionId");
        }

        public String reference() { return kind.name().toLowerCase() + ":" + objectId + "@" + versionId; }
    }

    /** Owner-issued review-case correlation. This module does not create or mint case authority. */
    public record ReviewCaseRef(String tenantId, String reviewCaseId, String exactTargetRef,
                                ExactVersionRef reviewSubjectRef, String scopeRef) {
        public ReviewCaseRef {
            tenantId = required(tenantId, "tenantId");
            reviewCaseId = opaque(reviewCaseId, "reviewCaseId");
            exactTargetRef = required(exactTargetRef, "exactTargetRef");
            Objects.requireNonNull(reviewSubjectRef, "reviewSubjectRef");
            scopeRef = required(scopeRef, "scopeRef");
            if (!exactTargetRef.equals(reviewSubjectRef.reference())) {
                throw new IllegalArgumentException("exactTargetRef and reviewSubjectRef must identify the same immutable version");
            }
        }
    }

    public record RationalTime(long ticks, long rateNumerator, long rateDenominator, ClockDomain clock) {
        public RationalTime {
            if (ticks < 0 || rateNumerator < 1 || rateDenominator < 1) {
                throw new IllegalArgumentException("time must be non-negative and rate components positive");
            }
            Objects.requireNonNull(clock, "clock");
            long gcd = gcd(rateNumerator, rateDenominator);
            rateNumerator /= gcd;
            rateDenominator /= gcd;
        }

        private static long gcd(long left, long right) {
            while (right != 0) { long next = left % right; left = right; right = next; }
            return left;
        }
    }

    public record TimeRange(RationalTime start, RationalTime end) {
        public TimeRange {
            Objects.requireNonNull(start, "start");
            Objects.requireNonNull(end, "end");
            if (start.clock() != end.clock()) throw new IllegalArgumentException("annotation time range must use one clock");
            java.math.BigInteger left = java.math.BigInteger.valueOf(start.ticks())
                    .multiply(java.math.BigInteger.valueOf(start.rateDenominator()))
                    .multiply(java.math.BigInteger.valueOf(end.rateNumerator()));
            java.math.BigInteger right = java.math.BigInteger.valueOf(end.ticks())
                    .multiply(java.math.BigInteger.valueOf(end.rateDenominator()))
                    .multiply(java.math.BigInteger.valueOf(start.rateNumerator()));
            if (left.compareTo(right) >= 0) throw new IllegalArgumentException("annotation end must follow start");
        }
    }

    /** Normalized top-left-origin ROI, bounded to the unit square. */
    public record NormalizedRoi(double x, double y, double width, double height) {
        public NormalizedRoi {
            if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(width) || !Double.isFinite(height)
                    || x < 0 || y < 0 || width <= 0 || height <= 0
                    || exceedsUnitSquare(x, width) || exceedsUnitSquare(y, height)) {
                throw new IllegalArgumentException("ROI must be finite, positive, and contained in the normalized unit square");
            }
        }

        private static boolean exceedsUnitSquare(double origin, double extent) {
            // Floating-point addition can round a genuine overrun back to 1.0 (for example,
            // 1.0 + Double.MIN_VALUE). Compare the caller's decimal values without that loss.
            return java.math.BigDecimal.valueOf(origin).add(java.math.BigDecimal.valueOf(extent))
                    .compareTo(java.math.BigDecimal.ONE) > 0;
        }
    }

    public record Annotation(TimeRange timeRange, NormalizedRoi roi) {
        public Annotation {
            if (timeRange == null && roi == null) {
                throw new IllegalArgumentException("annotation must include a time range, ROI, or both");
            }
        }
    }

    public sealed interface Payload permits Comment, DecisionRecord {
        String operationId();
        String textForSanitization();
        Payload withSanitizedText(String text);
    }

    public record Comment(String text, CommentDisposition disposition, Annotation annotation) implements Payload {
        public Comment {
            text = boundedText(text, 10_000, "commentText");
            Objects.requireNonNull(disposition, "disposition");
        }
        @Override public String operationId() { return "media.operation.action.record-review-comment"; }
        @Override public String textForSanitization() { return text; }
        @Override public Payload withSanitizedText(String safe) { return new Comment(safe, disposition, annotation); }
    }

    /** An append-only reviewer statement. ACCEPT does not mean HUMAN_REVIEW_APPROVAL or authorize delivery. */
    public record DecisionRecord(Decision decision, String reason) implements Payload {
        public DecisionRecord {
            Objects.requireNonNull(decision, "decision");
            reason = boundedText(reason, 4_000, "reason");
        }
        @Override public String operationId() { return "media.operation.action.record-version-review-decision"; }
        @Override public String textForSanitization() { return reason; }
        @Override public Payload withSanitizedText(String safe) { return new DecisionRecord(decision, safe); }
    }

    public record Confirmation(String operationId, String exactTargetRef, boolean acknowledged) {
        public Confirmation {
            operationId = required(operationId, "operationId");
            exactTargetRef = required(exactTargetRef, "exactTargetRef");
        }
    }

    public record AppendRequest(ReviewCaseRef reviewCase, long expectedCaseRevision, String expectedAuthorityVersion,
                                String requestId,
                                Confirmation confirmation, Payload payload) {
        public AppendRequest {
            Objects.requireNonNull(reviewCase, "reviewCase");
            if (expectedCaseRevision < 0) throw new IllegalArgumentException("expectedCaseRevision must be non-negative");
            expectedAuthorityVersion = opaque(expectedAuthorityVersion, "expectedAuthorityVersion");
            requestId = opaque(requestId, "requestId");
            Objects.requireNonNull(confirmation, "confirmation");
            Objects.requireNonNull(payload, "payload");
        }
    }

    public record AuthorizationDecision(AuthorizationStatus status, String tenantId, String principalId,
                                        String reviewCaseId, String exactTargetRef, String scopeRef,
                                        String authorityVersion, Instant validUntil,
                                        String currentMaterialVersionRef, RetentionStatus retentionStatus) {
        public AuthorizationDecision {
            Objects.requireNonNull(status, "status");
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            reviewCaseId = opaque(reviewCaseId, "reviewCaseId");
            exactTargetRef = required(exactTargetRef, "exactTargetRef");
            scopeRef = required(scopeRef, "scopeRef");
            authorityVersion = required(authorityVersion, "authorityVersion");
            Objects.requireNonNull(validUntil, "validUntil");
            Objects.requireNonNull(retentionStatus, "retentionStatus");
        }

        public Currentness currentnessFor(ExactVersionRef subject) {
            if (currentMaterialVersionRef == null || currentMaterialVersionRef.isBlank()) return Currentness.UNKNOWN;
            return currentMaterialVersionRef.equals(subject.reference()) ? Currentness.CURRENT : Currentness.STALE;
        }
    }

    @FunctionalInterface
    public interface AuthorizationPort {
        /** Must freshly verify identity, reviewer authority, exact case/target, currentness, and retention. */
        AuthorizationDecision evaluate(Actor actor, ReviewCaseRef reviewCase, String operationId, Instant now);
    }

    @FunctionalInterface
    public interface TextSanitizer {
        /** Returns a bounded, disclosure-safe value; the raw value must not be retained by the store. */
        String sanitize(String value);
    }

    public record ReviewRecord(String appendRecordId, String tenantId, String reviewCaseId,
                               ExactVersionRef reviewSubjectRef, String requestId, String operationId,
                               Actor actor, Payload payload, long caseRevision, Instant createdAt,
                               String authorityVersion) {
        public ReviewRecord {
            appendRecordId = opaque(appendRecordId, "appendRecordId");
            tenantId = required(tenantId, "tenantId");
            reviewCaseId = opaque(reviewCaseId, "reviewCaseId");
            Objects.requireNonNull(reviewSubjectRef, "reviewSubjectRef");
            requestId = opaque(requestId, "requestId");
            operationId = required(operationId, "operationId");
            Objects.requireNonNull(actor, "actor");
            Objects.requireNonNull(payload, "payload");
            if (caseRevision < 1) throw new IllegalArgumentException("caseRevision must be positive");
            Objects.requireNonNull(createdAt, "createdAt");
            authorityVersion = required(authorityVersion, "authorityVersion");
        }
    }

    public record AppendReceipt(String requestId, String reviewCaseId, ExactVersionRef reviewSubjectRef,
                               String appendRecordId, long caseRevision, Currentness currentness,
                               boolean establishesApproval, Instant observedAt) {
        public AppendReceipt {
            requestId = opaque(requestId, "requestId");
            reviewCaseId = opaque(reviewCaseId, "reviewCaseId");
            Objects.requireNonNull(reviewSubjectRef, "reviewSubjectRef");
            appendRecordId = opaque(appendRecordId, "appendRecordId");
            if (caseRevision < 1) throw new IllegalArgumentException("caseRevision must be positive");
            Objects.requireNonNull(currentness, "currentness");
            if (establishesApproval) throw new IllegalArgumentException("a Media review record cannot establish owner approval");
            Objects.requireNonNull(observedAt, "observedAt");
        }
    }

    public record RecordObservation(ReviewRecord record, Currentness currentness) {
        public RecordObservation { Objects.requireNonNull(record, "record"); Objects.requireNonNull(currentness, "currentness"); }
    }

    public record ReviewSnapshot(ReviewCaseRef reviewCase, long caseRevision, List<RecordObservation> records,
                                 Currentness currentness, Instant observedAt) {
        public ReviewSnapshot {
            Objects.requireNonNull(reviewCase, "reviewCase");
            if (caseRevision < 0) throw new IllegalArgumentException("caseRevision must be non-negative");
            records = List.copyOf(records);
            Objects.requireNonNull(currentness, "currentness");
            Objects.requireNonNull(observedAt, "observedAt");
        }
    }

    public interface ReviewStore {
        ReviewRecord append(Actor actor, ReviewCaseRef reviewCase, long expectedCaseRevision,
                            String requestId, String fingerprint, String appendRecordId,
                            String authorityVersion, Payload payload, Instant createdAt);
        List<ReviewRecord> read(Actor actor, ReviewCaseRef reviewCase);
    }

    public static final class ReviewDeniedException extends SecurityException {
        public ReviewDeniedException() { super("review action is not authorized for the exact target"); }
    }
    public static final class ReviewUnavailableException extends IllegalStateException {
        public ReviewUnavailableException() { super("review evidence is unavailable, expired, or not retained"); }
    }
    public static final class ReviewConflictException extends IllegalStateException {
        public ReviewConflictException(long expected, long actual) { super("review case changed: expected revision " + expected + " but found " + actual); }
    }
    public static final class ReviewRevisionExhaustedException extends IllegalStateException {
        public ReviewRevisionExhaustedException() { super("review case revision cannot advance beyond its maximum value"); }
    }
    public static final class ReviewAuthorityConflictException extends IllegalStateException {
        public ReviewAuthorityConflictException() { super("reviewer authority changed since the request was prepared"); }
    }
    public static final class ReviewIdempotencyConflictException extends IllegalStateException {
        public ReviewIdempotencyConflictException() { super("review requestId was reused with a different payload"); }
    }
    public static final class ReviewCaseMismatchException extends IllegalStateException {
        public ReviewCaseMismatchException() { super("review case does not match the exact requested tenant and immutable subject"); }
    }
    public static final class StaleReviewException extends IllegalStateException {
        public StaleReviewException() { super("review subject is stale relative to the current material version"); }
    }

    private static String boundedText(String value, int max, String name) {
        Objects.requireNonNull(value, name);
        if (value.isBlank() || value.length() > max) throw new IllegalArgumentException(name + " must contain 1-" + max + " characters");
        return value;
    }

    private static String opaque(String value, String name) {
        value = required(value, name);
        if (!value.matches("[A-Za-z0-9][A-Za-z0-9._~:-]{0,255}")) throw new IllegalArgumentException(name + " must be an opaque identifier");
        return value;
    }

    private static String required(String value, String name) {
        Objects.requireNonNull(value, name);
        if (value.isBlank()) throw new IllegalArgumentException(name + " must not be blank");
        return value;
    }
}
