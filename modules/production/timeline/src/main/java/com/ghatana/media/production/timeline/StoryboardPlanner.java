package com.ghatana.media.production.timeline;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.*;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/**
 * Builds deterministic, reviewable scene/shot plan candidates from authored input.
 *
 * <p>PDP-0 defines storyboard assembly as a local draft/candidate, not a project commit or render.
 * PDP-1 and PXD-235 bind each edition to one exact ProjectRevision, one ordered SceneGraph version
 * per PlannedScene, and one Timeline snapshot contained in that revision. These records are a
 * bounded authored projection; the plan authority port remains the sole append/CAS owner.</p>
 */
public final class StoryboardPlanner {
    /** Matches the owner-defined save-storyboard-revision sceneRefs maximum. */
    static final int MAX_SCENES = 256;
    /** Local safety ceilings; PDP-1 does not currently define a shot-count maximum. */
    static final int MAX_SHOTS_PER_SCENE = 1_024;
    static final int MAX_TOTAL_SHOTS = 10_000;
    /** Local safety ceiling; PDP source contracts do not define a per-list reference maximum. */
    static final int MAX_SOURCES_PER_COLLECTION = 4_096;
    /** Local aggregate safety ceiling; PDP source contracts do not define a plan-wide source maximum. */
    static final int MAX_TOTAL_SOURCE_REFERENCES = 16_384;

    private static final Comparator<SourceVersion> SOURCES = Comparator.comparing(SourceVersion::artifactId)
            .thenComparing(SourceVersion::artifactVersionId);

    private final CurrentSourceRights rights;
    private final ProjectTimelineEngine projectTimelineEngine;

    public StoryboardPlanner(CurrentSourceRights rights) {
        this(rights, null);
    }

    /** Creates a planner whose binding reads immutable revisions through the owner-scoped store. */
    public StoryboardPlanner(CurrentSourceRights rights, ProjectTimelineEngine projectTimelineEngine) {
        this.rights = Objects.requireNonNull(rights, "rights");
        this.projectTimelineEngine = projectTimelineEngine;
    }

    /** Pure deterministic candidate preparation. No model, renderer, project write, or source-byte read occurs. */
    public ScenePlan prepare(Actor actor, String projectId, String expectedProjectRevisionId,
                             String scenePlanId, String semanticVersion, AuthoredBrief brief,
                             List<AuthoredScene> authoredScenes) {
        Objects.requireNonNull(actor, "actor");
        String project = ownerOpaqueId(projectId, "projectId");
        String expectedRevision = ownerOpaqueId(expectedProjectRevisionId, "expectedProjectRevisionId");
        String planId = ownerOpaqueId(scenePlanId, "scenePlanId");
        String version = ownerSemanticVersion(semanticVersion, "semanticVersion");
        Objects.requireNonNull(brief, "brief");
        List<AuthoredScene> scenes = copyBoundedScenes(authoredScenes);
        if (scenes.isEmpty()) throw new IllegalArgumentException("storyboard requires at least one authored scene");
        int totalShots = 0;
        for (AuthoredScene scene : scenes) {
            totalShots += scene.shots().size();
            if (totalShots > MAX_TOTAL_SHOTS) {
                throw new IllegalArgumentException("storyboard exceeds the 10000 total-shot safety limit");
            }
        }
        validateBrief(brief);
        validateUniqueScenes(scenes);
        validateUniqueShots(scenes);

        List<PlannedScene> ordered = scenes.stream().map(StoryboardPlanner::planScene)
                .sorted(Comparator.comparingInt(PlannedScene::authoredOrder)
                        .thenComparing(PlannedScene::sceneId)).toList();
        List<SourceVersion> allSources = collectSources(brief, ordered);
        verifyCurrent(actor, brief.purpose(), allSources);
        return new ScenePlan(actor.tenantId(), actor.principalId(), project, planId, version, expectedRevision, brief, ordered,
                allSources, DraftDisposition.LOCAL_DRAFT_CANDIDATE);
    }

