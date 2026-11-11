package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaCaptionContracts.CaptionVersionSnapshot;
import com.ghatana.media.runtime.MediaDeploymentProfiles;
import com.ghatana.media.runtime.MediaCaptionContracts.MediaCaptionStore;
import com.ghatana.media.runtime.MediaCaptionContracts.Registered;
import com.ghatana.media.runtime.MediaCaptionContracts.RegistrationRequest;
import com.ghatana.media.runtime.MediaCaptionContracts.RegistrationResult;
import com.ghatana.media.runtime.MediaCaptionContracts.RegistrationAuthority;
import com.ghatana.media.runtime.MediaCapabilityNotAdmittedException;
import com.ghatana.media.runtime.MediaSourceRightsAdministration;
import com.ghatana.media.runtime.MediaTranscriptContracts.MediaTranscriptStore;

import java.time.Clock;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.ServiceLoader;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Launcher composition for the {@code media.operation.caption-version-write} and
 * {@code ...-read} durable surface. Composes the canonical caption store, the source-rights
 * administration that admits derived-version writes, and the optional transcript store used
 * for {@code TRANSCRIPT_VERSION} parent clocks.
 *
 * <p>Composition never fabricates authority: a missing or unready caption store or rights
 * administration leaves this runtime absent (dev profile) or fails startup (production-like
 * profile), and every {@link RegistrationResult} that reaches the store still passes through
 * the injected rights and parent-clock ports. Nothing here approves content, mutates a
 * parent, or establishes delivery.</p>
 */
final class MediaCaptionRuntime implements AutoCloseable {
    private final MediaCaptionStore captionStore;
    private final MediaSourceRightsAdministration rightsAdministration;
    private final MediaTranscriptStore transcriptStore;
    private final Clock clock;
    private final AtomicBoolean closed = new AtomicBoolean();

    MediaCaptionRuntime(MediaCaptionStore captionStore,
                        MediaSourceRightsAdministration rightsAdministration,
                        MediaTranscriptStore transcriptStore,
                        Clock clock) {
        this.captionStore = java.util.Objects.requireNonNull(captionStore, "captionStore");
        this.rightsAdministration = java.util.Objects.requireNonNull(
                rightsAdministration, "rightsAdministration");
        this.transcriptStore = transcriptStore;
        this.clock = java.util.Objects.requireNonNull(clock, "clock");
    }

    static MediaCaptionRuntime compose(Map<String, String> environment) {
        java.util.Objects.requireNonNull(environment, "environment");
        boolean productionLike = MediaDeploymentProfiles.productionLike(environment.getOrDefault(
                "MEDIA_RUNTIME_ENVIRONMENT",
                environment.getOrDefault("MEDIA_PROFILE", "local")));

        List<MediaCaptionStore> captionStores = new ArrayList<>();
        for (MediaCaptionStore candidate : ServiceLoader.load(MediaCaptionStore.class)) {
            captionStores.add(candidate);
        }
        List<MediaSourceRightsAdministration> rightsCandidates = new ArrayList<>();
        for (MediaSourceRightsAdministration candidate
                : ServiceLoader.load(MediaSourceRightsAdministration.class)) {
            rightsCandidates.add(candidate);
        }
        List<MediaTranscriptStore> transcriptStores = new ArrayList<>();
        for (MediaTranscriptStore candidate : ServiceLoader.load(MediaTranscriptStore.class)) {
            transcriptStores.add(candidate);
        }
        try {
            List<MediaCaptionStore> readyStores = captionStores.stream()
                    .filter(MediaCaptionRuntime::safeReady)
                    .sorted(Comparator.comparing(store -> store.getClass().getName()))
                    .toList();
            List<MediaSourceRightsAdministration> readyRights = rightsCandidates.stream()
                    .filter(MediaCaptionRuntime::safeReady)
                    .sorted(Comparator.comparing(admin -> canonical(admin.administrationId())))
                    .toList();
            if (readyStores.size() > 1 || readyRights.size() > 1) {
                throw new IllegalStateException(
                        "Expected at most one ready Media caption store and rights administration, found "
                                + readyStores.size() + " store(s) and " + readyRights.size() + " administration(s)");
            }
            MediaTranscriptStore transcriptStore = selectOptionalTranscriptStore(transcriptStores, productionLike);
            if (readyStores.isEmpty() || readyRights.isEmpty()) {
                closeAll(captionStores, rightsCandidates, transcriptStores);
                if (productionLike) {
                    throw new IllegalStateException(
                            "Production Media Runtime requires a ready caption store and source-rights administration");
                }
                return null;
            }
            MediaCaptionStore store = readyStores.get(0);
            MediaSourceRightsAdministration rights = readyRights.get(0);
            if (productionLike && (!store.productionEligible() || !rights.productionEligible())) {
                closeAll(captionStores, rightsCandidates, transcriptStores);
                throw new IllegalStateException(
                        "Media caption store and source-rights administration must be production eligible");
            }
            for (MediaCaptionStore candidate : captionStores) {
                if (candidate != store) safeClose(candidate);
            }
            for (MediaSourceRightsAdministration candidate : rightsCandidates) {
                if (candidate != rights) safeClose(candidate);
            }
            for (MediaTranscriptStore candidate : transcriptStores) {
                if (candidate != transcriptStore) safeClose(candidate);
            }
            return new MediaCaptionRuntime(store, rights, transcriptStore, Clock.systemUTC());
        } catch (RuntimeException failure) {
            closeAll(captionStores, rightsCandidates, transcriptStores);
            throw failure;
        }
    }

