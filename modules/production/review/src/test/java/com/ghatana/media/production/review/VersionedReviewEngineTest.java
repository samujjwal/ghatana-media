package com.ghatana.media.production.review;

import static com.ghatana.media.production.review.ReviewContracts.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;

class VersionedReviewEngineTest {
    private static final Instant NOW = Instant.parse("2026-11-05T12:00:00Z");
    private static final Actor REVIEWER = new Actor("tenant-a", "principal-reviewer");
    private static final ExactVersionRef V1 = new ExactVersionRef(SubjectKind.ARTIFACT_VERSION, "artifact-1", "v1");
    private static final ExactVersionRef V2 = new ExactVersionRef(SubjectKind.ARTIFACT_VERSION, "artifact-1", "v2");
    private static final ReviewCaseRef CASE = new ReviewCaseRef("tenant-a", "owner-case-1", V1.reference(), V1, "scope-visual-review");

    @Test
    void appendsExactVersionDecisionWithoutCreatingApprovalAndRedactsText() {
        Fixture fixture = new Fixture(AuthorizationStatus.ALLOW, RetentionStatus.ACTIVE, V1.reference());
        AppendReceipt receipt = fixture.engine.append(REVIEWER, fixture.request(0, "req-1", new DecisionRecord(Decision.ACCEPT, "secret:customer@example.test looks good")));

        assertThat(receipt.reviewSubjectRef()).isEqualTo(V1);
        assertThat(receipt.currentness()).isEqualTo(Currentness.CURRENT);
        assertThat(receipt.establishesApproval()).isFalse();
        assertThat(receipt.appendRecordId()).isEqualTo("record-1");
        ReviewRecord record = fixture.engine.inspect(REVIEWER, CASE).records().getFirst().record();
        assertThat(((DecisionRecord) record.payload()).reason()).contains("[REDACTED]").doesNotContain("customer@example.test");
        assertThat(record.reviewSubjectRef()).isEqualTo(V1);
        assertThat(((DecisionRecord) fixture.store.read(REVIEWER, CASE).getFirst().payload()).reason())
                .contains("[REDACTED]").doesNotContain("customer@example.test");
    }

    @Test
    void materialChangeMarksPriorDecisionStaleAndRejectsNewStaleDecision() {
        Fixture fixture = new Fixture(AuthorizationStatus.ALLOW, RetentionStatus.ACTIVE, V1.reference());
        fixture.engine.append(REVIEWER, fixture.request(0, "req-1", new DecisionRecord(Decision.ACCEPT, "reviewed")));
        fixture.currentVersion.set(V2.reference());

        ReviewSnapshot snapshot = fixture.engine.inspect(REVIEWER, CASE);
        assertThat(snapshot.currentness()).isEqualTo(Currentness.STALE);
        assertThat(snapshot.records().getFirst().currentness()).isEqualTo(Currentness.STALE);
        assertThatThrownBy(() -> fixture.engine.append(REVIEWER,
                fixture.request(1, "req-2", new DecisionRecord(Decision.ACCEPT, "late approval"))))
                .isInstanceOf(StaleReviewException.class);
    }

    @Test
    void materialChangeDuringAppendIsCaughtByFreshEffectBoundaryCheck() {
        Fixture fixture = new Fixture(AuthorizationStatus.ALLOW, RetentionStatus.ACTIVE, V1.reference());
        fixture.changeMaterialDuringSanitization.set(true);
        AppendRequest request = fixture.request(0, "req-edit-race", new DecisionRecord(Decision.ACCEPT, "reviewed"));

        assertThatThrownBy(() -> fixture.engine.append(REVIEWER, request)).isInstanceOf(StaleReviewException.class);
        assertThat(fixture.store.read(REVIEWER, CASE)).isEmpty();
        assertThat(fixture.authorizationChecks).hasValue(2);
    }