    /**
     * Bind an authored local draft to exact owner-defined plan, scene-graph, and timeline references.
     * The revision is loaded through the injected owner-scoped timeline engine: the selected timeline
     * must be one of its immutable snapshots, and its semantic version must match the wire reference.
     */
    public ScenePlan bind(Actor actor, ScenePlan plan, String expectedProjectRevisionId,
                          ScenePlanRef scenePlanRef, List<SceneGraphRef> sceneRefs, TimelineRef timelineRef) {
        Objects.requireNonNull(actor, "actor");
        Objects.requireNonNull(plan, "plan");
        String revisionId = ownerOpaqueId(expectedProjectRevisionId, "expectedProjectRevisionId");
        Objects.requireNonNull(scenePlanRef, "scenePlanRef");
        Objects.requireNonNull(timelineRef, "timelineRef");
        if (plan.binding() != null) {
            throw new ScenePlanAuthorityProtocolException("an immutable storyboard edition cannot be rebound");
        }
        if (!plan.tenantId().equals(actor.tenantId())) throw new ProjectNotFoundException();
        if (!plan.ownerPrincipalId().equals(actor.principalId())) throw new ProjectAccessDeniedException();
        if (!revisionId.equals(plan.expectedProjectRevisionId())) {
            throw new ScenePlanConflictException("expected ProjectRevision does not match the prepared plan scope");
        }
        ScenePlanRef expectedPlanRef = new ScenePlanRef(plan.tenantId(), plan.projectId(), plan.scenePlanId(),
                plan.semanticVersion());
        if (!expectedPlanRef.equals(scenePlanRef)) {
            throw new IllegalArgumentException("scenePlanRef must identify the exact prepared plan edition");
        }
        List<SceneGraphRef> exactSceneRefs = copyBoundedSceneRefs(sceneRefs);
        if (exactSceneRefs.size() != plan.scenes().size()) {
            throw new IllegalArgumentException("sceneRefs must contain exactly one reference per ordered planned scene");
        }
        if (exactSceneRefs.stream().distinct().count() != exactSceneRefs.size()) {
            throw new IllegalArgumentException("sceneRefs must be unique");
        }
        for (SceneGraphRef sceneRef : exactSceneRefs) {
            if (!sceneRef.tenantId().equals(plan.tenantId()) || !sceneRef.projectId().equals(plan.projectId())) {
                throw new IllegalArgumentException("sceneRefs must belong to the plan tenant and project");
            }
        }
        if (!timelineRef.tenantId().equals(plan.tenantId()) || !timelineRef.projectId().equals(plan.projectId())) {
            throw new IllegalArgumentException("timelineRef must belong to the plan tenant and project");
        }
        if (projectTimelineEngine == null) {
            throw new ScenePlanAuthorityProtocolException(
                    "owner ProjectTimelineEngine is required to bind a storyboard revision");
        }
        Revision expectedRevision = projectTimelineEngine.revision(actor, plan.projectId(), revisionId);
        TimelineSnapshot member = expectedRevision.timelines().stream()
                .filter(snapshot -> snapshot.timelineId().equals(timelineRef.timelineId()))
                .findFirst()
                .orElseThrow(() -> new ScenePlanConflictException(
                        "timelineRef is not contained in the expected ProjectRevision"));
        if (!member.semanticVersionId().equals(timelineRef.semanticVersion())) {
            throw new ScenePlanConflictException(
                    "timelineRef semanticVersion does not match the snapshot in the expected ProjectRevision");
        }
        StoryboardBinding binding = new StoryboardBinding(scenePlanRef, exactSceneRefs, timelineRef,
                expectedRevision.revisionId(), member.semanticVersionId(), plan);
        return new ScenePlan(plan.tenantId(), plan.ownerPrincipalId(), plan.projectId(), plan.scenePlanId(),
                plan.semanticVersion(), plan.expectedProjectRevisionId(), plan.brief(), plan.scenes(),
                plan.exactSources(), plan.disposition(), binding);
    }

    /**
     * Appends an immutable plan edition through the canonical owner port. The port must atomically
     * compare the current project head and plan parent version before making the append durable.
     * Rights are rechecked immediately before the append attempt.
     */
    public SavedPlan save(Actor actor, ScenePlan plan, String expectedParentSemanticVersion,
                          String requestId, ScenePlanAuthority authority) {
        Objects.requireNonNull(actor, "actor");
        Objects.requireNonNull(plan, "plan");
        Objects.requireNonNull(authority, "authority");
        if (!plan.tenantId().equals(actor.tenantId())) throw new ProjectNotFoundException();
        if (!plan.ownerPrincipalId().equals(actor.principalId())) throw new ProjectAccessDeniedException();
        if (plan.binding() == null) {
            throw new ScenePlanAuthorityProtocolException(
                    "storyboard draft must be bound to exact scene and timeline references before append");
        }
        String request = ownerActionRequestId(requestId);
        String parentVersion = optionalVersion(expectedParentSemanticVersion);
        verifyCurrent(actor, plan.brief().purpose(), plan.exactSources());
        SavedPlan saved = Objects.requireNonNull(authority.append(actor, plan, plan.expectedProjectRevisionId(),
                parentVersion, request),
                "scene plan authority returned no append receipt");
        if (!saved.plan().equals(plan) || saved.state() != EditionState.PERSISTED_DRAFT) {
            throw new ScenePlanAuthorityProtocolException("append receipt does not identify the exact draft edition");
        }
        return saved;
    }

