package com.ghatana.media.production.timeline;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.*;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Predicate;
import java.util.function.Supplier;

/** Applies deterministic graph edits and commits project revision changes through the store's CAS boundary. */
public final class ProjectTimelineEngine {
    private static final int MAX_EDIT_OPERATIONS = 10_000;
    private static final String REVISION_SCOPE_MISMATCH =
            "project timeline store returned a revision outside the requested identity scope";
    private static final String PROJECT_SCOPE_MISMATCH =
            "project timeline store returned a project outside the requested identity scope";
    private final ProjectTimelineStore store;
    private final Supplier<String> ids;

    public ProjectTimelineEngine(ProjectTimelineStore store) {
        this(store, () -> java.util.UUID.randomUUID().toString());
    }

    public ProjectTimelineEngine(ProjectTimelineStore store, Supplier<String> ids) {
        this.store = Objects.requireNonNull(store, "store");
        this.ids = Objects.requireNonNull(ids, "ids");
    }

    public Created createProject(Actor actor, String workspaceId, String title, String requestId) {
        Objects.requireNonNull(actor, "actor");
        requireCreateProjectRequestId(requestId);
        requireSelectedWorkspaceId(workspaceId);
        requiredProjectTitle(title);
        return store.create(actor, workspaceId, title, requestId, nextId(), nextId());
    }

    public Project project(Actor actor, String projectId) {
        Objects.requireNonNull(actor, "actor");
        requiredOpaqueId(projectId, "projectId");
        Project project = store.project(actor, projectId);
        if (project == null
                || !Objects.equals(actor.tenantId(), project.tenantId())
                || !Objects.equals(projectId, project.projectId())) {
            throw new IllegalStateException(PROJECT_SCOPE_MISMATCH);
        }
        return project;
    }

    /** Reads one immutable revision through the store's tenant/project and actor-authorization boundary. */
    public Revision revision(Actor actor, String projectId, String revisionId) {
        Objects.requireNonNull(actor, "actor");
        requiredOpaqueId(projectId, "projectId");
        requiredOpaqueId(revisionId, "revisionId");
        return requireRevisionIdentity(actor, projectId, revisionId,
                store.revision(actor, projectId, revisionId));
    }

    /** Reads the currently committed head and its immutable timeline snapshot. */
    public Revision currentRevision(Actor actor, String projectId) {
        Project project = project(actor, projectId);
        return revision(actor, projectId, project.headRevisionId());
    }

    public Revision createTimeline(Actor actor, String projectId, String expectedHeadRevisionId, String timelineId) {
        requireExpectedHead(expectedHeadRevisionId);
        requiredOpaqueId(timelineId, "timelineId");
        Project project = project(actor, projectId);
        Revision head = revision(actor, projectId, project.headRevisionId());
        if (!head.revisionId().equals(expectedHeadRevisionId)) {
            throw new RevisionConflictException(expectedHeadRevisionId, head.revisionId());
        }
        if (head.timelines().stream().anyMatch(t -> t.timelineId().equals(timelineId))) {
            throw new IllegalArgumentException("timeline already exists in the project");
        }
        List<TimelineSnapshot> next = new ArrayList<>(head.timelines());
        next.add(new TimelineSnapshot(nextVersionId(), Graph.empty(timelineId)));
        String revisionId = nextId();
        return requireSuccessor(actor, projectId, expectedHeadRevisionId, revisionId,
                store.commit(actor, projectId, expectedHeadRevisionId, revisionId, next));
    }