    @Test
    void reviewerAuthorityVersionUsesRequestCasAndIsRecheckedAtEffectBoundary() {
        Fixture staleRequest = new Fixture(AuthorizationStatus.ALLOW, RetentionStatus.ACTIVE, V1.reference());
        AppendRequest prepared = staleRequest.request(0, "req-role-stale", new Comment("safe", CommentDisposition.OPEN, null));
        staleRequest.authorityVersion.set("authority-v2");
        assertThatThrownBy(() -> staleRequest.engine.append(REVIEWER, prepared))
                .isInstanceOf(ReviewAuthorityConflictException.class);
        assertThat(staleRequest.store.read(REVIEWER, CASE)).isEmpty();

        Fixture changedDuringAppend = new Fixture(AuthorizationStatus.ALLOW, RetentionStatus.ACTIVE, V1.reference());
        changedDuringAppend.changeAuthorityDuringSanitization.set(true);
        AppendRequest request = changedDuringAppend.request(0, "req-role-race",
                new Comment("safe", CommentDisposition.OPEN, null));
        assertThatThrownBy(() -> changedDuringAppend.engine.append(REVIEWER, request))
                .isInstanceOf(ReviewAuthorityConflictException.class);
        assertThat(changedDuringAppend.store.read(REVIEWER, CASE)).isEmpty();
        assertThat(changedDuringAppend.authorizationChecks).hasValue(2);
    }

    @Test
    void wrongReviewerAuthorityDeniesWithoutAppending() {
        Fixture fixture = new Fixture(AuthorizationStatus.DENY, RetentionStatus.ACTIVE, V1.reference());
        assertThatThrownBy(() -> fixture.engine.append(REVIEWER,
                fixture.request(0, "req-1", new Comment("not authorized", CommentDisposition.OPEN, null))))
                .isInstanceOf(ReviewDeniedException.class);
        assertThat(fixture.store.read(REVIEWER, CASE)).isEmpty();
    }

    @Test
    void authorizationIdentityMustMatchTheAuthenticatedTenantAndPrincipal() {
        InMemoryReviewStore store = new InMemoryReviewStore(List.of(CASE));
        VersionedReviewEngine wrongTenant = engine(store, (actor, reviewCase, operation, now) ->
                authorization(actor, reviewCase, "tenant-other", actor.principalId(), V1.reference()));
        assertThatThrownBy(() -> wrongTenant.inspect(REVIEWER, CASE)).isInstanceOf(ReviewDeniedException.class);

        VersionedReviewEngine wrongPrincipal = engine(store, (actor, reviewCase, operation, now) ->
                authorization(actor, reviewCase, actor.tenantId(), "forged-principal", V1.reference()));
        assertThatThrownBy(() -> wrongPrincipal.append(REVIEWER,
                new AppendRequest(CASE, 0, "authority-v1", "req-forged",
                        new Confirmation("media.operation.action.record-review-comment", CASE.exactTargetRef(), true),
                        new Comment("must not store", CommentDisposition.OPEN, null))))
                .isInstanceOf(ReviewDeniedException.class);
        assertThat(store.read(REVIEWER, CASE)).isEmpty();
    }

    @Test
    void storeReadbackCannotDiscloseARecordForAnotherTenantOrVersion() {
        ReviewRecord foreign = new ReviewRecord("record-foreign", "tenant-other", CASE.reviewCaseId(), V2,
                "req-foreign", "media.operation.action.record-review-comment",
                new Actor("tenant-other", "principal-other"),
                new Comment("private text", CommentDisposition.OPEN, null), 1, NOW, "authority-v1");
        ReviewStore hostileStore = new ReviewStore() {
            @Override public ReviewRecord append(Actor actor, ReviewCaseRef reviewCase, long expectedCaseRevision,
                    String requestId, String fingerprint, String appendRecordId, String authorityVersion,
                    Payload payload, Instant createdAt) { throw new AssertionError("not an append test"); }
            @Override public List<ReviewRecord> read(Actor actor, ReviewCaseRef reviewCase) { return List.of(foreign); }
        };
        VersionedReviewEngine engine = engine(hostileStore,
                (actor, reviewCase, operation, now) -> authorization(actor, reviewCase,
                        actor.tenantId(), actor.principalId(), V1.reference()));

        assertThatThrownBy(() -> engine.inspect(REVIEWER, CASE)).isInstanceOf(ReviewCaseMismatchException.class);
    }