    /** Records a review as a separate immutable receipt over the exact persisted draft version. */
    public ReviewedPlan review(Actor reviewer, SavedPlan saved, String expectedProjectRevisionId,
                               String requestId, ScenePlanReviewAuthority authority) {
        Objects.requireNonNull(reviewer, "reviewer");
        Objects.requireNonNull(saved, "saved");
        Objects.requireNonNull(authority, "authority");
        ScenePlan plan = saved.plan();
        if (!plan.tenantId().equals(reviewer.tenantId())) throw new ProjectNotFoundException();
        if (saved.state() != EditionState.PERSISTED_DRAFT) {
            throw new ScenePlanAuthorityProtocolException("only a persisted draft can be reviewed");
        }
        if (!plan.expectedProjectRevisionId().equals(ownerOpaqueId(expectedProjectRevisionId,
                "expectedProjectRevisionId"))) {
            throw new ScenePlanConflictException("project revision does not match the saved draft");
        }
        if (plan.binding() == null) {
            throw new ScenePlanAuthorityProtocolException(
                    "storyboard draft must be bound to exact scene and timeline references before review");
        }
        // Reviews are append records under the same owner-defined save-storyboard-revision
        // action, so they must preserve its request identity shape as well.
        String request = ownerActionRequestId(requestId);
        verifyCurrent(reviewer, plan.brief().purpose(), plan.exactSources());
        ReviewedPlan reviewed = Objects.requireNonNull(authority.appendReview(
                reviewer, saved, expectedProjectRevisionId, request),
                "scene plan review authority returned no review receipt");
        if (!reviewed.savedPlan().equals(saved) || !reviewed.reviewer().equals(reviewer)
                || !reviewed.projectRevisionId().equals(expectedProjectRevisionId)
                || reviewed.state() != EditionState.REVIEWED) {
            throw new ScenePlanAuthorityProtocolException("review receipt does not identify the exact edition");
        }
        return reviewed;
    }

    public enum DraftDisposition { LOCAL_DRAFT_CANDIDATE }

    /** These states describe only local draft preparation and authority receipts; review is not approval. */
    public enum EditionState { LOCAL_DRAFT, PERSISTED_DRAFT, REVIEWED }

    /** Rights are an authoritative fresh observation, not a property of authored brief text. */
    public enum SourceDecision { ELIGIBLE, MISSING, STALE, REVOKED, DENIED, UNKNOWN }

    @FunctionalInterface
    public interface CurrentSourceRights {
        SourceDecision inspect(Actor actor, SourceVersion exactSource, String purpose);
    }

    /** The durable plan authority owns both current project-head and plan-version CAS checks. */
    @FunctionalInterface
    public interface ScenePlanAuthority {
        SavedPlan append(Actor actor, ScenePlan plan, String expectedProjectHeadRevisionId,
                         String expectedParentSemanticVersion, String requestId);
    }

    /**
     * Host-owned append-only review receipt authority. Implementations must verify the saved owner receipt,
     * exact project head, reviewer authority, and expected revision atomically. No inferred review is accepted.
     */
    @FunctionalInterface
    public interface ScenePlanReviewAuthority {
        ReviewedPlan appendReview(Actor reviewer, SavedPlan exactEdition,
                                  String expectedProjectRevisionId, String requestId);
    }

    public record AuthoredBrief(String briefId, String semanticVersion, String purpose,
                                String narrative, List<SourceVersion> exactReferences) {
        public AuthoredBrief {
            // A brief is the owner-defined SceneBrief value. Enforce its identity scalars at
            // construction so callers cannot bypass the same boundary used for ScenePlan.
            briefId = ownerOpaqueId(briefId, "briefId");
            semanticVersion = ownerSemanticVersion(semanticVersion, "semanticVersion");
            purpose = required(purpose, "purpose");
            narrative = required(narrative, "narrative");
            exactReferences = canonicalSources(exactReferences);
        }
    }

    public record AuthoredScene(String sceneId, int order, String intent,
                                RationalTime storyStart, RationalTime storyDuration,
                                List<ShotInput> shots) {
        public AuthoredScene {
            sceneId = required(sceneId, "sceneId");
            if (order < 0) throw new IllegalArgumentException("scene order must be non-negative");
            intent = required(intent, "scene intent");
            validateStoryInterval(storyStart, storyDuration, "scene");
            shots = copyBoundedShots(shots);
            if (shots.isEmpty()) throw new IllegalArgumentException("each scene requires at least one authored shot");
            Set<String> ids = new HashSet<>();
            Set<Integer> orders = new HashSet<>();
            for (ShotInput shot : shots) {
                RationalTime sceneEnd = storyStart.plus(storyDuration);
                RationalTime shotEnd = shot.storyStart().plus(shot.storyDuration());
                if (shot.storyStart().compareTo(storyStart) < 0 || shotEnd.compareTo(sceneEnd) > 0) {
                    throw new IllegalArgumentException("shot story interval must be contained by its scene");
                }
                if (!ids.add(shot.shotId())) throw new IllegalArgumentException("duplicate shot identity: " + shot.shotId());
                if (!orders.add(shot.order())) throw new IllegalArgumentException("duplicate shot order within scene");
            }
        }
    }

    public record ShotInput(String shotId, int order, String intent, RationalTime storyStart,
                            RationalTime storyDuration, List<SourceVersion> exactSources) {
        public ShotInput {
            shotId = required(shotId, "shotId");
            if (order < 0) throw new IllegalArgumentException("shot order must be non-negative");
            intent = required(intent, "shot intent");
            validateStoryInterval(storyStart, storyDuration, "shot");
            exactSources = canonicalSources(exactSources);
        }
    }