    public Revision edit(Actor actor, String projectId, String timelineId, String expectedHeadRevisionId,
                         List<Edit> edits) {
        requireExpectedHead(expectedHeadRevisionId);
        requiredOpaqueId(timelineId, "timelineId");
        Project project = project(actor, projectId);
        Revision head = revision(actor, projectId, project.headRevisionId());
        if (!head.revisionId().equals(expectedHeadRevisionId)) {
            throw new RevisionConflictException(expectedHeadRevisionId, head.revisionId());
        }
        List<TimelineSnapshot> next = new ArrayList<>(head.timelines());
        int selected = indexOfTimeline(next, timelineId);
        TimelineSnapshot current = next.get(selected);
        Graph graph = apply(current.graph(), edits);
        next.set(selected, new TimelineSnapshot(nextVersionId(), graph));
        String revisionId = nextId();
        return requireSuccessor(actor, projectId, expectedHeadRevisionId, revisionId,
                store.commit(actor, projectId, expectedHeadRevisionId, revisionId, next));
    }

    /** Restore copies the target project's complete timeline set into a new successor revision. */
    public Revision restore(Actor actor, String projectId, String expectedHeadRevisionId, String targetRevisionId) {
        requireExpectedHead(expectedHeadRevisionId);
        requiredOpaqueId(targetRevisionId, "targetRevisionId");
        Project project = project(actor, projectId);
        Revision head = revision(actor, projectId, project.headRevisionId());
        if (!head.revisionId().equals(expectedHeadRevisionId)) {
            throw new RevisionConflictException(expectedHeadRevisionId, head.revisionId());
        }
        Revision target = revision(actor, projectId, targetRevisionId);
        Map<String, TimelineSnapshot> current = byTimeline(head.timelines());
        List<TimelineSnapshot> restored = new ArrayList<>();
        for (TimelineSnapshot snapshot : target.timelines()) {
            TimelineSnapshot prior = current.get(snapshot.timelineId());
            restored.add(prior != null && prior.graph().equals(snapshot.graph()) ? prior
                    : new TimelineSnapshot(nextVersionId(), snapshot.graph()));
        }
        String revisionId = nextId();
        return requireSuccessor(actor, projectId, expectedHeadRevisionId, revisionId,
                store.commit(actor, projectId, expectedHeadRevisionId, revisionId, restored));
    }

    /** Reads two actor-authorized immutable revisions and returns a stable graph delta between them. */
    public RevisionDiff diff(Actor actor, String projectId, String fromRevisionId, String toRevisionId) {
        requiredOpaqueId(fromRevisionId, "fromRevisionId");
        requiredOpaqueId(toRevisionId, "toRevisionId");
        Revision from = requireRevisionIdentity(actor, projectId, fromRevisionId,
                store.revision(actor, projectId, fromRevisionId));
        Revision to = requireRevisionIdentity(actor, projectId, toRevisionId,
                store.revision(actor, projectId, toRevisionId));
        Map<String, TimelineSnapshot> before = byTimeline(from.timelines());
        Map<String, TimelineSnapshot> after = byTimeline(to.timelines());
        List<String> added = after.keySet().stream().filter(id -> !before.containsKey(id)).sorted().toList();
        List<String> removed = before.keySet().stream().filter(id -> !after.containsKey(id)).sorted().toList();
        Map<String, TimelineDiff> changes = new java.util.TreeMap<>();
        before.keySet().stream().filter(after::containsKey).sorted().forEach(id -> {
            TimelineSnapshot oldTimeline = before.get(id);
            TimelineSnapshot newTimeline = after.get(id);
            changes.put(id, new TimelineDiff(id, oldTimeline.semanticVersionId(), newTimeline.semanticVersionId(),
                    diff(oldTimeline.graph(), newTimeline.graph())));
        });
        return new RevisionDiff(from.revisionId(), to.revisionId(), added, removed, changes);
    }

    private static Revision requireRevisionIdentity(Actor actor, String projectId, String revisionId,
                                                    Revision revision) {
        if (revision == null || actor == null
                || !Objects.equals(actor.tenantId(), revision.tenantId())
                || !Objects.equals(projectId, revision.projectId())
                || !Objects.equals(revisionId, revision.revisionId())) {
            throw new IllegalStateException(REVISION_SCOPE_MISMATCH);
        }
        return revision;
    }

