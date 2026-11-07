package com.ghatana.media.runtime;

import java.math.BigInteger;
import java.util.List;
import java.util.Objects;

/** Typed identities and immutable values for a revisioned Media editorial timeline. */
public final class MediaProjectTimelineContracts {
    private MediaProjectTimelineContracts() { }

    public enum Clock { SOURCE_PRESENTATION, STORY }
    public enum TrackKind { VIDEO, AUDIO, CAPTION, OVERLAY }
    public enum SourceEligibility { ELIGIBLE, REVOKED, UNKNOWN }

    /** Exact non-negative time point. Rates are ticks per second and are normalized. */
    public record RationalTime(long ticks, long rateNumerator, long rateDenominator, Clock clock)
            implements Comparable<RationalTime> {
        public RationalTime {
            if (ticks < 0 || rateNumerator < 1 || rateDenominator < 1) {
                throw new IllegalArgumentException("time and rate must be non-negative and positive respectively");
            }
            Objects.requireNonNull(clock, "clock");
            long gcd = gcd(rateNumerator, rateDenominator);
            rateNumerator /= gcd;
            rateDenominator /= gcd;
        }

        @Override
        public int compareTo(RationalTime other) {
            Objects.requireNonNull(other, "other");
            if (clock != other.clock) throw new IllegalArgumentException("cannot compare different timeline clocks");
            BigInteger left = BigInteger.valueOf(ticks).multiply(BigInteger.valueOf(rateDenominator))
                    .multiply(BigInteger.valueOf(other.rateNumerator));
            BigInteger right = BigInteger.valueOf(other.ticks).multiply(BigInteger.valueOf(other.rateDenominator))
                    .multiply(BigInteger.valueOf(rateNumerator));
            return left.compareTo(right);
        }

        /** Adds exact elapsed time in the same clock domain; unrepresentable results fail instead of rounding. */
        public RationalTime plus(RationalTime duration) {
            Objects.requireNonNull(duration, "duration");
            if (clock != duration.clock) throw new IllegalArgumentException("cannot add different timeline clocks");
            BigInteger left = BigInteger.valueOf(ticks).multiply(BigInteger.valueOf(rateDenominator))
                    .multiply(BigInteger.valueOf(duration.rateNumerator));
            BigInteger right = BigInteger.valueOf(duration.ticks).multiply(BigInteger.valueOf(duration.rateDenominator))
                    .multiply(BigInteger.valueOf(rateNumerator));
            BigInteger numerator = left.add(right);
            BigInteger denominator = BigInteger.valueOf(rateNumerator).multiply(BigInteger.valueOf(duration.rateNumerator));
            BigInteger gcd = numerator.gcd(denominator);
            return new RationalTime(numerator.divide(gcd).longValueExact(), denominator.divide(gcd).longValueExact(),
                    1, clock);
        }

        private static long gcd(long left, long right) {
            while (right != 0) {
                long remainder = left % right;
                left = right;
                right = remainder;
            }
            return left;
        }
    }

    /** An exact immutable artifact version; a digest is never used as version identity. */
    public record SourceVersion(String artifactId, String artifactVersionId) {
        public SourceVersion {
            artifactId = requiredOpaqueId(artifactId, "artifactId");
            artifactVersionId = requiredOpaqueVersionId(artifactVersionId, "artifactVersionId");
        }
    }

    public record Scene(String sceneId, int order) {
        public Scene {
            sceneId = requiredOpaqueId(sceneId, "sceneId");
            if (order < 0) throw new IllegalArgumentException("scene order must be non-negative");
        }
    }

    public record Track(String trackId, String sceneId, TrackKind kind, int order) {
        public Track {
            trackId = requiredOpaqueId(trackId, "trackId");
            sceneId = requiredOpaqueId(sceneId, "sceneId");
            Objects.requireNonNull(kind, "kind");
            if (order < 0) throw new IllegalArgumentException("track order must be non-negative");
        }
    }

    public record Clip(
            String clipId,
            String sceneId,
            String trackId,
            SourceVersion source,
            RationalTime sourceIn,
            RationalTime sourceOut,
            RationalTime storyStart,
            RationalTime storyDuration) {
        public Clip {
            clipId = requiredOpaqueId(clipId, "clipId");
            sceneId = requiredOpaqueId(sceneId, "sceneId");
            trackId = requiredOpaqueId(trackId, "trackId");
            Objects.requireNonNull(source, "source");
            Objects.requireNonNull(sourceIn, "sourceIn");
            Objects.requireNonNull(sourceOut, "sourceOut");
            Objects.requireNonNull(storyStart, "storyStart");
            Objects.requireNonNull(storyDuration, "storyDuration");
            if (sourceIn.clock() != Clock.SOURCE_PRESENTATION || sourceOut.clock() != Clock.SOURCE_PRESENTATION
                    || storyStart.clock() != Clock.STORY || storyDuration.clock() != Clock.STORY) {
                throw new IllegalArgumentException("clip source and story times must use their declared clock domains");
            }
            if (sourceIn.compareTo(sourceOut) >= 0 || storyDuration.ticks() == 0) {
                throw new IllegalArgumentException("clip source interval and story duration must be positive");
            }
            try {
                storyStart.plus(storyDuration);
            } catch (ArithmeticException unrepresentableEnd) {
                throw new IllegalArgumentException("clip story interval end is not representable", unrepresentableEnd);
            }
        }

        public RationalTime storyEnd() { return storyStart.plus(storyDuration); }
    }

