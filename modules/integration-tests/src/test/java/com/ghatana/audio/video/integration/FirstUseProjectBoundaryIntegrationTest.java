package com.ghatana.audio.video.integration;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import static com.ghatana.media.runtime.MediaProjectTimelineContracts.Created;
import static com.ghatana.media.runtime.MediaProjectTimelineContracts.IdempotencyConflictException;
import static com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectAccessDeniedException;
import static com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectNotFoundException;
import static com.ghatana.media.runtime.MediaProjectTimelineContracts.RevisionConflictException;
import static com.ghatana.media.runtime.MediaProjectTimelineContracts.Scene;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.production.timeline.InMemoryProjectTimelineStore;
import com.ghatana.media.production.timeline.NotAdmittedProjectTimelineStore;
import com.ghatana.media.production.timeline.ProjectTimelineEngine;
import com.ghatana.media.production.timeline.ProjectTimelineEngine.AddScene;
import com.ghatana.media.runtime.MediaCapabilityNotAdmittedException;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Partial, fixture-only J-01 negative scenario. This does not complete the first-use journey:
 * Shared sign-in and the durable canonical project store remain NOT_ADMITTED.
 *
 * <p>Source bindings: PDP-0 journey-actor-resolutions.yaml#journeys/@id=J-01;
 * PDP-3 journey-contracts/first-use-and-project-creation.yaml (steps 0-3 and
 * criticalNonhappyPaths); PDP-1 operations.yaml#individualOperationContracts/records/@id=
 * media.operation-slice.create-project. The in-memory store below is a deterministic local
 * reference fixture, not canonical persistence or runtime admission.
 */
@DisplayName("J-01 first-use project boundary (partial fixture scenario)")
class FirstUseProjectBoundaryIntegrationTest {
    private static final Actor CREATOR = new Actor("tenant-j01-a", "creator-j01-a");
    private static final String WORKSPACE = "workspace-j01-a";
    private static final String REQUEST = "j01-create-request-001";

    @Test
    void typedNotAdmittedStoreDoesNotClaimCreationOrProduceAProject() {
        ProjectTimelineEngine engine = new ProjectTimelineEngine(new NotAdmittedProjectTimelineStore());

        assertThatThrownBy(() -> engine.createProject(CREATOR, WORKSPACE, "First cut", REQUEST))
                .isInstanceOf(MediaCapabilityNotAdmittedException.class)
                .satisfies(error -> {
                    MediaCapabilityNotAdmittedException notAdmitted =
                            (MediaCapabilityNotAdmittedException) error;
                    assertThat(notAdmitted.reason())
                            .isEqualTo(MediaCapabilityNotAdmittedException.Reason.NOT_ADMITTED);
                    assertThat(notAdmitted.modality()).isEqualTo("PROJECT_TIMELINE_STORE");
                });
    }

    @Test
    void exactCreateReplayReturnsOriginalReceiptAndDoesNotCreateAnotherProject() {
        AtomicInteger ids = new AtomicInteger();
        InMemoryProjectTimelineStore store = new InMemoryProjectTimelineStore();
        ProjectTimelineEngine engine = new ProjectTimelineEngine(
                store, () -> "j01-replay-id-" + ids.incrementAndGet());

        var first = engine.createProject(CREATOR, WORKSPACE, "First cut", REQUEST);
        var replay = engine.createProject(CREATOR, WORKSPACE, "First cut", REQUEST);

        assertThat(first.createdNow()).isTrue();
        assertThat(replay.createdNow()).isFalse();
        assertThat(replay.project().projectId()).isEqualTo(first.project().projectId());
        assertThat(replay.initialRevision().revisionId()).isEqualTo(first.initialRevision().revisionId());
        assertThat(replay.initialRevision().timelines()).isEmpty();
        assertThat(engine.project(CREATOR, first.project().projectId()).headRevisionId())
                .isEqualTo(first.initialRevision().revisionId());
    }

    @Test
    void concurrentExactCreateReplayReturnsOneProjectAndOneCreationReceipt() throws Exception {
        AtomicInteger ids = new AtomicInteger();
        InMemoryProjectTimelineStore store = new InMemoryProjectTimelineStore();
        ProjectTimelineEngine engine = new ProjectTimelineEngine(
                store, () -> "j01-concurrent-create-id-" + ids.incrementAndGet());
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);