    private static Revision requireSuccessor(Actor actor, String projectId, String expectedParentRevisionId,
                                             String revisionId, Revision revision) {
        Revision scoped = requireRevisionIdentity(actor, projectId, revisionId, revision);
        if (!Objects.equals(expectedParentRevisionId, scoped.parentRevisionId())) {
            throw new IllegalStateException(REVISION_SCOPE_MISMATCH);
        }
        return scoped;
    }

    /** Check live authority for every exact source before an external effect such as rendering. */
    public void requireCurrentSources(Actor actor, String projectId, String revisionId,
                                      Predicate<SourceVersion> currentlyEligible) {
        Revision revision = revision(actor, projectId, revisionId);
        if (revision.timelines().stream().allMatch(t -> t.graph().clips().isEmpty())) return;
        if (currentlyEligible == null) throw new SourceEligibilityException(SourceEligibility.UNKNOWN);
        for (Clip clip : revision.timelines().stream().flatMap(t -> t.graph().clips().stream()).toList()) {
            final boolean eligible;
            try {
                eligible = currentlyEligible.test(clip.source());
            } catch (RuntimeException unavailable) {
                throw new SourceEligibilityException(SourceEligibility.UNKNOWN);
            }
            if (!eligible) throw new SourceEligibilityException(SourceEligibility.REVOKED);
        }
    }

    /**
     * Preferred host binding: rechecks each exact artifact version against live authority.
     * Missing, null, revoked, or failing authority observations block the effect.
     */
    public void requireCurrentSources(Actor actor, String projectId, String revisionId,
                                      SourceEligibilityPort authority) {
        Revision revision = revision(actor, projectId, revisionId);
        if (revision.timelines().stream().allMatch(t -> t.graph().clips().isEmpty())) return;
        if (authority == null) throw new SourceEligibilityException(SourceEligibility.UNKNOWN);
        for (Clip clip : revision.timelines().stream().flatMap(t -> t.graph().clips().stream()).toList()) {
            final SourceEligibility current;
            try {
                current = authority.current(actor, clip.source());
            } catch (RuntimeException unavailable) {
                throw new SourceEligibilityException(SourceEligibility.UNKNOWN);
            }
            if (current != SourceEligibility.ELIGIBLE) {
                throw new SourceEligibilityException(current == null ? SourceEligibility.UNKNOWN : current);
            }
        }
    }

    public static Graph apply(Graph graph, List<Edit> edits) {
        Objects.requireNonNull(graph, "graph");
        List<Edit> commands = copyBoundedEdits(edits);
        if (commands.isEmpty()) throw new IllegalArgumentException("an edit command must contain at least one operation");
        Graph result = graph;
        for (Edit edit : commands) result = Objects.requireNonNull(edit, "edit").apply(result);
        return result;
    }

    /** Copies by actual iterator traversal; List.size() is only a hint for untrusted custom Lists. */
    private static List<Edit> copyBoundedEdits(List<Edit> edits) {
        if (edits == null) return List.of();
        List<Edit> commands = new ArrayList<>();
        Iterator<Edit> iterator = edits.iterator();
        while (commands.size() < MAX_EDIT_OPERATIONS && iterator.hasNext()) {
            commands.add(Objects.requireNonNull(iterator.next(), "edit"));
        }
        if (iterator.hasNext()) throw new IllegalArgumentException("an edit command exceeds the 10000 operation limit");
        return List.copyOf(commands);
    }

    public static GraphDiff diff(Graph before, Graph after) {
        Objects.requireNonNull(before, "before");
        Objects.requireNonNull(after, "after");
        if (!before.timelineId().equals(after.timelineId())) throw new IllegalArgumentException("cannot diff different timelines");
        ChangeSet scenes = changes(before.scenes(), after.scenes(), Scene::sceneId);
        ChangeSet tracks = changes(before.tracks(), after.tracks(), Track::trackId);
        ChangeSet clips = changes(before.clips(), after.clips(), Clip::clipId);
        return new GraphDiff(scenes.added(), scenes.removed(), scenes.changed(),
                tracks.added(), tracks.removed(), tracks.changed(),
                clips.added(), clips.removed(), clips.changed());
    }

