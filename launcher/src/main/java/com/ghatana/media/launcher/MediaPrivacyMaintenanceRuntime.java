package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaPrivacyMaintenance;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.ServiceLoader;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Launcher-owned lifecycle for the service-owned physical privacy-maintenance SPI.
 *
 * <p>Production-like profiles require exactly one ready production-eligible authority. One purge
 * completes synchronously before the HTTP service starts; later cycles run on a single bounded
 * scheduler. Failures are observable and retried by the next cycle without claiming erasure.
 *
 * @doc.type class
 * @doc.purpose Compose and schedule Media retention/erasure maintenance
 * @doc.layer product
 * @doc.pattern CompositionRoot, Scheduler
 */
final class MediaPrivacyMaintenanceRuntime implements AutoCloseable {
    private static final Logger log = LoggerFactory.getLogger(MediaPrivacyMaintenanceRuntime.class);
    private static final long DEFAULT_INTERVAL_SECONDS = 86_400L;

    private final MediaPrivacyMaintenance maintenance;
    private final ScheduledExecutorService scheduler;
    private final long intervalSeconds;
    private final AtomicBoolean closed = new AtomicBoolean(false);

    private MediaPrivacyMaintenanceRuntime(
            MediaPrivacyMaintenance maintenance,
            ScheduledExecutorService scheduler,
            long intervalSeconds) {
        this.maintenance = maintenance;
        this.scheduler = scheduler;
        this.intervalSeconds = intervalSeconds;
    }

    static MediaPrivacyMaintenanceRuntime compose(Map<String, String> environment) {
        java.util.Objects.requireNonNull(environment, "environment");
        boolean productionLike = productionLike(environment.getOrDefault(
                "MEDIA_RUNTIME_ENVIRONMENT",
                environment.getOrDefault("MEDIA_PROFILE", "local")));
        String configuredId = canonicalOptional(environment.get("MEDIA_PRIVACY_MAINTENANCE_ID"));
        List<MediaPrivacyMaintenance> discovered = new ArrayList<>();
        for (MediaPrivacyMaintenance candidate : ServiceLoader.load(MediaPrivacyMaintenance.class)) {
            discovered.add(candidate);
        }
        discovered.sort(Comparator.comparing(candidate -> canonical(candidate.maintenanceId())));
        List<MediaPrivacyMaintenance> ready = discovered.stream()
                .filter(MediaPrivacyMaintenance::ready)
                .filter(candidate -> configuredId.isBlank()
                        || canonical(candidate.maintenanceId()).equals(configuredId))
                .toList();
        if (ready.isEmpty()) {
            discovered.forEach(MediaPrivacyMaintenanceRuntime::safeClose);
            if (productionLike) {
                throw new IllegalStateException(
                        "Production Media Runtime requires a ready physical privacy-maintenance authority");
            }
            return null;
        }
        if (ready.size() != 1) {
            discovered.forEach(MediaPrivacyMaintenanceRuntime::safeClose);
            throw new IllegalStateException(
                    "Expected exactly one ready Media privacy-maintenance authority, found " + ready.size());
        }
        MediaPrivacyMaintenance selected = ready.getFirst();
        for (MediaPrivacyMaintenance candidate : discovered) {
            if (candidate != selected) safeClose(candidate);
        }
        if (productionLike && !selected.productionEligible()) {
            safeClose(selected);
            throw new IllegalStateException("Media privacy-maintenance authority is not production eligible");
        }

        long intervalSeconds = longValue(
                environment,
                "MEDIA_PRIVACY_MAINTENANCE_INTERVAL_SECONDS",
                DEFAULT_INTERVAL_SECONDS,
                60L,
                7L * 24L * 60L * 60L);
        ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "media-privacy-maintenance");
            thread.setDaemon(true);
            return thread;
        });
        MediaPrivacyMaintenanceRuntime runtime = new MediaPrivacyMaintenanceRuntime(
                selected, scheduler, intervalSeconds);
        try {
            runtime.runCycle(true);
            scheduler.scheduleWithFixedDelay(
                    () -> runtime.runCycle(false),
                    intervalSeconds,
                    intervalSeconds,
                    TimeUnit.SECONDS);
            return runtime;
        } catch (RuntimeException failure) {
            runtime.close();
            throw failure;
        }
    }

    String maintenanceId() {
        return maintenance.maintenanceId();
    }

    private void runCycle(boolean startup) {
        if (closed.get()) return;
        try {
            MediaPrivacyMaintenance.PurgeReport report = maintenance.purgeExpired(Instant.now());
            log.info(
                    "MEDIA_PRIVACY_PURGE_COMPLETED maintenanceId={} startup={} totalDeleted={} artifacts={} uploads={} chunks={} jobs={} streams={} intervalSeconds={}",
                    maintenance.maintenanceId(), startup, report.totalDeleted(),
                    report.artifactsDeleted(), report.uploadsDeleted(), report.chunksDeleted(),
                    report.jobsDeleted(), report.streamsDeleted(), intervalSeconds);
        } catch (RuntimeException failure) {
            log.error(
                    "MEDIA_PRIVACY_PURGE_FAILED maintenanceId={} startup={} failureType={}",
                    maintenance.maintenanceId(), startup, failure.getClass().getSimpleName(), failure);
            if (startup) throw failure;
        }
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) return;
        scheduler.shutdownNow();
        safeClose(maintenance);
    }

    private static void safeClose(MediaPrivacyMaintenance maintenance) {
        try { maintenance.close(); }
        catch (RuntimeException ignored) { }
    }

    private static long longValue(
            Map<String, String> environment, String key, long fallback, long min, long max) {
        try {
            long value = Long.parseLong(environment.getOrDefault(key, Long.toString(fallback)).trim());
            if (value < min || value > max) {
                throw new IllegalArgumentException(key + " must be between " + min + " and " + max);
            }
            return value;
        } catch (NumberFormatException failure) {
            throw new IllegalArgumentException(key + " must be an integer", failure);
        }
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