    @Test
    void storeReadbackCannotPairACommentPayloadWithAnotherOperationIdentity() {
        ReviewRecord mismatched = new ReviewRecord("record-mismatched", REVIEWER.tenantId(), CASE.reviewCaseId(), V1,
                "req-mismatched", "media.operation.action.record-version-review-decision", REVIEWER,
                new Comment("comment payload", CommentDisposition.OPEN, null), 1, NOW, "authority-v1");
        ReviewStore hostileStore = new ReviewStore() {
            @Override public ReviewRecord append(Actor actor, ReviewCaseRef reviewCase, long expectedCaseRevision,
                    String requestId, String fingerprint, String appendRecordId, String authorityVersion,
                    Payload payload, Instant createdAt) { throw new AssertionError("not an append test"); }
            @Override public List<ReviewRecord> read(Actor actor, ReviewCaseRef reviewCase) { return List.of(mismatched); }
        };
        VersionedReviewEngine engine = engine(hostileStore,
                (actor, reviewCase, operation, now) -> authorization(actor, reviewCase,
                        actor.tenantId(), actor.principalId(), V1.reference()));

        assertThatThrownBy(() -> engine.inspect(REVIEWER, CASE)).isInstanceOf(ReviewUnavailableException.class);
    }

    @Test
    void reviewerRevocationDuringReadIsRecheckedBeforeReturningDisclosure() {
        AtomicInteger authorizationChecks = new AtomicInteger();
        ReviewRecord record = new ReviewRecord("record-1", REVIEWER.tenantId(), CASE.reviewCaseId(), V1,
                "req-1", "media.operation.action.record-review-comment", REVIEWER,
                new Comment("sensitive review detail", CommentDisposition.OPEN, null), 1, NOW, "authority-v1");
        ReviewStore revokingStore = new ReviewStore() {
            @Override public ReviewRecord append(Actor actor, ReviewCaseRef reviewCase, long expectedCaseRevision,
                    String requestId, String fingerprint, String appendRecordId, String authorityVersion,
                    Payload payload, Instant createdAt) { throw new AssertionError("not an append test"); }
            @Override public List<ReviewRecord> read(Actor actor, ReviewCaseRef reviewCase) {
                return List.of(record);
            }
        };
        VersionedReviewEngine engine = engine(revokingStore, (actor, reviewCase, operation, now) -> {
            boolean allowed = authorizationChecks.getAndIncrement() == 0;
            return new AuthorizationDecision(allowed ? AuthorizationStatus.ALLOW : AuthorizationStatus.DENY,
                    actor.tenantId(), actor.principalId(), reviewCase.reviewCaseId(), reviewCase.exactTargetRef(),
                    reviewCase.scopeRef(), "authority-v1", NOW.plusSeconds(60), V1.reference(), RetentionStatus.ACTIVE);
        });

        assertThatThrownBy(() -> engine.inspect(REVIEWER, CASE)).isInstanceOf(ReviewDeniedException.class);
        assertThat(authorizationChecks).hasValue(2);
    }

