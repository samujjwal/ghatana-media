package com.ghatana.audio.video.integration;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import static com.ghatana.media.runtime.MediaProjectTimelineContracts.IdempotencyConflictException;
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
    void wrongTenantDuplicateCreateAndStaleRevisionHaveZeroAdditionalEffectInLocalFixture() {
        AtomicInteger ids = new AtomicInteger();
        InMemoryProjectTimelineStore store = new InMemoryProjectTimelineStore();
        ProjectTimelineEngine engine = new ProjectTimelineEngine(
                store, () -> "j01-id-" + ids.incrementAndGet());
        var created = engine.createProject(CREATOR, WORKSPACE, "First cut", REQUEST);
        String projectId = created.project().projectId();
        String initialRevision = created.initialRevision().revisionId();

        // Tenant-scoped absence does not disclose the project; the creator's head is unchanged.
        assertThatThrownBy(() -> engine.project(new Actor("tenant-j01-b", "creator-j01-a"), projectId))
                .isInstanceOf(ProjectNotFoundException.class);
        assertThat(engine.project(CREATOR, projectId).headRevisionId()).isEqualTo(initialRevision);

        // Rebinding the same create request to a different workspace conflicts without mutation.
        assertThatThrownBy(() -> engine.createProject(CREATOR, "workspace-j01-other", "First cut", REQUEST))
                .isInstanceOf(IdempotencyConflictException.class);
        assertThat(engine.project(CREATOR, projectId).headRevisionId()).isEqualTo(initialRevision);

        var committed = engine.edit(CREATOR, projectId, initialRevision,
                List.of(new AddScene(new Scene("scene-j01-1", 0))));
        assertThatThrownBy(() -> engine.edit(CREATOR, projectId, initialRevision,
                List.of(new AddScene(new Scene("scene-j01-stale", 1)))))
                .isInstanceOf(RevisionConflictException.class);
        assertThat(engine.project(CREATOR, projectId).headRevisionId()).isEqualTo(committed.revisionId());
        assertThat(store.revision(CREATOR, projectId, committed.revisionId()).graph().scenes())
                .containsExactly(new Scene("scene-j01-1", 0));
    }
}
