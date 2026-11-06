package com.ghatana.media.production.review;

import static com.ghatana.media.production.review.ReviewContracts.*;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Single-process development/test store. It is not a canonical or multi-host review writer. */
public final class InMemoryReviewStore implements ReviewStore {
    private final Map<CaseKey, CaseState> cases = new HashMap<>();
    private final Map<IdempotencyKey, IdempotencyEntry> idempotency = new HashMap<>();

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
        Objects.requireNonNull(actor, "actor");
        Objects.requireNonNull(reviewCase, "reviewCase");
        if (!actor.tenantId().equals(reviewCase.tenantId())) throw new ReviewCaseMismatchException();
        CaseState state = cases.get(new CaseKey(reviewCase.tenantId(), reviewCase.reviewCaseId()));
        if (state == null || !state.ref.equals(reviewCase)) throw new ReviewCaseMismatchException();

        IdempotencyKey idempotencyKey = new IdempotencyKey(actor.tenantId(), actor.principalId(), requestId);
        IdempotencyEntry previous = idempotency.get(idempotencyKey);
        if (previous != null) {
            if (!previous.fingerprint.equals(fingerprint)) throw new ReviewIdempotencyConflictException();
            return previous.record;
        }
        if (state.records.size() != expectedCaseRevision) {
            throw new ReviewConflictException(expectedCaseRevision, state.records.size());
        }
        ReviewRecord record = new ReviewRecord(appendRecordId, actor.tenantId(), reviewCase.reviewCaseId(),
                reviewCase.reviewSubjectRef(), requestId, payload.operationId(), actor, payload,
                state.records.size() + 1L, createdAt, authorityVersion);
        state.records.add(record);
        idempotency.put(idempotencyKey, new IdempotencyEntry(fingerprint, record));
        return record;
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

    private record CaseKey(String tenantId, String caseId) { }
    private record IdempotencyKey(String tenantId, String principalId, String requestId) { }

    private static final class CaseState {
        private final ReviewCaseRef ref;
        private final List<ReviewRecord> records = new ArrayList<>();
        private CaseState(ReviewCaseRef ref) { this.ref = ref; }
    }

    private record IdempotencyEntry(String fingerprint, ReviewRecord record) { }
}