        try (ExecutorService workers = Executors.newFixedThreadPool(2)) {
            Future<Created> first = workers.submit(() -> {
                ready.countDown();
                start.await();
                return engine.createProject(CREATOR, WORKSPACE, "First cut", "j01-concurrent-create-request");
            });
            Future<Created> second = workers.submit(() -> {
                ready.countDown();
                start.await();
                return engine.createProject(CREATOR, WORKSPACE, "First cut", "j01-concurrent-create-request");
            });

            ready.await();
            start.countDown();
            var firstResult = first.get();
            var secondResult = second.get();

            assertThat(List.of(firstResult, secondResult).stream().filter(Created::createdNow))
                    .hasSize(1);
            assertThat(firstResult.project().projectId()).isEqualTo(secondResult.project().projectId());
            assertThat(firstResult.initialRevision()).isEqualTo(secondResult.initialRevision());
            assertThat(engine.project(CREATOR, firstResult.project().projectId()).headRevisionId())
                    .isEqualTo(firstResult.initialRevision().revisionId());
        }
    }

    @Test
    void firstEditPreservesExactEmptyInitialRevisionReadback() {
        AtomicInteger ids = new AtomicInteger();
        InMemoryProjectTimelineStore store = new InMemoryProjectTimelineStore();
        ProjectTimelineEngine engine = new ProjectTimelineEngine(
                store, () -> "j01-revision-id-" + ids.incrementAndGet());
        var created = engine.createProject(CREATOR, WORKSPACE, "First cut", "j01-revision-readback-request");
        var initial = created.initialRevision();
        var timelineHead = engine.createTimeline(CREATOR, created.project().projectId(), initial.revisionId(), "timeline-j01");

        var successor = engine.edit(CREATOR, created.project().projectId(), "timeline-j01", timelineHead.revisionId(),
                List.of(new AddScene(new Scene("scene-j01-first-edit", 0))));

        assertThat(successor.revisionId()).isNotEqualTo(initial.revisionId());
        assertThat(successor.parentRevisionId()).isEqualTo(timelineHead.revisionId());
        assertThat(engine.project(CREATOR, created.project().projectId()).headRevisionId())
                .isEqualTo(successor.revisionId());
        assertThat(store.revision(CREATOR, created.project().projectId(), initial.revisionId()))
                .isEqualTo(initial);
        assertThat(initial.timelines()).isEmpty();
        assertThat(store.revision(CREATOR, created.project().projectId(), timelineHead.revisionId()).timelines()
                .getFirst().graph().scenes()).isEmpty();
        assertThat(store.revision(CREATOR, created.project().projectId(), successor.revisionId()).timelines()
                .getFirst().graph().scenes())
                .containsExactly(new Scene("scene-j01-first-edit", 0));

        var createdTimelineDiff = engine.diff(CREATOR, created.project().projectId(), initial.revisionId(), timelineHead.revisionId());
        assertThat(createdTimelineDiff.addedTimelineIds()).containsExactly("timeline-j01");
        assertThat(createdTimelineDiff.removedTimelineIds()).isEmpty();

        var diff = engine.diff(CREATOR, created.project().projectId(), timelineHead.revisionId(), successor.revisionId());
        assertThat(diff.fromRevisionId()).isEqualTo(timelineHead.revisionId());
        assertThat(diff.toRevisionId()).isEqualTo(successor.revisionId());
        assertThat(diff.timelineChanges().get("timeline-j01").changes().addedScenes())
                .containsExactly("scene-j01-first-edit");
        assertThat(diff.timelineChanges().get("timeline-j01").fromSemanticVersionId())
                .isEqualTo(timelineHead.timelines().getFirst().semanticVersionId());
        assertThat(diff.timelineChanges().get("timeline-j01").toSemanticVersionId())
                .isEqualTo(successor.timelines().getFirst().semanticVersionId());
        assertThat(diff.timelineChanges().get("timeline-j01").fromSemanticVersionId())
                .isNotEqualTo(diff.timelineChanges().get("timeline-j01").toSemanticVersionId());
        assertThat(engine.project(CREATOR, created.project().projectId()).headRevisionId())
                .isEqualTo(successor.revisionId());

        assertThatThrownBy(() -> engine.diff(new Actor(CREATOR.tenantId(), "another-principal"),
                created.project().projectId(), initial.revisionId(), successor.revisionId()))
                .isInstanceOf(ProjectAccessDeniedException.class)
                .hasMessage("principal is not authorized to edit this project");
        assertThat(engine.project(CREATOR, created.project().projectId()).headRevisionId())
                .isEqualTo(successor.revisionId());
    }

    @Test
    void invalidCreateAndSameTenantWrongPrincipalDoNotExposeOrMutateProject() {
        AtomicInteger ids = new AtomicInteger();
        InMemoryProjectTimelineStore store = new InMemoryProjectTimelineStore();
        ProjectTimelineEngine engine = new ProjectTimelineEngine(
                store, () -> "j01-denial-id-" + ids.incrementAndGet());

        assertThatThrownBy(() -> engine.createProject(CREATOR, WORKSPACE, "  ", REQUEST))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> engine.createProject(CREATOR, "workspace with spaces", "First cut", REQUEST))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> engine.createProject(CREATOR, "w".repeat(129), "First cut", REQUEST))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(ids).hasValue(0);
        var created = engine.createProject(CREATOR, WORKSPACE, "First cut", REQUEST);
        String head = created.initialRevision().revisionId();

        assertThatThrownBy(() -> engine.project(new Actor(CREATOR.tenantId(), "another-principal"),
                created.project().projectId())).isInstanceOf(ProjectAccessDeniedException.class);
        assertThat(engine.project(CREATOR, created.project().projectId()).headRevisionId()).isEqualTo(head);
        assertThat(store.revision(CREATOR, created.project().projectId(), head).timelines()).isEmpty();
    }

    @Test
    void wrongTenantDuplicateCreateAndStaleRevisionHaveZeroAdditionalEffectInLocalFixture() {
        AtomicInteger ids = new AtomicInteger();
        InMemoryProjectTimelineStore store = new InMemoryProjectTimelineStore();
        ProjectTimelineEngine engine = new ProjectTimelineEngine(
                store, () -> "j01-id-" + ids.incrementAndGet());
        var created = engine.createProject(CREATOR, WORKSPACE, "First cut", REQUEST);
        String projectId = created.project().projectId();
        String initialRevision = engine.createTimeline(CREATOR, created.project().projectId(),
                created.initialRevision().revisionId(), "timeline-j01").revisionId();

        // Tenant-scoped absence does not disclose the project; the creator's head is unchanged.
        assertThatThrownBy(() -> engine.project(new Actor("tenant-j01-b", "creator-j01-a"), projectId))
                .isInstanceOf(ProjectNotFoundException.class);
        assertThat(engine.project(CREATOR, projectId).headRevisionId()).isEqualTo(initialRevision);

        // Rebinding the same create request to a different workspace conflicts without mutation.
        assertThatThrownBy(() -> engine.createProject(CREATOR, "workspace-j01-other", "First cut", REQUEST))
                .isInstanceOf(IdempotencyConflictException.class);
        assertThat(engine.project(CREATOR, projectId).headRevisionId()).isEqualTo(initialRevision);

        var committed = engine.edit(CREATOR, projectId, "timeline-j01", initialRevision,
                List.of(new AddScene(new Scene("scene-j01-1", 0))));
        assertThatThrownBy(() -> engine.edit(CREATOR, projectId, "timeline-j01", initialRevision,
                List.of(new AddScene(new Scene("scene-j01-stale", 1)))))
                .isInstanceOf(RevisionConflictException.class);
        assertThat(engine.project(CREATOR, projectId).headRevisionId()).isEqualTo(committed.revisionId());
        assertThat(store.revision(CREATOR, projectId, committed.revisionId()).timelines().getFirst().graph().scenes())
                .containsExactly(new Scene("scene-j01-1", 0));
    }

    @Test
    void sameRequestIdWithDifferentTitleConflictsWithoutRebindingOrMutation() {
        AtomicInteger ids = new AtomicInteger();
        InMemoryProjectTimelineStore store = new InMemoryProjectTimelineStore();
        ProjectTimelineEngine engine = new ProjectTimelineEngine(
                store, () -> "j01-title-conflict-id-" + ids.incrementAndGet());
        var created = engine.createProject(CREATOR, WORKSPACE, "First cut", "j01-title-bound-request");
        String projectId = created.project().projectId();
        String initialRevisionId = created.initialRevision().revisionId();

        assertThatThrownBy(() -> engine.createProject(
                CREATOR, WORKSPACE, "A different title", "j01-title-bound-request"))
                .isInstanceOf(IdempotencyConflictException.class);

        var observed = engine.project(CREATOR, projectId);
        assertThat(observed.title()).isEqualTo("First cut");
        assertThat(observed.headRevisionId()).isEqualTo(initialRevisionId);
        assertThat(store.revision(CREATOR, projectId, initialRevisionId).timelines()).isEmpty();
    }

    @Test
    void blankTitleReplayIsRejectedBeforeAllocatingOrChangingTheBoundProject() {
        AtomicInteger ids = new AtomicInteger();
        InMemoryProjectTimelineStore store = new InMemoryProjectTimelineStore();
        ProjectTimelineEngine engine = new ProjectTimelineEngine(
                store, () -> "j01-blank-title-replay-id-" + ids.incrementAndGet());
        var created = engine.createProject(CREATOR, WORKSPACE, "First cut", "j01-blank-title-bound-request");
        String projectId = created.project().projectId();
        String initialRevisionId = created.initialRevision().revisionId();
        int allocatedIdsAfterCreate = ids.get();

        assertThatThrownBy(() -> engine.createProject(
                CREATOR, WORKSPACE, "  ", "j01-blank-title-bound-request"))
                .isInstanceOf(IllegalArgumentException.class);

        assertThat(ids).hasValue(allocatedIdsAfterCreate);
        assertThat(engine.project(CREATOR, projectId).title()).isEqualTo("First cut");
        assertThat(engine.project(CREATOR, projectId).headRevisionId()).isEqualTo(initialRevisionId);
        assertThat(store.revision(CREATOR, projectId, initialRevisionId).timelines()).isEmpty();
        var exactReplay = engine.createProject(CREATOR, WORKSPACE, "First cut", "j01-blank-title-bound-request");
        assertThat(exactReplay.createdNow()).isFalse();
        assertThat(exactReplay.project()).isEqualTo(created.project());
        assertThat(exactReplay.initialRevision()).isEqualTo(created.initialRevision());
        assertThat(engine.project(CREATOR, projectId).headRevisionId()).isEqualTo(initialRevisionId);
    }

    @Test
    void createRequestIdentityIsScopedToTenantAndPrincipal() {
        AtomicInteger ids = new AtomicInteger();
        InMemoryProjectTimelineStore store = new InMemoryProjectTimelineStore();
        ProjectTimelineEngine engine = new ProjectTimelineEngine(
                store, () -> "j01-principal-scope-id-" + ids.incrementAndGet());
        Actor otherPrincipal = new Actor(CREATOR.tenantId(), "creator-j01-b");

        var first = engine.createProject(CREATOR, WORKSPACE, "First cut", "j01-principal-scoped-request");
        var second = engine.createProject(otherPrincipal, WORKSPACE, "First cut", "j01-principal-scoped-request");

        assertThat(first.createdNow()).isTrue();
        assertThat(second.createdNow()).isTrue();
        assertThat(second.project().projectId()).isNotEqualTo(first.project().projectId());
        assertThat(second.initialRevision().revisionId()).isNotEqualTo(first.initialRevision().revisionId());
        assertThat(engine.project(CREATOR, first.project().projectId())).isEqualTo(first.project());
        assertThat(engine.project(otherPrincipal, second.project().projectId())).isEqualTo(second.project());
        assertThatThrownBy(() -> engine.project(otherPrincipal, first.project().projectId()))
                .isInstanceOf(ProjectAccessDeniedException.class);
    }

    @Test
    void wrongTenantCannotEditProjectOrAdvanceItsRevisionHead() {
        AtomicInteger ids = new AtomicInteger();
        InMemoryProjectTimelineStore store = new InMemoryProjectTimelineStore();
        ProjectTimelineEngine engine = new ProjectTimelineEngine(
                store, () -> "j01-tenant-edit-id-" + ids.incrementAndGet());
        var created = engine.createProject(CREATOR, WORKSPACE, "First cut", "j01-tenant-edit-request");
        String projectId = created.project().projectId();
        String initialRevisionId = created.initialRevision().revisionId();
        Actor otherTenant = new Actor("tenant-j01-other", CREATOR.principalId());

        assertThatThrownBy(() -> engine.edit(otherTenant, projectId, "timeline-j01", initialRevisionId,
                List.of(new AddScene(new Scene("scene-j01-forbidden", 0)))))
                .isInstanceOf(ProjectNotFoundException.class);

        assertThat(engine.project(CREATOR, projectId).headRevisionId()).isEqualTo(initialRevisionId);
        assertThat(store.revision(CREATOR, projectId, initialRevisionId).timelines()).isEmpty();
        assertThatThrownBy(() -> store.revision(CREATOR, projectId, "j01-tenant-edit-id-4"))
                .isInstanceOf(ProjectNotFoundException.class);
        assertThat(ids).hasValue(2);
    }

    @Test
    void sameTenantWrongPrincipalCannotEditProjectOrAllocateRevision() {
        AtomicInteger ids = new AtomicInteger();
        InMemoryProjectTimelineStore store = new InMemoryProjectTimelineStore();
        ProjectTimelineEngine engine = new ProjectTimelineEngine(
                store, () -> "j01-principal-edit-id-" + ids.incrementAndGet());
        var created = engine.createProject(CREATOR, WORKSPACE, "First cut", "j01-principal-edit-request");
        String projectId = created.project().projectId();
        String initialRevisionId = created.initialRevision().revisionId();
        Actor otherPrincipal = new Actor(CREATOR.tenantId(), "another-principal");

        assertThatThrownBy(() -> engine.edit(otherPrincipal, projectId, "timeline-j01", initialRevisionId,
                List.of(new AddScene(new Scene("scene-j01-forbidden-principal", 0)))))
                .isInstanceOf(ProjectAccessDeniedException.class);

        assertThat(engine.project(CREATOR, projectId).headRevisionId()).isEqualTo(initialRevisionId);
        assertThat(store.revision(CREATOR, projectId, initialRevisionId).timelines()).isEmpty();
        assertThat(ids).hasValue(2);
    }
}