    @Test
    void inspectRejectsSanitizerOutputOutsideTheCommentDisclosureBound() {
        ReviewRecord record = new ReviewRecord("record-1", REVIEWER.tenantId(), CASE.reviewCaseId(), V1,
                "req-1", "media.operation.action.record-review-comment", REVIEWER,
                new Comment("stored comment", CommentDisposition.OPEN, null), 1, NOW, "authority-v1");
        ReviewStore store = new ReviewStore() {
            @Override public ReviewRecord append(Actor actor, ReviewCaseRef reviewCase, long expectedCaseRevision,
                    String requestId, String fingerprint, String appendRecordId, String authorityVersion,
                    Payload payload, Instant createdAt) { throw new AssertionError("not an append test"); }
            @Override public List<ReviewRecord> read(Actor actor, ReviewCaseRef reviewCase) { return List.of(record); }
        };
        String unboundedText = "oversized-disclosure-";
        VersionedReviewEngine engine = new VersionedReviewEngine(store,
                (actor, reviewCase, operation, now) -> authorization(actor, reviewCase,
                        actor.tenantId(), actor.principalId(), V1.reference()),
                value -> unboundedText.repeat(500), Clock.fixed(NOW, ZoneOffset.UTC), () -> "record-unused");

        assertThatThrownBy(() -> engine.inspect(REVIEWER, CASE))
                .isInstanceOf(ReviewUnavailableException.class)
                .satisfies(failure -> assertThat(failure.getMessage()).doesNotContain(unboundedText));
    }

    @Test
    void appendReceiptMustNameTheExactRequestedRevisionAndPayload() {
        ReviewStore hostileStore = new ReviewStore() {
            @Override public ReviewRecord append(Actor actor, ReviewCaseRef reviewCase, long expectedCaseRevision,
                    String requestId, String fingerprint, String appendRecordId, String authorityVersion,
                    Payload payload, Instant createdAt) {
                return new ReviewRecord(appendRecordId, actor.tenantId(), reviewCase.reviewCaseId(), V2,
                        requestId, payload.operationId(), actor, payload, expectedCaseRevision + 1,
                        createdAt, authorityVersion);
            }
            @Override public List<ReviewRecord> read(Actor actor, ReviewCaseRef reviewCase) { return List.of(); }
        };
        VersionedReviewEngine engine = engine(hostileStore,
                (actor, reviewCase, operation, now) -> authorization(actor, reviewCase,
                        actor.tenantId(), actor.principalId(), V1.reference()));
        AppendRequest request = new AppendRequest(CASE, 0, "authority-v1", "req-wrong-target",
                new Confirmation("media.operation.action.record-review-comment", CASE.exactTargetRef(), true),
                new Comment("safe", CommentDisposition.OPEN, null));

        assertThatThrownBy(() -> engine.append(REVIEWER, request)).isInstanceOf(ReviewUnavailableException.class);
    }

    @Test
    void inspectRejectsDuplicateAppendRecordIdentityAcrossCaseRevisions() {
        ReviewRecord first = new ReviewRecord("record-reused", REVIEWER.tenantId(), CASE.reviewCaseId(), V1,
                "req-1", "media.operation.action.record-review-comment", REVIEWER,
                new Comment("first comment", CommentDisposition.OPEN, null), 1, NOW, "authority-v1");
        ReviewRecord second = new ReviewRecord("record-reused", REVIEWER.tenantId(), CASE.reviewCaseId(), V1,
                "req-2", "media.operation.action.record-review-comment", REVIEWER,
                new Comment("second comment", CommentDisposition.RESOLVED, null), 2, NOW, "authority-v1");
        ReviewStore hostileStore = new ReviewStore() {
            @Override public ReviewRecord append(Actor actor, ReviewCaseRef reviewCase, long expectedCaseRevision,
                    String requestId, String fingerprint, String appendRecordId, String authorityVersion,
                    Payload payload, Instant createdAt) { throw new AssertionError("not an append test"); }
            @Override public List<ReviewRecord> read(Actor actor, ReviewCaseRef reviewCase) {
                return List.of(first, second);
            }
        };
        VersionedReviewEngine engine = engine(hostileStore,
                (actor, reviewCase, operation, now) -> authorization(actor, reviewCase,
                        actor.tenantId(), actor.principalId(), V1.reference()));

        assertThatThrownBy(() -> engine.inspect(REVIEWER, CASE)).isInstanceOf(ReviewUnavailableException.class);
    }