    /** Complete immutable graph snapshot. A caller cannot smuggle detached nodes into a revision. */
    public record Graph(String timelineId, List<Scene> scenes, List<Track> tracks, List<Clip> clips) {
        public Graph {
            timelineId = requiredOpaqueId(timelineId, "timelineId");
            scenes = List.copyOf(scenes == null ? List.of() : scenes);
            tracks = List.copyOf(tracks == null ? List.of() : tracks);
            clips = List.copyOf(clips == null ? List.of() : clips);
            unique(scenes.stream().map(Scene::sceneId).toList(), "sceneId");
            unique(tracks.stream().map(Track::trackId).toList(), "trackId");
            unique(clips.stream().map(Clip::clipId).toList(), "clipId");
            unique(scenes.stream().map(Scene::order).toList(), "scene order");
            unique(tracks.stream().map(t -> new TrackOrder(t.sceneId(), t.order())).toList(), "track order within scene");
            java.util.Set<String> sceneIds = scenes.stream().map(Scene::sceneId).collect(java.util.stream.Collectors.toSet());
            java.util.Set<String> trackIds = tracks.stream().map(Track::trackId).collect(java.util.stream.Collectors.toSet());
            java.util.Map<String, Track> trackById = tracks.stream().collect(java.util.stream.Collectors.toMap(Track::trackId, t -> t));
            for (Track track : tracks) {
                if (!sceneIds.contains(track.sceneId())) throw new IllegalArgumentException("track references a missing scene");
            }
            for (Clip clip : clips) {
                Track track = trackById.get(clip.trackId());
                if (track == null || !sceneIds.contains(clip.sceneId()) || !track.sceneId().equals(clip.sceneId())) {
                    throw new IllegalArgumentException("clip scene and track must belong to the same graph scene");
                }
            }
            java.util.Map<String, Integer> sceneOrder = scenes.stream()
                    .collect(java.util.stream.Collectors.toMap(Scene::sceneId, Scene::order));
            java.util.Map<String, Integer> trackOrder = tracks.stream()
                    .collect(java.util.stream.Collectors.toMap(Track::trackId, Track::order));
            scenes = scenes.stream().sorted(java.util.Comparator.comparingInt(Scene::order)
                    .thenComparing(Scene::sceneId)).toList();
            tracks = tracks.stream().sorted(java.util.Comparator.comparingInt((Track track) -> sceneOrder.get(track.sceneId()))
                    .thenComparingInt(Track::order).thenComparing(Track::trackId)).toList();
            clips = clips.stream().sorted(java.util.Comparator.comparingInt((Clip clip) -> sceneOrder.get(clip.sceneId()))
                    .thenComparingInt(clip -> trackOrder.get(clip.trackId()))
                    .thenComparing(Clip::storyStart).thenComparing(Clip::clipId)).toList();
        }

        public static Graph empty(String timelineId) { return new Graph(timelineId, List.of(), List.of(), List.of()); }

        private static void unique(List<?> values, String label) {
            if (values.stream().distinct().count() != values.size()) throw new IllegalArgumentException("duplicate " + label);
        }
    }

    public record Actor(String tenantId, String principalId) {
        public Actor {
            tenantId = requiredOpaqueId(tenantId, "tenantId");
            principalId = requiredOpaqueId(principalId, "principalId");
        }
    }

    public record Project(String tenantId, String projectId, String workspaceId, String ownerPrincipalId,
                          String title, String headRevisionId) {
        public Project {
            tenantId = requiredOpaqueId(tenantId, "tenantId");
            projectId = requiredOpaqueId(projectId, "projectId");
            workspaceId = requiredOpaqueId(workspaceId, "workspaceId");
            ownerPrincipalId = requiredOpaqueId(ownerPrincipalId, "ownerPrincipalId");
            title = requiredProjectTitle(title);
            headRevisionId = requiredOpaqueId(headRevisionId, "headRevisionId");
        }
    }

