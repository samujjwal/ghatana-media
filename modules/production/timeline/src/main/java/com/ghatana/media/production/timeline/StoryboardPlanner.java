package com.ghatana.media.production.timeline;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.*;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/**
 * Builds deterministic, reviewable scene/shot plan candidates from authored input.
 *
 * <p>PDP-0 defines storyboard assembly as a local draft/candidate, not a project commit or render.
 * PDP-1 defines project-scoped ScenePlan/SceneBrief identities and immutable semantic versions,
 * but its exact graph field mapping remains unresolved. The records here are a bounded authored
 * projection; the plan authority port must be the sole append/CAS owner when persistence is used.</p>
 */
public final class StoryboardPlanner {
    private static final Comparator<SourceVersion> SOURCES = Comparator.comparing(SourceVersion::artifactId)
            .thenComparing(SourceVersion::artifactVersionId);

    private final CurrentSourceRights rights;

    public StoryboardPlanner(CurrentSourceRights rights) {
        this.rights = Objects.requireNonNull(rights, "rights");
    }

    /** Pure deterministic candidate preparation. No model, renderer, project write, or source-byte read occurs. */
    public ScenePlan prepare(Actor actor, String projectId, String expectedProjectRevisionId,
                             String scenePlanId, String semanticVersion, AuthoredBrief brief,
                             List<AuthoredScene> authoredScenes) {
        Objects.requireNonNull(actor, "actor");
        String project = required(projectId, "projectId");
        String expectedRevision = required(expectedProjectRevisionId, "expectedProjectRevisionId");
        String planId = required(scenePlanId, "scenePlanId");
        String version = required(semanticVersion, "semanticVersion");
        Objects.requireNonNull(brief, "brief");
        List<AuthoredScene> scenes = List.copyOf(authoredScenes == null ? List.of() : authoredScenes);
        if (scenes.isEmpty()) throw new IllegalArgumentException("storyboard requires at least one authored scene");
        validateBrief(brief);
        validateUniqueScenes(scenes);
        validateUniqueShots(scenes);

        List<PlannedScene> ordered = scenes.stream().map(StoryboardPlanner::planScene)
                .sorted(Comparator.comparing(PlannedScene::storyStart)
                        .thenComparingInt(PlannedScene::authoredOrder)
                        .thenComparing(PlannedScene::sceneId)).toList();
        List<SourceVersion> allSources = collectSources(brief, ordered);
        verifyCurrent(actor, brief.purpose(), allSources);
        return new ScenePlan(actor.tenantId(), actor.principalId(), project, planId, version, expectedRevision, brief, ordered,
                allSources, DraftDisposition.LOCAL_DRAFT_CANDIDATE);
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
        String request = required(requestId, "requestId");
        verifyCurrent(actor, plan.brief().purpose(), plan.exactSources());
        return authority.append(actor, plan, plan.expectedProjectRevisionId(),
                optionalVersion(expectedParentSemanticVersion), request);
    }

    public enum DraftDisposition { LOCAL_DRAFT_CANDIDATE }

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