    @Test
    void compositeIdempotencyIdentityCannotCollideOnDelimiterCharacters() {
        String firstTenant = "tenant-a\u0000principal-a";
        ReviewCaseRef firstCase = new ReviewCaseRef(firstTenant, "case-a", V1.reference(), V1, "scope-a");
        ReviewCaseRef secondCase = new ReviewCaseRef("tenant-a", "case-b", V1.reference(), V1, "scope-b");
        Actor firstActor = new Actor(firstTenant, "principal-b");
        Actor secondActor = new Actor("tenant-a", "principal-a\u0000principal-b");
        InMemoryReviewStore store = new InMemoryReviewStore(List.of(firstCase, secondCase));
        Comment payload = new Comment("same request id, distinct authenticated identities", CommentDisposition.OPEN, null);

        ReviewRecord first = store.append(firstActor, firstCase, 0, "request-1", "fingerprint-a", "record-a",
                "authority-a", payload, NOW);
        ReviewRecord second = store.append(secondActor, secondCase, 0, "request-1", "fingerprint-b", "record-b",
                "authority-b", payload, NOW);

        assertThat(first.reviewCaseId()).isEqualTo("case-a");
        assertThat(second.reviewCaseId()).isEqualTo("case-b");
        assertThat(store.read(firstActor, firstCase)).containsExactly(first);
        assertThat(store.read(secondActor, secondCase)).containsExactly(second);
    }

    @Test
    void exactTimeAndRoiAnnotationsRemainBoundToTheReviewedVersion() {
        Fixture fixture = new Fixture(AuthorizationStatus.ALLOW, RetentionStatus.ACTIVE, V1.reference());
        Annotation annotation = new Annotation(
                new TimeRange(new RationalTime(10, 30, 1, ClockDomain.SOURCE_PRESENTATION),
                        new RationalTime(20, 30, 1, ClockDomain.SOURCE_PRESENTATION)),
                new NormalizedRoi(0.1, 0.2, 0.4, 0.3));
        fixture.engine.append(REVIEWER, fixture.request(0, "req-annotated",
                new Comment("inspect this region", CommentDisposition.OPEN, annotation)));

        ReviewRecord stored = fixture.store.read(REVIEWER, CASE).getFirst();
        assertThat(stored.reviewSubjectRef()).isEqualTo(V1);
        assertThat(((Comment) stored.payload()).annotation()).isEqualTo(annotation);
        assertThat(annotation.timeRange().start().rateNumerator()).isEqualTo(30);
        assertThat(annotation.timeRange().end().ticks()).isEqualTo(20);
    }

    @Test
    void authorizationMustBindExactReviewCaseTargetAndDeclaredScope() {
        Fixture wrongCase = new Fixture(AuthorizationStatus.ALLOW, RetentionStatus.ACTIVE, V1.reference());
        wrongCase.authorizedCaseId.set("other-case");
        assertThatThrownBy(() -> wrongCase.engine.inspect(REVIEWER, CASE)).isInstanceOf(ReviewDeniedException.class);

        Fixture wrongTarget = new Fixture(AuthorizationStatus.ALLOW, RetentionStatus.ACTIVE, V1.reference());
        wrongTarget.authorizedTargetRef.set(V2.reference());
        assertThatThrownBy(() -> wrongTarget.engine.inspect(REVIEWER, CASE)).isInstanceOf(ReviewDeniedException.class);

        Fixture wrongScope = new Fixture(AuthorizationStatus.ALLOW, RetentionStatus.ACTIVE, V1.reference());
        wrongScope.authorizedScopeRef.set("different-scope");
        assertThatThrownBy(() -> wrongScope.engine.inspect(REVIEWER, CASE)).isInstanceOf(ReviewDeniedException.class);
    }