    public record PlannedScene(String sceneId, int authoredOrder, String intent,
                               RationalTime storyStart, RationalTime storyDuration,
                               List<PlannedShot> shots) {
        public PlannedScene {
            sceneId = required(sceneId, "sceneId");
            if (authoredOrder < 0) throw new IllegalArgumentException("scene order must be non-negative");
            intent = required(intent, "scene intent");
            validateStoryInterval(storyStart, storyDuration, "scene");
            shots = copyBoundedPlannedShots(shots).stream().sorted(Comparator.comparingInt(PlannedShot::authoredOrder)
                    .thenComparing(PlannedShot::shotId)).toList();
            if (shots.isEmpty()) throw new IllegalArgumentException("each scene requires at least one planned shot");
            Set<String> ids = new HashSet<>();
            Set<Integer> orders = new HashSet<>();
            for (PlannedShot shot : shots) {
                if (!ids.add(shot.shotId())) throw new IllegalArgumentException("duplicate planned shot identity");
                if (!orders.add(shot.authoredOrder())) throw new IllegalArgumentException("duplicate planned shot order");
                RationalTime sceneEnd = storyStart.plus(storyDuration);
                RationalTime shotEnd = shot.storyStart().plus(shot.storyDuration());
                if (shot.storyStart().compareTo(storyStart) < 0 || shotEnd.compareTo(sceneEnd) > 0) {
                    throw new IllegalArgumentException("planned shot story interval must be contained by its scene");
                }
            }
        }
    }

    public record PlannedShot(String shotId, int authoredOrder, String intent, RationalTime storyStart,
                              RationalTime storyDuration, List<SourceVersion> exactSources) {
        public PlannedShot {
            shotId = required(shotId, "shotId");
            if (authoredOrder < 0) throw new IllegalArgumentException("shot order must be non-negative");
            intent = required(intent, "shot intent");
            validateStoryInterval(storyStart, storyDuration, "shot");
            exactSources = canonicalSources(exactSources);
        }
    }

    /** Canonical PDP-1 reference identities used by save-storyboard-revision. */
    public record ScenePlanRef(String tenantId, String projectId, String scenePlanId, String semanticVersion) {
        public ScenePlanRef {
            tenantId = required(tenantId, "scenePlanRef.tenantId");
            projectId = ownerOpaqueId(projectId, "scenePlanRef.projectId");
            scenePlanId = ownerOpaqueId(scenePlanId, "scenePlanRef.scenePlanId");
            semanticVersion = ownerSemanticVersion(semanticVersion, "scenePlanRef.semanticVersion");
        }
    }

    public record SceneGraphRef(String tenantId, String projectId, String sceneGraphId, String semanticVersion) {
        public SceneGraphRef {
            tenantId = required(tenantId, "sceneRef.tenantId");
            projectId = ownerOpaqueId(projectId, "sceneRef.projectId");
            sceneGraphId = ownerOpaqueId(sceneGraphId, "sceneRef.sceneGraphId");
            semanticVersion = ownerSemanticVersion(semanticVersion, "sceneRef.semanticVersion");
        }
    }

    public record TimelineRef(String tenantId, String projectId, String timelineId, String semanticVersion) {
        public TimelineRef {
            tenantId = required(tenantId, "timelineRef.tenantId");
            projectId = ownerOpaqueId(projectId, "timelineRef.projectId");
            timelineId = ownerOpaqueId(timelineId, "timelineRef.timelineId");
            semanticVersion = ownerSemanticVersion(semanticVersion, "timelineRef.semanticVersion");
        }
    }

    /** Immutable binding provenance captured from one expected project-revision snapshot. */
    public static final class StoryboardBinding {
        private final ScenePlanRef scenePlanRef;
        private final List<SceneGraphRef> sceneRefs;
        private final TimelineRef timelineRef;
        private final String expectedProjectRevisionId;
        private final String timelineSnapshotSemanticVersionId;
        private final ScenePlan planSnapshot;

        private StoryboardBinding(ScenePlanRef scenePlanRef, List<SceneGraphRef> sceneRefs,
                                  TimelineRef timelineRef, String expectedProjectRevisionId,
                                  String timelineSnapshotSemanticVersionId, ScenePlan plan) {
            this.scenePlanRef = Objects.requireNonNull(scenePlanRef, "scenePlanRef");
            this.sceneRefs = copyBoundedSceneRefs(sceneRefs);
            if (this.sceneRefs.isEmpty()) throw new IllegalArgumentException("sceneRefs must not be empty");
            if (this.sceneRefs.stream().distinct().count() != this.sceneRefs.size()) {
                throw new IllegalArgumentException("sceneRefs must be unique");
            }
            this.timelineRef = Objects.requireNonNull(timelineRef, "timelineRef");
            this.expectedProjectRevisionId = ownerOpaqueId(expectedProjectRevisionId, "expectedProjectRevisionId");
            this.timelineSnapshotSemanticVersionId = ownerSemanticVersion(timelineSnapshotSemanticVersionId,
                    "timelineSnapshotSemanticVersionId");
            if (!this.timelineRef.semanticVersion().equals(this.timelineSnapshotSemanticVersionId)) {
                throw new IllegalArgumentException("timelineRef must identify the exact timeline snapshot version");
            }
            this.planSnapshot = unboundSnapshot(Objects.requireNonNull(plan, "plan"));
        }

