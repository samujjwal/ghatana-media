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
    void wrongReviewerAuthorityDeniesWithoutAppending() {
        Fixture fixture = new Fixture(AuthorizationStatus.DENY, RetentionStatus.ACTIVE, V1.reference());
        assertThatThrownBy(() -> fixture.engine.append(REVIEWER,
                fixture.request(0, "req-1", new Comment("not authorized", CommentDisposition.OPEN, null))))
                .isInstanceOf(ReviewDeniedException.class);
        assertThat(fixture.store.read(REVIEWER, CASE)).isEmpty();
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
    void exactTargetMismatchAndInvalidAnnotationsAreRejected() {
        assertThatThrownBy(() -> new ReviewCaseRef("tenant-a", "case-1", V2.reference(), V1, "scope"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new NormalizedRoi(0.8, 0.2, 0.3, 0.2)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new TimeRange(
                new RationalTime(5, 30, 1, ClockDomain.STORY),
                new RationalTime(4, 24, 1, ClockDomain.STORY))).isInstanceOf(IllegalArgumentException.class);
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

    private static final class Fixture {
        private final AtomicReference<String> currentVersion;
        private final InMemoryReviewStore store = new InMemoryReviewStore(List.of(CASE));
        private final AtomicReference<AuthorizationStatus> status;
        private final AtomicReference<RetentionStatus> retention;
        private final AtomicInteger ids = new AtomicInteger();
        private final VersionedReviewEngine engine;

        private Fixture(AuthorizationStatus status, RetentionStatus retention, String currentVersion) {
            this.status = new AtomicReference<>(status);
            this.retention = new AtomicReference<>(retention);
            this.currentVersion = new AtomicReference<>(currentVersion);
            Clock clock = Clock.fixed(NOW, ZoneOffset.UTC);
            engine = new VersionedReviewEngine(store, (actor, reviewCase, operation, now) ->
                    new AuthorizationDecision(this.status.get(), reviewCase.tenantId(), actor.principalId(),
                            reviewCase.exactTargetRef(), "authority-v1", NOW.plusSeconds(60),
                            this.currentVersion.get(), this.retention.get()),
                    value -> value.replaceAll("secret:[^ ]+", "[REDACTED]"), clock, () -> "record-" + ids.incrementAndGet());
        }

        private AppendRequest request(long expectedRevision, String requestId, Payload payload) {
            return new AppendRequest(CASE, expectedRevision, requestId,
                    new Confirmation(payload.operationId(), CASE.exactTargetRef(), true), payload);
        }
    }
}