    public record AuthoredBrief(String briefId, String semanticVersion, String purpose,
                                String narrative, List<SourceVersion> exactReferences) {
        public AuthoredBrief {
            briefId = required(briefId, "briefId");
            semanticVersion = required(semanticVersion, "brief semanticVersion");
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
            shots = List.copyOf(shots == null ? List.of() : shots);
            if (shots.isEmpty()) throw new IllegalArgumentException("each scene requires at least one authored shot");
            Set<String> ids = new HashSet<>();
            Set<Integer> orders = new HashSet<>();
            for (ShotInput shot : shots) {
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
            shots = List.copyOf(shots);
            if (shots.isEmpty()) throw new IllegalArgumentException("each scene requires at least one planned shot");
            Set<String> ids = new HashSet<>();
            Set<Integer> orders = new HashSet<>();
            for (PlannedShot shot : shots) {
                if (!ids.add(shot.shotId())) throw new IllegalArgumentException("duplicate planned shot identity");
                if (!orders.add(shot.authoredOrder())) throw new IllegalArgumentException("duplicate planned shot order");
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

    public record ScenePlan(String tenantId, String ownerPrincipalId, String projectId, String scenePlanId, String semanticVersion,
                            String expectedProjectRevisionId, AuthoredBrief brief, List<PlannedScene> scenes,
                            List<SourceVersion> exactSources, DraftDisposition disposition) {
        public ScenePlan {
            tenantId = required(tenantId, "tenantId");
            ownerPrincipalId = required(ownerPrincipalId, "ownerPrincipalId");
            projectId = required(projectId, "projectId");
            scenePlanId = required(scenePlanId, "scenePlanId");
            semanticVersion = required(semanticVersion, "semanticVersion");
            expectedProjectRevisionId = required(expectedProjectRevisionId, "expectedProjectRevisionId");
            Objects.requireNonNull(brief, "brief");
            scenes = List.copyOf(scenes).stream().sorted(Comparator.comparing(PlannedScene::storyStart)
                    .thenComparingInt(PlannedScene::authoredOrder).thenComparing(PlannedScene::sceneId)).toList();
            if (scenes.isEmpty()) throw new IllegalArgumentException("storyboard plan requires at least one scene");
            Set<String> sceneIds = new HashSet<>();
            Set<Integer> sceneOrders = new HashSet<>();
            Set<String> shotIds = new HashSet<>();
            for (PlannedScene scene : scenes) {
                if (!sceneIds.add(scene.sceneId())) throw new IllegalArgumentException("duplicate planned scene identity");
                if (!sceneOrders.add(scene.authoredOrder())) throw new IllegalArgumentException("duplicate planned scene order");
                for (PlannedShot shot : scene.shots()) {
                    if (!shotIds.add(shot.shotId())) throw new IllegalArgumentException("duplicate storyboard shot identity");
                }
            }
            List<SourceVersion> expectedSources = collectSources(brief, scenes);
            if (!expectedSources.equals(canonicalSources(exactSources))) {
                throw new IllegalArgumentException("plan source set must preserve every exact brief and shot reference");
            }
            exactSources = expectedSources;
            Objects.requireNonNull(disposition, "disposition");
            if (disposition != DraftDisposition.LOCAL_DRAFT_CANDIDATE) {
                throw new IllegalArgumentException("storyboard planner only emits local draft candidates");
            }
        }

    }

    public record SavedPlan(ScenePlan plan, String ownerReceipt) {
        public SavedPlan {
            Objects.requireNonNull(plan, "plan");
            ownerReceipt = required(ownerReceipt, "ownerReceipt");
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
                .sorted(Comparator.comparing(PlannedShot::storyStart)
                        .thenComparingInt(PlannedShot::authoredOrder)
                        .thenComparing(PlannedShot::shotId)).toList();
        return new PlannedScene(scene.sceneId(), scene.order(), scene.intent(), scene.storyStart(), scene.storyDuration(), shots);
    }

    private static List<SourceVersion> collectSources(AuthoredBrief brief, List<PlannedScene> scenes) {
        return canonicalSources(java.util.stream.Stream.concat(brief.exactReferences().stream(),
                scenes.stream().flatMap(s -> s.shots().stream()).flatMap(s -> s.exactSources().stream())).toList());
    }

    private static List<SourceVersion> canonicalSources(List<SourceVersion> sources) {
        if (sources == null) return List.of();
        return sources.stream().map(s -> Objects.requireNonNull(s, "source reference")).distinct()
                .sorted(SOURCES).toList();
    }

    private static void validateStoryInterval(RationalTime start, RationalTime duration, String subject) {
        Objects.requireNonNull(start, subject + " storyStart");
        Objects.requireNonNull(duration, subject + " storyDuration");
        if (start.clock() != Clock.STORY || duration.clock() != Clock.STORY || duration.ticks() == 0) {
            throw new IllegalArgumentException(subject + " requires positive story-clock timing");
        }
        start.plus(duration); // exact overflow/range check; never round a long duration.
    }

    private static String optionalVersion(String value) {
        return value == null || value.isBlank() ? null : required(value, "expectedParentSemanticVersion");
    }
}