        public ScenePlanRef scenePlanRef() { return scenePlanRef; }
        public List<SceneGraphRef> sceneRefs() { return sceneRefs; }
        public TimelineRef timelineRef() { return timelineRef; }
        public String expectedProjectRevisionId() { return expectedProjectRevisionId; }
        public String timelineSnapshotSemanticVersionId() { return timelineSnapshotSemanticVersionId; }

        private boolean matches(String tenantId, String ownerPrincipalId, String projectId, String scenePlanId,
                                String semanticVersion, String expectedProjectRevisionId, AuthoredBrief brief,
                                List<PlannedScene> scenes, List<SourceVersion> exactSources,
                                DraftDisposition disposition) {
            return planSnapshot.equals(new ScenePlan(tenantId, ownerPrincipalId, projectId, scenePlanId,
                    semanticVersion, expectedProjectRevisionId, brief, scenes, exactSources, disposition, null));
        }

        @Override public boolean equals(Object other) {
            if (this == other) return true;
            if (!(other instanceof StoryboardBinding that)) return false;
            return scenePlanRef.equals(that.scenePlanRef) && sceneRefs.equals(that.sceneRefs)
                    && timelineRef.equals(that.timelineRef)
                    && expectedProjectRevisionId.equals(that.expectedProjectRevisionId)
                    && timelineSnapshotSemanticVersionId.equals(that.timelineSnapshotSemanticVersionId)
                    && planSnapshot.equals(that.planSnapshot);
        }

        @Override public int hashCode() {
            return Objects.hash(scenePlanRef, sceneRefs, timelineRef, expectedProjectRevisionId,
                    timelineSnapshotSemanticVersionId, planSnapshot);
        }

        private static ScenePlan unboundSnapshot(ScenePlan plan) {
            return new ScenePlan(plan.tenantId(), plan.ownerPrincipalId(), plan.projectId(), plan.scenePlanId(),
                    plan.semanticVersion(), plan.expectedProjectRevisionId(), plan.brief(), plan.scenes(),
                    plan.exactSources(), plan.disposition(), null);
        }
    }

    public record ScenePlan(String tenantId, String ownerPrincipalId, String projectId, String scenePlanId, String semanticVersion,
                            String expectedProjectRevisionId, AuthoredBrief brief, List<PlannedScene> scenes,
                            List<SourceVersion> exactSources, DraftDisposition disposition, StoryboardBinding binding) {
        public ScenePlan {
            tenantId = required(tenantId, "tenantId");
            ownerPrincipalId = required(ownerPrincipalId, "ownerPrincipalId");
            projectId = ownerOpaqueId(projectId, "projectId");
            scenePlanId = ownerOpaqueId(scenePlanId, "scenePlanId");
            semanticVersion = ownerSemanticVersion(semanticVersion, "semanticVersion");
            expectedProjectRevisionId = ownerOpaqueId(expectedProjectRevisionId, "expectedProjectRevisionId");
            Objects.requireNonNull(brief, "brief");
            scenes = copyBoundedPlannedScenes(scenes).stream().sorted(Comparator.comparingInt(PlannedScene::authoredOrder)
                    .thenComparing(PlannedScene::sceneId)).toList();
            if (scenes.isEmpty()) throw new IllegalArgumentException("storyboard plan requires at least one scene");
            Set<String> sceneIds = new HashSet<>();
            Set<Integer> sceneOrders = new HashSet<>();
            Set<String> shotIds = new HashSet<>();
            int totalShots = 0;
            for (PlannedScene scene : scenes) {
                totalShots += scene.shots().size();
                if (totalShots > MAX_TOTAL_SHOTS) {
                    throw new IllegalArgumentException("storyboard exceeds the 10000 total-shot safety limit");
                }
                if (!sceneIds.add(scene.sceneId())) throw new IllegalArgumentException("duplicate planned scene identity");
                if (!sceneOrders.add(scene.authoredOrder())) throw new IllegalArgumentException("duplicate planned scene order");
                for (PlannedShot shot : scene.shots()) {
                    if (!shotIds.add(shot.shotId())) throw new IllegalArgumentException("duplicate storyboard shot identity");
                }
            }
            List<SourceVersion> expectedSources = collectSources(brief, scenes);
            if (!expectedSources.equals(canonicalSources(exactSources, MAX_TOTAL_SOURCE_REFERENCES))) {
                throw new IllegalArgumentException("plan source set must preserve every exact brief and shot reference");
            }
            exactSources = expectedSources;
            Objects.requireNonNull(disposition, "disposition");
            if (disposition != DraftDisposition.LOCAL_DRAFT_CANDIDATE) {
                throw new IllegalArgumentException("storyboard planner only emits local draft candidates");
            }
            if (binding != null) {
                if (!binding.matches(tenantId, ownerPrincipalId, projectId, scenePlanId, semanticVersion,
                        expectedProjectRevisionId, brief, scenes, exactSources, disposition)) {
                    throw new IllegalArgumentException("binding must preserve the exact prepared storyboard payload");
                }
                ScenePlanRef expectedRef = new ScenePlanRef(tenantId, projectId, scenePlanId, semanticVersion);
                if (!binding.scenePlanRef().equals(expectedRef)) {
                    throw new IllegalArgumentException("binding scenePlanRef must identify this exact plan edition");
                }
                if (!binding.expectedProjectRevisionId().equals(expectedProjectRevisionId)) {
                    throw new IllegalArgumentException("binding must use the plan's expected ProjectRevision");
                }
                if (binding.sceneRefs().size() != scenes.size()) {
                    throw new IllegalArgumentException("sceneRefs must contain exactly one reference per ordered planned scene");
                }
                if (!binding.timelineRef().tenantId().equals(tenantId)
                        || !binding.timelineRef().projectId().equals(projectId)) {
                    throw new IllegalArgumentException("timelineRef must belong to the plan tenant and project");
                }
                for (SceneGraphRef sceneRef : binding.sceneRefs()) {
                    if (!sceneRef.tenantId().equals(tenantId) || !sceneRef.projectId().equals(projectId)) {
                        throw new IllegalArgumentException("sceneRefs must belong to the plan tenant and project");
                    }
                }
            }
        }

        /** Compatibility constructor for a local candidate that has not yet been bound for append. */
        public ScenePlan(String tenantId, String ownerPrincipalId, String projectId, String scenePlanId,
                         String semanticVersion, String expectedProjectRevisionId, AuthoredBrief brief,
                         List<PlannedScene> scenes, List<SourceVersion> exactSources, DraftDisposition disposition) {
            this(tenantId, ownerPrincipalId, projectId, scenePlanId, semanticVersion, expectedProjectRevisionId,
                    brief, scenes, exactSources, disposition, null);
        }

        public EditionState state() { return EditionState.LOCAL_DRAFT; }

    }