    boolean ready() {
        return !closed.get() && captionStore.ready() && rightsAdministration.ready();
    }

    RegistrationResult register(String tenantId, String principalId, RegistrationRequest request) {
        if (closed.get()) throw new IllegalStateException("Media caption runtime is closed");
        return captionStore.register(tenantId, principalId, request,
                new MediaCaptionRegistrationAuthority(rightsAdministration, clock),
                new MediaCaptionParentClockLookup(tenantId, principalId, transcriptStore, captionStore));
    }

    List<Registered> versions(String tenantId, String principalId,
                              String sourceArtifactId, String sourceArtifactVersionId) {
        if (closed.get()) throw new IllegalStateException("Media caption runtime is closed");
        requireCurrentReadAuthority(tenantId, principalId, sourceArtifactId, sourceArtifactVersionId);
        return captionStore.versions(tenantId, principalId, sourceArtifactId, sourceArtifactVersionId);
    }

    Optional<CaptionVersionSnapshot> version(String tenantId, String principalId, String captionVersionId) {
        if (closed.get()) throw new IllegalStateException("Media caption runtime is closed");
        Optional<CaptionVersionSnapshot> snapshot = captionStore.version(tenantId, principalId, captionVersionId);
        snapshot.ifPresent(value -> requireCurrentReadAuthority(tenantId, principalId,
                value.sourceArtifactId(), value.sourceArtifactVersionId()));
        return snapshot;
    }

    private void requireCurrentReadAuthority(String tenantId, String principalId, String sourceArtifactId,
                                            String sourceArtifactVersionId) {
        RegistrationAuthority.Decision decision = new MediaCaptionRegistrationAuthority(rightsAdministration, clock)
                .check(new RegistrationAuthority.AuthorityCheck(tenantId, principalId, sourceArtifactId,
                        sourceArtifactVersionId, null, null));
        if (decision == RegistrationAuthority.Decision.DENIED) {
            throw new MediaCapabilityNotAdmittedException(
                    MediaCapabilityNotAdmittedException.Reason.POLICY_DENIED, "caption-version-read");
        }
        if (decision == RegistrationAuthority.Decision.UNAVAILABLE) {
            throw new MediaCapabilityNotAdmittedException(
                    MediaCapabilityNotAdmittedException.Reason.PROVIDER_UNAVAILABLE, "caption-version-read");
        }
    }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) {
            RuntimeException failure = null;
            for (AutoCloseable candidate : new AutoCloseable[] {captionStore, rightsAdministration, transcriptStore}) {
                if (candidate == null) continue;
                try { candidate.close(); } catch (Exception f) {
                    if (failure == null) failure = new IllegalStateException("Media caption runtime close failed", f);
                    else failure.addSuppressed(f);
                }
            }
            if (failure != null) throw failure;
        }
    }

    private static void closeAll(List<MediaCaptionStore> stores,
                                 List<MediaSourceRightsAdministration> rights,
                                 List<MediaTranscriptStore> transcripts) {
        RuntimeException failure = null;
        List<AutoCloseable> all = new ArrayList<>(stores.size() + rights.size() + transcripts.size());
        all.addAll(stores);
        all.addAll(rights);
        all.addAll(transcripts);
        for (AutoCloseable candidate : all) {
            try { candidate.close(); } catch (Exception f) {
                if (failure == null) failure = new IllegalStateException("caption composition cleanup failed", f);
                else failure.addSuppressed(f);
            }
        }
        if (failure != null) throw failure;
    }

    private static void safeClose(AutoCloseable candidate) {
        try { candidate.close(); } catch (Exception ignored) { }
    }

    private static boolean safeReady(Object candidate) {
        try {
            if (candidate instanceof MediaCaptionStore store) return store.ready();
            if (candidate instanceof MediaSourceRightsAdministration admin) return admin.ready();
            if (candidate instanceof MediaTranscriptStore store) return store.ready();
            return false;
        } catch (RuntimeException unavailable) {
            return false;
        }
    }

    /**
     * Transcript version reads are used to bind caption timing to an exact parent. Selecting
     * one of several ready stores by class-name order could silently bind a caption to a
     * different transcript history, so the optional dependency must have one unambiguous
     * owner. In production-like profiles, development-only stores are not eligible parents.
     */
    static MediaTranscriptStore selectOptionalTranscriptStore(
            List<MediaTranscriptStore> candidates, boolean productionLike) {
        List<MediaTranscriptStore> eligible = candidates.stream()
                .filter(MediaCaptionRuntime::safeReady)
                .filter(store -> !productionLike || safeProductionEligible(store))
                .sorted(Comparator.comparing(store -> store.getClass().getName()))
                .toList();
        if (eligible.size() > 1) {
            throw new IllegalStateException(
                    "Expected at most one eligible Media caption transcript store, found " + eligible.size());
        }
        return eligible.isEmpty() ? null : eligible.getFirst();
    }

    private static boolean safeProductionEligible(MediaTranscriptStore store) {
        try { return store.productionEligible(); }
        catch (RuntimeException unavailable) { return false; }
    }

    private static String canonical(String value) {
        return MediaDeploymentProfiles.canonical(value);
    }

    private static String canonicalOptional(String value) {
        String normalized = canonical(value);
        return normalized.isBlank() ? "" : normalized;
    }
}
