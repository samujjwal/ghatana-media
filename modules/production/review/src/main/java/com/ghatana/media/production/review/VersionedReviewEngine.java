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
        long expectedNextRevision;
        try {
            expectedNextRevision = Math.addExact(request.expectedCaseRevision(), 1L);
        } catch (ArithmeticException exhausted) {
            throw new ReviewRevisionExhaustedException();
        }
        AuthorizationDecision authority = authorize(actor, reviewCase, operation);
        requireExpectedAuthorityVersion(request.expectedAuthorityVersion(), authority);
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
        // Recheck role/capability, exact target, currentness and retention at the write boundary.
        AuthorizationDecision effectAuthority = authorize(actor, reviewCase, operation);
        requireExpectedAuthorityVersion(request.expectedAuthorityVersion(), effectAuthority);
        Currentness effectCurrentness = effectAuthority.currentnessFor(reviewCase.reviewSubjectRef());
        if (effectCurrentness == Currentness.UNKNOWN) throw new ReviewUnavailableException();
        if (safePayload instanceof DecisionRecord && effectCurrentness != Currentness.CURRENT) {
            throw new StaleReviewException();
        }
        String fingerprint = fingerprint(reviewCase, request.expectedCaseRevision(),
                request.expectedAuthorityVersion(), safePayload);
        Instant now = clock.instant();
        if (!effectAuthority.validUntil().isAfter(now)) throw new ReviewUnavailableException();
        String appendRecordId = nextId();
        ReviewRecord record;
        try {
            record = store.append(actor, reviewCase, request.expectedCaseRevision(), request.requestId(),
                    fingerprint, appendRecordId, effectAuthority.authorityVersion(), safePayload, now);
        } catch (ReviewDeniedException | ReviewConflictException | ReviewRevisionExhaustedException
                 | ReviewAuthorityConflictException | ReviewIdempotencyConflictException
                 | ReviewCaseMismatchException | StaleReviewException | ReviewUnavailableException known) {
            throw known;
        } catch (RuntimeException uncertainStoreFailure) {
            // An adapter can fail after its transaction committed. Keep the request outcome
            // unknown so callers reconcile this same requestId instead of issuing a second write.
            throw new ReviewUnavailableException();
        }
        requireExactAppendReceipt(actor, reviewCase, request, expectedNextRevision, safePayload, effectAuthority, record);
        return new AppendReceipt(request.requestId(), reviewCase.reviewCaseId(), reviewCase.reviewSubjectRef(),
                record.appendRecordId(), record.caseRevision(), effectCurrentness, false, now);
    }

    public ReviewSnapshot inspect(Actor actor, ReviewCaseRef reviewCase) {
        Objects.requireNonNull(actor, "actor");
        Objects.requireNonNull(reviewCase, "reviewCase");
        authorize(actor, reviewCase, INSPECT_OPERATION);
        List<ReviewRecord> stored = store.read(actor, reviewCase);
        if (stored == null) throw new ReviewUnavailableException();
        List<ReviewRecord> ordered = stored.stream().map(record -> {
            requireExactReadback(actor, reviewCase, record);
            return record;
        }).sorted(java.util.Comparator.comparingLong(ReviewRecord::caseRevision)).toList();
        java.util.Set<String> appendRecordIds = new java.util.HashSet<>();
        for (int index = 0; index < ordered.size(); index++) {
            ReviewRecord record = ordered.get(index);
            if (record.caseRevision() != index + 1L || !appendRecordIds.add(record.appendRecordId())) {
                throw new ReviewUnavailableException();
            }
        }
        List<ReviewRecord> redactedRecords = ordered.stream().map(this::redacted).toList();
        // Recheck after storage and redaction, at the disclosure boundary. A read may race with
        // reviewer revocation or retention expiry just as an append can race with a material edit.
        AuthorizationDecision disclosureAuthority = authorize(actor, reviewCase, INSPECT_OPERATION);
        Currentness currentness = disclosureAuthority.currentnessFor(reviewCase.reviewSubjectRef());
        if (currentness == Currentness.UNKNOWN) throw new ReviewUnavailableException();
        List<RecordObservation> observations = redactedRecords.stream()
                .map(record -> new RecordObservation(record,
                        disclosureAuthority.currentnessFor(record.reviewSubjectRef()))).toList();
        return new ReviewSnapshot(reviewCase, observations.size(), observations, currentness, clock.instant());
    }

    private static void requireExactAppendReceipt(Actor actor, ReviewCaseRef reviewCase, AppendRequest request,
                                                  long expectedNextRevision, Payload payload, AuthorizationDecision authority,
                                                  ReviewRecord record) {
        if (record == null) throw new ReviewUnavailableException();
        if (!record.tenantId().equals(actor.tenantId())
                || !record.actor().equals(actor)
                || !record.reviewCaseId().equals(reviewCase.reviewCaseId())
                || !record.reviewSubjectRef().equals(reviewCase.reviewSubjectRef())
                || !record.requestId().equals(request.requestId())
                || !record.operationId().equals(payload.operationId())
                || !record.payload().equals(payload)
                || !record.authorityVersion().equals(authority.authorityVersion())
                || record.caseRevision() != expectedNextRevision) {
            throw new ReviewUnavailableException();
        }
    }

    private static void requireExactReadback(Actor actor, ReviewCaseRef reviewCase, ReviewRecord record) {
        if (record == null) throw new ReviewUnavailableException();
        if (!record.tenantId().equals(actor.tenantId())
                || !record.actor().tenantId().equals(actor.tenantId())
                || !record.reviewCaseId().equals(reviewCase.reviewCaseId())
                || !record.reviewSubjectRef().equals(reviewCase.reviewSubjectRef())) {
            throw new ReviewCaseMismatchException();
        }
        if (!record.operationId().equals(record.payload().operationId())) {
            throw new ReviewUnavailableException();
        }
    }

    private AuthorizationDecision authorize(Actor actor, ReviewCaseRef reviewCase, String operation) {
        if (!actor.tenantId().equals(reviewCase.tenantId())) throw new ReviewDeniedException();
        Instant now = clock.instant();
        AuthorizationDecision decision = authorization.evaluate(actor, reviewCase, operation, now);
        if (decision == null || decision.status() == AuthorizationStatus.UNKNOWN) throw new ReviewUnavailableException();
        if (decision.status() != AuthorizationStatus.ALLOW
                || !decision.tenantId().equals(actor.tenantId())
                || !decision.principalId().equals(actor.principalId())
                || !decision.reviewCaseId().equals(reviewCase.reviewCaseId())
                || !decision.exactTargetRef().equals(reviewCase.exactTargetRef())
                || !decision.scopeRef().equals(reviewCase.scopeRef())) {
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
        int maxLength = record.payload() instanceof Comment ? 10_000 : 4_000;
        if (safe == null || safe.isBlank() || safe.length() > maxLength) {
            throw new ReviewUnavailableException();
        }
        return new ReviewRecord(record.appendRecordId(), record.tenantId(), record.reviewCaseId(), record.reviewSubjectRef(),
                record.requestId(), record.operationId(), record.actor(), record.payload().withSanitizedText(safe),
                record.caseRevision(), record.createdAt(), record.authorityVersion());
    }

    private static String fingerprint(ReviewCaseRef reviewCase, long expectedCaseRevision,
                                      String expectedAuthorityVersion, Payload payload) {
        // Tenant/scope values are not all opaque identifiers and may contain separators. Encode
        // every component with an explicit length so distinct request tuples cannot alias.
        StringBuilder canonical = new StringBuilder();
        field(canonical, reviewCase.tenantId());
        field(canonical, reviewCase.reviewCaseId());
        field(canonical, reviewCase.exactTargetRef());
        field(canonical, reviewCase.scopeRef());
        field(canonical, Long.toString(expectedCaseRevision));
        field(canonical, expectedAuthorityVersion);
        field(canonical, payload.getClass().getName());
        field(canonical, payload.operationId());
        if (payload instanceof Comment comment) {
            field(canonical, comment.text());
            field(canonical, comment.disposition().name());
            annotation(canonical, comment.annotation());
        } else if (payload instanceof DecisionRecord decision) {
            field(canonical, decision.decision().name());
            field(canonical, decision.reason());
        } else {
            throw new IllegalArgumentException("unsupported review payload");
        }
        try {
            byte[] digest = java.security.MessageDigest.getInstance("SHA-256")
                    .digest(canonical.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return java.util.HexFormat.of().formatHex(digest);
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    private static void annotation(StringBuilder canonical, Annotation annotation) {
        if (annotation == null) {
            field(canonical, "no-annotation");
            return;
        }
        field(canonical, "annotation");
        TimeRange range = annotation.timeRange();
        if (range == null) {
            field(canonical, "no-time-range");
        } else {
            field(canonical, "time-range");
            rationalTime(canonical, range.start());
            rationalTime(canonical, range.end());
        }
        NormalizedRoi roi = annotation.roi();
        if (roi == null) {
            field(canonical, "no-roi");
        } else {
            field(canonical, "roi");
            field(canonical, Double.toHexString(roi.x()));
            field(canonical, Double.toHexString(roi.y()));
            field(canonical, Double.toHexString(roi.width()));
            field(canonical, Double.toHexString(roi.height()));
        }
    }

    private static void rationalTime(StringBuilder canonical, RationalTime time) {
        field(canonical, Long.toString(time.ticks()));
        field(canonical, Long.toString(time.rateNumerator()));
        field(canonical, Long.toString(time.rateDenominator()));
        field(canonical, time.clock().name());
    }

    private static void field(StringBuilder canonical, String value) {
        canonical.append(value.length()).append(':').append(value);
    }

    private static void requireExpectedAuthorityVersion(String expected, AuthorizationDecision decision) {
        if (!expected.equals(decision.authorityVersion())) throw new ReviewAuthorityConflictException();
    }

    private String nextId() {
        String id = ids.get();
        if (id == null || !id.matches("[A-Za-z0-9][A-Za-z0-9._~:-]{0,255}")) {
            throw new IllegalStateException("id supplier returned an invalid append record identity");
        }
        return id;
    }
}
