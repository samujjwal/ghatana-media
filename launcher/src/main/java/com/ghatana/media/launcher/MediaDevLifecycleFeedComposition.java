package com.ghatana.media.launcher;

import com.ghatana.audio.video.infrastructure.messaging.MediaLifecycleOutboxRelay;
import com.ghatana.media.runtime.HmacMediaLifecycleIdentifierRedactor;
import com.ghatana.media.runtime.MediaDevLifecycleFeedContracts.Feed;
import com.ghatana.media.runtime.MediaDevLifecycleFeedContracts.FeedFactory;
import com.ghatana.media.runtime.MediaLifecycleOutboxSource;
import com.ghatana.messaging.outbox.OutboxPublicationSource;
import com.ghatana.messaging.util.AsyncOperations;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.ServiceLoader;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Host composition of the DEV_ONLY lifecycle feed (decision record: docs/surfaces/launcher/README.md, "DEV_ONLY
 * lifecycle feed"). Enabled only by {@code MEDIA_DEV_LIFECYCLE_FEED=true} with the dev profile and dev identity; it
 * additionally needs {@code MEDIA_DEV_LIFECYCLE_FEED_REDACTION_KEY} (at least 32 characters, stable across restarts so
 * public references stay stable). Optional: {@code MEDIA_DEV_LIFECYCLE_FEED_INTERVAL_MS} (relay period, default 500),
 * {@code MEDIA_DEV_LIFECYCLE_FEED_CLAIM_MS} (outbox claim lease, default 10000) and the one-shot crash seam
 * {@code MEDIA_DEV_LIFECYCLE_FEED_FAULT_MARKER}.
 */
final class MediaDevLifecycleFeedComposition implements AutoCloseable {
    private static final Logger log = LoggerFactory.getLogger(MediaDevLifecycleFeedComposition.class);
    static final String ENV_ENABLED = "MEDIA_DEV_LIFECYCLE_FEED";
    static final String ENV_KEY = "MEDIA_DEV_LIFECYCLE_FEED_REDACTION_KEY";
    static final String ENV_INTERVAL = "MEDIA_DEV_LIFECYCLE_FEED_INTERVAL_MS";
    static final String ENV_CLAIM = "MEDIA_DEV_LIFECYCLE_FEED_CLAIM_MS";

    private final MediaDevLifecycleFeedRoutes routes;
    private final Feed feed;
    private final OutboxPublicationSource source;
    private final MediaLifecycleOutboxRelay relay;
    private final MediaLifecycleOutboxSource attemptSource;
    private final ScheduledExecutorService scheduler;

    private MediaDevLifecycleFeedComposition(MediaDevLifecycleFeedRoutes routes, Feed feed,
            OutboxPublicationSource source, MediaLifecycleOutboxRelay relay,
            MediaLifecycleOutboxSource attemptSource, ScheduledExecutorService scheduler) {
        this.attemptSource = attemptSource;
        this.routes = routes;
        this.feed = feed;
        this.source = source;
        this.relay = relay;
        this.scheduler = scheduler;
    }

    MediaDevLifecycleFeedRoutes routes() { return routes; }

    static MediaDevLifecycleFeedComposition compose(MediaRuntime runtime, Map<String, String> environment) {
        if (!"true".equalsIgnoreCase(environment.getOrDefault(ENV_ENABLED, "false"))) return null;
        String key = environment.getOrDefault(ENV_KEY, "");
        if (key.length() < 32) {
            throw new IllegalStateException(ENV_KEY + " (at least 32 characters) is required for the DEV_ONLY lifecycle feed");
        }
        long interval = millis(environment, ENV_INTERVAL, 500, 50, 60_000);
        long claim = millis(environment, ENV_CLAIM, 10_000, 500, 600_000);
        List<FeedFactory> factories = ServiceLoader.load(FeedFactory.class).stream()
                .map(ServiceLoader.Provider::get).toList();
        if (factories.size() != 1) {
            throw new IllegalStateException("exactly one DEV_ONLY lifecycle feed factory is required");
        }
        List<OutboxPublicationSource> sources = new ArrayList<>(ServiceLoader.load(OutboxPublicationSource.class).stream()
                .map(ServiceLoader.Provider::get).toList());
        if (sources.size() != 1) {
            sources.forEach(MediaDevLifecycleFeedComposition::closeQuietly);
            throw new IllegalStateException("exactly one transactional outbox publication source is required");
        }
        OutboxPublicationSource source = sources.getFirst();
        if (!environment.getOrDefault("MEDIA_EVENT_PLANE_URL", "").isBlank()) {
            closeQuietly(source);
            throw new IllegalStateException("the DEV_ONLY lifecycle feed and MEDIA_EVENT_PLANE_URL both drain the "
                    + "lifecycle outboxes; enable only one");
        }
        List<MediaLifecycleOutboxSource> attemptSources = new ArrayList<>(ServiceLoader.load(MediaLifecycleOutboxSource.class)
                .stream().map(ServiceLoader.Provider::get).toList());
        if (attemptSources.size() != 1) {
            attemptSources.forEach(MediaDevLifecycleFeedComposition::closeQuietly);
            closeQuietly(source);
            throw new IllegalStateException("exactly one attempt-aware lifecycle outbox source is required");
        }
        MediaLifecycleOutboxSource attemptSource = attemptSources.getFirst();
        Feed feed = null;
        MediaLifecycleOutboxRelay relay = null;
        try {
            feed = factories.getFirst().createDevOnly(environment);
            var redactor = new HmacMediaLifecycleIdentifierRedactor(key.getBytes(StandardCharsets.UTF_8));
            String marker = environment.getOrDefault(MediaDevLifecycleFeedBus.ENV_FAULT_MARKER, "").trim();
            var bus = new MediaDevLifecycleFeedBus(feed, redactor, marker.isEmpty() ? null : Path.of(marker),
                    () -> Runtime.getRuntime().halt(137));
            relay = new MediaLifecycleOutboxRelay(source, bus, "media-launcher-feed-" + UUID.randomUUID(), 50,
                    Duration.ofMillis(claim), diagnostic -> { }, Clock.systemUTC());
            ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {
                Thread thread = new Thread(runnable, "media-dev-lifecycle-feed-relay");
                thread.setDaemon(true);
                return thread;
            });
            MediaLifecycleOutboxRelay activeRelay = relay;
            var attemptPublisher = bus.internalPublisher();
            scheduler.scheduleWithFixedDelay(() -> {
                try {
                    // Order: the job-store family (accepted) first, then the attempt-aware family (terminal). A failed
                    // or partial first stage skips the second so a terminal event never overtakes its accepted event.
                    var first = AsyncOperations.toFuture(activeRelay.runOnce()).get(60, TimeUnit.SECONDS);
                    if (first.publishedEvents() == first.claimedEvents()) {
                        attemptSource.publishConfirmed(attemptPublisher, 50);
                    }
                } catch (Exception failure) {
                    Throwable cause = failure.getCause() == null ? failure : failure.getCause();
                    log.warn("DEV_ONLY lifecycle feed relay pass failed: {}", cause.getClass().getSimpleName());
                }
            }, interval, interval, TimeUnit.MILLISECONDS);
            return new MediaDevLifecycleFeedComposition(
                    new MediaDevLifecycleFeedRoutes(feed, redactor, runtime), feed, source, relay, attemptSource, scheduler);
        } catch (RuntimeException failure) {
            closeQuietly(attemptSource);
            if (relay != null) relay.close();
            closeQuietly(feed);
            closeQuietly(source);
            throw failure;
        }
    }

    @Override
    public void close() {
        scheduler.shutdownNow();
        try { scheduler.awaitTermination(5, TimeUnit.SECONDS); } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
        relay.close();
        closeQuietly(attemptSource);
        closeQuietly(feed);
        closeQuietly(source);
    }

    private static void closeQuietly(Object value) {
        if (value instanceof AutoCloseable closeable) {
            try { closeable.close(); } catch (Exception ignored) { }
        }
    }

    private static long millis(Map<String, String> environment, String key, long fallback, long min, long max) {
        try {
            long value = Long.parseLong(environment.getOrDefault(key, Long.toString(fallback)).trim());
            if (value < min || value > max) throw new IllegalArgumentException(key + " must be between " + min + " and " + max);
            return value;
        } catch (NumberFormatException invalid) {
            throw new IllegalArgumentException(key + " must be an integer", invalid);
        }
    }
}