    public sealed interface Edit permits AddScene, RemoveScene, AddTrack, RemoveTrack, PutClip, RemoveClip {
        Graph apply(Graph graph);
    }

    public record AddScene(Scene scene) implements Edit {
        public AddScene { Objects.requireNonNull(scene, "scene"); }
        @Override public Graph apply(Graph g) {
            List<Scene> values = new ArrayList<>(g.scenes()); values.add(scene);
            return graph(g, values, g.tracks(), g.clips());
        }
    }

    public record RemoveScene(String sceneId) implements Edit {
        public RemoveScene { sceneId = required(sceneId, "sceneId"); }
        @Override public Graph apply(Graph g) {
            if (g.scenes().stream().noneMatch(s -> s.sceneId().equals(sceneId))) {
                throw new IllegalArgumentException("scene does not exist in the current graph");
            }
            if (g.tracks().stream().anyMatch(t -> t.sceneId().equals(sceneId))) {
                throw new IllegalArgumentException("scene with tracks cannot be removed; remove tracks and clips explicitly");
            }
            return graph(g, g.scenes().stream().filter(s -> !s.sceneId().equals(sceneId)).toList(), g.tracks(), g.clips());
        }
    }

    public record AddTrack(Track track) implements Edit {
        public AddTrack { Objects.requireNonNull(track, "track"); }
        @Override public Graph apply(Graph g) {
            List<Track> values = new ArrayList<>(g.tracks()); values.add(track);
            return graph(g, g.scenes(), values, g.clips());
        }
    }

    public record RemoveTrack(String trackId) implements Edit {
        public RemoveTrack { trackId = required(trackId, "trackId"); }
        @Override public Graph apply(Graph g) {
            if (g.tracks().stream().noneMatch(t -> t.trackId().equals(trackId))) {
                throw new IllegalArgumentException("track does not exist in the current graph");
            }
            if (g.clips().stream().anyMatch(c -> c.trackId().equals(trackId))) {
                throw new IllegalArgumentException("track with clips cannot be removed; remove clips explicitly");
            }
            return graph(g, g.scenes(), g.tracks().stream().filter(t -> !t.trackId().equals(trackId)).toList(), g.clips());
        }
    }

    /** Adds a clip or replaces the same stable clip identity with a new immutable revision value. */
    public record PutClip(Clip clip) implements Edit {
        public PutClip { Objects.requireNonNull(clip, "clip"); }
        @Override public Graph apply(Graph g) {
            List<Clip> values = new ArrayList<>(g.clips());
            values.removeIf(existing -> existing.clipId().equals(clip.clipId()));
            values.add(clip);
            return graph(g, g.scenes(), g.tracks(), values);
        }
    }

    public record RemoveClip(String clipId) implements Edit {
        public RemoveClip { clipId = required(clipId, "clipId"); }
        @Override public Graph apply(Graph g) {
            if (g.clips().stream().noneMatch(c -> c.clipId().equals(clipId))) {
                throw new IllegalArgumentException("clip does not exist in the current graph");
            }
            return graph(g, g.scenes(), g.tracks(), g.clips().stream().filter(c -> !c.clipId().equals(clipId)).toList());
        }
    }

    public record GraphDiff(List<String> addedScenes, List<String> removedScenes, List<String> changedScenes,
                            List<String> addedTracks, List<String> removedTracks, List<String> changedTracks,
                            List<String> addedClips, List<String> removedClips, List<String> changedClips) {
        public GraphDiff {
            addedScenes = List.copyOf(addedScenes); removedScenes = List.copyOf(removedScenes); changedScenes = List.copyOf(changedScenes);
            addedTracks = List.copyOf(addedTracks); removedTracks = List.copyOf(removedTracks); changedTracks = List.copyOf(changedTracks);
            addedClips = List.copyOf(addedClips); removedClips = List.copyOf(removedClips); changedClips = List.copyOf(changedClips);
        }
    }