    public record Revision(String tenantId, String projectId, String revisionId, String parentRevisionId,
                           Graph graph) {
        public Revision {
            tenantId = requiredOpaqueId(tenantId, "tenantId");
            projectId = requiredOpaqueId(projectId, "projectId");
            revisionId = requiredOpaqueId(revisionId, "revisionId");
            parentRevisionId = parentRevisionId == null ? null : requiredOpaqueId(parentRevisionId, "parentRevisionId");
            Objects.requireNonNull(graph, "graph");
        }
    }

    public record Created(Project project, Revision initialRevision, boolean createdNow) { }

    /** The only mutation boundary for a project timeline. Implementations must atomically compare the head. */
    public interface ProjectTimelineStore {
        Created create(Actor actor, String workspaceId, String title, String requestId,
                       String projectId, String initialRevisionId, String timelineId);
        Project project(Actor actor, String projectId);
        Revision revision(Actor actor, String projectId, String revisionId);
        Revision commit(Actor actor, String projectId, String expectedHeadRevisionId,
                       String newRevisionId, Graph graph);
    }

    /** Host-owned live authority read. UNKNOWN or an unavailable port blocks a rights-dependent effect. */
    @FunctionalInterface
    public interface SourceEligibilityPort {
        SourceEligibility current(Actor actor, SourceVersion exactSourceVersion);
    }

    public static class ProjectNotFoundException extends IllegalArgumentException {
        public ProjectNotFoundException() { super("project is not available in this tenant scope"); }
    }

    public static class ProjectAccessDeniedException extends SecurityException {
        public ProjectAccessDeniedException() { super("principal is not authorized to edit this project"); }
    }

    public static class IdempotencyConflictException extends IllegalStateException {
        public IdempotencyConflictException() { super("project creation requestId was already used with a different payload"); }
    }

    public static class RevisionConflictException extends IllegalStateException {
        private final String expectedRevisionId;
        private final String currentHeadRevisionId;
        public RevisionConflictException(String expectedRevisionId, String currentHeadRevisionId) {
            super("project revision conflict: expected " + expectedRevisionId + " but current head is " + currentHeadRevisionId);
            this.expectedRevisionId = required(expectedRevisionId, "expectedRevisionId");
            this.currentHeadRevisionId = required(currentHeadRevisionId, "currentHeadRevisionId");
        }
        public String expectedRevisionId() { return expectedRevisionId; }
        public String currentHeadRevisionId() { return currentHeadRevisionId; }
    }

    public static class SourceEligibilityException extends SecurityException {
        private final SourceEligibility observed;

        public SourceEligibilityException() { this(SourceEligibility.UNKNOWN); }

        public SourceEligibilityException(SourceEligibility observed) {
            super("one or more exact source versions are not currently eligible: " + observed);
            this.observed = Objects.requireNonNull(observed, "observed");
            if (observed == SourceEligibility.ELIGIBLE) {
                throw new IllegalArgumentException("eligible source status cannot represent an admission failure");
            }
        }

        public SourceEligibility observed() { return observed; }
    }

    public static String required(String value, String name) {
        Objects.requireNonNull(value, name);
        if (value.isBlank()) throw new IllegalArgumentException(name + " must not be blank");
        if (!value.equals(value.strip())) {
            throw new IllegalArgumentException(name + " must not have surrounding whitespace");
        }
        return value;
    }

    /** Validates PDP-1's opaque-id scalar before a development adapter accepts an identity. */
    public static String requiredOpaqueId(String value, String name) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
            throw new IllegalArgumentException(name + " must be a 1-128 character opaque id");
        }
        return value;
    }

    /** Validates PDP-1's opaque-version-id scalar; version identity is distinct from a digest. */
    public static String requiredOpaqueVersionId(String value, String name) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}")) {
            throw new IllegalArgumentException(name + " must be a 1-128 character opaque version id");
        }
        return value;
    }

    /** Validates the source-defined Unicode display title without normalizing submitted text. */
    public static String requiredProjectTitle(String title) {
        Objects.requireNonNull(title, "title");
        if (title.isBlank()) throw new IllegalArgumentException("title must not be blank");
        if (title.codePointCount(0, title.length()) > 200) {
            throw new IllegalArgumentException("title exceeds the 200 character project limit");
        }
        return title;
    }

    /** Validates J-01's selected workspace identifier against the owner wire schema. */
    public static String requireSelectedWorkspaceId(String workspaceId) {
        if (workspaceId == null || !workspaceId.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
            throw new IllegalArgumentException("workspaceId must be a 1-128 character opaque id");
        }
        return workspaceId;
    }

    /** Validates the J-01 owner wire-schema replay identity before any store side effect. */
    public static String requireCreateProjectRequestId(String requestId) {
        if (requestId == null || !requestId.matches("[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}")) {
            throw new IllegalArgumentException("requestId must be a 1-128 character ASCII opaque key");
        }
        return requestId;
    }

    private record TrackOrder(String sceneId, int order) { }
}
