package com.ghatana.media.launcher;

import com.ghatana.media.production.timeline.ProjectTimelineEngine;
import com.ghatana.media.production.timeline.ProjectTimelineEngine.Edit;
import com.ghatana.media.runtime.ManagedProjectTimelineStore;
import com.ghatana.media.runtime.MediaDevProjectTimelineStoreFactory;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Created;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Project;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Revision;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.List;
import java.util.Map;
import java.util.ServiceLoader;
import java.util.HexFormat;
import java.util.concurrent.atomic.AtomicBoolean;

/** DEV_ONLY host composition for owner-scoped durable project and timeline revision operations. */
public final class MediaDevProjectTimelineRuntime implements AutoCloseable {
    public static final String ENABLED = "MEDIA_PROJECT_TIMELINE_DEV_ENABLED";
    private final ManagedProjectTimelineStore store;
    private final ProjectTimelineEngine engine;
    private final AtomicBoolean closed = new AtomicBoolean();

    MediaDevProjectTimelineRuntime(ManagedProjectTimelineStore store) {
        this.store = java.util.Objects.requireNonNull(store, "store");
        this.engine = new ProjectTimelineEngine(store);
    }

    /** Returns null when the explicit DEV_ONLY local timeline feature flag is absent. */
    public static MediaDevProjectTimelineRuntime compose(Map<String, String> environment) {
        boolean enabled = parseBoolean(environment.getOrDefault(ENABLED, "false"), ENABLED);
        if (!enabled) return null;
        String profile = environment.getOrDefault("MEDIA_RUNTIME_ENVIRONMENT",
                environment.getOrDefault("MEDIA_PROFILE", "")).trim().toLowerCase(java.util.Locale.ROOT);
        if (!"dev".equals(profile)
                || !parseBoolean(environment.getOrDefault("MEDIA_DEV_IDENTITY_ENABLED", "false"),
                        "MEDIA_DEV_IDENTITY_ENABLED")) {
            throw new IllegalArgumentException(
                    "DEV_ONLY project timeline runtime requires profile=dev and MEDIA_DEV_IDENTITY_ENABLED=true");
        }
        List<MediaDevProjectTimelineStoreFactory> factories = ServiceLoader
                .load(MediaDevProjectTimelineStoreFactory.class).stream()
                .map(ServiceLoader.Provider::get)
                .filter(factory -> "postgresql-dev-project-timeline".equals(factory.factoryId()))
                .toList();
        if (factories.size() != 1) {
            throw new IllegalStateException("exactly one PostgreSQL DEV_ONLY project timeline store factory is required");
        }
        return new MediaDevProjectTimelineRuntime(factories.get(0).createDevOnly(Map.copyOf(environment)));
    }

    public String workspaceId(String tenantId, String principalId) {
        ensureOpen();
        return developmentWorkspaceId(actor(tenantId, principalId));
    }

    public Created createProject(String tenantId, String principalId, String selectedWorkspaceId,
                                 String title, String requestId) {
        ensureOpen();
        Actor actor = actor(tenantId, principalId);
        String workspaceId = developmentWorkspaceId(actor);
        if (!workspaceId.equals(selectedWorkspaceId)) {
            throw new SecurityException("selected workspace is not the authenticated owner's DEV_ONLY workspace");
        }
        return engine.createProject(actor, workspaceId, title, requestId);
    }

    public Project project(String tenantId, String principalId, String projectId) {
        ensureOpen();
        return engine.project(actor(tenantId, principalId), projectId);
    }

    public Revision currentRevision(String tenantId, String principalId, String projectId) {
        ensureOpen();
        return engine.currentRevision(actor(tenantId, principalId), projectId);
    }

    public Revision revision(String tenantId, String principalId, String projectId, String revisionId) {
        ensureOpen();
        return engine.revision(actor(tenantId, principalId), projectId, revisionId);
    }

    public Revision createTimeline(String tenantId, String principalId, String projectId,
                                   String expectedHeadRevisionId, String timelineId) {
        ensureOpen();
        return engine.createTimeline(actor(tenantId, principalId), projectId, expectedHeadRevisionId, timelineId);
    }

    public Revision editTimeline(String tenantId, String principalId, String projectId, String timelineId,
                                 String expectedHeadRevisionId, List<Edit> edits) {
        ensureOpen();
        return engine.edit(actor(tenantId, principalId), projectId, timelineId, expectedHeadRevisionId, edits);
    }

    public Revision restoreRevision(String tenantId, String principalId, String projectId,
                                    String expectedHeadRevisionId, String targetRevisionId) {
        ensureOpen();
        return engine.restore(actor(tenantId, principalId), projectId, expectedHeadRevisionId, targetRevisionId);
    }

    public static String developmentWorkspaceId(String tenantId, String principalId) {
        return developmentWorkspaceId(actor(tenantId, principalId));
    }

    private static String developmentWorkspaceId(Actor actor) {
        try {
            byte[] identity = (actor.tenantId() + "\u0000" + actor.principalId()).getBytes(StandardCharsets.UTF_8);
            String scope = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(identity), 0, 16);
            return "dev-workspace." + scope;
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    private static Actor actor(String tenantId, String principalId) { return new Actor(tenantId, principalId); }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("DEV_ONLY project timeline runtime is closed");
    }

    @Override public void close() { if (closed.compareAndSet(false, true)) store.close(); }

    private static boolean parseBoolean(String value, String key) {
        if ("true".equalsIgnoreCase(value)) return true;
        if ("false".equalsIgnoreCase(value)) return false;
        throw new IllegalArgumentException(key + " must be true or false");
    }
}