    public record SavedPlan(ScenePlan plan, String ownerReceipt, EditionState state) {
        public SavedPlan {
            Objects.requireNonNull(plan, "plan");
            ownerReceipt = required(ownerReceipt, "ownerReceipt");
            Objects.requireNonNull(state, "state");
            if (state != EditionState.PERSISTED_DRAFT) {
                throw new IllegalArgumentException("append receipt must describe a persisted draft");
            }
        }
        public SavedPlan(ScenePlan plan, String ownerReceipt) {
            this(plan, ownerReceipt, EditionState.PERSISTED_DRAFT);
        }
    }

    /** Review record references an immutable edition and owner receipt without changing that edition. */
    public record ReviewedPlan(SavedPlan savedPlan, Actor reviewer, String projectRevisionId,
                              String reviewReceipt, EditionState state) {
        public ReviewedPlan {
            Objects.requireNonNull(savedPlan, "savedPlan");
            Objects.requireNonNull(reviewer, "reviewer");
            projectRevisionId = ownerOpaqueId(projectRevisionId, "projectRevisionId");
            reviewReceipt = required(reviewReceipt, "reviewReceipt");
            Objects.requireNonNull(state, "state");
            if (state != EditionState.REVIEWED) {
                throw new IllegalArgumentException("review receipt must identify a reviewed edition");
            }
        }
    }

    public static class SourceReferenceMissingException extends IllegalArgumentException {
        public SourceReferenceMissingException() { super("an exact authored source version is missing"); }
    }
    public static class StaleSourceVersionException extends IllegalStateException {
        public StaleSourceVersionException() { super("an authored source version is stale; explicit rebase is required"); }
    }
    public static class SourceRightsDeniedException extends SecurityException {
        public SourceRightsDeniedException() { super("current source rights do not permit this storyboard purpose"); }
    }
    public static class SourceAuthorityUnavailableException extends IllegalStateException {
        public SourceAuthorityUnavailableException() { super("fresh source-rights authority is unavailable or unknown"); }
    }
    public static class DuplicateScenePlanVersionException extends IllegalStateException {
        public DuplicateScenePlanVersionException() { super("scene plan identity and semantic version already exist"); }
    }
    public static class ScenePlanConflictException extends IllegalStateException {
        public ScenePlanConflictException(String message) { super(message); }
    }
    public static class ScenePlanAuthorityProtocolException extends IllegalStateException {
        public ScenePlanAuthorityProtocolException(String message) { super(message); }
    }

    private void verifyCurrent(Actor actor, String purpose, List<SourceVersion> sources) {
        for (SourceVersion source : sources) {
            SourceDecision decision;
            try {
                decision = rights.inspect(actor, source, purpose);
            } catch (RuntimeException unavailable) {
                throw new SourceAuthorityUnavailableException();
            }
            if (decision == null || decision == SourceDecision.UNKNOWN) throw new SourceAuthorityUnavailableException();
            switch (decision) {
                case ELIGIBLE -> { }
                case MISSING -> throw new SourceReferenceMissingException();
                case STALE -> throw new StaleSourceVersionException();
                case REVOKED, DENIED -> throw new SourceRightsDeniedException();
                case UNKNOWN -> throw new SourceAuthorityUnavailableException();
            }
        }
    }

