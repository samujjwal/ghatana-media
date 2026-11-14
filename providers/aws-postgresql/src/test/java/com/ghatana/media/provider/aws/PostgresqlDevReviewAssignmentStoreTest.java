package com.ghatana.media.provider.aws;

import static com.ghatana.media.production.review.ReviewContracts.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.production.review.ManagedReviewStore;
import com.ghatana.media.production.review.ReviewAssignmentStore;
import com.ghatana.media.production.review.ReviewAssignmentStore.*;
import java.time.Instant;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/** DEV_ONLY reviewer assignments over the isolated dev schema (migration V003): durable, versioned, CAS and idempotent. */
@Testcontainers(disabledWithoutDocker = true)
class PostgresqlDevReviewAssignmentStoreTest {
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:16-alpine");

    private static final ReviewCaseRef CASE = new ReviewCaseRef("tenant-assign", "devreview.case-1",
            "project_revision:p1@r1", new ExactVersionRef(SubjectKind.PROJECT_REVISION, "p1", "r1"), "dev-only:owner:x");
    private static final Instant NOW = Instant.parse("2026-11-13T20:00:00Z");
    private static final Instant EXPIRES = NOW.plusSeconds(3600);
    private static final String FP = "a".repeat(64);

    @Test
    void assignmentsAreVersionedCasGuardedIdempotentAndSurviveStoreRestart() {
        String schema = "media_dev_" + UUID.randomUUID().toString().replace("-", "");
        Map<String, String> env = Map.of(
                "MEDIA_RUNTIME_ENVIRONMENT", "dev", "MEDIA_DEV_IDENTITY_ENABLED", "true",
                "MEDIA_PROJECT_TIMELINE_DEV_ENABLED", "true", "MEDIA_PROJECT_TIMELINE_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl(),
                "MEDIA_PROJECT_TIMELINE_SCHEMA", schema, "MEDIA_PROJECT_TIMELINE_POSTGRES_USER", POSTGRES.getUsername(),
                "MEDIA_PROJECT_TIMELINE_POSTGRES_PASSWORD_REFERENCE", "secret:env:DEV_DB_PASSWORD",
                "DEV_DB_PASSWORD", POSTGRES.getPassword());
        var factory = new PostgresqlDevReviewStoreFactory();
        String assignmentId;
        try (ManagedReviewStore managed = factory.createDevOnly(env)) {
            ReviewAssignmentStore store = (ReviewAssignmentStore) managed;
            managed.registerCase(CASE);
            AssignmentChange created = store.assign(CASE, "owner", "reviewer", Set.of(ReviewScope.QUALITY, ReviewScope.RIGHTS),
                    EXPIRES, 0, "req-1", FP, () -> "assignment-1", NOW);
            assignmentId = created.assignment().assignmentId();
            assertThat(created.replayed()).isFalse();
            assertThat(created.assignment().assignmentVersion()).isEqualTo(1);
            assertThat(created.assignment().scopes()).containsExactlyInAnyOrder(ReviewScope.QUALITY, ReviewScope.RIGHTS);

            AssignmentChange replay = store.assign(CASE, "owner", "reviewer", Set.of(ReviewScope.QUALITY),
                    EXPIRES, 0, "req-1", FP, () -> "assignment-x", NOW);
            assertThat(replay.replayed()).isTrue();
            assertThat(replay.assignment().assignmentId()).isEqualTo(assignmentId);
            assertThatThrownBy(() -> store.assign(CASE, "owner", "reviewer", Set.of(ReviewScope.QUALITY), EXPIRES, 0,
                    "req-1", "b".repeat(64), () -> "assignment-y", NOW)).isInstanceOf(ReviewIdempotencyConflictException.class);
            assertThatThrownBy(() -> store.assign(CASE, "owner", "reviewer", Set.of(ReviewScope.QUALITY), EXPIRES, 0,
                    "req-2", FP, () -> "assignment-z", NOW)).isInstanceOf(ReviewAssignmentActiveException.class);
            assertThatThrownBy(() -> store.assign(CASE, "owner", "other", Set.of(ReviewScope.QUALITY), EXPIRES, 4,
                    "req-3", FP, () -> "assignment-w", NOW)).isInstanceOf(ReviewConflictException.class);
            assertThatThrownBy(() -> store.assign(CASE, "owner", "owner", Set.of(ReviewScope.QUALITY), EXPIRES, 0,
                    "req-self", FP, () -> "assignment-self", NOW)).isInstanceOf(IllegalStateException.class);
        }
        try (ManagedReviewStore managed = factory.createDevOnly(env)) {
            ReviewAssignmentStore store = (ReviewAssignmentStore) managed;
            assertThat(store.assignments(CASE)).singleElement().satisfies(a -> {
                assertThat(a.status()).isEqualTo(AssignmentStatus.ACTIVE);
                assertThat(a.reviewerPrincipalId()).isEqualTo("reviewer");
            });
            AssignmentChange revoked = store.revoke(CASE, "owner", assignmentId, 0, "req-r", FP, NOW.plusSeconds(60));
            assertThat(revoked.assignment().status()).isEqualTo(AssignmentStatus.REVOKED);
            assertThat(revoked.assignment().assignmentVersion()).isEqualTo(2);
            assertThat(store.revoke(CASE, "owner", assignmentId, 0, "req-r", FP, NOW.plusSeconds(90)).replayed()).isTrue();
            assertThatThrownBy(() -> store.revoke(CASE, "owner", assignmentId, 0, "req-r2", FP, NOW))
                    .isInstanceOf(ReviewAssignmentRevokedException.class);
            assertThatThrownBy(() -> store.revoke(CASE, "owner", "missing", 0, "req-r3", FP, NOW))
                    .isInstanceOf(ReviewAssignmentNotFoundException.class);
            // A revoked reviewer can be assigned afresh; the revoked version stays as durable history.
            AssignmentChange fresh = store.assign(CASE, "owner", "reviewer", Set.of(ReviewScope.APPROVAL), EXPIRES, 0,
                    "req-4", FP, () -> "assignment-2", NOW.plusSeconds(120));
            assertThat(fresh.assignment().assignmentVersion()).isEqualTo(1);
            assertThat(store.assignments(CASE)).hasSize(2);
        }
    }
}