    public record TimelineDiff(String timelineId, String fromSemanticVersionId, String toSemanticVersionId,
                               GraphDiff changes) {
        public TimelineDiff {
            timelineId = requiredOpaqueId(timelineId, "timelineId");
            fromSemanticVersionId = requiredOpaqueVersionId(fromSemanticVersionId, "fromSemanticVersionId");
            toSemanticVersionId = requiredOpaqueVersionId(toSemanticVersionId, "toSemanticVersionId");
            Objects.requireNonNull(changes, "changes");
        }
    }

    /** Project-scoped revision delta with timeline membership and per-shared-timeline changes. */
    public record RevisionDiff(String fromRevisionId, String toRevisionId, List<String> addedTimelineIds,
                               List<String> removedTimelineIds, Map<String, TimelineDiff> timelineChanges) {
        public RevisionDiff {
            fromRevisionId = requiredOpaqueId(fromRevisionId, "fromRevisionId");
            toRevisionId = requiredOpaqueId(toRevisionId, "toRevisionId");
            addedTimelineIds = List.copyOf(addedTimelineIds);
            removedTimelineIds = List.copyOf(removedTimelineIds);
            timelineChanges = java.util.Collections.unmodifiableMap(new java.util.TreeMap<>(timelineChanges));
        }
    }

    private static <T> ChangeSet changes(List<T> before, List<T> after, java.util.function.Function<T, String> id) {
        Map<String, T> left = byId(before, id), right = byId(after, id);
        List<String> added = right.keySet().stream().filter(k -> !left.containsKey(k)).sorted().toList();
        List<String> removed = left.keySet().stream().filter(k -> !right.containsKey(k)).sorted().toList();
        List<String> changed = left.keySet().stream().filter(right::containsKey)
                .filter(k -> !left.get(k).equals(right.get(k))).sorted().toList();
        return new ChangeSet(added, removed, changed);
    }

    private static <T> Map<String, T> byId(List<T> values, java.util.function.Function<T, String> id) {
        Map<String, T> result = new HashMap<>(); values.forEach(v -> result.put(id.apply(v), v)); return result;
    }
    private record ChangeSet(List<String> added, List<String> removed, List<String> changed) { }

    private static Map<String, TimelineSnapshot> byTimeline(List<TimelineSnapshot> values) {
        Map<String, TimelineSnapshot> result = new HashMap<>();
        values.forEach(value -> result.put(value.timelineId(), value));
        return result;
    }

    private static int indexOfTimeline(List<TimelineSnapshot> values, String timelineId) {
        for (int i = 0; i < values.size(); i++) if (values.get(i).timelineId().equals(timelineId)) return i;
        throw new IllegalArgumentException("timeline does not exist in the current project revision");
    }

    private static Graph graph(Graph g, List<Scene> scenes, List<Track> tracks, List<Clip> clips) {
        return new Graph(g.timelineId(), scenes, tracks, clips);
    }

    private static void requireExpectedHead(String expectedHeadRevisionId) {
        try {
            requiredOpaqueId(expectedHeadRevisionId, "expectedHeadRevisionId");
        } catch (IllegalArgumentException invalid) {
            throw new IllegalArgumentException("expectedHeadRevisionId must be a valid opaque revision id", invalid);
        }
    }

    private String nextId() {
        String value = ids.get();
        try {
            return requiredOpaqueId(value, "generatedId");
        } catch (IllegalArgumentException invalidId) {
            throw new IllegalStateException("id supplier returned an invalid opaque id", invalidId);
        }
    }

    private String nextVersionId() {
        String value = ids.get();
        try {
            return requiredOpaqueVersionId(value, "generatedSemanticVersionId");
        } catch (IllegalArgumentException invalidId) {
            throw new IllegalStateException("id supplier returned an invalid opaque semantic version id", invalidId);
        }
    }
}
