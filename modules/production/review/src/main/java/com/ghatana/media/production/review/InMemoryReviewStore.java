package com.ghatana.media.production.review;

import static com.ghatana.media.production.review.ReviewContracts.*;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.Supplier;

/** Single-process development/test store. It is not a canonical or multi-host review writer. */
public final class InMemoryReviewStore implements ManagedReviewStore, ReviewAssignmentStore {
    private final Map<CaseKey, CaseState> cases = new HashMap<>();
    private final Map<IdempotencyKey, IdempotencyEntry> idempotency = new HashMap<>();
    private final Map<IdempotencyKey, AssignmentRequest> assignmentRequests = new HashMap<>();

    /** Seeds only externally issued case references; this adapter never mints owner case identity. */
    public InMemoryReviewStore(List<ReviewCaseRef> issuedCases) {
        for (ReviewCaseRef reviewCase : List.copyOf(issuedCases)) {
            Objects.requireNonNull(reviewCase, "reviewCase");
            if (cases.putIfAbsent(new CaseKey(reviewCase.tenantId(), reviewCase.reviewCaseId()), new CaseState(reviewCase)) != null) {
                throw new IllegalArgumentException("duplicate review case identity");
            }
        }
    }

    @Override
    public synchronized ReviewRecord append(Actor actor, ReviewCaseRef reviewCase, long expectedCaseRevision,
                                            String requestId, String fingerprint, String appendRecordId,
                                            String authorityVersion, Payload payload, java.time.Instant createdAt) {
        return appendWithReplay(actor, reviewCase, expectedCaseRevision, requestId, fingerprint, appendRecordId,
                authorityVersion, payload, createdAt).record();
    }

    @Override
    public synchronized StoreAppendResult appendWithReplay(Actor actor, ReviewCaseRef reviewCase,
                                            long expectedCaseRevision, String requestId, String fingerprint,
                                            String appendRecordId, String authorityVersion, Payload payload,
                                            java.time.Instant createdAt) {
        return appendWithReplayAndLazyId(actor, reviewCase, expectedCaseRevision, requestId, fingerprint,
                () -> appendRecordId, authorityVersion, payload, createdAt);
    }

    @Override
    public synchronized StoreAppendResult appendWithReplayAndLazyId(Actor actor, ReviewCaseRef reviewCase,
                                            long expectedCaseRevision, String requestId, String fingerprint,
                                            Supplier<String> appendRecordId, String authorityVersion, Payload payload,
                                            java.time.Instant createdAt) {
        Objects.requireNonNull(actor, "actor");
        Objects.requireNonNull(reviewCase, "reviewCase");
        Objects.requireNonNull(appendRecordId, "appendRecordId");
        if (!actor.tenantId().equals(reviewCase.tenantId())) throw new ReviewCaseMismatchException();
        CaseState state = cases.get(new CaseKey(reviewCase.tenantId(), reviewCase.reviewCaseId()));
        if (state == null || !state.ref.equals(reviewCase)) throw new ReviewCaseMismatchException();

        IdempotencyKey idempotencyKey = new IdempotencyKey(actor.tenantId(), actor.principalId(), requestId);
        IdempotencyEntry previous = idempotency.get(idempotencyKey);
        if (previous != null) {
            if (!previous.fingerprint.equals(fingerprint)) throw new ReviewIdempotencyConflictException();
            return new StoreAppendResult(previous.record, true);
        }
        if (state.records.size() != expectedCaseRevision) {
            throw new ReviewConflictException(expectedCaseRevision, state.records.size());
        }
        String allocatedId = Objects.requireNonNull(appendRecordId.get(), "appendRecordId");
        if (state.records.stream().anyMatch(record -> record.appendRecordId().equals(allocatedId))) {
            // V033 makes appendRecordId unique within the exact tenant/case scope. Keep this
            // development store fail-closed instead of accepting evidence PostgreSQL rejects.
            throw new ReviewUnavailableException();
        }
        ReviewRecord record = new ReviewRecord(allocatedId, actor.tenantId(), reviewCase.reviewCaseId(),
                reviewCase.reviewSubjectRef(), requestId, payload.operationId(), actor, payload,
                state.records.size() + 1L, createdAt, authorityVersion);
        state.records.add(record);
        idempotency.put(idempotencyKey, new IdempotencyEntry(fingerprint, record));
        return new StoreAppendResult(record, false);
    }

    @Override
    public synchronized List<ReviewRecord> read(Actor actor, ReviewCaseRef reviewCase) {
        Objects.requireNonNull(actor, "actor");
        Objects.requireNonNull(reviewCase, "reviewCase");
        if (!actor.tenantId().equals(reviewCase.tenantId())) throw new ReviewCaseMismatchException();
        CaseState state = cases.get(new CaseKey(reviewCase.tenantId(), reviewCase.reviewCaseId()));
        if (state == null || !state.ref.equals(reviewCase)) throw new ReviewCaseMismatchException();
        return List.copyOf(state.records);
    }

    @Override
    public synchronized void registerCase(ReviewCaseRef reviewCase) {
        Objects.requireNonNull(reviewCase, "reviewCase");
        CaseState existing = cases.putIfAbsent(new CaseKey(reviewCase.tenantId(), reviewCase.reviewCaseId()),
                new CaseState(reviewCase));
        if (existing != null && !existing.ref.equals(reviewCase)) throw new ReviewCaseMismatchException();
    }