    @Test
    void simultaneousCaseEditsHaveOneCasWinner() throws Exception {
        Fixture fixture = new Fixture(AuthorizationStatus.ALLOW, RetentionStatus.ACTIVE, V1.reference());
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<Boolean> first = pool.submit(() -> appendAtSameRevision(fixture, ready, start, "req-a", "one"));
            Future<Boolean> second = pool.submit(() -> appendAtSameRevision(fixture, ready, start, "req-b", "two"));
            ready.await();
            start.countDown();
            assertThat(first.get() ^ second.get()).isTrue();
            assertThat(fixture.store.read(REVIEWER, CASE)).hasSize(1);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void unknownOrExpiredRetentionFailsClosedOnWriteAndRead() {
        Fixture unknown = new Fixture(AuthorizationStatus.ALLOW, RetentionStatus.UNKNOWN, V1.reference());
        assertThatThrownBy(() -> unknown.engine.append(REVIEWER,
                unknown.request(0, "req-1", new Comment("private", CommentDisposition.OPEN, null))))
                .isInstanceOf(ReviewUnavailableException.class);
        assertThat(unknown.store.read(REVIEWER, CASE)).isEmpty();

        Fixture expired = new Fixture(AuthorizationStatus.ALLOW, RetentionStatus.EXPIRED, V1.reference());
        assertThatThrownBy(() -> expired.engine.inspect(REVIEWER, CASE)).isInstanceOf(ReviewDeniedException.class);
    }

    @Test
    void requestReplayReturnsSameRecordAndPayloadReuseConflicts() {
        Fixture fixture = new Fixture(AuthorizationStatus.ALLOW, RetentionStatus.ACTIVE, V1.reference());
        AppendReceipt original = fixture.engine.append(REVIEWER,
                fixture.request(0, "req-1", new Comment("safe", CommentDisposition.OPEN, null)));
        AppendReceipt replay = fixture.engine.append(REVIEWER,
                fixture.request(0, "req-1", new Comment("safe", CommentDisposition.OPEN, null)));
        assertThat(replay.appendRecordId()).isEqualTo(original.appendRecordId());
        assertThat(replay.caseRevision()).isEqualTo(original.caseRevision());
        assertThat(fixture.store.read(REVIEWER, CASE)).hasSize(1);

        assertThatThrownBy(() -> fixture.engine.append(REVIEWER,
                fixture.request(0, "req-1", new Comment("different", CommentDisposition.OPEN, null))))
                .isInstanceOf(ReviewIdempotencyConflictException.class);
    }

    @Test
    void appendUsesCanonicalSha256FingerprintRequiredByDurableStore() {
        AtomicReference<String> fingerprint = new AtomicReference<>();
        ReviewStore capturingStore = new ReviewStore() {
            @Override public ReviewRecord append(Actor actor, ReviewCaseRef reviewCase, long expectedCaseRevision,
                    String requestId, String requestFingerprint, String appendRecordId, String authorityVersion,
                    Payload payload, Instant createdAt) {
                fingerprint.set(requestFingerprint);
                return new ReviewRecord(appendRecordId, actor.tenantId(), reviewCase.reviewCaseId(),
                        reviewCase.reviewSubjectRef(), requestId, payload.operationId(), actor, payload,
                        expectedCaseRevision + 1, createdAt, authorityVersion);
            }
            @Override public List<ReviewRecord> read(Actor actor, ReviewCaseRef reviewCase) { return List.of(); }
        };
        VersionedReviewEngine engine = engine(capturingStore,
                (actor, reviewCase, operation, now) -> authorization(actor, reviewCase,
                        actor.tenantId(), actor.principalId(), V1.reference()));

        engine.append(REVIEWER, new AppendRequest(CASE, 0, "authority-v1", "req-fingerprint",
                new Confirmation("media.operation.action.record-review-comment", CASE.exactTargetRef(), true),
                new Comment("text with delimiters \u0000 and unicode λ", CommentDisposition.OPEN, null)));

        assertThat(fingerprint.get()).matches("[0-9a-f]{64}");
    }

    @Test
    void inMemoryStoreRejectsDuplicateAppendRecordIdentityWithoutAdvancingCase() {
        InMemoryReviewStore store = new InMemoryReviewStore(List.of(CASE));
        Comment firstPayload = new Comment("first", CommentDisposition.OPEN, null);
        ReviewRecord first = store.append(REVIEWER, CASE, 0, "req-first", "fingerprint-first", "record-reused",
                "authority-v1", firstPayload, NOW);

        assertThatThrownBy(() -> store.append(REVIEWER, CASE, 1, "req-second", "fingerprint-second",
                "record-reused", "authority-v1",
                new Comment("second", CommentDisposition.OPEN, null), NOW))
                .isInstanceOf(ReviewUnavailableException.class);

        assertThat(store.read(REVIEWER, CASE)).containsExactly(first);
        assertThat(store.append(REVIEWER, CASE, 1, "req-third", "fingerprint-third", "record-next",
                "authority-v1", new Comment("third", CommentDisposition.OPEN, null), NOW).caseRevision())
                .isEqualTo(2);
    }

    @Test
    void exhaustedCaseRevisionFailsBeforeAuthorizationOrStorageEffect() {
        Fixture fixture = new Fixture(AuthorizationStatus.ALLOW, RetentionStatus.ACTIVE, V1.reference());

        assertThatThrownBy(() -> fixture.engine.append(REVIEWER,
                fixture.request(Long.MAX_VALUE, "req-exhausted",
                        new Comment("must not append", CommentDisposition.OPEN, null))))
                .isInstanceOf(ReviewRevisionExhaustedException.class);

        assertThat(fixture.authorizationChecks.get()).isZero();
        assertThat(fixture.store.read(REVIEWER, CASE)).isEmpty();
    }

    @Test
    void invalidGeneratedAppendIdentityIsRejectedBeforeStoreCall() {
        AtomicInteger appendCalls = new AtomicInteger();
        ReviewStore countingStore = new ReviewStore() {
            @Override public ReviewRecord append(Actor actor, ReviewCaseRef reviewCase, long expectedCaseRevision,
                    String requestId, String fingerprint, String appendRecordId, String authorityVersion,
                    Payload payload, Instant createdAt) {
                appendCalls.incrementAndGet();
                return new ReviewRecord(appendRecordId, actor.tenantId(), reviewCase.reviewCaseId(),
                        reviewCase.reviewSubjectRef(), requestId, payload.operationId(), actor, payload,
                        expectedCaseRevision + 1, createdAt, authorityVersion);
            }
            @Override public List<ReviewRecord> read(Actor actor, ReviewCaseRef reviewCase) { return List.of(); }
        };
        VersionedReviewEngine engine = new VersionedReviewEngine(countingStore,
                (actor, reviewCase, operation, now) -> authorization(actor, reviewCase,
                        actor.tenantId(), actor.principalId(), V1.reference()),
                value -> value, Clock.fixed(NOW, ZoneOffset.UTC), () -> "invalid record id");

        assertThatThrownBy(() -> engine.append(REVIEWER,
                new AppendRequest(CASE, 0, "authority-v1", "req-invalid-record-id",
                        new Confirmation("media.operation.action.record-review-comment", CASE.exactTargetRef(), true),
                        new Comment("safe", CommentDisposition.OPEN, null))))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("invalid append record identity");
        assertThat(appendCalls).hasValue(0);
    }

    @Test
    void exactTargetMismatchAndInvalidAnnotationsAreRejected() {
        assertThatThrownBy(() -> new ReviewCaseRef("tenant-a", "case-1", V2.reference(), V1, "scope"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new NormalizedRoi(0.8, 0.2, 0.3, 0.2)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new NormalizedRoi(1.0, 0.2, Double.MIN_VALUE, 0.2))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new NormalizedRoi(0.2, 1.0, 0.2, Double.MIN_VALUE))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new TimeRange(
                new RationalTime(5, 30, 1, ClockDomain.STORY),
                new RationalTime(4, 24, 1, ClockDomain.STORY))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Annotation(null, null)).isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("time range, ROI");
    }

