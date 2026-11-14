package com.ghatana.media.production.review;

import static com.ghatana.media.production.review.ReviewContracts.*;

import java.time.Instant;
import java.util.EnumSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.function.Supplier;

/**
 * DEV_ONLY reviewer assignment extension of a {@link ManagedReviewStore}. The case owner assigns a reviewer principal
 * (different from the owner) with an explicit scope set and an expiry. Assignments and revocations are immutable,
 * versioned rows written under the same case lock and revision CAS as review records, so they are durable and ordered
 * with the case. An assignment never establishes owner approval or a trusted human identity.
 */
public interface ReviewAssignmentStore {
    enum ReviewScope { QUALITY, RIGHTS, PROVENANCE, APPROVAL }
    enum AssignmentStatus { ACTIVE, REVOKED }

    /** Current state of one assignment; {@code assignmentVersion} is 1 on creation and increments on revocation. */
    record ReviewAssignment(String assignmentId, String tenantId, String reviewCaseId, String reviewerPrincipalId,
                            String assignedByPrincipalId, Set<ReviewScope> scopes, Instant expiresAt,
                            AssignmentStatus status, long assignmentVersion, Instant createdAt, Instant changedAt,
                            String requestId) {
        public ReviewAssignment {
            Objects.requireNonNull(assignmentId, "assignmentId");
            Objects.requireNonNull(tenantId, "tenantId");
            Objects.requireNonNull(reviewCaseId, "reviewCaseId");
            Objects.requireNonNull(reviewerPrincipalId, "reviewerPrincipalId");
            Objects.requireNonNull(assignedByPrincipalId, "assignedByPrincipalId");
            if (scopes == null || scopes.isEmpty()) throw new IllegalArgumentException("at least one scope is required");
            scopes = Set.copyOf(EnumSet.copyOf(scopes));
            Objects.requireNonNull(expiresAt, "expiresAt");
            Objects.requireNonNull(status, "status");
            if (assignmentVersion < 1) throw new IllegalArgumentException("assignmentVersion must be positive");
            Objects.requireNonNull(createdAt, "createdAt");
            Objects.requireNonNull(changedAt, "changedAt");
            Objects.requireNonNull(requestId, "requestId");
        }
        public boolean activeAt(Instant now) { return status == AssignmentStatus.ACTIVE && expiresAt.isAfter(now); }
    }

    /** Outcome of an assign/revoke; replayed is true when an earlier identical request's result was returned. */
    record AssignmentChange(ReviewAssignment assignment, boolean replayed) {
        public AssignmentChange { Objects.requireNonNull(assignment, "assignment"); }
    }

    /** A reviewer already holds an unexpired, unrevoked assignment on the case. */
    final class ReviewAssignmentActiveException extends IllegalStateException {
        public ReviewAssignmentActiveException() { super("reviewer already holds an active assignment on this case"); }
    }
    final class ReviewAssignmentNotFoundException extends IllegalStateException {
        public ReviewAssignmentNotFoundException() { super("review assignment does not exist on this case"); }
    }
    final class ReviewAssignmentRevokedException extends IllegalStateException {
        public ReviewAssignmentRevokedException() { super("review assignment is already revoked"); }
    }

    /**
     * Creates assignment version 1. Under the case lock: replays an identical (tenant, owner, requestId) request,
     * fails with {@link ReviewIdempotencyConflictException} on a different fingerprint, with
     * {@link ReviewConflictException} when expectedCaseRevision is not the current record revision and with
     * {@link ReviewAssignmentActiveException} when the reviewer's assignment is still active.
     */
    AssignmentChange assign(ReviewCaseRef reviewCase, String ownerPrincipalId, String reviewerPrincipalId,
                            Set<ReviewScope> scopes, Instant expiresAt, long expectedCaseRevision, String requestId,
                            String fingerprint, Supplier<String> assignmentId, Instant now);

    /** Appends the REVOKED version of an assignment under the same CAS/idempotency rules. */
    AssignmentChange revoke(ReviewCaseRef reviewCase, String ownerPrincipalId, String assignmentId,
                            long expectedCaseRevision, String requestId, String fingerprint, Instant now);

    /** Current state of every assignment on the case, oldest first. */
    List<ReviewAssignment> assignments(ReviewCaseRef reviewCase);
}
