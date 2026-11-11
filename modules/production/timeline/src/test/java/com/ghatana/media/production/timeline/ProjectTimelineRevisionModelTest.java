package com.ghatana.media.production.timeline;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class ProjectTimelineRevisionModelTest {
    private static final Actor OWNER = new Actor("tenant-revision-model", "owner-revision-model");

    @Test
    void projectStartsWithoutTimelinesThenCreatesEditsDiffsAndRestoresThroughProjectHead() {
        AtomicInteger ids = new AtomicInteger();
        ProjectTimelineEngine engine = new ProjectTimelineEngine(new InMemoryProjectTimelineStore(),
                () -> "revision-model-id-" + ids.incrementAndGet());
        var created = engine.createProject(OWNER, "workspace-revision-model", "Revision model", "revision-model-create");
        Revision initial = created.initialRevision();
        assertThat(initial.timelines()).isEmpty();

        Revision withTimeline = engine.createTimeline(OWNER, created.project().projectId(), initial.revisionId(), "timeline-main");
        TimelineSnapshot empty = withTimeline.timelines().getFirst();
        assertThat(empty.timelineId()).isEqualTo("timeline-main");
        assertThat(empty.graph()).isEqualTo(Graph.empty("timeline-main"));
        assertThat(empty.semanticVersionId()).isNotBlank();
        assertThatThrownBy(() -> engine.edit(OWNER, created.project().projectId(), "missing-timeline",
                withTimeline.revisionId(), List.of(new ProjectTimelineEngine.AddScene(new Scene("scene-main", 0)))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("timeline does not exist");

        Revision edited = engine.edit(OWNER, created.project().projectId(), "timeline-main", withTimeline.revisionId(),
                List.of(new ProjectTimelineEngine.AddScene(new Scene("scene-main", 0)),
                        new ProjectTimelineEngine.AddTrack(new Track("track-main", "scene-main", TrackKind.VIDEO, 0))));
        assertThat(edited.timelines()).hasSize(1);
        assertThat(edited.timelines().getFirst().timelineId()).isEqualTo("timeline-main");
        assertThat(edited.timelines().getFirst().graph().scenes()).containsExactly(new Scene("scene-main", 0));
        assertThat(edited.timelines().getFirst().graph().tracks())
                .containsExactly(new Track("track-main", "scene-main", TrackKind.VIDEO, 0));
        assertThat(edited.timelines().getFirst().semanticVersionId()).isNotEqualTo(empty.semanticVersionId());

        var diff = engine.diff(OWNER, created.project().projectId(), withTimeline.revisionId(), edited.revisionId());
        assertThat(diff.addedTimelineIds()).isEmpty();
        assertThat(diff.removedTimelineIds()).isEmpty();
        var timelineDiff = diff.timelineChanges().get("timeline-main");
        assertThat(timelineDiff.fromSemanticVersionId()).isEqualTo(empty.semanticVersionId());
        assertThat(timelineDiff.toSemanticVersionId()).isEqualTo(edited.timelines().getFirst().semanticVersionId());
        assertThat(timelineDiff.changes().addedScenes()).containsExactly("scene-main");
        assertThat(timelineDiff.changes().addedTracks()).containsExactly("track-main");

        Revision restored = engine.restore(OWNER, created.project().projectId(), edited.revisionId(),
                withTimeline.revisionId());
        assertThat(restored.parentRevisionId()).isEqualTo(edited.revisionId());
        assertThat(restored.timelines().getFirst().graph()).isEqualTo(Graph.empty("timeline-main"));
        assertThat(engine.currentRevision(OWNER, created.project().projectId()).revisionId())
                .isEqualTo(restored.revisionId());
    }

    @Test
    void projectRevisionsSortTimelineSnapshotsAndDiffMembership() {
        TimelineSnapshot z = new TimelineSnapshot("version-z", Graph.empty("timeline-z"));
        TimelineSnapshot a = new TimelineSnapshot("version-a", Graph.empty("timeline-a"));
        Revision revision = new Revision("tenant-revision-model", "project-revision-model", "revision-model",
                null, List.of(z, a));
        assertThat(revision.timelines()).containsExactly(a, z);
        assertThatThrownBy(() -> new Revision("tenant-revision-model", "project-revision-model",
                "revision-null-timelines", null, null)).isInstanceOf(NullPointerException.class)
                .hasMessage("timelines");
    }

    @Test
    void projectDiffReportsTimelineMembershipAndRestorePreservesUnchangedSnapshots() {
        AtomicInteger ids = new AtomicInteger();
        ProjectTimelineEngine engine = new ProjectTimelineEngine(new InMemoryProjectTimelineStore(),
                () -> "membership-id-" + ids.incrementAndGet());
        var created = engine.createProject(OWNER, "workspace-revision-model", "Membership", "membership-create");
        Revision firstTimeline = engine.createTimeline(OWNER, created.project().projectId(),
                created.initialRevision().revisionId(), "timeline-a");
        String unchangedVersion = firstTimeline.timelines().getFirst().semanticVersionId();
        Revision secondTimeline = engine.createTimeline(OWNER, created.project().projectId(),
                firstTimeline.revisionId(), "timeline-b");

        var added = engine.diff(OWNER, created.project().projectId(), firstTimeline.revisionId(), secondTimeline.revisionId());
        assertThat(added.addedTimelineIds()).containsExactly("timeline-b");
        assertThat(added.removedTimelineIds()).isEmpty();
        assertThat(added.timelineChanges().get("timeline-a").fromSemanticVersionId())
                .isEqualTo(added.timelineChanges().get("timeline-a").toSemanticVersionId());

        Revision restored = engine.restore(OWNER, created.project().projectId(), secondTimeline.revisionId(),
                firstTimeline.revisionId());
        assertThat(restored.parentRevisionId()).isEqualTo(secondTimeline.revisionId());
        assertThat(restored.timelines()).extracting(TimelineSnapshot::timelineId).containsExactly("timeline-a");
        assertThat(restored.timelines().getFirst().semanticVersionId()).isEqualTo(unchangedVersion);
        assertThat(engine.revision(OWNER, created.project().projectId(), firstTimeline.revisionId())).isEqualTo(firstTimeline);
        assertThat(engine.revision(OWNER, created.project().projectId(), secondTimeline.revisionId())).isEqualTo(secondTimeline);
        var removed = engine.diff(OWNER, created.project().projectId(), secondTimeline.revisionId(), restored.revisionId());
        assertThat(removed.removedTimelineIds()).containsExactly("timeline-b");
        assertThat(removed.addedTimelineIds()).isEmpty();
    }

    @Test
    void restoreAppendsUndoAndRedoRevisionsWithoutChangingHistoricalGraphs() {
        AtomicInteger ids = new AtomicInteger();
        InMemoryProjectTimelineStore backing = new InMemoryProjectTimelineStore();
        ProjectTimelineEngine engine = new ProjectTimelineEngine(backing,
                () -> "undo-redo-id-" + ids.incrementAndGet());
        var created = engine.createProject(OWNER, "workspace-revision-model", "Undo and redo", "undo-redo-create");
        Revision emptyTimeline = engine.createTimeline(OWNER, created.project().projectId(),
                created.initialRevision().revisionId(), "timeline-main");
        Revision withScene = engine.edit(OWNER, created.project().projectId(), "timeline-main",
                emptyTimeline.revisionId(), List.of(new ProjectTimelineEngine.AddScene(new Scene("scene-main", 0))));

        Revision undo = engine.restore(OWNER, created.project().projectId(), withScene.revisionId(), emptyTimeline.revisionId());
        assertThat(undo.revisionId()).isNotEqualTo(emptyTimeline.revisionId());
        assertThat(undo.parentRevisionId()).isEqualTo(withScene.revisionId());
        assertThat(undo.timelines().getFirst().graph()).isEqualTo(emptyTimeline.timelines().getFirst().graph());
        assertThat(undo.timelines().getFirst().semanticVersionId())
                .isNotEqualTo(withScene.timelines().getFirst().semanticVersionId());

        Revision redo = engine.restore(OWNER, created.project().projectId(), undo.revisionId(), withScene.revisionId());
        assertThat(redo.revisionId()).isNotEqualTo(withScene.revisionId());
        assertThat(redo.parentRevisionId()).isEqualTo(undo.revisionId());
        assertThat(redo.timelines().getFirst().graph()).isEqualTo(withScene.timelines().getFirst().graph());
        assertThat(redo.timelines().getFirst().semanticVersionId())
                .isNotEqualTo(withScene.timelines().getFirst().semanticVersionId());
        assertThat(engine.revision(OWNER, created.project().projectId(), emptyTimeline.revisionId())).isEqualTo(emptyTimeline);
        assertThat(engine.revision(OWNER, created.project().projectId(), withScene.revisionId())).isEqualTo(withScene);
        assertThat(engine.currentRevision(OWNER, created.project().projectId())).isEqualTo(redo);
    }

    @Test
    void restoreRejectsHeadAndTargetRevisionsOutsideTheRequestedIdentityBeforeCommit() {
        AtomicInteger ids = new AtomicInteger();
        RevisionScopeOverrideStore store = new RevisionScopeOverrideStore(new InMemoryProjectTimelineStore());
        ProjectTimelineEngine engine = new ProjectTimelineEngine(store,
                () -> "restore-scope-id-" + ids.incrementAndGet());
        var created = engine.createProject(OWNER, "workspace-revision-model", "Restore scope", "restore-scope-create");
        Revision target = created.initialRevision();
        Revision head = engine.createTimeline(OWNER, created.project().projectId(), target.revisionId(), "timeline-main");
        int commitsBeforeRestore = store.commits;

        store.revisionOverrides.put(target.revisionId(), new Revision("other-tenant", created.project().projectId(),
                target.revisionId(), null, List.of()));
        assertThatThrownBy(() -> engine.restore(OWNER, created.project().projectId(), head.revisionId(), target.revisionId()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("outside the requested identity scope");
        assertThat(store.commits).isEqualTo(commitsBeforeRestore);

        store.revisionOverrides.clear();
        store.revisionOverrides.put(target.revisionId(), new Revision(OWNER.tenantId(), created.project().projectId(),
                "different-revision", null, List.of()));
        assertThatThrownBy(() -> engine.restore(OWNER, created.project().projectId(), head.revisionId(), target.revisionId()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("outside the requested identity scope");
        assertThat(store.commits).isEqualTo(commitsBeforeRestore);

        store.revisionOverrides.clear();
        store.revisionOverrides.put(head.revisionId(), new Revision(OWNER.tenantId(), "other-project",
                head.revisionId(), target.revisionId(), head.timelines()));
        assertThatThrownBy(() -> engine.restore(OWNER, created.project().projectId(), head.revisionId(), target.revisionId()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("outside the requested identity scope");
        assertThat(store.commits).isEqualTo(commitsBeforeRestore);
    }

    @Test
    void timelineMutationsRejectMisScopedProjectAndHeadBeforeCommit() {
        AtomicInteger ids = new AtomicInteger();
        RevisionScopeOverrideStore store = new RevisionScopeOverrideStore(new InMemoryProjectTimelineStore());
        ProjectTimelineEngine engine = new ProjectTimelineEngine(store,
                () -> "mutation-scope-id-" + ids.incrementAndGet());
        var created = engine.createProject(OWNER, "workspace-revision-model", "Mutation scope", "mutation-scope-create");
        Project actual = created.project();
        int commitsBeforeMutations = store.commits;

        store.projectOverride = new Project("other-tenant", actual.projectId(), actual.workspaceId(),
                actual.ownerPrincipalId(), actual.title(), actual.headRevisionId());
        assertThatThrownBy(() -> engine.createTimeline(OWNER, actual.projectId(),
                created.initialRevision().revisionId(), "timeline-main"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("project outside the requested identity scope");

        store.projectOverride = new Project(actual.tenantId(), "other-project", actual.workspaceId(),
                actual.ownerPrincipalId(), actual.title(), actual.headRevisionId());
        assertThatThrownBy(() -> engine.project(OWNER, actual.projectId()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("project outside the requested identity scope");
        assertThatThrownBy(() -> engine.currentRevision(OWNER, actual.projectId()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("project outside the requested identity scope");

        store.projectOverride = null;

        Revision initial = created.initialRevision();
        store.revisionOverrides.put(initial.revisionId(), new Revision("other-tenant", actual.projectId(),
                initial.revisionId(), null, List.of()));
        assertThatThrownBy(() -> engine.createTimeline(OWNER, actual.projectId(), initial.revisionId(), "timeline-main"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("revision outside the requested identity scope");
        assertThat(store.commits).isEqualTo(commitsBeforeMutations);
        store.revisionOverrides.clear();

        Revision timeline = engine.createTimeline(OWNER, actual.projectId(), initial.revisionId(), "timeline-main");
        int commitsAfterTimelineCreate = store.commits;
        store.revisionOverrides.put(timeline.revisionId(), new Revision(OWNER.tenantId(), "other-project",
                timeline.revisionId(), initial.revisionId(), timeline.timelines()));
        assertThatThrownBy(() -> engine.edit(OWNER, actual.projectId(), "timeline-main", timeline.revisionId(),
                List.of(new ProjectTimelineEngine.AddScene(new Scene("scene-main", 0)))))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("revision outside the requested identity scope");
        assertThat(store.commits).isEqualTo(commitsAfterTimelineCreate);
        assertThat(store.delegate.project(OWNER, actual.projectId()).headRevisionId()).isEqualTo(timeline.revisionId());
    }

    private static final class RevisionScopeOverrideStore implements ProjectTimelineStore {
        private final ProjectTimelineStore delegate;
        private final Map<String, Revision> revisionOverrides = new HashMap<>();
        private Project projectOverride;
        private int commits;

        private RevisionScopeOverrideStore(ProjectTimelineStore delegate) { this.delegate = delegate; }

        @Override public Created create(Actor actor, String workspaceId, String title, String requestId,
                                        String projectId, String initialRevisionId) {
            return delegate.create(actor, workspaceId, title, requestId, projectId, initialRevisionId);
        }

        @Override public Project project(Actor actor, String projectId) {
            return projectOverride == null ? delegate.project(actor, projectId) : projectOverride;
        }

        @Override public Revision revision(Actor actor, String projectId, String revisionId) {
            return revisionOverrides.getOrDefault(revisionId, delegate.revision(actor, projectId, revisionId));
        }

        @Override public Revision commit(Actor actor, String projectId, String expectedHeadRevisionId,
                                         String newRevisionId, List<TimelineSnapshot> timelines) {
            commits++;
            return delegate.commit(actor, projectId, expectedHeadRevisionId, newRevisionId, timelines);
        }
    }
}
