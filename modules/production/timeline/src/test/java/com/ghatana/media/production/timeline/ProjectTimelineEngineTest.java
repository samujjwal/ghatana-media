package com.ghatana.media.production.timeline;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.runtime.MediaCapabilityNotAdmittedException;
import java.util.AbstractList;
import java.util.Iterator;
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
        Revision edited = engine.edit(OWNER, first.project().projectId(), first.initialRevision().revisionId(),
                List.of(new ProjectTimelineEngine.AddScene(new Scene("later-scene", 0))));
        Created lateReplay = engine.createProject(OWNER, "workspace-a", "Cut", "create-1");
        assertThat(lateReplay.initialRevision().revisionId()).isEqualTo(first.initialRevision().revisionId());
        assertThat(lateReplay.project().headRevisionId()).isEqualTo(first.initialRevision().revisionId());
        assertThatThrownBy(() -> engine.createProject(OWNER, "workspace-b", "Cut", "create-1"))
                .isInstanceOf(IdempotencyConflictException.class);

        Created replayAfterConflict = engine.createProject(OWNER, "workspace-a", "Cut", "create-1");
        assertThat(replayAfterConflict).isEqualTo(lateReplay);
        assertThat(engine.project(OWNER, first.project().projectId()).headRevisionId())
                .isEqualTo(edited.revisionId());
    }

    @Test
    void sameRequestIdBoundToDifferentTitleConflictsAndPreservesOriginalReceipt() {
        ProjectTimelineEngine engine = engine();
        Created first = engine.createProject(OWNER, "workspace-a", "Cut", "create-title-1");

        assertThatThrownBy(() -> engine.createProject(OWNER, "workspace-a", "Renamed cut", "create-title-1"))
                .isInstanceOf(IdempotencyConflictException.class);

        Created replay = engine.createProject(OWNER, "workspace-a", "Cut", "create-title-1");
        assertThat(replay.createdNow()).isFalse();
        assertThat(replay.project()).isEqualTo(first.project());
        assertThat(replay.initialRevision()).isEqualTo(first.initialRevision());
        assertThat(engine.project(OWNER, first.project().projectId()).headRevisionId())
                .isEqualTo(first.initialRevision().revisionId());
    }

    @Test
    void generatedIdsMustMatchOpaqueIdentityContractBeforeStoreCreate() {
        InMemoryProjectTimelineStore store = new InMemoryProjectTimelineStore();
        AtomicInteger generated = new AtomicInteger();
        ProjectTimelineEngine engine = new ProjectTimelineEngine(store, () -> switch (generated.getAndIncrement()) {
            case 0 -> "invalid id";
            case 1 -> "project-valid";
            case 2 -> "revision-valid";
            default -> "timeline-valid";
        });

        assertThatThrownBy(() -> engine.createProject(OWNER, "workspace-a", "Cut", "generated-id-retry"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("id supplier returned an invalid opaque id");

        Created created = engine.createProject(OWNER, "workspace-a", "Cut", "generated-id-retry");
        assertThat(created.createdNow()).isTrue();
        assertThat(created.project().projectId()).isEqualTo("project-valid");
        assertThat(created.initialRevision().revisionId()).isEqualTo("revision-valid");
        assertThat(created.initialRevision().graph().timelineId()).isEqualTo("timeline-valid");
    }

    @Test
    void createRequestIdMatchesOwnerWireSchemaAtEngineAndStoreBoundaries() {
        InMemoryProjectTimelineStore store = new InMemoryProjectTimelineStore();
        AtomicInteger nextId = new AtomicInteger();
        ProjectTimelineEngine engine = new ProjectTimelineEngine(store, () -> "generated-id-" + nextId.getAndIncrement());
        String maximum = "A" + "._~-".repeat(31) + "._~";
        assertThat(maximum).hasSize(128);
        assertThat(engine.createProject(OWNER, "workspace-a", "Cut", maximum).createdNow()).isTrue();

        for (String invalid : List.of("", ":bad", "a".repeat(129), "å", "_first")) {
            assertThatThrownBy(() -> engine.createProject(OWNER, "workspace-a", "Cut", invalid))
                    .as("engine requestId %s", invalid)
                    .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> store.create(OWNER, "workspace-a", "Cut", invalid,
                    "direct-project-" + invalid.hashCode(), "direct-revision", "direct-timeline"))
                    .as("direct store requestId %s", invalid)
                    .isInstanceOf(IllegalArgumentException.class);
        }

        assertThat(engine.createProject(OWNER, "workspace-a", "Cut", "a:b.c_d~e-f").createdNow()).isTrue();
        assertThat(store.create(OWNER, "workspace-a", "Cut", "a.b_c~d-e",
                "direct-project-valid", "direct-revision-valid", "direct-timeline").createdNow()).isTrue();
        assertThat(store.create(OWNER, "workspace-a", "Cut", "a:b.direct",
                "direct-project-colon", "direct-revision-colon", "direct-timeline-colon").createdNow()).isTrue();

        NotAdmittedProjectTimelineStore unavailable = new NotAdmittedProjectTimelineStore();
        assertThatThrownBy(() -> unavailable.create(OWNER, "workspace-a", "Cut", ":bad",
                "invalid-not-admitted-project", "invalid-not-admitted-revision", "invalid-not-admitted-timeline"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> unavailable.create(OWNER, "workspace-a", "Cut", "a:b",
                "not-admitted-project", "not-admitted-revision", "not-admitted-timeline"))
                .isInstanceOf(MediaCapabilityNotAdmittedException.class);
    }

    @Test
    void directStoreCreateRejectsInvalidTitleBeforeRecordingIdempotencyReceipt() {
        InMemoryProjectTimelineStore store = new InMemoryProjectTimelineStore();

        for (String invalidTitle : List.of("", "  ", "x".repeat(201))) {
            assertThatThrownBy(() -> store.create(OWNER, "workspace-a", invalidTitle, "create-title-boundary",
                    "project-invalid", "revision-invalid", "timeline-invalid"))
                    .isInstanceOf(IllegalArgumentException.class);
        }

        Created created = store.create(OWNER, "workspace-a", "Cut", "create-title-boundary",
                "project-valid", "revision-valid", "timeline-valid");
        assertThat(created.createdNow()).isTrue();
        assertThat(created.project().title()).isEqualTo("Cut");
    }

    @Test
    void projectTitlesPreserveUnicodeInputAndUseCodePointLengthAcrossEngineAndStore() {
        String preserved = " " + "😀".repeat(198) + " ";
        String maximum = "😀".repeat(200);
        String tooLong = "😀".repeat(201);
        assertThat(preserved.codePointCount(0, preserved.length())).isEqualTo(200);
        assertThat(preserved.length()).isGreaterThan(200);
        assertThat(maximum.codePointCount(0, maximum.length())).isEqualTo(200);

        ProjectTimelineEngine engine = engine();
        Created preservedProject = engine.createProject(OWNER, "workspace-a", preserved, "unicode-title-1");
        assertThat(preservedProject.project().title()).isEqualTo(preserved);
        assertThat(engine.createProject(OWNER, "workspace-a", maximum, "unicode-title-2")
                .project().title()).isEqualTo(maximum);
        assertThatThrownBy(() -> engine.createProject(OWNER, "workspace-a", tooLong, "unicode-title-3"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("200 character project limit");

        InMemoryProjectTimelineStore store = new InMemoryProjectTimelineStore();
        assertThat(store.create(OWNER, "workspace-a", preserved, "unicode-store-1",
                "unicode-project-1", "unicode-revision-1", "unicode-timeline-1").project().title())
                .isEqualTo(preserved);
        assertThat(store.create(OWNER, "workspace-a", maximum, "unicode-store-2",
                "unicode-project-2", "unicode-revision-2", "unicode-timeline-2").project().title())
                .isEqualTo(maximum);
        assertThatThrownBy(() -> store.create(OWNER, "workspace-a", tooLong, "unicode-store-3",
                "unicode-project-3", "unicode-revision-3", "unicode-timeline-3"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("200 character project limit");
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
        assertThatThrownBy(() -> engine.requireCurrentSources(OWNER, projectId, edited.revisionId(),
                (SourceEligibilityPort) (actor, source) -> SourceEligibility.REVOKED))
                .isInstanceOf(SourceEligibilityException.class)
                .satisfies(error -> assertThat(((SourceEligibilityException) error).observed())
                        .isEqualTo(SourceEligibility.REVOKED));
        assertThatThrownBy(() -> engine.requireCurrentSources(OWNER, projectId, edited.revisionId(),
                (SourceEligibilityPort) (actor, source) -> null))
                .isInstanceOf(SourceEligibilityException.class)
                .satisfies(error -> assertThat(((SourceEligibilityException) error).observed())
                        .isEqualTo(SourceEligibility.UNKNOWN));
        assertThatThrownBy(() -> engine.requireCurrentSources(OWNER, projectId, edited.revisionId(),
                (SourceEligibilityPort) null))
                .isInstanceOf(SourceEligibilityException.class)
                .satisfies(error -> assertThat(((SourceEligibilityException) error).observed())
                        .isEqualTo(SourceEligibility.UNKNOWN));
        engine.requireCurrentSources(OWNER, projectId, edited.revisionId(), (actor, source) -> {
            assertThat(actor).isEqualTo(OWNER);
            assertThat(source).isEqualTo(new SourceVersion("artifact-1", "version-7"));
            return SourceEligibility.ELIGIBLE;
        });
        engine.requireCurrentSources(OWNER, projectId, edited.revisionId(), source ->
                source.artifactId().equals("artifact-1") && source.artifactVersionId().equals("version-7"));

        Revision undo = engine.restore(OWNER, projectId, edited.revisionId(), created.initialRevision().revisionId());
        assertThat(undo.graph().clips()).isEmpty();
        Revision redo = engine.restore(OWNER, projectId, undo.revisionId(), edited.revisionId());
        assertThat(redo.graph()).isEqualTo(edited.graph());
        assertThat(redo.revisionId()).isNotEqualTo(edited.revisionId());

        assertThatThrownBy(() -> engine.restore(OWNER, projectId, undo.revisionId(),
                created.initialRevision().revisionId()))
                .isInstanceOf(RevisionConflictException.class)
                .satisfies(error -> assertThat(((RevisionConflictException) error).currentHeadRevisionId())
                        .isEqualTo(redo.revisionId()));
        assertThat(engine.project(OWNER, projectId).headRevisionId()).isEqualTo(redo.revisionId());
    }

    @Test
    void diffReportsExactSourceVersionReplacementAsChangedClip() {
        Scene scene = new Scene("scene-1", 0);
        Track track = new Track("track-1", scene.sceneId(), TrackKind.VIDEO, 0);
        Clip original = clip("clip-1", scene.sceneId(), track.trackId());
        Graph before = new Graph("timeline-1", List.of(scene), List.of(track), List.of(original));
        Clip replacement = new Clip(original.clipId(), original.sceneId(), original.trackId(),
                new SourceVersion("artifact-1", "version-8"), original.sourceIn(), original.sourceOut(),
                original.storyStart(), original.storyDuration());
        Graph after = ProjectTimelineEngine.apply(before, List.of(new ProjectTimelineEngine.PutClip(replacement)));

        ProjectTimelineEngine.GraphDiff diff = ProjectTimelineEngine.diff(before, after);

        assertThat(after.clips()).containsExactly(replacement);
        assertThat(diff.changedClips()).containsExactly("clip-1");
        assertThat(diff.addedClips()).isEmpty();
        assertThat(diff.removedClips()).isEmpty();
    }

    @Test
    void diffTreatsEquivalentRationalTickBasesAsTheSameClipValue() {
        Scene scene = new Scene("scene-1", 0);
        Track track = new Track("track-1", scene.sceneId(), TrackKind.VIDEO, 0);
        Clip original = clip("clip-1", scene.sceneId(), track.trackId());
        Clip sameExactTimes = new Clip(original.clipId(), original.sceneId(), original.trackId(), original.source(),
                new RationalTime(original.sourceIn().ticks() * 2, original.sourceIn().rateNumerator() * 2,
                        original.sourceIn().rateDenominator(), Clock.SOURCE_PRESENTATION),
                new RationalTime(original.sourceOut().ticks() * 2, original.sourceOut().rateNumerator() * 2,
                        original.sourceOut().rateDenominator(), Clock.SOURCE_PRESENTATION),
                new RationalTime(original.storyStart().ticks() * 2, original.storyStart().rateNumerator() * 2,
                        original.storyStart().rateDenominator(), Clock.STORY),
                new RationalTime(original.storyDuration().ticks() * 2,
                        original.storyDuration().rateNumerator() * 2,
                        original.storyDuration().rateDenominator(), Clock.STORY));
        Graph before = new Graph("timeline-1", List.of(scene), List.of(track), List.of(original));
        Graph after = new Graph("timeline-1", List.of(scene), List.of(track), List.of(sameExactTimes));

        assertThat(sameExactTimes).isEqualTo(original);
        assertThat(ProjectTimelineEngine.diff(before, after).changedClips()).isEmpty();
    }

    @Test
    void sourceAuthorityFailureIsUnknownAndDoesNotExposeAdapterDetails() {
        ProjectTimelineEngine engine = engine();
        Created created = engine.createProject(OWNER, "workspace-a", "Cut", "create-authority-failure");
        Revision edited = engine.edit(OWNER, created.project().projectId(), created.initialRevision().revisionId(), List.of(
                new ProjectTimelineEngine.AddScene(new Scene("scene-1", 0)),
                new ProjectTimelineEngine.AddTrack(new Track("track-1", "scene-1", TrackKind.VIDEO, 0)),
                new ProjectTimelineEngine.PutClip(clip("clip-1", "scene-1", "track-1"))));

        assertThatThrownBy(() -> engine.requireCurrentSources(OWNER, created.project().projectId(), edited.revisionId(),
                (SourceEligibilityPort) (actor, source) -> {
                    throw new IllegalStateException("private authority adapter detail");
                }))
                .isInstanceOf(SourceEligibilityException.class)
                .satisfies(error -> {
                    SourceEligibilityException unavailable = (SourceEligibilityException) error;
                    assertThat(unavailable.observed()).isEqualTo(SourceEligibility.UNKNOWN);
                    assertThat(unavailable.getCause()).isNull();
                    assertThat(unavailable.getMessage()).doesNotContain("private authority adapter detail");
                });
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
    void malformedExpectedHeadIsRejectedBeforeEditOrRestoreAndCannotMoveProjectHead() {
        ProjectTimelineEngine engine = engine();
        Created created = engine.createProject(OWNER, "workspace-a", "Cut", "create-bad-head");
        Revision edited = engine.edit(OWNER, created.project().projectId(), created.initialRevision().revisionId(),
                List.of(new ProjectTimelineEngine.AddScene(new Scene("scene", 0))));

        for (String invalidHead : java.util.Arrays.asList(
                null, "", "  ", ":bad", "with space", "é", "x".repeat(129))) {
            assertThatThrownBy(() -> engine.edit(OWNER, created.project().projectId(), invalidHead,
                    List.of(new ProjectTimelineEngine.AddScene(new Scene("other-scene", 1)))))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("expectedHeadRevisionId");
            assertThatThrownBy(() -> engine.restore(OWNER, created.project().projectId(), invalidHead,
                    created.initialRevision().revisionId()))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("expectedHeadRevisionId");
        }

        assertThatThrownBy(() -> engine.edit(OWNER, "missing-project", ":bad",
                List.of(new ProjectTimelineEngine.AddScene(new Scene("unreached-scene", 0)))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("expectedHeadRevisionId");
        assertThatThrownBy(() -> engine.restore(OWNER, "missing-project", ":bad", "missing-revision"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("expectedHeadRevisionId");

        assertThat(engine.project(OWNER, created.project().projectId()).headRevisionId()).isEqualTo(edited.revisionId());
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
    void editAlgebraIsDeterministicAndARejectedBatchLeavesTheHeadUntouched() {
        Graph empty = Graph.empty("timeline-1");
        Scene scene = new Scene("scene-1", 0);
        Track track = new Track("track-1", scene.sceneId(), TrackKind.VIDEO, 0);
        Clip clip = clip("clip-1", scene.sceneId(), track.trackId());
        List<ProjectTimelineEngine.Edit> forward = List.of(new ProjectTimelineEngine.AddScene(scene),
                new ProjectTimelineEngine.AddTrack(track), new ProjectTimelineEngine.PutClip(clip));

        Graph batched = ProjectTimelineEngine.apply(empty, forward);
        Graph sequential = ProjectTimelineEngine.apply(
                ProjectTimelineEngine.apply(ProjectTimelineEngine.apply(empty, List.of(forward.get(0))), List.of(forward.get(1))),
                List.of(forward.get(2)));
        Graph restored = ProjectTimelineEngine.apply(batched, List.of(new ProjectTimelineEngine.RemoveClip(clip.clipId()),
                new ProjectTimelineEngine.RemoveTrack(track.trackId()), new ProjectTimelineEngine.RemoveScene(scene.sceneId())));

        assertThat(batched).isEqualTo(sequential);
        assertThat(restored).isEqualTo(empty);

        InMemoryProjectTimelineStore store = new InMemoryProjectTimelineStore();
        AtomicInteger id = new AtomicInteger();
        ProjectTimelineEngine engine = new ProjectTimelineEngine(store, () -> "batch-id-" + id.incrementAndGet());
        Created created = engine.createProject(OWNER, "workspace-a", "Cut", "create-atomic-batch");
        assertThatThrownBy(() -> engine.edit(OWNER, created.project().projectId(), created.initialRevision().revisionId(),
                List.of(new ProjectTimelineEngine.AddScene(scene), new ProjectTimelineEngine.AddTrack(track),
                        new ProjectTimelineEngine.RemoveClip("missing-clip"))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("clip does not exist");
        assertThat(engine.project(OWNER, created.project().projectId()).headRevisionId())
                .isEqualTo(created.initialRevision().revisionId());
        assertThat(store.revision(OWNER, created.project().projectId(), created.initialRevision().revisionId()).graph())
                .isEqualTo(created.initialRevision().graph());
    }

    @Test
    void storeRejectsChangingTimelineIdentityAcrossRevisions() {
        InMemoryProjectTimelineStore store = new InMemoryProjectTimelineStore();
        AtomicInteger id = new AtomicInteger();
        ProjectTimelineEngine engine = new ProjectTimelineEngine(store, () -> "id-" + id.incrementAndGet());
        Created created = engine.createProject(OWNER, "workspace-a", "Cut", "create-timeline-id");

        assertThatThrownBy(() -> store.commit(OWNER, created.project().projectId(),
                created.initialRevision().revisionId(), "revision-new", Graph.empty("different-timeline")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("timeline identity is immutable");
        assertThat(engine.project(OWNER, created.project().projectId()).headRevisionId())
                .isEqualTo(created.initialRevision().revisionId());
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

    @Test
    void editCopyStopsAtBoundWhenCustomListUnderreportsItsIterator() {
        AtomicInteger visited = new AtomicInteger();
        List<ProjectTimelineEngine.Edit> underreported = new AbstractList<>() {
            @Override public ProjectTimelineEngine.Edit get(int index) {
                throw new UnsupportedOperationException("iterator is authoritative");
            }

            @Override public int size() { return 1; }

            @Override public Iterator<ProjectTimelineEngine.Edit> iterator() {
                return new Iterator<>() {
                    @Override public boolean hasNext() { return true; }
                    @Override public ProjectTimelineEngine.Edit next() {
                        visited.incrementAndGet();
                        return new ProjectTimelineEngine.AddScene(new Scene("scene-1", 0));
                    }
                };
            }
        };

        assertThatThrownBy(() -> ProjectTimelineEngine.apply(Graph.empty("timeline-bounded"), underreported))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("10000 operation limit");
        assertThat(visited).hasValue(10_000);
    }

    @Test
    void missingDurableAuthorityFailsClosedWithTypedNotAdmittedResult() {
        ProjectTimelineEngine engine = new ProjectTimelineEngine(new NotAdmittedProjectTimelineStore());

        assertThatThrownBy(() -> engine.createProject(OWNER, "workspace-a", "Cut", "create-unavailable"))
                .isInstanceOf(com.ghatana.media.runtime.MediaCapabilityNotAdmittedException.class)
                .satisfies(error -> {
                    var unavailable = (com.ghatana.media.runtime.MediaCapabilityNotAdmittedException) error;
                    assertThat(unavailable.reason())
                            .isEqualTo(com.ghatana.media.runtime.MediaCapabilityNotAdmittedException.Reason.NOT_ADMITTED);
                    assertThat(unavailable.modality()).isEqualTo("PROJECT_TIMELINE_STORE");
                });
    }

    @Test
    void repeatedFrameAccumulationMatchesExactDirectSumAfterLongDuration() {
        int frameCount = 1_000_000;
        RationalTime frameDuration = new RationalTime(1_001, 30_000, 1, Clock.STORY);
        RationalTime accumulated = new RationalTime(0, 1, 1, Clock.STORY);

        for (int frame = 0; frame < frameCount; frame++) {
            accumulated = accumulated.plus(frameDuration);
        }

        RationalTime directSum = new RationalTime((long) frameCount * 1_001, 30_000, 1, Clock.STORY);
        RationalTime expectedElapsed = new RationalTime(100_100, 3, 1, Clock.STORY);
        assertThat(accumulated.compareTo(directSum)).isZero();
        assertThat(accumulated.compareTo(expectedElapsed)).isZero();
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