    private static boolean appendAtSameRevision(Fixture fixture, CountDownLatch ready, CountDownLatch start,
                                                String requestId, String text) throws Exception {
        ready.countDown();
        start.await();
        try {
            fixture.engine.append(REVIEWER, fixture.request(0, requestId,
                    new Comment(text, CommentDisposition.OPEN, null)));
            return true;
        } catch (ReviewConflictException expected) {
            return false;
        }
    }

    private static VersionedReviewEngine engine(ReviewStore store, AuthorizationPort authorization) {
        return new VersionedReviewEngine(store, authorization, value -> value,
                Clock.fixed(NOW, ZoneOffset.UTC), () -> "record-test");
    }

    private static AuthorizationDecision authorization(Actor actor, ReviewCaseRef reviewCase,
                                                        String tenantId, String principalId,
                                                        String currentMaterialVersionRef) {
        return new AuthorizationDecision(AuthorizationStatus.ALLOW, tenantId, principalId,
                reviewCase.reviewCaseId(), reviewCase.exactTargetRef(), reviewCase.scopeRef(),
                "authority-v1", NOW.plusSeconds(60), currentMaterialVersionRef, RetentionStatus.ACTIVE);
    }

    private static final class Fixture {
        private final AtomicReference<String> currentVersion;
        private final InMemoryReviewStore store = new InMemoryReviewStore(List.of(CASE));
        private final AtomicReference<AuthorizationStatus> status;
        private final AtomicReference<RetentionStatus> retention;
        private final AtomicReference<String> authorityVersion = new AtomicReference<>("authority-v1");
        private final AtomicReference<String> authorizedCaseId = new AtomicReference<>(CASE.reviewCaseId());
        private final AtomicReference<String> authorizedTargetRef = new AtomicReference<>(CASE.exactTargetRef());
        private final AtomicReference<String> authorizedScopeRef = new AtomicReference<>(CASE.scopeRef());
        private final AtomicBoolean changeAuthorityDuringSanitization = new AtomicBoolean();
        private final AtomicBoolean changeMaterialDuringSanitization = new AtomicBoolean();
        private final AtomicInteger authorizationChecks = new AtomicInteger();
        private final AtomicInteger ids = new AtomicInteger();
        private final VersionedReviewEngine engine;