    private static void validateBrief(AuthoredBrief brief) {
        if (brief.narrative().isBlank() || brief.purpose().isBlank()) {
            throw new IllegalArgumentException("brief narrative and purpose are required");
        }
    }

    private static void validateUniqueScenes(List<AuthoredScene> scenes) {
        Set<String> ids = new HashSet<>();
        Set<Integer> orders = new HashSet<>();
        for (AuthoredScene scene : scenes) {
            Objects.requireNonNull(scene, "scene");
            if (!ids.add(scene.sceneId())) throw new IllegalArgumentException("duplicate scene identity: " + scene.sceneId());
            if (!orders.add(scene.order())) throw new IllegalArgumentException("duplicate scene order");
        }
    }

    private static void validateUniqueShots(List<AuthoredScene> scenes) {
        Set<String> ids = new HashSet<>();
        for (AuthoredScene scene : scenes) {
            for (ShotInput shot : scene.shots()) {
                if (!ids.add(shot.shotId())) throw new IllegalArgumentException("duplicate storyboard shot identity: " + shot.shotId());
            }
        }
    }

    private static PlannedScene planScene(AuthoredScene scene) {
        List<PlannedShot> shots = scene.shots().stream()
                .map(s -> new PlannedShot(s.shotId(), s.order(), s.intent(), s.storyStart(), s.storyDuration(), s.exactSources()))
                .sorted(Comparator.comparingInt(PlannedShot::authoredOrder)
                        .thenComparing(PlannedShot::shotId)).toList();
        return new PlannedScene(scene.sceneId(), scene.order(), scene.intent(), scene.storyStart(), scene.storyDuration(), shots);
    }

    private static List<SourceVersion> collectSources(AuthoredBrief brief, List<PlannedScene> scenes) {
        List<SourceVersion> references = new ArrayList<>();
        appendBoundedSources(references, brief.exactReferences());
        for (PlannedScene scene : scenes) {
            for (PlannedShot shot : scene.shots()) {
                appendBoundedSources(references, shot.exactSources());
            }
        }
        return canonicalSources(references, MAX_TOTAL_SOURCE_REFERENCES);
    }

    private static void appendBoundedSources(List<SourceVersion> aggregate, List<SourceVersion> references) {
        for (SourceVersion reference : references) {
            if (aggregate.size() == MAX_TOTAL_SOURCE_REFERENCES) {
                throw new IllegalArgumentException(
                        "storyboard exceeds the 16384 total source-reference safety limit");
            }
            aggregate.add(reference);
        }
    }

    private static List<SourceVersion> canonicalSources(List<SourceVersion> sources) {
        return canonicalSources(sources, MAX_SOURCES_PER_COLLECTION);
    }

    /** Canonicalize a plan-wide set using its separate aggregate safety ceiling. */
    private static List<SourceVersion> canonicalSources(List<SourceVersion> sources, int maximum) {
        if (sources == null) return List.of();
        Iterator<SourceVersion> iterator = sources.iterator();
        List<SourceVersion> snapshot = new ArrayList<>();
        while (iterator.hasNext()) {
            if (snapshot.size() == maximum) {
                throw new IllegalArgumentException("source references exceed the " + maximum + "-item safety limit");
            }
            snapshot.add(Objects.requireNonNull(iterator.next(), "source reference"));
        }
        return snapshot.stream().distinct().sorted(SOURCES).toList();
    }

    private static void validateStoryInterval(RationalTime start, RationalTime duration, String subject) {
        Objects.requireNonNull(start, subject + " storyStart");
        Objects.requireNonNull(duration, subject + " storyDuration");
        if (start.clock() != Clock.STORY || duration.clock() != Clock.STORY || duration.ticks() == 0) {
            throw new IllegalArgumentException(subject + " requires positive story-clock timing");
        }
        try {
            start.plus(duration); // exact overflow/range check; never round a long duration.
        } catch (ArithmeticException unrepresentableEnd) {
            throw new IllegalArgumentException(subject + " story interval end is not exactly representable",
                    unrepresentableEnd);
        }
    }

    private static String optionalVersion(String value) {
        if (value == null) return null;
        if (value.isBlank()) throw new IllegalArgumentException("expectedParentSemanticVersion must not be blank");
        return ownerSemanticVersion(value, "expectedParentSemanticVersion");
    }

    /**
     * The owner-defined save-storyboard-revision payload permits at most 256 scene references.
     * Consume one item at a time and stop at the first excess item, before copying an unbounded list.
     */
    private static List<AuthoredScene> copyBoundedScenes(List<AuthoredScene> authoredScenes) {
        if (authoredScenes == null) return List.of();
        Iterator<AuthoredScene> iterator = authoredScenes.iterator();
        List<AuthoredScene> snapshot = new ArrayList<>(MAX_SCENES);
        while (iterator.hasNext()) {
            if (snapshot.size() == MAX_SCENES) {
                throw new IllegalArgumentException("storyboard exceeds the 256 scene-reference limit");
            }
            snapshot.add(Objects.requireNonNull(iterator.next(), "scene"));
        }
        return List.copyOf(snapshot);
    }

