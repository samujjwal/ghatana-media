package com.ghatana.audio.video.integration;

import static com.ghatana.media.production.review.ReviewContracts.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.production.review.InMemoryReviewStore;
import com.ghatana.media.production.review.VersionedReviewEngine;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

/**
 * Source-free J-21 fixture scenario: a record for one immutable version becomes stale when
 * current material advances. The local fixture demonstrates version binding only; it does not
 * stand in for an owner-issued review authority or durable review service.
 */
class VersionSpecificReviewScenarioTest {
    private static final Instant NOW = Instant.parse("2026-11-05T12:00:00Z");
    private static final Actor REVIEWER = new Actor("tenant-j21", "principal-j21-reviewer");
    private static final ExactVersionRef V1 = new ExactVersionRef(SubjectKind.ARTIFACT_VERSION,
            "artifact-j21", "revision-1");
    private static final ExactVersionRef V2 = new ExactVersionRef(SubjectKind.ARTIFACT_VERSION,
            "artifact-j21", "revision-2");
    private static final ReviewCaseRef CASE = new ReviewCaseRef(REVIEWER.tenantId(), "case-j21-v1",
            V1.reference(), V1, "scope-j21-review");

    @Test
    void decisionForPriorSourceRevisionIsStaleAndCannotBeReusedForNewRevision() {
        AtomicReference<String> currentVersion = new AtomicReference<>(V1.reference());
        InMemoryReviewStore store = new InMemoryReviewStore(List.of(CASE));
        VersionedReviewEngine engine = new VersionedReviewEngine(store,
                (actor, reviewCase, operation, now) -> new AuthorizationDecision(
                        AuthorizationStatus.ALLOW,
                        actor.tenantId(),
                        actor.principalId(),
                        reviewCase.reviewCaseId(),
                        reviewCase.exactTargetRef(),
                        reviewCase.scopeRef(),
                        "fixture-authority-v1",
                        NOW.plusSeconds(60),
                        currentVersion.get(),
                        RetentionStatus.ACTIVE),
                value -> value,
                Clock.fixed(NOW, ZoneOffset.UTC),
                () -> "record-j21-v1");

        AppendReceipt receipt = engine.append(REVIEWER, new AppendRequest(CASE, 0, "fixture-authority-v1",
                "request-j21-v1",
                new Confirmation("media.operation.action.record-version-review-decision", V1.reference(), true),
                new DecisionRecord(Decision.ACCEPT, "Reviewed source revision 1")));
        assertThat(receipt.reviewSubjectRef()).isEqualTo(V1);
        assertThat(receipt.currentness()).isEqualTo(Currentness.CURRENT);
        assertThat(receipt.establishesApproval()).isFalse();

        currentVersion.set(V2.reference());
        ReviewSnapshot changed = engine.inspect(REVIEWER, CASE);
        assertThat(changed.currentness()).isEqualTo(Currentness.STALE);
        assertThat(changed.records()).singleElement().satisfies(observation -> {
            assertThat(observation.record().reviewSubjectRef()).isEqualTo(V1);
            assertThat(observation.currentness()).isEqualTo(Currentness.STALE);
        });

        assertThatThrownBy(() -> engine.append(REVIEWER, new AppendRequest(CASE, 1,
                "fixture-authority-v1", "request-j21-reuse-v1",
                new Confirmation("media.operation.action.record-version-review-decision", V1.reference(), true),
                new DecisionRecord(Decision.ACCEPT, "Attempt to reuse on source revision 2"))))
                .isInstanceOf(StaleReviewException.class);
        assertThat(store.read(REVIEWER, CASE)).hasSize(1);
    }

    @Test
    void sourceRevisionChangingAtWriteBoundaryPreventsDecisionRecordCreation() {
        AtomicReference<String> currentVersion = new AtomicReference<>(V1.reference());
        AtomicInteger authorityChecks = new AtomicInteger();
        InMemoryReviewStore store = new InMemoryReviewStore(List.of(CASE));
        VersionedReviewEngine engine = new VersionedReviewEngine(store,
                (actor, reviewCase, operation, now) -> {
                    String version = authorityChecks.incrementAndGet() == 1
                            ? V1.reference() : V2.reference();
                    currentVersion.set(version);
                    return new AuthorizationDecision(
                            AuthorizationStatus.ALLOW,
                            actor.tenantId(),
                            actor.principalId(),
                            reviewCase.reviewCaseId(),
                            reviewCase.exactTargetRef(),
                            reviewCase.scopeRef(),
                            "fixture-authority-v1",
                            NOW.plusSeconds(60),
                            version,
                            RetentionStatus.ACTIVE);
                },
                value -> value,
                Clock.fixed(NOW, ZoneOffset.UTC),
                () -> "record-j21-stale-write");

        assertThatThrownBy(() -> engine.append(REVIEWER, new AppendRequest(CASE, 0, "fixture-authority-v1",
                "request-j21-stale-write",
                new Confirmation("media.operation.action.record-version-review-decision", V1.reference(), true),
                new DecisionRecord(Decision.ACCEPT, "Review exact source revision 1"))))
                .isInstanceOf(StaleReviewException.class);

        assertThat(authorityChecks).hasValue(2);
        assertThat(currentVersion).hasValue(V2.reference());
        assertThat(store.read(REVIEWER, CASE)).isEmpty();
    }

    @Test
    void unknownAtWriteBoundaryDoesNotCreateOrRetryDecisionRecord() {
        AtomicInteger authorityChecks = new AtomicInteger();
        InMemoryReviewStore store = new InMemoryReviewStore(List.of(CASE));
        VersionedReviewEngine engine = new VersionedReviewEngine(store,
                (actor, reviewCase, operation, now) -> {
                    int check = authorityChecks.incrementAndGet();
                    return new AuthorizationDecision(
                            check == 1 ? AuthorizationStatus.ALLOW : AuthorizationStatus.UNKNOWN,
                            actor.tenantId(),
                            actor.principalId(),
                            reviewCase.reviewCaseId(),
                            reviewCase.exactTargetRef(),
                            reviewCase.scopeRef(),
                            "fixture-authority-v1",
                            NOW.plusSeconds(60),
                            V1.reference(),
                            RetentionStatus.ACTIVE);
                },
                value -> value,
                Clock.fixed(NOW, ZoneOffset.UTC),
                () -> "record-j21-unknown-write");

        assertThatThrownBy(() -> engine.append(REVIEWER, new AppendRequest(CASE, 0, "fixture-authority-v1",
                "request-j21-unknown-write",
                new Confirmation("media.operation.action.record-version-review-decision", V1.reference(), true),
                new DecisionRecord(Decision.ACCEPT, "Review exact source revision 1"))))
                .isInstanceOf(ReviewUnavailableException.class);

        // This is an authorization uncertainty before storage, not proof of HUMAN_REVIEW_APPROVAL
        // or a substitute for reconciliation of an actually ambiguous remote write.
        assertThat(authorityChecks).hasValue(2);
        assertThat(store.read(REVIEWER, CASE)).isEmpty();
    }
}
