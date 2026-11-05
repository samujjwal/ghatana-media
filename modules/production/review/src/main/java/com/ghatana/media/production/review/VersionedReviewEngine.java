package com.ghatana.media.production.review;

import static com.ghatana.media.production.review.ReviewContracts.*;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Supplier;

/** Append-only review records scoped to an owner-issued case and exact immutable version. */
public final class VersionedReviewEngine {
    private static final String INSPECT_OPERATION = "media.operation.action.inspect-version-and-review-scope";
    private final ReviewStore store;
    private final AuthorizationPort authorization;
    private final TextSanitizer sanitizer;
    private final Clock clock;
    private final Supplier<String> ids;

    public VersionedReviewEngine(ReviewStore store, AuthorizationPort authorization, TextSanitizer sanitizer, Clock clock) {
        this(store, authorization, sanitizer, clock, () -> UUID.randomUUID().toString());
    }

    public VersionedReviewEngine(ReviewStore store, AuthorizationPort authorization, TextSanitizer sanitizer,
                                 Clock clock, Supplier<String> ids) {
        this.store = Objects.requireNonNull(store, "store");
        this.authorization = Objects.requireNonNull(authorization, "authorization");
        this.sanitizer = Objects.requireNonNull(sanitizer, "sanitizer");
        this.clock = Objects.requireNonNull(clock, "clock");
        this.ids = Objects.requireNonNull(ids, "ids");
    }

    public AppendReceipt append(Actor actor, AppendRequest request) {
        Objects.requireNonNull(actor, "actor");
        Objects.requireNonNull(request, "request");
        ReviewCaseRef reviewCase = request.reviewCase();
        String operation = request.payload().operationId();
        if (!request.confirmation().acknowledged()
                || !request.confirmation().operationId().equals(operation)
                || !request.confirmation().exactTargetRef().equals(reviewCase.exactTargetRef())) {
            throw new ReviewDeniedException();
        }
        AuthorizationDecision authority = authorize(actor, reviewCase, operation);
        Currentness currentness = authority.currentnessFor(reviewCase.reviewSubjectRef());
        if (currentness == Currentness.UNKNOWN) throw new ReviewUnavailableException();
        if (request.payload() instanceof DecisionRecord && currentness != Currentness.CURRENT) {
            throw new StaleReviewException();
        }

        String safeText = sanitizer.sanitize(request.payload().textForSanitization());
        if (safeText == null || safeText.isBlank() || safeText.length() > (request.payload() instanceof Comment ? 10_000 : 4_000)) {
            throw new ReviewUnavailableException();
        }
        Payload safePayload = request.payload().withSanitizedText(safeText);
        String fingerprint = fingerprint(reviewCase, request.expectedCaseRevision(), safePayload);
        Instant now = clock.instant();
        ReviewRecord record = store.append(actor, reviewCase, request.expectedCaseRevision(), request.requestId(),
                fingerprint, nextId(), authority.authorityVersion(), safePayload, now);
        return new AppendReceipt(request.requestId(), reviewCase.reviewCaseId(), reviewCase.reviewSubjectRef(),
                record.appendRecordId(), record.caseRevision(), currentness, false, now);
    }

    public ReviewSnapshot inspect(Actor actor, ReviewCaseRef reviewCase) {
        Objects.requireNonNull(actor, "actor");
        Objects.requireNonNull(reviewCase, "reviewCase");
        AuthorizationDecision authority = authorize(actor, reviewCase, INSPECT_OPERATION);
        Currentness currentness = authority.currentnessFor(reviewCase.reviewSubjectRef());
        if (currentness == Currentness.UNKNOWN) throw new ReviewUnavailableException();
        List<RecordObservation> observations = store.read(actor, reviewCase).stream()
                .map(record -> new RecordObservation(redacted(record), currentness)).toList();
        return new ReviewSnapshot(reviewCase, observations.size(), observations, currentness, clock.instant());
    }

    private AuthorizationDecision authorize(Actor actor, ReviewCaseRef reviewCase, String operation) {
        if (!actor.tenantId().equals(reviewCase.tenantId())) throw new ReviewDeniedException();
        Instant now = clock.instant();
        AuthorizationDecision decision = authorization.evaluate(actor, reviewCase, operation, now);
        if (decision == null || decision.status() == AuthorizationStatus.UNKNOWN) throw new ReviewUnavailableException();
        if (decision.status() != AuthorizationStatus.ALLOW
                || !decision.tenantId().equals(actor.tenantId())
                || !decision.principalId().equals(actor.principalId())
                || !decision.exactTargetRef().equals(reviewCase.exactTargetRef())) {
            throw new ReviewDeniedException();
        }
        if (!decision.validUntil().isAfter(now) || decision.retentionStatus() == RetentionStatus.UNKNOWN) {
            throw new ReviewUnavailableException();
        }
        if (decision.retentionStatus() != RetentionStatus.ACTIVE) throw new ReviewDeniedException();
        return decision;
    }

    private ReviewRecord redacted(ReviewRecord record) {
        String safe = sanitizer.sanitize(record.payload().textForSanitization());
        if (safe == null || safe.isBlank()) throw new ReviewUnavailableException();
        return new ReviewRecord(record.appendRecordId(), record.tenantId(), record.reviewCaseId(), record.reviewSubjectRef(),
                record.requestId(), record.operationId(), record.actor(), record.payload().withSanitizedText(safe),
                record.caseRevision(), record.createdAt(), record.authorityVersion());
    }

    private static String fingerprint(ReviewCaseRef reviewCase, long expectedCaseRevision, Payload payload) {
        return reviewCase.tenantId() + "\u0000" + reviewCase.reviewCaseId() + "\u0000"
                + reviewCase.exactTargetRef() + "\u0000" + reviewCase.scopeRef() + "\u0000"
                + expectedCaseRevision + "\u0000" + payload.operationId() + "\u0000" + payload.toString();
    }

    private String nextId() {
        String id = ids.get();
        if (id == null || id.isBlank()) throw new IllegalStateException("id supplier returned blank value");
        return id;
    }
}
