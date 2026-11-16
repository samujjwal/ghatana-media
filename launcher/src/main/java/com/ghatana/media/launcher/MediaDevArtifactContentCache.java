package com.ghatana.media.launcher;

import com.ghatana.audio.video.infrastructure.cache.RightsAwareContentCache;
import com.ghatana.audio.video.infrastructure.cache.RightsAwareContentCache.Scope;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.time.Duration;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * DEV_ONLY host wiring of the rights-aware content cache for {@code GET /dev/v1/artifacts/{id}/content}: the
 * Explorer's exact-byte reads, whose miss path is a full S3 read plus SHA-256 verification into private staging.
 *
 * <p>The cache holds only bytes that already passed that verification and is never an authority. Every read first
 * re-reads the owning authorities (the artifact record for tenant, owner and exact version, and the durable rights
 * store for the rights state of that version) and keys the entry by all of it; a rights change, erasure or a
 * different version addresses another key, and a rights change or erasure also drops the entries immediately. When
 * an authority cannot be read the read fails closed (503) and no cached byte is released. Enabled with
 * {@value #ENABLED}=true; off by default so existing lanes keep their uncached behavior.</p>
 */
final class MediaDevArtifactContentCache implements AutoCloseable {
    static final String ENABLED = "MEDIA_DEV_CONTENT_CACHE_ENABLED";
    static final String MAX_BYTES_ENV = "MEDIA_DEV_CONTENT_CACHE_MAX_BYTES";
    static final String MAX_ENTRIES_ENV = "MEDIA_DEV_CONTENT_CACHE_MAX_ENTRIES";
    static final String TTL_SECONDS_ENV = "MEDIA_DEV_CONTENT_CACHE_TTL_SECONDS";
    static final long DEFAULT_MAX_BYTES = 32L * 1024 * 1024;
    static final int DEFAULT_MAX_ENTRIES = 256;
    static final long DEFAULT_TTL_SECONDS = 300;
    private static final Logger log = LoggerFactory.getLogger(MediaDevArtifactContentCache.class);

    private final MediaRuntime runtime;
    private final MediaDevRightsRuntime rights;
    private final RightsAwareContentCache cache;

    MediaDevArtifactContentCache(MediaRuntime runtime, MediaDevRightsRuntime rights, RightsAwareContentCache cache) {
        this.runtime = java.util.Objects.requireNonNull(runtime, "runtime");
        this.rights = rights;
        this.cache = java.util.Objects.requireNonNull(cache, "cache");
        if (rights != null) {
            rights.onRightsChange((tenantId, artifactId) -> {
                try {
                    cache.invalidateArtifact(tenantId, artifactId);
                } catch (RuntimeException failure) {
                    // The changed rights epoch already addresses a different key; log the eager drop that failed.
                    log.error("Content cache could not drop entries after a rights change artifactId={} reason={}",
                            artifactId, failure.getClass().getSimpleName());
                }
            });
        }
    }

    /** Returns null unless {@value #ENABLED} is true. */
    static MediaDevArtifactContentCache compose(Map<String, String> environment, MediaRuntime runtime,
                                                MediaDevRightsRuntime rights) {
        String flag = environment.getOrDefault(ENABLED, "false").trim().toLowerCase(Locale.ROOT);
        if (!flag.equals("true") && !flag.equals("false")) throw new IllegalArgumentException(ENABLED + " must be true or false");
        if (!flag.equals("true")) return null;
        long maxBytes = positive(environment, MAX_BYTES_ENV, DEFAULT_MAX_BYTES);
        long maxEntries = positive(environment, MAX_ENTRIES_ENV, DEFAULT_MAX_ENTRIES);
        long ttl = positive(environment, TTL_SECONDS_ENV, DEFAULT_TTL_SECONDS);
        if (maxEntries > Integer.MAX_VALUE) throw new IllegalArgumentException(MAX_ENTRIES_ENV + " is too large");
        return new MediaDevArtifactContentCache(runtime, rights, new RightsAwareContentCache(
                new RightsAwareContentCache.Config(maxBytes, (int) maxEntries, Duration.ofSeconds(ttl),
                        Duration.ofSeconds(5))));
    }

    private static long positive(Map<String, String> environment, String name, long fallback) {
        String raw = environment.get(name);
        if (raw == null || raw.isBlank()) return fallback;
        try {
            long value = Long.parseLong(raw.trim());
            if (value < 1) throw new IllegalArgumentException(name + " must be positive");
            return value;
        } catch (NumberFormatException failure) {
            throw new IllegalArgumentException(name + " must be an integer", failure);
        }
    }

    /** True when the object is small enough to be cached; larger objects use the uncached verified path. */
    static boolean cacheable(long sizeBytes) {
        return sizeBytes <= RightsAwareContentCache.MAX_ENTRY_BYTES;
    }

    /**
     * Verified full bytes of the exact version. Owner authorities are re-read on every call; the source is read and
     * verified only on a miss.
     */
    RightsAwareContentCache.Result read(String tenantId, String principalId, String artifactId,
                                        ArtifactVersion expected, long sizeBytes) throws IOException {
        RightsAwareContentCache.Authority authority = () -> {
            Optional<MediaArtifact> found = runtime.artifact(tenantId, principalId, artifactId);
            if (found.isEmpty() || !found.get().version().equals(expected)) return Optional.empty();
            MediaArtifact artifact = found.get();
            MediaDevRightsRuntime.RightsState state = rights == null
                    ? new MediaDevRightsRuntime.RightsState(0, "no-rights-authority")
                    : rights.rightsState(tenantId, artifactId, artifact.version().value());
            return Optional.of(new Scope(tenantId, principalId, artifactId, artifact.version().value(),
                    artifact.sha256(), artifact.sizeBytes(), state.epoch(), state.fingerprint()));
        };
        return cache.get(authority, () -> {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream((int) Math.min(Math.max(sizeBytes, 1), 1 << 20));
            var receipt = runtime.copyArtifactContent(tenantId, principalId, artifactId, expected, buffer,
                    Math.max(sizeBytes, 1));
            if (receipt.isEmpty() || receipt.get().bytesCopied() != buffer.size() || buffer.size() != sizeBytes) {
                throw new IOException("Content receipt does not match the artifact record");
            }
            return buffer.toByteArray();
        });
    }

    void invalidateTenant(String tenantId) {
        cache.invalidateTenant(tenantId);
    }

    RightsAwareContentCache.Stats stats() { return cache.stats(); }

    @Override public void close() { cache.close(); }
}