        private Fixture(AuthorizationStatus status, RetentionStatus retention, String currentVersion) {
            this.status = new AtomicReference<>(status);
            this.retention = new AtomicReference<>(retention);
            this.currentVersion = new AtomicReference<>(currentVersion);
            Clock clock = Clock.fixed(NOW, ZoneOffset.UTC);
            engine = new VersionedReviewEngine(store, (actor, reviewCase, operation, now) -> {
                authorizationChecks.incrementAndGet();
                return new AuthorizationDecision(this.status.get(), reviewCase.tenantId(), actor.principalId(),
                        authorizedCaseId.get(), authorizedTargetRef.get(), authorizedScopeRef.get(),
                        this.authorityVersion.get(), NOW.plusSeconds(60),
                        this.currentVersion.get(), this.retention.get());
            }, value -> {
                if (changeAuthorityDuringSanitization.get()) authorityVersion.set("authority-v2");
                if (changeMaterialDuringSanitization.get()) this.currentVersion.set(V2.reference());
                return value.replaceAll("secret:[^ ]+", "[REDACTED]");
            }, clock, () -> "record-" + ids.incrementAndGet());
        }

        private AppendRequest request(long expectedRevision, String requestId, Payload payload) {
            return new AppendRequest(CASE, expectedRevision, authorityVersion.get(), requestId,
                    new Confirmation(payload.operationId(), CASE.exactTargetRef(), true), payload);
        }
    }
}