    @Override
    public synchronized java.util.Optional<ReviewCaseRef> findCase(String tenantId, String reviewCaseId) {
        CaseState state = cases.get(new CaseKey(tenantId, reviewCaseId));
        return state == null ? java.util.Optional.empty() : java.util.Optional.of(state.ref);
    }

    @Override
    public synchronized AssignmentChange assign(ReviewCaseRef reviewCase, String ownerPrincipalId,
                                                String reviewerPrincipalId, java.util.Set<ReviewScope> scopes,
                                                java.time.Instant expiresAt, long expectedCaseRevision,
                                                String requestId, String fingerprint, Supplier<String> assignmentId,
                                                java.time.Instant now) {
        CaseState state = exactCase(reviewCase);
        IdempotencyKey key = new IdempotencyKey(reviewCase.tenantId(), ownerPrincipalId, requestId);
        AssignmentRequest previous = assignmentRequests.get(key);
        if (previous != null) {
            if (!previous.fingerprint.equals(fingerprint) || !previous.operation.equals("ASSIGN")
                    || !previous.caseId.equals(reviewCase.reviewCaseId())) throw new ReviewIdempotencyConflictException();
            return new AssignmentChange(current(state, previous.assignmentId), true);
        }
        if (state.records.size() != expectedCaseRevision) {
            throw new ReviewConflictException(expectedCaseRevision, state.records.size());
        }
        if (state.assignments.stream().anyMatch(a -> a.reviewerPrincipalId().equals(reviewerPrincipalId)
                && a.activeAt(now))) throw new ReviewAssignmentActiveException();
        ReviewAssignment created = new ReviewAssignment(Objects.requireNonNull(assignmentId.get()),
                reviewCase.tenantId(), reviewCase.reviewCaseId(), reviewerPrincipalId, ownerPrincipalId, scopes,
                expiresAt, AssignmentStatus.ACTIVE, 1, now, now, requestId);
        state.assignments.add(created);
        assignmentRequests.put(key, new AssignmentRequest("ASSIGN", fingerprint, reviewCase.reviewCaseId(),
                created.assignmentId()));
        return new AssignmentChange(created, false);
    }

    @Override
    public synchronized AssignmentChange revoke(ReviewCaseRef reviewCase, String ownerPrincipalId,
                                                String assignmentId, long expectedCaseRevision, String requestId,
                                                String fingerprint, java.time.Instant now) {
        CaseState state = exactCase(reviewCase);
        IdempotencyKey key = new IdempotencyKey(reviewCase.tenantId(), ownerPrincipalId, requestId);
        AssignmentRequest previous = assignmentRequests.get(key);
        if (previous != null) {
            if (!previous.fingerprint.equals(fingerprint) || !previous.operation.equals("REVOKE")
                    || !previous.caseId.equals(reviewCase.reviewCaseId())) throw new ReviewIdempotencyConflictException();
            return new AssignmentChange(current(state, previous.assignmentId), true);
        }
        if (state.records.size() != expectedCaseRevision) {
            throw new ReviewConflictException(expectedCaseRevision, state.records.size());
        }
        ReviewAssignment existing = current(state, assignmentId);
        if (existing.status() == AssignmentStatus.REVOKED) throw new ReviewAssignmentRevokedException();
        ReviewAssignment revoked = new ReviewAssignment(existing.assignmentId(), existing.tenantId(),
                existing.reviewCaseId(), existing.reviewerPrincipalId(), existing.assignedByPrincipalId(),
                existing.scopes(), existing.expiresAt(), AssignmentStatus.REVOKED,
                existing.assignmentVersion() + 1, existing.createdAt(), now, requestId);
        state.assignments.set(state.assignments.indexOf(existing), revoked);
        assignmentRequests.put(key, new AssignmentRequest("REVOKE", fingerprint, reviewCase.reviewCaseId(),
                assignmentId));
        return new AssignmentChange(revoked, false);
    }

    @Override
    public synchronized List<ReviewAssignment> assignments(ReviewCaseRef reviewCase) {
        return List.copyOf(exactCase(reviewCase).assignments);
    }

    private CaseState exactCase(ReviewCaseRef reviewCase) {
        Objects.requireNonNull(reviewCase, "reviewCase");
        CaseState state = cases.get(new CaseKey(reviewCase.tenantId(), reviewCase.reviewCaseId()));
        if (state == null || !state.ref.equals(reviewCase)) throw new ReviewCaseMismatchException();
        return state;
    }

    private static ReviewAssignment current(CaseState state, String assignmentId) {
        return state.assignments.stream().filter(a -> a.assignmentId().equals(assignmentId)).findFirst()
                .orElseThrow(ReviewAssignmentNotFoundException::new);
    }

    private record AssignmentRequest(String operation, String fingerprint, String caseId, String assignmentId) { }

    @Override public void close() { }

    private record CaseKey(String tenantId, String caseId) { }
    private record IdempotencyKey(String tenantId, String principalId, String requestId) { }

    private static final class CaseState {
        private final ReviewCaseRef ref;
        private final List<ReviewRecord> records = new ArrayList<>();
        private final List<ReviewAssignment> assignments = new ArrayList<>();
        private CaseState(ReviewCaseRef ref) { this.ref = ref; }
    }

    private record IdempotencyEntry(String fingerprint, ReviewRecord record) { }
}
