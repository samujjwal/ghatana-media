package com.ghatana.media.production.timeline;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class ProjectTimelineEngineTest {
    private static final Actor OWNER = new Actor("tenant-a", "principal-a");

    @Test
    void creationReplayIsIdempotentAndPayloadRebindingConflicts() {
        ProjectTimelineEngine engine = engine();
        Created first = engine.createProject(OWNER, "workspace-a", "Cut", "create-1");
        Created replay = engine.createProject(OWNER, "workspace-a", "Cut", "create-1");

        assertThat(first.createdNow()).isTrue();
        assertThat(replay.createdNow()).isFalse();
        assertThat(replay.project().projectId()).isEqualTo(first.project().projectId());
        assertThat(replay.initialRevision().revisionId()).isEqualTo(first.initialRevision().revisionId());
        engine.edit(OWNER, first.project().projectId(), first.initialRevision().revisionId(),
                List.of(new ProjectTimelineEngine.AddScene(new Scene("later-scene", 0))));
        Created lateReplay = engine.createProject(OWNER, "workspace-a", "Cut", "create-1");
        assertThat(lateReplay.initialRevision().revisionId()).isEqualTo(first.initialRevision().revisionId());
        assertThat(lateReplay.project().headRevisionId()).isEqualTo(first.initialRevision().revisionId());
        assertThatThrownBy(() -> engine.createProject(OWNER, "workspace-b", "Cut", "create-1"))
                .isInstanceOf(IdempotencyConflictException.class);
    }

    @Test
    void editRestoreDiffAndSourceRevocationUseExactImmutableVersions() {
        ProjectTimelineEngine engine = engine();
        Created created = engine.createProject(OWNER, "workspace-a", "Cut", "create-2");
        String projectId = created.project().projectId();
        Revision edited = engine.edit(OWNER, projectId, created.initialRevision().revisionId(), List.of(
                new ProjectTimelineEngine.AddScene(new Scene("scene-1", 0)),
                new ProjectTimelineEngine.AddTrack(new Track("track-1", "scene-1", TrackKind.VIDEO, 0)),
                new ProjectTimelineEngine.PutClip(clip("clip-1", "scene-1", "track-1"))));
        assertThat(edited.parentRevisionId()).isEqualTo(created.initialRevision().revisionId());
        assertThat(edited.graph().clips()).hasSize(1);

        ProjectTimelineEngine.GraphDiff diff = ProjectTimelineEngine.diff(created.initialRevision().graph(), edited.graph());
        assertThat(diff.addedScenes()).containsExactly("scene-1");
        assertThat(diff.addedTracks()).containsExactly("track-1");
        assertThat(diff.addedClips()).containsExactly("clip-1");

        assertThatThrownBy(() -> engine.requireCurrentSources(OWNER, projectId, edited.revisionId(), ignored -> false))
                .isInstanceOf(SourceEligibilityException.class);
        engine.requireCurrentSources(OWNER, projectId, edited.revisionId(), source ->
                source.artifactId().equals("artifact-1") && source.artifactVersionId().equals("version-7"));

        Revision undo = engine.restore(OWNER, projectId, edited.revisionId(), created.initialRevision().revisionId());
        assertThat(undo.graph().clips()).isEmpty();
        Revision redo = engine.restore(OWNER, projectId, undo.revisionId(), edited.revisionId());
        assertThat(redo.graph()).isEqualTo(edited.graph());
        assertThat(redo.revisionId()).isNotEqualTo(edited.revisionId());
    }

    @Test
    void staleEditsFailWithoutOverwritingAndOwnershipDoesNotCrossTenantOrPrincipal() {
        ProjectTimelineEngine engine = engine();
        Created created = engine.createProject(OWNER, "workspace-a", "Cut", "create-3");
        String projectId = created.project().projectId();
        Revision next = engine.edit(OWNER, projectId, created.initialRevision().revisionId(),
                List.of(new ProjectTimelineEngine.AddScene(new Scene("scene-1", 0))));

        assertThatThrownBy(() -> engine.edit(OWNER, projectId, created.initialRevision().revisionId(),
                List.of(new ProjectTimelineEngine.AddScene(new Scene("scene-2", 1)))))
                .isInstanceOf(RevisionConflictException.class)
                .satisfies(error -> {
                    RevisionConflictException conflict = (RevisionConflictException) error;
                    assertThat(conflict.currentHeadRevisionId()).isEqualTo(next.revisionId());
                });
        assertThat(engine.project(OWNER, projectId).headRevisionId()).isEqualTo(next.revisionId());
        assertThatThrownBy(() -> engine.project(new Actor("tenant-b", OWNER.principalId()), projectId))
                .isInstanceOf(ProjectNotFoundException.class);
        assertThatThrownBy(() -> engine.project(new Actor(OWNER.tenantId(), "principal-b"), projectId))
                .isInstanceOf(ProjectAccessDeniedException.class);
    }

    @Test
    void concurrentCommandsWithSameHeadAllowExactlyOneCommit() throws Exception {
        ProjectTimelineEngine engine = engine();
        Created created = engine.createProject(OWNER, "workspace-a", "Cut", "create-4");
        CountDownLatch ready = new CountDownLatch(2), go = new CountDownLatch(1);
        AtomicInteger success = new AtomicInteger(), conflicts = new AtomicInteger();
        Runnable first = command(engine, created, "scene-a", ready, go, success, conflicts);
        Runnable second = command(engine, created, "scene-b", ready, go, success, conflicts);
        Thread a = new Thread(first), b = new Thread(second);
        a.start(); b.start(); ready.await(); go.countDown(); a.join(); b.join();

        assertThat(success.get()).isEqualTo(1);
        assertThat(conflicts.get()).isEqualTo(1);
        assertThat(engine.project(OWNER, created.project().projectId()).headRevisionId()).isNotEqualTo(created.initialRevision().revisionId());
    }

    @Test
    void invalidGraphEditAndImplicitCascadeAreRejectedBeforeCommit() {
        ProjectTimelineEngine engine = engine();
        Created created = engine.createProject(OWNER, "workspace-a", "Cut", "create-5");
        String projectId = created.project().projectId();
        Revision withSceneAndTrack = engine.edit(OWNER, projectId, created.initialRevision().revisionId(), List.of(
                new ProjectTimelineEngine.AddScene(new Scene("scene-1", 0)),
                new ProjectTimelineEngine.AddTrack(new Track("track-1", "scene-1", TrackKind.VIDEO, 0))));

        assertThatThrownBy(() -> engine.edit(OWNER, projectId, withSceneAndTrack.revisionId(),
                List.of(new ProjectTimelineEngine.RemoveScene("scene-1"))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("remove tracks and clips explicitly");
        assertThat(engine.project(OWNER, projectId).headRevisionId()).isEqualTo(withSceneAndTrack.revisionId());
    }

    @Test
    void emptyEditDoesNotCreateARevision() {
        ProjectTimelineEngine engine = engine();
        Created created = engine.createProject(OWNER, "workspace-a", "Cut", "create-6");

        assertThatThrownBy(() -> engine.edit(OWNER, created.project().projectId(),
                created.initialRevision().revisionId(), List.of()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("at least one operation");
        assertThat(engine.project(OWNER, created.project().projectId()).headRevisionId())
                .isEqualTo(created.initialRevision().revisionId());
    }

    private static Runnable command(ProjectTimelineEngine engine, Created created, String sceneId,
                                    CountDownLatch ready, CountDownLatch go, AtomicInteger success,
                                    AtomicInteger conflicts) {
        return () -> {
            ready.countDown();
            try {
                go.await();
                engine.edit(OWNER, created.project().projectId(), created.initialRevision().revisionId(),
                        List.of(new ProjectTimelineEngine.AddScene(new Scene(sceneId, sceneId.endsWith("a") ? 0 : 1))));
                success.incrementAndGet();
            } catch (RevisionConflictException expected) {
                conflicts.incrementAndGet();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new AssertionError(interrupted);
            }
        };
    }

    private static ProjectTimelineEngine engine() {
        AtomicInteger id = new AtomicInteger();
        return new ProjectTimelineEngine(new InMemoryProjectTimelineStore(), () -> "id-" + id.incrementAndGet());
    }

    private static Clip clip(String id, String sceneId, String trackId) {
        return new Clip(id, sceneId, trackId, new SourceVersion("artifact-1", "version-7"),
                new RationalTime(0, 30_000, 1_001, Clock.SOURCE_PRESENTATION),
                new RationalTime(30_000, 30_000, 1_001, Clock.SOURCE_PRESENTATION),
                new RationalTime(86_400L * 24, 24, 1, Clock.STORY),
                new RationalTime(24, 24, 1, Clock.STORY));
    }
}
