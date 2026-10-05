package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaConsentAdministration;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.ServiceLoader;
import java.util.concurrent.atomic.AtomicBoolean;

/** Launcher composition for the self-service Media consent administration SPI. */
final class MediaConsentAdministrationRuntime implements AutoCloseable {
    private final MediaConsentAdministration administration;
    private final AtomicBoolean closed = new AtomicBoolean(false);

    private MediaConsentAdministrationRuntime(MediaConsentAdministration administration) {
        this.administration = administration;
    }

    static MediaConsentAdministrationRuntime compose(Map<String, String> environment) {
        java.util.Objects.requireNonNull(environment, "environment");
        boolean productionLike = productionLike(environment.getOrDefault(
                "MEDIA_RUNTIME_ENVIRONMENT",
                environment.getOrDefault("MEDIA_PROFILE", "local")));
        String configuredId = canonicalOptional(environment.get("MEDIA_CONSENT_ADMINISTRATION_ID"));
        List<MediaConsentAdministration> discovered = new ArrayList<>();
        for (MediaConsentAdministration candidate : ServiceLoader.load(MediaConsentAdministration.class)) {
            discovered.add(candidate);
        }
        discovered.sort(Comparator.comparing(candidate -> canonical(candidate.administrationId())));
        List<MediaConsentAdministration> ready = discovered.stream()
                .filter(MediaConsentAdministration::ready)
                .filter(candidate -> configuredId.isBlank()
                        || canonical(candidate.administrationId()).equals(configuredId))
                .toList();
        if (ready.isEmpty()) {
            discovered.forEach(MediaConsentAdministrationRuntime::safeClose);
            if (productionLike) {
                throw new IllegalStateException(
                        "Production Media Runtime requires a ready consent-administration provider");
            }
            return null;
        }
        if (ready.size() != 1) {
            discovered.forEach(MediaConsentAdministrationRuntime::safeClose);
            throw new IllegalStateException(
                    "Expected exactly one ready Media consent-administration provider, found " + ready.size());
        }
        MediaConsentAdministration selected = ready.getFirst();
        for (MediaConsentAdministration candidate : discovered) {
            if (candidate != selected) safeClose(candidate);
        }
        if (productionLike && !selected.productionEligible()) {
            safeClose(selected);
            throw new IllegalStateException("Media consent-administration provider is not production eligible");
        }
        return new MediaConsentAdministrationRuntime(selected);
    }

    MediaConsentAdministration administration() {
        if (closed.get()) throw new IllegalStateException("Media consent administration is closed");
        return administration;
    }

    String administrationId() { return administration.administrationId(); }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) safeClose(administration);
    }

    private static void safeClose(MediaConsentAdministration administration) {
        try { administration.close(); }
        catch (RuntimeException ignored) { }
    }

    private static boolean productionLike(String profile) {
        return "production".equalsIgnoreCase(profile)
                || "staging".equalsIgnoreCase(profile)
                || "sovereign".equalsIgnoreCase(profile);
    }

    private static String canonical(String value) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException("component ID is required");
        return value.trim().toLowerCase(java.util.Locale.ROOT);
    }

    private static String canonicalOptional(String value) {
        return value == null ? "" : value.trim().toLowerCase(java.util.Locale.ROOT);
    }
}
