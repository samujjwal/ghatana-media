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
        assertThat(first.initialRevision().timelines()).isEmpty();
        Revision timeline = engine.createTimeline(OWNER, first.project().projectId(),
                first.initialRevision().revisionId(), "timeline-1");
        Revision edited = engine.edit(OWNER, first.project().projectId(), "timeline-1", timeline.revisionId(),
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
    void timelineSemanticVersionMustBeDistinctFromContainingProjectRevision() {
        Graph graph = Graph.empty("timeline-version-boundary");
        TimelineSnapshot snapshot = new TimelineSnapshot("revision-version-boundary", graph);

        assertThatThrownBy(() -> new Revision(OWNER.tenantId(), "project-version-boundary",
                "revision-version-boundary", null, List.of(snapshot)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("timeline semanticVersionId must differ from project revisionId");
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
            default -> "generated-valid-" + generated.get();
        });

        assertThatThrownBy(() -> engine.createProject(OWNER, "workspace-a", "Cut", "generated-id-retry"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("id supplier returned an invalid opaque id");

        Created created = engine.createProject(OWNER, "workspace-a", "Cut", "generated-id-retry");
        assertThat(created.createdNow()).isTrue();
        assertThat(created.project().projectId()).isEqualTo("project-valid");
        assertThat(created.initialRevision().revisionId()).isEqualTo("revision-valid");
        assertThat(created.initialRevision().timelines()).isEmpty();
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
                    "direct-project-" + invalid.hashCode(), "direct-revision"))
                    .as("direct store requestId %s", invalid)
                    .isInstanceOf(IllegalArgumentException.class);
        }

        assertThat(engine.createProject(OWNER, "workspace-a", "Cut", "a:b.c_d~e-f").createdNow()).isTrue();
        assertThat(store.create(OWNER, "workspace-a", "Cut", "a.b_c~d-e",
                "direct-project-valid", "direct-revision-valid").createdNow()).isTrue();
        assertThat(store.create(OWNER, "workspace-a", "Cut", "a:b.direct",
                "direct-project-colon", "direct-revision-colon").createdNow()).isTrue();

        NotAdmittedProjectTimelineStore unavailable = new NotAdmittedProjectTimelineStore();
        assertThatThrownBy(() -> unavailable.create(OWNER, "workspace-a", "Cut", ":bad",
                "invalid-not-admitted-project", "invalid-not-admitted-revision"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> unavailable.create(OWNER, "workspace-a", "Cut", "a:b",
                "not-admitted-project", "not-admitted-revision"))
                .isInstanceOf(MediaCapabilityNotAdmittedException.class);
    }

    @Test
    void directStoreCreateRejectsInvalidTitleBeforeRecordingIdempotencyReceipt() {
        InMemoryProjectTimelineStore store = new InMemoryProjectTimelineStore();

        for (String invalidTitle : List.of("", "  ", "x".repeat(201))) {
            assertThatThrownBy(() -> store.create(OWNER, "workspace-a", invalidTitle, "create-title-boundary",
                    "project-invalid", "revision-invalid"))
                    .isInstanceOf(IllegalArgumentException.class);
        }

        Created created = store.create(OWNER, "workspace-a", "Cut", "create-title-boundary",
                "project-valid", "revision-valid");
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
                "unicode-project-1", "unicode-revision-1").project().title())
                .isEqualTo(preserved);
        assertThat(store.create(OWNER, "workspace-a", maximum, "unicode-store-2",
                "unicode-project-2", "unicode-revision-2").project().title())
                .isEqualTo(maximum);
        assertThatThrownBy(() -> store.create(OWNER, "workspace-a", tooLong, "unicode-store-3",
                "unicode-project-3", "unicode-revision-3"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("200 character project limit");
    }

    @Test
    void editRestoreDiffAndSourceRevocationUseExactImmutableVersions() {
        ProjectTimelineEngine engine = engine();
        Created created = engine.createProject(OWNER, "workspace-a", "Cut", "create-2");
        String projectId = created.project().projectId();
        assertThat(created.initialRevision().timelines()).isEmpty();
        Revision timeline = engine.createTimeline(OWNER, projectId, created.initialRevision().revisionId(), "timeline-1");
        String initialSemanticVersion = timeline.timelines().getFirst().semanticVersionId();
        Revision edited = engine.edit(OWNER, projectId, "timeline-1", timeline.revisionId(), List.of(
                new ProjectTimelineEngine.AddScene(new Scene("scene-1", 0)),
                new ProjectTimelineEngine.AddTrack(new Track("track-1", "scene-1", TrackKind.VIDEO, 0)),
                new ProjectTimelineEngine.PutClip(clip("clip-1", "scene-1", "track-1"))));
        assertThat(edited.parentRevisionId()).isEqualTo(timeline.revisionId());
        assertThat(timeline(edited, "timeline-1").graph().clips()).hasSize(1);
        assertThat(timeline(edited, "timeline-1").semanticVersionId()).isNotEqualTo(initialSemanticVersion);

        ProjectTimelineEngine.GraphDiff diff = ProjectTimelineEngine.diff(
                timeline(timeline, "timeline-1").graph(), timeline(edited, "timeline-1").graph());
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
        assertThat(undo.timelines()).isEmpty();
        Revision redo = engine.restore(OWNER, projectId, undo.revisionId(), edited.revisionId());
        assertThat(timeline(redo, "timeline-1").graph()).isEqualTo(timeline(edited, "timeline-1").graph());
        assertThat(timeline(redo, "timeline-1").semanticVersionId())
                .isNotEqualTo(timeline(edited, "timeline-1").semanticVersionId());
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
    void revisionDiffReadsOwnerScopedImmutableSnapshotsAndReturnsTheirIds() {
        ProjectTimelineEngine engine = engine();
        Created created = engine.createProject(OWNER, "workspace-a", "Cut", "revision-diff");
        Revision timeline = engine.createTimeline(OWNER, created.project().projectId(),
                created.initialRevision().revisionId(), "timeline-1");
        Revision edited = engine.edit(OWNER, created.project().projectId(), "timeline-1", timeline.revisionId(),
                List.of(new ProjectTimelineEngine.AddScene(new Scene("scene-z", 0)),
                        new ProjectTimelineEngine.AddScene(new Scene("scene-a", 1))));

        ProjectTimelineEngine.RevisionDiff result = engine.diff(OWNER, created.project().projectId(),
                timeline.revisionId(), edited.revisionId());

        assertThat(result.fromRevisionId()).isEqualTo(timeline.revisionId());
        assertThat(result.toRevisionId()).isEqualTo(edited.revisionId());
        assertThat(result.addedTimelineIds()).isEmpty();
        assertThat(result.removedTimelineIds()).isEmpty();
        var timelineChange = result.timelineChanges().get("timeline-1");
        assertThat(timelineChange.fromSemanticVersionId()).isEqualTo(timeline(timeline, "timeline-1").semanticVersionId());
        assertThat(timelineChange.toSemanticVersionId()).isEqualTo(timeline(edited, "timeline-1").semanticVersionId());
        assertThat(timelineChange.changes().addedScenes()).containsExactly("scene-a", "scene-z");
        assertThat(timelineChange.changes().removedScenes()).isEmpty();
        assertThat(timelineChange.changes().changedScenes()).isEmpty();
        ProjectTimelineEngine.RevisionDiff same = engine.diff(OWNER, created.project().projectId(),
                edited.revisionId(), edited.revisionId());
        assertThat(same.timelineChanges().get("timeline-1").fromSemanticVersionId())
                .isEqualTo(same.timelineChanges().get("timeline-1").toSemanticVersionId());
        assertThat(same.timelineChanges().get("timeline-1").changes().addedScenes()).isEmpty();
        ProjectTimelineEngine.RevisionDiff reverse = engine.diff(OWNER, created.project().projectId(),
                edited.revisionId(), timeline.revisionId());
        assertThat(reverse.timelineChanges().get("timeline-1").changes().removedScenes())
                .containsExactly("scene-a", "scene-z");
        ProjectTimelineEngine.RevisionDiff membership = engine.diff(OWNER, created.project().projectId(),
                created.initialRevision().revisionId(), edited.revisionId());
        assertThat(membership.addedTimelineIds()).containsExactly("timeline-1");
        assertThatThrownBy(() -> engine.diff(OWNER, created.project().projectId(), "unknown-revision",
                edited.revisionId()))
                .isInstanceOf(ProjectNotFoundException.class)
                .hasMessage("project is not available in this tenant scope");
        assertThatThrownBy(() -> engine.diff(OWNER, created.project().projectId(),
                created.initialRevision().revisionId(), "unknown-revision"))
                .isInstanceOf(ProjectNotFoundException.class)
                .hasMessage("project is not available in this tenant scope");
        assertThatThrownBy(() -> engine.diff(new Actor("tenant-a", "another-principal"),
                created.project().projectId(), created.initialRevision().revisionId(), edited.revisionId()))
                .isInstanceOf(ProjectAccessDeniedException.class)
                .hasMessage("principal is not authorized to edit this project");
    }

    @Test
    void malformedRevisionDiffIdsAreRejectedBeforeAnyStoreRead() {
        AtomicInteger revisionReads = new AtomicInteger();
        ProjectTimelineStore store = new ProjectTimelineStore() {
            @Override public Created create(Actor actor, String workspaceId, String title, String requestId,
                                            String projectId, String initialRevisionId) {
                throw new AssertionError("diff must not create projects");
            }
            @Override public Project project(Actor actor, String projectId) {
                throw new AssertionError("diff must not read the project head");
            }
            @Override public Revision revision(Actor actor, String projectId, String revisionId) {
                revisionReads.incrementAndGet();
                throw new AssertionError("malformed revision IDs must be rejected before store reads");
            }
            @Override public Revision commit(Actor actor, String projectId, String expectedHeadRevisionId,
                                             String newRevisionId, List<TimelineSnapshot> timelines) {
                throw new AssertionError("diff must not commit revisions");
            }
        };
        ProjectTimelineEngine engine = new ProjectTimelineEngine(store);

        assertThatThrownBy(() -> engine.diff(OWNER, "project-valid", " bad", "revision-valid"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("fromRevisionId must be a 1-128 character opaque id");
        assertThatThrownBy(() -> engine.diff(OWNER, "project-valid", "revision-valid", "revision/invalid"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("toRevisionId must be a 1-128 character opaque id");
        assertThat(revisionReads).hasValue(0);
    }

    @Test
    void revisionDiffRejectsStoreRowsOutsideRequestedTenantProjectOrRevisionScope() {
        String projectId = "project-valid";
        String fromId = "revision-from";
        String toId = "revision-to";
        List<TimelineSnapshot> timelines = List.of();

        for (int corruptRead = 1; corruptRead <= 2; corruptRead++) {
            int failOnRead = corruptRead;
            String expectedRevisionId = corruptRead == 1 ? fromId : toId;
            List<Revision> aliasedRows = List.of(
                    new Revision("tenant-other", projectId, expectedRevisionId, null, timelines),
                    new Revision(OWNER.tenantId(), "project-other", expectedRevisionId, null, timelines),
                    new Revision(OWNER.tenantId(), projectId, "revision-other", null, timelines));
            for (Revision aliased : aliasedRows) {
                AtomicInteger revisionReads = new AtomicInteger();
                ProjectTimelineStore store = new ProjectTimelineStore() {
                    @Override public Created create(Actor actor, String workspaceId, String title, String requestId,
                                                    String createdProjectId, String initialRevisionId) {
                        throw new AssertionError("diff must not create projects");
                    }
                    @Override public Project project(Actor actor, String readProjectId) {
                        throw new AssertionError("diff must not read the project head");
                    }
                    @Override public Revision revision(Actor actor, String readProjectId, String revisionId) {
                        int read = revisionReads.incrementAndGet();
                        if (read == failOnRead) return aliased;
                        return new Revision(actor.tenantId(), readProjectId, revisionId, null, timelines);
                    }
                    @Override public Revision commit(Actor actor, String readProjectId,
                                                     String expectedHeadRevisionId, String newRevisionId,
                                                     List<TimelineSnapshot> nextTimelines) {
                        throw new AssertionError("diff must not commit revisions");
                    }
                };

                assertThatThrownBy(() -> new ProjectTimelineEngine(store).diff(OWNER, projectId, fromId, toId))
                        .isInstanceOf(IllegalStateException.class)
                        .hasMessage("project timeline store returned a revision outside the requested identity scope");
                assertThat(revisionReads).hasValue(corruptRead);
            }
        }
    }

    @Test
    void graphDiffIdentityListsAreDeterministicAndIndependentOfDisplayOrder() {
        Graph before = Graph.empty("timeline-diff-order");
        Graph after = new Graph("timeline-diff-order", List.of(
                new Scene("z-scene", 0), new Scene("a-scene", 1)), List.of(), List.of());

        ProjectTimelineEngine.GraphDiff diff = ProjectTimelineEngine.diff(before, after);

        // Graph presentation follows scene order; diff output follows stable identity order.
        assertThat(after.scenes()).extracting(Scene::sceneId).containsExactly("z-scene", "a-scene");
        assertThat(diff.addedScenes()).containsExactly("a-scene", "z-scene");
        assertThat(ProjectTimelineEngine.diff(before,
                new Graph("timeline-diff-order", List.of(new Scene("a-scene", 1), new Scene("z-scene", 0)),
                        List.of(), List.of())))
                .isEqualTo(diff);
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
        Revision timeline = createTimeline(engine, created, "timeline-1");
        Revision edited = engine.edit(OWNER, created.project().projectId(), "timeline-1", timeline.revisionId(), List.of(
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
    void sourceAuthorityChecksRejectRevisionRowsOutsideRequestedIdentityScope() {
        AtomicInteger authorityCalls = new AtomicInteger();
        Scene scene = new Scene("foreign-scene", 0);
        Track track = new Track("foreign-track", scene.sceneId(), TrackKind.VIDEO, 0);
        TimelineSnapshot foreignTimeline = new TimelineSnapshot("semantic-foreign",
                new Graph("timeline-foreign", List.of(scene), List.of(track),
                        List.of(clip("foreign-clip", scene.sceneId(), track.trackId()))));
        ProjectTimelineStore aliasedStore = new ProjectTimelineStore() {
            @Override public Created create(Actor actor, String workspaceId, String title, String requestId,
                                            String projectId, String initialRevisionId) {
                throw new AssertionError("source checks must not create projects");
            }
            @Override public Project project(Actor actor, String projectId) {
                throw new AssertionError("source checks must not read the project head");
            }
            @Override public Revision revision(Actor actor, String projectId, String revisionId) {
                return new Revision("tenant-other", "project-other", "revision-other", null, List.of(foreignTimeline));
            }
            @Override public Revision commit(Actor actor, String projectId, String expectedHeadRevisionId,
                                             String newRevisionId, List<TimelineSnapshot> timelines) {
                throw new AssertionError("source checks must not commit revisions");
            }
        };
        ProjectTimelineEngine engine = new ProjectTimelineEngine(aliasedStore);

        assertThatThrownBy(() -> engine.requireCurrentSources(OWNER, "project-requested", "revision-requested",
                source -> {
                    authorityCalls.incrementAndGet();
                    return true;
                }))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("project timeline store returned a revision outside the requested identity scope");
        assertThatThrownBy(() -> engine.requireCurrentSources(OWNER, "project-requested", "revision-requested",
                (SourceEligibilityPort) (actor, source) -> {
                    authorityCalls.incrementAndGet();
                    return SourceEligibility.ELIGIBLE;
                }))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("project timeline store returned a revision outside the requested identity scope");
        assertThat(authorityCalls).hasValue(0);
    }

    @Test
    void sourceAuthorityChecksLaterTimelineClipsAndFailsClosed() {
        ProjectTimelineEngine engine = engine();
        Created created = engine.createProject(OWNER, "workspace-a", "Cut", "create-authority-all-timelines");
        Revision timelineA = engine.createTimeline(OWNER, created.project().projectId(),
                created.initialRevision().revisionId(), "timeline-a");
        Revision timelineB = engine.createTimeline(OWNER, created.project().projectId(),
                timelineA.revisionId(), "timeline-b");
        Revision withAClip = engine.edit(OWNER, created.project().projectId(), "timeline-a",
                timelineB.revisionId(), List.of(
                        new ProjectTimelineEngine.AddScene(new Scene("scene-a", 0)),
                        new ProjectTimelineEngine.AddTrack(new Track("track-a", "scene-a", TrackKind.VIDEO, 0)),
                        new ProjectTimelineEngine.PutClip(clip("clip-a", "scene-a", "track-a"))));
        Revision withBothClips = engine.edit(OWNER, created.project().projectId(), "timeline-b",
                withAClip.revisionId(), List.of(
                        new ProjectTimelineEngine.AddScene(new Scene("scene-b", 0)),
                        new ProjectTimelineEngine.AddTrack(new Track("track-b", "scene-b", TrackKind.VIDEO, 0)),
                        new ProjectTimelineEngine.PutClip(new Clip("clip-b", "scene-b", "track-b",
                                new SourceVersion("artifact-later", "version-2"),
                                new RationalTime(0, 30_000, 1_001, Clock.SOURCE_PRESENTATION),
                                new RationalTime(30_000, 30_000, 1_001, Clock.SOURCE_PRESENTATION),
                                new RationalTime(0, 24, 1, Clock.STORY),
                                new RationalTime(24, 24, 1, Clock.STORY)))));

        List<String> checked = new java.util.ArrayList<>();
        assertThatThrownBy(() -> engine.requireCurrentSources(OWNER, created.project().projectId(),
                withBothClips.revisionId(), (SourceEligibilityPort) (actor, source) -> {
                    checked.add(source.artifactId());
                    return source.artifactId().equals("artifact-1")
                            ? SourceEligibility.ELIGIBLE : SourceEligibility.REVOKED;
                }))
                .isInstanceOf(SourceEligibilityException.class)
                .satisfies(error -> assertThat(((SourceEligibilityException) error).observed())
                        .isEqualTo(SourceEligibility.REVOKED));
        assertThat(checked).containsExactly("artifact-1", "artifact-later");

        checked.clear();
        assertThatThrownBy(() -> engine.requireCurrentSources(OWNER, created.project().projectId(),
                withBothClips.revisionId(), (SourceEligibilityPort) (actor, source) -> {
                    checked.add(source.artifactId());
                    return source.artifactId().equals("artifact-1") ? SourceEligibility.ELIGIBLE : null;
                }))
                .isInstanceOf(SourceEligibilityException.class)
                .satisfies(error -> assertThat(((SourceEligibilityException) error).observed())
                        .isEqualTo(SourceEligibility.UNKNOWN));
        assertThat(checked).containsExactly("artifact-1", "artifact-later");
    }

    @Test
    void staleEditsFailWithoutOverwritingAndOwnershipDoesNotCrossTenantOrPrincipal() {
        ProjectTimelineEngine engine = engine();
        Created created = engine.createProject(OWNER, "workspace-a", "Cut", "create-3");
        String projectId = created.project().projectId();
        Revision timeline = createTimeline(engine, created, "timeline-1");
        Revision next = engine.edit(OWNER, projectId, "timeline-1", timeline.revisionId(),
                List.of(new ProjectTimelineEngine.AddScene(new Scene("scene-1", 0))));

        assertThatThrownBy(() -> engine.edit(OWNER, projectId, "timeline-1", timeline.revisionId(),
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
        Revision timeline = createTimeline(engine, created, "timeline-1");
        Revision edited = engine.edit(OWNER, created.project().projectId(), "timeline-1", timeline.revisionId(),
                List.of(new ProjectTimelineEngine.AddScene(new Scene("scene", 0))));

        for (String invalidHead : java.util.Arrays.asList(
                null, "", "  ", " head-1", "head-1 ", ":bad", "with space", "é", "x".repeat(129))) {
            assertThatThrownBy(() -> engine.edit(OWNER, created.project().projectId(), "timeline-1", invalidHead,
                    List.of(new ProjectTimelineEngine.AddScene(new Scene("other-scene", 1)))))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("expectedHeadRevisionId");
            assertThatThrownBy(() -> engine.restore(OWNER, created.project().projectId(), invalidHead,
                    created.initialRevision().revisionId()))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("expectedHeadRevisionId");
        }

        assertThatThrownBy(() -> engine.edit(OWNER, "missing-project", "timeline-1", ":bad",
                List.of(new ProjectTimelineEngine.AddScene(new Scene("unreached-scene", 0)))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("expectedHeadRevisionId");
        assertThatThrownBy(() -> engine.restore(OWNER, "missing-project", ":bad", "missing-revision"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("expectedHeadRevisionId");
        assertThatThrownBy(() -> engine.edit(OWNER, "missing-project", "timeline-1", " head-1",
                List.of(new ProjectTimelineEngine.AddScene(new Scene("unreached-scene", 0)))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("expectedHeadRevisionId");
        assertThatThrownBy(() -> engine.restore(OWNER, "missing-project", "head-1 ", "missing-revision"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("expectedHeadRevisionId");

        assertThat(engine.project(OWNER, created.project().projectId()).headRevisionId()).isEqualTo(edited.revisionId());
    }

    @Test
    void concurrentCommandsWithSameHeadAllowExactlyOneCommit() throws Exception {
        ProjectTimelineEngine engine = engine();
        Created created = engine.createProject(OWNER, "workspace-a", "Cut", "create-4");
        Revision timeline = createTimeline(engine, created, "timeline-1");
        CountDownLatch ready = new CountDownLatch(2), go = new CountDownLatch(1);
        AtomicInteger success = new AtomicInteger(), conflicts = new AtomicInteger();
        Runnable first = command(engine, created, timeline, "scene-a", ready, go, success, conflicts);
        Runnable second = command(engine, created, timeline, "scene-b", ready, go, success, conflicts);
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
        Revision timeline = createTimeline(engine, created, "timeline-1");
        Revision withSceneAndTrack = engine.edit(OWNER, projectId, "timeline-1", timeline.revisionId(), List.of(
                new ProjectTimelineEngine.AddScene(new Scene("scene-1", 0)),
                new ProjectTimelineEngine.AddTrack(new Track("track-1", "scene-1", TrackKind.VIDEO, 0))));

        assertThatThrownBy(() -> engine.edit(OWNER, projectId, "timeline-1", withSceneAndTrack.revisionId(),
                List.of(new ProjectTimelineEngine.RemoveScene("scene-1"))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("remove tracks and clips explicitly");
        assertThat(engine.project(OWNER, projectId).headRevisionId()).isEqualTo(withSceneAndTrack.revisionId());
    }

    @Test
    void removeTrackWithExistingClipIsRejectedWithoutCascadeOrRevisionCommit() {
        ProjectTimelineEngine engine = engine();
        Created created = engine.createProject(OWNER, "workspace-a", "Cut", "remove-track-clip-1");
        String projectId = created.project().projectId();
        Revision timeline = createTimeline(engine, created, "timeline-1");
        Revision withTrackAndClip = engine.edit(OWNER, projectId, "timeline-1", timeline.revisionId(), List.of(
                new ProjectTimelineEngine.AddScene(new Scene("scene-1", 0)),
                new ProjectTimelineEngine.AddTrack(new Track("track-1", "scene-1", TrackKind.VIDEO, 0)),
                new ProjectTimelineEngine.PutClip(clip("clip-1", "scene-1", "track-1"))));
        String beforeHeadRevisionId = engine.project(OWNER, projectId).headRevisionId();
        Revision beforeHead = engine.currentRevision(OWNER, projectId);

        assertThatThrownBy(() -> engine.edit(OWNER, projectId, "timeline-1", beforeHeadRevisionId,
                List.of(new ProjectTimelineEngine.RemoveTrack("track-1"))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("track with clips cannot be removed; remove clips explicitly");

        assertThat(engine.project(OWNER, projectId).headRevisionId()).isEqualTo(beforeHeadRevisionId);
        assertThat(engine.currentRevision(OWNER, projectId)).isEqualTo(beforeHead);
        assertThat(engine.revision(OWNER, projectId, withTrackAndClip.revisionId())).isEqualTo(withTrackAndClip);
        assertThat(timeline(engine.currentRevision(OWNER, projectId), "timeline-1").graph().tracks())
                .containsExactly(new Track("track-1", "scene-1", TrackKind.VIDEO, 0));
        assertThat(timeline(engine.currentRevision(OWNER, projectId), "timeline-1").graph().clips())
                .containsExactly(clip("clip-1", "scene-1", "track-1"));
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
        Revision timeline = createTimeline(engine, created, "timeline-1");
        assertThatThrownBy(() -> engine.edit(OWNER, created.project().projectId(), "timeline-1", timeline.revisionId(),
                List.of(new ProjectTimelineEngine.AddScene(scene), new ProjectTimelineEngine.AddTrack(track),
                        new ProjectTimelineEngine.RemoveClip("missing-clip"))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("clip does not exist");
        assertThat(engine.project(OWNER, created.project().projectId()).headRevisionId())
                .isEqualTo(timeline.revisionId());
        assertThat(store.revision(OWNER, created.project().projectId(), created.initialRevision().revisionId()).timelines())
                .isEmpty();
    }

    @Test
    void timelinesKeepIndependentGraphsAndSemanticVersionsAcrossProjectRevisions() {
        ProjectTimelineEngine engine = engine();
        Created created = engine.createProject(OWNER, "workspace-a", "Cut", "create-timeline-id");
        assertThat(created.initialRevision().timelines()).isEmpty();
        Revision firstTimeline = engine.createTimeline(OWNER, created.project().projectId(),
                created.initialRevision().revisionId(), "timeline-a");
        Revision secondTimeline = engine.createTimeline(OWNER, created.project().projectId(),
                firstTimeline.revisionId(), "timeline-b");
        TimelineSnapshot initialA = timeline(secondTimeline, "timeline-a");
        TimelineSnapshot initialB = timeline(secondTimeline, "timeline-b");

        Revision editedA = engine.edit(OWNER, created.project().projectId(), "timeline-a", secondTimeline.revisionId(),
                List.of(new ProjectTimelineEngine.AddScene(new Scene("scene-a", 0))));
        assertThat(timeline(editedA, "timeline-a").semanticVersionId()).isNotEqualTo(initialA.semanticVersionId());
        assertThat(timeline(editedA, "timeline-b")).isEqualTo(initialB);

        Revision editedB = engine.edit(OWNER, created.project().projectId(), "timeline-b", editedA.revisionId(),
                List.of(new ProjectTimelineEngine.AddScene(new Scene("scene-b", 0))));
        assertThat(timeline(editedB, "timeline-a")).isEqualTo(timeline(editedA, "timeline-a"));
        assertThat(timeline(editedB, "timeline-b").semanticVersionId()).isNotEqualTo(initialB.semanticVersionId());
        ProjectTimelineEngine.RevisionDiff diff = engine.diff(OWNER, created.project().projectId(),
                secondTimeline.revisionId(), editedB.revisionId());
        assertThat(diff.timelineChanges()).containsKeys("timeline-a", "timeline-b");
        assertThat(diff.timelineChanges().get("timeline-a").fromSemanticVersionId())
                .isEqualTo(initialA.semanticVersionId());
        assertThat(diff.timelineChanges().get("timeline-b").fromSemanticVersionId())
                .isEqualTo(initialB.semanticVersionId());
    }

    @Test
    void emptyEditDoesNotCreateARevision() {
        ProjectTimelineEngine engine = engine();
        Created created = engine.createProject(OWNER, "workspace-a", "Cut", "create-6");
        Revision timeline = createTimeline(engine, created, "timeline-1");

        assertThatThrownBy(() -> engine.edit(OWNER, created.project().projectId(),
                "timeline-1", timeline.revisionId(), List.of()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("at least one operation");
        assertThat(engine.project(OWNER, created.project().projectId()).headRevisionId())
                .isEqualTo(timeline.revisionId());
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

    private static Runnable command(ProjectTimelineEngine engine, Created created, Revision timeline, String sceneId,
                                    CountDownLatch ready, CountDownLatch go, AtomicInteger success,
                                    AtomicInteger conflicts) {
        return () -> {
            ready.countDown();
            try {
                go.await();
                engine.edit(OWNER, created.project().projectId(), "timeline-1", timeline.revisionId(),
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

    private static Revision createTimeline(ProjectTimelineEngine engine, Created created, String timelineId) {
        assertThat(created.initialRevision().timelines()).isEmpty();
        return engine.createTimeline(OWNER, created.project().projectId(),
                created.initialRevision().revisionId(), timelineId);
    }

    private static TimelineSnapshot timeline(Revision revision, String timelineId) {
        return revision.timelines().stream().filter(snapshot -> snapshot.timelineId().equals(timelineId))
                .findFirst().orElseThrow();
    }

    private static Clip clip(String id, String sceneId, String trackId) {
        return new Clip(id, sceneId, trackId, new SourceVersion("artifact-1", "version-7"),
                new RationalTime(0, 30_000, 1_001, Clock.SOURCE_PRESENTATION),
                new RationalTime(30_000, 30_000, 1_001, Clock.SOURCE_PRESENTATION),
                new RationalTime(86_400L * 24, 24, 1, Clock.STORY),
                new RationalTime(24, 24, 1, Clock.STORY));
    }
}