    private static List<SceneGraphRef> copyBoundedSceneRefs(List<SceneGraphRef> sceneRefs) {
        if (sceneRefs == null) throw new NullPointerException("sceneRefs");
        Iterator<SceneGraphRef> iterator = sceneRefs.iterator();
        List<SceneGraphRef> snapshot = new ArrayList<>(MAX_SCENES);
        while (iterator.hasNext()) {
            if (snapshot.size() == MAX_SCENES) {
                throw new IllegalArgumentException("sceneRefs exceeds the 256 reference limit");
            }
            snapshot.add(Objects.requireNonNull(iterator.next(), "sceneRef"));
        }
        return List.copyOf(snapshot);
    }

    /** Local structural guard; the authored PDP does not yet declare a shot-per-scene maximum. */
    private static List<ShotInput> copyBoundedShots(List<ShotInput> shots) {
        if (shots == null) return List.of();
        int declaredSize = shots.size();
        if (declaredSize > MAX_SHOTS_PER_SCENE) {
            throw new IllegalArgumentException("scene exceeds the 1024 shot-per-scene safety limit");
        }
        List<ShotInput> snapshot = new ArrayList<>(Math.max(0, declaredSize));
        Iterator<ShotInput> iterator = shots.iterator();
        while (snapshot.size() < MAX_SHOTS_PER_SCENE && iterator.hasNext()) {
            snapshot.add(Objects.requireNonNull(iterator.next(), "shot"));
        }
        if (iterator.hasNext()) {
            throw new IllegalArgumentException("scene exceeds the 1024 shot-per-scene safety limit");
        }
        return List.copyOf(snapshot);
    }

    /** Public planned-scene construction cannot bypass the per-scene safety ceiling. */
    private static List<PlannedShot> copyBoundedPlannedShots(List<PlannedShot> shots) {
        Objects.requireNonNull(shots, "shots");
        int declaredSize = shots.size();
        if (declaredSize > MAX_SHOTS_PER_SCENE) {
            throw new IllegalArgumentException("planned scene exceeds the 1024 shot-per-scene safety limit");
        }
        List<PlannedShot> snapshot = new ArrayList<>(Math.max(0, declaredSize));
        Iterator<PlannedShot> iterator = shots.iterator();
        while (snapshot.size() < MAX_SHOTS_PER_SCENE && iterator.hasNext()) {
            snapshot.add(Objects.requireNonNull(iterator.next(), "planned shot"));
        }
        if (iterator.hasNext()) {
            throw new IllegalArgumentException("planned scene exceeds the 1024 shot-per-scene safety limit");
        }
        return List.copyOf(snapshot);
    }

    /** Snapshot the public plan boundary too; callers may construct ScenePlan without prepare(). */
    private static List<PlannedScene> copyBoundedPlannedScenes(List<PlannedScene> scenes) {
        Objects.requireNonNull(scenes, "scenes");
        int declaredSize = scenes.size();
        if (declaredSize > MAX_SCENES) {
            throw new IllegalArgumentException("storyboard exceeds the 256 scene-reference limit");
        }
        Iterator<PlannedScene> iterator = scenes.iterator();
        List<PlannedScene> snapshot = new ArrayList<>(Math.min(declaredSize, MAX_SCENES));
        int totalShots = 0;
        while (iterator.hasNext()) {
            if (snapshot.size() == MAX_SCENES) {
                throw new IllegalArgumentException("storyboard exceeds the 256 scene-reference limit");
            }
            PlannedScene scene = Objects.requireNonNull(iterator.next(), "scene");
            totalShots += scene.shots().size();
            if (totalShots > MAX_TOTAL_SHOTS) {
                throw new IllegalArgumentException("storyboard exceeds the 10000 total-shot safety limit");
            }
            snapshot.add(scene);
        }
        return List.copyOf(snapshot);
    }

    /** Exact request-ID shape from owner-action-wire-contracts.yaml#save-storyboard-revision. */
    private static String ownerActionRequestId(String value) {
        if (value == null || value.length() > 128
                || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
            throw new IllegalArgumentException("requestId must match the 1-128 character owner-action format");
        }
        return value;
    }

    /** PDP-1's ScenePlan identity tuple uses owner-defined opaque IDs for projectId and scenePlanId. */
    private static String ownerOpaqueId(String value, String name) {
        if (value == null || value.length() > 128 || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]*")) {
            throw new IllegalArgumentException(name + " must match the 1-128 character owner opaque-ID format");
        }
        return value;
    }

    /** PDP-1 semantic-version-or-owner-version-id scalar; validate before rights or append effects. */
    private static String ownerSemanticVersion(String value, String name) {
        if (value == null || value.length() > 128 || !value.matches("[A-Za-z0-9][A-Za-z0-9.+:-]*")) {
            throw new IllegalArgumentException(name + " must match the 1-128 character owner version format");
        }
        return value;
    }
}
